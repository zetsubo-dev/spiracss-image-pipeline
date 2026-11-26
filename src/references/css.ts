import { parse as parseCss, walk as walkCss } from 'css-tree'

import type { DocumentReferences, OutputReference } from './types.ts'

export function inspectCss(text: string): DocumentReferences {
  const references: OutputReference[] = []
  let unknown = false
  const ast = parseCss(text, {
    positions: true,
    onParseError: () => {
      unknown = true
    },
  })
  walkCss(ast, (node) => {
    if (node.type === 'Function' && node.name.toLowerCase().includes('image-set')) unknown = true
    if (node.type !== 'Url' || !node.loc) return
    references.push({
      url: node.value,
      usage: 'body',
      urlEdit: { start: node.loc.start.offset, end: node.loc.end.offset, value: node.value },
    })
  })
  return { references, unknown }
}
