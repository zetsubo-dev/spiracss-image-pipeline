import fs from 'node:fs/promises'
import path from 'node:path'

import { sha256 } from '../shared/digest.ts'
import { readIfPresent, writeAtomic } from '../shared/fs.ts'
import { logicalRelative } from '../shared/paths.ts'
import type { VerifiedOutputPlan } from './plan.ts'

export async function commitOutput(
  { images, originals, records, stateFile, destination, edited }: VerifiedOutputPlan,
  outputRoot: string,
  processed: string[],
): Promise<void> {
  if (images.size) {
    for (const [file, source] of originals) {
      const existing = await readIfPresent(file)
      if (!existing?.equals(source)) await writeAtomic(file, source)
    }
    for (const [name, { record }] of images) records.set(name, record)
    await writeAtomic(stateFile, JSON.stringify(Object.fromEntries(records)) + '\n')
  }
  for (const [name, { bytes, record }] of images) {
    const file = await destination(name)
    const existing = await readIfPresent(file)
    if (existing && sha256(existing) === record.output) continue
    if ((existing ? sha256(existing) : undefined) !== record.previous)
      throw new Error(`Output image changed after planning: ${name}`)
    await writeAtomic(
      file,
      bytes,
      path.dirname(file),
      existing ? (await fs.stat(file)).mode : undefined,
    )
    processed.push(name)
  }
  for (const [file, { text, original }] of edited) {
    await writeAtomic(file, text, path.dirname(file), (await fs.stat(file)).mode, async () => {
      if (
        (await fs.realpath(file)) !== file ||
        !(await fs.readFile(file)).equals(Buffer.from(original))
      )
        throw new Error(`Output document changed after planning: ${file}`)
    })
    processed.push(logicalRelative(outputRoot, file))
  }
}
