import fs from 'node:fs/promises'
import path from 'node:path'

import { getImageDimensions } from '../processing/image-size.ts'
import { inspectCss } from '../references/css.ts'
import { inspectHtml } from '../references/html.ts'
import { DocumentJsonError } from '../references/json.ts'
import { inspectManifestImages } from '../references/manifest.ts'
import { locateOutputUrl } from '../references/resolve.ts'
import type { DocumentReferences } from '../references/types.ts'
import { sha256File, type Digest } from '../shared/digest.ts'
import { hasErrorCode } from '../shared/fs.ts'
import { imageFormat, type ImageFormat } from '../shared/image-format.ts'
import { assertLogicalName, containsPath } from '../shared/paths.ts'

export interface PublicationUsageReference {
  url: string
  usage: string
  mime?: string
}

export interface PublicationDocument {
  file: string
  url: string
  encoding?: string
  references?: readonly { url: string; destination?: string }[]
  /** The host reads framework-serialized metadata with its own runtime decoder. */
  usageReferences?: readonly PublicationUsageReference[]
}

export interface VerifyPublicationOptions {
  deleted?: readonly string[]
  deletionRules?: ReadonlyMap<string, readonly string[]>
  documents?: readonly PublicationDocument[]
  /** Digest and provenance supplied by the host's final publication record. */
  publishedImages?: readonly {
    destination: string
    digest: string
    owner?: string
    sourceDigest: string
    format: string
  }[]
}

export interface PublicationFile {
  digest: Digest
  url?: string
  owner?: string
  sourceDigest?: Digest
  format?: ImageFormat
}

const localOrigin = 'https://image-pipeline.invalid'

function imageMime(format: ImageFormat): string {
  if (format === 'svg') return 'image/svg+xml'
  if (format === 'ico') return 'image/x-icon'
  return 'image/' + format
}

function normalizedMime(value: string | undefined): string | undefined {
  const mime = value?.split(';')[0]?.trim().toLowerCase()
  return mime === 'image/vnd.microsoft.icon' ? 'image/x-icon' : mime
}

function resolveDocumentTarget(url: string, document: URL, baseHref?: string): string | undefined {
  try {
    return locateOutputUrl(url, document.pathname.slice(1), '/', document.origin, baseHref)?.file
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof URIError)) throw error
    return undefined
  }
}

function inspectManifest(text: string): DocumentReferences | undefined {
  try {
    return inspectManifestImages(text)
  } catch (error) {
    if (!(error instanceof DocumentJsonError)) throw error
    return undefined
  }
}

