import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function writeAtomic(
  destination: string,
  bytes: Uint8Array | string,
  temporaryDirectory: string = path.dirname(destination),
  mode?: number,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.mkdir(temporaryDirectory, { recursive: true })
  const temp = path.join(temporaryDirectory, `.image-pipeline-${randomUUID()}`)
  try {
    const handle = await fs.open(temp, 'wx', mode)
    try {
      await handle.writeFile(bytes)
      if (mode !== undefined) await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await beforeRename?.()
    await fs.rename(temp, destination)
  } finally {
    await fs.rm(temp, { force: true })
  }
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file)
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error
    return undefined
  }
}

export async function* listFiles(
  directory: string,
  skip?: (file: string) => boolean,
): AsyncGenerator<string> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (skip?.(file)) continue
    if (entry.isDirectory()) yield* listFiles(file, skip)
    else if (entry.isFile()) yield file
    else if (entry.isSymbolicLink())
      throw new Error(`Symbolic link in output or copy directory: ${file}`)
  }
}
