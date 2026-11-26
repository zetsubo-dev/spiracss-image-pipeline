/** Sharp treats an omitted own option and an own undefined option identically. */
export function normalizeBitmapOptions<T extends object>(options: T): T {
  const prototype = Object.getPrototypeOf(options)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(options).length
  )
    throw new TypeError('Unsupported bitmap options object')
  const descriptors = Object.getOwnPropertyDescriptors(options)
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]
    if (descriptor && 'value' in descriptor && descriptor.value === undefined)
      delete descriptors[key]
  }
  return Object.create(prototype, descriptors) as T
}
