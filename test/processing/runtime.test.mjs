import assert from 'node:assert/strict'
import { test } from 'node:test'

import { configureImageRuntime } from '@spiracss/image-pipeline/adapter/v1'
import sharp from 'sharp'

test('image runtime applies the configured libvips cache bounds', (t) => {
  const previous = sharp.cache()
  t.after(() =>
    configureImageRuntime({
      cache: { memory: previous.memory.max, files: previous.files.max, items: previous.items.max },
    }),
  )
  configureImageRuntime({ cache: { memory: 256, files: 64, items: 256 } })
  const cache = sharp.cache()
  assert.equal(cache.memory.max, 256)
  assert.equal(cache.files.max, 64)
  assert.equal(cache.items.max, 256)
})
