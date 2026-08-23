/**
 * User-habit memory seam: the abstract `HabitStore` contract every provider
 * implements. The service owns what belongs to the contract — the write-time
 * guard, deterministic topic consolidation, version bumping, the
 * `user-habits/committed` commit event, and the canonical resident-section
 * rendering — while providers own only storage (persist/list/remove).
 *
 * @module @deepseek-ai/dsh-user-habits
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { habitId } from './brand.ts'
import type { HabitId } from './brand.ts'
import { guardHabitContent, guardHabitValue } from './guard.ts'
import { HabitError } from './error.ts'
import type {
  HabitEntry,
  HabitLayer,
  HabitWriteOutcome,
  HabitWriteRequest,
} from './types.ts'

export { HabitError } from './error.ts'
export type { HabitErrorCode } from './error.ts'
export { guardHabitContent, guardHabitValue, normalizeHabitValue } from './guard.ts'
export { habitId } from './brand.ts'
export type { HabitId } from './brand.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    habits: HabitService
  }
}

/** Topic keys are stable lower kebab-case atoms, one per entry. */
export const TOPIC_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u

/** Deployment configuration of the contract layer. */
export interface Config {
  /** Per-entry character budget (code points) enforced by the guard. */
  maxEntryChars?: number
}

/** Contract defaults after validation. */
export interface ResolvedConfig {
  /** Per-entry character budget (code points) enforced by the guard. */
  maxEntryChars: number
}

/**
 * The habits contract service (`ctx.habits`). Providers extend this class and
 * implement the three storage hooks; consumers (tools, commands, prompt
 * sections) depend on the concrete class only through this contract.
 */
export abstract class HabitService extends Service {
  static Config: z<Config> = z.object({
    maxEntryChars: z.number().min(1).default(200),
  })

  protected readonly resolved: ResolvedConfig

