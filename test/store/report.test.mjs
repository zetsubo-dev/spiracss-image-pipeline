import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { startAdoptedStoreReport } from '@spiracss/image-pipeline'
import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'

import { temporaryProject, makePng, file, request } from '../support/project.mjs'

test('successful builds report record and blob additions and only suggest tracking a shareable store', async (t) => {
  const projectRoot = await temporaryProject(t)
  execFileSync('git', ['init', '-q'], { cwd: projectRoot })
  await fs.writeFile(path.join(projectRoot, '.gitignore'), '/maintenance-store/\n')
  await makePng(path.join(projectRoot, file))
  const messages = []
  t.mock.method(console, 'info', (message) => messages.push(message))

  for (const adoptedStoreDir of ['maintenance-store', '.image-adopted']) {
    const report = await startAdoptedStoreReport(projectRoot, adoptedStoreDir)
    const config = { build: { outputFormat: 'webp' } }
    await createImageBuild({ projectRoot, config, adoptedStoreDir }).prepareUse(request())
    await report()
  }

  const reportUnchanged = await startAdoptedStoreReport(projectRoot, '.image-adopted')
  await reportUnchanged()
  assert.equal(
    messages.filter((message) => message.includes('Added 1 record(s) and 1 blob(s)')).length,
    2,
  )
  assert.equal(
    messages.filter((message) =>
      message.includes('spiracss-image-pipeline store check --staged --config <file>'),
    ).length,
    1,
  )
  assert.match(messages[2], /Track \.image-adopted\/records\//u)
  const reportMore = await startAdoptedStoreReport(
    projectRoot,
    '.image-adopted',
    'pnpm image:store check --staged',
  )
  const original = await fs.readFile(path.join(projectRoot, file))
  await fs.writeFile(
    path.join(projectRoot, file),
    Buffer.concat([original, Buffer.from('new input')]),
  )
  await createImageBuild({
    projectRoot,
    config: { build: { outputFormat: 'webp' } },
    adoptedStoreDir: '.image-adopted',
  }).prepareUse(request())
  await reportMore()
  assert.match(messages[3], /Added 1 record\(s\) and 0 blob\(s\)/u)
  assert.match(messages[4], /pnpm image:store check --staged/u)
})
