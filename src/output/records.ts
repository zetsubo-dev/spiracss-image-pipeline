import { isDigest, type Digest } from '../shared/digest.ts'
import { assertLogicalName } from '../shared/paths.ts'

export interface OutputRecord {
  owner: string
  input: Digest
  output: Digest
  previous?: Digest
}

export function parseOutputRecords(bytes: Buffer | undefined): Map<string, OutputRecord> {
  if (!bytes) return new Map()
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid output processing state')
  const records = new Map<string, OutputRecord>()
  for (const [file, record] of Object.entries(value)) {
    assertLogicalName(file)
    if (
      !record ||
      typeof record !== 'object' ||
      typeof record.owner !== 'string' ||
      !isDigest(record.input) ||
      !isDigest(record.output) ||
      (record.previous !== undefined && !isDigest(record.previous))
    )
      throw new Error(`Invalid output processing state for ${file}`)
    assertLogicalName(record.owner)
    records.set(file, {
      owner: record.owner,
      input: record.input,
      output: record.output,
      previous: record.previous,
    })
  }
  return records
}
