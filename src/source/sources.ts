import fs from 'node:fs/promises'
import path from 'node:path'

import PQueue from 'p-queue'

import { resolveImageConfig, type ImageConfig, type ImageOverride } from '../config/image-config.ts'
import { createImageDistIgnoreMatcher, resolveImageOverride } from '../config/policy.ts'
import { imageJobLimit } from '../processing/runtime.ts'
import { bitmapRecordSignature } from '../processing/signatures.ts'
import { resolveSvgProcessingSettings } from '../processing/svg-processing.ts'
import { runTrial, type ProcessingTrial } from '../processing/trial.ts'
import { isDigest, sha256, type Digest } from '../shared/digest.ts'
import { acquireFileLock } from '../shared/file-lock.ts'
import { hasErrorCode, readIfPresent, writeAtomic } from '../shared/fs.ts'
import { imageFormat, type ImageFormat } from '../shared/image-format.ts'
import { containsPath, logicalRelative } from '../shared/paths.ts'
import {
  parseSourceRecord,
  sourceImageRecordName,
  updateLedger,
  type SourceRecord,
} from '../store/source-ledger.ts'

export interface SourceOptions {
  projectRoot: string
  roots: readonly string[]
  /** Pass an empty array when the project has no protected public sources. */
  publicRoots: readonly string[]
  cacheDir?: string
  /** Source scan roots can be absent in a freshly scaffolded host. */
  allowMissingRoots?: boolean
  /** Restrict direct per-file requests to the same real roots as the host source scan. */
  allowedRoots?: readonly string[]
  sourceFormats?: readonly Exclude<ImageFormat, 'ico'>[]
  /** Coordinate with a host that still uses its existing per-image lock directory. */
  sourceLockDir?: string
  sourceRecordLockPath?: string
  config?: ImageConfig
  signal?: AbortSignal
  onWarning?: (message: string) => void
}

export interface SourceResult {
  file: string
  status: 'optimized' | 'baseline' | 'retained' | 'protected' | 'recovered'
}

async function* walk(directory: string): AsyncGenerator<string> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(file)
    else if (entry.isFile() || entry.isSymbolicLink()) yield file
  }
}

async function protectedPublic(options: SourceOptions, projectRoot: string): Promise<string[]> {
  if (!Array.isArray(options.publicRoots))
    throw new TypeError('Declare publicRoots. Pass [] if there is no protected public directory.')
  return await Promise.all(
    options.publicRoots.map(async (directory) => {
      const file = path.resolve(projectRoot, directory)
      const real = await fs.realpath(file).catch((error: unknown) => {
        if (!hasErrorCode(error, 'ENOENT')) throw error
        return undefined
      })
      if (!real) return file
      for await (const entry of walk(real)) {
        const resolved = await fs.realpath(entry)
        if (!containsPath(real, resolved))
          throw new Error(`Public link leaves its declared root: ${entry} → ${resolved}`)
      }
      return real
    }),
  )
}

async function sourceFiles(
  options: SourceOptions,
  root: string,
  publicRoots: readonly string[],
): Promise<string[]> {
  const ignored = createImageDistIgnoreMatcher(
    resolveImageConfig(options.config).dev.ignoreAllAutoOptimize,
  )
  const files = new Set<string>()
  const allowed = (
    await Promise.all(
      options.allowedRoots?.map(async (entry) => {
        const candidate = path.resolve(root, entry)
        return await fs.realpath(candidate).catch((error: unknown) => {
          if (!hasErrorCode(error, 'ENOENT')) throw error
        })
      }) ?? [],
    )
  ).filter((entry): entry is string => entry !== undefined)
  const declaredRoot = path.resolve(options.projectRoot)
  for (const input of options.roots) {
    const declaredPath = path.resolve(declaredRoot, input)
    const candidate = containsPath(declaredRoot, declaredPath)
      ? path.resolve(root, path.relative(declaredRoot, declaredPath))
      : declaredPath
    const real = await fs.realpath(candidate).catch((error: unknown) => {
      if (!options.allowMissingRoots || !hasErrorCode(error, 'ENOENT')) throw error
    })
    if (!real) continue
    if (!containsPath(root, candidate) || !containsPath(root, real))
      throw new Error(`Image source leaves the project root: ${candidate} → ${real}`)
    if (publicRoots.some((directory) => containsPath(directory, real))) continue
    const single = (await fs.stat(real)).isFile()
    for await (const file of single ? [candidate] : walk(candidate)) {
      const format = imageFormat(file)
      if (!format || ignored(logicalRelative(root, file))) continue
      if (options.sourceFormats && (format === 'ico' || !options.sourceFormats.includes(format)))
        continue
      const resolved = await fs.realpath(file)
      if (publicRoots.some((directory) => containsPath(directory, resolved))) continue
      if (
        !containsPath(single ? root : real, resolved) ||
        (options.allowedRoots && !allowed.some((directory) => containsPath(directory, resolved)))
      )
        throw new Error(`Image source link leaves the allowed directory: ${file} → ${resolved}`)
      if (format !== imageFormat(resolved))
        throw new Error(`Image source link changes the image format: ${file} → ${resolved}`)
      files.add(resolved)
    }
  }
  return [...files]
}

export async function baselineSources(options: SourceOptions): Promise<SourceResult[]> {
  return await processSources(options, true)
}

export async function optimizeSources(options: SourceOptions): Promise<SourceResult[]> {
  return await processSources(options, false)
}

