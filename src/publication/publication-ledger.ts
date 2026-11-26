import path from 'node:path'

import { isDigest, sha256File } from '../shared/digest.ts'
import { imageFormat } from '../shared/image-format.ts'
import { assertLogicalName } from '../shared/paths.ts'
import { readCheckpoint, writeCheckpoint } from './checkpoint.ts'
import {
  validatePublishedImage,
  type createPlacementRegistry,
  type FixedCopy,
  type Publication,
  type RecordedCopy,
  type ResolvedImage,
} from './placement-registry.ts'
import type { PublicationFile, VerifyPublicationOptions } from './verify.ts'

export function createPublicationLedger(
  root: string,
  registry: ReturnType<typeof createPlacementRegistry>,
  verifyStoragePaths: () => Promise<void>,
) {
  const fixedCopies = new Map<string, RecordedCopy>()
  const publications = new Map<string, Publication>()
  let fixedPlacementsDeclared = false
  function recordOutput(
    owner: string,
    generated: boolean,
    image: ResolvedImage,
    used: boolean,
  ): void {
    if (generated && !fixedPlacementsDeclared)
      throw new Error('Declare fixed image placements before publishing generated images')
    validatePublishedImage(image)
    registry.reserve({
      destination: image.destination,
      owner,
      digest: image.outputDigest,
      sourceDigest: image.sourceDigest,
      generated,
    })
    const previous = publications.get(image.destination)
    if (previous) previous.used ||= used
    else
      publications.set(image.destination, {
        owner,
        generated,
        image: { ...image, bytes: Buffer.from(image.bytes), trialKeys: [...image.trialKeys] },
        used,
      })
  }
  return {
    getPublications(): readonly Publication[] {
      return [...publications.values()].map((entry) => ({
        ...entry,
        image: {
          ...entry.image,
          bytes: Buffer.from(entry.image.bytes),
          trialKeys: [...entry.image.trialKeys],
        },
      }))
    },
    async registerFixedCopies(copies: readonly FixedCopy[]): Promise<void> {
      await verifyStoragePaths()
      const entries: RecordedCopy[] = []
      for (const { file, destination } of copies) {
        assertLogicalName(destination)
        const absolute = path.resolve(root, file)
        entries.push({ file: absolute, destination, digest: await sha256File(absolute) })
      }
      registry.transaction(entries.map((copy) => ({ ...copy, owner: copy.file, generated: false })))
      for (const copy of entries) fixedCopies.set(copy.destination, copy)
      fixedPlacementsDeclared = true
    },
    getPublishedDestinations(): string[] {
      const used = [...publications.values()].filter((entry) => entry.used)
      return [...new Set([...fixedCopies.keys(), ...used.map((entry) => entry.image.destination)])]
    },
    recordOutput(owner: string, generated: boolean, image: ResolvedImage, used: boolean): void {
      recordOutput(owner, generated, image, used)
    },
    getUnusedOutputs(): string[] {
      return [...publications.values()]
        .filter((entry) => entry.generated && !entry.used)
        .map((entry) => entry.image.destination)
    },
    async checkpoint(file: string): Promise<void> {
      await writeCheckpoint(root, file, publications.values(), fixedCopies.values())
    },
    async resume(file: string): Promise<void> {
      if (publications.size || fixedCopies.size)
        throw new Error('Resume the image checkpoint before recording new outputs')
      await verifyStoragePaths()
      const { entries, copies } = await readCheckpoint(root, file)
      if (publications.size || fixedCopies.size)
        throw new Error('Resume the image checkpoint before recording new outputs')
      registry.transaction([
        ...copies.map((copy) => ({ ...copy, owner: copy.file, generated: false })),
        ...[...entries].map(([destination, entry]) => ({
          destination,
          owner: entry.owner,
          digest: entry.image.outputDigest,
          sourceDigest: entry.image.sourceDigest,
          generated: entry.generated,
        })),
      ])
      for (const copy of copies) fixedCopies.set(copy.destination, copy)
      for (const [destination, entry] of entries) publications.set(destination, entry)
      fixedPlacementsDeclared = true
    },
    requiredFiles(declaration: VerifyPublicationOptions): Map<string, PublicationFile> {
      const required = new Map<string, PublicationFile>()
      for (const copy of fixedCopies.values())
        required.set(copy.destination, { digest: copy.digest, owner: copy.file })
      for (const entry of publications.values()) {
        if (
          entry.used ||
          declaration.documents?.some((document) =>
            document.references?.some(({ destination }) => destination === entry.image.destination),
          )
        )
          required.set(entry.image.destination, {
            digest: entry.image.outputDigest,
            url: entry.image.url,
            owner: entry.owner,
            sourceDigest: entry.image.sourceDigest,
            format: entry.image.format,
          })
      }
      for (const {
        destination,
        digest,
        owner,
        sourceDigest,
        format,
      } of declaration.publishedImages ?? []) {
        assertLogicalName(destination)
        const actualFormat = imageFormat('image.' + format)
        if (!isDigest(digest) || !isDigest(sourceDigest) || !actualFormat)
          throw new TypeError(`Invalid host image publication: ${destination}`)
        const previous = required.get(destination)
        if (previous && previous.digest !== digest)
          throw new Error(`Host image publication differs from the recorded output: ${destination}`)
        if (!previous)
          required.set(destination, { digest, owner, sourceDigest, format: actualFormat })
      }
      return required
    },
  }
}
