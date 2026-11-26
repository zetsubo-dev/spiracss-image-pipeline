export {
  BITMAP_MINIFY_PIPELINE_VERSION,
  IMAGE_OVERRIDE_PIPELINE_VERSIONS,
  SVG_PIPELINE_VERSION,
  SVG_PRESERVE_ASPECT,
  buildBitmapProcessingSignature,
  buildImageConfigSignature,
  buildSvgConfigSignature,
  getImageCodecVersions,
} from './processing/signatures.ts'
export { configureImageRuntime, createImageJobScheduler } from './processing/runtime.ts'
export { prepareInlineSvg } from './processing/svg-inline.ts'
export { inspectJson } from './references/json.ts'
export { inspectHtml } from './references/html.ts'
export {
  inspectManifestImages,
  planManifestImages,
  rewriteManifestImages,
} from './references/manifest.ts'
export type {
  ManifestImagePlan,
  ManifestPlanOptions,
  ManifestSelections,
  ManifestUnknownReason,
  PlannedManifestReference,
} from './references/manifest.ts'
export { locateOutputUrl, resolveReference } from './references/resolve.ts'
export type { DocumentReferences, OutputReference } from './references/types.ts'
export type { FixedCopy } from './publication/placement-registry.ts'
export type {
  PublicationDocument,
  PublicationUsageReference,
  VerifyPublicationOptions,
} from './publication/verify.ts'
export type { PreparedInlineSvg } from './processing/svg-inline.ts'
export { createImageBuild } from './build/image-build.ts'
export type { ImageBuild, ImagePlacement } from './build/image-build.ts'
export type { PreparedImage } from './build/trial-engine.ts'
export type { ImageBuildOptions, LocalCacheLimits } from './build/options.ts'
export type { Publication, ResolvedImage } from './publication/placement-registry.ts'
export type { ImageUse, StoreTrialInput } from './processing/trial-plan.ts'
