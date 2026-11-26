import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { optimizeSources, baselineSources } from '@spiracss/image-pipeline'
import sharp from 'sharp'

import { acquireFileLock } from '../../dist/shared/file-lock.js'
import { temporaryProject, makePng, file } from '../support/project.mjs'

test('aborting optimization while waiting on a source lock leaves image and ledger intact', async (t) => {
  const projectRoot = await temporaryProject(t)
  const source = path.join(projectRoot, file)
  const ledger = path.join(projectRoot, '.source-image-processed.sha256')
  const original = await makePng(source)
  const ledgerText = 'a'.repeat(64) + '\n'
  await fs.writeFile(ledger, ledgerText)
  const lock = source + '.image-pipeline.lock'
  const release = await acquireFileLock(lock)
  t.after(release)

  const waiting = Promise.withResolvers()
  const mkdir = fs.mkdir
  t.mock.method(fs, 'mkdir', async (entry, ...args) => {
    try {
      return await mkdir(entry, ...args)
    } catch (error) {
      if (entry === lock + '.gate' && error.code === 'EEXIST') waiting.resolve()
      throw error
    }
  })
  const controller = new AbortController()
  const optimization = optimizeSources({
    projectRoot,
    roots: [file],
    publicRoots: [],
    signal: controller.signal,
  })
  await Promise.race([waiting.promise, optimization])
  controller.abort()
  await assert.rejects(optimization, { name: 'AbortError' })
  assert.deepEqual(await fs.readFile(source), original)
  assert.equal(await fs.readFile(ledger, 'utf8'), ledgerText)
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).pid, process.pid)
})

test('a source-format filter keeps pre-encoded images out of the automatic scan', async (t) => {
  const projectRoot = await temporaryProject(t)
  const original = await makePng(path.join(projectRoot, file))
  const webp = await sharp(original).webp({ quality: 100 }).toBuffer()
  const avif = await sharp(original).avif({ quality: 100 }).toBuffer()
  const modern = [
    [path.join(projectRoot, 'pre-encoded.webp'), webp],
    [path.join(projectRoot, 'pre-encoded.avif'), avif],
  ]
  for (const [name, bytes] of modern) await fs.writeFile(name, bytes)
  const results = await optimizeSources({
    projectRoot,
    roots: ['.'],
    publicRoots: [],
    sourceFormats: ['png', 'jpeg', 'gif', 'svg'],
  })
  assert.deepEqual(
    results.map(({ file: name }) => path.basename(name)),
    [file],
  )
  for (const [name, bytes] of modern) assert.deepEqual(await fs.readFile(name), bytes)
})

test('the source ledger protects existing bytes across checkouts and refuses invalid records', async (t) => {
  const projectRoot = await temporaryProject(t)
  const bytes = await makePng(path.join(projectRoot, file))
  const publicRoot = path.join(projectRoot, 'public')
  await fs.mkdir(publicRoot)
  await fs.writeFile(path.join(publicRoot, file), bytes)
  const options = { projectRoot, roots: ['.'], publicRoots: ['public'] }
  assert.equal((await baselineSources(options)).length, 1)
  const ledger = '.source-image-processed.sha256'
  const baseline = await fs.readFile(path.join(projectRoot, ledger))
  assert.match(baseline.toString(), /^[a-f0-9]{64}\n$/u)
  assert.equal((await optimizeSources(options))[0].status, 'protected')
  assert.deepEqual(await fs.readFile(path.join(projectRoot, file)), bytes)
  assert.deepEqual(await fs.readFile(path.join(publicRoot, file)), bytes)
  await fs.writeFile(path.join(projectRoot, ledger), 'bad\n')
  await assert.rejects(optimizeSources(options), /Invalid image processing record/u)
  assert.deepEqual(await fs.readFile(path.join(projectRoot, file)), bytes)
})

test('public aliases escaping their declared root fail before baseline writes', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  const publicDirectory = path.join(projectRoot, 'public')
  await fs.mkdir(publicDirectory)
  await fs.symlink(path.join(projectRoot, file), path.join(publicDirectory, file))
  await assert.rejects(
    baselineSources({
      projectRoot,
      roots: ['.'],
      publicRoots: ['public'],
    }),
    /Public link leaves its declared root/u,
  )
  await assert.rejects(fs.stat(path.join(projectRoot, '.source-image-processed.sha256')), {
    code: 'ENOENT',
  })
})

test('absolute source paths work through the declared project directory alias', async (t) => {
  const projectRoot = await temporaryProject(t)
  const aliasParent = await temporaryProject(t)
  const alias = path.join(aliasParent, 'project')
  await fs.symlink(projectRoot, alias, 'dir')
  const actual = path.join(projectRoot, file)
  const before = await makePng(actual)
  const options = { projectRoot: alias, roots: [path.join(alias, file)], publicRoots: [] }
  const results = await optimizeSources(options)
  assert.equal(results[0].status, 'optimized')
  assert.notDeepEqual(await fs.readFile(actual), before)

  const outside = path.join(aliasParent, file)
  await makePng(outside)
  await assert.rejects(
    optimizeSources({ ...options, roots: [outside] }),
    /leaves the project root/u,
  )
})
