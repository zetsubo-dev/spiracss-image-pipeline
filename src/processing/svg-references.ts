import { optimize, type CustomPlugin, type XastElement } from 'svgo'

import { failInlineSvg, ImagePipelineError } from '../shared/errors.ts'

export const IDREF_LIST_ATTRIBUTES: Set<string> = new Set([
  'aria-activedescendant',
  'aria-controls',
  'aria-describedby',
  'aria-details',
  'aria-errormessage',
  'aria-flowto',
  'aria-labelledby',
  'aria-owns',
  'headers',
  'itemref',
])
export const IDREF_ATTRIBUTES: Set<string> = new Set([
  'commandfor',
  'for',
  'form',
  'list',
  'popovertarget',
])
export const URL_REFERENCE_ATTRIBUTES: Set<string> = new Set([
  'clip-path',
  'color-profile',
  'cursor',
  'fill',
  'filter',
  'marker',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'stroke',
  'style',
])
export const ANIMATION_VALUE_ATTRIBUTES = ['by', 'from', 'to', 'values'] as const

function localFragmentId(value: string): string | null {
  if (!value.startsWith('#')) return null
  const rawId = value.slice(1)
  try {
    return decodeURIComponent(rawId)
  } catch {
    return rawId
  }
}

function assertReferenceTarget(
  value: string,
  sourceIds: ReadonlySet<string>,
  optimizedIds: ReadonlySet<string>,
  source: string,
): void {
  const id = localFragmentId(value)
  if (id !== null && sourceIds.has(id) && !optimizedIds.has(id)) {
    failInlineSvg('SVG_INLINE_DANGLING_ID_REFERENCE', `${source}: #${id}`)
  }
}

function assertUrlReferenceTargets(
  value: string,
  sourceIds: ReadonlySet<string>,
  optimizedIds: ReadonlySet<string>,
  source: string,
): void {
  for (const match of value.matchAll(/url\(\s*(?:"(#[^"]+)"|'(#[^']+)'|(#[^)"'\s]+))\s*\)/giu)) {
    const reference = match[1] ?? match[2] ?? match[3]
    if (reference !== undefined) {
      assertReferenceTarget(reference, sourceIds, optimizedIds, source)
    }
  }
}

function assertNoDanglingAttributeReference(
  name: string,
  value: string,
  sourceIds: ReadonlySet<string>,
  optimizedIds: ReadonlySet<string>,
  sourceIdsByLength: readonly string[],
  source: string,
): void {
  const lowerName = name.toLowerCase()

  if (lowerName === 'href' || lowerName === 'xlink:href') {
    assertReferenceTarget(value, sourceIds, optimizedIds, source)
  } else if (IDREF_LIST_ATTRIBUTES.has(lowerName)) {
    for (const token of value.match(/[^\t\n\f\r ]+/gu) ?? []) {
      if (sourceIds.has(token) && !optimizedIds.has(token)) {
        failInlineSvg('SVG_INLINE_DANGLING_ID_REFERENCE', `${source}: #${token}`)
      }
    }
  } else if (IDREF_ATTRIBUTES.has(lowerName) && sourceIds.has(value) && !optimizedIds.has(value)) {
    failInlineSvg('SVG_INLINE_DANGLING_ID_REFERENCE', `${source}: #${value}`)
  } else if (lowerName === 'begin' || lowerName === 'end') {
    for (const part of value.split(';')) {
      const timing = part.trimStart()
      const id = sourceIdsByLength.find((candidate) => timing.startsWith(`${candidate}.`))
      if (id !== undefined && !optimizedIds.has(id)) {
        failInlineSvg('SVG_INLINE_DANGLING_ID_REFERENCE', `${source}: #${id}`)
      }
    }
  }

  if (URL_REFERENCE_ATTRIBUTES.has(lowerName) && /url\s*\(/iu.test(value)) {
    assertUrlReferenceTargets(value, sourceIds, optimizedIds, source)
  }
}

function assertNoDanglingAnimationReferences(
  node: XastElement,
  sourceIds: ReadonlySet<string>,
  optimizedIds: ReadonlySet<string>,
  source: string,
): void {
  const animationTarget = node.attributes.attributeName?.toLowerCase()
  for (const name of ANIMATION_VALUE_ATTRIBUTES) {
    const value = node.attributes[name]
    if (value === undefined) continue
    if (animationTarget === 'href' || animationTarget === 'xlink:href') {
      for (const part of value.split(';')) {
        assertReferenceTarget(part.trim(), sourceIds, optimizedIds, source)
      }
    } else if (animationTarget !== undefined && URL_REFERENCE_ATTRIBUTES.has(animationTarget)) {
      assertUrlReferenceTargets(value, sourceIds, optimizedIds, source)
    }
  }
}

export function assertNoDanglingSourceReferencesPlugin(
  sourceIds: ReadonlySet<string>,
  optimizedIds: ReadonlySet<string>,
  source: string,
): CustomPlugin {
  const sourceIdsByLength = [...sourceIds].sort((a, b) => b.length - a.length)

  return {
    name: 'assert-no-dangling-inline-svg-references',
    fn: () => ({
      element: {
        enter(node) {
          for (const [name, value] of Object.entries(node.attributes)) {
            assertNoDanglingAttributeReference(
              name,
              value,
              sourceIds,
              optimizedIds,
              sourceIdsByLength,
              source,
            )
          }
          assertNoDanglingAnimationReferences(node, sourceIds, optimizedIds, source)
        },
      },
    }),
  }
}

// Reuse the inline contract for candidates about to replace source/output bytes.
// Collect raw IDs here without extending inline-only source validation to images.
function collectReferenceIds(ids: Set<string>): CustomPlugin {
  return {
    name: 'collect-svg-reference-ids',
    fn: () => ({
      element: {
        enter(node) {
          if (node.attributes.id !== undefined) ids.add(node.attributes.id)
        },
      },
    }),
  }
}

export function preservesSvgReferences(
  sourceSvg: string,
  outputSvg: string,
  source: string,
): boolean {
  const sourceIds = new Set<string>()
  const outputIds = new Set<string>()
  optimize(sourceSvg, { multipass: false, plugins: [collectReferenceIds(sourceIds)] })
  try {
    optimize(outputSvg, {
      multipass: false,
      plugins: [
        collectReferenceIds(outputIds),
        assertNoDanglingSourceReferencesPlugin(sourceIds, outputIds, source),
      ],
    })
    return true
  } catch (error) {
    if (error instanceof ImagePipelineError && error.code === 'SVG_INLINE_DANGLING_ID_REFERENCE')
      return false
    throw error
  }
}
