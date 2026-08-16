/**
 * The habits seam's nominal entry id: content-addressed as `layer:topic`, so
 * one topic owns at most one id per layer and every later write walks the
 * entry's `version` forward instead of appending a sibling. Branding keeps
 * habit ids from mixing with other cross-package ids.
 *
 * @module @deepseek-ai/dsh-user-habits
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one habit entry within its layer. */
export type HabitId = Branded<'HabitId'>

/**
 * Brand a validated habit-id string.
 * @param value - the exact `layer:topic` identity of one entry.
 * @returns the branded id (type-level only; no runtime cost).
 */
export function habitId(value: string): HabitId {
  return value as HabitId
}
