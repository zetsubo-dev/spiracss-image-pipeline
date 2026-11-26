import path from 'node:path'

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'svg' | 'ico'
export function imageFormat(file: string): ImageFormat | undefined {
  const format = path.posix.extname(file).slice(1).toLowerCase()
  if (format === 'jpg') return 'jpeg'
  if (
    format === 'png' ||
    format === 'jpeg' ||
    format === 'gif' ||
    format === 'webp' ||
    format === 'avif' ||
    format === 'svg' ||
    format === 'ico'
  )
    return format
  return undefined
}
