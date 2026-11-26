import fs from 'node:fs/promises'
import path from 'node:path'

import {
  sharedTrialKey,
  type ImageTrial,
  type ImageInputBytes,
  type TrialResult,
} from '../processing/trial.ts'
import { canonicalJson, toJson } from '../shared/canonical-json.ts'
import { isDigest, sha256, type Digest } from '../shared/digest.ts'
import { acquireFileLock } from '../shared/file-lock.ts'
import { hasErrorCode, readIfPresent, writeAtomic } from '../shared/fs.ts'

type RecordResult =
  | { kind: 'adopted'; digest: Digest; size: number }
  | Exclude<TrialResult, { kind: 'adopted' }>
interface TrialRecord {
  version: 1
  key: Digest
  input: { digest: Digest; size: number }
  trial: ImageTrial
  result: RecordResult
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function readRecordResult(
  value: unknown,
  trial: ImageTrial,
  input: TrialRecord['input'],
): RecordResult {
  if (!isObject(value)) throw new Error('Invalid trial result')
  switch (value.kind) {
    case 'adopted':
      if (
        isDigest(value.digest) &&
        value.digest !== input.digest &&
        validSize(value.size) &&
        (trial.adoption === 'always' || value.size < input.size)
      )
        return { kind: 'adopted', digest: value.digest, size: value.size }
      break
    case 'same-as-source':
      if (
        trial.operation !== 'convert' &&
        (value.reason === 'animation' ||
          value.reason === 'id-reference' ||
          value.reason === 'no-gain' ||
          value.reason === 'source-record')
      )
        return { kind: 'same-as-source', reason: value.reason }
      break
    case 'skipped-min-size':
      if (
        trial.operation === 'convert' &&
        trial.adoption === 'smaller' &&
        validSize(value.candidateSize) &&
        value.candidateSize >= input.size
      )
        return { kind: 'skipped-min-size', candidateSize: value.candidateSize }
      break
  }
  throw new Error('Image trial result contradicts its recorded conditions')
}

function parseTrial(value: unknown): ImageTrial {
  if (!isObject(value) || value.version !== 1) throw new Error('Unsupported trial version')
  const { format, operation, adoption } = value
  if (
    format !== 'png' &&
    format !== 'jpeg' &&
    format !== 'gif' &&
    format !== 'webp' &&
    format !== 'avif' &&
    format !== 'svg'
  )
    throw new Error('Invalid trial format')
  if (operation !== 'minify' && operation !== 'convert' && operation !== 'override')
    throw new Error('Invalid trial operation')
  if (adoption !== 'smaller' && adoption !== 'always') throw new Error('Invalid trial adoption')
  if (
    (operation === 'convert' && format !== 'avif' && format !== 'webp') ||
    (operation === 'minify' && adoption !== 'smaller') ||
    (format === 'svg' && adoption !== 'smaller')
  )
    throw new Error('Trial format and adoption contradict the operation')
  return { version: 1, format, operation, adoption, options: toJson(value.options) }
}

export function parseRecord(
  bytes: Buffer,
  key: Digest,
  expected?: { trial: ImageTrial; input: ImageInputBytes },
): TrialRecord {
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (!isObject(parsed) || parsed.version !== 1 || parsed.key !== key || !isObject(parsed.input))
    throw invalidRecord(expected)
  const { digest, size } = parsed.input
  if (expected) {
    if (
      digest !== expected.input.digest ||
      size !== expected.input.bytes.length ||
      canonicalJson(parsed.trial) !== canonicalJson(expected.trial)
    )
      throw invalidRecord(expected)
    const input = { digest: expected.input.digest, size: expected.input.bytes.length }
    return {
      version: 1,
      key,
      input,
      trial: expected.trial,
      result: readRecordResult(parsed.result, expected.trial, input),
    }
  }
  if (!isDigest(digest) || !validSize(size)) throw invalidRecord(expected)
  const input = { digest, size }
  const trial = parseTrial(parsed.trial)
  if (sharedTrialKey(digest, trial) !== key) throw new Error('Trial key does not match its record')
  return { version: 1, key, input, trial, result: readRecordResult(parsed.result, trial, input) }
}

function invalidRecord(expected: unknown): Error {
  return new Error(
    expected ? 'Record has an invalid version, key, input or trial' : 'Invalid record metadata',
  )
}

type RecordDirectory = 'records' | 'blobs'

export function shardPath(directory: RecordDirectory, key: Digest): string {
  return path.posix.join(directory, key.slice(0, 2), key + extensionFor(directory))
}

function extensionFor(directory: RecordDirectory): string {
  return directory === 'records' ? '.json' : ''
}

export function recordedBlobDigest(value: unknown): Digest | undefined {
  if (
    isObject(value) &&
    isObject(value.result) &&
    value.result.kind === 'adopted' &&
    isDigest(value.result.digest)
  )
    return value.result.digest
  return undefined
}

interface WrittenTrialRecord {
  recordSize: number
  blob?: { digest: Digest; size: number }
}

export class TrialRecordStore {
  private readonly directory: string
  private readonly onWarning: ((message: string) => void) | undefined

