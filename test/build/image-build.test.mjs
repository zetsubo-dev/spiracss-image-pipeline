import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { optimizeSources } from '@spiracss/image-pipeline'
import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'

import { temporaryProject, makePng, file, request, declaredBuild } from '../support/project.mjs'

test('body, CSS and metadata resolve independently and share the same adopted trials', async (t) => {
  const projectRoot = await temporaryProject(t)
  const bytes = await makePng(path.join(projectRoot, file))
  const config = {
    build: { outputFormat: 'avif', preserveFormatFor: ['ogp'] },
    formats: { avif: { minSize: false, effort: 1 } },
  }
  const options = { projectRoot, config, adoptedStoreDir: '.image-adopted', cacheDir: '.cache' }
  const build = await declaredBuild(options)
  const [body, css, ogp] = await Promise.all([
    build.resolveUse(request()),
    build.resolveUse(request()),
    build.resolveUse(request('ogp')),
  ])
  assert.equal(body.format, 'avif')
  assert.equal(ogp.format, 'png')
  assert.equal(body.destination, css.destination)
  assert.deepEqual(body.bytes, css.bytes)
  assert.equal(build.getStatistics().encodes, 2)
  assert.equal(build.getStatistics().joinedTrials, 1)
  const nameHash = createHash('sha256')
    .update('image-name-v1\0')
    .update(Buffer.from(body.sourceDigest, 'hex'))
    .update(Buffer.from(body.outputDigest, 'hex'))
    .digest('hex')
  assert.equal(body.destination, `images/example-${nameHash.slice(0, 12)}.avif`)
  assert.deepEqual(await fs.readFile(path.join(projectRoot, file)), bytes)

  const secondRoot = await temporaryProject(t)
  await fs.writeFile(path.join(secondRoot, file), bytes)
  await fs.cp(path.join(projectRoot, '.image-adopted'), path.join(secondRoot, '.image-adopted'), {
    recursive: true,
  })
  const secondBuild = await declaredBuild({ ...options, projectRoot: secondRoot })
  assert.deepEqual(await secondBuild.resolveUse(request('ogp')), ogp)
  assert.deepEqual(await secondBuild.resolveUse(request()), body)
  assert.equal(secondBuild.getStatistics().encodes, 0)
  assert.equal(secondBuild.getStatistics().sharedHits, 2)

  const changedConfig = {
    ...config,
    formats: { avif: { minSize: false, effort: 1, quality: 11 } },
  }
  const changed = await declaredBuild({ ...options, config: changedConfig })
  assert.deepEqual(await changed.resolveUse(request('ogp')), ogp)
  assert.equal(changed.getStatistics().encodes, 0)

  const blob = path.join(
    secondRoot,
    '.image-adopted/blobs',
    body.outputDigest.slice(0, 2),
    body.outputDigest,
  )
  await fs.writeFile(blob, Buffer.alloc(body.bytes.length))
  const corrupt = createImageBuild({ ...options, projectRoot: secondRoot })
  await assert.rejects(corrupt.resolveUse(request()), /Missing or damaged adopted image/u)
  assert.equal(corrupt.getStatistics().encodes, 0)
})

test('a rejected AVIF and same-as-source PNG are both reused without encoding', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file), 9)
  const options = {
    projectRoot,
    config: { build: { outputFormat: 'avif' }, formats: { avif: { effort: 1 } } },
    adoptedStoreDir: '.image-adopted',
  }
  const cold = await declaredBuild(options)
  const body = await cold.resolveUse(request())
  assert.equal(body.format, 'png')
  assert.equal(body.trialKeys.length, 2)
  assert.equal(cold.getStatistics().encodes, 2)
  const warm = await declaredBuild(options)
  assert.deepEqual(await warm.resolveUse(request()), body)
  assert.equal(warm.getStatistics().sharedHits, 2)
  assert.equal(warm.getStatistics().encodes, 0)
})

