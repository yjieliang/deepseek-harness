/**
 * Settings-backed provider of the habits seam: stores `global` habit entries
 * in the user-settings namespace `user-habits` (schema-validated, serialized
 * writes, settings/updated event stream) and registers the canonical
 * budgeted resident prompt section. The settings namespace is registered on
 * this plugin's fiber, so unloading the provider removes the namespace and
 * the section together.
 *
 * The resident budget prices fragments under the shared fixed-density
 * heuristic of `dsh-token-meter`'s `estimate.ts` (4 code points per token
 * plus per-fragment overhead), so the section budget stays consistent with
 * the harness token accounting without pulling the meter service in.
 *
 * @module @deepseek-ai/dsh-habits-settings
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsScope, SettingsValidatePhase } from '@deepseek-ai/dsh-settings'
// Type-only: loads the `ctx.systemPrompt` Context declaration.
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  HabitService,
  TOPIC_PATTERN,
  estimateTextTokens,
  guardHabitContent,
  habitId,
  renderHabitsSectionWithinBudget,
} from '@deepseek-ai/dsh-user-habits'
import type { HabitEntry, HabitId } from '@deepseek-ai/dsh-user-habits'

/** Deployment configuration; every key optional with validated defaults. */
export interface Config {
  /** Per-entry character budget forwarded to the contract guard. */
  maxEntryChars?: number
  /** Hard token ceiling of the resident prompt section. */
  residentTokenBudget?: number
}

/** One stored entry record inside the settings namespace. */
interface StoredEntry {
  /** Stable topic key. */
  topic: string
  /** Guard-validated value. */
  value: string
  /** Final author. */
  source: 'user' | 'agent-proposed'
  /** Present only when a human confirmed guard-failing content. */
  guardConfirmed?: boolean
  /** Positive version counter. */
  version: number
  /** Epoch milliseconds of the commit. */
  updatedAt: number
}

/** The stored section shape of the `user-habits` namespace. */
interface HabitSection {
  entries: StoredEntry[]
}

/** Schema validating every stored entry on load and write. */
const habitSectionSchema = z.object({
  entries: z.array(z.object({
    topic: z.string(),
    value: z.string(),
    source: z.union([z.const('user'), z.const('agent-proposed')]),
    guardConfirmed: z.boolean().default(false),
    version: z.number().min(1),
    updatedAt: z.number(),
  })),
})

/** Content-address prefix shared by every global entry id. */
const GLOBAL_PREFIX = 'global:'

/** The settings namespace this provider owns. */
const USER_HABITS_NS = settingsNamespace('user-habits')

/** Recover the topic from a global entry id (topics never contain ':'). */
function topicOf(id: HabitId): string {
  return id.slice(GLOBAL_PREFIX.length)
}

/** Rebuild one committed entry from its stored record. */
function restoreEntry(stored: StoredEntry): HabitEntry {
  return Object.freeze({
    id: habitId(`${GLOBAL_PREFIX}${stored.topic}`),
    layer: 'global',
    topic: stored.topic,
    value: stored.value,
    source: stored.source,
    ...(stored.guardConfirmed === true ? { guardConfirmed: true as const } : {}),
    version: stored.version,
    updatedAt: stored.updatedAt,
  })
}

/**
 * Settings-backed habit store (`ctx.habits`): the `global` layer provider of
 * the habits seam, mounted as a Cordis service plugin.
 */
export default class HabitsSettingsStore extends HabitService {
  static inject = ['settings', 'systemPrompt']

  static override Config: z<Config> = z.object({
    maxEntryChars: z.number().min(1).default(200),
    residentTokenBudget: z.number().min(1).default(600),
  })

