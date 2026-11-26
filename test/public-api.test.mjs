import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { publicDeclarations } from './support/public-declarations.mjs'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const entries = {
  '.': {
    file: 'index',
    names: [
      'ImagePipelineError',
      'baselineSources',
      'collectAdoptedStoreKeys',
      'getImageDimensions',
      'getImageSize',
      'mergeSourceRecords',
      'optimizeSources',
      'parseSourceRecord',
      'processOutput',
      'pruneAdoptedStore',
      'recordSourceImages',
      'refreshAdoptedResult',
      'sourceImageRecordName',
      'startAdoptedStoreReport',
    ],
  },
  './config': {
    file: 'config',
    names: [
      'assertImageOverrideFamily',
      'createImageDistIgnoreMatcher',
      'defineImageConfig',
      'normalizeBitmapOptions',
      'resolveAutomaticImageFormat',
      'resolveImageConfig',
      'resolveImageOverride',
      'standardImageUsages',
    ],
  },
  './adapter/v1': {
    file: 'build',
    names: [
      'BITMAP_MINIFY_PIPELINE_VERSION',
      'IMAGE_OVERRIDE_PIPELINE_VERSIONS',
      'SVG_PIPELINE_VERSION',
      'SVG_PRESERVE_ASPECT',
      'buildBitmapProcessingSignature',
      'buildImageConfigSignature',
      'buildSvgConfigSignature',
      'configureImageRuntime',
      'createImageBuild',
      'createImageJobScheduler',
      'getImageCodecVersions',
      'inspectHtml',
      'inspectJson',
      'inspectManifestImages',
      'locateOutputUrl',
      'planManifestImages',
      'prepareInlineSvg',
      'resolveReference',
      'rewriteManifestImages',
    ],
  },
  './watch': {
    file: 'watch',
    names: ['createSourceEventHandler', 'watchSources'],
  },
}

test('public package entry points match the 0.1.0 API snapshot', async (t) => {
  assert.deepEqual(Object.keys(manifest.exports).sort(), Object.keys(entries).sort())
  assert.deepEqual(manifest.bin, { 'spiracss-image-pipeline': './dist/cli.js' })
  const snapshot = JSON.parse(
    await readFile(new URL('fixtures/public-api.json', import.meta.url), 'utf8'),
  )
  const dist = fileURLToPath(new URL('../dist/', import.meta.url))
  const declarations = publicDeclarations(
    dist,
    Object.values(entries).map(({ file }) => file),
  )
  for (const [entry, { file, names }] of Object.entries(entries)) {
    await t.test(entry, async () => {
      const importPath = `./dist/${file}.js`
      const types = `./dist/${file}.d.ts`
      assert.deepEqual(manifest.exports[entry], { types, import: importPath })
      assert.deepEqual(Object.keys(await import(manifest.name + entry.slice(1))), names)
      assert.deepEqual(declarations[file], snapshot[file], types)
    })
  }
})
