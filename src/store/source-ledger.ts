import fs from 'node:fs/promises'
import path from 'node:path'

import { isDigest, type Digest } from '../shared/digest.ts'
import { acquireFileLock, type AcquireFileLockOptions } from '../shared/file-lock.ts'
import { readIfPresent, writeAtomic } from '../shared/fs.ts'

export const sourceImageRecordName = '.source-image-processed.sha256'
export type SourceRecord = Map<Digest, Set<Digest>>

export function parseSourceRecord(text: string): SourceRecord {
  const records: SourceRecord = new Map()
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const [source, signature, extra] = line.split(' ')
    if (
      !isDigest(source) ||
      (signature !== undefined && !isDigest(signature)) ||
      extra !== undefined
    )
      throw new Error(`Invalid image processing record in ${sourceImageRecordName}`)
    const signatures = records.get(source) ?? new Set<Digest>()
    if (signature) signatures.add(signature)
    records.set(source, signatures)
  }
  return records
}

export async function readSourceRecord(file: string): Promise<SourceRecord> {
  return parseSourceRecord((await readIfPresent(file))?.toString('utf8') ?? '')
}

interface LedgerEntry {
  digest: Digest
  signature?: Digest
}

export async function updateLedger(
  file: string,
  entries: readonly LedgerEntry[],
  lockFile: string,
  options?: Pick<AcquireFileLockOptions, 'signal' | 'onWarning'>,
): Promise<number> {
  const release = await acquireFileLock(lockFile, { timeoutMs: 300_000, ...options })
  try {
    const text = (await readIfPresent(file))?.toString('utf8') ?? ''
    const records = parseSourceRecord(text)
    const lines = []
    for (const { digest, signature } of entries) {
      const current = records.get(digest)
      if (current && (!signature || current.has(signature))) continue
      lines.push(signature ? `${digest} ${signature}` : digest)
      const signatures = current ?? new Set<Digest>()
      if (signature) signatures.add(signature)
      records.set(digest, signatures)
    }
    if (lines.length) {
      options?.signal?.throwIfAborted()
      const separator = text === '' || text.endsWith('\n') ? '' : '\n'
      await writeAtomic(
        file,
        `${text}${separator}${lines.join('\n')}\n`,
        path.dirname(file),
        text ? (await fs.stat(file)).mode : undefined,
      )
    }
    return lines.length
  } finally {
    await release()
  }
}

export interface RecordSourceImagesOptions {
  projectRoot: string
  digests: Iterable<string>
  processingSignature?: string
  sourceRecordLockPath?: string
  signal?: AbortSignal
  onWarning?: (message: string) => void
}

/** Append verified digests under the same lock as source processing and record merges. */
export async function recordSourceImages(options: RecordSourceImagesOptions): Promise<number> {
  const { projectRoot, processingSignature, signal, onWarning } = options
  signal?.throwIfAborted()
  if (processingSignature !== undefined && !isDigest(processingSignature))
    throw new TypeError(`Invalid image processing record in ${sourceImageRecordName}`)
  const entries: LedgerEntry[] = []
  for (const digest of options.digests) {
    if (!isDigest(digest))
      throw new TypeError(`Invalid image processing record in ${sourceImageRecordName}`)
    entries.push({ digest, signature: processingSignature })
  }
  if (!entries.length) return 0
  const ledger = path.resolve(projectRoot, sourceImageRecordName)
  return updateLedger(
    ledger,
    entries,
    path.resolve(projectRoot, options.sourceRecordLockPath ?? `${ledger}.lock`),
    { signal, onWarning },
  )
}

export async function mergeSourceRecords(options: {
  projectRoot: string
  file: string
  sourceRecordLockPath?: string
  onWarning?: (message: string) => void
}): Promise<number> {
  const source = await fs.readFile(path.resolve(options.projectRoot, options.file), 'utf8')
  const records = parseSourceRecord(source)
  const entries: LedgerEntry[] = []
  for (const [digest, signatures] of records) {
    if (!signatures.size) entries.push({ digest })
    for (const signature of signatures) entries.push({ digest, signature })
  }
  const ledger = path.resolve(options.projectRoot, sourceImageRecordName)
  return await updateLedger(
    ledger,
    entries,
    path.resolve(options.projectRoot, options.sourceRecordLockPath ?? `${ledger}.lock`),
    { onWarning: options.onWarning },
  )
}
