import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { collectAdoptedStoreKeys } from '@spiracss/image-pipeline'
import sharp from 'sharp'

import { resolveCommand } from '../../dist/cli/arguments.js'

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
const exec = promisify(execFile)
const configFile = 'images.json'
const ledger = '.source-image-processed.sha256'
const digest = 'a'.repeat(64)
const flags = {
  config: ['--config', configFile],
  baseline: ['--baseline'],
  watch: ['--watch'],
  apply: ['--apply'],
  env: ['--env', 'staging'],
  staged: ['--staged'],
}
const help = [
  'spiracss-image-pipeline source <dir> --config <file> [--baseline | --watch]',
  'spiracss-image-pipeline record merge <file>',
  'spiracss-image-pipeline output <dir> --config <file>',
  'spiracss-image-pipeline store check --staged [--config <file>]',
  'spiracss-image-pipeline store prune --config <file> [--apply]',
  'spiracss-image-pipeline store refresh <key> --config <file> [--env <name>]',
].join('\n')

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), 'image-pipeline-cli-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  await Promise.all(['assets', 'build-input', 'output'].map((dir) => fs.mkdir(path.join(cwd, dir))))
  execFileSync('git', ['init', '--quiet'], { cwd })

  const file = 'build-input/sample.png'
  const rgb = { r: 12, g: 34, b: 56 }
  await sharp({ create: { width: 16, height: 16, channels: 3, background: rgb } })
    .png()
    .toFile(path.join(cwd, file))
  const environment = {
    name: 'staging',
    config: { build: { outputFormat: 'webp' }, formats: { webp: { minSize: false } } },
    inputs: [{ file, logicalName: file, logicalPlacement: file }],
  }
  const [key] = await collectAdoptedStoreKeys(cwd, environment)
  assert.match(key, /^[a-f0-9]{64}$/u)

  await fs.writeFile(
    path.join(cwd, configFile),
    JSON.stringify({
      publicRoots: [],
      adoptedStoreDir: '.image-adopted',
      environments: [environment],
      output: { publicCopies: [], editableDocuments: [] },
    }),
  )
  await fs.writeFile(path.join(cwd, 'record.txt'), digest + '\n')
  return { cwd, key, file }
}

async function run(cwd, args) {
  const options = {
    cwd,
    timeout: 10_000,
    env: { ...process.env, IMAGE_ADOPTED_STORE_DIR: '.image-adopted' },
  }
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], options)
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    return { code: error.code, stdout: error.stdout.trim(), stderr: error.stderr.trim() }
  }
}

async function watchToShutdown(t, cwd, file, args) {
  const watchRoot = path.join(cwd, 'assets')
  await fs.copyFile(path.join(cwd, file), path.join(watchRoot, 'watch.png'))
  const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = await fs.readFile(path.join(cwd, ledger), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return ''
    })
    if (record.trim()) {
      child.kill('SIGTERM')
      assert.deepEqual(await closed, [0, null], stderr)
      assert.equal(stdout + stderr, '')
      return
    }
    assert.equal(child.exitCode, null, stderr)
    await delay(25)
  }
  assert.fail('Source watch never recorded its initial scan')
}

function* flagCombinations() {
  const names = Object.keys(flags)
  for (let mask = 0; mask < 2 ** names.length; mask++) {
    yield names.filter((_, bit) => mask & (1 << bit))
  }
}

const commands = [
  { args: ['source', 'assets'], accepted: ['config', 'config baseline', 'config watch'] },
  { args: ['record', 'merge', 'record.txt'], accepted: [''] },
  { args: ['output', 'output'], accepted: ['config'] },
  { args: ['store', 'check'], accepted: ['staged', 'config staged'] },
  { args: ['store', 'prune'], accepted: ['config', 'config apply'] },
  { args: ['store', 'refresh'], accepted: ['config', 'config env'] },
]

