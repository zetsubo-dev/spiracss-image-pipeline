export { getImageDimensions, getImageSize } from './processing/image-size.ts'
export { baselineSources, optimizeSources } from './source/sources.ts'
export type { SourceOptions, SourceResult } from './source/sources.ts'
export {
  collectAdoptedStoreKeys,
  pruneAdoptedStore,
  refreshAdoptedResult,
} from './store/maintenance.ts'
export type {
  StoreEnvironment,
  StoreInput,
  StoreKeyInventory,
  StoreOptions,
} from './store/maintenance.ts'
export { startAdoptedStoreReport } from './store/report.ts'
export { processOutput } from './output/process.ts'
export type { ProcessOutputOptions } from './output/discover.ts'
export { ImagePipelineError } from './shared/errors.ts'
export {
  mergeSourceRecords,
  parseSourceRecord,
  recordSourceImages,
  sourceImageRecordName,
  type RecordSourceImagesOptions,
} from './store/source-ledger.ts'
