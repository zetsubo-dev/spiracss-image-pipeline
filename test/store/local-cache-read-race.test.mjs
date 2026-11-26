import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'

import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'

import { cacheFixture, cacheFiles } from '../support/cache.mjs'

test('deletion during a cache read falls back to encoding', async (t) => {
  const { root, options, use } = await cacheFixture(t)
  const expected = await createImageBuild(options).prepareUse(use('red'))
  for (const kind of ['records', 'blobs']) {
    const target = (await cacheFiles(root, kind))[0]
    const originalReadFile = fs.readFile
    let removed = false
    fs.readFile = async function (file, ...args) {
      if (!removed && file === target) {
        removed = true
        await fs.rm(target)
      }
      return originalReadFile.call(this, file, ...args)
    }
    try {
      const build = createImageBuild(options)
      assert.deepEqual((await build.prepareUse(use('red'))).bytes, expected.bytes)
      assert.equal(build.getStatistics().encodes, 1)
      assert.equal(removed, true)
    } finally {
      fs.readFile = originalReadFile
    }
  }
})
