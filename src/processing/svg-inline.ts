import { optimize, type CustomPlugin, type XastElement } from 'svgo'

import { failInlineSvg, ImagePipelineError } from '../shared/errors.ts'
import { optimizeInlineSvg, type SvgProcessingSettings } from './svg-processing.ts'
import {
  IDREF_LIST_ATTRIBUTES,
  IDREF_ATTRIBUTES,
  URL_REFERENCE_ATTRIBUTES,
  ANIMATION_VALUE_ATTRIBUTES,
  assertNoDanglingSourceReferencesPlugin,
} from './svg-references.ts'

function assertSafeHrefValue(attributeName: string, value: string, source: string): void {
  const normalized = value.replace(/[\t\n\r]/gu, '').trimStart()
  if (/^javascript:/iu.test(normalized)) {
    failInlineSvg(
      'SVG_INLINE_UNSAFE_ATTRIBUTE',
      `${attributeName}=javascript: is not supported: ${source}`,
    )
  }
}

function assertSafeAnimationHrefValues(node: XastElement, source: string): void {
  const animationTarget = node.attributes.attributeName?.trim().toLowerCase()
  if (animationTarget !== 'href' && animationTarget !== 'xlink:href') return

  for (const attributeName of ANIMATION_VALUE_ATTRIBUTES) {
    const value = node.attributes[attributeName]
    if (value === undefined) continue
    const candidates = attributeName === 'values' ? value.split(';') : [value]
    for (const candidate of candidates) assertSafeHrefValue(attributeName, candidate, source)
  }
}

function scopedId(id: string): string {
  return `${SVG_ID_PREFIX_SENTINEL}${id}`
}

function scopeIdToken(token: string, ids: ReadonlySet<string>): string {
  return ids.has(token) ? scopedId(token) : token
}

function scopeIdReferenceList(value: string, ids: ReadonlySet<string>): string {
  return value.replace(/[^\t\n\f\r ]+/gu, (token) => scopeIdToken(token, ids))
}

function scopeFragmentReference(value: string, ids: ReadonlySet<string>): string {
  if (!value.startsWith('#')) return value
  const rawId = value.slice(1)
  if (ids.has(rawId)) return `#${scopedId(rawId)}`

  try {
    return ids.has(decodeURIComponent(rawId)) ? `#${scopedId(rawId)}` : value
  } catch {
    return value
  }
}

function scopeAnimationValues(value: string, ids: ReadonlySet<string>): string {
  return value
    .split(';')
    .map((part) => {
      const match = /^(?<leading>\s*)(?<token>.*?)(?<trailing>\s*)$/su.exec(part)
      const leading = match?.groups?.leading ?? ''
      const trailing = match?.groups?.trailing ?? ''
      const token = match?.groups?.token ?? part
      return `${leading}${scopeFragmentReference(token, ids)}${trailing}`
    })
    .join(';')
}

function scopeSmilTiming(value: string, ids: ReadonlySet<string>): string {
  const idsByLength = [...ids].sort((a, b) => b.length - a.length)

  return value
    .split(';')
    .map((part) => {
      const leading = /^\s*/u.exec(part)?.[0] ?? ''
      const timing = part.slice(leading.length)
      const id = idsByLength.find((candidate) => timing.startsWith(`${candidate}.`))
      return id ? `${leading}${scopedId(id)}${timing.slice(id.length)}` : part
    })
    .join(';')
}

function scopeUrlReferences(value: string, ids: ReadonlySet<string>): string {
  return value.replace(
    /url\(\s*(?:"(#[^"]+)"|'(#[^']+)'|(#[^)"'\s]+))\s*\)/giu,
    (match, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string) => {
      const reference = doubleQuoted ?? singleQuoted ?? bare
      const quote = doubleQuoted === undefined ? (singleQuoted === undefined ? '' : "'") : '"'
      const scoped = scopeFragmentReference(reference, ids)
      return scoped === reference ? match : `url(${quote}${scoped}${quote})`
    },
  )
}

function collectIdsPlugin(ids: Set<string>, source: string): CustomPlugin {
  return {
    name: 'collect-inline-svg-ids',
    fn: () => ({
      element: {
        enter(node) {
          const id = node.attributes.id
          if (id === undefined) return
          if (id.length === 0 || /\s/u.test(id)) {
            failInlineSvg(
              'SVG_INLINE_INVALID_ID',
              `id must be non-empty and contain no whitespace: ${source}`,
            )
          }
          if (id.includes(SVG_ID_PREFIX_SENTINEL)) {
            failInlineSvg(
              'SVG_INLINE_INVALID_ID',
              `id contains the reserved inline sentinel: ${source}`,
            )
          }
          if (ids.has(id))
            failInlineSvg('SVG_INLINE_DUPLICATE_ID', `Duplicate SVG id in ${source}: ${id}`)
          ids.add(id)
        },
      },
    }),
  }
}

