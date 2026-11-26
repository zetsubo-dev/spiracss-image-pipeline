import fs from 'node:fs/promises'
import path from 'node:path'

import type { ImageConfig } from '../config/image-config.ts'
import type { ProcessOutputOptions } from '../output/discover.ts'
import { processOutput } from '../output/process.ts'
import { baselineSources, optimizeSources } from '../source/sources.ts'
import { watchSources } from '../source/watch.ts'
import {
  pruneAdoptedStore,
  refreshAdoptedResult,
  type StoreEnvironment,
} from '../store/maintenance.ts'
import { mergeSourceRecords } from '../store/source-ledger.ts'
import { checkStagedStore } from '../store/staged-check.ts'
import { resolveCommand } from './arguments.ts'

interface CliConfig {
  image?: ImageConfig
  publicRoots?: string[]
  output?: Pick<
    ProcessOutputOptions,
    'base' | 'publicCopies' | 'editableDocuments' | 'inventory' | 'siteOrigin' | 'stateDir'
  >
  adoptedStoreDir?: string
  cacheDir?: string
  environments?: StoreEnvironment[]
}

async function readConfig(projectRoot: string, file: string): Promise<CliConfig> {
  const value: unknown = JSON.parse(await fs.readFile(path.resolve(projectRoot, file), 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Image pipeline configuration must be an object')
  if ('adoptedStoreDir' in value && typeof value.adoptedStoreDir !== 'string')
    throw new TypeError('adoptedStoreDir must be a string')
  if ('cacheDir' in value && typeof value.cacheDir !== 'string')
    throw new TypeError('cacheDir must be a string')
  if ('environments' in value && !Array.isArray(value.environments))
    throw new TypeError('environments must be an array')
  if (
    'publicRoots' in value &&
    (!Array.isArray(value.publicRoots) ||
      value.publicRoots.some((entry: unknown) => typeof entry !== 'string'))
  )
    throw new TypeError('publicRoots must be an array of path strings')
  return value
}

function showHelp(): void {
  console.log(
    [
      'spiracss-image-pipeline source <dir> --config <file> [--baseline | --watch]',
      'spiracss-image-pipeline record merge <file>',
      'spiracss-image-pipeline output <dir> --config <file>',
      'spiracss-image-pipeline store check --staged [--config <file>]',
      'spiracss-image-pipeline store prune --config <file> [--apply]',
      'spiracss-image-pipeline store refresh <key> --config <file> [--env <name>]',
    ].join('\n'),
  )
}

async function runOutput(
  projectRoot: string,
  target: string,
  configFile: string,
): Promise<number | undefined> {
  const config = await readConfig(projectRoot, configFile)
  if (!config.output) throw new TypeError('Specify publicCopies and editableDocuments in output')
  const { publicCopies, editableDocuments, ...output } = config.output
  const result = await processOutput({
    ...output,
    projectRoot,
    outputDir: target,
    publicCopies,
    editableDocuments,
    config: config.image,
    adoptedStoreDir: config.adoptedStoreDir,
    cacheDir: config.cacheDir,
  })
  console.log(JSON.stringify(result, null, 2))
  return result.missing.length ? 2 : undefined
}

async function runCheck(projectRoot: string, configFile: string | undefined): Promise<void> {
  const directory = configFile
    ? (await readConfig(projectRoot, configFile)).adoptedStoreDir
    : (process.env.IMAGE_ADOPTED_STORE_DIR ?? '.image-adopted')
  if (!directory) throw new TypeError('Specify adoptedStoreDir in the configuration')
  console.log(JSON.stringify({ records: await checkStagedStore(projectRoot, directory) }))
}

async function runStore(
  projectRoot: string,
  {
    config: file,
    ...command
  }: Extract<ReturnType<typeof resolveCommand>, { kind: 'prune' | 'refresh' }>,
): Promise<number | undefined> {
  const config = await readConfig(projectRoot, file)
  if (!config.adoptedStoreDir) throw new TypeError('Specify adoptedStoreDir in the configuration')
  const options = {
    projectRoot,
    adoptedStoreDir: config.adoptedStoreDir,
    async loadEnvironments() {
      const current = await readConfig(projectRoot, file)
      if (!current.environments) throw new TypeError('Enumerate the store environments')
      return current.environments
    },
  }
  if (command.kind === 'prune') {
    const result = await pruneAdoptedStore({ ...options, apply: command.apply })
    console.log(JSON.stringify(result, null, 2))
    return result.missing.length ? 2 : undefined
  }
  console.log(
    JSON.stringify(
      await refreshAdoptedResult({
        ...options,
        key: command.key,
        environment: command.environment,
      }),
      null,
      2,
    ),
  )
  return undefined
}

async function runSource(
  projectRoot: string,
  {
    target,
    config: file,
    baseline,
    watch,
  }: Extract<ReturnType<typeof resolveCommand>, { kind: 'source' }>,
): Promise<void> {
  const config = await readConfig(projectRoot, file)
  if (!config.publicRoots) throw new TypeError('Declare publicRoots. Use [] when there are none.')
  const options = {
    projectRoot,
    roots: [target],
    publicRoots: config.publicRoots,
    cacheDir: config.cacheDir,
    config: config.image,
  }
  if (!watch) {
    console.log(
      JSON.stringify(await (baseline ? baselineSources(options) : optimizeSources(options))),
    )
    return
  }
  const observer = watchSources({
    ...options,
    onError: (error) => {
      console.error(error)
      process.exitCode = 1
      void observer.close().catch(console.error)
    },
  })
  const close = () =>
    void observer.close().catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  await observer.ready
}

export async function runCli(): Promise<number | undefined> {
  const projectRoot = process.cwd()
  try {
    const command = resolveCommand(process.argv.slice(2))
    switch (command.kind) {
      case 'help':
        showHelp()
        return undefined
      case 'merge': {
        const added = await mergeSourceRecords({ projectRoot, file: command.file })
        console.log(JSON.stringify({ added }))
        return undefined
      }
      case 'output':
        return await runOutput(projectRoot, command.target, command.config)
      case 'check':
        await runCheck(projectRoot, command.config)
        return undefined
      case 'prune':
      case 'refresh':
        return await runStore(projectRoot, command)
      case 'source':
        await runSource(projectRoot, command)
        return undefined
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    return 1
  }
}
