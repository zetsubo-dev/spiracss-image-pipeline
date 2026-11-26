import sharp from 'sharp'
import { VERSION as svgoVersion } from 'svgo'

import { canonicalJson, toJson, type Json } from '../shared/canonical-json.ts'
import { sha256, type Digest } from '../shared/digest.ts'
import type { ImageFormat } from '../shared/image-format.ts'
import { encodeBitmap, hasBitmapAnimation, hasUndecodableBitmapAnimation } from './bitmap-codec.ts'
import { normalizeBitmapOptions } from './bitmap-options.ts'
import { optimizeSvgFile, type SvgProcessingSettings } from './svg-processing.ts'

export type ImageTrial = {
  version: 1
  format: Exclude<ImageFormat, 'ico'>
  operation: 'minify' | 'convert' | 'override'
  adoption: 'smaller' | 'always'
  options: Json
}

export interface ImageInputBytes {
  bytes: Buffer
  digest: Digest
}

type UnchangedTrialResult =
  | { kind: 'same-as-source'; reason: 'no-gain' | 'id-reference' | 'source-record' | 'animation' }
  | { kind: 'skipped-min-size'; candidateSize: number }

export type TrialResult = { kind: 'adopted'; bytes: Buffer } | UnchangedTrialResult

export function sharedTrialKey(input: Digest, trial: ImageTrial): Digest {
  return sha256(canonicalJson({ input, trial }))
}

interface TrialSettings {
  format: Exclude<ImageFormat, 'ico'>
  operation: ImageTrial['operation']
  options: object
  adoption: ImageTrial['adoption']
}

export type ProcessingTrial = TrialSettings &
  (
    | { format: Exclude<ImageFormat, 'svg' | 'ico'> }
    | { format: 'svg'; svg: SvgProcessingSettings; logicalPath: string }
  )

export function trialConditions(trial: ProcessingTrial): ImageTrial | undefined {
  const options =
    trial.format === 'svg'
      ? {
          ...trial.svg,
          logicalPath: trial.logicalPath,
          preserveAspectRatio: 'none',
          references: 'preserve',
        }
      : { ...normalizeBitmapOptions(trial.options), metadata: true, animated: true }
  try {
    return {
      version: 1,
      operation: trial.operation,
      format: trial.format,
      adoption: trial.adoption,
      options: toJson(options),
    }
  } catch (error) {
    if (trial.format !== 'svg') throw error
    return undefined
  }
}

export function localTrialKey(sharedKey: Digest, trial: ProcessingTrial): Digest {
  const codec = trial.format === 'svg' ? { svgo: svgoVersion } : { sharp: sharp.versions }
  return sha256(
    canonicalJson({
      sharedKey,
      codec,
      ...(trial.format === 'avif' && { concurrency: sharp.concurrency() }),
    }),
  )
}

export async function runTrial(
  input: ImageInputBytes,
  trial: ProcessingTrial,
  onEncode?: () => void,
): Promise<TrialResult> {
  if (trial.format === 'svg') {
    onEncode?.()
    const result = optimizeSvgFile(input.bytes, trial.logicalPath, trial.svg)
    return result.skipReason
      ? { kind: 'same-as-source', reason: result.skipReason }
      : { kind: 'adopted', bytes: result.buffer }
  }
  if (
    trial.operation === 'minify' &&
    ((await hasUndecodableBitmapAnimation(input.bytes)) ||
      (trial.format === 'avif' && (await hasBitmapAnimation(input.bytes))))
  )
    return { kind: 'same-as-source', reason: 'animation' }
  onEncode?.()
  const bytes = await encodeBitmap(input.bytes, trial.format, trial.options)
  if (trial.adoption === 'smaller' && bytes.length >= input.bytes.length)
    return trial.operation === 'convert'
      ? { kind: 'skipped-min-size', candidateSize: bytes.length }
      : { kind: 'same-as-source', reason: 'no-gain' }
  if (bytes.equals(input.bytes)) return { kind: 'same-as-source', reason: 'no-gain' }
  return { kind: 'adopted', bytes }
}
