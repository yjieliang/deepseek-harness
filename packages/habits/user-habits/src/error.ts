/**
 * Typed failures of the habits seam: one error class over a stable
 * lower-kebab-case code union, so tools route expected rejections without
 * string matching.
 *
 * @module @deepseek-ai/dsh-user-habits
 */

/** Structured failure codes the service throws through {@link HabitError}. */
export type HabitErrorCode =
  | 'invalid-topic'
  | 'invalid-value'
  | 'guard-injection'
  | 'guard-secret'
  | 'over-budget'
  | 'duplicate'
  | 'not-found'

/** Typed failure for every expected write/remove rejection. */
export class HabitError extends Error {
  /** Stable lower-kebab-case classification for routing and tools. */
  readonly code: HabitErrorCode

  /**
   * Create one typed habit failure.
   * @param code - stable machine-routable classification.
   * @param message - human- and model-readable explanation.
   */
  constructor(code: HabitErrorCode, message: string) {
    super(message)
    this.name = 'HabitError'
    this.code = code
  }
}
