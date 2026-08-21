/**
 * The habits write guard: pure, deterministic validation every value passes
 * before a provider persists it. This module is the ONLY enforcement point —
 * tools and commands may soften presentation, but they cannot bypass these
 * checks, so a rejected value fails identically from every caller.
 *
 * Habits are a persistent prompt entry point: their content reaches future
 * model contexts, so the guard is stricter than ordinary chat text.
 *
 * The guard is source-layered: agent-proposed content is always hard-rejected;
 * a user-authored value may pass with `userConfirmed` (a human has seen the
 * warning and confirmed), in which case hostile-looking content is admitted
 * while invisible characters are still stripped and the budget still holds.
 *
 * @module @deepseek-ai/dsh-user-habits
 */

import { HabitError } from './error.ts'
import type { HabitSource } from './types.ts'

/** Zero-width and control-format characters commonly abused for injection. */
const INVISIBLE_CHARACTER = /[\u200B-\u200D\u2028-\u202E\u2060-\u2064\uFEFF\u00AD]/u

/** Manipulative instruction shapes that never belong in a durable habit. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override)\s+(all\s+)?(previous|prior|preceding|earlier)\s+(instructions|rules|constraints|habits)/iu,
  /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be|roleplay\s+as)\b/iu,
  /<(system|developer|user|assistant)[\s>]/iu,
]

/** Credential-shaped content that a habit value must never carry. */
const SECRET_KEYWORD = /(api[\s_-]?key|access[\s_-]?token|password|passwd|secret|private[\s_-]?key|密码|密钥|私钥)/iu

/** Long opaque token shapes (base64/hex-like runs) that indicate secrets. */
const SECRET_SHAPE = /[A-Za-z0-9+/]{32,}={0,2}/u

/**
 * Normalize one habit value to its canonical persisted form.
 * @param raw - the raw value text.
 * @returns the NFKC-normalized, trimmed value.
 */
export function normalizeHabitValue(raw: string): string {
  return raw.normalize('NFKC').trim()
}

/** Remove invisible control characters (sanitization, never an override path). */
function stripInvisible(value: string): string {
  return value.replace(new RegExp(INVISIBLE_CHARACTER.source, 'gu'), '')
}

/** Whether a raw value carries invisible control characters. */
function hasInvisible(raw: string): boolean {
  return INVISIBLE_CHARACTER.test(raw)
}

/**
 * Validate one raw habit value against every guard rule EXCEPT the character
 * budget and return its canonical form. Proposers pre-check candidate content
 * with this before asking a human to confirm; the full write-time guard
 * {@link guardHabitValue} re-applies these rules plus the budget.
 * @param raw - the raw value text.
 * @returns the normalized, validated value.
 */
export function guardHabitContent(raw: string): string {
  if (hasInvisible(raw)) {
    throw new HabitError('guard-injection', 'habit value contains invisible control characters')
  }
  const value = normalizeHabitValue(raw)
  if (value.length === 0) {
    throw new HabitError('invalid-value', 'habit value must be non-empty')
  }
  if (INJECTION_PATTERNS.some(pattern => pattern.test(value))) {
    throw new HabitError('guard-injection', 'habit value matches a prompt-injection pattern')
  }
  if (SECRET_KEYWORD.test(value) || SECRET_SHAPE.test(value)) {
    throw new HabitError('guard-secret', 'habit value matches a secret or credential pattern')
  }
  return value
}

/**
 * Validate one raw habit value under the source-layered guard and return its
 * canonical form. Normalization, invisible-character stripping, non-emptiness,
 * and the character budget always apply. The injection and secret patterns
 * hard-reject agent-proposed content; a user-authored value passes them only
 * with {@link userConfirmed}.
 * @param raw - the raw value text.
 * @param maxEntryChars - per-entry character budget (code points).
 * @param source - who authored the content.
 * @param userConfirmed - true when a human saw the guard warning and confirmed.
 * @returns the normalized, validated (possibly sanitized) value.
 */
export function guardHabitValue(
  raw: string,
  maxEntryChars: number,
  source: HabitSource,
  userConfirmed = false,
): string {
  const overridable = source === 'user' && userConfirmed
  if (hasInvisible(raw) && !overridable) {
    throw new HabitError('guard-injection', 'habit value contains invisible control characters')
  }
  const value = stripInvisible(normalizeHabitValue(raw))
  if (value.length === 0) {
    throw new HabitError('invalid-value', 'habit value must be non-empty')
  }
  if (!overridable) {
    if (INJECTION_PATTERNS.some(pattern => pattern.test(value))) {
      throw new HabitError('guard-injection', 'habit value matches a prompt-injection pattern')
    }
    if (SECRET_KEYWORD.test(value) || SECRET_SHAPE.test(value)) {
      throw new HabitError('guard-secret', 'habit value matches a secret or credential pattern')
    }
  }
  const length = Array.from(value).length
  if (length > maxEntryChars) {
    throw new HabitError('over-budget', `habit value is ${length} characters, above the ${maxEntryChars} limit`)
  }
  return value
}
