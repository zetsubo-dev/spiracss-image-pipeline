import path from 'node:path'

import PQueue from 'p-queue'

import type { ImageUsage, resolveImageConfig } from '../config/image-config.ts'
import type { InputReader } from '../processing/input.ts'
import { imageJobLimit } from '../processing/runtime.ts'
import { bitmapRecordSignature } from '../processing/signatures.ts'
import type { ImageUse, TrialPlanner } from '../processing/trial-plan.ts'
import {
  localTrialKey,
  runTrial,
  sharedTrialKey,
  trialConditions,
  type ImageInputBytes,
  type ProcessingTrial,
  type TrialResult,
} from '../processing/trial.ts'
import type { ResolvedImage } from '../publication/placement-registry.ts'
import { imageNameHash, sha256, type Digest } from '../shared/digest.ts'
import { imageFormat } from '../shared/image-format.ts'
import { assertLogicalName } from '../shared/paths.ts'
import { AdoptedStore } from '../store/adopted-store.ts'
import { LocalTrialCache } from '../store/local-cache.ts'
import { readSourceRecord, sourceImageRecordName } from '../store/source-ledger.ts'
import type { ImageBuildOptions } from './options.ts'

function matchesBitmapRecord(proofs: ReadonlySet<string> | undefined, trial: ProcessingTrial) {
  if (!proofs || trial.operation === 'convert') return false
  if (proofs.has(bitmapRecordSignature(trial.format, trial.options, trial.operation))) return true
  if (trial.operation !== 'minify' || (trial.format !== 'avif' && trial.format !== 'webp'))
    return false
  // Older ledgers signed the conversion threshold even for same-format compression.
  return [true, false].some((minSize) =>
    proofs.has(bitmapRecordSignature(trial.format, { ...trial.options, minSize }, 'minify')),
  )
}

export interface PreparedImage extends Omit<ResolvedImage, 'destination' | 'url'> {
  suggestedDestination: string
  nameDigest: Digest
  attempts: readonly {
    operation: ProcessingTrial['operation']
    format: ProcessingTrial['format']
    result: TrialResult['kind']
    reason?: string
  }[]
}

interface TrialEngine {
  prepareUse(
    use: ImageUse,
    usages: readonly ImageUsage[],
    readInput: InputReader,
    planTrials: TrialPlanner,
  ): Promise<PreparedImage>
  getStatistics(): {
    encodes: number
    sharedHits: number
    localHits: number
    joinedTrials: number
    sourceRecordHits: number
  }
  pruneCache(): Promise<void>
  finishStandaloneUse(): Promise<void> | undefined
}

