import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import * as pipeline from '@spiracss/image-pipeline'

import { temporaryProject } from '../support/project.mjs'

test('the public source ledger appender serializes, validates, and deduplicates records', async (t) => {
  assert.equal(typeof pipeline.recordSourceImages, 'function')
  const projectRoot = await temporaryProject(t)
  const ledger = path.join(projectRoot, pipeline.sourceImageRecordName)
  const initial = 'a'.repeat(64)
  const digest = 'b'.repeat(64)
  const processingSignature = 'c'.repeat(64)
  await fs.writeFile(ledger, initial)
  const options = {
    projectRoot,
    digests: [digest, digest],
    processingSignature,
    sourceRecordLockPath: '.cache/source-record.lock',
  }
  const results = await Promise.all([
    pipeline.recordSourceImages(options),
    pipeline.recordSourceImages(options),
  ])
  assert.deepEqual(results.sort(), [0, 1])
  assert.equal(await pipeline.recordSourceImages({ ...options, processingSignature: undefined }), 0)
  await assert.rejects(
    pipeline.recordSourceImages({ ...options, digests: ['invalid'] }),
    /Invalid image processing record/u,
  )
  const stop = new AbortController()
  stop.abort(new Error('canceled'))
  await assert.rejects(
    pipeline.recordSourceImages({ ...options, signal: stop.signal }),
    /canceled/u,
  )
  assert.equal(await fs.readFile(ledger, 'utf8'), `${initial}\n${digest} ${processingSignature}\n`)
})
