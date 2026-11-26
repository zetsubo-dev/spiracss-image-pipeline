import path from 'node:path'

import { watch } from 'chokidar'
import PQueue from 'p-queue'

import { resolveImageConfig } from '../config/image-config.ts'
import { imageJobLimit } from '../processing/runtime.ts'
import { hasErrorCode } from '../shared/fs.ts'
import { imageFormat } from '../shared/image-format.ts'
import { containsPath } from '../shared/paths.ts'
import { optimizeSources, type SourceOptions } from './sources.ts'

type SourceEvent = 'add' | 'change' | 'unlink'

export interface SourceWatchOptions extends SourceOptions {
  onUpdate?: (file: string, event: SourceEvent) => void | Promise<void>
  onError?: (error: unknown) => void
}

export function createSourceEventHandler(options: SourceWatchOptions): {
  ready: Promise<undefined>
  handle: (event: SourceEvent, file: string) => Promise<void>
  close(): Promise<void>
} {
  const root = path.resolve(options.projectRoot)
  const publicRoots = (options.publicRoots ?? []).map((directory) => path.resolve(root, directory))
  const roots = options.roots.map((directory) => path.resolve(root, directory))
  const queue = new PQueue({ concurrency: imageJobLimit(resolveImageConfig(options.config).jobs) })
  let accepting = true
  const pending = new Map<string, { event: SourceEvent; changed: boolean; task: Promise<void> }>()
  const ready = optimizeSources(options).then(() => undefined)

  function handle(event: SourceEvent, file: string): Promise<void> {
    const absolute = path.resolve(root, file)
    if (
      !accepting ||
      publicRoots.some((directory) => containsPath(directory, absolute)) ||
      !imageFormat(file) ||
      !roots.some((directory) => containsPath(directory, absolute))
    )
      return Promise.resolve()
    const existing = pending.get(absolute)
    if (existing) {
      existing.event = event
      existing.changed = true
      return existing.task
    }
    const entry = { event, changed: false, task: Promise.resolve() }
    entry.task = ready
      .then(async () => {
        do {
          entry.changed = false
          const accepted = entry.event
          if (accepted === 'unlink') {
            await options.onUpdate?.(absolute, accepted)
            continue
          }
          try {
            const results = await queue.add(() =>
              optimizeSources({
                ...options,
                roots: [absolute],
                allowedRoots: roots,
              }),
            )
            if (results.some(({ status }) => status === 'optimized' || status === 'recovered'))
              await options.onUpdate?.(absolute, accepted)
          } catch (error) {
            if (!hasErrorCode(error, 'ENOENT') && !entry.changed) throw error
          }
        } while (entry.changed)
      })
      .finally(() => pending.delete(absolute))
    pending.set(absolute, entry)
    return entry.task
  }

  return {
    ready,
    handle,
    async close() {
      accepting = false
      const settled = await Promise.allSettled([
        ready,
        ...[...pending.values()].map((entry) => entry.task),
      ])
      const failed = settled.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    },
  }
}

export function watchSources(options: SourceWatchOptions): {
  ready: Promise<void>
  handle: (event: SourceEvent, file: string) => Promise<void>
  close: () => Promise<void>
} {
  const handler = createSourceEventHandler(options)
  let watcher: ReturnType<typeof watch> | undefined
  let closed: Promise<void> | undefined
  let stopPreparing: (() => void) | undefined

  const ready = handler.ready.then(async () => {
    if (closed) return
    watcher = watch(
      options.roots.map((directory) => path.resolve(options.projectRoot, directory)),
      {
        ignoreInitial: false,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
      },
    )
    const initial = new Set<Promise<void>>()
    let started = false
    watcher.on('all', (event, file) => {
      if (event !== 'add' && event !== 'change' && event !== 'unlink') return
      const job = handler.handle(event, file)
      if (!started) initial.add(job)
      void job.catch((error) => options.onError?.(error))
    })
    await new Promise<void>((resolve, reject) => {
      stopPreparing = resolve
      watcher?.once('ready', resolve)
      watcher?.once('error', reject)
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
        once: true,
      })
    })
    stopPreparing = undefined
    started = true
    await Promise.all(initial)
    if (closed) return
    watcher.on('error', (error) => options.onError?.(error))
  })

  function close(): Promise<void> {
    stopPreparing?.()
    closed ??= Promise.allSettled([watcher?.close(), handler.close()]).then((results) => {
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
    return closed
  }

  void ready.catch(() => close().catch(() => undefined))
  return { ready, handle: handler.handle, close }
}
