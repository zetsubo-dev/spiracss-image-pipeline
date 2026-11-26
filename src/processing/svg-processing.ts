import { optimize, type Config as SvgoConfig, type PluginConfig } from 'svgo'

import { preservesSvgReferences } from './svg-references.ts'

const SVG_PRESERVE_ASPECT = 'none'

export interface SvgProcessingSettings {
  svgoConfig: unknown
  dimensionsMode: 'round' | 'none'
}

/** Resolve only the two SVG fields; an explicit SVGO configuration replaces the whole value. */
export function resolveSvgProcessingSettings(
  base: { svgoConfig: unknown; dimensionsMode?: unknown },
  override?: { svgoConfig?: unknown; dimensionsMode?: unknown },
): SvgProcessingSettings {
  const svgoConfig = override?.svgoConfig === undefined ? base.svgoConfig : override.svgoConfig
  const selectedDimensions =
    override?.dimensionsMode === undefined ? base.dimensionsMode : override.dimensionsMode
  const dimensionsMode = selectedDimensions === undefined ? 'round' : selectedDimensions
  if (typeof svgoConfig !== 'object' || svgoConfig === null || Array.isArray(svgoConfig))
    throw new TypeError('SVG svgoConfig must be a non-null object')
  if (dimensionsMode !== 'round' && dimensionsMode !== 'none')
    throw new TypeError('SVG dimensionsMode must be round or none')
  return { svgoConfig, dimensionsMode }
}

function ensureSvgDimensions(svg: string, mode: SvgProcessingSettings['dimensionsMode']): string {
  const match = /<svg[^>]*>/iu.exec(svg)
  if (!match) return svg
  const originalTag = match[0]
  const hasWidth = /\swidth\s*=/iu.test(originalTag)
  const hasHeight = /\sheight\s*=/iu.test(originalTag)
  if (hasWidth && hasHeight) return svg
  const viewBoxMatch = /\sviewBox\s*=\s*["'](?<group1>[^"']+)["']/iu.exec(originalTag)
  if (!viewBoxMatch) return svg
  const parts = viewBoxMatch[1]!.trim().split(/[ ,]+/u)
  if (parts.length < 4) return svg
  const minXNum = Number(parts[0])
  const minYNum = Number(parts[1])
  const widthNum = Number(parts[2])
  const heightNum = Number(parts[3])
  const width = mode === 'round' ? Math.round(widthNum) : widthNum
  const height = mode === 'round' ? Math.round(heightNum) : heightNum
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(minXNum) ||
    !Number.isFinite(minYNum) ||
    width <= 0 ||
    height <= 0
  )
    return svg
  let insert = ''
  if (!hasWidth) insert += ` width="${width}"`
  if (!hasHeight) insert += ` height="${height}"`
  const updatedTag = originalTag.replace('<svg', `<svg${insert}`)
  return svg.replace(originalTag, updatedTag)
}

function baseConfig(settings: SvgProcessingSettings): SvgoConfig | undefined {
  const value = settings.svgoConfig
  return typeof value === 'object' && value !== null ? (value as SvgoConfig) : undefined
}

function optimizeConfiguredSvg(
  svg: string,
  source: string,
  config: SvgoConfig | undefined,
  plugins: PluginConfig[],
  dimensionsMode: SvgProcessingSettings['dimensionsMode'],
): string {
  const hasAddAttributes = plugins.some(
    (plugin) =>
      plugin !== null && typeof plugin === 'object' && plugin.name === 'addAttributesToSVGElement',
  )
  const { data } = optimize(svg, {
    ...config,
    path: source,
    plugins: hasAddAttributes
      ? plugins
      : [
          ...plugins,
          {
            name: 'addAttributesToSVGElement',
            params: { attributes: [{ preserveAspectRatio: SVG_PRESERVE_ASPECT }] },
          },
        ],
  })
  return ensureSvgDimensions(data, dimensionsMode)
}

function withInlinePresetOverrides(plugins: PluginConfig[]): PluginConfig[] {
  const ignored = new Set(['cleanupIds', 'convertStyleToAttrs', 'prefixIds'])
  return plugins
    .filter(
      (plugin) =>
        !(typeof plugin === 'string' && ignored.has(plugin)) &&
        !(typeof plugin === 'object' && plugin !== null && ignored.has(plugin.name)),
    )
    .map((plugin) => {
      if (plugin === 'preset-default')
        return {
          name: 'preset-default',
          params: {
            overrides: { cleanupIds: false, inlineStyles: false, removeEmptyContainers: false },
          },
        }
      if (typeof plugin !== 'object' || plugin.name !== 'preset-default') return plugin
      const preset = plugin as {
        name: 'preset-default'
        params?: { overrides?: Record<string, boolean> }
      }
      return {
        ...preset,
        params: {
          ...preset.params,
          overrides: {
            ...preset.params?.overrides,
            cleanupIds: false,
            inlineStyles: false,
            removeEmptyContainers: false,
          },
        },
      } as PluginConfig
    })
}

/** File replacement must shrink and preserve references; unused candidates retain the input. */
export function optimizeSvgFile(
  bytes: Buffer,
  source: string,
  settings: SvgProcessingSettings,
): { buffer: Buffer; skipReason: 'no-gain' | 'id-reference' | null } {
  const config = baseConfig(settings)
  const input = bytes.toString('utf8')
  const output = optimizeConfiguredSvg(
    input,
    source,
    config,
    config?.plugins ?? [],
    settings.dimensionsMode,
  )
  const buffer = Buffer.from(output, 'utf8')
  if (buffer.length >= bytes.length) return { buffer: bytes, skipReason: 'no-gain' }
  if (!preservesSvgReferences(input, output, source))
    return { buffer: bytes, skipReason: 'id-reference' }
  return { buffer, skipReason: null }
}

/** Inline configuration runs before the caller's ID scoping, even when the text grows. */
export function optimizeInlineSvg(
  svg: string,
  source: string,
  settings: SvgProcessingSettings,
): string {
  const config = baseConfig(settings)
  if (!config) return ensureSvgDimensions(svg, settings.dimensionsMode)
  return optimizeConfiguredSvg(
    svg,
    source,
    config,
    withInlinePresetOverrides(config.plugins ?? []),
    settings.dimensionsMode,
  )
}
