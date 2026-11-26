import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'
import sharp from 'sharp'

import { temporaryProject, makePng, file, request, publishUse } from '../support/project.mjs'

test('checkpoint verification preserves fixed copies and checks decoded document URLs', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  await fs.writeFile(path.join(projectRoot, 'fixed.css'), '/* fixed */')
  const build = createImageBuild({ projectRoot, skipProcessing: true })
  const output = path.join(projectRoot, 'output')
  const fixed = [{ file: 'fixed.css', destination: 'fixed.css' }]
  await build.registerFixedCopies(fixed)
  const image = await publishUse(build, request())
  await build.checkpoint('record.json')
  await fs.mkdir(path.join(output, 'images'), { recursive: true })
  await fs.copyFile(path.join(projectRoot, 'fixed.css'), path.join(output, 'fixed.css'))
  await fs.writeFile(path.join(output, image.destination), image.bytes)
  await fs.writeFile(
    path.join(output, 'index.html'),
    Buffer.concat([
      Buffer.from('<title>'),
      Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]),
      Buffer.from(`</title><img src=".${image.url}?v=1&amp;w=2">`),
    ]),
  )
  const resumed = createImageBuild({ projectRoot })
  await resumed.resume('record.json')
  assert.equal(resumed.getPublications().length, 1)
  assert.deepEqual(resumed.getPublishedDestinations(), ['fixed.css', image.destination])
  const declaration = {
    documents: [
      {
        file: 'index.html',
        url: '/index.html',
        encoding: 'shift_jis',
        references: [{ url: `.${image.url}?v=1&w=2`, destination: image.destination }],
      },
    ],
  }
  await resumed.verifyPublication(output, declaration)
  await assert.rejects(
    resumed.verifyPublication(output, {
      ...declaration,
      deleted: [image.destination],
    }),
    /declared deleted still exists/u,
  )
  await fs.writeFile(path.join(output, 'fixed.css'), '/* altered */')
  await assert.rejects(resumed.verifyPublication(output), /does not match its recorded bytes/u)
  await fs.copyFile(path.join(projectRoot, 'fixed.css'), path.join(output, 'fixed.css'))
  await fs.unlink(path.join(output, image.destination))
  await assert.rejects(
    resumed.verifyPublication(output, {
      deleted: [image.destination],
      documents: [{ file: 'index.html', url: '/index.html', encoding: 'shift_jis' }],
    }),
    /Reference points to a deleted publication/u,
  )
  await fs.mkdir(path.join(output, 'manifests'))
  await fs.writeFile(
    path.join(output, 'manifests/app.json'),
    JSON.stringify({ icons: [{ src: '../' + image.destination + '?v=1' }] }),
  )
  const deletion = {
    deleted: [image.destination],
    deletionRules: new Map([[image.destination, ['images/**']]]),
    documents: [{ file: 'index.html', url: '/index.html', encoding: 'shift_jis' }],
  }
  for (const manifest of ['app.json', 'app.webmanifest']) {
    if (manifest.endsWith('.webmanifest'))
      await fs.copyFile(
        path.join(output, 'manifests/app.json'),
        path.join(output, 'manifests', manifest),
      )
    await fs.writeFile(
      path.join(output, 'index.html'),
      Buffer.concat([
        Buffer.from('<title>'),
        Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]),
        Buffer.from(`</title><link rel="manifest" href="manifests/${manifest}">`),
      ]),
    )
    await assert.rejects(resumed.verifyPublication(output, deletion), (error) => {
      assert.match(error.message, /Reference points to a deleted publication/u)
      assert.ok(error.message.includes(`../${image.destination}?v=1`))
      assert.ok(error.message.includes(`manifests/${manifest} (linked from index.html)`))
      assert.ok(error.message.includes('matched removeDistFiles.removeList: "images/**"'))
      return true
    })
  }
  await fs.writeFile(path.join(output, 'index.html'), '<html lang="en"></html>')
  await resumed.verifyPublication(output, {
    ...deletion,
    documents: [...deletion.documents, { file: 'manifests/app.json', url: '/manifests/app.json' }],
  })
})

