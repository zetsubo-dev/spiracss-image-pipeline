import path from 'node:path'

export function assertLogicalName(name: string): void {
  if (
    !name ||
    name
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..' || part.includes(':')) ||
    /[?\\#]/u.test(name) ||
    [...name].some((character) => character.charCodeAt(0) <= 0x1f)
  )
    throw new TypeError(`Expected a project-relative logical image path: ${name}`)
}

export function containsPath(directory: string, target: string): boolean {
  const relative = path.relative(directory, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function logicalRelative(directory: string, target: string): string {
  return path.relative(directory, target).split(path.sep).join('/')
}
