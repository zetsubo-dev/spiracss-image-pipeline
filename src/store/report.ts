import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { isDigest, type Digest } from '../shared/digest.ts'
import { hasErrorCode } from '../shared/fs.ts'
import { shardPath } from './trial-record.ts'

async function digests(directory: string, suffix: string): Promise<Set<Digest>> {
  const entries = await fs
    .readdir(directory, { recursive: true, withFileTypes: true })
    .catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) return []
      throw error
    })
  return new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name.slice(0, entry.name.length - suffix.length))
      .filter(isDigest),
  )
}

export async function startStoreReport(
  projectRoot: string,
  adoptedStoreDir: string,
  checkCommand: string,
  emit: (message: string) => void,
): Promise<() => Promise<void>> {
  const store = path.resolve(projectRoot, adoptedStoreDir)
  const records = path.join(store, 'records')
  const blobs = path.join(store, 'blobs')
  const snapshot = () => Promise.all([digests(records, '.json'), digests(blobs, '')])
  const [previousRecords, previousBlobs] = await snapshot()
  return async () => {
    const [currentRecords, currentBlobs] = await snapshot()
    const addedRecords = [...currentRecords].filter((key) => !previousRecords.has(key))
    const addedBlobs = [...currentBlobs].filter((key) => !previousBlobs.has(key))
    if (!addedRecords.length && !addedBlobs.length) return
    emit(`[image-store] Added ${addedRecords.length} record(s) and ${addedBlobs.length} blob(s).`)
    const firstRecord = addedRecords[0]
    if (!firstRecord) return
    const record = path.join(store, shardPath('records', firstRecord))
    const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', record], {
      cwd: projectRoot,
      stdio: 'ignore',
    })
    if (ignored.status !== 1) return
    const relative = path.relative(projectRoot, store) || '.'
    emit(
      `[image-store] Track ${relative}/records/ and the blobs they reference in ${relative}/blobs/. ` +
        `Verify the staged files with ${checkCommand}.`,
    )
  }
}

/** Report store additions after the caller's build finishes. */
export async function startAdoptedStoreReport(
  projectRoot: string,
  adoptedStoreDir: string,
  checkCommand = 'spiracss-image-pipeline store check --staged --config <file>',
): Promise<() => Promise<void>> {
  return startStoreReport(projectRoot, adoptedStoreDir, checkCommand, (message) =>
    // oxlint-disable-next-line no-console -- The public report writes to the host console.
    console.info(message),
  )
}
