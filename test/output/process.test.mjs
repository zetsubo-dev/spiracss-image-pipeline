import assert from 'node:assert/strict'
import { execFile, spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import sharp from 'sharp'

import { temporaryProject, makePng, file } from '../support/project.mjs'

test('output processing updates only declared HTML and CSS references and leaves unknown references intact', async (t) => {
  const { processOutput } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  const output = path.join(projectRoot, 'output')
  await fs.mkdir(output)
  const original = await makePng(path.join(output, file))
  const html =
    '\uFEFF<!doctype html>\r\n<link rel="icon" type="image/png" href="/alpha/example.png?rev=1#i">\r\n<img src="example.png">\r\n<script src="main.js"></script>\r\n'
  await fs.writeFile(path.join(output, 'index.html'), html)
  await fs.writeFile(
    path.join(output, 'styles.css'),
    '.example { background: url(./example.png?css=1); }\n',
  )
  await fs.writeFile(path.join(output, 'main.js'), 'const original = "example.png";\n')
  const config = {
    build: { outputFormat: 'avif', preserveFormatFor: ['favicon'] },
    formats: { avif: { effort: 1, minSize: false } },
  }
  const options = {
    projectRoot,
    outputDir: 'output',
    publicCopies: [],
    editableDocuments: ['index.html', 'styles.css'],
    base: '/alpha/',
    config,
  }
  const result = await processOutput(options)
  assert.deepEqual(result.processed, ['example.avif', 'index.html', 'styles.css'])
  assert.equal(
    await fs.readFile(path.join(output, 'index.html'), 'utf8'),
    html.replace('<img src="example.png">', '<img src="example.avif">'),
  )
  assert.match(await fs.readFile(path.join(output, 'styles.css'), 'utf8'), /example\.avif\?css=1/u)
  assert.deepEqual(await fs.readFile(path.join(output, file)), original)
  assert.deepEqual((await processOutput(options)).processed, [])
  assert.equal(
    await fs.readFile(path.join(output, 'main.js'), 'utf8'),
    'const original = "example.png";\n',
  )
})

test('parallel output calls retain both original images for the next conversion', async (t) => {
  const { processOutput } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  const originals = ['a', 'b']
  const config = (format) => ({
    build: { outputFormat: format },
    formats: { [format]: { effort: 1, minSize: false } },
  })
  const options = (outputDir, format, images) => ({
    projectRoot,
    outputDir,
    publicCopies: [],
    editableDocuments: images.map((name) => name + '.html'),
    config: config(format),
  })
  for (const directory of ['api', 'cli', 'control']) {
    const output = path.join(projectRoot, directory)
    await fs.mkdir(output)
    for (const [index, name] of originals.entries()) {
      await makePng(path.join(output, name + '.png'), index)
      await fs.writeFile(path.join(output, name + '.html'), `<img src="${name}.png">`)
    }
  }
  await Promise.all(originals.map((name) => processOutput(options('api', 'webp', [name]))))
  for (const name of originals) {
    await fs.writeFile(
      path.join(projectRoot, name + '.json'),
      JSON.stringify({
        output: { publicCopies: [], editableDocuments: [name + '.html'] },
        image: config('webp'),
      }),
    )
  }
  await Promise.all(
    originals.map((name) =>
      promisify(execFile)(
        process.execPath,
        [path.resolve('dist/cli.js'), 'output', 'cli', '--config', name + '.json'],
        { cwd: projectRoot },
      ),
    ),
  )
  await Promise.all(
    ['api', 'cli', 'control'].map((directory) =>
      processOutput(options(directory, 'avif', originals)),
    ),
  )
  for (const directory of ['api', 'cli']) {
    const state = createHash('sha256').update(path.join(projectRoot, directory)).digest('hex')
    const records = JSON.parse(
      await fs.readFile(
        path.join(projectRoot, '.cache/image-pipeline-output', state, 'records.json'),
        'utf8',
      ),
    )
    for (const name of originals) {
      assert.equal(records[name + '.webp'].owner, name + '.png')
      assert.deepEqual(
        await fs.readFile(path.join(projectRoot, directory, name + '.avif')),
        await fs.readFile(path.join(projectRoot, 'control', name + '.avif')),
      )
    }
  }
  const lock = path.join(projectRoot, 'api', '.image-pipeline-output.lock')
  const script = `import { acquireFileLock } from ${JSON.stringify(new URL('../../dist/shared/file-lock.js', import.meta.url).href)};
    await acquireFileLock(process.argv[1]); console.log('ready'); setInterval(() => {}, 5000);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, lock])
  const exited = once(child, 'exit')
  t.after(() => child.kill('SIGKILL'))
  await once(child.stdout, 'data')
  await processOutput(options('cli', 'avif', originals))
  assert.equal(child.exitCode, null)
  assert.equal(child.kill('SIGKILL'), true)
  await exited
  assert.deepEqual((await processOutput(options('api', 'avif', originals))).processed, [])
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' })
})

test('output processing refuses missing declarations and colliding public placements', async (t) => {
  const { processOutput } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  const output = path.join(projectRoot, 'output')
  await fs.mkdir(output)
  await makePng(path.join(output, file))
  const html = '<img src="example.png">'
  await fs.writeFile(path.join(output, 'index.html'), html)
  const options = {
    projectRoot,
    outputDir: 'output',
    editableDocuments: ['index.html'],
    config: { build: { outputFormat: 'avif' }, formats: { avif: { effort: 1, minSize: false } } },
  }
  assert.deepEqual((await processOutput(options)).missing, ['publicCopies'])
  const copied = Buffer.from('existing fixed bytes')
  await fs.writeFile(path.join(projectRoot, 'fixed.avif'), copied)
  await fs.writeFile(path.join(output, 'example.avif'), copied)
  await assert.rejects(
    processOutput({
      ...options,
      publicCopies: [{ source: 'fixed.avif', destination: 'example.avif' }],
    }),
    /Image publication collision.*Rename the fixed public asset/u,
  )
  assert.equal(await fs.readFile(path.join(output, 'index.html'), 'utf8'), html)
  assert.deepEqual(await fs.readFile(path.join(output, 'example.avif')), copied)
  await assert.rejects(fs.stat(path.join(projectRoot, '.cache/image-pipeline-output')), {
    code: 'ENOENT',
  })
})

test('output planning reports fixed-file aliases before updating output or original-image state', async (t) => {
  const { processOutput } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  for (const [name, fixed, directory] of [
    ['share', 'Share.avif', 'case'],
    ['café', 'cafe\u0301.avif', 'unicode'],
  ]) {
    const output = path.join(projectRoot, directory)
    await fs.mkdir(output)
    await fs.mkdir(path.join(projectRoot, 'static'), { recursive: true })
    const original = await makePng(path.join(output, name + '.png'))
    await fs.writeFile(path.join(projectRoot, 'static', fixed), 'fixed')
    await fs.writeFile(path.join(output, fixed), 'fixed')
    const html = `<img src="${name}.png">`
    await fs.writeFile(path.join(output, 'index.html'), html)
    await assert.rejects(
      processOutput({
        projectRoot,
        outputDir: directory,
        stateDir: 'original-state',
        caseInsensitiveOutputs: true,
        publicCopies: [{ source: 'static/' + fixed, destination: fixed }],
        editableDocuments: ['index.html'],
        config: {
          build: { outputFormat: 'avif' },
          formats: { avif: { effort: 1, minSize: false } },
        },
      }),
      (error) => {
        for (const evidence of [
          name + '.avif',
          name + '.png',
          'static/' + fixed,
          'Rename the fixed public asset',
        ])
          assert.ok(
            error.message.normalize('NFC').includes(evidence.normalize('NFC')),
            error.message,
          )
        return true
      },
    )
    assert.equal(await fs.readFile(path.join(output, 'index.html'), 'utf8'), html)
    assert.equal(await fs.readFile(path.join(output, fixed), 'utf8'), 'fixed')
    assert.deepEqual(await fs.readFile(path.join(output, name + '.png')), original)
    await assert.rejects(fs.stat(path.join(projectRoot, 'original-state')), { code: 'ENOENT' })
  }
})

test('replacing a same-path image is stable across repeated output runs', async (t) => {
  const { processOutput } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  const output = path.join(projectRoot, 'output')
  await fs.mkdir(output)
  const original = await makePng(path.join(output, file))
  await fs.writeFile(path.join(output, 'index.html'), '<img src="example.png">')
  const options = {
    projectRoot,
    outputDir: 'output',
    publicCopies: [],
    editableDocuments: ['index.html'],
    inventory: { completeReferences: true, generatedImages: [{ output: file, logicalName: file }] },
  }
  assert.deepEqual((await processOutput(options)).processed, [file])
  const compressed = await fs.readFile(path.join(output, file))
  assert.ok(compressed.length < original.length)
  assert.deepEqual((await processOutput(options)).processed, [])
  assert.deepEqual(await fs.readFile(path.join(output, file)), compressed)
})

test('output keeps integrity-protected CSS when HTML declares a base URL', async (t) => {
  const { processOutput } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  const css = '.hero{background:url(photo.png)}'
  const integrity = ` integrity="sha256-${createHash('sha256').update(css).digest('base64')}"`
  for (const [outputDir, baseHref, declaration] of [
    ['protected', '/assets/', integrity],
    ['ordinary', '/assets/', ''],
    ['unresolved', 'https://cdn.example/assets/', integrity],
  ]) {
    const output = path.join(projectRoot, outputDir)
    const assets = path.join(output, 'assets')
    await fs.mkdir(assets, { recursive: true })
    await makePng(path.join(assets, 'photo.png'))
    const stylesheet = path.join(assets, 'style.css')
    await fs.writeFile(stylesheet, css)
    await fs.writeFile(
      path.join(output, 'index.html'),
      `<base href="${baseHref}"><link rel="stylesheet" href="style.css"${declaration}>`,
    )
    const result = await processOutput({
      projectRoot,
      outputDir,
      publicCopies: [],
      editableDocuments: ['assets/style.css'],
      config: { build: { outputFormat: 'webp' }, formats: { webp: { minSize: false } } },
    })
    const actual = await fs.readFile(stylesheet, 'utf8')
    if (declaration) {
      assert.equal(actual, css, outputDir)
      assert.ok(
        result.retained.some(
          ({ file, reason }) =>
            file === 'assets/style.css' && reason.includes('integrity declaration'),
        ),
      )
    } else {
      assert.match(actual, /photo\.webp/u)
    }
  }
})

test('output keeps an existing derived image when references are incomplete', async (t) => {
  const { processOutput } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  const outputDir = 'output'
  const output = path.join(projectRoot, outputDir)
  await fs.mkdir(output)
  await makePng(path.join(output, 'photo.png'))
  const document = path.join(output, 'index.html')
  await fs.writeFile(document, '<img src="photo.png">')
  const run = (quality) =>
    processOutput({
      projectRoot,
      outputDir,
      publicCopies: [],
      editableDocuments: ['index.html'],
      inventory: {
        completeReferences: true,
        generatedImages: [{ output: 'photo.png', logicalName: 'photo.png' }],
      },
      config: { build: { outputFormat: 'webp' }, formats: { webp: { quality, minSize: false } } },
    })
  await run(25)
  const derivative = path.join(output, 'photo.webp')
  const initial = await fs.readFile(derivative)
  const html = await fs.readFile(document, 'utf8')
  assert.match(html, /photo\.webp/u)
  const script = path.join(output, 'dynamic.js')
  await fs.writeFile(script, 'new Image().src = ["photo", "webp"].join(".");')
  const protectedResult = await run(90)
  assert.deepEqual(await fs.readFile(derivative), initial)
  assert.equal(await fs.readFile(document, 'utf8'), html)
  assert.ok(
    protectedResult.retained.some(
      ({ file, reason }) => file === 'photo.webp' && reason.includes('references are incomplete'),
    ),
  )
  await fs.unlink(script)
  const updated = await run(90)
  assert.ok(updated.processed.includes('photo.webp'))
  assert.notDeepEqual(await fs.readFile(derivative), initial)
  assert.equal(await fs.readFile(document, 'utf8'), html)
})

test('fixed HTML preserves the images it references without protecting unrelated images', async (t) => {
  const { processOutput } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  const output = path.join(projectRoot, 'output')
  await fs.mkdir(output)
  const protectedImage = await makePng(path.join(output, 'protected.png'))
  const unrelated = await makePng(path.join(output, 'unrelated.png'))
  const fixed = '<!doctype html><img src="protected.png">'
  await fs.writeFile(path.join(projectRoot, 'fixed.html'), fixed)
  await fs.writeFile(path.join(output, 'fixed.html'), fixed)
  await fs.writeFile(
    path.join(output, 'index.html'),
    '<img src="protected.png"><img src="unrelated.png">',
  )
  const result = await processOutput({
    projectRoot,
    outputDir: 'output',
    publicCopies: [{ source: 'fixed.html', destination: 'fixed.html' }],
    editableDocuments: ['index.html'],
    inventory: {
      completeReferences: true,
      generatedImages: ['protected.png', 'unrelated.png'].map((name) => ({
        output: name,
        logicalName: name,
      })),
    },
  })
  assert.deepEqual(result.processed, ['unrelated.png'])
  assert.ok(
    result.retained.some(
      ({ file, reason }) => file === 'protected.png' && reason.includes('fixed.html'),
    ),
  )
  assert.equal(await fs.readFile(path.join(output, 'fixed.html'), 'utf8'), fixed)
  assert.deepEqual(await fs.readFile(path.join(output, 'protected.png')), protectedImage)
  assert.ok((await fs.readFile(path.join(output, 'unrelated.png'))).length < unrelated.length)
})

test('output rewrites manifest icons and JSON-LD while preserving screenshots and formatting on retry', async (t) => {
  const { processOutput } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  const output = path.join(projectRoot, 'output')
  await fs.mkdir(path.join(output, 'app'), { recursive: true })
  const original = await makePng(path.join(output, 'app', file))
  const html =
    '<link rel="manifest" href="app/site.json">\r\n<script type="application/ld+json">{"image":"app/example.png?ld#x"}</script>\r\n'
  const manifest =
    '\uFEFF{\r\n  "icons": [{"src":"example.png?v=1#icon", "type":"image/png"}],\r\n  "icons_localized": {"ja": [{"src":"example.png"}]},\r\n  "shortcuts": [{"url":"example.png", "icons": [{"src":"example.png", "type":"image/png"}], "icons_localized":{"en":[{"src":"example.png"}]} }],\r\n  "screenshots": [{"src":"example.png"}]\r\n}\r\n'
  await fs.writeFile(path.join(output, 'index.html'), html)
  await fs.writeFile(path.join(output, 'app/site.json'), manifest)
  const options = {
    projectRoot,
    outputDir: 'output',
    publicCopies: [],
    editableDocuments: ['index.html', 'app/site.json'],
    inventory: {
      completeReferences: true,
      generatedImages: [{ output: 'app/example.png', logicalName: 'app/example.png' }],
    },
    config: { build: { outputFormat: 'avif' }, formats: { avif: { effort: 1, minSize: false } } },
  }
  await processOutput(options)
  const result = await fs.readFile(path.join(output, 'app/site.json'), 'utf8')
  assert.equal(
    result,
    manifest
      .replace('example.png?v=1#icon', 'example.avif?v=1#icon')
      .replaceAll('"type":"image/png"', '"type":"image/avif"')
      .replace('"ja": [{"src":"example.png"}]', '"ja": [{"src":"example.avif"}]')
      .replace('"icons": [{"src":"example.png"', '"icons": [{"src":"example.avif"')
      .replace('"en":[{"src":"example.png"}]', '"en":[{"src":"example.avif"}]'),
  )
  assert.equal(
    await fs.readFile(path.join(output, 'index.html'), 'utf8'),
    html.replace('app/example.png?ld#x', 'app/example.avif?ld#x'),
  )
  assert.deepEqual(await fs.readFile(path.join(output, 'app/example.png')), original)
  assert.deepEqual((await processOutput(options)).processed, [])
})

test('output CLI processes a linked manifest and leaves malformed JSON-LD untouched', async (t) => {
  const projectRoot = await temporaryProject(t)
  const output = path.join(projectRoot, 'output')
  await fs.mkdir(output)
  const original = await makePng(path.join(output, file))
  const html =
    '<link rel="manifest" href="site.webmanifest"><script type="application/ld+json">{"image":</script>'
  await fs.writeFile(path.join(output, 'index.html'), html)
  await fs.writeFile(
    path.join(output, 'site.webmanifest'),
    '{"icons":[{"src":"example.png","type":"image/png"}]}',
  )
  await fs.writeFile(
    path.join(projectRoot, 'config.json'),
    JSON.stringify({
      image: { build: { outputFormat: 'avif' }, formats: { avif: { effort: 1, minSize: false } } },
      output: {
        publicCopies: [],
        editableDocuments: ['index.html', 'site.webmanifest'],
        inventory: {
          completeReferences: true,
          generatedImages: [{ output: file, logicalName: file }],
        },
      },
    }),
  )
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [path.resolve('dist/cli.js'), 'output', 'output', '--config', 'config.json'],
      { cwd: projectRoot, encoding: 'utf8' },
    ),
  )
  assert.ok(result.processed.includes('site.webmanifest'))
  assert.match(await fs.readFile(path.join(output, 'site.webmanifest'), 'utf8'), /example\.avif/u)
  assert.equal(await fs.readFile(path.join(output, 'index.html'), 'utf8'), html)
  assert.deepEqual(await fs.readFile(path.join(output, file)), original)
})

test('picture srcset updates candidate spans and type through the CLI', async (t) => {
  const projectRoot = await temporaryProject(t)
  const output = path.join(projectRoot, 'output')
  await fs.mkdir(output)
  await makePng(path.join(output, 'small.png'))
  await makePng(path.join(output, 'large.png'))
  const html =
    "\uFEFF<!doctype html>\r\n<picture><source  type = 'image/png' media='(min-width: 1px)' srcset = 'small.png?v=1#x 1x,  large.png 2x'><img src=small.png></picture>\r\n"
  await fs.writeFile(path.join(output, 'index.html'), html)
  await fs.writeFile(
    path.join(projectRoot, 'config.json'),
    JSON.stringify({
      image: { build: { outputFormat: 'avif' }, formats: { avif: { effort: 1, minSize: false } } },
      output: {
        publicCopies: [],
        editableDocuments: ['index.html'],
        inventory: {
          completeReferences: true,
          generatedImages: ['small.png', 'large.png'].map((name) => ({
            output: name,
            logicalName: name,
          })),
        },
      },
    }),
  )
  const run = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.resolve('dist/cli.js'), 'output', 'output', '--config', 'config.json'],
        { cwd: projectRoot, encoding: 'utf8' },
      ),
    )
  run()
  assert.equal(
    await fs.readFile(path.join(output, 'index.html'), 'utf8'),
    html
      .replace("type = 'image/png'", "type = 'image/avif'")
      .replace('small.png?v=1#x', 'small.avif?v=1#x')
      .replace('large.png 2x', 'large.avif 2x')
      .replace('src=small.png', 'src="small.avif"'),
  )
  assert.equal((await sharp(path.join(output, 'large.avif')).metadata()).format, 'heif')
  assert.deepEqual(run().processed, [])
})

test('mixed selected formats leave the entire source set and originals intact', async (t) => {
  const { processOutput } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  const output = path.join(projectRoot, 'output')
  await fs.mkdir(output)
  const small = await makePng(path.join(output, 'small.png'))
  const large = await makePng(path.join(output, 'large.png'))
  const html = '<picture><source type="image/png" srcset="small.png 1x, large.png 2x"></picture>'
  await fs.writeFile(path.join(output, 'index.html'), html)
  await processOutput({
    projectRoot,
    outputDir: 'output',
    publicCopies: [],
    editableDocuments: ['index.html'],
    inventory: {
      completeReferences: true,
      generatedImages: ['small.png', 'large.png'].map((name) => ({
        output: name,
        logicalName: name,
      })),
    },
    config: {
      build: { outputFormat: 'avif', ignoreDistConversion: ['large.png'] },
      formats: { avif: { effort: 1, minSize: false } },
    },
  })
  assert.equal(await fs.readFile(path.join(output, 'index.html'), 'utf8'), html)
  assert.deepEqual(await fs.readFile(path.join(output, 'small.png')), small)
  assert.deepEqual(await fs.readFile(path.join(output, 'large.png')), large)
  await assert.rejects(fs.stat(path.join(output, 'small.avif')), { code: 'ENOENT' })
})

test('picture leaves unresolved sets and fixed HTML references protected', async (t) => {
  const { processOutput } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  const output = path.join(projectRoot, 'output')
  await fs.mkdir(output)
  const original = await makePng(path.join(output, 'small.png'))
  const fixed = '<picture><source srcset="small.png 1x"><img src="small.png"></picture>'
  const html =
    '<picture><source type="image/png" srcset="small.png 1x, missing.png 2x"><img src="small.png"></picture>'
  await fs.writeFile(path.join(projectRoot, 'fixed.html'), fixed)
  await fs.writeFile(path.join(output, 'fixed.html'), fixed)
  await fs.writeFile(path.join(output, 'index.html'), html)
  await processOutput({
    projectRoot,
    outputDir: 'output',
    publicCopies: [{ source: 'fixed.html', destination: 'fixed.html' }],
    editableDocuments: ['index.html'],
    inventory: {
      completeReferences: true,
      generatedImages: ['small.png', 'missing.png'].map((name) => ({
        output: name,
        logicalName: name,
      })),
    },
    config: { build: { outputFormat: 'avif' }, formats: { avif: { effort: 1, minSize: false } } },
  })
  assert.equal(await fs.readFile(path.join(output, 'fixed.html'), 'utf8'), fixed)
  assert.equal(
    await fs.readFile(path.join(output, 'index.html'), 'utf8'),
    html.replace('src="small.png"', 'src="small.avif"'),
  )
  assert.deepEqual(await fs.readFile(path.join(output, 'small.png')), original)
})
