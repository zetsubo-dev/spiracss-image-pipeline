import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { captureProcessIdentity, classifyOwner } from './process-identity.ts'
import { isolateWarning } from './warning.ts'

export interface LockPayload {
  createdAt: string
  pid: number
  processStartedAt: string
  processStartedAtFormat?: string
  token?: string
}

export interface AcquireFileLockOptions {
  signal?: AbortSignal
  retryMs?: number
  staleAfterMs?: number
  timeoutMs?: number
  onWarning?: (message: string) => void
  now?: () => number
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isValidLockPayload(value: unknown): value is LockPayload {
  if (!isUnknownRecord(value)) return false

  const { createdAt, pid, processStartedAt } = value
  return (
    typeof createdAt === 'string' &&
    !Number.isNaN(Date.parse(createdAt)) &&
    typeof pid === 'number' &&
    Number.isInteger(pid) &&
    pid > 0 &&
    typeof processStartedAt === 'string' &&
    processStartedAt.trim().length > 0
  )
}

function lockOwnerStatus(payload: LockPayload) {
  return classifyOwner({
    pid: payload.pid,
    startedAt: payload.processStartedAt,
    startedAtFormat: payload.processStartedAtFormat,
  })
}

async function readLockPayload(lockFile: string): Promise<LockPayload | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockFile, 'utf8')) as unknown
    return isValidLockPayload(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function shouldRecoverStaleLock(lockFile: string, staleAfterMs: number): Promise<boolean> {
  const payload = await readLockPayload(lockFile)
  if (payload) return lockOwnerStatus(payload) === 'dead'

  try {
    const stats = await fs.stat(lockFile)
    return Date.now() - stats.mtimeMs >= staleAfterMs
  } catch {
    return true
  }
}

function createCurrentLockPayload(): LockPayload {
  const identity = captureProcessIdentity(process.pid)
  return {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    processStartedAt: identity.startedAt,
    processStartedAtFormat: 'lstart-c-utc',
    token: randomUUID(),
  }
}

function resolveLockGate(lockFile: string): string {
  return `${lockFile}.gate`
}

function resolveRecoveryMarker(
  gate: string,
  generation: Pick<Awaited<ReturnType<typeof fs.stat>>, 'dev' | 'ino'>,
): string {
  return path.join(gate, `.reclaim-${generation.dev}-${generation.ino}`)
}

async function removeLockGate(lockFile: string, expectedToken: string): Promise<void> {
  const gate = resolveLockGate(lockFile)
  const initialStats = await fs.stat(gate).catch(() => null)
  if (!initialStats) return
  const owner = await readLockPayload(path.join(gate, 'owner.json'))
  if (!owner || owner.token !== expectedToken) return
  const marker = resolveRecoveryMarker(gate, initialStats)
  if (await fs.stat(marker).catch(() => null)) return
  const currentStats = await fs.stat(gate).catch(() => null)
  if (
    !currentStats ||
    currentStats.dev !== initialStats.dev ||
    currentStats.ino !== initialStats.ino
  )
    return
  const quarantine = `${gate}.${process.pid}.${randomUUID()}.release`
  try {
    await fs.rename(gate, quarantine)
  } catch (error: unknown) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code !== 'ENOENT') throw error
    return
  }
  await fs.rm(quarantine, { recursive: true, force: true })
}

async function tryRecoverStaleGate(lockFile: string, staleAfterMs: number): Promise<boolean> {
  const gate = resolveLockGate(lockFile)
  const initialStats = await fs.stat(gate).catch(() => null)
  if (!initialStats) return false
  const initialOwner = await readLockPayload(path.join(gate, 'owner.json'))
  const gateStale = initialOwner
    ? lockOwnerStatus(initialOwner) === 'dead'
    : Date.now() - initialStats.mtimeMs >= staleAfterMs
  if (!gateStale) return false
  const marker = resolveRecoveryMarker(gate, initialStats)
  const recoveryPayload = createCurrentLockPayload()
  try {
    await fs.writeFile(marker, JSON.stringify(recoveryPayload), {
      encoding: 'utf8',
      flag: 'wx',
    })
  } catch (error: unknown) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'EEXIST') return false
    if (code === 'ENOENT') return false
    throw error
  }

  let moved = false
  try {
    const currentStats = await fs.stat(gate).catch(() => null)
    if (
      !currentStats ||
      currentStats.dev !== initialStats.dev ||
      currentStats.ino !== initialStats.ino
    ) {
      return false
    }
    const currentOwner = await readLockPayload(path.join(gate, 'owner.json'))
    if (initialOwner?.token && currentOwner?.token !== initialOwner.token) return false
    if (!initialOwner && currentOwner) return false
    const quarantine = `${gate}.${process.pid}.${randomUUID()}.stale`
    try {
      await fs.rename(gate, quarantine)
    } catch (error: unknown) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      if (code === 'ENOENT') return false
      throw error
    }
    moved = true
    await fs.rm(quarantine, { recursive: true, force: true })
    return true
  } finally {
    if (!moved) {
      const markerOwner = await readLockPayload(marker)
      if (markerOwner?.token === recoveryPayload.token) {
        await fs.rm(marker, { force: true }).catch(() => undefined)
      }
    }
  }
}

