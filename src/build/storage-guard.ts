import path from 'node:path'

import { outputNameKey } from '../publication/output-name.ts'
import { isCaseInsensitiveOutput, resolvePlannedPath } from '../publication/output-paths.ts'
import { containsPath } from '../shared/paths.ts'
import type { ImageBuildOptions } from './options.ts'

export function createStorageGuard(
  root: string,
  options: ImageBuildOptions,
  setCaseInsensitive: (value: boolean) => void,
): (outputDirectory?: string) => Promise<void> {
  let validatedOutput: Promise<string> | undefined
  async function validate(plannedOutput: string): Promise<string> {
    const output = await resolvePlannedPath(plannedOutput)
    const insensitive = await isCaseInsensitiveOutput(output)
    const outputKey = outputNameKey(output, insensitive)
    for (const storage of [options.adoptedStoreDir, options.cacheDir]) {
      if (!storage) continue
      const directory = await resolvePlannedPath(path.resolve(root, storage))
      const key = outputNameKey(directory, insensitive)
      if (containsPath(outputKey, key) || containsPath(key, outputKey))
        throw new Error(`Image storage overlaps build output: ${directory} and ${output}`)
    }
    setCaseInsensitive(options.caseInsensitiveOutputs ?? insensitive)
    return plannedOutput
  }

  async function verifyStoragePaths(outputDirectory?: string): Promise<void> {
    const directory = options.outputDir ?? outputDirectory
    if (!validatedOutput && directory !== undefined)
      validatedOutput = validate(path.resolve(root, directory))
    if (!validatedOutput) return
    const plannedOutput = await validatedOutput
    if (outputDirectory === undefined) return
    // The directory may have been created or replaced since registration.
    const [output, supplied] = await Promise.all([
      resolvePlannedPath(plannedOutput),
      resolvePlannedPath(path.resolve(root, outputDirectory)),
    ])
    if (output !== supplied)
      throw new Error(`Image build output directory differs: ${supplied} and ${output}`)
  }
  return verifyStoragePaths
}
