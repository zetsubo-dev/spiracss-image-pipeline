import ignore from 'ignore'
import micromatch from 'micromatch'

/** Family conversion has no codec; reject the selected entry instead of skipping it. */
export function assertImageOverrideFamily(sourceExtension: string, targetFormat: string): void {
  const source = sourceExtension.replace(/^\./u, '').toLowerCase()
  const target = targetFormat.replace(/^\./u, '').toLowerCase()
  if ((source === 'svg') !== (target === 'svg'))
    throw new Error(`Unsupported image override family: ${source} → ${target}`)
}

/** Adapters supply one normalized output-relative policy coordinate. */
export function createImageDistIgnoreMatcher(
  patterns: readonly string[],
): (relative: string) => boolean {
  if (patterns.length === 0) return () => false
  const matcher = ignore().add([...patterns])
  return (relative) => relative.length > 0 && matcher.ignores(relative)
}

/** Select the first matching configuration entry in declaration order. */
export function resolveImageOverride<T extends { match: string | RegExp }>(
  overrides: readonly T[],
  candidates: readonly string[],
): T | undefined {
  return overrides.find(({ match }) =>
    candidates.some((candidate) => {
      if (typeof match === 'string') return micromatch.isMatch(candidate, match)
      const previousIndex = match.lastIndex
      try {
        match.lastIndex = 0
        return match.test(candidate)
      } finally {
        match.lastIndex = previousIndex
      }
    }),
  )
}

/** Format-only decision shared by recipes and processors; policy and size stay outside. */
export function resolveAutomaticImageFormat(
  sourceFormat: string,
  outputFormat: 'avif' | 'webp' | false,
): 'webp' | 'avif' | null {
  const extension = sourceFormat.replace(/^\./u, '').toLowerCase()
  const source = extension === 'jpg' ? 'jpeg' : extension
  if (
    !outputFormat ||
    !['png', 'jpeg', 'gif', 'webp', 'avif'].includes(source) ||
    outputFormat === source ||
    (source === 'gif' && outputFormat === 'avif')
  )
    return null
  return outputFormat
}
