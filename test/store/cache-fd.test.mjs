import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { test } from 'node:test'

import { sha256 } from '../../dist/shared/digest.js'
import { TrialRecordStore } from '../../dist/store/trial-record.js'
import { temporaryProject } from '../support/project.mjs'

test('prune scans more records than the process soft file descriptor limit', async (t) => {
  const directory = await temporaryProject(t)
  const store = new TrialRecordStore(directory)
  for (let i = 0; i < 192; i++) {
    const key = sha256(String(i))
    const file = store.recordPath(key)
    await fs.mkdir(new URL('.', new URL('file://' + file)), { recursive: true })
    await fs.writeFile(file, '{"result":{"kind":"skipped-min-size"}}')
  }
  const script = `
    import { LocalTrialCache } from './dist/store/local-cache.js'
    const warnings = []
    const cache = new LocalTrialCache(process.argv[1], {maxBytes: 1000000, maxEntries: 100}, {
      onWarning: (message) => warnings.push(message),
    })
    await cache.prune()
    if (warnings.length) throw new Error(warnings.join(' '))`
  const child = spawnSync(
    'sh',
    [
      '-ec',
      'ulimit -n 64; exec "$@"',
      'sh',
      process.execPath,
      '--input-type=module',
      '-e',
      script,
      directory,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(child.status, 0, child.stderr)
  assert.equal((await store.list('records')).length, 100)
})
