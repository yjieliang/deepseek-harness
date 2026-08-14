/** Browser-side word lookup: direction detection, free sources, result assembly. */

export type LookupDirection = 'en-zh' | 'zh-en'

/** One part-of-speech group of the selected word. */
export interface LookupMeaning {
  /** Part-of-speech label, e.g. `noun`; may be empty when the source omits it. */
  partOfSpeech: string
  /** Definition lines, capped per group. */
  definitions: string[]
}

/** Complete lookup outcome: every available facet plus per-source failures. */
export interface LookupResult {
  word: string
  direction: LookupDirection
  /** Machine translation of the word (MyMemory). */
  translation?: string
  /** IPA phonetic when an English dictionary entry exists. */
  phonetic?: string
  /** Part-of-speech groups from the English dictionary. */
  meanings?: LookupMeaning[]
  /** Encyclopedia first-paragraph noun introduction (Wikipedia). */
  intro?: string
  /** Wikipedia page title behind `intro`. */
  introTitle?: string
  /** Wikipedia desktop page URL behind `intro`. */
  introUrl?: string
  /** Human-readable failures of the optional sources; absent means all succeeded or were irrelevant. */
  errors: string[]
}

/** Detect the translation direction: CJK text translates to English, other text to Chinese. */
export function detectDirection(text: string): LookupDirection {
  return /[\u3400-\u9fff]/.test(text) ? 'zh-en' : 'en-zh'
}

/** Fetch failure carrying the HTTP status; 404 means "no entry", not a broken service. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

/** True when a fetch failure means the queried term has no entry (an ordinary miss). */
export function isNotFound(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404
}

/** Fetch one JSON endpoint, throwing an {@link HttpError} on non-OK responses. */
export async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new HttpError(response.status)
  return response.json() as Promise<unknown>
}

/** Narrow an unknown MyMemory response to its translated text. */
export function parseMyMemory(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const data = payload as { responseData?: { translatedText?: unknown } }
  const text = data.responseData?.translatedText
  return typeof text === 'string' && text.length > 0 ? text : undefined
}

/** Narrow an unknown Free Dictionary entry to the facets the card renders. */
export function parseFreeDictionary(payload: unknown): { phonetic?: string; meanings: LookupMeaning[] } | undefined {
  const entries = Array.isArray(payload) ? payload as Array<{
    phonetic?: unknown
    phonetics?: Array<{ text?: unknown }>
    meanings?: Array<{
      partOfSpeech?: unknown
      definitions?: Array<{ definition?: unknown }>
    }>
  }> : undefined
  const entry = entries?.[0]
  if (entry === undefined) return undefined
  const phoneticText = entry.phonetics?.find(item => typeof item.text === 'string' && item.text.length > 0)?.text
  const phoneticValue = typeof entry.phonetic === 'string' && entry.phonetic.length > 0
    ? entry.phonetic
    : typeof phoneticText === 'string' ? phoneticText : undefined
  const meanings: LookupMeaning[] = []
  for (const meaning of entry.meanings ?? []) {
    const definitions = (meaning.definitions ?? [])
      .map(item => item.definition)
      .filter((definition): definition is string => typeof definition === 'string' && definition.length > 0)
      .slice(0, 3)
    if (definitions.length === 0) continue
    meanings.push({
      partOfSpeech: typeof meaning.partOfSpeech === 'string' ? meaning.partOfSpeech : '',
      definitions,
    })
    if (meanings.length >= 3) break
  }
  return {
    ...(phoneticValue !== undefined ? { phonetic: phoneticValue } : {}),
    meanings,
  }
}

/** Narrow an unknown Wikipedia REST summary to the extract the card renders. */
export function parseWikipedia(payload: unknown): { extract?: string; title?: string; url?: string } | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const page = payload as {
    type?: unknown
    extract?: unknown
    title?: unknown
    content_urls?: { desktop?: { page?: unknown } }
  }
  if (page.type !== 'standard') return undefined
  const extract = page.extract
  if (typeof extract !== 'string' || extract.length === 0) return undefined
  const url = page.content_urls?.desktop?.page
  const title = typeof page.title === 'string' ? page.title : undefined
  return {
    extract,
    ...(title !== undefined ? { title } : {}),
    ...(typeof url === 'string' ? { url } : {}),
  }
}

/** Narrow an unknown Google Translate gtx response to its translated text. */
export function parseGoogleTranslate(payload: unknown): string | undefined {
  if (!Array.isArray(payload)) return undefined
  const outer = payload as unknown[]
  const segments = outer[0]
  if (!Array.isArray(segments)) return undefined
  const text = (segments as unknown[])
    .map(segment => Array.isArray(segment) ? (segment as unknown[])[0] : undefined)
    .filter((part): part is string => typeof part === 'string')
    .join('')
  return text.length > 0 ? text : undefined
}

/** One source adapter; the default implementation calls the free endpoints. */
export interface LookupSources {
  /** Translate `word` between the two language codes. */
  translate(from: string, to: string, word: string, signal: AbortSignal): Promise<string | undefined>
  /** English dictionary entry (phonetic + part-of-speech groups). */
  dictionary(word: string, signal: AbortSignal): Promise<{ phonetic?: string; meanings: LookupMeaning[] } | undefined>
  /** Encyclopedia summary for `term` on the given Wikipedia language. */
  wikipedia(lang: string, term: string, signal: AbortSignal): Promise<{ extract?: string; title?: string; url?: string } | undefined>
}

