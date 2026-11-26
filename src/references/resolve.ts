import path from 'node:path'

import { imageFormat } from '../shared/image-format.ts'

type OutputUrlResolution =
  | { kind: 'local'; file: string; suffix: string }
  | { kind: 'external' }
  | { kind: 'unresolvable' }

export function classifyOutputUrl(
  url: string,
  document: string,
  base: string,
  siteOrigin?: string,
  baseHref?: string,
): OutputUrlResolution {
  if (!url.trim()) return { kind: 'unresolvable' }
  if (/^(?:#|data:|blob:)/iu.test(url)) return { kind: 'external' }
  if (!siteOrigin && /^(?:\/\/|[A-Za-z][A-Za-z0-9+.-]*:)/u.test(url)) return { kind: 'external' }
  const origin = siteOrigin ?? 'https://image-pipeline.invalid'
  try {
    const documentUrl = new URL(base + document, origin)
    const reference = new URL(url, baseHref ? new URL(baseHref, documentUrl) : documentUrl)
    if (reference.origin !== origin) return { kind: 'external' }
    if (!reference.pathname.startsWith(base) || /%(?![0-9a-f]{2})/iu.test(url))
      return { kind: 'unresolvable' }
    const parts = reference.pathname.slice(base.length).split('/').map(decodeURIComponent)
    if (
      parts.some(
        (part) =>
          !part || part === '.' || part === '..' || /[/\\:]/u.test(part) || part.includes('\0'),
      )
    )
      return { kind: 'unresolvable' }
    const file = parts.join('/')
    return { kind: 'local', file, suffix: reference.search + reference.hash }
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof URIError)) throw error
    return { kind: 'unresolvable' }
  }
}

export function locateOutputUrl(
  url: string,
  document: string,
  base: string,
  siteOrigin?: string,
  baseHref?: string,
): { file: string; suffix: string } | undefined {
  const resolution = classifyOutputUrl(url, document, base, siteOrigin, baseHref)
  if (resolution.kind === 'local') return { file: resolution.file, suffix: resolution.suffix }
  return undefined
}

export function resolveReference(
  url: string,
  document: string,
  base: string,
  siteOrigin?: string,
  baseHref?: string,
): { file: string; suffix: string } | undefined {
  const target = locateOutputUrl(url, document, base, siteOrigin, baseHref)
  return target && imageFormat(target.file) ? target : undefined
}

export function outputUrl(
  oldUrl: string,
  next: string,
  document: string,
  base: string,
  siteOrigin: string | undefined,
  suffix: string,
): string {
  const encode = (name: string) => name.split('/').map(encodeURIComponent).join('/')
  if (oldUrl.startsWith('//') && siteOrigin)
    return new URL(base + encode(next), siteOrigin).href.replace(/^https?:/iu, '') + suffix
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(oldUrl) && siteOrigin)
    return new URL(base + encode(next), siteOrigin).href + suffix
  if (oldUrl.startsWith('/')) return base + encode(next) + suffix
  return encode(path.posix.relative(path.posix.dirname(document), next)) + suffix
}