test('fixed public assets keep their bytes and reject a generated owner at the same placement', async (t) => {
  const projectRoot = await temporaryProject(t)
  const bytes = await makePng(path.join(projectRoot, file))
  const build = createImageBuild({ projectRoot, skipProcessing: true })
  await build.registerFixedCopies([{ file, destination: file }])
  const publicImage = await build.resolveUse({
    ...request(),
    input: { kind: 'fixed-public', file },
    logicalPlacement: file,
    usage: 'favicon',
  })
  assert.equal(publicImage.destination, file)
  assert.deepEqual(publicImage.bytes, bytes)
  for (const spelling of [path.resolve(projectRoot, file), './' + file]) {
    const same = await build.resolveUse({
      ...request(),
      input: { kind: 'fixed-public', file: spelling },
      logicalPlacement: file,
      usage: 'favicon',
    })
    assert.equal(same.destination, file)
    assert.deepEqual(same.bytes, bytes)
  }
  assert.deepEqual(build.getPublishedDestinations(), [file])
  await assert.rejects(
    build.resolveUse({
      ...request('body', undefined),
      hashLength: undefined,
      logicalPlacement: file,
    }),
    /Image publication collision/u,
  )
})

test('a protected use reports the target-format override it overrides', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  const warnings = []
  const build = createImageBuild({
    projectRoot,
    onWarning: (message) => warnings.push(message),
    config: {
      build: {
        preserveFormatFor: ['ogp'],
        customOverridesDist: [{ match: 'images/example.png', format: 'webp' }],
      },
    },
  })
  assert.equal((await build.prepareUse(request())).format, 'webp')
  assert.equal((await build.prepareUse(request('ogp'))).format, 'png')
  assert.equal((await build.prepareUse(request('ogp'))).format, 'png')
  assert.equal(warnings.length, 1)
  assert.match(
    warnings[0],
    /example\.png \(ogp\).*build\.preserveFormatFor.*build\.customOverridesDist\[0\]/u,
  )
})

test('a matching source proof outranks local trials while a shared adoption outranks the proof', async (t) => {
  const projectRoot = await temporaryProject(t)
  const source = path.join(projectRoot, file)
  const original = await makePng(source)
  const config = { build: { outputFormat: false } }
  const localOptions = { projectRoot, cacheDir: '.cache', config }
  const sharedOptions = { ...localOptions, adoptedStoreDir: 'shared-before-ledger' }
  const adopted = await (await declaredBuild(sharedOptions)).resolveUse(request())
  assert.ok(adopted.bytes.length < original.length)

  await optimizeSources({ projectRoot, roots: [file], publicRoots: [], config })
  const ledgerFile = path.join(projectRoot, '.source-image-processed.sha256')
  const [result, signature] = (await fs.readFile(ledgerFile, 'utf8')).trim().split(' ')
  assert.match(signature, /^[a-f0-9]{64}$/u)
  await fs.writeFile(source, original)
  const originalDigest = createHash('sha256').update(original).digest('hex')
  assert.notEqual(result, originalDigest)
  await fs.writeFile(ledgerFile, originalDigest + ' ' + signature + '\n')

  const build = await declaredBuild({ ...localOptions, adoptedStoreDir: 'shared-after-ledger' })
  assert.deepEqual((await build.resolveUse(request())).bytes, original)
  assert.equal(build.getStatistics().sourceRecordHits, 1)
  assert.equal(build.getStatistics().encodes, 0)
  const winner = await declaredBuild(sharedOptions)
  assert.deepEqual(await winner.resolveUse(request()), adopted)
  assert.equal(winner.getStatistics().sharedHits, 1)
})

test('prepared images protect the acquired source and defer publication reservation', async (t) => {
  const projectRoot = await temporaryProject(t)
  const original = await makePng(path.join(projectRoot, file))
  const build = createImageBuild({ projectRoot, skipProcessing: true })
  const use = request()
  const prepared = await build.prepareUse({
    ...use,
    input: { ...use.input, bytes: original },
  })
  assert.deepEqual(build.getPublications(), [])
  assert.deepEqual(prepared.bytes, original)
  await fs.appendFile(path.join(projectRoot, file), Buffer.from([0]))
  await assert.rejects(build.prepareUse(use), /Image input changed after acquisition/u)
})

test('an output cannot contain the adopted store, including through a symlink', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  await fs.mkdir(path.join(projectRoot, 'output'))
  await fs.symlink(path.join(projectRoot, 'output'), path.join(projectRoot, 'alias'))
  const build = createImageBuild({
    projectRoot,
    outputDir: 'output',
    adoptedStoreDir: 'alias/adopted',
  })
  await assert.rejects(build.resolveUse(request()), /Image storage overlaps build output/u)
})
