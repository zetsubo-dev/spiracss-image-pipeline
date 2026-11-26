import { imageFormat } from '../shared/image-format.ts'
import { inspectHtml } from './html.ts'
import { DocumentJsonError, inspectJson } from './json.ts'
import { classifyOutputUrl, outputUrl, resolveReference } from './resolve.ts'
import type { DocumentReferences, Edit, OutputReference } from './types.ts'

export interface ManifestPlanOptions {
  document: string
  base: string
  siteOrigin?: string
  kind?: 'html' | 'manifest'
  mode?: 'default' | 'verify'
  readOnly?: boolean
}

export interface PlannedManifestReference {
  reference: OutputReference
  file: string
  suffix: string
  readOnly: boolean
}

export type ManifestSelections = ReadonlyMap<
  OutputReference,
  { destination: string; format: string }
>

export type ManifestUnknownReason =
  | DocumentJsonError['code']
  | 'UNRECOGNIZED_CONTENT'
  | 'UNRESOLVABLE_URL'

export interface ManifestImagePlan {
  references: PlannedManifestReference[]
  manifests: string[]
  unknown: boolean
  unknownReasons: readonly ManifestUnknownReason[]
  rewrite(selections: ManifestSelections): string
}

function inspectForPlan(
  text: string,
  { kind, mode }: ManifestPlanOptions,
  reasons: Set<ManifestUnknownReason>,
): DocumentReferences {
  if (kind === 'html') return inspectHtml(text, mode === 'verify')
  try {
    return inspectManifestImages(text)
  } catch (error) {
    if (!(error instanceof DocumentJsonError)) throw error
    reasons.add(error.code)
    return { references: [], unknown: false }
  }
}

/** Resolve manifest links and image uses before the host chooses new placements. */
export function planManifestImages(text: string, options: ManifestPlanOptions): ManifestImagePlan {
  const { document, base, siteOrigin, kind, readOnly, mode } = options
  const reasons = new Set<ManifestUnknownReason>()
  const parsed = inspectForPlan(text, options, reasons)
  if (parsed.unknown) reasons.add('UNRECOGNIZED_CONTENT')
  const baseHref = mode === 'verify' ? parsed.baseHref : undefined
  function locate(url: string) {
    const target = classifyOutputUrl(url, document, base, siteOrigin, baseHref)
    if (target.kind === 'unresolvable') reasons.add('UNRESOLVABLE_URL')
    if (target.kind === 'local') return { file: target.file, suffix: target.suffix }
    return undefined
  }
  const manifests = (parsed.manifests ?? []).flatMap((href) => {
    const target = locate(href)
    return target ? [target.file] : []
  })
  const references = parsed.references.flatMap((reference) => {
    const target = locate(reference.url)
    return target && imageFormat(target.file)
      ? [{ ...target, reference, readOnly: Boolean(readOnly || reference.readOnly) }]
      : []
  })
  return {
    references,
    manifests,
    unknown: reasons.size > 0,
    unknownReasons: [...reasons],
    rewrite(selections) {
      if (kind === 'html' || readOnly) return text
      return rewriteManifestImages(
        text,
        references.map(({ reference }) => reference),
        selections,
        document,
        base,
        siteOrigin,
      )
    },
  }
}
/** Parse only image-bearing manifest fields; screenshot references remain read-only. */
export function inspectManifestImages(text: string): DocumentReferences {
  return inspectJson(text.replace(/^\uFEFF/u, ' '), 'manifest')
}

/** Apply decisions made by the host after it has resolved and published each source. */
export function rewriteManifestImages(
  text: string,
  references: readonly OutputReference[],
  selections: ReadonlyMap<OutputReference, { destination: string; format: string }>,
  document: string,
  base: string,
  siteOrigin?: string,
): string {
  const edits: Edit[] = []
  for (const reference of references) {
    const selected = selections.get(reference)
    if (!selected || reference.readOnly) continue
    const target = resolveReference(reference.url, document, base, siteOrigin)
    if (!target) throw new Error('Cannot resolve manifest image: ' + reference.url)
    edits.push({
      ...reference.urlEdit,
      value: JSON.stringify(
        outputUrl(reference.url, selected.destination, document, base, siteOrigin, target.suffix),
      ),
    })
    if (reference.typeEdit) {
      const format = selected.format === 'jpg' ? 'jpeg' : selected.format
      const mime =
        format === 'svg' ? 'image/svg+xml' : format === 'ico' ? 'image/x-icon' : `image/${format}`
      edits.push({ ...reference.typeEdit, value: JSON.stringify(mime) })
    }
  }
  edits.sort((a, b) => b.start - a.start)
  for (const edit of edits) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end)
  return text
}
