import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { ImagePipelineError } from '@spiracss/image-pipeline'
import {
  buildBitmapProcessingSignature,
  createImageBuild,
  prepareInlineSvg,
} from '@spiracss/image-pipeline/adapter/v1'

import { makeImageBuild } from '../../dist/build/image-build.js'
import { LocalTrialCache } from '../../dist/store/local-cache.js'
import { file, makePng, request, temporaryProject } from '../support/project.mjs'

for (const asyncWarning of [false, true]) {
  test(`build warnings cannot interrupt preparation or publication (async=${asyncWarning})`, async (t) => {
    const projectRoot = await temporaryProject(t)
    await makePng(path.join(projectRoot, file))
    await fs.mkdir(path.join(projectRoot, 'dist'))
    const warnings = []
    const build = createImageBuild({
      projectRoot,
      outputDir: 'dist',
      config: {
        build: {
          preserveFormatFor: ['ogp'],
          customOverridesDist: [{ match: 'images/example.png', format: 'webp' }],
        },
      },
      onWarning(message) {
        warnings.push(message)
        const error = new Error('logger failed')
        if (asyncWarning) return Promise.reject(error)
        throw error
      },
    })
    assert.equal((await build.prepareUse(request('ogp'))).format, 'png')
    await build.verifyPublication('dist', {
      documents: [
        {
          file: 'runtime.json',
          url: '/runtime.json',
          usageReferences: [{ url: 'not-owned.png', usage: 'ogp' }],
        },
      ],
    })
    assert.equal(warnings.length, 2)
  })
}

test('SVG inline diagnostics expose stable error codes', () => {
  for (const [svg, code] of [
    ['<svg><g id="a"/><g id="a"/></svg>', 'SVG_INLINE_DUPLICATE_ID'],
    ['<svg onload="x"></svg>', 'SVG_INLINE_UNSAFE_ATTRIBUTE'],
    ['<div/>', 'SVG_INLINE_INVALID_SOURCE'],
  ]) {
    assert.throws(
      () => prepareInlineSvg(svg),
      (error) => error instanceof ImagePipelineError && error.code === code,
    )
  }
})

test('importing the package root does not load the watcher', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { registerHooks } from 'node:module'
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === 'chokidar') throw new Error('The root imported the watcher')
      return nextResolve(specifier, context)
    } })
    const { startAdoptedStoreReport } = await import('@spiracss/image-pipeline')
    if (typeof startAdoptedStoreReport !== 'function') throw new Error('Report function is missing')
  `,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(run.status, 0, run.stderr)
})

test('source ledger processing signatures retain the frozen digests', () => {
  assert.equal(
    buildBitmapProcessingSignature('png', { quality: 80 }, 'minify'),
    '47c58a321408955fae04453659827ccd44d26e48758d7c962d0f42398a7d915f',
  )
  assert.equal(
    buildBitmapProcessingSignature('webp', { quality: 81, minSize: false }, 'override'),
    'f0b632fdd4ce50bea0cdce6b8da0923f0abfa9710a03847af08d8630b8b0420c',
  )
})

test('distinguishes cache trimming after verification and during build teardown', async (t) => {
  const projectRoot = await temporaryProject(t)
  const outputDir = 'dist'
  const { build, finish } = makeImageBuild({ projectRoot, outputDir, cacheDir: '.cache' })
  const prune = t.mock.method(LocalTrialCache.prototype, 'prune')
  await assert.rejects(build.verifyPublication(outputDir), { code: 'ENOENT' })
  assert.equal(prune.mock.callCount(), 0)
  await fs.mkdir(path.join(projectRoot, outputDir))
  await build.verifyPublication(outputDir)
  assert.equal(prune.mock.callCount(), 1)
  await finish()
  assert.equal(prune.mock.callCount(), 2)
  await fs.rmdir(path.join(projectRoot, outputDir))
  const other = makeImageBuild({ projectRoot, outputDir, cacheDir: '.cache' })
  await assert.rejects(other.build.verifyPublication(outputDir), { code: 'ENOENT' })
  await other.finish()
  assert.equal(prune.mock.callCount(), 3)
})
