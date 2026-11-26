import type { Sharp } from 'sharp'
import type { Config as SvgoConfig } from 'svgo'

export type ImageUsage = string

export const standardImageUsages = [
  'body',
  'ogp',
  'twitter',
  'favicon',
  'apple-touch-icon',
  'manifest-icon',
  'json-ld',
] as const

export interface BitmapOptions {
  png: NonNullable<Parameters<Sharp['png']>[0]>
  jpeg: NonNullable<Parameters<Sharp['jpeg']>[0]>
  gif: NonNullable<Parameters<Sharp['gif']>[0]>
  webp: NonNullable<Parameters<Sharp['webp']>[0]> & { minSize?: boolean }
  avif: NonNullable<Parameters<Sharp['avif']>[0]> & { minSize?: boolean }
}

export interface SvgOptions {
  svgoConfig: SvgoConfig
  dimensionsMode?: 'round' | 'none'
}

type FormatOptions = BitmapOptions & { svg: SvgOptions }
export type ImageOverride = {
  [Format in keyof FormatOptions]: {
    match: string | RegExp
    format: Format
    options?: Format extends 'svg' ? Partial<SvgOptions> : FormatOptions[Format]
  }
}[keyof FormatOptions]

export interface ImageConfig {
  formats?: Partial<FormatOptions>
  dev?: {
    autoMinify?: boolean
    ignoreAllAutoOptimize?: readonly string[]
    customOverrides?: readonly ImageOverride[]
  }
  build?: {
    outputFormat?: 'webp' | 'avif' | false
    ignoreSrcConversion?: readonly string[]
    ignoreDistConversion?: readonly string[]
    ignoreDistMinify?: readonly string[]
    customOverridesDist?: readonly ImageOverride[]
    preserveFormatFor?: readonly ImageUsage[]
  }
  jobs?: number
}

export function defineImageConfig(config: ImageConfig): ImageConfig {
  resolveImageConfig(config)
  return config
}

export function resolveImageConfig(
  config: ImageConfig = {},
  usages?: readonly ImageUsage[],
): {
  formats: {
    png: NonNullable<Parameters<Sharp['png']>[0]>
    jpeg: NonNullable<Parameters<Sharp['jpeg']>[0]>
    gif: NonNullable<Parameters<Sharp['gif']>[0]>
    webp: NonNullable<Parameters<Sharp['webp']>[0]> & {
      minSize?: boolean
    }
    avif: NonNullable<Parameters<Sharp['avif']>[0]> & {
      minSize?: boolean
    }
    svg: SvgOptions
  }
  dev: {
    autoMinify: boolean
    ignoreAllAutoOptimize: readonly string[]
    customOverrides: readonly ImageOverride[]
  }
  build: {
    outputFormat: false | 'webp' | 'avif'
    ignoreSrcConversion: readonly string[]
    ignoreDistConversion: readonly string[]
    ignoreDistMinify: readonly string[]
    customOverridesDist: readonly ImageOverride[]
    preserveFormatFor: readonly string[]
  }
  jobs: number
} {
  const { dev = {}, build = {}, formats = {}, jobs = 4 } = config
  if ('ignoreAutoWebp' in dev)
    throw new TypeError(
      'dev.ignoreAutoWebp was removed. Use build.ignoreSrcConversion and build.ignoreDistConversion.',
    )
  if (dev.autoMinify !== undefined && typeof dev.autoMinify !== 'boolean')
    throw new TypeError('dev.autoMinify must be a boolean')
  for (const key of ['toWebp', 'ignoreSrcWebp', 'ignoreDistWebp']) {
    if (key in build)
      throw new TypeError(
        `build.${key} was removed. Use build.outputFormat, build.ignoreSrcConversion and build.ignoreDistConversion.`,
      )
  }
  if (build.outputFormat !== undefined && ![false, 'webp', 'avif'].includes(build.outputFormat))
    throw new TypeError('build.outputFormat must be webp, avif, or false')
  const preserveFormatFor = strings(build.preserveFormatFor, 'build.preserveFormatFor')
  for (const usage of preserveFormatFor) {
    if (!usage || (usages && !usages.includes(usage)))
      throw new TypeError(
        `Unknown build.preserveFormatFor usage "${usage}". Valid usages: ${usages?.join(', ') ?? 'non-empty names'}`,
      )
  }
  if (!Number.isSafeInteger(jobs) || jobs < 1)
    throw new TypeError('jobs must be a positive integer')
  return {
    formats: {
      png: {},
      jpeg: {},
      gif: {},
      webp: {},
      avif: {},
      svg: { svgoConfig: { plugins: ['preset-default'] }, dimensionsMode: 'round' },
      ...formats,
    } satisfies FormatOptions,
    dev: {
      autoMinify: dev.autoMinify ?? true,
      ignoreAllAutoOptimize: strings(dev.ignoreAllAutoOptimize, 'dev.ignoreAllAutoOptimize'),
      customOverrides: overrides(dev.customOverrides, 'dev.customOverrides'),
    },
    build: {
      outputFormat: build.outputFormat ?? false,
      ignoreSrcConversion: strings(build.ignoreSrcConversion, 'build.ignoreSrcConversion'),
      ignoreDistConversion: strings(build.ignoreDistConversion, 'build.ignoreDistConversion'),
      ignoreDistMinify: strings(build.ignoreDistMinify, 'build.ignoreDistMinify'),
      customOverridesDist: overrides(build.customOverridesDist, 'build.customOverridesDist'),
      preserveFormatFor,
    },
    jobs,
  }
}

function strings(value: readonly string[] = [], key: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new TypeError(`${key} must be an array of strings`)
  return value
}

function overrides(value: readonly ImageOverride[] = [], key: string): readonly ImageOverride[] {
  if (!Array.isArray(value)) throw new TypeError(`${key} must be an array of image overrides`)
  for (const entry of value) {
    if (
      !entry ||
      (typeof entry.match !== 'string' && !(entry.match instanceof RegExp)) ||
      !['png', 'jpeg', 'gif', 'webp', 'avif', 'svg'].includes(entry.format) ||
      (entry.options !== undefined &&
        (typeof entry.options !== 'object' ||
          entry.options === null ||
          Array.isArray(entry.options)))
    )
      throw new TypeError(`Invalid image override in ${key}`)
  }
  return value
}