  protected constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'habits')
    this.resolved = { maxEntryChars: config.maxEntryChars ?? 200 }
  }

  /**
   * List committed entries in stable id order, optionally filtered to one layer.
   * @param layer - optional ownership layer filter.
   * @returns a fresh frozen array over the provider's current state.
   */
  list(layer?: HabitLayer): readonly HabitEntry[] {
    const entries = layer === undefined
      ? this.listAll()
      : this.listAll().filter(entry => entry.layer === layer)
    return Object.freeze([...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
  }

  /**
   * Validate, consolidate, persist, and commit one habit write. The guard
   * hard-rejects hostile agent-proposed values and rejects user-authored
   * hostile-looking values unless a human confirmed the warning; the budget
   * always holds. Deterministic consolidation replaces the same-topic entry
   * instead of appending a sibling, and an unchanged value is rejected as a
   * duplicate.
   * @param request - layer, topic, raw value, and final author.
   * @param options - optional `userConfirmed` override after a human saw the guard warning.
   * @returns the committed entry, the operation, and the replaced entry on update.
   */
  async write(request: HabitWriteRequest, options?: { userConfirmed?: boolean }): Promise<HabitWriteOutcome> {
    const topic = resolveTopic(request.topic)
    const value = guardHabitValue(
      request.value,
      this.resolved.maxEntryChars,
      request.source,
      options?.userConfirmed ?? false,
    )
    let guardConfirmed: true | undefined
    if (options?.userConfirmed === true) {
      try {
        guardHabitContent(request.value)
      } catch {
        guardConfirmed = true
      }
    }
    const current = this.listAll().find(entry => entry.layer === request.layer && entry.topic === topic)
    if (current !== undefined && current.value === value) {
      throw new HabitError('duplicate', `habit [${topic}] already holds this value`)
    }
    const op: 'add' | 'update' = current === undefined ? 'add' : 'update'
    const entry: HabitEntry = Object.freeze({
      id: habitId(`${request.layer}:${topic}`),
      layer: request.layer,
      topic,
      value,
      source: request.source,
      ...(guardConfirmed === true ? { guardConfirmed } : {}),
      version: current === undefined ? 1 : current.version + 1,
      updatedAt: Date.now(),
    })
    await this.persistWrite(entry, op)
    this.ctx.emit('user-habits/committed', entry, op)
    return current === undefined ? { entry, op } : { entry, op, replaced: current }
  }

  /**
   * Persist a removal and commit it. The removed entry's id leaves the store
   * before the `user-habits/committed` remove event fires.
   * @param id - exact entry id (content-addressed `layer:topic`).
   * @returns the removed entry.
   */
  async remove(id: HabitId): Promise<HabitEntry> {
    const entry = this.listAll().find(candidate => candidate.id === id)
    if (entry === undefined) {
      throw new HabitError('not-found', `no habit entry with id ${JSON.stringify(id)}`)
    }
    await this.persistRemove(id)
    this.ctx.emit('user-habits/committed', entry, 'remove')
    return entry
  }

  /** Provider storage hook: the complete current committed state. */
  protected abstract listAll(): readonly HabitEntry[]

  /** Provider storage hook: durably record one add or update before the commit event. */
  protected abstract persistWrite(entry: HabitEntry, op: 'add' | 'update'): Promise<void>

  /** Provider storage hook: durably drop one entry before the commit event. */
  protected abstract persistRemove(id: HabitId): Promise<void>
}

/** Validate one topic key into its canonical form. */
function resolveTopic(raw: string): string {
  const topic = raw.trim()
  if (!TOPIC_PATTERN.test(topic)) {
    throw new HabitError('invalid-topic', `habit topic must match ${String(TOPIC_PATTERN)}`)
  }
  return topic
}

const SECTION_TITLE = '## 用户习惯'
const SECTION_GUIDANCE = '以下为该用户确认过的偏好。撰写回复时主动遵守;同主题条目以项目级为准。'

/** Token-budget input for the budgeted resident renderer. */
/** Fixed text-density constant shared with `dsh-token-meter`'s estimate.ts. */
const CHARS_PER_TOKEN = 4

/** Per-fragment structural overhead shared with `dsh-token-meter`'s estimate.ts. */
const FRAGMENT_OVERHEAD = 4

/**
 * Estimate the token cost of one text fragment under the harness-shared
 * fixed-density heuristic (4 code points per token plus per-fragment
 * structural overhead).
 * @param text - the fragment to price.
 * @returns the heuristic token count.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(Array.from(text).length / CHARS_PER_TOKEN) + FRAGMENT_OVERHEAD
}

/** Budget knobs for a resident habit section render. */
export interface HabitsSectionBudget {
  /** Hard token ceiling the rendered section must stay under. */
  readonly maxTokens: number
  /** Token estimate for one text fragment (header or one row). */
  readonly estimate: (text: string) => number
}

/** Outcome of one budgeted resident render. */
export interface HabitsSectionRender {
  /** The pinned section text, or the empty string when nothing fit. */
  readonly text: string
  /** Count of whole entries omitted for budget (never partially truncated). */
  readonly omitted: number
}

/**
 * Render the pinned resident habit section under a token budget: the fixed
 * header renders first, then complete `- [{topic}] {value}` rows in the given
 * (id) order while they fit. An entry is either included whole or omitted
 * whole — the renderer never truncates a row. The empty entry list, and a
 * budget too small for any row, render the empty string.
 * @param entries - the effective entries, already layer-merged by the caller.
 * @param budget - token ceiling and per-fragment estimator.
 * @returns the section text plus the omitted-entry count.
 */
export function renderHabitsSectionWithinBudget(
  entries: readonly HabitEntry[],
  budget: HabitsSectionBudget,
): HabitsSectionRender {
  if (entries.length === 0) return { text: '', omitted: 0 }
  const header = [SECTION_TITLE, '', SECTION_GUIDANCE].join('\n')
  let used = budget.estimate(header)
  const kept: string[] = []
  let omitted = 0
  for (const entry of entries) {
    const row = `- [${entry.topic}] ${entry.value}`
    const cost = budget.estimate(row)
    if (used + cost > budget.maxTokens) {
      omitted += 1
      continue
    }
    kept.push(row)
    used += cost
  }
  return kept.length === 0
    ? { text: '', omitted }
    : { text: [header, '', ...kept].join('\n'), omitted }
}

/**
 * Render the canonical resident habit section (design-doc pin: fixed heading,
 * fixed guidance line, `- [{topic}] {value}` rows in id order). An empty
 * entry list renders the empty string, so a scoped section contributes
 * nothing when the user confirmed no habits yet.
 * @param entries - the effective entries, already layer-merged by the caller.
 * @returns the pinned section text, or the empty string for no entries.
 */
export function renderHabitsSection(entries: readonly HabitEntry[]): string {
  return renderHabitsSectionWithinBudget(entries, { maxTokens: Number.POSITIVE_INFINITY, estimate: () => 0 }).text
}
