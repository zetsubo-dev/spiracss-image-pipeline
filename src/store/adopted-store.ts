import fs from 'node:fs/promises'
import path from 'node:path'

import type { ImageTrial, ImageInputBytes, TrialResult } from '../processing/trial.ts'
import { sha256, type Digest } from '../shared/digest.ts'
import { acquireFileLock } from '../shared/file-lock.ts'
import { parseRecord, TrialRecordStore } from './trial-record.ts'

export class AdoptedStore {
  private readonly directory: string
  private readonly records: TrialRecordStore

  private readonly onWarning: ((message: string) => void) | undefined

  constructor(directory: string, onWarning?: (message: string) => void) {
    this.directory = directory
    this.onWarning = onWarning
    this.records = new TrialRecordStore(directory)
  }
  async mutate<T>(action: () => Promise<T>): Promise<T> {
    const release = await acquireFileLock(path.join(this.directory, '.tmp', 'store.lock'), {
      timeoutMs: 300_000,
      onWarning: this.onWarning,
    })
    try {
      return await action()
    } finally {
      await release()
    }
  }
  read(key: Digest, trial: ImageTrial, input: ImageInputBytes): Promise<TrialResult | undefined> {
    return this.records.read(key, trial, input)
  }

  async write(
    key: Digest,
    trial: ImageTrial,
    input: ImageInputBytes,
    selection: TrialResult,
    replace = false,
  ): Promise<void> {
    await this.mutate(() => this.records.write(key, trial, input, selection, { replace }))
  }
  async inventory(): Promise<{
    records: {
      key: Digest
      file: string
      digest: Digest | undefined
      size: number
    }[]
    blobs: {
      size: number
      file: string
      key: Digest
    }[]
  }> {
    const records = await this.records.list('records')
    const blobs = await this.records.list('blobs')
    const sizes = new Map<Digest, number>()
    for (const blob of blobs) sizes.set(blob.key, (await fs.stat(blob.file)).size)
    const verified = new Set<Digest>()
    const entries = []
    for (const { file, key } of records) {
      try {
        const bytes = await fs.readFile(file)
        const { result } = parseRecord(bytes, key)
        const digest = result.kind === 'adopted' ? result.digest : undefined
        if (result.kind === 'adopted') {
          if (sizes.get(result.digest) !== result.size)
            throw new Error(
              `Missing or damaged adopted image: ${this.records.blobPath(result.digest)}`,
            )
          if (!verified.has(result.digest)) {
            const blob = this.records.blobPath(result.digest)
            if (sha256(await fs.readFile(blob)) !== result.digest)
              throw new Error(`Missing or damaged adopted image: ${blob}`)
            verified.add(result.digest)
          }
        }
        entries.push({ key, file, digest, size: bytes.length })
      } catch (cause) {
        throw new Error(`Invalid image result for ${key} at ${file}: ${String(cause)}`, { cause })
      }
    }
    return {
      records: entries,
      blobs: blobs.map((blob) => ({ ...blob, size: sizes.get(blob.key) ?? 0 })),
    }
  }
}
