import fs from 'node:fs/promises'
import path from 'node:path'

import type { ImageBuildOptions } from '../build/options.ts'
import { resolvePlannedPath } from '../publication/output-paths.ts'
import type { FixedCopy } from '../publication/placement-registry.ts'
import { inspectCss } from '../references/css.ts'
import { inspectHtml } from '../references/html.ts'
import { inspectManifestImages } from '../references/manifest.ts'
import { classifyOutputUrl, locateOutputUrl, resolveReference } from '../references/resolve.ts'
import type { OutputReference } from '../references/types.ts'
import { sha256 } from '../shared/digest.ts'
import { listFiles, readIfPresent } from '../shared/fs.ts'
import { assertLogicalName, containsPath, logicalRelative } from '../shared/paths.ts'
import { parseOutputRecords, type OutputRecord } from './records.ts'

export interface ProcessOutputOptions extends ImageBuildOptions {
  outputDir: string
  stateDir?: string
  /** An explicit empty array declares that there are no fixed copies. */
  publicCopies: readonly { source: string; destination: string }[]
  editableDocuments: readonly string[]
  /** Declare all references and generated image owners to allow same-path replacements. */
  inventory?: {
    completeReferences: boolean
    generatedImages: readonly { output: string; logicalName: string }[]
  }
  base?: string
  siteOrigin?: string
}

export type RetainedOutput = { file: string; reason: string }

interface OutputDocument {
  name: string
  file: string
  css: boolean
  text: string
  entries: OutputReference[]
  editable: boolean
}

type OutputDestination = (name: string) => Promise<string>

export const outputLockName = '.image-pipeline-output.lock'
const decodeUtf8 = new TextDecoder('utf8', { fatal: true, ignoreBOM: true })
function wouldOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left)
}

function isOwnLockPath(name: string): boolean {
  return (
    name === outputLockName ||
    name === outputLockName + '.gate' ||
    (name.startsWith(outputLockName + '.gate.') && /\.(?:release|stale)$/u.test(name))
  )
}

