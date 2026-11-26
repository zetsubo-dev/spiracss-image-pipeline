import fs from 'node:fs/promises'
import path from 'node:path'

import {
  resolveImageConfig,
  standardImageUsages,
  type ImageConfig,
  type ImageUsage,
} from '../config/image-config.ts'
import { createInputReader } from '../processing/input.ts'
import {
  createTrialPlanner,
  describeTrials,
  type ImageUse,
  type StoreTrialInput,
} from '../processing/trial-plan.ts'
import { runTrial } from '../processing/trial.ts'
import { isDigest, type Digest } from '../shared/digest.ts'
import { ImagePipelineError } from '../shared/errors.ts'
import { AdoptedStore } from './adopted-store.ts'

export type StoreInput = Omit<StoreTrialInput, 'usage'> & Partial<Pick<StoreTrialInput, 'usage'>>

export interface StoreEnvironment {
  name: string
  config?: ImageConfig | undefined
  usages?: readonly ImageUsage[] | undefined
  inputs: readonly StoreInput[]
  /** Describe input ranges that could not be enumerated, including external dependencies. */
  missing?: readonly string[]
}

export interface StoreOptions {
  projectRoot: string
  adoptedStoreDir: string
  onWarning?: (message: string) => void
  loadEnvironments(): Promise<readonly StoreEnvironment[]>
}

export interface StoreKeyInventory {
  name: string
  keys: readonly string[]
  missing?: readonly string[]
}

type StoreLocation = Pick<StoreOptions, 'projectRoot' | 'adoptedStoreDir' | 'onWarning'>

function adoptedStore(options: StoreLocation) {
  if (!options.adoptedStoreDir) throw new TypeError('Specify the adopted image store directory')
  return new AdoptedStore(
    path.resolve(options.projectRoot, options.adoptedStoreDir),
    options.onWarning,
  )
}

async function* describeInputs(projectRoot: string, environment: StoreEnvironment) {
  const usages = [...new Set(['body', ...(environment.config?.build?.preserveFormatFor ?? [])])]
  const configuredUsages = environment.usages ?? standardImageUsages
  const config = resolveImageConfig(environment.config, configuredUsages)
  const readInput = createInputReader(path.resolve(projectRoot))
  const planTrials = createTrialPlanner(config)
  const keys = new Set<Digest>()
  for (const input of environment.inputs) {
    for (const usage of input.usage === undefined ? usages : [input.usage]) {
      const use: ImageUse = {
        input: { kind: 'generated', file: input.file, logicalName: input.logicalName },
        logicalPlacement: input.logicalPlacement,
        usage,
        excludeConversion: input.excludeConversion,
      }
      for (const entry of await describeTrials(use, configuredUsages, readInput, planTrials)) {
        if (keys.has(entry.key)) continue
        keys.add(entry.key)
        yield entry
      }
    }
  }
}

export async function collectAdoptedStoreKeys(
  projectRoot: string,
  environment: StoreEnvironment,
): Promise<string[]> {
  const keys: string[] = []
  for await (const entry of describeInputs(projectRoot, environment)) keys.push(entry.key)
  return keys
}

export async function pruneAdoptedStore(
  options: StoreLocation & {
    loadEnvironments(): Promise<readonly (StoreEnvironment | StoreKeyInventory)[]>
    apply?: boolean
  },
): Promise<{
  records: {
    key: Digest
    file: string
    digest: Digest | undefined
    size: number
  }[]
  blobs: {
    size: number
    file: string
    key: Digest
  }[]
  bytes: number
  missing: string[]
}> {
  const store = adoptedStore(options)
  const environments = await options.loadEnvironments()
  const missing = environments.flatMap((environment) => environment.missing ?? [])
  if (!environments.length) missing.push('No environments were enumerated')
  const reachable = new Set<Digest>()
  for (const environment of environments) {
    try {
      const keys =
        'keys' in environment
          ? environment.keys
          : await collectAdoptedStoreKeys(options.projectRoot, environment)
      for (const key of keys) {
        if (!isDigest(key)) throw new TypeError(`Invalid adoption key: ${key}`)
        reachable.add(key)
      }
    } catch (error) {
      missing.push(`${environment.name}: ${String(error)}`)
    }
  }
  if (missing.length) return { records: [], blobs: [], bytes: 0, missing }
  async function inspect() {
    const inventory = await store.inventory()
    const retained = new Set<Digest>()
    const records = inventory.records.filter((entry) => {
      if (!reachable.has(entry.key)) return true
      if (entry.digest) retained.add(entry.digest)
      return false
    })
    const blobs = inventory.blobs.filter((entry) => !retained.has(entry.key))
    if (options.apply) {
      for (const entry of records) await fs.rm(entry.file)
      for (const entry of blobs) await fs.rm(entry.file)
    }
    const bytes = [...records, ...blobs].reduce((total, entry) => total + entry.size, 0)
    return { records, blobs, bytes, missing }
  }
  return options.apply ? store.mutate(inspect) : inspect()
}

export async function refreshAdoptedResult(
  options: StoreOptions & { key: string; environment?: string },
): Promise<{
  environment: string
  key: Digest
  result: 'adopted' | 'same-as-source' | 'skipped-min-size'
}> {
  const { key } = options
  if (!isDigest(key))
    throw new ImagePipelineError(
      'INVALID_STORE_KEY',
      'An image store key must be a complete SHA-256',
    )
  const store = adoptedStore(options)
  const environments = await options.loadEnvironments()
  const environment =
    options.environment === undefined && environments.length === 1
      ? environments[0]
      : environments.find((entry) => entry.name === options.environment)
  if (!environment)
    throw new ImagePipelineError(
      'INVALID_STORE_ENVIRONMENT',
      `Specify a valid store environment: ${environments.map((entry) => entry.name).join(', ')}`,
    )
  if (environment.missing?.length)
    throw new ImagePipelineError(
      'INCOMPLETE_STORE_INPUTS',
      `${environment.name} has incomplete inputs: ${environment.missing.join(', ')}`,
    )
  for await (const { key: candidate, source, trial, conditions } of describeInputs(
    options.projectRoot,
    environment,
  )) {
    if (candidate !== key) continue
    await store.read(key, conditions, source)
    const result = await runTrial(source, trial)
    await store.write(key, conditions, source, result, true)
    return { environment: environment.name, key, result: result.kind }
  }
  throw new ImagePipelineError(
    'STORE_TRIAL_NOT_FOUND',
    `No current trial in ${environment.name} matches ${key}`,
  )
}
