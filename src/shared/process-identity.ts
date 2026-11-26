import { spawnSync } from 'node:child_process'

export interface ProcessIdentity {
  pid: number
  startedAt: string
  startedAtFormat: 'lstart-c-utc'
}

export interface RecordedOwner {
  pid: number
  startedAt: string
  startedAtFormat?: string
}

export type OwnerStatus = 'alive' | 'dead' | 'unknown'

export class ProcessIdentityUnavailableError extends Error {
  constructor(pid: number) {
    super(`Failed to inspect process start time: ${pid}`)
    this.name = 'ProcessIdentityUnavailableError'
  }
}

function readStartedAt(pid: number): string | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0) return null
  const value = result.stdout?.trim()
  return value || null
}

export function captureProcessIdentity(pid: number): ProcessIdentity {
  const startedAt = readStartedAt(pid)
  if (!startedAt) throw new ProcessIdentityUnavailableError(pid)
  return { pid, startedAt, startedAtFormat: 'lstart-c-utc' }
}

export function classifyPid(pid: number): OwnerStatus {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return 'dead'
    return 'unknown'
  }
}

export function classifyOwner(owner: RecordedOwner): OwnerStatus {
  const status = classifyPid(owner.pid)
  if (status !== 'alive') return status
  if (owner.startedAtFormat !== 'lstart-c-utc') return 'unknown'
  const actual = readStartedAt(owner.pid)
  if (actual === null) return 'unknown'
  return actual === owner.startedAt ? 'alive' : 'dead'
}

export function sameProcessIdentity(a: RecordedOwner, b: RecordedOwner): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt && a.startedAtFormat === b.startedAtFormat
}
