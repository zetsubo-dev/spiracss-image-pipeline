import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inspectJson, planManifestImages } from '@spiracss/image-pipeline/adapter/v1'

const manifest = { document: 'site.webmanifest', base: '/site/', siteOrigin: 'https://example.com' }

for (const [text, reason] of [
  ['{', 'JSON_SYNTAX'],
  ['{"icons":[],"icons":[]}', 'JSON_DUPLICATE_KEY'],
]) {
  test(`manifest planning returns ${reason} and preserves the original text`, () => {
    const plan = planManifestImages(text, manifest)
    assert.equal(plan.unknown, true)
    assert.deepEqual(plan.unknownReasons, [reason])
    assert.equal(plan.rewrite(new Map()), text)
    assert.throws(() => inspectJson(text, 'manifest'), { name: 'DocumentJsonError', code: reason })
  })
}

test('unresolvable URLs are reported while valid local references remain available', () => {
  const plan = planManifestImages('{"icons":[{"src":"%zz.png"},{"src":"good.png"}]}', manifest)
  assert.equal(plan.unknown, true)
  assert.deepEqual(plan.unknownReasons, ['UNRESOLVABLE_URL'])
  assert.deepEqual(
    plan.references.map(({ file }) => file),
    ['good.png'],
  )
})

test('external manifests do not contribute uncertainty and same-origin URLs resolve', () => {
  const html = { ...manifest, kind: 'html', document: 'index.html' }
  const links = [
    'https://another.example/site/app.webmanifest',
    '//another.example/site/app.webmanifest',
    'data:application/manifest+json,%7B%7D',
  ]
  const input = links.map((href) => `<link rel="manifest" href="${href}">`).join('')
  const plan = planManifestImages(
    input + '<link rel="manifest" href="//example.com/site/local.json">',
    html,
  )
  assert.equal(plan.unknown, false)
  assert.deepEqual(plan.unknownReasons, [])
  assert.deepEqual(plan.manifests, ['local.json'])
  const broken = planManifestImages('<link rel="manifest" href="%zz.json">', html)
  assert.deepEqual(broken.unknownReasons, ['UNRESOLVABLE_URL'])
})
