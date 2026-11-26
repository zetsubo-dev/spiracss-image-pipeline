import assert from 'node:assert/strict'
import { test } from 'node:test'

test('adapter resolves and rewrites generated manifest image fields relative to the final document', async () => {
  const { inspectManifestImages, resolveReference, rewriteManifestImages } =
    await import('@spiracss/image-pipeline/adapter/v1')
  assert.equal(resolveReference('%zz.png', 'manifest.webmanifest', '/'), undefined)
  const source =
    '\ufeff{"icons":[{"src":"../photos/share.png?v=1#icon","type":"image/png"}],"shortcuts":[{"url":"../photos/share.png","icons":[{"src":"../photos/share.png?x=2#s","type":"image/png"}]}],"screenshots":[{"src":"../photos/share.png?v=1","type":"image/png"}]}'
  const parsed = inspectManifestImages(source)
  assert.equal(parsed.unknown, false)
  const selections = new Map()
  for (const reference of parsed.references) {
    assert.equal(
      resolveReference(reference.url, 'manifests/nested/site.json', '/').file,
      'manifests/photos/share.png',
    )
    selections.set(reference, { destination: 'assets/share.avif', format: 'avif' })
  }
  const result = rewriteManifestImages(
    source,
    parsed.references,
    selections,
    'manifests/nested/site.json',
    '/',
  )
  const json = JSON.parse(result.slice(1))
  assert.equal(json.icons[0].src, '../../assets/share.avif?v=1#icon')
  assert.equal(json.icons[0].type, 'image/avif')
  assert.equal(json.shortcuts[0].icons[0].src, '../../assets/share.avif?x=2#s')
  assert.equal(json.shortcuts[0].url, '../photos/share.png')
  assert.deepEqual(json.screenshots[0], { src: '../photos/share.png?v=1', type: 'image/png' })
})

test('manifest planning resolves HTML base in verification and protects read-only references', async () => {
  const { planManifestImages } = await import('@spiracss/image-pipeline/adapter/v1')
  const html = '<base href="/site/assets/"><link rel="manifest" href="spec.json"><img src="a.png">'
  const options = { kind: 'html', document: 'nested/page.html', base: '/site/' }
  const checked = planManifestImages(html, { ...options, mode: 'verify', readOnly: true })
  assert.deepEqual(checked.manifests, ['assets/spec.json'])
  assert.deepEqual(
    checked.references.map(({ file, readOnly }) => ({ file, readOnly })),
    [{ file: 'assets/a.png', readOnly: true }],
  )
  const conservative = planManifestImages(html, options)
  assert.deepEqual(conservative.references, [])
  assert.equal(conservative.unknown, true)

  const text =
    '\ufeff{"icons":[{"src":"a.png?q=1#x","type":"image/png"}],"screenshots":[{"src":"b.png"}]}'
  const manifestOptions = { document: 'assets/spec.json', base: '/site/' }
  const plan = planManifestImages(text, manifestOptions)
  assert.deepEqual(
    plan.references.map(({ file, readOnly }) => [file, readOnly]),
    [
      ['assets/a.png', false],
      ['assets/b.png', true],
    ],
  )
  const selections = new Map(
    plan.references.map(({ reference }) => [
      reference,
      { destination: 'image.avif', format: 'avif' },
    ]),
  )
  const result = JSON.parse(plan.rewrite(selections).slice(1))
  assert.deepEqual(result.icons, [{ src: '../image.avif?q=1#x', type: 'image/avif' }])
  assert.deepEqual(result.screenshots, [{ src: 'b.png' }])
  const fixed = planManifestImages(text, { ...manifestOptions, readOnly: true })
  assert.ok(fixed.references.every(({ readOnly }) => readOnly))
  assert.equal(fixed.rewrite(selections), text)
  assert.equal(planManifestImages('{', manifestOptions).unknown, true)
})

test('base href resolves image references without changing conservative HTML inspection', async () => {
  const { inspectHtml, resolveReference } = await import('@spiracss/image-pipeline/adapter/v1')
  for (const base of ['/assets/img/photos/', '../assets/img/photos/']) {
    assert.equal(
      resolveReference('base-alias.png?v=1', 'sub/probe.html', '/', 'https://site.test', base)
        ?.file,
      'assets/img/photos/base-alias.png',
    )
  }
  assert.equal(
    resolveReference(
      'base-alias.png',
      'sub/probe.html',
      '/',
      'https://site.test',
      'https://cdn.example.invalid/',
    ),
    undefined,
  )
  const result = inspectHtml('<base href="/assets/"><img src="a.png">')
  assert.deepEqual(result.references, [])
  assert.equal(result.unknown, true)
})
