import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { isDigest, type Digest } from '../shared/digest.ts'
import { containsPath, logicalRelative } from '../shared/paths.ts'
import { parseRecord, shardPath } from './trial-record.ts'

function gitText(root: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

async function stagedBlob(root: string, file: string): Promise<{ digest: Digest; size: number }> {
  const child = spawn('git', ['show', `:${file}`], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of child.stdout) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary Git output')
    hash.update(chunk)
    size += chunk.length
  }
  if ((await exit) !== 0) throw new Error(`Missing staged image blob: ${file}`)
  const digest = hash.digest('hex')
  if (!isDigest(digest)) throw new Error('Expected a SHA-256 digest')
  return { digest, size }
}

export async function checkStagedStore(
  projectRoot: string,
  adoptedStoreDir: string,
): Promise<number> {
  const root = gitText(projectRoot, ['rev-parse', '--show-toplevel']).trim()
  const directory = path.resolve(projectRoot, adoptedStoreDir)
  if (!containsPath(root, directory) || root === directory)
    throw new Error('The adopted image store must be inside the Git worktree')
  const relative = logicalRelative(root, directory)
  const records = gitText(root, ['ls-files', '-z', '--', `:(literal)${relative}/records`])
    .split('\0')
    .filter((file) => file.endsWith('.json'))
  const verified = new Map<string, { digest: Digest; size: number }>()
  for (const file of records) {
    const key = path.posix.basename(file, '.json')
    if (!isDigest(key) || file !== relative + '/' + shardPath('records', key))
      throw new Error(`Invalid staged image record path: ${file}`)
    const result = stagedResult(root, file, key)
    if (result.kind !== 'adopted') continue
    const { digest, size } = result
    const blob = relative + '/' + shardPath('blobs', digest)
    const actual = verified.get(blob) ?? (await stagedBlob(root, blob))
    if (actual.size !== size || actual.digest !== digest)
      throw new Error(`Staged image blob does not match ${file}: ${blob}`)
    verified.set(blob, actual)
  }
  return records.length
}

function stagedResult(root: string, file: string, key: Digest) {
  try {
    return parseRecord(execFileSync('git', ['show', `:${file}`], { cwd: root }), key).result
  } catch (cause) {
    throw new Error(`Invalid staged image record: ${file}: ${String(cause)}`, { cause })
  }
}
