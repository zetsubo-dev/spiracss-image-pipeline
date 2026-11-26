import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { sharedTrialKey } from '../../dist/processing/trial.js'
import { sha256 } from '../../dist/shared/digest.js'
import { LocalTrialCache } from '../../dist/store/local-cache.js'
import { TrialRecordStore } from '../../dist/store/trial-record.js'
import { temporaryProject } from '../support/project.mjs'

const trial = { version: 1, operation: 'convert', format: 'webp', adoption: 'smaller', options: {} }
const input = { bytes: Buffer.from('source image'), digest: sha256('source image') }
const key = sharedTrialKey(input.digest, trial)
const adopted = { kind: 'adopted', bytes: Buffer.from('result') }
const skipped = { kind: 'skipped-min-size', candidateSize: input.bytes.length }
const limits = { maxBytes: 10_000_000, maxEntries: 10_000 }

async function orphan(store, text) {
  const digest = sha256(text)
  const file = store.blobPath(digest)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  const stale = new Date(Date.now() - 700_000)
  await fs.utimes(file, stale, stale)
  return digest
}

for (const selection of [adopted, skipped]) {
  test(`prune collects an expired orphan alongside two ${selection.kind} records`, async (t) => {
    const directory = await temporaryProject(t)
    const store = new TrialRecordStore(directory)
    const cache = new LocalTrialCache(directory, limits, { now: () => Date.now() + 660_000 })
    await cache.write(key, trial, input, selection)
    await cache.write(sha256('second'), trial, input, selection)
    await orphan(store, 'orphan')
    await cache.prune()
    assert.deepEqual(
      (await store.list('blobs')).map((entry) => entry.key),
      selection.kind === 'adopted' ? [sha256(selection.bytes)] : [],
    )
    assert.equal((await store.list('records')).length, 2)
  })
}

test('a second writer can reclaim a blob after the pruning inventory observed it', async (t) => {
  const directory = await temporaryProject(t)
  const store = new TrialRecordStore(directory)
  const digest = await orphan(store, adopted.bytes)
  const file = store.blobPath(digest)
  const write = new LocalTrialCache(directory, limits)
  const prune = new LocalTrialCache(directory, limits)
  const { resolve: observed, promise: ready } = Promise.withResolvers()
  const { resolve: resume, promise: paused } = Promise.withResolvers()
  const originalStat = fs.stat
  t.mock.method(fs, 'stat', async (entry, ...args) => {
    const result = await originalStat(entry, ...args)
    if (entry === file) Object.defineProperty(result, 'birthtimeMs', { value: result.mtimeMs })
    return result
  })
  const original = await fs.stat(file)
  const readdir = fs.readdir
  t.mock.method(fs, 'readdir', async (entry, ...args) => {
    if (entry !== path.join(directory, 'records')) return readdir(entry, ...args)
    observed()
    await paused
    return []
  })
  const started = prune.prune()
  await ready
  try {
    await write.write(key, trial, input, adopted)
  } finally {
    resume()
    await started
  }
  assert.ok((await fs.stat(file)).mtimeMs > original.mtimeMs)
  assert.deepEqual(await store.read(key, trial, input), adopted)
})

test('prune joining a lightweight trim schedules one additional scan', async (t) => {
  const directory = await temporaryProject(t)
  const cache = new LocalTrialCache(directory, limits)
  await cache.write(key, trial, input, skipped)
  const { resolve: observed, promise: ready } = Promise.withResolvers()
  const { resolve: resume, promise: paused } = Promise.withResolvers()
  const list = TrialRecordStore.prototype.list
  const mock = t.mock.method(TrialRecordStore.prototype, 'list', async function (...args) {
    if (mock.mock.callCount() === 1) {
      observed()
      await paused
    }
    return list.apply(this, args)
  })
  const light = cache.finishStandaloneUse()
  await ready
  const a = cache.prune()
  const b = cache.prune()
  resume()
  await Promise.all([light, a, b])
  assert.equal(mock.mock.callCount(), 4)
})

test(
  'a writer starting between the final stat and unlink can still persist the blob',
  { timeout: 5000 },
  async (t) => {
    const directory = await temporaryProject(t)
    const store = new TrialRecordStore(directory)
    const digest = await orphan(store, adopted.bytes)
    const file = store.blobPath(digest)
    const writer = new LocalTrialCache(directory, limits)
    const pruner = new LocalTrialCache(directory, limits, { now: () => Date.now() + 660_000 })
    const { resolve: beforeUnlink, promise: unlinkReady } = Promise.withResolvers()
    const { resolve: allowUnlink, promise: paused } = Promise.withResolvers()
    const { resolve: writerArrived, promise: waiting } = Promise.withResolvers()
    const remove = fs.rm
    t.mock.method(fs, 'rm', async (entry, ...args) => {
      if (entry === file) {
        beforeUnlink()
        await paused
      }
      return remove(entry, ...args)
    })
    const lock = TrialRecordStore.prototype.withBlobLock
    let lockRequests = 0
    t.mock.method(TrialRecordStore.prototype, 'withBlobLock', function (...args) {
      if (++lockRequests === 2) writerArrived()
      return lock.apply(this, args)
    })
    const pruning = pruner.prune()
    await unlinkReady
    const writing = writer.write(key, trial, input, adopted)
    await waiting
    allowUnlink()
    await Promise.all([pruning, writing])
    assert.deepEqual(await store.read(key, trial, input), adopted)
  },
)
