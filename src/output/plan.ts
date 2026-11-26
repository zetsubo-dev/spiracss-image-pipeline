import path from 'node:path'

import { makeImageBuild, type ImageBuild } from '../build/image-build.ts'
import type { PreparedImage } from '../build/trial-engine.ts'
import { replacement } from '../references/html.ts'
import { outputUrl, type resolveReference } from '../references/resolve.ts'
import type { Edit, OutputReference } from '../references/types.ts'
import { sha256 } from '../shared/digest.ts'
import { readIfPresent } from '../shared/fs.ts'
import type { discoverOutput, ProcessOutputOptions, RetainedOutput } from './discover.ts'
import type { OutputRecord } from './records.ts'

type Discovery = Awaited<ReturnType<typeof discoverOutput>>
type SelectedImage = { owner: string; prepared: PreparedImage; input: string; source: Buffer }
type StageImage = (item: SelectedImage) => Promise<void>
type PlannedReference = {
  selected: PreparedImage
  resolved: NonNullable<ReturnType<typeof resolveReference>>
  owner: string
  input: string
  source: Buffer
}

const verified: unique symbol = Symbol('verified output plan')

interface OutputPlan {
  records: Map<string, OutputRecord>
  stateFile: string
  destination: Discovery['destination']
  publish: ImageBuild['publish']
  finish: () => Promise<void>
  collectEdits: (stageImage: StageImage) => Promise<Map<string, { text: string; original: string }>>
}

export interface VerifiedOutputPlan {
  readonly [verified]: true
  records: Map<string, OutputRecord>
  stateFile: string
  destination: Discovery['destination']
  images: Map<string, { bytes: Buffer; record: OutputRecord }>
  originals: Map<string, Buffer>
  edited: Map<string, { text: string; original: string }>
}

