import fs from 'node:fs/promises'

import type { ImageTrial, ImageInputBytes, TrialResult } from '../processing/trial.ts'
import { sha256, type Digest } from '../shared/digest.ts'
import { hasErrorCode } from '../shared/fs.ts'
import { isolateWarning } from '../shared/warning.ts'
import { CacheInventory, type CacheLimits } from './cache-inventory.ts'
import { TrialRecordStore } from './trial-record.ts'

interface CacheOptions {
  onWarning?: (message: string) => void
  now?: () => number
  orphanGraceMs?: number
}

export class LocalTrialCache {
  private readonly records: TrialRecordStore
  private readonly limits: CacheLimits
  private readonly pinnedKeys = new Set<Digest>()
  private readonly pinnedBlobs = new Set<Digest>()
  private readonly warn: (message: string) => void
  private readonly now: () => number
  private readonly orphanGraceMs: number
  private writes: Promise<void> = Promise.resolve()
  private pendingPrune: { work: Promise<void>; refresh: boolean } | undefined
  private firstHitPrune: Promise<void> | undefined
  private inventory: CacheInventory | undefined
  private untrimmedWrites = false

  constructor(directory: string, limits: CacheLimits, options: CacheOptions = {}) {
    this.limits = limits
    this.warn = isolateWarning(options.onWarning)
    this.records = new TrialRecordStore(directory, this.warn)
    this.now = options.now ?? Date.now
    this.orphanGraceMs = options.orphanGraceMs ?? 10 * 60_000
  }

  async read(
    key: Digest,
    trial: ImageTrial,
    input: ImageInputBytes,
  ): Promise<TrialResult | undefined> {
    try {
      return await this.records.read(key, trial, input, async (record, blob) => {
        this.pin(record, blob)
        await this.touch(record)
        await (this.firstHitPrune ??= this.prune())
      })
    } catch {
      await fs.rm(this.records.recordPath(key), { force: true }).catch(() => {
        this.warn('Could not discard a damaged local image cache record.')
      })
      return undefined
    }
  }

  prune(): Promise<void> {
    return this.trim(true)
  }

  // Prepare-only adapter consumers may return without a publication verification.
  finishStandaloneUse(): Promise<void> | undefined {
    if (this.untrimmedWrites) return this.trim(false)
    return undefined
  }

  private trim(refresh: boolean): Promise<void> {
    if (this.pendingPrune && (!refresh || this.pendingPrune.refresh)) return this.pendingPrune.work
    const work = this.writes
      .then(async () => {
        const scan = refresh || !this.inventory
        const cutoff = this.now() - this.orphanGraceMs
        const inventory =
          refresh || !this.inventory ? await CacheInventory.read(this.records) : this.inventory
        await inventory.prune(
          this.records,
          this.limits,
          this.pinnedKeys,
          this.pinnedBlobs,
          scan ? cutoff : undefined,
        )
        this.inventory = inventory
        this.untrimmedWrites = false
      })
      .catch(() => {
        this.inventory = undefined
        this.warn('Could not prune the local image cache.')
      })
      .finally(() => {
        if (this.pendingPrune?.work === work) this.pendingPrune = undefined
      })
    this.pendingPrune = { work, refresh }
    this.writes = work
    return work
  }
  write(
    key: Digest,
    trial: ImageTrial,
    input: ImageInputBytes,
    selection: TrialResult,
  ): Promise<void> {
    const work = this.writes
      .then(async () => {
        const write = () =>
          this.records.write(key, trial, input, selection, {
            replace: false,
            repairBlob: true,
          })
        const { recordSize, blob } =
          selection.kind === 'adopted'
            ? await this.records.withBlobLock(sha256(selection.bytes), write)
            : await write()
        const now = this.now()
        this.pin(key, blob?.digest)
        await this.touch(key)
        this.inventory?.rememberRecord({
          file: this.records.recordPath(key),
          key,
          size: recordSize,
          digest: blob?.digest,
          created: now,
          mtime: now,
        })
        if (blob)
          this.inventory?.rememberBlob({
            file: this.records.blobPath(blob.digest),
            key: blob.digest,
            size: blob.size,
            created: now,
            mtime: now,
          })
        this.untrimmedWrites = true
      })
      .catch(() => this.warn('Could not write a local image cache record.'))
    this.writes = work
    return work
  }

  private pin(key: Digest, digest?: Digest): void {
    this.pinnedKeys.add(key)
    if (digest) this.pinnedBlobs.add(digest)
  }

  private async touch(key: Digest): Promise<void> {
    const now = new Date(this.now())
    await fs.utimes(this.records.recordPath(key), now, now).catch((error: unknown) => {
      if (!hasErrorCode(error, 'ENOENT')) this.warn('Could not update local image cache recency.')
    })
  }
}