async function recoverSourceWrite(
  pending: Buffer,
  journal: string,
  digest: Digest,
  ledger: string,
  ledgerLock: string,
  onWarning?: (message: string) => void,
): Promise<boolean> {
  const state: unknown = JSON.parse(pending.toString('utf8'))
  if (
    typeof state !== 'object' ||
    state === null ||
    !('input' in state) ||
    !isDigest(state.input) ||
    !('output' in state) ||
    !isDigest(state.output) ||
    ('signature' in state && !isDigest(state.signature))
  )
    throw new Error(`Invalid image replacement journal: ${journal}`)
  if (state.output === digest) {
    await updateLedger(
      ledger,
      [
        {
          digest,
          signature:
            'signature' in state && isDigest(state.signature) ? state.signature : undefined,
        },
      ],
      ledgerLock,
      { onWarning },
    )
    await fs.rm(journal, { force: true })
    return true
  }
  await fs.rm(journal, { force: true })
  return false
}

async function verifySourceUnchanged(
  file: string,
  digest: Digest,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  if ((await fs.realpath(file)) !== file || sha256(await fs.readFile(file)) !== digest)
    throw new Error(`Image changed during processing: ${file}`)
}

function sourceTrial(
  format: Exclude<ImageFormat, 'ico'>,
  override: ImageOverride | undefined,
  config: ReturnType<typeof resolveImageConfig>,
  root: string,
  file: string,
): ProcessingTrial {
  return format === 'svg'
    ? {
        format,
        operation: override ? 'override' : 'minify',
        adoption: 'smaller',
        options: {},
        svg: resolveSvgProcessingSettings(
          config.formats.svg,
          override?.format === 'svg' ? override.options : undefined,
        ),
        logicalPath: logicalRelative(root, file),
      }
    : {
        format,
        operation: override ? 'override' : 'minify',
        adoption: override ? 'always' : 'smaller',
        options: override ? (override.options ?? {}) : config.formats[format],
      }
}

async function processSources(options: SourceOptions, baseline: boolean): Promise<SourceResult[]> {
  const { onWarning } = options
  const root = await fs.realpath(options.projectRoot)
  const publicRoots = await protectedPublic(options, root)
  const config = resolveImageConfig(options.config)
  const ledger = path.join(root, sourceImageRecordName)
  const ledgerLock = path.resolve(root, options.sourceRecordLockPath ?? `${ledger}.lock`)
  parseSourceRecord((await readIfPresent(ledger))?.toString('utf8') ?? '')
  const files = await sourceFiles(options, root, publicRoots)
  const cache = path.resolve(root, options.cacheDir ?? '.cache/image-pipeline')
  const queue = new PQueue({ concurrency: imageJobLimit(config.jobs) })
  const work = queue.addAll(
    files.map((file) => async (): Promise<SourceResult> => {
      const signal = options.signal
      signal?.throwIfAborted()
      const format = imageFormat(file)
      if (!format || format === 'ico') return { file, status: 'retained' }
      const lockFile = options.sourceLockDir
        ? path.resolve(root, options.sourceLockDir, `source-${sha256(file)}.lock`)
        : `${file}.image-pipeline.lock`
      const release = await acquireFileLock(lockFile, { timeoutMs: 300_000, signal, onWarning })
      try {
        if ((await fs.realpath(file)) !== file)
          throw new Error(`Image source changed after discovery: ${file}`)
        const bytes = await fs.readFile(file)
        const digest = sha256(bytes)
        const previous: SourceRecord = parseSourceRecord(
          (await readIfPresent(ledger))?.toString('utf8') ?? '',
        )
        const journal = path.join(
          cache,
          'source-writes',
          `${sha256(logicalRelative(root, file))}.json`,
        )
        const pending = await readIfPresent(journal)
        if (
          pending &&
          (await recoverSourceWrite(pending, journal, digest, ledger, ledgerLock, onWarning))
        )
          return { file, status: 'recovered' }
        if (baseline) {
          await updateLedger(ledger, [{ digest }], ledgerLock, { signal, onWarning })
          return { file, status: 'baseline' }
        }
        if (previous.has(digest)) return { file, status: 'protected' }
        const override = resolveImageOverride(config.dev.customOverrides, [
          logicalRelative(root, file),
        ])
        if (!override && !config.dev.autoMinify) return { file, status: 'retained' }
        if (override && override.format !== format)
          throw new Error(`Source optimization requires the original image format: ${file}`)
        const trial = sourceTrial(format, override, config, root, file)
        const signature =
          trial.format === 'svg' || trial.operation === 'convert'
            ? undefined
            : bitmapRecordSignature(trial.format, trial.options, trial.operation)
        const result = await runTrial({ bytes, digest }, trial)
        const check = () => verifySourceUnchanged(file, digest, signal)
        await check()
        if (result.kind !== 'adopted') {
          await updateLedger(ledger, [{ digest, signature }], ledgerLock, { signal, onWarning })
          return { file, status: 'retained' }
        }
        const adopted = sha256(result.bytes)
        await writeAtomic(
          journal,
          JSON.stringify({ input: digest, output: adopted, signature }) + '\n',
        )
        await writeAtomic(file, result.bytes, path.dirname(file), (await fs.stat(file)).mode, check)
        await updateLedger(ledger, [{ digest: adopted, signature }], ledgerLock, { onWarning })
        await fs.rm(journal, { force: true })
        return { file, status: 'optimized' }
      } finally {
        await release()
      }
    }),
  )
  try {
    return await work
  } finally {
    await queue.onIdle()
  }
}