export function planOutput(
  options: ProcessOutputOptions,
  projectRoot: string,
  outputRoot: string,
  discovery: Discovery,
  retained: RetainedOutput[],
): OutputPlan {
  const {
    documents,
    integrityFiles,
    unknownIntegrity,
    targets,
    fixed,
    unknown,
    protectedImages,
    state,
    stateFile,
    records,
    destination,
    base,
    siteOrigin,
    cacheRoot,
    fixedCopies,
  } = discovery
  // A failed or mixed srcset must never cause another reference to overwrite its originals.
  const groupedOriginals = new Set(
    [...targets].filter(([reference]) => reference.group).map(([, target]) => target.file),
  )
  const known = new Map(
    options.inventory?.generatedImages.map((entry) => [entry.output, entry.logicalName]),
  )
  const { build, finish } = makeImageBuild({
    ...options,
    projectRoot,
    outputDir: outputRoot,
    cacheDir: cacheRoot,
  })
  async function planReference(reference: OutputReference): Promise<PlannedReference | undefined> {
    const resolved = targets.get(reference)
    if (!resolved || fixed.has(resolved.file)) return undefined
    if (reference.readOnly) return undefined
    const previous = records.get(resolved.file)
    const owner = previous?.owner ?? resolved.file
    const logicalName = known.get(owner) ?? owner
    if (options.inventory && !known.has(owner)) return undefined
    const currentFile = await destination(resolved.file)
    const current = await readIfPresent(currentFile)
    if (!current) {
      retained.push({ file: resolved.file, reason: 'Image reference did not resolve' })
      return undefined
    }
    const currentDigest = sha256(current)
    if (previous && ![previous.input, previous.output, previous.previous].includes(currentDigest)) {
      retained.push({ file: resolved.file, reason: 'Image state differs from the output bytes' })
      return undefined
    }
    const sourceDigest = previous?.input ?? currentDigest
    const input = path.join(state, 'inputs', sourceDigest + path.extname(owner))
    const source = previous ? await readIfPresent(input) : current
    if (!source || sha256(source) !== sourceDigest) {
      retained.push({ file: resolved.file, reason: 'Original image bytes are unavailable' })
      return undefined
    }
    const prepared = await build.prepareUse({
      input: {
        kind: 'generated',
        file: previous ? input : currentFile,
        logicalName,
        owner,
        bytes: source,
      },
      logicalPlacement: owner,
      usage: reference.usage,
    })
    return { selected: prepared, resolved, owner, input, source }
  }

  async function retainSelection({
    selected,
    resolved,
    owner,
  }: PlannedReference): Promise<boolean> {
    const name = selected.suggestedDestination
    const incompleteReferences =
      unknown &&
      (name === owner ||
        name === resolved.file ||
        (records.has(name) && (await readIfPresent(await destination(name))) !== undefined))
    if (
      protectedImages.has(name) ||
      incompleteReferences ||
      (name === owner && groupedOriginals.has(owner))
    ) {
      retained.push({
        file: name,
        reason: protectedImages.has(name)
          ? 'Image is referenced by a read-only document'
          : 'Original image kept because its references are incomplete',
      })
      return true
    }
    return false
  }
  type ReferenceGroup = NonNullable<OutputReference['group']>
  type GroupPlan = { formats: Set<string>; plans: (SelectedImage & { edit?: Edit })[] }

  async function stageGroup(
    document: (typeof documents)[number],
    group: ReferenceGroup,
    plan: GroupPlan,
    edits: Map<number, Edit>,
    stageImage: StageImage,
  ) {
    if (plan.plans.length !== group.count || plan.formats.size !== 1) return
    for (const item of plan.plans) {
      await stageImage(item)
      if (item.edit) edits.set(item.edit.start, item.edit)
    }
    if (group.typeEdit && plan.plans.some((item) => item.edit)) {
      const format = [...plan.formats][0]
      const mime = format === 'svg' ? 'image/svg+xml' : `image/${format}`
      edits.set(group.typeEdit.start, {
        ...group.typeEdit,
        value: replacement(document.text, group.typeEdit, mime, false),
      })
    }
  }

  async function planDocument(document: (typeof documents)[number], stageImage: StageImage) {
    if (!document.editable) return
    if (integrityFiles.has(document.name) || (document.css && unknownIntegrity)) {
      retained.push({ file: document.name, reason: 'Asset is covered by an integrity declaration' })
      return
    }
    const edits = new Map<number, Edit>()
    const groups = new Map<ReferenceGroup, GroupPlan>()
    for (const reference of document.entries) {
      const selection = await planReference(reference)
      if (!selection || (await retainSelection(selection))) continue
      const { selected, resolved, owner, input, source } = selection
      const name = selected.suggestedDestination
      if (reference.group) {
        const group = groups.get(reference.group) ?? { formats: new Set<string>(), plans: [] }
        group.formats.add(selected.format)
        const url = outputUrl(reference.url, name, document.name, base, siteOrigin, resolved.suffix)
        group.plans.push({
          owner,
          prepared: selected,
          input,
          source,
          edit:
            resolved.file === name
              ? undefined
              : {
                  ...reference.urlEdit,
                  value: url
                    .replace(/&/gu, '&amp;')
                    .replace(/"/gu, '&quot;')
                    .replace(/'/gu, '&#39;'),
                },
        })
        groups.set(reference.group, group)
        continue
      }
      await stageImage({ owner, prepared: selected, input, source })
      if (resolved.file === name) continue
      const url = outputUrl(reference.url, name, document.name, base, siteOrigin, resolved.suffix)
      const urlEdit = reference.urlEdit
      edits.set(urlEdit.start, {
        ...urlEdit,
        value:
          reference.syntax === 'json'
            ? JSON.stringify(url).replace(/</gu, '\\u003c')
            : replacement(document.text, urlEdit, url, document.css),
      })
      if (reference.typeEdit) {
        const mime = selected.format === 'svg' ? 'image/svg+xml' : `image/${selected.format}`
        edits.set(reference.typeEdit.start, {
          ...reference.typeEdit,
          value:
            reference.syntax === 'json'
              ? JSON.stringify(mime)
              : replacement(document.text, reference.typeEdit, mime, false),
        })
      }
    }
    for (const [group, plan] of groups) await stageGroup(document, group, plan, edits, stageImage)
    let text = document.text
    for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.value + text.slice(edit.end)
    }
    return text !== document.text ? { text, original: document.text } : undefined
  }
  return {
    records,
    stateFile,
    destination,
    publish: build.publish,
    finish,
    async collectEdits(stageImage) {
      await build.registerFixedCopies(fixedCopies)
      const edited = new Map<string, { text: string; original: string }>()
      for (const document of documents) {
        const edit = await planDocument(document, stageImage)
        if (edit) edited.set(document.file, edit)
      }
      return edited
    },
  }
}

export async function verifyOutputPlan(plan: OutputPlan): Promise<VerifiedOutputPlan> {
  const { records, stateFile, destination, publish } = plan
  const images = new Map<string, { bytes: Buffer; record: OutputRecord }>()
  const originals = new Map<string, Buffer>()
  const stageImage: StageImage = async ({ owner, prepared, input, source }) => {
    const name = prepared.suggestedDestination
    const image = publish(prepared, {
      owner,
      generated: true,
      destination: name,
      url: '/' + name.split('/').map(encodeURIComponent).join('/'),
    })
    const existing = await readIfPresent(await destination(name))
    const previous = records.get(name)
    if (
      existing &&
      name !== owner &&
      (!previous ||
        previous.owner !== owner ||
        ![previous.output, previous.previous].includes(sha256(existing)))
    )
      throw new Error(`Generated image conflicts with an existing output: ${owner} → ${name}`)
    images.set(name, {
      bytes: image.bytes,
      record: {
        owner,
        input: image.sourceDigest,
        output: image.outputDigest,
        previous: existing ? sha256(existing) : undefined,
      },
    })
    originals.set(input, source)
  }
  // Check each selected image at its original planning point so a collision still
  // stops processing before subsequent documents. Commit can only see the finished plan.
  const edited = await plan.collectEdits(stageImage)
  return { [verified]: true, records, stateFile, destination, images, originals, edited }
}