/** Real network sources (CORS-enabled free APIs). */
export const defaultLookupSources: LookupSources = {
  // Google Translate (unofficial gtx endpoint) first: better quality and far
  // fewer rate limits than the anonymous MyMemory quota; MyMemory stays as the
  // fallback so a Google outage is not a translation failure.
  translate: async (from, to, word, signal) => {
    const encoded = encodeURIComponent(word)
    const google = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encoded}`
    try {
      const translated = parseGoogleTranslate(await fetchJson(google, signal))
      if (translated !== undefined) return translated
    } catch {
      // Swallowed on purpose: a Google failure is not a translation failure
      // while the MyMemory fallback below can still answer.
    }
    return parseMyMemory(
      await fetchJson(`https://api.mymemory.translated.net/get?q=${encoded}&langpair=${from}|${to}`, signal),
    )
  },
  dictionary: async (word, signal) => parseFreeDictionary(
    await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, signal),
  ),
  wikipedia: async (lang, term, signal) => parseWikipedia(
    await fetchJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`, signal),
  ),
}

/** One source attempt outcome. */
type Attempt<T> =
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }
  | { status: 'miss' }

/** Retryable failure: HTTP 429 (rate limited) or a network-level fetch failure. */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 429
  return error instanceof Error && error.message === 'Failed to fetch'
}

/** One-shot backoff pause before a retry. */
function backoff(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Backoff before one automatic retry of a rate-limited or dropped request. */
const RETRY_DELAY_MS = 600

/** Decide whether a failure is an ordinary miss under the quiet policy. */
function isQuiet(quiet: boolean | ((error: unknown) => boolean), error: unknown): boolean {
  return quiet === true || (typeof quiet === 'function' && quiet(error))
}

/** Render any thrown value as a message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one source call, folding failures into the result instead of throwing.
 * A rate-limited (429) or network-dropped first attempt is retried once after
 * a short backoff.
 * @param run - the source call.
 * @param quiet - treat failure as silence (an ordinary miss) rather than a
 * user-visible error; a predicate narrows that to specific failures.
 * @returns the attempt outcome.
 */
async function attempt<T>(
  run: () => Promise<T>,
  quiet: boolean | ((error: unknown) => boolean),
): Promise<Attempt<T>> {
  try {
    return { status: 'ok', value: await run() }
  } catch (error) {
    if (isRetryable(error)) {
      await backoff(RETRY_DELAY_MS)
      try {
        return { status: 'ok', value: await run() }
      } catch (retryError) {
        if (isQuiet(quiet, retryError)) return { status: 'miss' }
        return { status: 'error', message: messageOf(retryError) }
      }
    }
    if (isQuiet(quiet, error)) return { status: 'miss' }
    return { status: 'error', message: messageOf(error) }
  }
}

/** Copy the non-undefined facets of a dictionary entry onto the result. */
function applyDictionary(
  result: LookupResult,
  dictionary: Attempt<{ phonetic?: string; meanings: LookupMeaning[] } | undefined>,
): void {
  if (dictionary.status !== 'ok' || dictionary.value === undefined) return
  const value = dictionary.value
  if (value.phonetic !== undefined) result.phonetic = value.phonetic
  result.meanings = value.meanings
}

/** Copy the non-undefined facets of a Wikipedia summary onto the result. */
function applyIntro(
  result: LookupResult,
  intro: Attempt<{ extract?: string; title?: string; url?: string } | undefined>,
): void {
  if (intro.status !== 'ok' || intro.value === undefined) return
  const value = intro.value
  if (value.extract !== undefined) result.intro = value.extract
  if (value.title !== undefined) result.introTitle = value.title
  if (value.url !== undefined) result.introUrl = value.url
}

/**
 * Look up one selected word through the free sources.
 * @param word - the selected text, already trimmed.
 * @param sources - source adapters (real network by default).
 * @param signal - cancellation for all in-flight fetches.
 * @returns the assembled result; individual source failures never reject.
 */
export async function lookupWord(word: string, sources: LookupSources, signal: AbortSignal): Promise<LookupResult> {
  const direction = detectDirection(word)
  const result: LookupResult = { word, direction, errors: [] }
  if (direction === 'en-zh') {
    const [translation, dictionary, intro] = await Promise.all([
      attempt(() => sources.translate('en', 'zh-CN', word, signal), false),
      // A word without a dictionary entry (404) is an ordinary miss, not a failure.
      attempt(() => sources.dictionary(word, signal), isNotFound),
      // A word without a Wikipedia page is an ordinary miss, not a failure.
      attempt(() => sources.wikipedia('en', word, signal), true),
    ])
    if (translation.status === 'error') result.errors.push(translation.message)
    if (dictionary.status === 'error') result.errors.push(dictionary.message)
    if (translation.status === 'ok' && translation.value !== undefined) result.translation = translation.value
    applyDictionary(result, dictionary)
    applyIntro(result, intro)
    return result
  }
  const [translation, intro] = await Promise.all([
    attempt(() => sources.translate('zh-CN', 'en', word, signal), false),
    attempt(() => sources.wikipedia('zh', word, signal), true),
  ])
  if (translation.status === 'error') result.errors.push(translation.message)
  if (translation.status === 'ok' && translation.value !== undefined) result.translation = translation.value
  applyIntro(result, intro)
  return result
}
