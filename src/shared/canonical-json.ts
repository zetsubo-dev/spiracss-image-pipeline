export type Json = null | string | number | boolean | Json[] | { [key: string]: Json }

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toJson(value))
}

export function toJson(value: unknown, ancestors: Set<object> = new Set<object>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || ancestors.has(value))
    throw new TypeError('Image processing settings must be deterministic JSON to be reused')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Array.from(value, (entry: unknown) => toJson(entry, ancestors))
    const prototype = Object.getPrototypeOf(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length
    )
      throw new TypeError('Image processing settings must use plain objects to be reused')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const entries: [string, Json][] = []
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]!
      if (!('value' in descriptor))
        throw new TypeError('Image processing settings with accessors cannot be reused')
      if (descriptor.value !== undefined) entries.push([key, toJson(descriptor.value, ancestors)])
    }
    return Object.fromEntries(entries)
  } finally {
    ancestors.delete(value)
  }
}
