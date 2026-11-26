import type {
  ImageOverride,
  ImageUsage,
  SvgOptions,
  resolveImageConfig,
} from '../config/image-config.ts'
import {
  assertImageOverrideFamily,
  createImageDistIgnoreMatcher,
  resolveAutomaticImageFormat,
  resolveImageOverride,
} from '../config/policy.ts'
import type { Digest } from '../shared/digest.ts'
import { imageFormat, type ImageFormat } from '../shared/image-format.ts'
import { assertLogicalName } from '../shared/paths.ts'
import { hasBitmapAnimation, hasUndecodableBitmapAnimation } from './bitmap-codec.ts'
import type { InputReader } from './input.ts'
import { resolveSvgProcessingSettings } from './svg-processing.ts'
import {
  sharedTrialKey,
  trialConditions,
  type ImageInputBytes,
  type ImageTrial,
  type ProcessingTrial,
} from './trial.ts'

export interface ImageUse {
  input:
    | { kind: 'generated'; file: string; logicalName: string; owner?: string; bytes?: Uint8Array }
    | { kind: 'fixed-public'; file: string }
  logicalPlacement: string
  usage: ImageUsage
  excludeConversion?: boolean
  /** Keep the source bytes when the document requires the original format. */
  preserveSourceBytes?: boolean
  hashLength?: number
}

export interface StoreTrialInput {
  file: string
  logicalName: string
  logicalPlacement: string
  usage: ImageUsage
  excludeConversion?: boolean
}

export type TrialPlanner = (
  use: ImageUse,
  source: ImageInputBytes,
  onOverrideConflict?: (message: string) => void,
) => Promise<ProcessingTrial[]>

function explicitTrial(
  sourceFormat: Exclude<ImageFormat, 'ico'>,
  override: ImageOverride | undefined,
  svgOptions: SvgOptions,
  logicalPlacement: string,
): ProcessingTrial | undefined {
  if (override) assertImageOverrideFamily(sourceFormat, override.format)
  if (sourceFormat === 'svg') {
    const svg = resolveSvgProcessingSettings(
      svgOptions,
      override?.format === 'svg' ? override.options : undefined,
    )
    return {
      format: 'svg',
      operation: override ? 'override' : 'minify',
      adoption: 'smaller',
      options: {},
      svg,
      logicalPath: logicalPlacement,
    }
  }
  if (override && override.format !== 'svg') {
    const { minSize: _minSize, ...encoderOptions } = { minSize: undefined, ...override.options }
    return {
      format: override.format,
      operation: 'override',
      options: encoderOptions,
      adoption: 'always',
    }
  }
  return undefined
}

async function canConvert(target: 'avif' | 'webp', bytes: Buffer): Promise<boolean> {
  return (
    !(await hasUndecodableBitmapAnimation(bytes)) &&
    !(target === 'avif' && (await hasBitmapAnimation(bytes)))
  )
}

export function createTrialPlanner(
  config: ReturnType<typeof resolveImageConfig>,
  skipProcessing: () => boolean | undefined = () => undefined,
): TrialPlanner {
  const ignoreSourceConversion = createImageDistIgnoreMatcher(config.build.ignoreSrcConversion)
  const ignoreOutputConversion = createImageDistIgnoreMatcher(config.build.ignoreDistConversion)
  const ignoreMinify = createImageDistIgnoreMatcher(config.build.ignoreDistMinify)
  return async function planTrials(
    use: ImageUse,
    source: ImageInputBytes,
    onOverrideConflict?: (message: string) => void,
  ): Promise<ProcessingTrial[]> {
    const { input, logicalPlacement, usage } = use
    const sourceFormat = imageFormat(input.file)
    const trials: ProcessingTrial[] = []
    if (
      input.kind === 'fixed-public' ||
      skipProcessing() ||
      use.preserveSourceBytes ||
      ignoreMinify(logicalPlacement) ||
      !sourceFormat ||
      sourceFormat === 'ico'
    )
      return trials
    const preserveFormat = config.build.preserveFormatFor.includes(usage)
    const selected = resolveImageOverride(config.build.customOverridesDist, [logicalPlacement])
    const override =
      selected && (!preserveFormat || selected.format === sourceFormat) ? selected : undefined
    if (onOverrideConflict && selected && !override) {
      const index = config.build.customOverridesDist.indexOf(selected)
      onOverrideConflict(
        `Keeping ${sourceFormat} for ${input.file} (${usage}): build.preserveFormatFor conflicts with build.customOverridesDist[${index}] (${selected.format}).`,
      )
    }
    const explicit = explicitTrial(sourceFormat, override, config.formats.svg, logicalPlacement)
    if (explicit) return [explicit]
    if (sourceFormat === 'svg') return trials
    const target =
      !preserveFormat &&
      !use.excludeConversion &&
      !ignoreSourceConversion(input.logicalName) &&
      !ignoreOutputConversion(logicalPlacement) &&
      resolveAutomaticImageFormat(sourceFormat, config.build.outputFormat)
    if (target && (await canConvert(target, source.bytes))) {
      const { minSize = true, ...encoderOptions } = config.formats[target]
      trials.push({
        format: target,
        operation: 'convert',
        options: encoderOptions,
        adoption: minSize ? 'smaller' : 'always',
      })
      if (!minSize) return trials
    }
    const { minSize: _minSize, ...encoderOptions } = {
      minSize: undefined,
      ...config.formats[sourceFormat],
    }
    trials.push({
      format: sourceFormat,
      operation: 'minify',
      options: encoderOptions,
      adoption: 'smaller',
    })
    return trials
  }
}

export async function describeTrials(
  use: ImageUse,
  usages: readonly ImageUsage[],
  readInput: InputReader,
  planTrials: TrialPlanner,
): Promise<
  {
    source: ImageInputBytes
    trial: ProcessingTrial
    conditions: ImageTrial
    key: Digest
  }[]
> {
  if (!usages.includes(use.usage)) throw new TypeError(`Unknown image usage: ${use.usage}`)
  assertLogicalName(use.logicalPlacement)
  if (use.input.kind === 'generated') assertLogicalName(use.input.logicalName)
  const source = await readInput(
    use.input.file,
    use.input.kind === 'generated' ? use.input.bytes : undefined,
  )
  const trials = []
  for (const trial of await planTrials(use, source)) {
    const conditions = trialConditions(trial)
    if (conditions)
      trials.push({ source, trial, conditions, key: sharedTrialKey(source.digest, conditions) })
  }
  return trials
}