function inspectDocument(text: string, css: boolean) {
  const declared = css
    ? /^\uFEFF?@charset\s+['"]([^'"]+)/iu.exec(text)?.[1]
    : /<meta\b[^>]*?\bcharset\s*=\s*["']?([^\s"'/>]+)/iu.exec(text)?.[1]
  if (declared && !/^utf-?8$/iu.test(declared))
    throw new Error(`Unsupported document encoding: ${declared}`)
  return css ? inspectCss(text) : inspectHtml(text)
}

async function discoverFixedCopies(
  copies: ProcessOutputOptions['publicCopies'],
  projectRoot: string,
  destination: OutputDestination,
) {
  const fixed = new Set<string>()
  const fixedCopies: FixedCopy[] = []
  for (const copy of copies) {
    const source = path.resolve(projectRoot, copy.source)
    const isDirectory = (await fs.stat(source)).isDirectory()
    for await (const input of isDirectory ? listFiles(source) : [source]) {
      const output = isDirectory
        ? path.posix.join(copy.destination, logicalRelative(source, input))
        : copy.destination
      const bytes = await fs.readFile(await destination(output))
      if (!bytes.equals(await fs.readFile(input)))
        throw new Error(`Fixed public copy has different bytes: ${input} → ${output}`)
      fixed.add(output)
      fixedCopies.push({ file: input, destination: output })
    }
  }
  return { fixed, fixedCopies }
}

async function discoverLinkedManifests(
  outputDocuments: ReadonlySet<string>,
  destination: OutputDestination,
  base: string,
  siteOrigin: string | undefined,
) {
  let unknown = false
  const linkedManifests = new Set<string>()
  const htmlDocuments = new Map<string, { text: string; parsed: ReturnType<typeof inspectHtml> }>()
  for (const name of outputDocuments) {
    if (!/\.html?$/iu.test(name)) continue
    try {
      const text = decodeUtf8.decode(await fs.readFile(await destination(name)))
      const parsed = inspectDocument(text, false)
      htmlDocuments.set(name, { text, parsed })
      for (const url of parsed.manifests ?? []) {
        const target = classifyOutputUrl(url, name, base, siteOrigin)
        if (target.kind === 'local') linkedManifests.add(target.file)
        if (target.kind === 'unresolvable') unknown = true
      }
    } catch {
      unknown = true
    }
  }
  return { linkedManifests, htmlDocuments, unknown }
}

async function discoverDocuments(
  options: ProcessOutputOptions,
  outputRoot: string,
  destination: OutputDestination,
  fixed: ReadonlySet<string>,
  base: string,
  siteOrigin: string | undefined,
  retained: RetainedOutput[],
) {
  const editable = new Set(options.editableDocuments)
  const documents: OutputDocument[] = []
  let unknown = !options.inventory?.completeReferences
  const integrityFiles = new Set<string>()
  let unknownIntegrity = false
  const outputDocuments = new Set<string>()
  for await (const file of listFiles(outputRoot, (file) =>
    isOwnLockPath(logicalRelative(outputRoot, file)),
  )) {
    const name = logicalRelative(outputRoot, file)
    if (/\.(?:html?|css|json|[mc]?js|xml|webmanifest)$/iu.test(name)) outputDocuments.add(name)
  }
  const html = await discoverLinkedManifests(outputDocuments, destination, base, siteOrigin)
  unknown ||= html.unknown
  const { htmlDocuments, linkedManifests } = html
  for (const name of new Set([...outputDocuments, ...editable])) {
    const file = await destination(name)
    const css = path.extname(name).toLowerCase() === '.css'
    try {
      const manifest =
        /\.webmanifest$/iu.test(name) || (/\.json$/iu.test(name) && linkedManifests.has(name))
      if (!css && !manifest && !/\.html?$/iu.test(name))
        throw new Error('Unsupported editable document type')
      const cached = htmlDocuments.get(name)
      const text = cached?.text ?? decodeUtf8.decode(await fs.readFile(file))
      const parsed =
        cached?.parsed ?? (manifest ? inspectManifestImages(text) : inspectDocument(text, css))
      const canEdit = editable.has(name) && !fixed.has(name)
      documents.push({ name, file, css, text, entries: parsed.references, editable: canEdit })
      unknown ||= parsed.unknown
      for (const url of parsed.integrity ?? []) {
        try {
          const protectedAsset = locateOutputUrl(url, name, base, siteOrigin, parsed.baseHref)
          if (protectedAsset) integrityFiles.add(protectedAsset.file)
          else if (!siteOrigin || parsed.baseHref) unknownIntegrity = true
        } catch {
          unknownIntegrity = true
        }
      }
    } catch (error) {
      unknown = true
      retained.push({ file: name, reason: String(error) })
    }
  }
  return { documents, unknown, integrityFiles, unknownIntegrity }
}

function discoverTargets(
  {
    documents,
    unknown: initialUnknown,
    integrityFiles,
    unknownIntegrity,
  }: Awaited<ReturnType<typeof discoverDocuments>>,
  base: string,
  siteOrigin: string | undefined,
  retained: RetainedOutput[],
) {
  let unknown = initialUnknown
  const protectedImages = new Set(integrityFiles)
  const targets = new Map<OutputReference, NonNullable<ReturnType<typeof resolveReference>>>()
  for (const document of documents) {
    if (
      !siteOrigin &&
      document.entries.some(({ url }) => /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\//u.test(url))
    ) {
      unknown = true
      retained.push({
        file: document.name,
        reason: 'siteOrigin is required to resolve absolute URLs',
      })
    }
    const readOnly =
      !document.editable || integrityFiles.has(document.name) || (document.css && unknownIntegrity)
    for (const reference of document.entries) {
      try {
        const resolved = resolveReference(reference.url, document.name, base, siteOrigin)
        if (!resolved) continue
        targets.set(reference, resolved)
        if (!readOnly && !reference.readOnly) continue
        protectedImages.add(resolved.file)
        retained.push({ file: resolved.file, reason: `Read-only reference in ${document.name}` })
      } catch {
        unknown = true
      }
    }
  }
  return { protectedImages, targets, unknown }
}

interface OutputDiscovery {
  state: string
  stateFile: string
  cacheRoot: string
  records: Map<string, OutputRecord>
  destination: OutputDestination
  base: string
  siteOrigin: string | undefined
  fixed: Set<string>
  fixedCopies: FixedCopy[]
  documents: OutputDocument[]
  unknown: boolean
  integrityFiles: Set<string>
  unknownIntegrity: boolean
  protectedImages: Set<string>
  targets: Map<OutputReference, NonNullable<ReturnType<typeof resolveReference>>>
}

export async function discoverOutput(
  options: ProcessOutputOptions,
  projectRoot: string,
  outputRoot: string,
  retained: RetainedOutput[],
): Promise<OutputDiscovery> {
  const stateRoot = await resolvePlannedPath(
    path.resolve(projectRoot, options.stateDir ?? '.cache/image-pipeline-output'),
  )
  const adoptedRoot = options.adoptedStoreDir
    ? await resolvePlannedPath(path.resolve(projectRoot, options.adoptedStoreDir))
    : undefined
  const cacheRoot = await resolvePlannedPath(
    options.cacheDir ? path.resolve(projectRoot, options.cacheDir) : stateRoot + '-trials',
  )
  if (
    [stateRoot, adoptedRoot, cacheRoot].some(
      (directory) => directory && wouldOverlap(outputRoot, directory),
    )
  )
    throw new Error('Output directory overlaps image state, cache or adopted store')
  const destination = async (name: string) => {
    assertLogicalName(name)
    if (isOwnLockPath(name)) throw new Error(`Reserved image output path: ${name}`)
    const file = path.join(outputRoot, name)
    if ((await resolvePlannedPath(file)) !== file)
      throw new Error(`Image output path resolves through a symbolic link: ${file}`)
    return file
  }
  const base = options.base ?? '/'
  if (!base.startsWith('/') || !base.endsWith('/') || base.startsWith('//') || /[?#\\]/u.test(base))
    throw new TypeError('base must be a root-relative URL directory ending with /')
  const siteOrigin = options.siteOrigin && new URL(options.siteOrigin).origin
  const state = path.join(stateRoot, sha256(outputRoot))
  const stateFile = path.join(state, 'records.json')
  const records = parseOutputRecords(await readIfPresent(stateFile))
  const { fixed, fixedCopies } = await discoverFixedCopies(
    options.publicCopies,
    projectRoot,
    destination,
  )
  const docs = await discoverDocuments(
    options,
    outputRoot,
    destination,
    fixed,
    base,
    siteOrigin,
    retained,
  )
  const targets = discoverTargets(docs, base, siteOrigin, retained)
  return {
    state,
    stateFile,
    cacheRoot,
    records,
    destination,
    base,
    siteOrigin,
    fixed,
    fixedCopies,
    ...docs,
    ...targets,
  }
}