export async function verifyOutputFiles(
  directory: string,
  files: ReadonlyMap<string, PublicationFile>,
  options: VerifyPublicationOptions,
  protectedUsages: ReadonlySet<string>,
  warn: (message: string) => void,
): Promise<void> {
  const root = await fs.realpath(directory)
  const deleted = new Set(options.deleted)
  for (const file of deleted) assertLogicalName(file)
  const found = new Set<string>()
  const probed = new Map<string, string | undefined>()
  const unknownOwners = new Set<string>()

  async function resolvedFile(file: string): Promise<string> {
    assertLogicalName(file)
    const absolute = path.join(root, file)
    if (!containsPath(root, await fs.realpath(absolute)))
      throw new Error(`Published file resolves outside output: ${file}`)
    return absolute
  }

  async function verify(file: string, reference?: { url: string; from: string }): Promise<void> {
    if (found.has(file)) return
    const entry = files.get(file)
    if (!entry) throw new Error(`Unregistered publication: ${file}`)
    if (deleted.has(file)) {
      if (reference) {
        const rules = options.deletionRules?.get(file)
        const ruleDetail = rules?.length
          ? `; matched removeDistFiles.removeList: ${rules.map((rule) => JSON.stringify(rule)).join(', ')}`
          : ''
        throw new Error(
          `Reference points to a deleted publication: ${file} (URL ${reference.url} in ${reference.from})${ruleDetail}`,
        )
      }
      const exists = await fs.lstat(path.join(root, file)).catch((error: unknown) => {
        if (!hasErrorCode(error, 'ENOENT')) throw error
      })
      if (exists) throw new Error(`Publication declared deleted still exists: ${file}`)
      return
    }
    if ((await sha256File(await resolvedFile(file))) !== entry.digest)
      throw new Error(`Published file does not match its recorded bytes: ${file}`)
    found.add(file)
  }

  async function readDocument(document: PublicationDocument): Promise<string> {
    return new TextDecoder(document.encoding ?? 'utf-8', { fatal: true }).decode(
      await fs.readFile(await resolvedFile(document.file)),
    )
  }

  async function verifyKnownReferences(
    documentUrl: URL,
    from: string,
    references: DocumentReferences | undefined,
    baseHref?: string,
  ) {
    for (const reference of references?.references ?? []) {
      await verifyReference(
        documentUrl,
        from,
        {
          url: reference.url,
          usage: reference.usage,
          mime: reference.typeEdit?.value,
          readOnly: reference.readOnly,
        },
        baseHref,
      )
    }
  }

  async function verifyReference(
    documentUrl: URL,
    from: string,
    { url, usage, mime, readOnly }: PublicationUsageReference & { readOnly?: boolean },
    baseHref?: string,
  ) {
    const target = resolveDocumentTarget(url, documentUrl, baseHref)
    if (!target) return
    const entry = files.get(target)
    if (entry) await verify(target, { url, from })
    if (readOnly || !protectedUsages.has(usage)) return
    if (!entry?.owner) {
      if (!unknownOwners.has(target)) {
        unknownOwners.add(target)
        warn(`Cannot verify protected image ownership in ${from} (${usage}): ${url}`)
      }
      return
    }
    const source = imageFormat(entry.owner)
    if (!source) {
      if (!unknownOwners.has(target)) {
        unknownOwners.add(target)
        warn(`Cannot verify the source format of ${entry.owner} in ${from} (${usage}): ${url}`)
      }
      return
    }
    if (!probed.has(target)) {
      const dimensions = getImageDimensions(await fs.readFile(await resolvedFile(target)))
      probed.set(target, normalizedMime(dimensions.mime))
    }
    const expectedMime = imageMime(source)
    const actualMime = probed.get(target)
    if (
      (entry.format === undefined || entry.format === source) &&
      imageFormat(target) === source &&
      actualMime === expectedMime &&
      (mime === undefined || normalizedMime(mime) === actualMime)
    )
      return
    const expected = [...files].find(
      ([destination, candidate]) =>
        !deleted.has(destination) &&
        candidate.owner === entry.owner &&
        candidate.sourceDigest === entry.sourceDigest &&
        (candidate.format ?? imageFormat(destination)) === source,
    )
    const expectedUrl = expected
      ? (expected[1].url ?? '/' + expected[0])
      : 'original-format output was not generated'
    throw new Error(
      `Protected image format mismatch in ${from} (${usage}). Source: ${entry.owner}. ` +
        `Expected: ${expectedUrl} (${expectedMime}). Actual: ${url} (${actualMime ?? 'unknown format'}${mime === undefined ? '' : `, declared ${mime}`}).`,
    )
  }

  async function verifyDocument(document: PublicationDocument) {
    if (deleted.has(document.file)) return
    const extension = path.extname(document.file).toLowerCase()
    const documentUrl = new URL(document.url, localOrigin)
    for (const reference of document.usageReferences ?? [])
      await verifyReference(documentUrl, document.file, reference)
    if (!document.references && !['.html', '.css'].includes(extension)) return
    const text = await readDocument(document)
    if (!document.references) {
      const references = extension === '.html' ? inspectHtml(text, true) : inspectCss(text)
      await verifyKnownReferences(documentUrl, document.file, references, references.baseHref)
      for (const href of references?.manifests ?? []) {
        const file = resolveDocumentTarget(href, documentUrl, references.baseHref)
        if (!file || parsedManifests.has(file)) continue
        if (files.has(file)) await verify(file, { url: href, from: document.file })
        if (!['.json', '.webmanifest'].includes(path.extname(file).toLowerCase())) continue
        parsedManifests.add(file)
        const manifestUrl = new URL('/' + file, documentUrl)
        const manifest = await readDocument({
          file,
          url: manifestUrl.href,
          encoding: documents.get(file)?.encoding,
        }).catch((error: unknown) => {
          if (!hasErrorCode(error, 'ENOENT')) throw error
        })
        if (manifest !== undefined)
          await verifyKnownReferences(
            manifestUrl,
            `${file} (linked from ${document.file})`,
            inspectManifest(manifest),
          )
      }
      return
    }
    for (const reference of document.references) {
      if (!text.includes(reference.url) && !text.includes(reference.url.replace(/&/gu, '&amp;')))
        throw new Error(
          `Reference ${reference.url} was not found in the published document: ${document.file}`,
        )
      if (!reference.destination) continue
      const entry = files.get(reference.destination)
      const documentUrl = new URL(document.url, localOrigin)
      const actual = new URL(reference.url, documentUrl)
      const expected = new URL(entry?.url ?? '/' + reference.destination, documentUrl.origin)
      if (actual.pathname !== expected.pathname || actual.origin !== expected.origin)
        throw new Error(
          `Reference ${reference.url} does not resolve to ${reference.destination} in ${document.file}`,
        )
      await verify(reference.destination, { url: reference.url, from: document.file })
    }
  }

  for (const [file] of files) await verify(file)
  const documents = new Map(options.documents?.map((document) => [document.file, document]))
  const parsedManifests = new Set<string>()
  for (const document of options.documents ?? []) await verifyDocument(document)
  for (const document of options.documents ?? []) {
    if (
      document.references ||
      deleted.has(document.file) ||
      parsedManifests.has(document.file) ||
      path.extname(document.file).toLowerCase() !== '.webmanifest'
    )
      continue
    await verifyKnownReferences(
      new URL(document.url, localOrigin),
      document.file,
      inspectManifest(await readDocument(document)),
    )
  }
}