  private readonly scope: SettingsScope<HabitSection>
  private readonly residentTokenBudget: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, { maxEntryChars: config.maxEntryChars ?? 200 })
    this.residentTokenBudget = config.residentTokenBudget ?? 600
    this.scope = ctx.settings.register(USER_HABITS_NS, habitSectionSchema, {
      base: { entries: [] },
      // The content guard is write-phase only: stored entries must load so an
      // entry written before `guardConfirmed` existed (the only way hostile
      // content could have been stored was a confirmed override) can be
      // migrated below instead of refusing the whole plugin at boot. Topic
      // shape and budget stay hard in both phases.
      validate: (section: HabitSection, phase: SettingsValidatePhase) => {
        for (const stored of section.entries) {
          if (!TOPIC_PATTERN.test(stored.topic)) {
            throw new Error(`习惯主题无效:${JSON.stringify(stored.topic)}`)
          }
          const length = Array.from(stored.value).length
          if (length > this.resolved.maxEntryChars) {
            throw new Error(`习惯内容超出单条字符上限(${this.resolved.maxEntryChars} 字符):${stored.topic}`)
          }
          if (phase === 'load' || stored.guardConfirmed === true) continue
          guardHabitContent(stored.value)
        }
      },
    })
    this.migrateConfirmedOverrides()
    this.ctx.effect(() => {
      // A provider that publishes the stored document only after registration
      // (settings-file cold load) resolves it through the load-phase
      // validator, which skips the content guard — so the migration must also
      // run when the document changes from outside this store. Idempotent:
      // once every offending entry carries the flag, nothing is written.
      const stop = this.ctx.on('settings/document-updated', (ns) => {
        if (ns !== USER_HABITS_NS) return
        this.migrateConfirmedOverrides()
      })
      return () => { stop() }
    }, 'habits-settings: migrate on document change')
    this.ctx.effect(() => ctx.systemPrompt.section({
      name: 'user-habits',
      order: 50,
      text: () => this.renderSection(),
    }), 'habits-settings: resident section')
  }

  /**
   * Persist `guardConfirmed` for stored entries whose content trips the guard.
   * Before that flag existed, the only write path that admitted hostile
   * content was a human-confirmed override, so the migration records that
   * fact rather than guessing; afterwards the write-phase validator lets
   * these entries past while still refusing unconfirmed ones. A failed write
   * retries at the next boot — the load-phase validator keeps them loadable.
   */
  private migrateConfirmedOverrides(): void {
    const current = this.scope.get().entries
    const migrated = current.map((entry) => {
      if (entry.guardConfirmed === true) return entry
      try {
        guardHabitContent(entry.value)
        return entry
      } catch {
        return { ...entry, guardConfirmed: true }
      }
    })
    if (migrated.some((entry, index) => entry !== current[index])) {
      void this.scope.replace({ entries: migrated }).catch((error: unknown) => {
        this.ctx.logger.warn('habits-settings: confirmed-override migration failed', error)
      })
    }
  }

  protected override listAll(): readonly HabitEntry[] {
    return Object.freeze(this.scope.get().entries.map(restoreEntry))
  }

  protected override async persistWrite(entry: HabitEntry): Promise<void> {
    const next = this.scope.get().entries.filter(stored => stored.topic !== entry.topic)
    next.push({
      topic: entry.topic,
      value: entry.value,
      source: entry.source,
      ...(entry.guardConfirmed === true ? { guardConfirmed: true } : {}),
      version: entry.version,
      updatedAt: entry.updatedAt,
    })
    next.sort((a, b) => (a.topic < b.topic ? -1 : 1))
    await this.scope.update({ entries: next })
  }

  protected override async persistRemove(id: HabitId): Promise<void> {
    const topic = topicOf(id)
    await this.scope.update({ entries: this.scope.get().entries.filter(stored => stored.topic !== topic) })
  }

  /** Assemble the resident section under the configured token budget. */
  private renderSection(): string {
    const { text, omitted } = renderHabitsSectionWithinBudget(this.list('global'), {
      maxTokens: this.residentTokenBudget,
      estimate: estimateTextTokens,
    })
    if (text === '') return ''
    return omitted === 0
      ? text
      : `${text}\n部分用户习惯因超出注入预算未展示(${omitted} 条)。需要时用 memory_list 查看。`
  }
}
