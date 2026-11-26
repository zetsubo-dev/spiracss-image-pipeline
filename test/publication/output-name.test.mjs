import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { outputNameKey } from '../../dist/publication/output-name.js'
import { isCaseInsensitiveOutput } from '../../dist/publication/output-paths.js'
import { temporaryProject } from '../support/project.mjs'

test('all Unicode casing and decomposition variants that share an inode share an output key', async (t) => {
  const directory = await temporaryProject(t)
  const insensitive = await isCaseInsensitiveOutput(directory)
  let probed = 0
  let aliases = 0
  for (let code = 0; code <= 0x10ffff; code++) {
    const name = String.fromCodePoint(code)
    const variants = new Set([
      name.toUpperCase(),
      name.toLowerCase(),
      name.normalize('NFD'),
      name.normalize('NFKD'),
      outputNameKey(name, true),
    ])
    variants.delete(name)
    if (!variants.size) continue
    const original = path.join(directory, `image-${name}.svg`)
    await fs.writeFile(original, '', { flag: 'wx' })
    const inode = await fs.stat(original)
    try {
      for (const variant of variants) {
        if (variant.includes('/')) continue
        probed++
        const alias = await fs.stat(path.join(directory, `image-${variant}.svg`)).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
        if (alias?.dev === inode.dev && alias.ino === inode.ino) {
          aliases++
          assert.equal(
            outputNameKey(variant, insensitive),
            outputNameKey(name, insensitive),
            `U+${code.toString(16)} and ${JSON.stringify(variant)}`,
          )
        }
      }
    } finally {
      await fs.unlink(original)
    }
  }
  assert.ok(probed > 15000)
  t.diagnostic(
    `${probed} filename pairs, ${aliases} inode aliases, case-insensitive volume: ${insensitive}`,
  )
})

test('output name measurement keeps the strict key when the volume is inaccessible', async (t) => {
  const directory = await temporaryProject(t)
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  t.mock.method(fs, 'mkdtemp', async () => {
    throw error
  })
  assert.equal(await isCaseInsensitiveOutput(path.join(directory, 'yet-to-exist')), true)
})