async function prepareOwnedGate(
  lockFile: string,
  gate: string,
  payload: LockPayload,
  staleAfterMs: number,
): Promise<boolean> {
  await fs.writeFile(path.join(gate, 'owner.json'), JSON.stringify(payload), 'utf8')
  const mustWait = !(await shouldRecoverStaleLock(lockFile, staleAfterMs))
  if (mustWait) {
    await removeLockGate(lockFile, payload.token ?? '')
    return false
  }
  await fs.writeFile(lockFile, JSON.stringify(payload), 'utf8')
  return true
}

function createLockRelease(
  lockFile: string,
  gate: string,
  payload: LockPayload,
): () => Promise<void> {
  return async () => {
    const current = await readLockPayload(lockFile)
    if (current?.token === payload.token) {
      await fs.rm(lockFile, { force: true })
    }
    const owner = await readLockPayload(path.join(gate, 'owner.json'))
    if (owner?.token === payload.token) {
      await removeLockGate(lockFile, payload.token ?? '')
    }
  }
}

async function recoverGateIfStale(lockFile: string, staleAfterMs: number): Promise<boolean> {
  const gate = resolveLockGate(lockFile)
  const stats = await fs.stat(gate).catch(() => null)
  if (!stats) return false
  const owner = await readLockPayload(path.join(gate, 'owner.json'))
  const stale = owner
    ? lockOwnerStatus(owner) === 'dead'
    : Date.now() - stats.mtimeMs >= staleAfterMs
  return stale && (await tryRecoverStaleGate(lockFile, staleAfterMs))
}

async function createLockTimeoutError(
  lockFile: string,
  gate: string,
  cause?: unknown,
): Promise<Error> {
  const entries = await fs.readdir(gate).catch(() => [])
  const markerHint = entries.some((entry) => entry.startsWith('.reclaim-'))
    ? `; remove the stale recovery marker under ${gate}`
    : ''
  const message = `lock acquisition timed out: ${lockFile}${markerHint}`
  return cause === undefined ? new Error(message) : new Error(message, { cause })
}

async function cleanupFailedGate(
  lockFile: string,
  payload: LockPayload,
  expectedStats: Pick<Awaited<ReturnType<typeof fs.stat>>, 'dev' | 'ino'> | null,
): Promise<void> {
  const gate = resolveLockGate(lockFile)
  const currentStats = await fs.stat(gate).catch(() => null)
  if (
    !expectedStats ||
    !currentStats ||
    currentStats.dev !== expectedStats.dev ||
    currentStats.ino !== expectedStats.ino
  ) {
    return
  }
  const owner = await readLockPayload(path.join(gate, 'owner.json'))
  if (owner?.token === payload.token) {
    await removeLockGate(lockFile, payload.token ?? '').catch(() => undefined)
  } else {
    await fs.rm(gate, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function acquireFileLock(
  lockFile: string,
  options: AcquireFileLockOptions = {},
): Promise<() => Promise<void>> {
  options.signal?.throwIfAborted()
  const retryMs = options.retryMs ?? 100
  const staleAfterMs = options.staleAfterMs ?? 30_000
  const timeoutMs = options.timeoutMs ?? 60_000
  const now = options.now ?? (() => performance.now())
  const startedAt = now()
  const warn = isolateWarning(options.onWarning)
  let nextWarningAt = 30_000
  let warned = false
  const payload = createCurrentLockPayload()
  await fs.mkdir(path.dirname(lockFile), { recursive: true })
  const gate = resolveLockGate(lockFile)

  async function waitForRetry(cause?: unknown): Promise<void> {
    const elapsed = now() - startedAt
    if (elapsed >= timeoutMs) throw await createLockTimeoutError(lockFile, gate, cause)
    if (elapsed >= nextWarningAt) {
      warn(`Waiting for an image pipeline lock (${Math.floor(elapsed / 1000)}s elapsed).`)
      nextWarningAt = elapsed + 60_000
      warned = true
    }
    await delay(retryMs, undefined, { signal: options.signal })
  }

  while (true) {
    options.signal?.throwIfAborted()
    let gateOwned = false
    let gateStats: Pick<Awaited<ReturnType<typeof fs.stat>>, 'dev' | 'ino'> | null = null
    try {
      await fs.mkdir(gate)
      gateOwned = true
      gateStats = await fs.stat(gate)
      if (!(await prepareOwnedGate(lockFile, gate, payload, staleAfterMs))) {
        gateOwned = false
        gateStats = null
        await waitForRetry()
        continue
      }
      const release = createLockRelease(lockFile, gate, payload)
      if (options.signal?.aborted) {
        await release()
        options.signal.throwIfAborted()
      }
      if (warned)
        warn(`Acquired the image pipeline lock after ${Math.floor((now() - startedAt) / 1000)}s.`)
      return release
    } catch (error: unknown) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      if (code !== 'EEXIST') {
        if (gateOwned) await cleanupFailedGate(lockFile, payload, gateStats)
        throw error
      }

      if (await recoverGateIfStale(lockFile, staleAfterMs)) continue

      await waitForRetry(error)
    }
  }
}
