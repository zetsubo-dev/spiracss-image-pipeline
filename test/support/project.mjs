import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'
import sharp from 'sharp'

export async function temporaryProject(t) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'image-pipeline-test-')),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

export async function makePng(file, compressionLevel = 0) {
  const bytes = await sharp({
    create: { width: 48, height: 48, channels: 3, background: { r: 80, g: 91, b: 118 } },
  })
    .png({ compressionLevel })
    .toBuffer()
  await fs.writeFile(file, bytes)
  return bytes
}

export const file = 'example.png'

export function request(usage = 'body', hashLength = 12) {
  return {
    input: { kind: 'generated', file, logicalName: file },
    logicalPlacement: `images/${file}`,
    usage,
    hashLength,
  }
}

export async function declaredBuild(options) {
  const build = createImageBuild(options)
  await build.registerFixedCopies([])
  return build
}

export async function publishUse(build, use, owner = use.input.file) {
  const prepared = await build.prepareUse(use)
  const destination = prepared.suggestedDestination
  return build.publish(prepared, { owner, generated: true, destination, url: '/' + destination })
}
