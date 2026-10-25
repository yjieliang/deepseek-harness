/** Request normalization, parameterized predicates, and result presentation. */

import {
  SessionQueryError,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
} from '@deepseek-ai/dsh-session-query'
import type {
  SessionAvailability,
  SessionEventMetadataFilter,
  SessionEventResultFilter,
  SessionEventSearchRequest,
  SessionResultFilter,
  SessionSearchCursor,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

/** Collision-free marker inserted before an FTS5 match by `highlight()`. */
export const FTS_HIGHLIGHT_START = '\uFDD0'
/** Collision-free marker inserted after an FTS5 match by `highlight()`. */
export const FTS_HIGHLIGHT_END = '\uFDD1'

/** Largest page size whose internal lookahead remains an exact SQLite integer binding. */
export const SQLITE_MAX_PAGE_LIMIT = Number.MAX_SAFE_INTEGER - 1

/** Portable host-parameter ceiling shared by predicate and statement builders. */
export const SQLITE_PORTABLE_VARIABLE_LIMIT = 32_766

/** Supported outer-predicate budget that keeps SQLite FTS5 MATCH usable. */
export const SQLITE_FTS5_OUTER_PREDICATE_LIMIT = 14

/**
 * Reject prospective SQLite binding growth beyond the portable ceiling.
 * @param count - binding count at the current construction boundary.
 */
export function assertPortableBindingCount(count: number): void {
  if (count > SQLITE_PORTABLE_VARIABLE_LIMIT) {
    throw new SessionQueryError(
      `session-search request exceeds SQLite's portable ${SQLITE_PORTABLE_VARIABLE_LIMIT}-variable limit; reduce filter values`,
      'SESSION_QUERY_INVALID_FILTER',
    )
  }
}

/**
 * Reject compiled outer predicates beyond the supported FTS5 planner budget.
 * @param count - predicate count including fixed statement predicates.
 */
export function assertFts5OuterPredicateCount(count: number): void {
  if (count > SQLITE_FTS5_OUTER_PREDICATE_LIMIT) {
    throw new SessionQueryError(
      `session-search request exceeds the supported SQLite FTS5 outer-predicate budget of ${SQLITE_FTS5_OUTER_PREDICATE_LIMIT}; reduce filters`,
      'SESSION_QUERY_INVALID_FILTER',
    )
  }
}

/** Limit defaults needed to normalize a search request. */
export interface QueryLimits {
  /** Page size used when the request omits one. */
  defaultLimit: number
  /** Largest accepted page size. */
  maxLimit: number
}

/** Normalized cross-session request. */
export interface NormalizedSessionRequest {
  query: string
  sessionFilters: readonly SessionResultFilter[]
  eventFilters: readonly SessionEventMetadataFilter[]
  limit: number
  cursor?: SessionSearchCursor
}

/** Normalized within-session request. */
export interface NormalizedEventRequest {
  sessionId: SessionEventSearchRequest['sessionId']
  query: string
  filters: readonly SessionEventMetadataFilter[]
  limit: number
  cursor?: SessionSearchCursor
}

/** Parameterized SQL predicate fragment. */
export interface SqlWhere {
  /** SQL without the leading `WHERE`. */
  sql: string
  /** Bindings in placeholder order. */
  params: Array<string | number>
  /** Number of compiled predicates in `sql`. */
  predicateCount: number
}

/**
 * Validate and canonicalize a cross-session request.
 * @param request - caller-provided query, filters, limit, and cursor.
 * @param limits - configured default and maximum page sizes.
 * @returns normalized request with explicit arrays and limit.
 */
export function normalizeSessionRequest(
  request: SessionSearchRequest,
  limits: QueryLimits,
): NormalizedSessionRequest {
  const sessionFilters = materializeSessionResultFilters(request.sessionFilters ?? [])
  const eventFilters = materializeMetadataFilters(request.eventFilters ?? [])
  const cursor = materializeCursor(request.cursor)
  return {
    query: normalizeQuery(request.query),
    sessionFilters,
    eventFilters,
    limit: normalizeLimit(request.limit, limits),
    ...cursor === undefined ? {} : { cursor },
  }
}

/**
 * Validate and canonicalize a within-session request.
 * @param request - caller-provided target, query, filters, limit, and cursor.
 * @param limits - configured default and maximum page sizes.
 * @returns normalized request with an explicit filter array and limit.
 */
export function normalizeEventRequest(
  request: SessionEventSearchRequest,
  limits: QueryLimits,
): NormalizedEventRequest {
  if (typeof request.sessionId !== 'string') {
    throw new SessionQueryError('session-search session id must be text', 'SESSION_QUERY_INVALID_FILTER')
  }
  const filters = materializeMetadataFilters(request.filters ?? [])
  const cursor = materializeCursor(request.cursor)
  return {
    sessionId: request.sessionId,
    query: normalizeQuery(request.query),
    filters,
    limit: normalizeLimit(request.limit, limits),
    ...cursor === undefined ? {} : { cursor },
  }
}

/**
 * Compile logical-session predicates against selected-document columns.
 * @param filters - validated ANDed logical-session clauses.
 * @returns parameterized SQL fragment and ordered bindings.
 */
export function buildSessionWhere(filters: readonly SessionResultFilter[]): SqlWhere {
  const clauses: string[] = []
  const params: Array<string | number> = []
  for (const filter of filters) {
    switch (filter.kind) {
      case 'id':
        addList(clauses, params, 'session_id', filter.values)
        break
      case 'cwd':
        addNullableList(clauses, params, 'cwd', filter.values)
        break
      case 'created-at':
        addRange(clauses, params, 'created_at', filter)
        break
      case 'parent':
        addNullableList(clauses, params, 'parent_session', filter.values)
        break
      case 'availability': {
        const availability = [...new Set(filter.values)]
        if (availability.length === 0) clauses.push('0')
        else if (availability.length === 1) {
          const value = availability[0] as SessionAvailability
          switch (value) {
            case 'live':
              clauses.push('live = 1')
              break
            case 'persisted':
              clauses.push('persisted = 1')
              break
            default:
              unknownAvailability(value)
          }
        }
        break
      }
      default:
        unknownFilter(filter)
    }
  }
  assertFts5OuterPredicateCount(clauses.length)
  return { sql: clauses.join(' AND '), params, predicateCount: clauses.length }
}

/**
 * Compile event metadata predicates against selected-document columns.
 * @param filters - validated ANDed event metadata clauses.
 * @returns parameterized SQL fragment and ordered bindings.
 */
export function buildEventWhere(filters: readonly SessionEventMetadataFilter[]): SqlWhere {
  const clauses: string[] = []
  const params: Array<string | number> = []
  for (const filter of filters) {
    switch (filter.kind) {
      case 'seq':
        addRange(clauses, params, 'seq', filter)
        break
      case 'time':
        addRange(clauses, params, 'time', filter)
        break
      case 'type':
        addList(clauses, params, 'type', filter.values)
        break
      case 'surface':
        addList(clauses, params, 'surface', filter.values)
        break
      default:
        unknownFilter(filter)
    }
  }
  assertFts5OuterPredicateCount(clauses.length)
  return { sql: clauses.join(' AND '), params, predicateCount: clauses.length }
}

/**
 * Quote caller text as one FTS5 phrase so query syntax remains inert data.
 * @param query - normalized caller query.
 * @returns FTS5 expression containing one escaped literal phrase.
 */
export function quoteFtsData(query: string): string {
  return `"${query.replaceAll('"', '""')}"`
}

/** Fewest code points a trigram index can match; shorter queries need a substring scan. */
export const SQLITE_TRIGRAM_MIN_CODEPOINTS = 3

/**
 * Most code points whose separator-free ASCII word still needs the scan route.
 *
 * A trigram `MATCH` needs {@link SQLITE_TRIGRAM_MIN_CODEPOINTS} code points, so a
 * shorter separator-free ASCII word has no index that can answer it: the word is too
 * long to be a single token boundary the primary index could reach when a CJK run has
 * swallowed it, and too short for the companion trigram. Exactly two code points is
 * the whole of that gap — see {@link isShortSeparatorFreeAsciiWord}.
 */
export const SQLITE_ASCII_SUBSTRING_MAX_CODEPOINTS = 2

/**
 * CJK ranges whose contiguous runs `unicode61` folds into a single token.
 *
 * The property escape covers every `Script=Han` ideograph, including the
 * supplementary-plane CJK extension blocks (U+20000 and above), because an
 * extension ideograph adjacent to a common one still forms one unmatchable
 * token. Japanese kana and Hangul ranges are listed explicitly: they behave the
 * same way under `unicode61` and are not part of `Script=Han`.
 *
 * Deliberately absent, so a future reader does not assume "CJK-adjacent" means
 * covered: Bopomofo (U+3105–U+312F, U+31A0–U+31BF), ideographic description
 * characters (U+2FF0–U+2FFF), Yijing hexagram symbols (U+4DC0–U+4DFF), enclosed
 * CJK letters and months (U+3200–U+32FF), CJK strokes (U+31C0–U+31EF), and
 * vertical punctuation (U+FE10–U+FE19). Those characters keep the primary
 * `unicode61` route, so an unseparated run containing them stays one token.
 */
/** Explicit non-Han CJK-adjacent ranges, kept separate to bound the pattern width. */
const CJK_COMPANION_RANGES = '\u1100-\u11ff\u2e80-\u2fdf\u3000-\u30ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff\ufe30-\ufe4f\uff00-\uffef'

const CJK_PATTERN = new RegExp(`[\\p{Script=Han}${CJK_COMPANION_RANGES}]`, 'u')

/**
 * Whether text contains a character the primary tokenizer folds into a CJK run.
 * @param text - extracted document text.
 * @returns true when the companion trigram index must also carry this document.
 */
export function containsCjk(text: string): boolean {
  return CJK_PATTERN.test(text)
}

/** Which engine answers one normalized query. */
export type SqliteQueryRoute =
  /** CJK substring match through the companion contentless trigram index. */
  | 'cjk-trigram'
  /** CJK query shorter than a trigram: a substring scan over the primary table. */
  | 'cjk-substring'
  /** The primary `unicode61` full-text index; token-adjacency semantics, unchanged. */
  | 'primary'
  /**
   * The primary `unicode61` index UNION a companion trigram probe — additive, never
   * a replacement. It exists for the one shape whose primary hits must be kept while
   * a neighbouring CJK run may have swallowed it: see
   * {@link widensToCompanionTrigram}.
   */
  | 'primary-cjk-trigram'
  /**
   * A literal substring scan of the primary table for a separator-free ASCII word too
   * short for the companion trigram, UNIONed with the primary `MATCH` — additive, never a
   * replacement, so a two-code-point query keeps whatever the tokenizer already answered
   * while gaining the glued-in-CJK hits it could not reach: see
   * {@link isShortSeparatorFreeAsciiWord}.
   */
  | 'ascii-substring'

/**
 * A word spelled only with ASCII letters and digits: no whitespace, no separator.
 *
 * This is the shape a reader means as one word, and the shape `unicode61` folds
 * together with an adjacent CJK run.
 */
const SEPARATOR_FREE_ASCII_WORD = /^[0-9A-Za-z]+$/u

/**
 * Whether a non-CJK query must ALSO probe the companion trigram index.
 *
 * `unicode61` folds an unseparated run such as `本次DSH会话检索修复已完成` into the
 * single token `本次dsh会话检索修复已完成`, so `DSH` is unreachable through the
 * primary index even though the document plainly contains it.
 *
 * The widening is deliberately limited to a separator-free ASCII word of at least
 * {@link SQLITE_TRIGRAM_MIN_CODEPOINTS} code points, because that shape is both
 * unambiguous — no token boundary is being reinterpreted — and indexable. Every
 * other non-CJK query keeps `primary`, and that is what "no regression" means
 * concretely:
 *
 * - a separator-bearing query (`session-query`, `packages/session-query`, `v2.1`,
 *   `a_b`) keeps token-adjacency semantics the literal trigram engine cannot
 *   express — it matches a document spelled `SESSION_QUERY` through neighbouring
 *   tokens, which a substring engine would lose;
 * - a query with an internal space (`DSH tool`) is a phrase, not one word;
 * - a two-code-point word (`AI`, `v2`) cannot use trigram at all, because a trigram
 *   `MATCH` against fewer than three code points returns the empty set without error.
 *
 * The pairing predicate is additive, never a replacement: the primary `MATCH` and the
 * companion probe each contribute row ids, and the union drives the scan, so the
 * result set only ever grows, and only inside documents the companion index holds. It
 * is a row-id union rather than a single `... OR ...` predicate because SQLite refuses
 * a `MATCH` that sits inside an `OR` in this statement shape.
 * @param query - normalized caller query that contains no CJK.
 * @returns true when the caller must also probe the companion index.
 */
export function widensToCompanionTrigram(query: string): boolean {
  return Array.from(query).length >= SQLITE_TRIGRAM_MIN_CODEPOINTS
    && SEPARATOR_FREE_ASCII_WORD.test(query)
}

/**
 * Whether a non-CJK query must fall back to a literal substring scan.
 *
 * A separator-free ASCII word shorter than {@link SQLITE_TRIGRAM_MIN_CODEPOINTS} has no
 * index that can answer it. `unicode61` folds an unseparated run such as
 * `实时AI推理已完成` into the single token `实时ai推理已完成`, so the primary index cannot
 * reach `AI` inside it; the companion trigram index cannot help either, because a
 * trigram `MATCH` against fewer than three code points returns the empty set rather
 * than an error. This is the residual gap left by {@link widensToCompanionTrigram},
 * and the case the requirement names (`AI`, `v2`, `5G`).
 *
 * The scan is deliberately limited to exactly two code points of an unseparated ASCII
 * word, because that shape is the smallest one a reader spells as a word:
 *
 * - a single code point is not bounded here; it is left on the primary route so a
 *   one-character query keeps whatever the tokenizer already answers (`a` still matches
 *   the token `a`), rather than scanning the whole index;
 * - three or more code points already widen additively through the companion trigram,
 *   which is indexable and keeps the primary hits;
 * - a separator-bearing query (`session-query`, `v2.1`, `a_b`) is not one word, and its
 *   token-adjacency semantics must stay on the primary index.
 *
 * The scan is **case-sensitive**, which is a deliberate semantic, not an oversight:
 * SQLite's `LIKE` folds ASCII case and, in the same breath, treats `%`/`_` as wildcards
 * and matches inside longer words. `instr()` is a literal, case-sensitive test, so `AI`
 * matches `实时AI推理已完成` without also matching `plain ascii document` or `本次ai工具`.
 * The cost is that a case-mismatched spelling reaches the caller unmarked, exactly as the
 * additive route already documents for its companion-only rows.
 * @param query - normalized caller query that contains no CJK.
 * @returns true when the caller must scan the primary table instead of matching it.
 */
export function isShortSeparatorFreeAsciiWord(query: string): boolean {
  const length = Array.from(query).length
  return SEPARATOR_FREE_ASCII_WORD.test(query)
    && length > 1
    && length <= SQLITE_ASCII_SUBSTRING_MAX_CODEPOINTS
}

/**
 * Route a normalized query to the engine that can answer it.
 *
 * Only queries containing CJK leave the primary index entirely. CJK queries shorter
 * than {@link SQLITE_TRIGRAM_MIN_CODEPOINTS} cannot use `MATCH` at all — a trigram
 * `MATCH` against fewer than three code points returns the empty set without error —
 * so they fall back to a substring scan. A non-CJK query leaves the primary index
 * additively through `primary-cjk-trigram` for the shape
 * {@link widensToCompanionTrigram} accepts, and entirely through `ascii-substring` for
 * the shorter shape {@link isShortSeparatorFreeAsciiWord} accepts.
 * @param query - normalized caller query.
 * @returns the route whose predicate and bindings must be used.
 */
export function routeSqliteQuery(query: string): SqliteQueryRoute {
  if (!CJK_PATTERN.test(query)) {
    if (isShortSeparatorFreeAsciiWord(query)) return 'ascii-substring'
    return widensToCompanionTrigram(query) ? 'primary-cjk-trigram' : 'primary'
  }
  return Array.from(query).length < SQLITE_TRIGRAM_MIN_CODEPOINTS ? 'cjk-substring' : 'cjk-trigram'
}

/**
 * Escape caller text for a `LIKE` pattern with `ESCAPE '\'`.
 * @param query - normalized caller query.
 * @returns pattern-safe body; callers wrap it in `%` themselves.
 */
export function escapeLikePattern(query: string): string {
  return query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/**
 * Remove reserved marker collisions before text enters FTS5 or MATCH.
 * @param text - extracted document text or normalized caller query.
 * @returns text with reserved noncharacters mapped to replacement characters.
 */
export function sanitizeFtsText(text: string): string {
  return text
    .replaceAll('\0', '\uFFFD')
    .replaceAll(FTS_HIGHLIGHT_START, '\uFFFD')
    .replaceAll(FTS_HIGHLIGHT_END, '\uFFFD')
}

/**
 * Build the stable normalized request identity stored in opaque cursors.
 * @param request - normalized request whose filter ordering is canonicalized.
 * @returns deterministic JSON identity for cursor binding.
 */
export function requestFingerprint(request: NormalizedSessionRequest | NormalizedEventRequest): string {
  if ('sessionId' in request) {
    return JSON.stringify({
      scope: 'events',
      sessionId: request.sessionId,
      query: request.query,
      filters: canonicalFilters(request.filters),
      limit: request.limit,
    })
  }
  return JSON.stringify({
    scope: 'sessions',
    query: request.query,
    sessionFilters: canonicalFilters(request.sessionFilters),
    eventFilters: canonicalFilters(request.eventFilters),
    limit: request.limit,
  })
}

/**
 * Build a whitespace-normalized excerpt no longer than `maxChars`.
 * @param markedText - complete document with FTS5 `highlight()` markers.
 * @param maxChars - maximum result length in Unicode code points.
 * @returns bounded plain-text snippet.
 */
export function makeSnippet(markedText: string, maxChars: number): string {
  const { text: clean, matchStart } = normalizeMarkedText(markedText)
  const characters = Array.from(clean)
  if (characters.length <= maxChars) return clean
  if (maxChars === 1) return '…'
  const matchedIndex = Math.min(matchStart, characters.length - 1)
  let start = Math.max(0, matchedIndex - Math.floor(maxChars / 3))
  const prefix = start > 0 ? '…' : ''
  let suffix = '…'
  let contentLength = maxChars - prefix.length - suffix.length
  if (contentLength < 1) {
    start = matchedIndex
    suffix = ''
    contentLength = maxChars - prefix.length - suffix.length
  } else if (matchedIndex >= start + contentLength) {
    start = matchedIndex - contentLength + 1
  }
  let end = Math.min(characters.length, start + contentLength)
  if (end === characters.length) {
    suffix = ''
    contentLength = maxChars - prefix.length
    start = Math.max(0, end - contentLength)
  }
  end = Math.min(characters.length, start + contentLength)
  return `${prefix}${characters.slice(start, end).join('')}${suffix}`
}

function normalizeMarkedText(markedText: string): { text: string; matchStart: number } {
  const characters: string[] = []
  let matchStart: number | undefined
  for (const character of markedText) {
    if (character === FTS_HIGHLIGHT_START) {
      matchStart ??= characters.length
      continue
    }
    if (character === FTS_HIGHLIGHT_END) continue
    if (/\s/u.test(character)) {
      if (characters.length > 0 && characters.at(-1) !== ' ') characters.push(' ')
    } else {
      characters.push(character)
    }
  }
  if (characters.at(-1) === ' ') characters.pop()
  return {
    text: characters.join(''),
    matchStart: matchStart ?? 0,
  }
}

function normalizeQuery(value: string): string {
  if (typeof value !== 'string') {
    throw new SessionQueryError('session-search query must be text', 'SESSION_QUERY_INVALID_QUERY')
  }
  const query = value.trim().replace(/\s+/gu, ' ')
  if (query.length === 0) {
    throw new SessionQueryError(
      'session-search query must contain non-whitespace text',
      'SESSION_QUERY_INVALID_QUERY',
    )
  }
  if (query.includes('\0')) {
    throw new SessionQueryError(
      'session-search query must not contain NUL',
      'SESSION_QUERY_INVALID_QUERY',
    )
  }
  return sanitizeFtsText(query)
}

function materializeCursor(cursor: SessionSearchCursor | undefined): SessionSearchCursor | undefined {
  if (cursor === undefined) return undefined
  if (typeof cursor !== 'string') {
    throw new SessionQueryError('session-search cursor must be text', 'SESSION_QUERY_INVALID_CURSOR')
  }
  return cursor
}

function materializeMetadataFilters(
  filters: readonly SessionEventMetadataFilter[],
): SessionEventMetadataFilter[] {
  const candidates: readonly SessionEventResultFilter[] = filters
  for (const filter of candidates) {
    switch (filter.kind) {
      case 'seq':
      case 'time':
      case 'type':
      case 'surface':
        break
      case 'text':
        throw new SessionQueryError(
          'session-search metadata filters do not accept text clauses',
          'SESSION_QUERY_INVALID_FILTER',
        )
      default:
        unknownFilter(filter)
    }
  }
  return materializeSessionEventResultFilters(filters) as SessionEventMetadataFilter[]
}

function normalizeLimit(value: number | undefined, limits: QueryLimits): number {
  const limit = value ?? limits.defaultLimit
  const maxLimit = Math.min(limits.maxLimit, SQLITE_MAX_PAGE_LIMIT)
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > maxLimit
  ) {
    throw new SessionQueryError(
      `session-search limit must be an integer between 1 and ${maxLimit}`,
      'SESSION_QUERY_INVALID_LIMIT',
    )
  }
  return limit
}

function addList(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  values: readonly (string | number)[],
): void {
  if (values.length === 0) {
    clauses.push('0')
    return
  }
  clauses.push(`${column} IN (${appendListBindings(params, values)})`)
}

function addNullableList(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  values: readonly (string | null)[],
): void {
  if (values.length === 0) {
    clauses.push('0')
    return
  }
  const concrete = values.filter((value): value is string => value !== null)
  const parts: string[] = []
  if (concrete.length > 0) {
    parts.push(`${column} IN (${appendListBindings(params, concrete)})`)
  }
  if (values.includes(null)) parts.push(`${column} IS NULL`)
  clauses.push(`(${parts.join(' OR ')})`)
}

function addRange(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  range: { from?: number; to?: number },
): void {
  if (range.from !== undefined) {
    assertPortableBindingCount(params.length + 1)
    clauses.push(`CAST(${column} AS INTEGER) >= ?`)
    params.push(range.from)
  }
  if (range.to !== undefined) {
    assertPortableBindingCount(params.length + 1)
    clauses.push(`CAST(${column} AS INTEGER) <= ?`)
    params.push(range.to)
  }
}

function appendListBindings(
  params: Array<string | number>,
  values: readonly (string | number)[],
): string {
  assertPortableBindingCount(params.length + values.length)
  for (const value of values) params.push(value)
  return values.map(() => '?').join(', ')
}

function canonicalFilters(filters: readonly (SessionResultFilter | SessionEventMetadataFilter)[]): unknown[] {
  return filters.map((filter) => {
    if ('values' in filter) {
      return { ...filter, values: [...filter.values].sort(compareNullable) }
    }
    return {
      kind: filter.kind,
      from: filter.from ?? null,
      to: filter.to ?? null,
    }
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a.localeCompare(b)
}

function unknownAvailability(value: never): never {
  throw new SessionQueryError(
    `session availability filter contains unknown value "${String(value)}"`,
    'SESSION_QUERY_INVALID_FILTER',
  )
}

function unknownFilter(filter: never): never {
  const kind = (filter as { kind?: unknown }).kind
  throw new SessionQueryError(
    `session filter contains unknown kind ${typeof kind === 'string' ? `"${kind}"` : '(missing)'}`,
    'SESSION_QUERY_INVALID_FILTER',
  )
}
