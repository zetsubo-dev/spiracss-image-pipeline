import { parse, type DefaultTreeAdapterTypes } from 'parse5'

import { DocumentJsonError, inspectJson } from './json.ts'
import type { DocumentReferences, Edit, OutputReference } from './types.ts'

type HtmlElement = DefaultTreeAdapterTypes.Element
function parseAttribute(element: HtmlElement, name: string): Edit | undefined {
  const location = element.sourceCodeLocation?.attrs?.[name]
  const value = element.attrs.find((attribute) => attribute.name === name)?.value
  if (!location || value === undefined) return
  return { start: location.startOffset, end: location.endOffset, value }
}

export function inspectHtml(text: string, verification = false): DocumentReferences {
  const references: OutputReference[] = []
  let unknown = false
  let baseHref: string | undefined
  const integrity: string[] = []
  const manifests: string[] = []
  const add = (element: HtmlElement, attribute: string, usage = 'body', typeAttribute?: string) => {
    const urlEdit = parseAttribute(element, attribute)
    if (!urlEdit) return
    const typeEdit = typeAttribute ? parseAttribute(element, typeAttribute) : undefined
    references.push({ url: urlEdit.value, usage, urlEdit, typeEdit })
  }
  const addSrcset = (element: HtmlElement) => {
    const attribute = parseAttribute(element, 'srcset')
    if (!attribute) return false
    const raw = text.slice(attribute.start, attribute.end)
    const match = /^[^=]+=[\t\n\f\r ]*(?:(["'])([\s\S]*)\1|([^\s"'`=<>]+))$/u.exec(raw)
    // Entities need a full HTML token-to-source mapping.
    const value = match?.[2] ?? match?.[3]
    if (value === undefined || value !== attribute.value || /[&]/u.test(value)) return false
    const valueStart = attribute.end - (match?.[1] ? 1 : 0) - value.length
    const entries: OutputReference[] = []
    const descriptors = new Set<string>()
    let kind = ''
    let offset = 0
    for (const part of value.split(',')) {
      const candidate =
        /^([\t\n\f\r ]*)([^\s,]+)(?:[\t\n\f\r ]+((?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)))?([\t\n\f\r ]*)$/u.exec(
          part,
        )
      if (!candidate || /^(?:data:|blob:)/iu.test(candidate[2]!)) return false
      const descriptor = candidate[3] ?? '1x'
      const nextKind = descriptor.slice(-1)
      if (
        (kind && kind !== nextKind) ||
        descriptors.has(descriptor) ||
        (nextKind === 'x' && Number.parseFloat(descriptor) <= 0)
      )
        return false
      kind = nextKind
      descriptors.add(descriptor)
      const start = valueStart + offset + candidate[1]!.length
      entries.push({
        url: candidate[2]!,
        usage: 'body',
        urlEdit: { start, end: start + candidate[2]!.length, value: candidate[2]! },
        syntax: 'srcset',
      })
      offset += part.length + 1
    }
    const group = { typeEdit: parseAttribute(element, 'type'), count: entries.length }
    for (const entry of entries) entry.group = group
    references.push(...entries)
    return true
  }
  let ogp: OutputReference[] | undefined
  let ogpType: Edit | undefined
  const commitOgp = () => {
    if (!ogp) return
    // Distinct secure and ordinary URLs require an explicit relationship from the host.
    if (!verification && ogp.some((entry) => entry.url !== ogp?.[0]!.url)) {
      unknown = true
    } else {
      ogp.forEach((entry, index) => {
        references.push(index === 0 || verification ? { ...entry, typeEdit: ogpType } : entry)
      })
    }
    ogp = undefined
    ogpType = undefined
  }
  function scanScript(node: HtmlElement, type: string | undefined) {
    if ((type ?? '').toLowerCase().split(';')[0]!.trim() === 'application/ld+json') {
      const start = node.sourceCodeLocation?.startTag?.endOffset
      const end = node.sourceCodeLocation?.endTag?.startOffset
      if (start === undefined || end === undefined) {
        unknown = true
        return
      }
      try {
        const result = inspectJson(text.slice(start, end), 'json-ld', start)
        references.push(...result.references)
        unknown ||= result.unknown
      } catch (error) {
        if (!(error instanceof DocumentJsonError)) throw error
        unknown = true
      }
    } else unknown = true
  }
  function scanLink(node: HtmlElement, attr: (key: string) => string | undefined) {
    const rel = (attr('rel') ?? '').toLowerCase().split(/\s+/u)
    if (attr('integrity')) {
      const href = attr('href')
      if (href) integrity.push(href)
      unknown = true
    } else if (rel.includes('icon')) add(node, 'href', 'favicon', 'type')
    else if (rel.includes('apple-touch-icon')) add(node, 'href', 'apple-touch-icon', 'type')
    else if (rel.includes('manifest')) {
      const href = attr('href')
      if (href) manifests.push(href)
      else unknown = true
    } else if (rel.includes('preload')) unknown = true
  }
  function scanMeta(node: HtmlElement, attr: (key: string) => string | undefined) {
    const property = (attr('property') ?? attr('name') ?? '').toLowerCase()
    if (property === 'og:image' || property === 'og:image:url') {
      commitOgp()
      const urlEdit = parseAttribute(node, 'content')
      if (urlEdit) ogp = [{ url: urlEdit.value, usage: 'ogp', urlEdit }]
    } else if (property === 'og:image:secure_url') {
      const urlEdit = parseAttribute(node, 'content')
      if (ogp && urlEdit) ogp.push({ url: urlEdit.value, usage: 'ogp', urlEdit })
      else if (verification && urlEdit) ogp = [{ url: urlEdit.value, usage: 'ogp', urlEdit }]
      else unknown = true
    } else if (property === 'og:image:type') {
      if (ogp) ogpType = parseAttribute(node, 'content')
      else unknown = true
    } else if (property === 'twitter:image' || property === 'twitter:image:src') {
      add(node, 'content', 'twitter')
    }
  }
  function scanUnknownAttributes(node: HtmlElement, attr: (key: string) => string | undefined) {
    if (
      (attr('srcset') !== undefined && node.tagName !== 'img' && node.tagName !== 'source') ||
      attr('style') ||
      node.attrs.some(
        ({ name, value }) =>
          name.startsWith('data-') &&
          /\.(?:png|jpe?g|svg|gif|webp|avif|ico)(?:[?#]|$)/iu.test(value),
      )
    )
      unknown = true
  }
  function scan(node: DefaultTreeAdapterTypes.Node) {
    if ('tagName' in node) {
      const attr = (key: string) => node.attrs.find((value) => value.name === key)?.value
      scanUnknownAttributes(node, attr)
      switch (node.tagName) {
        case 'base':
          baseHref ??= attr('href') || undefined
          break
        case 'script':
          scanScript(node, attr('type'))
          break
        case 'style':
        case 'template':
        case 'svg':
          unknown = true
          break
        case 'source':
          if (
            !('parentNode' in node) ||
            !node.parentNode ||
            !('tagName' in node.parentNode) ||
            node.parentNode.tagName !== 'picture' ||
            !addSrcset(node)
          )
            unknown = true
          break
        case 'img':
          if (attr('srcset') !== undefined && !addSrcset(node)) unknown = true
          add(node, 'src')
          break
        case 'video':
          add(node, 'poster')
          break
        case 'input':
          if (attr('type') === 'image') add(node, 'src')
          break
        case 'link':
          scanLink(node, attr)
          break
        case 'meta':
          scanMeta(node, attr)
          break
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(scan)
  }
  scan(parse(text, { sourceCodeLocationInfo: true }))
  commitOgp()
  return baseHref && !verification
    ? { references: [], unknown: true, integrity, baseHref }
    : { references, unknown, integrity, manifests, baseHref }
}

export function replacement(text: string, edit: Edit, value: string, css: boolean): string {
  if (css) return `url("${value.replace(/[\\"]/gu, '\\$&')}")`
  const source = text.slice(edit.start, edit.end)
  const equals = source.indexOf('=')
  const valueStart = /^\s*/u.exec(source.slice(equals + 1))?.[0].length ?? 0
  const start = equals + 1 + valueStart
  const delimiter = source[start]
  const quote = delimiter === '"' || delimiter === "'" ? delimiter : '"'
  const escaped = value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;')
  return source.slice(0, start) + quote + escaped + quote
}
