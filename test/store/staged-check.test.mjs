import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { sharedTrialKey } from '../../dist/processing/trial.js'
import { sha256 } from '../../dist/shared/digest.js'
import { TrialRecordStore } from '../../dist/store/trial-record.js'
import { temporaryProject } from '../support/project.mjs'

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

test('validates every staged result and diagnoses malformed blob-free records by path', async (t) => {
  const cwd = await temporaryProject(t)
  const git = (...args) => execFileSync('git', args, { cwd })
  git('init', '--quiet')
  const root = path.join(cwd, '.image-adopted')
  const store = new TrialRecordStore(root)
  const input = { bytes: Buffer.from('image source'), digest: sha256('image source') }
  const trial = { version: 1, operation: 'minify', adoption: 'smaller', format: 'png', options: {} }
  const convert = { ...trial, operation: 'convert', format: 'webp' }
  const same = sharedTrialKey(input.digest, trial)
  await store.write(
    same,
    trial,
    input,
    { kind: 'same-as-source', reason: 'no-gain' },
    { replace: false },
  )
  await store.write(
    sharedTrialKey(input.digest, convert),
    convert,
    input,
    { kind: 'skipped-min-size', candidateSize: input.bytes.length },
    { replace: false },
  )
  const adopt = { ...convert, adoption: 'always' }
  await store.write(
    sharedTrialKey(input.digest, adopt),
    adopt,
    input,
    { kind: 'adopted', bytes: Buffer.from('output') },
    { replace: false },
  )
  git('add', '.image-adopted')
  const check = () =>
    spawnSync(process.execPath, [cli, 'store', 'check', '--staged'], { cwd, encoding: 'utf8' })
  const healthy = check()
  assert.equal(healthy.status, 0, healthy.stderr)
  assert.deepEqual(JSON.parse(healthy.stdout), { records: 3 })
  const record = store.recordPath(same)
  const relative = path.relative(cwd, record)
  const validRecord = await fs.readFile(record, 'utf8')
  await fs.writeFile(record, '{"result":{"kind":"same-as-source"}}')
  git('add', relative)
  const broken = check()
  assert.equal(broken.status, 1, broken.stdout)
  assert.ok(broken.stderr.includes(relative), broken.stderr)
  await fs.writeFile(record, validRecord)
  const wrongShard = path.join(root, 'records', same.startsWith('00') ? '01' : '00', same + '.json')
  await fs.mkdir(path.dirname(wrongShard), { recursive: true })
  await fs.writeFile(wrongShard, validRecord)
  git('add', relative, path.relative(cwd, wrongShard))
  assert.ok(
    check().stderr.includes(`Invalid staged image record path: ${path.relative(cwd, wrongShard)}`),
  )
})
