import type { ImageConfig, ImageUsage } from '../config/image-config.ts'
import type { StoreTrialInput, ImageUse } from '../processing/trial-plan.ts'
import type { Digest } from '../shared/digest.ts'

export interface LocalCacheLimits {
  maxBytes?: number
  maxEntries?: number
}

export interface ImageBuildOptions {
  projectRoot: string
  config?: ImageConfig
  usages?: readonly ImageUsage[]
  adoptedStoreDir?: string
  outputDir?: string
  caseInsensitiveOutputs?: boolean
  cacheDir?: string
  localCache?: LocalCacheLimits
  sourceRecordPath?: string
  skipProcessing?: boolean
  onWarning?: (message: string) => void
  onStoreTrials?: (input: StoreTrialInput, keys: readonly Digest[]) => Promise<void>
  urlFor?: (destination: string, use: ImageUse) => string
}
