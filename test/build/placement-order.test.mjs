import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'

import { file, makePng, request, temporaryProject } from '../support/project.mjs'

function publish(build, prepared, destination) {
  return Promise.resolve().then(() =>
    build.publish(prepared, {
      owner: 'source',
      generated: true,
      destination,
      url: '/' + destination,
    }),
  )
}

test('unknown output volume blocks casing collisions before returning a URL', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  const build = createImageBuild({
    projectRoot,
    config: { build: { outputFormat: 'webp' }, formats: { webp: { minSize: false } } },
  })
  await build.registerFixedCopies([{ file, destination: 'FALLBACK.webp' }])
  const prepared = await build.prepareUse(request())
  assert.equal(prepared.format, 'webp')
  await assert.rejects(publish(build, prepared, 'fallback.webp'), /Rename the fixed public asset/u)
})

test('verification checks storage overlap and refuses a different output directory', async (t) => {
  const projectRoot = await temporaryProject(t)
  const implicit = createImageBuild({ projectRoot, cacheDir: 'dist/cache' })
  await assert.rejects(implicit.verifyPublication('dist'), /Image storage overlaps build output/u)
  const explicit = createImageBuild({ projectRoot, outputDir: 'dist' })
  await fs.mkdir(path.join(projectRoot, 'dist'))
  await fs.symlink('dist', path.join(projectRoot, 'linked-output'))
  await explicit.verifyPublication('linked-output')
  await assert.rejects(explicit.verifyPublication('other'), /Image build output directory differs/u)
})

async function hasCaseInsensitivePaths(projectRoot) {
  await fs.mkdir(path.join(projectRoot, 'Case-Probe'))
  try {
    await fs.stat(path.join(projectRoot, 'case-probe'))
    return true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return false
  }
}

test('verifies an output directory created after registration with another spelling', async (t) => {
  const projectRoot = await temporaryProject(t)
  const insensitive = await hasCaseInsensitivePaths(projectRoot)
  t.diagnostic(`caseInsensitive=${insensitive}`)
  const build = createImageBuild({ projectRoot, outputDir: 'DIST' })
  await build.registerFixedCopies([])
  await fs.mkdir(path.join(projectRoot, 'dist'))
  const results = await Promise.allSettled([
    build.verifyPublication('DIST'),
    build.verifyPublication('dist'),
  ])
  if (insensitive) {
    assert.deepEqual(
      results.map(({ status }) => status),
      ['fulfilled', 'fulfilled'],
    )
  } else {
    assert.equal(results[0].status, 'rejected')
    assert.equal(results[0].reason.code, 'ENOENT')
    assert.equal(results[1].status, 'rejected')
    assert.match(results[1].reason.message, /Image build output directory differs/u)
  }
})

test('accepts a symlink to the output directory created after registration', async (t) => {
  const projectRoot = await temporaryProject(t)
  const outputDir = (await hasCaseInsensitivePaths(projectRoot)) ? 'DIST' : 'dist'
  const build = createImageBuild({ projectRoot, outputDir })
  await build.registerFixedCopies([])
  await fs.mkdir(path.join(projectRoot, 'dist'))
  await fs.symlink('dist', path.join(projectRoot, 'linked-output'))
  await build.verifyPublication('linked-output')
})

test('rejects a different output directory before and after creation', async (t) => {
  const projectRoot = await temporaryProject(t)
  const build = createImageBuild({ projectRoot, outputDir: 'dist' })
  await build.registerFixedCopies([])
  await assert.rejects(build.verifyPublication('dist'), { code: 'ENOENT' })
  await assert.rejects(build.verifyPublication('other'), /Image build output directory differs/u)
  await fs.mkdir(path.join(projectRoot, 'dist'))
  await fs.mkdir(path.join(projectRoot, 'other'))
  await assert.rejects(build.verifyPublication('other'), /Image build output directory differs/u)
})

test('distinguishes DIST and dist when the volume allows both to exist', async (t) => {
  const projectRoot = await temporaryProject(t)
  const insensitive = await hasCaseInsensitivePaths(projectRoot)
  t.diagnostic(`caseInsensitive=${insensitive}`)
  const build = createImageBuild({ projectRoot, outputDir: 'DIST' })
  await build.registerFixedCopies([])
  await fs.mkdir(path.join(projectRoot, 'DIST'))
  if (insensitive) {
    await assert.rejects(fs.mkdir(path.join(projectRoot, 'dist')), { code: 'EEXIST' })
    await build.verifyPublication('dist')
  } else {
    await fs.mkdir(path.join(projectRoot, 'dist'))
    await build.verifyPublication('DIST')
    await assert.rejects(build.verifyPublication('dist'), /Image build output directory differs/u)
  }
})

test('resolves the registered output again after it is replaced', async (t) => {
  const projectRoot = await temporaryProject(t)
  const insensitive = await hasCaseInsensitivePaths(projectRoot)
  const registered = path.join(projectRoot, 'DIST')
  await fs.mkdir(registered)
  const build = createImageBuild({ projectRoot, outputDir: 'DIST' })
  await build.registerFixedCopies([])
  await fs.rename(registered, path.join(projectRoot, 'previous-output'))
  await fs.mkdir(path.join(projectRoot, 'dist'))
  if (!insensitive) {
    await assert.rejects(build.verifyPublication('dist'), /Image build output directory differs/u)
    await fs.mkdir(registered)
  }
  await build.verifyPublication('DIST')
  if (insensitive) await build.verifyPublication('dist')
})

test('generated publish requires a successful declaration, including empty declarations', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  const options = { projectRoot, skipProcessing: true }
  const build = createImageBuild(options)
  const prepared = await build.prepareUse(request())
  await assert.rejects(publish(build, prepared, file), /Declare fixed image placements/u)
  await assert.rejects(build.registerFixedCopies([{ file: 'missing.png', destination: file }]))
  await assert.rejects(publish(build, prepared, file), /Declare fixed image placements/u)
  await build.registerFixedCopies([])
  await build.checkpoint('empty.json')
  const restored = createImageBuild(options)
  await restored.resume('empty.json')
  assert.equal(
    (await publish(restored, await restored.prepareUse(request()), file)).url,
    '/' + file,
  )
  assert.equal((await publish(build, prepared, file)).url, '/' + file)
})