function validateSourcePlugin(source: string): CustomPlugin {
  return {
    name: 'validate-inline-svg-source',
    fn: () => ({
      element: {
        enter(node) {
          const name = node.name.toLowerCase()
          if (name === 'style' || name === 'script') {
            failInlineSvg('SVG_INLINE_UNSAFE_ELEMENT', `<${name}> is not supported: ${source}`)
          }

          for (const [attributeName, value] of Object.entries(node.attributes)) {
            if (/^on/iu.test(attributeName)) {
              failInlineSvg(
                'SVG_INLINE_UNSAFE_ATTRIBUTE',
                `${attributeName} is not supported: ${source}`,
              )
            }
            if (
              attributeName.toLowerCase() === 'href' ||
              attributeName.toLowerCase() === 'xlink:href'
            ) {
              assertSafeHrefValue(attributeName, value, source)
            }
          }
          assertSafeAnimationHrefValues(node, source)
        },
      },
    }),
  }
}

function scopeElementAttributes(node: XastElement, ids: ReadonlySet<string>): void {
  for (const [name, originalValue] of Object.entries(node.attributes)) {
    const lowerName = name.toLowerCase()
    let value = originalValue

    if (lowerName === 'id') {
      value = scopedId(value)
    } else if (lowerName === 'href' || lowerName === 'xlink:href') {
      value = scopeFragmentReference(value, ids)
    } else if (IDREF_LIST_ATTRIBUTES.has(lowerName)) {
      value = scopeIdReferenceList(value, ids)
    } else if (IDREF_ATTRIBUTES.has(lowerName)) {
      value = scopeIdToken(value, ids)
    } else if (lowerName === 'begin' || lowerName === 'end') {
      value = scopeSmilTiming(value, ids)
    }

    if (URL_REFERENCE_ATTRIBUTES.has(lowerName) && /url\s*\(/iu.test(value)) {
      value = scopeUrlReferences(value, ids)
    }

    node.attributes[name] = value
  }

  const animationTarget = node.attributes.attributeName?.toLowerCase()
  for (const name of ANIMATION_VALUE_ATTRIBUTES) {
    const value = node.attributes[name]
    if (value === undefined) continue
    if (animationTarget === 'href' || animationTarget === 'xlink:href') {
      node.attributes[name] = scopeAnimationValues(value, ids)
    } else if (animationTarget !== undefined && URL_REFERENCE_ATTRIBUTES.has(animationTarget)) {
      node.attributes[name] = scopeUrlReferences(value, ids)
    }
  }
}

function scopeIdsPlugin(ids: ReadonlySet<string>): CustomPlugin {
  return {
    name: 'scope-inline-svg-ids',
    fn: () => ({
      element: {
        enter(node) {
          scopeElementAttributes(node, ids)
        },
      },
    }),
  }
}

const SVG_INLINE_KIND = 'prepared-inline-svg/v1'
const SVG_ID_PREFIX_SENTINEL = '__SVG_INLINE_INSTANCE_7A4F2C__'

export interface PreparedInlineSvg {
  kind: typeof SVG_INLINE_KIND
  html: string
  hasIds: boolean
  source: string
}

export function prepareInlineSvg(
  svg: string,
  source = 'inline SVG',
  settings?: SvgProcessingSettings,
): PreparedInlineSvg {
  if (svg.includes(SVG_ID_PREFIX_SENTINEL)) {
    failInlineSvg(
      'SVG_INLINE_INVALID_SOURCE',
      `source contains the reserved inline sentinel: ${source}`,
    )
  }

  let parsed: string
  try {
    const validated = optimize(svg, {
      multipass: false,
      path: source,
      plugins: [validateSourcePlugin(source)],
    }).data
    const result = optimize(validated, {
      multipass: false,
      path: source,
      plugins: ['removeDoctype', 'removeXMLProcInst', 'removeComments', 'removeScripts'],
    })
    parsed = result.data
  } catch (error) {
    if (error instanceof ImagePipelineError) throw error
    failInlineSvg('SVG_INLINE_INVALID_SOURCE', `${source}: ${String(error)}`, error)
  }

  if (!/^<svg(?:\s|>)/u.test(parsed)) {
    failInlineSvg('SVG_INLINE_INVALID_SOURCE', `source must have an svg root element: ${source}`)
  }
  if (parsed.includes(SVG_ID_PREFIX_SENTINEL)) {
    failInlineSvg(
      'SVG_INLINE_INVALID_SOURCE',
      `source contains the reserved inline sentinel after parsing: ${source}`,
    )
  }

  const sourceIds = new Set<string>()
  let optimized: string
  try {
    const collected = optimize(parsed, {
      multipass: false,
      path: source,
      plugins: [collectIdsPlugin(sourceIds, source)],
    }).data
    optimized = settings ? optimizeInlineSvg(collected, source, settings) : collected
  } catch (error) {
    if (error instanceof ImagePipelineError) throw error
    failInlineSvg('SVG_INLINE_OPTIMIZE_FAILED', `${source}: ${String(error)}`, error)
  }

  const optimizedIds = new Set<string>()
  let html: string
  try {
    html = optimize(optimized, {
      multipass: false,
      path: source,
      plugins: [
        collectIdsPlugin(optimizedIds, source),
        assertNoDanglingSourceReferencesPlugin(sourceIds, optimizedIds, source),
        scopeIdsPlugin(optimizedIds),
      ],
    }).data
  } catch (error) {
    if (error instanceof ImagePipelineError) throw error
    failInlineSvg('SVG_INLINE_INVALID_SOURCE', `${source}: ${String(error)}`, error)
  }

  return {
    kind: SVG_INLINE_KIND,
    html,
    hasIds: optimizedIds.size > 0,
    source,
  }
}
