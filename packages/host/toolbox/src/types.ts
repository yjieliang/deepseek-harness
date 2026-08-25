/**
 * Wire vocabulary of the developer toolbox endpoint.
 * Client-safe: plain JSON only, no branded ids, no service imports.
 */

/** One translation request. */
export interface ToolboxTranslateRequest {
  /** The source text to translate. */
  text: string
  /** Source language code (e.g. `auto`, `en`, `zh-CN`). */
  source: string
  /** Target language code (e.g. `zh-CN`, `en`). */
  target: string
  /** Which engine to use: `model` routes through the configured LLM, else the free API. */
  engine: 'api' | 'model'
}

/** One translation result. */
export interface ToolboxTranslateResult {
  /** The translated text, empty when the call failed. */
  text: string
  /** Human-readable failure message; present only when the call failed. */
  error?: string
}

/** One UUID generation request. */
export interface ToolboxUuidRequest {
  /** Number of UUIDs to generate, clamped to 1..100. */
  count: number
}

/** One UUID generation result. */
export interface ToolboxUuidResult {
  /** Time-ordered v1 UUIDs. */
  v1: string[]
  /** Random v4 UUIDs. */
  v4: string[]
  /** Human-readable failure message; present only when the call failed. */
  error?: string
}
