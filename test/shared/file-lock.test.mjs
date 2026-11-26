import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { acquireFileLock } from '../../dist/shared/file-lock.js'

async function lockFixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'image-pipeline-lock-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, lock: path.join(root, 'store.lock') }
}

async function ownInChild(t, lock) {
  const module = new URL('../../dist/shared/file-lock.js', import.meta.url)
  const script = `
    import { acquireFileLock } from ${JSON.stringify(module.href)}
    const release = await acquireFileLock(process.argv[1])
    process.once('message', async () => {
      await release()
      process.disconnect()
    })
    process.send('locked')
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, lock], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    closed.then(() => assert.fail('Lock owner exited before acquiring: ' + stderr)),
  ])
  assert.equal(ready, 'locked')
  return { child, closed }
}

test('file lock writes ownership, releases both files, and can be acquired again', async (t) => {
  const { root, lock } = await lockFixture(t)
  const release = await acquireFileLock(lock)
  try {
    const payload = JSON.parse(await fs.readFile(lock, 'utf8'))
    assert.equal(payload.pid, process.pid)
    assert.ok(payload.token)
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(lock + '.gate', 'owner.json'), 'utf8')),
      payload,
    )
  } finally {
    await release()
  }
  assert.deepEqual(await fs.readdir(root), [])
  const releaseAgain = await acquireFileLock(lock)
  await releaseAgain()
  assert.deepEqual(await fs.readdir(root), [])
})

test(
  'file lock reclaims a dead process lock and gate without leaving quarantine files',
  { timeout: 10_000 },
  async (t) => {
    const { root, lock } = await lockFixture(t)
    const { child, closed } = await ownInChild(t, lock)
    const prior = JSON.parse(await fs.readFile(lock, 'utf8'))
    assert.equal(prior.pid, child.pid)
    assert.equal(child.kill('SIGKILL'), true)
    assert.deepEqual(await closed, [null, 'SIGKILL'])

    const release = await acquireFileLock(lock, { retryMs: 5, timeoutMs: 2_000 })
    try {
      const recovered = JSON.parse(await fs.readFile(lock, 'utf8'))
      assert.equal(recovered.pid, process.pid)
      assert.notEqual(recovered.token, prior.token)
    } finally {
      await release()
    }
    assert.deepEqual(await fs.readdir(root), [])
  },
)

test(
  'file lock preserves a live process lock despite timeout and a zero stale threshold',
  { timeout: 10_000 },
  async (t) => {
    const { root, lock } = await lockFixture(t)
    const { child, closed } = await ownInChild(t, lock)
    const owner = path.join(lock + '.gate', 'owner.json')
    const prior = await fs.readFile(lock, 'utf8')
    assert.equal(JSON.parse(prior).pid, child.pid)
    await assert.rejects(
      acquireFileLock(lock, { retryMs: 5, staleAfterMs: 0, timeoutMs: 75 }),
      /lock acquisition timed out/u,
    )
    assert.equal(await fs.readFile(lock, 'utf8'), prior)
    assert.equal(await fs.readFile(owner, 'utf8'), prior)
    child.send('release')
    assert.deepEqual(await closed, [0, null])
    assert.deepEqual(await fs.readdir(root), [])
  },
)

test('lock diagnostics wait 30 seconds, repeat each minute and keep callback failures isolated', async (t) => {
  const { root } = await lockFixture(t)
  const lock = path.join(root, 'private-filename.lock')
  const release = await acquireFileLock(lock)
  t.after(release)
  const diagnostics = []
  const ticks = [29_999, 30_000, 89_999, 90_000, 149_999, 150_000]
  let elapsed = 0
  const mkdir = fs.mkdir
  t.mock.method(fs, 'mkdir', async (entry, ...args) => {
    if (entry === lock + '.gate') {
      const tick = ticks.shift()
      if (tick === undefined) await release()
      elapsed = tick ?? 150_001
    }
    return mkdir(entry, ...args)
  })
  const subscriber = acquireFileLock(lock, {
    now: () => elapsed,
    retryMs: 1,
    timeoutMs: 300_000,
    signal: AbortSignal.timeout(15_000),
    onWarning(message) {
      diagnostics.push(message)
      if (diagnostics.length === 1) throw new Error('consumer secret')
      if (diagnostics.length === 2) return Promise.reject(new Error('asynchronous consumer secret'))
    },
  })
  const acquired = await subscriber
  await acquired()
  assert.deepEqual(diagnostics, [
    'Waiting for an image pipeline lock (30s elapsed).',
    'Waiting for an image pipeline lock (90s elapsed).',
    'Waiting for an image pipeline lock (150s elapsed).',
    'Acquired the image pipeline lock after 150s.',
  ])
})

test('file lock recovers an old malformed lock and gate', async (t) => {
  const { root, lock } = await lockFixture(t)
  const gate = lock + '.gate'
  await fs.writeFile(lock, '{')
  await fs.mkdir(gate)
  await fs.writeFile(path.join(gate, 'owner.json'), '{')
  const old = new Date(Date.now() - 60_000)
  await Promise.all([fs.utimes(lock, old, old), fs.utimes(gate, old, old)])

  const release = await acquireFileLock(lock, { retryMs: 5, staleAfterMs: 1_000, timeoutMs: 2_000 })
  try {
    assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).pid, process.pid)
  } finally {
    await release()
  }
  assert.deepEqual(await fs.readdir(root), [])
})
