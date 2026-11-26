import { caseFoldingData } from './case-folding-data.ts'

const folds = new Map(
  caseFoldingData
    .trim()
    .split(/\s+/u)
    .map((row) => {
      const separator = row.indexOf(':')
      const source = Number.parseInt(row.slice(0, separator), 16)
      const target = row
        .slice(separator + 1)
        .split(',')
        .map((code) => Number.parseInt(code, 16))
      return [source, String.fromCodePoint(...target)] as const
    }),
)

export function outputNameKey(name: string, caseInsensitive: boolean): string {
  const decomposed = name.normalize('NFD')
  if (!caseInsensitive) return decomposed
  // Unicode canonical caseless matching (D145).
  return Array.from(decomposed, (character) => folds.get(character.codePointAt(0)!) ?? character)
    .join('')
    .normalize('NFD')
}
