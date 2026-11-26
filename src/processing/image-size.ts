import { readFileSync } from 'node:fs'

import probeImageSize from 'probe-image-size'

export function getImageDimensions(bytes: Uint8Array): {
  width: number
  height: number
  mime?: string
} {
  try {
    const dims = probeImageSize.sync(Buffer.from(bytes))
    if (dims && typeof dims.width === 'number' && typeof dims.height === 'number') {
      return { width: Math.max(0, dims.width), height: Math.max(0, dims.height), mime: dims.mime }
    }
  } catch {}
  return { width: 0, height: 0 }
}

export function getImageSize(absPath: string): { width: number; height: number; mime?: string } {
  try {
    return getImageDimensions(readFileSync(absPath))
  } catch {
    return { width: 0, height: 0 }
  }
}
