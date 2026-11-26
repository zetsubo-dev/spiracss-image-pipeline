import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'
import sharp from 'sharp'

import { TrialRecordStore } from '../../dist/store/trial-record.js'
import { cacheFixture, cacheFiles } from '../support/cache.mjs'
import { makePng, request, file, temporaryProject } from '../support/project.mjs'

test('local LRU keeps only the latest entry and blob', async (t) => {
  const { root, options, use } = await cacheFixture(t)
  for (const color of ['red', 'green', 'blue'])
    await createImageBuild({ ...options, localCache: { maxEntries: 1 } }).prepareUse(use(color))
  assert.equal((await cacheFiles(root, 'records')).length, 1)
  assert.equal((await cacheFiles(root, 'blobs')).length, 1)
})

for (const verify of [false, true]) {
  for (const scenario of ['bytes', 'entries', 'lowered']) {
    test(`hit-only local cache pruning: ${scenario}, publication=${verify}`, async (t) => {
      const { root, options, use } = await cacheFixture(t)
      const limits = scenario === 'bytes' ? { maxBytes: 1 } : { maxEntries: 1 }
      const initial = createImageBuild(
        scenario === 'lowered' ? options : { ...options, localCache: limits },
      )
      for (const color of ['red', 'green', 'blue']) await initial.prepareUse(use(color))
      assert.equal((await cacheFiles(root, 'records')).length, 3)
      assert.equal((await cacheFiles(root, 'blobs')).length, 3)
      const hit = createImageBuild({ ...options, localCache: limits })
      await hit.prepareUse(use('blue'))
      if (verify) {
        await fs.mkdir(path.join(root, 'dist'))
        await hit.verifyPublication('dist')
      }
      assert.equal(hit.getStatistics().encodes, 0)
      assert.equal((await cacheFiles(root, 'records')).length, 1)
      assert.equal((await cacheFiles(root, 'blobs')).length, 1)
    })
  }
}

test(
  'concurrent preparations of one image complete with the local cache enabled',
  { timeout: 5000 },
  async (t) => {
    const { options, use } = await cacheFixture(t)
    const build = createImageBuild({ ...options, localCache: { maxEntries: 1 } })
    await Promise.all([build.prepareUse(use('blue')), build.prepareUse(use('blue'))])
  },
)

test('a tiny byte limit protects the active build and later re-encodes', async (t) => {
  const { root, options, use } = await cacheFixture(t)
  const limited = { ...options, localCache: { maxBytes: 1 } }
  const first = createImageBuild(limited)
  const expected = await first.prepareUse(use('red'))
  await createImageBuild(limited).prepareUse(use('blue'))
  assert.equal((await cacheFiles(root, 'records')).length, 1)
  const again = createImageBuild(limited)
  assert.deepEqual((await again.prepareUse(use('red'))).bytes, expected.bytes)
  assert.equal(again.getStatistics().encodes, 1)
})

test('a build retains all its entries until a later build prunes them', async (t) => {
  const { root, options, use } = await cacheFixture(t)
  const limited = { ...options, localCache: { maxEntries: 1 } }
  const build = createImageBuild(limited)
  for (const color of ['red', 'green', 'blue']) {
    const result = await build.prepareUse(use(color))
    const independent = await createImageBuild({
      projectRoot: root,
      config: options.config,
    }).prepareUse(use(color))
    assert.deepEqual(result.bytes, independent.bytes)
    assert.equal((await sharp(result.bytes).metadata()).format, 'webp')
  }
  assert.equal((await cacheFiles(root, 'records')).length, 3)
  await createImageBuild(limited).prepareUse(use('yellow'))
  assert.equal((await cacheFiles(root, 'records')).length, 1)
})

test('standalone preparations enforce limits after later writes with one inventory scan', async (t) => {
  const { root, options, use } = await cacheFixture(t)
  await createImageBuild(options).prepareUse(use('red'))
  const calls = t.mock.method(TrialRecordStore.prototype, 'list')
  const next = createImageBuild({ ...options, localCache: { maxEntries: 2 } })
  await next.prepareUse(use('blue'))
  assert.equal((await cacheFiles(root, 'records')).length, 2)
  await next.prepareUse(use('green'))
  assert.equal((await cacheFiles(root, 'records')).length, 2)
  assert.equal((await cacheFiles(root, 'blobs')).length, 2)
  assert.equal(calls.mock.callCount(), 2)
})

test('local eviction does not modify the adopted store', async (t) => {
  const { root, options, use } = await cacheFixture(t)
  await createImageBuild({ ...options, adoptedStoreDir: '.image-adopted' }).prepareUse(use('red'))
  async function snapshot() {
    const files = await fs.readdir(path.join(root, '.image-adopted'), {
      recursive: true,
      withFileTypes: true,
    })
    const entries = files.filter(
      (f) => f.isFile() && (f.parentPath.includes('/records/') || f.parentPath.includes('/blobs/')),
    )
    return Promise.all(
      entries.map(async (f) => [
        path.join(f.parentPath, f.name),
        createHash('sha256')
          .update(await fs.readFile(path.join(f.parentPath, f.name)))
          .digest('hex'),
      ]),
    ).then((x) => x.sort())
  }
  const before = await snapshot()
  assert.ok(before.length >= 2)
  for (const color of ['green', 'blue'])
    await createImageBuild({ ...options, localCache: { maxEntries: 1 } }).prepareUse(use(color))
  assert.deepEqual(await snapshot(), before)
})

test('invalid explicit local cache limits throw', () => {
  for (const name of ['maxBytes', 'maxEntries'])
    for (const value of [0, -1, 1.5, NaN, Infinity, null, '1', Number.MAX_SAFE_INTEGER + 1])
      assert.throws(
        () => createImageBuild({ projectRoot: '.', localCache: { [name]: value } }),
        /Invalid localCache/u,
      )
})