test(
  'CLI characterizes all 64 non-help flag combinations for each command',
  { concurrency: true },
  async (t) => {
    await Promise.all(
      commands.map(({ args: command, accepted }) =>
        t.test(command.join(' '), async (t) => {
          const { cwd, key, file } = await fixture(t)
          const positionals = command[1] === 'refresh' ? [...command, key] : command
          for (const selection of flagCombinations()) {
            const selected = selection.join(' ')
            const args = [...positionals, ...selection.flatMap((flag) => flags[flag])]
            const context = args.join(' ')
            if (command[0] === 'source' && selected === 'config watch') {
              await watchToShutdown(t, cwd, file, args)
              continue
            }
            const result = await run(cwd, args)
            if (!accepted.includes(selected)) {
              assert.equal(result.code, 1, context)
              assert.equal(result.stdout, '', context)
              const error =
                command[0] === 'source' && ['', 'baseline', 'watch'].includes(selected)
                  ? /^Specify --config with publicRoots\./u
                  : /^Invalid command\. See --help\.$/u
              assert.match(result.stderr, error, context)
              continue
            }

            assert.equal(result.code, 0, context + '\n' + result.stderr)
            assert.equal(result.stderr, '', context)
            const json = JSON.parse(result.stdout)
            switch (command[0] + ' ' + command[1]) {
              case 'source assets':
                assert.deepEqual(json, [], context)
                break
              case 'record merge':
                assert.deepEqual(json, { added: selected === '' ? 1 : 0 }, context)
                assert.equal(await fs.readFile(path.join(cwd, ledger), 'utf8'), digest + '\n')
                break
              case 'output output':
                assert.deepEqual(json, { missing: [], processed: [], retained: [] }, context)
                break
              case 'store check':
                assert.deepEqual(json, { records: 0 }, context)
                break
              case 'store prune':
                assert.deepEqual(json, { records: [], blobs: [], bytes: 0, missing: [] }, context)
                break
              case 'store refresh':
                assert.equal(json.environment, 'staging', context)
                assert.equal(json.key, key, context)
                assert.match(json.result, /^(?:adopted|same-as-source|skipped-min-size)$/u, context)
                break
            }
          }
        }),
      ),
    )
  },
)

test('CLI handles help, invalid switches, and missing or extra positionals', async (t) => {
  const { cwd, key } = await fixture(t)
  for (const args of [['--help'], ['-h'], ['source', '-h'], ['store', 'refresh', '--help']]) {
    assert.deepEqual(await run(cwd, args), { code: 0, stderr: '', stdout: help })
  }
  for (const args of [
    [],
    ['unknown', '--help'],
    ['source', '--baseline', '--watch', '-h'],
    ['source', '--config', configFile],
    ['source', 'assets', 'extra', '--config', configFile],
    ['record', 'merge'],
    ['record', 'merge', 'record.txt', 'extra'],
    ['output', 'output', 'extra', '--config', configFile],
    ['store', 'check', 'extra', '--staged'],
    ['store', 'prune', 'extra', '--config', configFile],
    ['store', 'refresh', '--config', configFile],
    ['store', 'refresh', key, 'extra', '--config', configFile],
  ]) {
    assert.deepEqual(
      await run(cwd, args),
      {
        code: 1,
        stderr: 'Invalid command. See --help.',
        stdout: '',
      },
      args.join(' '),
    )
  }
  assert.match((await run(cwd, ['--unknown'])).stderr, /Unknown option/u)
  assert.match((await run(cwd, ['source', 'assets', '--config'])).stderr, /argument missing/u)
  assert.deepEqual(await run(cwd, ['store', 'refresh', 'invalid', '--config', configFile]), {
    code: 1,
    stderr: 'An image store key must be a complete SHA-256',
    stdout: '',
  })
})

test('CLI rejects invalid arguments with INVALID_COMMAND before reading configuration', () => {
  for (const args of [
    ['record', 'merge', 'absent.txt', '--env='],
    ['record', 'merge', 'absent.txt', '--apply'],
    ['record', 'merge', 'absent.txt', '--staged'],
    ['store', 'check', '--staged', '--staged'],
    ['store', 'unknown', '--config', 'absent.json'],
    ['source', 'assets', '--unknown'],
    ['source', 'assets', '--config'],
    ['source', 'assets', '--config='],
  ]) {
    assert.throws(() => resolveCommand(args), {
      name: 'ImagePipelineError',
      code: 'INVALID_COMMAND',
    })
  }
})

test('CLI reports incomplete output and store plans with exit status 2', async (t) => {
  const { cwd } = await fixture(t)
  await fs.writeFile(
    path.join(cwd, configFile),
    JSON.stringify({
      adoptedStoreDir: '.image-adopted',
      environments: [],
      output: {},
    }),
  )

  const output = await run(cwd, ['output', 'output', '--config', configFile])
  assert.equal(output.code, 2)
  assert.equal(output.stderr, '')
  assert.deepEqual(JSON.parse(output.stdout), {
    missing: ['publicCopies', 'editableDocuments'],
    processed: [],
    retained: [],
  })

  const prune = await run(cwd, ['store', 'prune', '--config', configFile, '--apply'])
  assert.equal(prune.code, 2)
  assert.equal(prune.stderr, '')
  assert.deepEqual(JSON.parse(prune.stdout), {
    records: [],
    blobs: [],
    bytes: 0,
    missing: ['No environments were enumerated'],
  })
})
