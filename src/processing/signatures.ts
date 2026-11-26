import sharp from 'sharp'
import { VERSION as SVGO_VERSION } from 'svgo'

import { sha256, type Digest } from '../shared/digest.ts'
import { normalizeBitmapOptions } from './bitmap-options.ts'

function serializeImageConfig(value: unknown, stack = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Image config contains a non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw new Error(`Image config contains an unsupported ${typeof value}`)
  }
  if (stack.has(value)) throw new Error('Image config contains a circular reference')
  stack.add(value)
  try {
    if (Array.isArray(value)) {
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new Error('Image config contains a sparse array')
        items.push(serializeImageConfig(value[index], stack))
      }
      return `[${items.join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error('Image config contains symbol keys')
    }
    if (prototype === RegExp.prototype) {
      if (Object.keys(value).length > 0)
        throw new Error('Image config contains an unsupported object')
      const expression = value as RegExp
      return `RegExp(${JSON.stringify(expression.source)},${JSON.stringify(expression.flags)})`
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Image config contains an unsupported object')
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serializeImageConfig((value as Record<string, unknown>)[key], stack)}`,
      )
    return `{${entries.join(',')}}`
  } finally {
    stack.delete(value)
  }
}

/** Versions of the actual codecs loaded by this package. */
export function getImageCodecVersions(): {
  sharp: {
    aom?: string | undefined
    archive?: string | undefined
    cairo?: string | undefined
    cgif?: string | undefined
    exif?: string | undefined
    expat?: string | undefined
    ffi?: string | undefined
    fontconfig?: string | undefined
    freetype?: string | undefined
    fribidi?: string | undefined
    glib?: string | undefined
    harfbuzz?: string | undefined
    heif?: string | undefined
    highway?: string | undefined
    imagequant?: string | undefined
    lcms?: string | undefined
    mozjpeg?: string | undefined
    pango?: string | undefined
    pixman?: string | undefined
    png?: string | undefined
    'proxy-libintl'?: string | undefined
    rsvg?: string | undefined
    sharp: string
    spng?: string | undefined
    tiff?: string | undefined
    vips: string
    webp?: string | undefined
    xml?: string | undefined
    'zlib-ng'?: string | undefined
  }
  svgo: string
} {
  return { sharp: { ...sharp.versions }, svgo: SVGO_VERSION }
}

export const SVG_PIPELINE_VERSION = 5
export const BITMAP_MINIFY_PIPELINE_VERSION = 3

export const IMAGE_OVERRIDE_PIPELINE_VERSIONS = {
  bitmap: 2,
  // Override orchestration is independent of the SVG codec revision in its config signature.
  svg: 2,
} as const

export const SVG_PRESERVE_ASPECT = 'none'

// Strict serialization disables cache shortcuts for unsupported configuration values.
export function buildImageConfigSignature(snapshot: unknown): string {
  try {
    const json = serializeImageConfig(snapshot)
    return sha256(json)
  } catch {
    return ''
  }
}

export function buildSvgConfigSignature(
  svgCfg: { svgoConfig: unknown; dimensionsMode?: unknown },
  pipelineVersion: number = SVG_PIPELINE_VERSION,
  svgoVersion: string = SVGO_VERSION,
): string {
  try {
    return buildImageConfigSignature({
      pipelineVersion,
      svgoVersion,
      svgoConfig: svgCfg.svgoConfig,
      dimensionsMode: svgCfg.dimensionsMode ?? 'round',
    })
  } catch {
    return ''
  }
}

/** Compatibility signature for the two-column source-image processing record. */
export function buildBitmapProcessingSignature(
  format: string,
  options: object,
  kind: 'minify' | 'override',
): string {
  return bitmapRecordSignature(format, options, kind)
}

export function bitmapRecordSignature(
  format: string,
  options: object,
  kind: 'minify' | 'override',
): Digest {
  return sha256(
    serializeImageConfig({
      version: 2,
      pipelineVersion:
        kind === 'minify'
          ? BITMAP_MINIFY_PIPELINE_VERSION
          : IMAGE_OVERRIDE_PIPELINE_VERSIONS.bitmap,
      format,
      options: normalizeBitmapOptions(options),
      kind,
      passes: 1,
      adoption: kind === 'minify' ? 'smaller-only' : 'always',
      sharp: sharp.versions.sharp,
      withMetadata: true,
      animated: true,
    }),
  )
}