test('final publication checks protected HTML, manifest, and framework data image uses', async (t) => {
  const projectRoot = await temporaryProject(t)
  const original = await makePng(path.join(projectRoot, file))
  const output = path.join(projectRoot, 'output')
  await fs.mkdir(path.join(output, 'images'), { recursive: true })
  const build = createImageBuild({
    projectRoot,
    config: {
      build: {
        outputFormat: 'avif',
        preserveFormatFor: [
          'ogp',
          'twitter',
          'favicon',
          'apple-touch-icon',
          'json-ld',
          'manifest-icon',
        ],
      },
      formats: { avif: { minSize: false, effort: 1 } },
    },
  })
  await fs.writeFile(path.join(projectRoot, 'fixed.png'), original)
  await fs.writeFile(path.join(output, 'fixed.png'), original)
  await build.registerFixedCopies([{ file: 'fixed.png', destination: 'fixed.png' }])
  const body = await publishUse(build, request('body'))
  const originalFormat = await publishUse(build, request('ogp'))
  assert.equal(body.format, 'avif')
  for (const image of [body, originalFormat]) {
    await fs.writeFile(path.join(output, image.destination), image.bytes)
  }
  const origin = 'https://site.test'
  const html = { file: 'index.html', url: origin + '/index.html', encoding: 'shift_jis' }
  const declaration = { documents: [html] }
  async function writeHtml(markup) {
    await fs.writeFile(
      path.join(output, html.file),
      Buffer.concat([
        Buffer.from('<title>'),
        Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]),
        Buffer.from('</title>' + markup),
      ]),
    )
  }
  await writeHtml(`<img src="${body.url}"><meta property="og:image" content="${originalFormat.url}">
    <meta property="og:image:type" content="image/png"><meta name="twitter:image" content="https://foreign.test/cover.avif">
    <link rel="icon" href="/fixed.png" type="image/png">`)
  await build.verifyPublication(output, declaration)
  const cases = [
    [
      'ogp',
      `<meta property="og:image" content="${originalFormat.url}"><meta property="og:image:secure_url" content="${origin + body.url}">`,
    ],
    ['twitter', `<meta name="twitter:image:src" content="${body.url}">`],
    ['favicon', `<link rel="icon" href="${originalFormat.url}" type="image/webp">`],
    ['apple-touch-icon', `<link rel="apple-touch-icon" href="${body.url}">`],
    ['json-ld', `<script type="application/ld+json">{"image":"${body.url}"}</script>`],
  ]
  for (const [usage, markup] of cases) {
    await writeHtml(markup)
    await assert.rejects(build.verifyPublication(output, declaration), (error) => {
      for (const evidence of [
        'index.html',
        usage,
        file,
        originalFormat.url,
        usage === 'favicon' ? 'declared image/webp' : body.url,
      ])
        assert.ok(error.message.includes(evidence), error.message)
      return true
    })
  }
  await writeHtml(
    '<base href="https://cdn.example.invalid/"><link rel="icon" href="' + body.url.slice(1) + '">',
  )
  await build.verifyPublication(output, declaration)
  await writeHtml('<base href="http://["><link rel="icon" href="missing.png">')
  await build.verifyPublication(output, declaration)
  await writeHtml('<link rel="manifest" href="/manifest.json">')
  await fs.writeFile(
    path.join(output, 'manifest.json'),
    JSON.stringify({ screenshots: [{ src: body.url, type: 'image/avif' }] }),
  )
  await build.verifyPublication(output, declaration)
  for (const manifest of [
    { icons: [{ src: body.url }] },
    { shortcuts: [{ icons: [{ src: body.url }] }] },
  ]) {
    await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest))
    await assert.rejects(
      build.verifyPublication(output, declaration),
      /Protected image format mismatch.*manifest-icon/u,
    )
  }
  await fs.writeFile(
    path.join(output, 'manifest.json'),
    JSON.stringify({ screenshots: [{ src: body.url }] }),
  )
  await fs.rm(path.join(output, body.destination))
  await assert.rejects(
    build.verifyPublication(output, { ...declaration, deleted: [body.destination] }),
    /Reference points to a deleted publication/u,
  )
  await fs.writeFile(path.join(output, body.destination), body.bytes)
  await writeHtml('<link rel="manifest" href="/manifest.json">')
  await fs.writeFile(
    path.join(output, 'manifest.json'),
    JSON.stringify({
      shortcuts: [{ icons_localized: { ja: [{ src: body.url, type: 'image/avif' }] } }],
    }),
  )
  await assert.rejects(
    build.verifyPublication(output, declaration),
    /manifest\.json .*manifest-icon/u,
  )
  await assert.rejects(
    build.verifyPublication(output, {
      documents: [
        {
          file: 'index.pageContext.json',
          url: origin + '/index.pageContext.json',
          usageReferences: [{ url: body.url, usage: 'ogp' }],
        },
      ],
    }),
    /index\.pageContext\.json \(ogp\)/u,
  )

  const webp = await sharp(original).webp().toBuffer()
  await fs.writeFile(path.join(projectRoot, 'original.webp'), webp)
  const protectedWebp = await publishUse(build, {
    input: { kind: 'generated', file: 'original.webp', logicalName: 'original.webp' },
    logicalPlacement: 'images/original.webp',
    usage: 'ogp',
  })
  await fs.writeFile(path.join(output, protectedWebp.destination), protectedWebp.bytes)
  await writeHtml(`<meta property="og:image" content="${protectedWebp.url}">`)
  await build.verifyPublication(output, declaration)
})

test('manifest screenshots accept AVIF without protected usages configured', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  const output = path.join(projectRoot, 'output')
  const build = createImageBuild({
    projectRoot,
    config: {
      build: { outputFormat: 'avif', preserveFormatFor: [] },
      formats: { avif: { minSize: false, effort: 1 } },
    },
  })
  await build.registerFixedCopies([])
  const image = await publishUse(build, request('body'))
  await fs.mkdir(path.dirname(path.join(output, image.destination)), { recursive: true })
  await fs.writeFile(path.join(output, image.destination), image.bytes)
  await fs.writeFile(
    path.join(output, 'site.webmanifest'),
    JSON.stringify({ screenshots: [{ src: image.url }] }),
  )
  await build.verifyPublication(output, {
    documents: [{ file: 'site.webmanifest', url: '/site.webmanifest' }],
  })
})
