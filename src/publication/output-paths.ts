import fs from 'node:fs/promises'
import path from 'node:path'

import { hasErrorCode } from '../shared/fs.ts'

export async function resolvePlannedPath(file: string): Promise<string> {
  try {
    return await fs.realpath(file)
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error
    const parent = path.dirname(file)
    if (parent === file) throw error
    return path.join(await resolvePlannedPath(parent), path.basename(file))
  }
}

export async function isCaseInsensitiveOutput(file: string): Promise<boolean> {
  let directory = file
  // Create the probe inside the destination volume, including when the
  // nearest existing directory is itself a mount point.
  while (true) {
    try {
      if (!(await fs.stat(directory)).isDirectory()) return true
      break
    } catch (error) {
      const parent = path.dirname(directory)
      if (!hasErrorCode(error, 'ENOENT') || parent === directory) return true
      directory = parent
    }
  }
  let probe: string
  try {
    probe = await fs.mkdtemp(path.join(directory, '.image-case-'))
  } catch {
    return true
  }
  try {
    const alternate = path.join(directory, path.basename(probe).replace('.image-', '.Image-'))
    await fs.stat(alternate)
    return true
  } catch (error) {
    return !hasErrorCode(error, 'ENOENT')
  } finally {
    await fs.rmdir(probe)
  }
}