  constructor(directory: string, onWarning?: (message: string) => void) {
    this.directory = directory
    this.onWarning = onWarning
  }
  recordPath(key: Digest): string {
    return path.join(this.directory, shardPath('records', key))
  }

  blobPath(digest: Digest): string {
    return path.join(this.directory, shardPath('blobs', digest))
  }
  async withBlobLock<T>(digest: Digest, action: () => Promise<T>): Promise<T> {
    const release = await acquireFileLock(path.join(this.directory, '.tmp', `${digest}.lock`), {
      onWarning: this.onWarning,
    })
    try {
      return await action()
    } finally {
      await release()
    }
  }
  async read(
    key: Digest,
    trial: ImageTrial,
    input: ImageInputBytes,
    onRead?: (key: Digest, digest?: Digest) => Promise<void>,
  ): Promise<TrialResult | undefined> {
    const file = this.recordPath(key)
    const source = await readIfPresent(file)
    if (!source) return
    try {
      const result = parseRecord(source, key, { trial, input }).result
      if (result.kind !== 'adopted') {
        if (onRead) await onRead(key)
        return result
      }
      const blob = this.blobPath(result.digest)
      const bytes = await readIfPresent(blob)
      if (!bytes || bytes.length !== result.size || sha256(bytes) !== result.digest)
        throw new Error(`Missing or damaged adopted image: ${blob}`)
      if (onRead) await onRead(key, result.digest)
      return { kind: 'adopted', bytes }
    } catch (cause) {
      throw new Error(`Invalid image result for ${key} at ${file}: ${String(cause)}`, { cause })
    }
  }
  async write(
    key: Digest,
    trial: ImageTrial,
    input: ImageInputBytes,
    selection: TrialResult,
    options: {
      replace: boolean
      repairBlob?: boolean
    },
  ): Promise<WrittenTrialRecord> {
    const result: RecordResult =
      selection.kind === 'adopted'
        ? { kind: 'adopted', digest: sha256(selection.bytes), size: selection.bytes.length }
        : selection
    readRecordResult(result, trial, { digest: input.digest, size: input.bytes.length })
    const file = this.recordPath(key)
    const record: TrialRecord = {
      version: 1,
      key,
      trial,
      input: { digest: input.digest, size: input.bytes.length },
      result,
    }
    const text = `${canonicalJson(record)}\n`
    const blob =
      result.kind === 'adopted' ? { digest: result.digest, size: result.size } : undefined
    const existingRecord = await readIfPresent(file)
    if (existingRecord) {
      let previous: TrialResult | undefined
      try {
        previous = await this.read(key, trial, input)
      } catch (error) {
        if (!options.repairBlob) throw error
      }
      if (!previous && !options.repairBlob)
        throw new Error(`Image result disappeared for ${key} at ${file}`)
      if (previous) {
        const same =
          previous.kind === 'adopted' || selection.kind === 'adopted'
            ? previous.kind === 'adopted' &&
              selection.kind === 'adopted' &&
              previous.bytes.equals(selection.bytes)
            : canonicalJson(previous) === canonicalJson(selection)
        if (same) {
          if (options.repairBlob && blob) await touchBlob(this.blobPath(blob.digest))
          return { recordSize: existingRecord.length, blob }
        }
        if (!options.replace) throw new Error(`Conflicting image result for ${key} at ${file}`)
      }
    }
    const temporary = path.join(this.directory, '.tmp')
    if (selection.kind === 'adopted' && result.kind === 'adopted') {
      const blob = this.blobPath(result.digest)
      const previous = await readIfPresent(blob)
      if (previous && !previous.equals(selection.bytes) && !options.repairBlob)
        throw new Error(`Damaged adopted image: ${blob}`)
      if (!previous?.equals(selection.bytes)) await writeAtomic(blob, selection.bytes, temporary)
      else if (options.repairBlob) await touchBlob(blob)
    }
    await writeAtomic(file, text, temporary)
    return { recordSize: Buffer.byteLength(text), blob }
  }
  async list(directory: RecordDirectory, sort = true): Promise<{ file: string; key: Digest }[]> {
    const base = path.join(this.directory, directory)
    const extension = extensionFor(directory)
    const directories = await fs.readdir(base, { withFileTypes: true }).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return []
      throw error
    })
    const files = []
    for (const entry of directories) {
      if (!entry.isDirectory() || !/^[a-f0-9]{2}$/u.test(entry.name)) continue
      const shard = path.join(base, entry.name)
      const leaves = await fs.readdir(shard, { withFileTypes: true }).catch((error: unknown) => {
        if (hasErrorCode(error, 'ENOENT')) return []
        throw error
      })
      for (const leaf of leaves) {
        if (!leaf.name.endsWith(extension)) continue
        const key = leaf.name.slice(0, leaf.name.length - extension.length)
        if (!isDigest(key) || !key.startsWith(entry.name)) continue
        const file = path.join(shard, leaf.name)
        if (!leaf.isFile()) throw new Error(`Unexpected entry in image result store: ${file}`)
        files.push({ file, key })
      }
    }
    return sort ? files.sort((a, b) => a.key.localeCompare(b.key)) : files
  }
}

async function touchBlob(file: string): Promise<void> {
  const now = new Date()
  await fs.utimes(file, now, now)
}
