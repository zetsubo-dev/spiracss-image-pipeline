import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'

import { isCaseInsensitiveOutput } from '../../dist/publication/output-paths.js'
import { temporaryProject } from '../support/project.mjs'

const file = 'source.svg'
const variants = [
  ['σ', 'ς'],
  ['ß', 'ss'],
  ['ﬁ', 'fi'],
  ['ſ', 's'],
  ['µ', 'μ'],
  ['ᾳ', 'αι'],
  ['é', 'e\u0301'],
]

async function prepare(t, options) {
  const projectRoot = await temporaryProject(t)
  await fs.writeFile(path.join(projectRoot, file), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const build = createImageBuild({ projectRoot, skipProcessing: true, ...options })
  const prepared = await build.prepareUse({
    input: { kind: 'generated', file, logicalName: file },
    logicalPlacement: file,
    usage: 'body',
  })
  const publish = (destination) =>
    build.publish(prepared, {
      owner: 'source',
      generated: true,
      destination,
      url: '/' + destination,
    })
  return { build, publish, projectRoot }
}

for (const [fixed, generated] of variants) {
  test(`fixed ${fixed}.svg collides with ${generated}.svg before returning a URL`, async (t) => {
    const { build, publish } = await prepare(t, { caseInsensitiveOutputs: true })
    await build.registerFixedCopies([{ file, destination: fixed + '.svg' }])
    await assert.rejects(
      Promise.resolve().then(() => publish(generated + '.svg')),
      /Rename the fixed public asset/u,
    )
  })
}

test('case-sensitive output keeps ASCII case distinct and rejects canonical aliases', async (t) => {
  const { build, publish } = await prepare(t, { caseInsensitiveOutputs: false })
  await build.registerFixedCopies([
    { file, destination: 'A.svg' },
    { file, destination: 'é.svg' },
  ])
  assert.equal((await publish('a.svg')).destination, 'a.svg')
  await assert.rejects(
    Promise.resolve().then(() => publish('e\u0301.svg')),
    /Rename the fixed public asset/u,
  )
})

test('an actual output-volume measurement selects the ASCII case rule', async (t) => {
  const { build, publish, projectRoot } = await prepare(t, { outputDir: 'dist' })
  const uppercase = path.join(projectRoot, 'A.svg')
  const lowercase = path.join(projectRoot, 'a.svg')
  await fs.writeFile(uppercase, '')
  const original = await fs.stat(uppercase)
  const alternate = await fs.stat(lowercase).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  const insensitive = alternate?.dev === original.dev && alternate.ino === original.ino
  assert.equal(await isCaseInsensitiveOutput(projectRoot), insensitive)
  await build.registerFixedCopies([{ file, destination: 'A.svg' }])
  if (insensitive) {
    assert.throws(() => publish('a.svg'), /Rename the fixed public asset/u)
  } else {
    assert.equal(publish('a.svg').destination, 'a.svg')
  }
})
