import type { DocumentReferences, Edit, OutputReference } from './types.ts'

type Node =
  | { kind: 'string'; value: string; edit: Edit }
  | { kind: 'object'; fields: Map<string, Node> }
  | { kind: 'array'; items: Node[] }
  | { kind: 'other' }

type DocumentJsonErrorCode = 'JSON_SYNTAX' | 'JSON_DUPLICATE_KEY'

export class DocumentJsonError extends SyntaxError {
  override readonly name = 'DocumentJsonError'
  readonly code: DocumentJsonErrorCode

  constructor(code: DocumentJsonErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

function parseJson(text: string, offset: number): Node {
  try {
    JSON.parse(text)
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause
    throw new DocumentJsonError('JSON_SYNTAX', cause.message, { cause })
  }
  let pos = 0
  const space = () => {
    while (/\s/u.test(text[pos] ?? '') && pos < text.length) pos++
  }
  const string = (): Extract<Node, { kind: 'string' }> => {
    const start = pos++
    while (pos < text.length) {
      if (text[pos++] === '\\') pos++
      else if (text[pos - 1] === '"') break
    }
    const value: string = JSON.parse(text.slice(start, pos))
    return { kind: 'string', value, edit: { start: offset + start, end: offset + pos, value } }
  }
  const value = (): Node => {
    space()
    if (text[pos] === '"') return string()
    if (text[pos] === '{') {
      pos++
      space()
      const fields = new Map<string, Node>()
      while (text[pos] !== '}') {
        const key = string().value
        space()
        pos++
        const entry = value()
        if (fields.has(key))
          throw new DocumentJsonError(
            'JSON_DUPLICATE_KEY',
            `Duplicate JSON key: ${JSON.stringify(key)}`,
          )
        fields.set(key, entry)
        space()
        if (text[pos] !== ',') break
        pos++
        space()
      }
      pos++
      return { kind: 'object', fields }
    }
    if (text[pos] === '[') {
      pos++
      space()
      const items: Node[] = []
      while (text[pos] !== ']') {
        items.push(value())
        space()
        if (text[pos] !== ',') break
        pos++
      }
      pos++
      return { kind: 'array', items }
    }
    while (pos < text.length && !/[\s,\]}]/u.test(text[pos]!)) pos++
    return { kind: 'other' }
  }
  return value()
}

export function inspectJson(
  text: string,
  mode: 'manifest' | 'json-ld',
  offset = 0,
): DocumentReferences {
  const root = parseJson(text, offset)
  const references: OutputReference[] = []
  let unknown = false
  const add = (node: Node | undefined, usage: string, type?: Node, readOnly = false) => {
    if (!node || node.kind !== 'string') {
      unknown = true
      return
    }
    references.push({
      url: node.value,
      usage,
      urlEdit: node.edit,
      syntax: 'json',
      readOnly,
      typeEdit: type?.kind === 'string' ? type.edit : undefined,
    })
    if (type && type.kind !== 'string') unknown = true
  }
  const icons = (node: Node | undefined, readOnly = false) => {
    if (!node) return
    if (node.kind !== 'array') {
      unknown = true
      return
    }
    for (const item of node.items) {
      if (item.kind !== 'object') {
        unknown = true
        continue
      }
      add(item.fields.get('src'), 'manifest-icon', item.fields.get('type'), readOnly)
    }
  }
  const localized = (node: Node | undefined) => {
    if (!node) return
    if (node.kind !== 'object') {
      unknown = true
      return
    }
    for (const entry of node.fields.values()) icons(entry)
  }
  if (mode === 'manifest') {
    if (root.kind !== 'object') return { references, unknown: true }
    icons(root.fields.get('icons'))
    localized(root.fields.get('icons_localized'))
    icons(root.fields.get('screenshots'), true)
    const shortcuts = root.fields.get('shortcuts')
    if (shortcuts?.kind === 'array')
      for (const item of shortcuts.items) {
        if (item.kind !== 'object') {
          unknown = true
          continue
        }
        icons(item.fields.get('icons'))
        localized(item.fields.get('icons_localized'))
      }
    else if (shortcuts) unknown = true
  } else {
    const visit = (node: Node, image = false) => {
      if (node.kind === 'string') {
        if (image) add(node, 'json-ld')
        else if (/\.(?:png|jpe?g|svg|gif|webp|avif|ico)(?:[?#]|$)/iu.test(node.value))
          unknown = true
        return
      }
      if (node.kind === 'array') {
        node.items.forEach((item) => visit(item, image))
        return
      }
      if (node.kind !== 'object') {
        if (image) unknown = true
        return
      }
      for (const [key, entry] of node.fields) {
        const field = key.toLowerCase()
        visit(
          entry,
          ['image', 'logo', 'thumbnailurl', 'contenturl'].includes(field) ||
            (image && (field === 'url' || field === '@id')),
        )
      }
    }
    visit(root)
  }
  return { references, unknown }
}
