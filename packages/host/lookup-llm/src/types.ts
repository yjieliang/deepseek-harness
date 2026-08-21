/**
 * Wire vocabulary of the model-backed word explanation endpoint.
 * Client-safe: plain JSON only, no branded ids, no service imports.
 */

/** One request to explain a selected word. */
export interface LookupExplainRequest {
  /** The selected word or short phrase. */
  word: string
  /** Optional surrounding text of the selection, for a contextual explanation. */
  context?: string
}

/** One part-of-speech group of the explanation. */
export interface LookupExplainMeaning {
  /** Part-of-speech label, e.g. `noun`. */
  partOfSpeech: string
  /** Short definitions. */
  definitions: string[]
}

/** The model-generated translation and noun introduction. */
export interface LookupExplainResult {
  /** The word the explanation is about (echoed). */
  word: string
  /** Translation into the target language (Chinese for English words, English for Chinese words). */
  translation: string
  /** IPA phonetic, present only for English words. */
  phonetic?: string
  /** Part-of-speech groups, present only for English words. */
  meanings?: LookupExplainMeaning[]
  /** A 2-4 sentence noun introduction of the word or term. */
  explanation: string
}
