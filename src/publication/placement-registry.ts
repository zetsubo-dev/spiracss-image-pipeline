import { sha256, type Digest } from '../shared/digest.ts'
import { imageFormat, type ImageFormat } from '../shared/image-format.ts'
import { assertLogicalName } from '../shared/paths.ts'
import { outputNameKey } from './output-name.ts'

export interface FixedCopy {
  file: string
  destination: string
}

export interface RecordedCopy extends FixedCopy {
  digest: Digest
}

export interface ResolvedImage {
  destination: string
  url: string
  format: ImageFormat
  sourceDigest: Digest
  outputDigest: Digest
  bytes: Buffer
  trialKeys: readonly Digest[]
}

export interface Publication {
  owner: string
  generated: boolean
  image: ResolvedImage
  used: boolean
}

interface Placement {
  destination: string
  owner: string
  digest: Digest
  sourceDigest?: Digest
  generated: boolean
}

interface Prefix {
  children: Map<string, Prefix>
  first?: Placement
  placement?: Placement
}

function prefix(): Prefix {
  return { children: new Map() }
}

function isSamePlacement(a: Placement, b: Placement): boolean {
  return (
    a.destination === b.destination &&
    a.owner === b.owner &&
    a.generated === b.generated &&
    a.digest === b.digest &&
    (a.sourceDigest ?? a.digest) === (b.sourceDigest ?? b.digest)
  )
}

export function validatePublishedImage<
  T extends Pick<ResolvedImage, 'destination' | 'bytes' | 'outputDigest'> & { format: unknown },
>(image: T): asserts image is T & { format: ImageFormat } {
  assertLogicalName(image.destination)
  const format = imageFormat(image.destination)
  if (!format || image.format !== format)
    throw new TypeError(`Publication format does not match its destination: ${image.destination}`)
  if (sha256(image.bytes) !== image.outputDigest)
    throw new Error(`Image output bytes changed: ${image.destination}`)
}

function collision(item: Placement, existing: Placement): Error {
  const remedy =
    !existing.generated || !item.generated
      ? 'Rename the fixed public asset or change the generated image directory.'
      : 'Change the logical placement.'
  return new Error(
    `Image publication collision at ${item.destination}: ${existing.owner} and ${item.owner}. ${remedy}`,
  )
}

function normalizedPath(destination: string, insensitive: boolean): string[] {
  return destination.split('/').map((part) => outputNameKey(part, insensitive))
}

function insert(root: Prefix, parts: readonly string[], item: Placement): boolean {
  let node = root
  const parents: Prefix[] = []
  for (const part of parts) {
    if (node.placement) throw collision(item, node.placement)
    parents.push(node)
    const next = node.children.get(part) ?? prefix()
    node.children.set(part, next)
    node = next
  }
  if (node.placement && isSamePlacement(item, node.placement)) return false
  if (node.first) throw collision(item, node.first)
  node.placement = item
  node.first = item
  for (const parent of parents) parent.first ??= item
  return true
}

function undoInsert(root: Prefix, parts: readonly string[]): void {
  let node = root
  const parents: { parent: Prefix; part: string }[] = []
  for (const part of parts) {
    parents.push({ parent: node, part })
    node = node.children.get(part)!
  }
  delete node.placement
  delete node.first
  // Transactions roll back in reverse order, so a representative remains valid
  // whenever an earlier placement still occupies the prefix.
  for (const { parent, part } of parents.reverse()) {
    parent.children.delete(part)
    if (parent.children.size) break
    delete parent.first
  }
}

export function createPlacementRegistry(initialCaseInsensitive: boolean) {
  const destinations = new Map<string, Placement>()
  let root = prefix()
  let caseInsensitiveOutputs = initialCaseInsensitive
  function reserve(item: Placement): string[] | undefined {
    assertLogicalName(item.destination)
    const parts = normalizedPath(item.destination, caseInsensitiveOutputs)
    if (!insert(root, parts, item)) return undefined
    destinations.set(item.destination, item)
    return parts
  }
  return {
    setCaseInsensitive(value: boolean): void {
      if (value === caseInsensitiveOutputs) return
      const next = prefix()
      for (const item of destinations.values())
        insert(next, normalizedPath(item.destination, value), item)
      root = next
      caseInsensitiveOutputs = value
    },
    reserve(item: Placement): void {
      reserve(item)
    },
    transaction(items: Iterable<Placement>): void {
      const inserted: { destination: string; parts: string[] }[] = []
      try {
        for (const item of items) {
          const parts = reserve(item)
          if (parts) inserted.push({ destination: item.destination, parts })
        }
      } catch (error) {
        for (const { destination, parts } of inserted.reverse()) {
          undoInsert(root, parts)
          destinations.delete(destination)
        }
        throw error
      }
    },
  }
}