test('missing or damaged cache records and blobs cause recomputation', async (t) => {
  const { root, options, use } = await cacheFixture(t)
  const expected = await createImageBuild(options).prepareUse(use('red'))
  for (const kind of ['records', 'blobs']) {
    const target = (await cacheFiles(root, kind))[0]
    await fs.writeFile(target, Buffer.alloc((await fs.stat(target)).size))
    const build = createImageBuild(options)
    assert.deepEqual((await build.prepareUse(use('red'))).bytes, expected.bytes)
    assert.equal(build.getStatistics().encodes, 1)
    await fs.rm((await cacheFiles(root, kind))[0])
    const missing = createImageBuild(options)
    assert.deepEqual((await missing.prepareUse(use('red'))).bytes, expected.bytes)
    assert.equal(missing.getStatistics().encodes, 1)
  }
})

test('a min-size conversion rejection is cached as metadata without a blob', async (t) => {
  const projectRoot = await temporaryProject(t)
  const original = await makePng(path.join(projectRoot, file), 9)
  const options = {
    projectRoot,
    cacheDir: '.cache',
    config: { build: { outputFormat: 'avif' }, formats: { avif: { effort: 1 } } },
  }
  const result = await createImageBuild(options).prepareUse(request())
  assert.deepEqual(result.bytes, original)
  const files = await cacheFiles(projectRoot, 'records')
  const records = await Promise.all(
    files.map(async (file) => JSON.parse(await fs.readFile(file, 'utf8'))),
  )
  const rejected = records.find(({ result }) => result.kind === 'skipped-min-size')
  assert.ok(rejected)
  assert.deepEqual(Object.keys(rejected.result).sort(), ['candidateSize', 'kind'])
  assert.equal((await cacheFiles(projectRoot, 'blobs')).length, 0)
  const warm = createImageBuild(options)
  assert.deepEqual((await warm.prepareUse(request())).bytes, original)
  assert.equal(warm.getStatistics().localHits, 2)
  assert.equal(warm.getStatistics().encodes, 0)
})

test('a local cache write failure warns and returns the generated bytes', async (t) => {
  const { root, options, use } = await cacheFixture(t)
  const directory = path.join(root, '.cache/trials-v1')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, '.tmp'), 'not a directory')
  const expected = await createImageBuild({ ...options, cacheDir: undefined }).prepareUse(
    use('red'),
  )
  const warnings = []
  const build = createImageBuild({
    ...options,
    onWarning: (message) => {
      warnings.push(message)
      throw new Error('logging failed')
    },
  })
  assert.deepEqual(await build.prepareUse(use('red')), expected)
  assert.deepEqual(warnings, ['Could not write a local image cache record.'])
  assert.equal(build.getStatistics().encodes, 1)
})

test('the current build neither reads nor deletes the legacy local cache', async (t) => {
  const { root, options, use } = await cacheFixture(t)
  const oldManifest = path.join(root, '.cache/custom-overrides-webp-cache.json')
  const oldBlob = path.join(root, '.cache/custom-overrides', 'legacy.webp')
  await fs.mkdir(path.dirname(oldBlob), { recursive: true })
  const legacy = await sharp(path.join(root, 'blue.png')).webp().toBuffer()
  const manifest = JSON.stringify({ version: 1, entries: [{ blob: path.basename(oldBlob) }] })
  await fs.writeFile(oldManifest, manifest)
  await fs.writeFile(oldBlob, legacy)
  const reads = t.mock.method(fs, 'readFile')
  const expected = await createImageBuild({ ...options, cacheDir: undefined }).prepareUse(
    use('red'),
  )
  const build = createImageBuild({ ...options, localCache: { maxEntries: 1 } })
  assert.deepEqual(await build.prepareUse(use('red')), expected)
  assert.equal(build.getStatistics().encodes, 1)
  assert.equal(build.getStatistics().localHits, 0)
  assert.ok(
    reads.mock.calls.every(({ arguments: [file] }) => file !== oldManifest && file !== oldBlob),
  )
  reads.mock.restore()
  assert.equal(await fs.readFile(oldManifest, 'utf8'), manifest)
  assert.deepEqual(await fs.readFile(oldBlob), legacy)
})

test('default limits retain a warm local hit', async (t) => {
  const { options, use } = await cacheFixture(t)
  const expected = await createImageBuild(options).prepareUse(use('red'))
  const warm = createImageBuild(options)
  assert.deepEqual((await warm.prepareUse(use('red'))).bytes, expected.bytes)
  assert.ok(warm.getStatistics().localHits >= 1)
  assert.equal(warm.getStatistics().encodes, 0)
})

test('local cache hits update LRU order and protect referenced blobs', async (t) => {
  const { root, options, use } = await cacheFixture(t)
  const limited = { ...options, localCache: { maxEntries: 2 } }
  const red = await createImageBuild(limited).prepareUse(use('red'))
  await createImageBuild(limited).prepareUse(use('green'))
  const records = await cacheFiles(root, 'records')
  for (const record of records) await fs.utimes(record, new Date(1000), new Date(1000))
  const warm = createImageBuild(limited)
  assert.deepEqual((await warm.prepareUse(use('red'))).bytes, red.bytes)
  await createImageBuild(limited).prepareUse(use('blue'))
  const retained = createImageBuild(limited)
  assert.deepEqual((await retained.prepareUse(use('red'))).bytes, red.bytes)
  assert.equal(retained.getStatistics().encodes, 0)
  assert.equal(retained.getStatistics().localHits, 1)
})
