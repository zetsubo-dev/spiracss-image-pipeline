import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export type Digest = string & { readonly __brand: 'SHA-256' }

export function isDigest(value: unknown): value is Digest {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

export function sha256(bytes: Uint8Array | string): Digest {
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (!isDigest(hash)) throw new Error('Expected a SHA-256 digest')
  return hash
}

export async function sha256File(file: string): Promise<Digest> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary image data: ' + file)
    hash.update(chunk)
  }
  const digest = hash.digest('hex')
  if (!isDigest(digest)) throw new Error('Expected a SHA-256 digest')
  return digest
}

export function imageNameHash(input: Digest, output: Digest): Digest {
  return sha256(
    Buffer.concat([
      Buffer.from('image-name-v1\0', 'ascii'),
      Buffer.from(input, 'hex'),
      Buffer.from(output, 'hex'),
    ]),
  )
}
