import fs from 'node:fs/promises'
import path from 'node:path'

import { isDigest, type Digest } from '../shared/digest.ts'
import { writeAtomic } from '../shared/fs.ts'
import {
  validatePublishedImage,
  type Publication,
  type RecordedCopy,
} from './placement-registry.ts'

export async function writeCheckpoint(
  root: string,
  file: string,
  publications: Iterable<Publication>,
  fixedCopies: Iterable<RecordedCopy>,
): Promise<void> {
  const entries = [...publications].map(({ image, ...entry }) => ({
    ...entry,
    image: { ...image, bytes: image.bytes.toString('base64') },
  }))
  await writeAtomic(
    path.resolve(root, file),
    JSON.stringify({ version: 1, root, entries, copies: [...fixedCopies] }) + '\n',
  )
}

export async function readCheckpoint(
  root: string,
  file: string,
): Promise<{
  entries: Map<string, Publication>
  copies: RecordedCopy[]
}> {
  const checkpoint = path.resolve(root, file)
  const value: unknown = JSON.parse(await fs.readFile(checkpoint, 'utf8'))
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('root' in value) ||
    value.root !== root ||
    !('entries' in value) ||
    !Array.isArray(value.entries)
  )
    throw new Error(`Invalid image checkpoint: ${checkpoint}`)
  return {
    entries: parseCheckpointEntries(value.entries, checkpoint),
    copies: parseCheckpointCopies(value, checkpoint),
  }
}

function validateImageFields(
  image: object,
  checkpoint: string,
): asserts image is {
  destination: string
  url: string
  bytes: string
  sourceDigest: Digest
  outputDigest: Digest
  trialKeys: Digest[]
} {
  if (
    !('destination' in image) ||
    typeof image.destination !== 'string' ||
    !('url' in image) ||
    typeof image.url !== 'string' ||
    !('bytes' in image) ||
    typeof image.bytes !== 'string' ||
    !('sourceDigest' in image) ||
    !isDigest(image.sourceDigest) ||
    !('outputDigest' in image) ||
    !isDigest(image.outputDigest) ||
    !('trialKeys' in image) ||
    !Array.isArray(image.trialKeys) ||
    !image.trialKeys.every(isDigest)
  )
    throw new Error(`Invalid image checkpoint entry: ${checkpoint}`)
}

function parseCheckpointEntries(entries: unknown[], checkpoint: string): Map<string, Publication> {
  const supplied = new Map<string, Publication>()
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('owner' in entry) ||
      typeof entry.owner !== 'string' ||
      !('generated' in entry) ||
      typeof entry.generated !== 'boolean' ||
      !('used' in entry) ||
      typeof entry.used !== 'boolean' ||
      !('image' in entry) ||
      !entry.image ||
      typeof entry.image !== 'object'
    )
      throw new Error(`Invalid image checkpoint entry: ${checkpoint}`)
    validateImageFields(entry.image, checkpoint)
    const { destination, url, sourceDigest, outputDigest, trialKeys } = entry.image
    const bytes = Buffer.from(entry.image.bytes, 'base64')
    const image = {
      destination,
      url,
      sourceDigest,
      outputDigest,
      trialKeys,
      bytes,
      format: 'format' in entry.image ? entry.image.format : undefined,
    }
    if (supplied.has(destination))
      throw new Error(`Invalid image checkpoint output: ${destination}`)
    try {
      validatePublishedImage(image)
    } catch (cause) {
      throw new Error(`Invalid image checkpoint output: ${destination}`, { cause })
    }
    supplied.set(destination, {
      owner: entry.owner,
      generated: entry.generated,
      used: entry.used,
      image,
    })
  }
  return supplied
}

function parseCheckpointCopies(checkpointData: object, checkpoint: string): RecordedCopy[] {
  const copies: RecordedCopy[] = []
  if ('copies' in checkpointData) {
    const { copies: value } = checkpointData
    if (!Array.isArray(value)) throw new Error(`Invalid fixed copies: ${checkpoint}`)
    for (const copy of value) {
      if (
        !copy ||
        typeof copy.file !== 'string' ||
        typeof copy.destination !== 'string' ||
        !isDigest(copy.digest)
      )
        throw new Error(`Invalid fixed copy in image checkpoint: ${checkpoint}`)
      copies.push({ file: copy.file, destination: copy.destination, digest: copy.digest })
    }
  }
  return copies
}
