import fs from 'node:fs/promises'

import sharp from 'sharp'

import { normalizeBitmapOptions } from './bitmap-options.ts'

type SharpInstance = ReturnType<typeof sharp>

export type BitmapFormat = 'png' | 'jpeg' | 'jpg' | 'gif' | 'webp' | 'avif'

type BitmapFormatOptions = {
  png: Parameters<SharpInstance['png']>[0]
  jpeg: Parameters<SharpInstance['jpeg']>[0]
  jpg: Parameters<SharpInstance['jpeg']>[0]
  gif: Parameters<SharpInstance['gif']>[0]
  webp: Parameters<SharpInstance['webp']>[0]
  avif: Parameters<SharpInstance['avif']>[0]
}

export async function encodeBitmap(
  input: string | Buffer,
  format: BitmapFormat,
  options?: object,
): Promise<Buffer> {
  await assertBitmapEncodingSupported(input, format)
  return await encodeBitmapPass(input, format, options)
}

/** Explicit encoding must reject inputs whose complete animation cannot be decoded. */
export async function assertBitmapEncodingSupported(
  input: string | Buffer,
  format: BitmapFormat,
): Promise<void> {
  const bytes = typeof input === 'string' ? await fs.readFile(input) : input
  if (
    (await hasUndecodableBitmapAnimation(bytes)) ||
    (format !== 'gif' && format !== 'webp' && (await hasBitmapAnimation(bytes)))
  )
    throw new Error(`Animated bitmap cannot be encoded as ${format} without dropping frames`)
}

async function encodeBitmapPass(
  input: string | Buffer,
  format: BitmapFormat,
  options?: object,
): Promise<Buffer> {
  options = normalizeBitmapOptions(options ?? {})
  let pipeline = sharp(input, { animated: true }).withMetadata()
  switch (format) {
    case 'png':
      pipeline = pipeline.png(options as BitmapFormatOptions['png'])
      break
    case 'jpeg':
    case 'jpg':
      pipeline = pipeline.jpeg(options as BitmapFormatOptions['jpeg'])
      break
    case 'gif':
      pipeline = pipeline.gif(options as BitmapFormatOptions['gif'])
      break
    case 'avif':
      pipeline = pipeline.avif(options as BitmapFormatOptions['avif'])
      break
    case 'webp':
      pipeline = pipeline.webp(options as BitmapFormatOptions['webp'])
      break
  }
  return await pipeline.toBuffer()
}

/** Encode the original input once, adopting only a smaller result. */
export async function optimizeBitmapBuffer(
  input: Buffer,
  format: BitmapFormat,
  options?: object,
): Promise<Buffer> {
  // Automatic minify retains animations whose complete frames cannot be encoded.
  if (
    (await hasUndecodableBitmapAnimation(input)) ||
    (format === 'avif' && (await hasBitmapAnimation(input)))
  )
    return input
  const encoded = await encodeBitmapPass(input, format, options)
  return encoded.length < input.length ? encoded : input
}

export async function hasBitmapAnimation(input: string | Buffer): Promise<boolean> {
  return (
    (await hasUndecodableBitmapAnimation(input)) ||
    ((await sharp(input, { animated: true }).metadata()).pages ?? 1) > 1
  )
}

/** Container facts cover animations hidden by the current decoder's single-page metadata. */
export async function hasUndecodableBitmapAnimation(input: string | Buffer): Promise<boolean> {
  const bytes = typeof input === 'string' ? await fs.readFile(input) : input
  return isApng(bytes) || isAvifSequence(bytes)
}

function isApng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) return false
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'acTL') return length === 8 && bytes.readUInt32BE(offset + 8) > 1
    if (type === 'IEND') return false
    offset = end
  }
  return false
}

// libvips cannot decode AVIF track sequences; inspect their container before decoding.
function isAvifSequence(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp') return false
  const end = bytes.readUInt32BE(0)
  if (end < 16 || end > bytes.length) return false
  if (bytes.toString('ascii', 8, 12) === 'avis') return true
  for (let offset = 16; offset + 4 <= end; offset += 4)
    if (bytes.toString('ascii', offset, offset + 4) === 'avis') return true
  return false
}
