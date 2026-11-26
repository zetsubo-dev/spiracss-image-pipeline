import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { sha256 } from '../../dist/shared/digest.js'
import { LocalTrialCache } from '../../dist/store/local-cache.js'
import { shardPath, TrialRecordStore } from '../../dist/store/trial-record.js'
import { temporaryProject } from '../support/project.mjs'

function random(seed) {
  return (max) => {
    seed = (Math.imul(1_664_525, seed) + 1_013_904_223) >>> 0
    return Math.floor((seed / 2 ** 32) * max)
  }
}

async function write(directory, kind, key, bytes, time) {
  const file = path.join(directory, shardPath(kind, key))
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, bytes)
  if (time) await fs.utimes(file, time, time)
}

// The pre-P2b eviction algorithm rebuilt the complete reference set after each removal.
function oldPrune(records, blobs, limits) {
  records = [...records]
  blobs = new Map(blobs.map(({ key, size }) => [key, size]))
  let total = records.reduce((sum, { size }) => sum + size, 0)
  for (const size of blobs.values()) total += size
  const withinLimits = () => records.length <= limits.maxEntries && total <= limits.maxBytes
  const sweep = () => {
    const used = new Set(records.map(({ digest }) => digest))
    for (const [key, size] of blobs) {
      if (used.has(key)) continue
      total -= size
      blobs.delete(key)
    }
  }
  sweep()
  records.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key))
  while (records.length && !withinLimits()) {
    total -= records.shift().size
    sweep()
  }
  return [records.map(({ key }) => key).sort(), [...blobs.keys()].sort()]
}

test('reference-counted LRU retains the same entries and blobs as the old sweep', async (t) => {
  const root = await temporaryProject(t)
  for (let seed = 1; seed <= 64; ++seed) {
    const next = random(Math.imul(seed, 0x9e3779b1))
    const directory = path.join(root, String(seed))
    const records = []
    const blobs = []
    for (let i = 0, n = next(14); i < n; ++i) {
      const key = sha256('blob' + i)
      const size = next(130) + 1
      blobs.push({ key, size })
      await write(directory, 'blobs', key, Buffer.alloc(size))
    }
    for (let i = 0, n = next(22); i < n; ++i) {
      const key = sha256('record' + i)
      const digest = blobs[next(blobs.length + 3)]?.key
      const text = digest ? JSON.stringify({ result: { kind: 'adopted', digest } }) : '{'
      const time = 1_000 + next(7)
      records.push({ key, digest, size: Buffer.byteLength(text), time })
      await write(directory, 'records', key, text, new Date(time * 1_000))
    }
    const limits = { maxBytes: next(2_400) + 1, maxEntries: next(19) + 1 }
    await new LocalTrialCache(directory, limits, { now: () => Date.now() + 660_000 }).prune()
    const store = new TrialRecordStore(directory)
    const actual = await Promise.all(
      ['records', 'blobs'].map(async (kind) => (await store.list(kind)).map(({ key }) => key)),
    )
    assert.deepEqual(actual, oldPrune(records, blobs, limits), 'seed ' + seed)
  }
})

test('concurrent pruning shares one scan and keeps a freshly written orphan through the grace period', async (t) => {
  const directory = await temporaryProject(t)
  const key = sha256('orphan bytes')
  await write(directory, 'blobs', key, 'orphan bytes')
  const birth = await fs.stat(path.join(directory, shardPath('blobs', key)))
  let now = Math.ceil(Math.max(birth.birthtimeMs, birth.mtimeMs)) + 599_000
  const cache = new LocalTrialCache(
    directory,
    { maxBytes: 1, maxEntries: 1 },
    {
      now: () => now,
    },
  )
  const first = cache.prune()
  const concurrent = cache.prune()
  await Promise.all([first, concurrent])
  assert.equal(concurrent, first)
  const store = new TrialRecordStore(directory)
  assert.equal((await store.list('blobs')).length, 1)
  now += 2_000
  await cache.prune()
  assert.equal((await store.list('blobs')).length, 0)
})

test('writing multiple trial records performs no directory scans', async (t) => {
  const directory = await temporaryProject(t)
  const cache = new LocalTrialCache(directory, { maxBytes: 1, maxEntries: 1 })
  const trial = {
    version: 1,
    operation: 'convert',
    format: 'webp',
    adoption: 'smaller',
    options: {},
  }
  const bytes = Buffer.from('input')
  const input = { bytes, digest: sha256(bytes) }
  const list = t.mock.method(TrialRecordStore.prototype, 'list')
  for (let i = 0; i < 5; ++i) {
    await cache.write(sha256(String(i)), trial, input, {
      kind: 'skipped-min-size',
      candidateSize: 5,
    })
  }
  assert.equal(list.mock.callCount(), 0)
  await cache.prune()
  assert.equal(list.mock.callCount(), 2)
})
