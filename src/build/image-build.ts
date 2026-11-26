import path from 'node:path'

import { resolveImageConfig, standardImageUsages } from '../config/image-config.ts'
import { createInputReader } from '../processing/input.ts'
import { createTrialPlanner, describeTrials, type ImageUse } from '../processing/trial-plan.ts'
import type { ImageInputBytes, ProcessingTrial } from '../processing/trial.ts'
import {
  createPlacementRegistry,
  type FixedCopy,
  type Publication,
  type ResolvedImage,
} from '../publication/placement-registry.ts'
import { createPublicationLedger } from '../publication/publication-ledger.ts'
import { verifyOutputFiles, type VerifyPublicationOptions } from '../publication/verify.ts'
import type { Digest } from '../shared/digest.ts'
import { isolateWarning } from '../shared/warning.ts'
import type { ImageBuildOptions } from './options.ts'
import { createStorageGuard } from './storage-guard.ts'
import { createTrialEngine, type PreparedImage } from './trial-engine.ts'

export interface ImageBuild {
  resolveUse: (use: ImageUse) => Promise<ResolvedImage>
  prepareUse: (use: ImageUse) => Promise<PreparedImage>
  publish(prepared: PreparedImage, placement: ImagePlacement): ResolvedImage
  getPublications(): readonly Publication[]
  describeTrials(use: ImageUse): Promise<
    {
      source: ImageInputBytes
      trial: ProcessingTrial
      conditions: import('../processing/trial.ts').ImageTrial
      key: Digest
    }[]
  >
  registerFixedCopies(copies: readonly FixedCopy[]): Promise<void>
  getStatistics: () => {
    encodes: number
    sharedHits: number
    localHits: number
    joinedTrials: number
    sourceRecordHits: number
  }
  getPublishedDestinations(): string[]
  getUnusedOutputs(): string[]
  checkpoint(file: string): Promise<void>
  resume(file: string): Promise<void>
  verifyPublication(outputDirectory: string, declaration?: VerifyPublicationOptions): Promise<void>
}

export interface ImagePlacement {
  owner: string
  generated: boolean
  destination: string
  url: string
}

export function createImageBuild(options: ImageBuildOptions): ImageBuild {
  return makeImageBuild(options, true).build
}

export function makeImageBuild(
  options: ImageBuildOptions,
  standalone = false,
): { build: ImageBuild; finish: () => Promise<void> } {
  const limits = {
    maxBytes:
      options.localCache?.maxBytes === undefined ? 512 * 1024 * 1024 : options.localCache.maxBytes,
    maxEntries: options.localCache?.maxEntries === undefined ? 4096 : options.localCache.maxEntries,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Invalid localCache.${name}: expected a positive safe integer`)
  }
  const usages = options.usages ?? standardImageUsages
  const warn = isolateWarning(options.onWarning)
  const config = resolveImageConfig(options.config, usages)
  const root = path.resolve(options.projectRoot)
  const engine = createTrialEngine(root, options, config, limits, warn)
  const registry = createPlacementRegistry(options.caseInsensitiveOutputs ?? true)
  const verifyStoragePaths = createStorageGuard(root, options, registry.setCaseInsensitive)
  const readInput = createInputReader(root, verifyStoragePaths)
  const planTrials = createTrialPlanner(config, () => options.skipProcessing)
  const publication = createPublicationLedger(root, registry, verifyStoragePaths)
  const issued = new WeakSet<PreparedImage>()
  async function prepareUse(use: ImageUse): Promise<PreparedImage> {
    const prepared = await engine.prepareUse(use, usages, readInput, planTrials)
    if (standalone) await engine.finishStandaloneUse()
    Object.freeze(prepared.trialKeys)
    const result = Object.freeze(prepared)
    issued.add(result)
    return result
  }

  async function resolveUse(use: ImageUse): Promise<ResolvedImage> {
    const {
      suggestedDestination: destination,
      nameDigest: _nameDigest,
      attempts: _attempts,
      ...imageData
    } = await prepareUse(use)
    const { input } = use
    const url =
      options.urlFor?.(destination, use) ??
      '/' + destination.split('/').map(encodeURIComponent).join('/')
    const image = { ...imageData, destination, url }
    const owner =
      input.kind === 'generated'
        ? (input.owner ?? input.logicalName)
        : path.resolve(root, input.file)
    publication.recordOutput(owner, input.kind === 'generated', image, input.kind !== 'generated')
    return image
  }
  const build: ImageBuild = {
    resolveUse,
    prepareUse,
    publish(prepared, { owner, generated, destination, url }) {
      if (!issued.has(prepared)) throw new TypeError('Prepared image was not issued by this build')
      if (typeof owner !== 'string' || typeof generated !== 'boolean' || typeof url !== 'string')
        throw new TypeError('Invalid image placement')
      const {
        suggestedDestination: _destination,
        nameDigest: _name,
        attempts: _attempts,
        ...data
      } = prepared
      const image: ResolvedImage = { ...data, destination, url }
      publication.recordOutput(owner, generated, image, true)
      return image
    },
    getPublications: publication.getPublications,
    async describeTrials(use) {
      return describeTrials(use, usages, readInput, planTrials)
    },
    registerFixedCopies: publication.registerFixedCopies,
    getStatistics: engine.getStatistics,
    getPublishedDestinations: publication.getPublishedDestinations,
    getUnusedOutputs: publication.getUnusedOutputs,
    checkpoint: publication.checkpoint,
    resume: publication.resume,
    async verifyPublication(outputDirectory, declaration = {}) {
      await verifyStoragePaths(outputDirectory)
      const required = publication.requiredFiles(declaration)
      await verifyOutputFiles(
        path.resolve(root, outputDirectory),
        required,
        declaration,
        new Set(config.build.preserveFormatFor),
        warn,
      )
      await engine.pruneCache()
    },
  }
  return { build, finish: engine.pruneCache }
}
