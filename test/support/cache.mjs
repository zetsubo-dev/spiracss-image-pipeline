import fs from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import { temporaryProject } from './project.mjs'

export async function cacheFiles(root, kind, cache = '.cache') {
  const base = path.join(root, cache, 'trials-v1', kind)
  const shards = await fs.readdir(base).catch((e) => {
    if (e.code === 'ENOENT') return []
    throw e
  })
  return (
    await Promise.all(
      shards.map(async (shard) =>
        (await fs.readdir(path.join(base, shard))).map((name) => path.join(base, shard, name)),
      ),
    )
  )
    .flat()
    .sort()
}

export async function cacheFixture(t) {
  const root = await temporaryProject(t)
  for (const color of ['red', 'green', 'blue', 'yellow']) {
    await sharp({ create: { width: 48, height: 48, channels: 3, background: color } })
      .png()
      .toFile(path.join(root, `${color}.png`))
  }
  const options = {
    projectRoot: root,
    cacheDir: '.cache',
    config: {
      build: { outputFormat: 'webp' },
      formats: { webp: { minSize: false } },
    },
  }
  const use = (color) => ({
    input: { kind: 'generated', file: `${color}.png`, logicalName: `${color}.png` },
    logicalPlacement: `${color}.png`,
    usage: 'body',
  })
  return { root, options, use }
}