export function createTrialEngine(
  root: string,
  options: ImageBuildOptions,
  config: ReturnType<typeof resolveImageConfig>,
  limits: { maxBytes: number; maxEntries: number },
  warn: (message: string) => void,
): TrialEngine {
  const store =
    options.adoptedStoreDir && new AdoptedStore(path.resolve(root, options.adoptedStoreDir), warn)
  const cache =
    options.cacheDir &&
    new LocalTrialCache(path.resolve(root, options.cacheDir, 'trials-v1'), limits, {
      onWarning: warn,
    })
  const queue = new PQueue({ concurrency: imageJobLimit(config.jobs) })
  const warnedOverrides = new Set<string>()
  const jobs = new Map<Digest, Promise<TrialResult>>()
  const statistics = {
    encodes: 0,
    sharedHits: 0,
    localHits: 0,
    joinedTrials: 0,
    sourceRecordHits: 0,
  }
  let sourceRecord: ReturnType<typeof readSourceRecord> | undefined
  function executeTrial(input: ImageInputBytes, trial: ProcessingTrial) {
    return runTrial(input, trial, () => {
      statistics.encodes++
    })
  }

  function trialResult(
    input: ImageInputBytes,
    trial: ProcessingTrial,
  ): { key?: Digest; result: Promise<TrialResult> } {
    const conditions = trialConditions(trial)
    const key = conditions && sharedTrialKey(input.digest, conditions)
    if (!conditions || !key) return { result: queue.add(() => executeTrial(input, trial)) }
    const existing = jobs.get(key)
    if (existing) {
      statistics.joinedTrials++
      return { key, result: existing }
    }
    const pending = queue.add(async () => {
      const shared = store && (await store.read(key, conditions, input))
      if (shared) {
        statistics.sharedHits++
        return shared
      }
      if (trial.format !== 'svg' && trial.operation !== 'convert') {
        sourceRecord ??= readSourceRecord(
          path.resolve(root, options.sourceRecordPath ?? sourceImageRecordName),
        )
        const proofs = (await sourceRecord).get(input.digest)
        if (matchesBitmapRecord(proofs, trial)) {
          statistics.sourceRecordHits++
          const result = { kind: 'same-as-source', reason: 'source-record' } as const
          if (store) await store.write(key, conditions, input, result)
          return result
        }
      }
      const localKey = localTrialKey(key, trial)
      let result = cache ? await cache.read(localKey, conditions, input) : undefined
      if (result) statistics.localHits++
      else {
        result = await executeTrial(input, trial)
        if (cache) await cache.write(localKey, conditions, input, result)
      }
      if (store) await store.write(key, conditions, input, result)
      return result
    })
    jobs.set(key, pending)
    return { key, result: pending }
  }
  async function prepareUse(
    use: ImageUse,
    usages: readonly ImageUsage[],
    readInput: InputReader,
    planTrials: TrialPlanner,
  ): Promise<PreparedImage> {
    const { input, logicalPlacement, usage, hashLength } = use
    if (!usages.includes(usage)) throw new TypeError(`Unknown image usage: ${usage}`)
    assertLogicalName(logicalPlacement)
    if (
      hashLength !== undefined &&
      (!Number.isInteger(hashLength) || hashLength < 1 || hashLength > 64)
    )
      throw new TypeError('Image hash length must be between 1 and 64')
    if (input.kind === 'generated') assertLogicalName(input.logicalName)
    const sourceFormat = imageFormat(input.file)
    if (!sourceFormat) throw new TypeError(`Unsupported image format: ${input.file}`)
    if (imageFormat(logicalPlacement) !== sourceFormat)
      throw new TypeError(`Logical placement must use the source format: ${logicalPlacement}`)
    const snapshot = input.kind === 'generated' ? input.bytes : undefined
    const source = await readInput(input.file, snapshot)
    let { bytes } = source
    let format = sourceFormat
    const trialKeys: Digest[] = []
    const attempts: PreparedImage['attempts'][number][] = []

    const applyTrial = async (trial: ProcessingTrial): Promise<boolean> => {
      const { key, result } = trialResult(source, trial)
      if (key) trialKeys.push(key)
      const selection = await result
      attempts.push({
        operation: trial.operation,
        format: trial.format,
        result: selection.kind,
        reason: selection.kind === 'same-as-source' ? selection.reason : undefined,
      })
      if (selection.kind === 'skipped-min-size') return false
      if (selection.kind === 'adopted') bytes = selection.bytes
      format = trial.format
      return true
    }

    const trials = await planTrials(use, source, (message) => {
      const key = JSON.stringify([input.file, logicalPlacement, usage])
      if (warnedOverrides.has(key)) return
      warnedOverrides.add(key)
      warn(message)
    })
    if (options.onStoreTrials && input.kind === 'generated') {
      const keys = trials.flatMap((trial) => {
        const conditions = trialConditions(trial)
        return conditions ? [sharedTrialKey(source.digest, conditions)] : []
      })
      await options.onStoreTrials(
        {
          file: path.resolve(root, input.file),
          logicalName: input.logicalName,
          logicalPlacement,
          usage,
          excludeConversion: use.excludeConversion,
        },
        keys,
      )
    }
    for (const trial of trials) {
      if (await applyTrial(trial)) break
    }

    await readInput(input.file, snapshot)
    const digest = sha256(bytes)
    const nameDigest = imageNameHash(source.digest, digest)
    const extension = path.posix.extname(logicalPlacement)
    const outputExtension = format === sourceFormat ? extension : `.${format}`
    const suffix =
      input.kind === 'generated' && hashLength ? `-${nameDigest.slice(0, hashLength)}` : ''
    const suggestedDestination = `${logicalPlacement.slice(0, logicalPlacement.length - extension.length)}${suffix}${outputExtension}`
    return {
      suggestedDestination,
      nameDigest,
      format,
      sourceDigest: source.digest,
      outputDigest: digest,
      bytes: Buffer.from(bytes),
      trialKeys,
      attempts,
    }
  }

  return {
    prepareUse,
    getStatistics: () => ({ ...statistics }),
    finishStandaloneUse: () => (cache ? cache.finishStandaloneUse() : undefined),
    async pruneCache() {
      if (cache) await cache.prune()
    },
  }
}
