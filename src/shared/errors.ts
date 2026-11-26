type SvgInlineErrorCode =
  | 'SVG_INLINE_INVALID_SOURCE'
  | 'SVG_INLINE_INVALID_ID'
  | 'SVG_INLINE_DUPLICATE_ID'
  | 'SVG_INLINE_UNSAFE_ATTRIBUTE'
  | 'SVG_INLINE_UNSAFE_ELEMENT'
  | 'SVG_INLINE_OPTIMIZE_FAILED'
  | 'SVG_INLINE_DANGLING_ID_REFERENCE'

type ImagePipelineErrorCode =
  | 'INVALID_COMMAND'
  | 'INVALID_STORE_KEY'
  | 'INVALID_STORE_ENVIRONMENT'
  | 'INCOMPLETE_STORE_INPUTS'
  | 'STORE_TRIAL_NOT_FOUND'
  | SvgInlineErrorCode

export class ImagePipelineError extends Error {
  override readonly name = 'ImagePipelineError'
  readonly code: ImagePipelineErrorCode

  constructor(code: ImagePipelineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

export function failInlineSvg(code: SvgInlineErrorCode, message: string, cause?: unknown): never {
  const description = code.slice('SVG_INLINE_'.length).toLowerCase().replaceAll('_', '-')
  throw new ImagePipelineError(code, `[svg-inline:${description}] ${message}`, { cause })
}
