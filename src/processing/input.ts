import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { sha256 } from '../shared/digest.ts'
import type { ImageInputBytes } from './trial.ts'

interface AcquiredInput extends ImageInputBytes {
  stamp: string
}

function statStamp(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}

async function acquire(file: string): Promise<AcquiredInput> {
  const handle = await fs.open(file, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error(`Not an image input file: ${file}`)
    const stamp = statStamp(before)
    const bytes = await handle.readFile()
    if (stamp !== statStamp(await handle.stat()))
      throw new Error(`Image input changed during acquisition: ${file}`)
    return { bytes, digest: sha256(bytes), stamp }
  } finally {
    await handle.close()
  }
}

export type InputReader = (file: string, snapshot?: Uint8Array) => Promise<ImageInputBytes>

export function createInputReader(root: string, beforeRead?: () => Promise<void>): InputReader {
  const inputs = new Map<string, Promise<AcquiredInput>>()
  return async function readInput(file: string, snapshot?: Uint8Array): Promise<ImageInputBytes> {
    if (beforeRead) await beforeRead()
    const absolute = path.resolve(root, file)
    let reading = inputs.get(absolute)
    if (!reading) {
      reading = acquire(absolute)
      inputs.set(absolute, reading)
    }
    const input = await reading
    if (
      input.stamp !== statStamp(await fs.stat(absolute)) ||
      (snapshot && sha256(snapshot) !== input.digest)
    )
      throw new Error(`Image input changed after acquisition: ${absolute}`)
    return input
  }
}
