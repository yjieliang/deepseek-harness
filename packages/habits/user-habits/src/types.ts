/**
 * Pure vocabulary of the habits seam: the entry model, write requests, and
 * the seam's Cordis event declaration. Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-user-habits/types
 */

import type { HabitId } from './brand.ts'

/** The habit's ownership layer. */
export type HabitLayer = 'global' | 'project'

/** Who authored the habit's final content; both settle on user confirmation. */
export type HabitSource = 'user' | 'agent-proposed'

/** How one committed habit mutation changed the store. */
export type HabitOp = 'add' | 'update' | 'remove'

/** One committed habit entry, immutable after the provider persisted it. */
export interface HabitEntry {
  /** Content-addressed `layer:topic` identity. */
  readonly id: HabitId
  /** Ownership layer. */
  readonly layer: HabitLayer
  /** Stable topic key (lower kebab-case). */
  readonly topic: string
  /** Normalized, guard-validated value text. */
  readonly value: string
  /** Final author; both sources settle on user confirmation. */
  readonly source: HabitSource
  /**
   * Present only when a human confirmed content that would otherwise fail
   * the content guard. Settings-level validation must let such entries pass
   * the content check so a confirmed override survives re-validation.
   */
  readonly guardConfirmed?: true
  /** Positive integer bumped by every write to this entry's id. */
  readonly version: number
  /** Epoch milliseconds of the committed write. */
  readonly updatedAt: number
}

/** Validated input for {@link HabitService.write}. */
export interface HabitWriteRequest {
  /** Ownership layer of the new or replaced entry. */
  readonly layer: HabitLayer
  /** Stable topic key (lower kebab-case). */
  readonly topic: string
  /** Raw value; the guard normalizes and validates it. */
  readonly value: string
  /** Final author of the content. */
  readonly source: HabitSource
}

/** Outcome of one accepted write. */
export interface HabitWriteOutcome {
  /** The committed entry. */
  readonly entry: HabitEntry
  /** How the entry changed. */
  readonly op: 'add' | 'update'
  /** The shadowed previous entry on update; absent on add. */
  readonly replaced?: HabitEntry
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One durable habit mutation settled: the exact committed entry and the
     * operation it entered by. Emitted strictly after the provider persisted
     * the change, so the store state already reflects the entry when listeners
     * run — consumers read the authoritative data stream, never the payload
     * alone.
     * @param entry - the committed entry (a remove carries the removed value).
     * @param op - how the entry changed.
     * @mode emit
     */
    'user-habits/committed'(entry: HabitEntry, op: HabitOp): void
  }
}
