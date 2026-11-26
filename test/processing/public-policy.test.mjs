import assert from 'node:assert/strict'
import { test } from 'node:test'

test('public policy rules share the configured order, exclusions and automatic format conditions', async () => {
  const {
    assertImageOverrideFamily,
    createImageDistIgnoreMatcher,
    normalizeBitmapOptions,
    resolveAutomaticImageFormat,
    resolveImageOverride,
  } = await import('@spiracss/image-pipeline/config')
  const first = { match: /icons\/.*\.png/gu, format: 'webp' }
  first.match.lastIndex = 50
  assert.equal(
    resolveImageOverride([first, { match: '**/*.png', format: 'avif' }], ['icons/a.png']),
    first,
  )
  assert.equal(first.match.lastIndex, 50)
  const ignore = createImageDistIgnoreMatcher(['icons/**', '!icons/keep.png'])
  assert.equal(ignore('icons/a.png'), true)
  assert.equal(ignore('icons/keep.png'), false)
  assert.equal(resolveAutomaticImageFormat('.JPG', 'webp'), 'webp')
  assert.equal(resolveAutomaticImageFormat('gif', 'avif'), null)
  assert.throws(
    () => assertImageOverrideFamily('.svg', 'webp'),
    /Unsupported image override family/u,
  )
  assert.deepEqual(normalizeBitmapOptions({ lossless: false, quality: undefined }), {
    lossless: false,
  })
})

test('the public source ledger parser reads both record layouts', async () => {
  const { parseSourceRecord, sourceImageRecordName } = await import('@spiracss/image-pipeline')
  assert.equal(sourceImageRecordName, '.source-image-processed.sha256')
  const source = 'a'.repeat(64)
  const signature = 'b'.repeat(64)
  assert.deepEqual(
    parseSourceRecord(source + '\n' + source + ' ' + signature + '\r\n'),
    new Map([[source, new Set([signature])]]),
  )
  assert.throws(() => parseSourceRecord(source + ' invalid'), /Invalid image processing record/u)
})
