import fs from 'node:fs/promises'

import type { Digest } from '../shared/digest.ts'
import { hasErrorCode } from '../shared/fs.ts'
import { recordedBlobDigest, type TrialRecordStore } from './trial-record.ts'

interface CacheFile {
  file: string
  key: Digest
  size: number
  mtime: number
  created: number
}

interface CachedRecord extends CacheFile {
  digest: Digest | undefined
}

export interface CacheLimits {
  maxBytes: number
  maxEntries: number
}

async function statFile(item: { file: string; key: Digest }): Promise<CacheFile | undefined> {
  try {
    const stat = await fs.stat(item.file)
    return { ...item, size: stat.size, mtime: stat.mtimeMs, created: stat.birthtimeMs }
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error
    return undefined
  }
}

async function scanFiles<T>(
  items: { file: string; key: Digest }[],
  inspect: (item: CacheFile) => T | Promise<T>,
): Promise<T[]> {
  const results: T[] = []
  const batchSize = 16
  for (let start = 0; start < items.length; start += batchSize) {
    const stats = await Promise.all(items.slice(start, start + batchSize).map(statFile))
    const batch = await Promise.all(stats.filter((stat) => stat !== undefined).map(inspect))
    results.push(...batch)
  }
  return results
}

async function readBlobReference(file: string): Promise<Digest | undefined> {
  try {
    return recordedBlobDigest(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error
    return undefined
  }
}

export class CacheInventory {
  static async read(store: TrialRecordStore): Promise<CacheInventory> {
    // Start with blobs so records committed during the scan can still protect them.
    const blobs = await scanFiles(await store.list('blobs', false), (blob) => blob)
    const records = await scanFiles(await store.list('records', false), async (record) => ({
      ...record,
      digest: await readBlobReference(record.file),
    }))
    return new CacheInventory(records, blobs)
  }

  private readonly records = new Map<Digest, CachedRecord>()
  private readonly blobs = new Map<Digest, CacheFile>()
  private readonly references = new Map<Digest, number>()
  private readonly oldest: CachedRecord[]
  private cursor = 0
  private total = 0

  private constructor(records: CachedRecord[], blobs: CacheFile[]) {
    for (const blob of blobs) this.rememberBlob(blob)
    for (const record of records) this.rememberRecord(record)
    this.oldest = records.sort((a, b) => a.mtime - b.mtime || a.key.localeCompare(b.key))
  }

  rememberRecord(record: CachedRecord): void {
    const previous = this.records.get(record.key)
    if (previous) this.forgetRecord(previous)
    this.records.set(record.key, record)
    this.total += record.size
    if (record.digest)
      this.references.set(record.digest, (this.references.get(record.digest) ?? 0) + 1)
  }

  rememberBlob(blob: CacheFile): void {
    this.total += blob.size - (this.blobs.get(blob.key)?.size ?? 0)
    this.blobs.set(blob.key, blob)
  }

  private forgetRecord(record: CachedRecord): void {
    this.records.delete(record.key)
    this.total -= record.size
    if (!record.digest) return
    const remaining = (this.references.get(record.digest) ?? 1) - 1
    if (remaining) this.references.set(record.digest, remaining)
    else this.references.delete(record.digest)
  }

  async prune(
    store: TrialRecordStore,
    limits: CacheLimits,
    pinnedKeys: ReadonlySet<Digest>,
    pinnedBlobs: ReadonlySet<Digest>,
    orphanCutoff?: number,
  ): Promise<void> {
    const withinLimits = () =>
      this.records.size <= limits.maxEntries && this.total <= limits.maxBytes
    if (orphanCutoff !== undefined) {
      for (const [key, blob] of this.blobs) {
        if (Math.max(blob.created, blob.mtime) < orphanCutoff)
          await this.removeUnusedBlob(store, key, pinnedBlobs, orphanCutoff)
      }
    }
    while (!withinLimits()) {
      const record = this.oldest[this.cursor]
      if (!record) break
      if (!pinnedKeys.has(record.key) && this.records.get(record.key) === record) {
        await fs.rm(record.file, { force: true })
        this.forgetRecord(record)
        if (record.digest) await this.removeUnusedBlob(store, record.digest, pinnedBlobs)
      }
      this.cursor++
    }
  }

  private async removeUnusedBlob(
    store: TrialRecordStore,
    key: Digest,
    pinned: ReadonlySet<Digest>,
    orphanCutoff?: number,
  ): Promise<void> {
    const blob = this.blobs.get(key)
    if (!blob || pinned.has(key) || this.references.has(key)) return
    await store.withBlobLock(key, async () => {
      const current = await statFile(blob)
      if (
        current &&
        orphanCutoff !== undefined &&
        Math.max(current.created, current.mtime) >= orphanCutoff
      )
        return
      if (current && current.mtime > blob.mtime) return
      await fs.rm(blob.file, { force: true })
      this.blobs.delete(key)
      this.total -= blob.size
    })
  }
}
