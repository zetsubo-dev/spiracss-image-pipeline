export interface Edit {
  start: number
  end: number
  value: string
}

export interface OutputReference {
  url: string
  usage: string
  urlEdit: Edit
  typeEdit?: Edit
  syntax?: 'json' | 'srcset'
  group?: { typeEdit?: Edit; count: number }
  readOnly?: boolean
}

export interface DocumentReferences {
  references: OutputReference[]
  unknown: boolean
  integrity?: string[]
  manifests?: string[]
  baseHref?: string
}
