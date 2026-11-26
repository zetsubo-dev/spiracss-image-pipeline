import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import { getImageDimensions } from '@spiracss/image-pipeline'
import { createImageBuild, prepareInlineSvg } from '@spiracss/image-pipeline/adapter/v1'
import sharp from 'sharp'

import * as imageSize from '../../dist/processing/image-size.js'
import * as signatures from '../../dist/processing/signatures.js'
import * as trial from '../../dist/processing/trial.js'
import { temporaryProject, file, request, makePng } from '../support/project.mjs'

test('source ledger signatures have one implementation and retain the legacy digest', () => {
  const options = { quality: 80, minSize: true, lossless: undefined }
  for (const kind of ['minify', 'override']) {
    assert.equal(
      signatures.bitmapRecordSignature('webp', options, kind),
      signatures.buildBitmapProcessingSignature('webp', options, kind),
    )
  }
  assert.equal('bitmapRecordSignature' in trial, false)
})

test('image size exposes only the reachable named functions', () => {
  assert.deepEqual(Object.keys(imageSize).sort(), ['getImageDimensions', 'getImageSize'])
})

test('AVIF and WebP keep source dimensions and alpha with the configured codec settings', async (t) => {
  const root = await temporaryProject(t)
  await sharp({ create: { width: 64, height: 40, channels: 4, background: '#4889cc80' } })
    .png()
    .toFile(path.join(root, file))
  for (const format of ['avif', 'webp']) {
    const formatOptions = { quality: 70, effort: 1 }
    const result = await createImageBuild({
      projectRoot: root,
      config: {
        build: { outputFormat: format },
        formats: { [format]: { ...formatOptions, minSize: false } },
      },
    }).prepareUse(request())
    const { hasAlpha, width, height } = await sharp(result.bytes).metadata()
    assert.deepEqual({ hasAlpha, width, height }, { hasAlpha: true, width: 64, height: 40 })
    const expected = await sharp(path.join(root, file), { animated: true })
      .withMetadata()
      [format](formatOptions)
      .toBuffer()
    assert.deepEqual(result.bytes, expected)
  }
})

test('probing and inline SVG preparation preserve the existing server contract', async (t) => {
  const projectRoot = await temporaryProject(t)
  const bytes = await makePng(path.join(projectRoot, file))
  assert.deepEqual(getImageDimensions(bytes), { width: 48, height: 48, mime: 'image/png' })
  assert.deepEqual(getImageDimensions(Buffer.from('invalid')), { width: 0, height: 0 })
  const prepared = prepareInlineSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><g id="sample"/></svg>',
  )
  assert.equal(prepared.kind, 'prepared-inline-svg/v1')
  assert.equal(prepared.hasIds, true)
  assert.match(prepared.html, /__SVG_INLINE_INSTANCE_7A4F2C__sample/u)
})
