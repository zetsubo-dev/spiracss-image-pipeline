import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { createImageBuild } from '@spiracss/image-pipeline/adapter/v1'

import { temporaryProject, file, makePng, request, declaredBuild } from '../support/project.mjs'

test('store pruning considers all current environments and refresh changes only the selected key', async (t) => {
  const { collectAdoptedStoreKeys, pruneAdoptedStore, refreshAdoptedResult } =
    await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  const source = path.join(projectRoot, file)
  await makePng(source)
  const adoptedStoreDir = '.image-adopted'
  const config = {
    build: { outputFormat: 'avif' },
    formats: { avif: { effort: 1, minSize: false } },
  }
  const webp = { build: { outputFormat: 'webp' }, formats: { webp: { effort: 1, minSize: false } } }
  const settings = { projectRoot, adoptedStoreDir }
  const avifAsset = await (await declaredBuild({ ...settings, config })).resolveUse(request())
  const webpAsset = await (await declaredBuild({ ...settings, config: webp })).resolveUse(request())
  const inputs = [{ file, logicalName: file, logicalPlacement: request().logicalPlacement }]
  let environments = [
    { name: 'staging', config: webp, inputs },
    { name: 'production', config, inputs },
  ]
  const options = { ...settings, loadEnvironments: async () => environments }
  assert.deepEqual((await pruneAdoptedStore(options)).records, [])
  const snapshots = await Promise.all(
    environments.map(async (environment) => ({
      name: environment.name,
      keys: await collectAdoptedStoreKeys(projectRoot, environment),
    })),
  )
  assert.deepEqual(
    (await pruneAdoptedStore({ ...options, loadEnvironments: async () => snapshots })).records,
    [],
  )
  const missingCoverage = await pruneAdoptedStore({
    ...options,
    apply: true,
    loadEnvironments: async () => [{ name: 'production', keys: ['unverified'] }],
  })
  assert.match(missingCoverage.missing[0], /Invalid adoption key/u)
  assert.deepEqual(missingCoverage.records, [])
  await assert.rejects(refreshAdoptedResult({ ...options, key: avifAsset.trialKeys[0] }), {
    code: 'INVALID_STORE_ENVIRONMENT',
    message: /Specify a valid store environment/u,
  })
  const before = await fs.readFile(
    path.join(
      projectRoot,
      adoptedStoreDir,
      'records',
      webpAsset.trialKeys[0].slice(0, 2),
      webpAsset.trialKeys[0] + '.json',
    ),
  )
  assert.equal(
    (
      await refreshAdoptedResult({
        ...options,
        key: avifAsset.trialKeys[0],
        environment: 'production',
      })
    ).result,
    'adopted',
  )
  environments = [{ ...environments[0], missing: ['dependency images'] }]
  assert.deepEqual((await pruneAdoptedStore({ ...options, apply: true })).missing, [
    'dependency images',
  ])
  environments = [{ ...environments[0], missing: [] }]
  assert.deepEqual(
    (await pruneAdoptedStore(options)).records.map((record) => record.key),
    avifAsset.trialKeys,
  )
  await pruneAdoptedStore({ ...options, apply: true })
  assert.deepEqual((await pruneAdoptedStore(options)).records, [])
  assert.deepEqual(
    await fs.readFile(
      path.join(
        projectRoot,
        adoptedStoreDir,
        'records',
        webpAsset.trialKeys[0].slice(0, 2),
        webpAsset.trialKeys[0] + '.json',
      ),
    ),
    before,
  )
})

test('a refresh with no matching trial fails with a structured code', async (t) => {
  const { ImagePipelineError, refreshAdoptedResult } = await import('@spiracss/image-pipeline')
  const projectRoot = await temporaryProject(t)
  await assert.rejects(
    refreshAdoptedResult({
      projectRoot,
      adoptedStoreDir: '.image-adopted',
      key: 'a'.repeat(64),
      async loadEnvironments() {
        return [{ name: 'production', inputs: [] }]
      },
    }),
    (error) =>
      typeof ImagePipelineError === 'function' &&
      error instanceof ImagePipelineError &&
      error.code === 'STORE_TRIAL_NOT_FOUND',
  )
})

test('store discovery observes both selected and fallback trials for an actual image use', async (t) => {
  const projectRoot = await temporaryProject(t)
  await makePng(path.join(projectRoot, file))
  const captured = []
  const build = createImageBuild({
    projectRoot,
    adoptedStoreDir: '.image-adopted',
    config: { build: { outputFormat: 'avif' }, formats: { avif: { effort: 0, minSize: true } } },
    async onStoreTrials(input, keys) {
      captured.push({ input, keys })
    },
  })
  const use = request()
  await build.prepareUse(use)
  const planned = await build.describeTrials(use)
  assert.deepEqual(
    planned.map(({ trial }) => trial.format),
    ['avif', 'png'],
  )
  assert.deepEqual(captured, [
    {
      input: {
        file: path.join(projectRoot, file),
        logicalName: use.input.logicalName,
        logicalPlacement: use.logicalPlacement,
        usage: use.usage,
        excludeConversion: undefined,
      },
      keys: planned.map(({ key }) => key),
    },
  ])
})

test('the staged check catches an unstaged blob and a fresh Git checkout reuses it', async (t) => {
  const projectRoot = await temporaryProject(t)
  const runGit = (...args) => execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe' })
  runGit('init', '--quiet')
  await fs.writeFile(
    path.join(projectRoot, '.gitattributes'),
    '.image-adopted/blobs/** binary\n.image-adopted/records/**/*.json text eol=lf -merge\n',
  )
  await makePng(path.join(projectRoot, file))
  const config = {
    build: { outputFormat: 'avif' },
    formats: { avif: { effort: 1, minSize: false } },
  }
  const options = { projectRoot, config, adoptedStoreDir: '.image-adopted' }
  const image = await (await declaredBuild(options)).resolveUse(request())
  await fs.writeFile(
    path.join(projectRoot, 'images.json'),
    JSON.stringify({ adoptedStoreDir: '.image-adopted' }),
  )
  runGit('add', '.gitattributes', file, '.image-adopted/records')
  const cli = new URL('../../dist/cli.js', import.meta.url).pathname
  const check = () =>
    spawnSync(process.execPath, [cli, 'store', 'check', '--staged', '--config', 'images.json'], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
  assert.match(check().stderr, /Missing staged image blob/u)
  runGit('add', '.image-adopted/blobs')
  assert.equal(check().status, 0)
  runGit('diff', '--cached', '--check')
  runGit(
    '-c',
    'user.name=Image Tests',
    '-c',
    'user.email=tests@example.test',
    'commit',
    '--quiet',
    '-m',
    'Add image trial',
  )
  const checkout = path.join(await temporaryProject(t), 'checkout')
  runGit('clone', '--quiet', '--config', 'core.autocrlf=true', projectRoot, checkout)
  const build = createImageBuild({ ...options, projectRoot: checkout })
  await build.registerFixedCopies([])
  assert.deepEqual(await build.resolveUse(request()), image)
  assert.equal(build.getStatistics().encodes, 0)
  assert.equal(build.getStatistics().sharedHits, 1)
})
