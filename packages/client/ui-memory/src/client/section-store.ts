/**
 * User-habit memory settings controller: reads the `user-habits` settings
 * namespace through `settings.describe` and edits it wholesale through
 * `settings.replace` with optimistic concurrency (`expectedRevision`).
 *
 * The browser has no access to the host `HabitService`, so this controller
 * maintains the same entry bookkeeping the service owns — version bumps and
 * `updatedAt` on change, `source: 'user'` for everything a person writes
 * here. The host's namespace `validate` still runs on every write: budget
 * violations always reject, and guard-failing content rejects until the
 * person confirms it once (`overrideDraft`, which persists `guardConfirmed`).
 */

import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { MemorySettingsKey } from './locales.ts'

/** The user-habits settings namespace on the host wire. */
export const USER_HABITS_NS = 'user-habits'

/** Mirrors the host's stable topic rule (`TOPIC_PATTERN` in dsh-user-habits). */
const TOPIC_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u

/** One habit entry exactly as the namespace stores it. */
export interface MemoryEntry {
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

/** The open editor dialog: one entry being added or edited. */
export interface MemoryDraft {
  /** Topic being typed. */
  topic: string
  /** Value being typed. */
  value: string
  /** Local validation failure, localized by the renderer. */
  errorKey: MemorySettingsKey | null
  /** Host rejection text (already localized by the host), cleared on edit. */
  error: string | null
  /**
   * Whether the failed submit may be retried with the host content guard
   * overridden. Set after the first rejection and cleared when the override
   * itself is refused — a budget violation must never be overridable.
   */
  overridable: boolean
  /** Whether the save is in flight. */
  saving: boolean
}

/** Section snapshot. */
export interface MemorySectionState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  /** Whole-load failure text; an editor or delete failure stays on the dialog. */
  error: string | null
  /** Whether this browser may write the namespace at all. */
  writable: boolean
  /** Namespace revision the entries were read at, sent back on writes. */
  revision: number
  /** Every committed entry, sorted by topic. */
  entries: readonly MemoryEntry[]
  /** The open editor dialog, or null. */
  draft: MemoryDraft | null
  /** The entry topic awaiting delete confirmation, or null. */
  pendingDelete: string | null
  /** Whether a delete is in flight. */
  deleting: boolean
}

const INITIAL: MemorySectionState = {
  status: 'idle',
  error: null,
  // Assumed until `load()` asks; a page that has not read yet renders nothing
  // interactive anyway (status 'idle').
  writable: true,
  revision: 0,
  entries: [],
  draft: null,
  pendingDelete: null,
  deleting: false,
}

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the surface still
 * has to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parse the namespace's redacted resolved value into entries. This is a wire
 * boundary: a namespace edited by hand or by an older host can hold anything,
 * so every field is checked before it reaches render code.
 * @param value - the resolved namespace value the host answered with.
 * @returns the entries, or undefined when the value cannot be trusted.
 */
export function parseEntries(value: unknown): MemoryEntry[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entries = (value as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  const out: MemoryEntry[] = []
  for (const item of entries) {
    if (typeof item !== 'object' || item === null) return undefined
    const record = item as Record<string, unknown>
    if (typeof record.topic !== 'string' || typeof record.value !== 'string') return undefined
    if (record.source !== 'user' && record.source !== 'agent-proposed') return undefined
    if (record.guardConfirmed !== undefined && typeof record.guardConfirmed !== 'boolean') return undefined
    if (typeof record.version !== 'number' || typeof record.updatedAt !== 'number') return undefined
    out.push({
      topic: record.topic,
      value: record.value,
      source: record.source,
      ...(record.guardConfirmed === true ? { guardConfirmed: true as const } : {}),
      version: record.version,
      updatedAt: record.updatedAt,
    })
  }
  return out
}

/** The `user-habits` namespace view inside a `settings.describe` answer. */
interface NamespaceView {
  /** Namespace key. */
  ns: string
  /** Redacted resolved value. */
  value: unknown
  /** Monotonic revision the value was read at. */
  revision: number
}

/** Reads the namespace and edits it through the settings wire. */
export class MemorySectionController {
  /** Section snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<MemorySectionState> = createSnapshotStore(INITIAL)

  constructor(private readonly api: Pick<IApiClient, 'settings'>) {}

  private set(patch: Partial<MemorySectionState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  private patchDraft(patch: Partial<MemoryDraft>): void {
    const before = this.store.getSnapshot()
    if (before.draft === null) return
    this.set({ draft: { ...before.draft, ...patch } })
  }

  /**
   * Read the namespace. A deployment without the habits-settings provider
   * reports `unavailable` and renders nothing; a refused read reports `error`
   * with the host's text.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const before = this.store.getSnapshot()
    if (before.status === 'loading') return
    this.set({ status: 'loading', error: null })
    let described
    try {
      described = await this.api.settings.describe({})
    } catch (error) {
      this.set({ status: 'error', error: messageOf(error) })
      return
    }
    if (!described.result.ok) {
      this.set({ status: 'error', error: described.result.error.message })
      return
    }
    const namespaces = described.result.value.namespaces as NamespaceView[]
    const view = namespaces.find(ns => ns.ns === USER_HABITS_NS)
    if (view === undefined) {
      this.set({ status: 'unavailable', writable: false, revision: 0, entries: [] })
      return
    }
    const entries = parseEntries(view.value)
    if (entries === undefined) {
      this.set({ status: 'error', error: 'memory data cannot be parsed' })
      return
    }
    this.set({
      status: 'ready',
      error: null,
      writable: described.result.value.writable,
      revision: view.revision,
      entries,
    })
  }

  /** Open the editor over a fresh entry. */
  beginAdd(): void {
    this.set({ draft: { topic: '', value: '', errorKey: null, error: null, overridable: false, saving: false } })
  }

  /** Open the editor over one committed entry.
   * @param topic - the committed entry's topic.
   */
  beginEdit(topic: string): void {
    const entry = this.store.getSnapshot().entries.find(candidate => candidate.topic === topic)
    if (entry === undefined) return
    this.set({
      draft: {
        topic: entry.topic,
        value: entry.value,
        errorKey: null,
        error: null,
        overridable: false,
        saving: false,
      },
    })
  }

  /** Type the topic, clearing any earlier failure.
   * @param topic - the new topic text.
   */
  setDraftTopic(topic: string): void {
    this.patchDraft({ topic, errorKey: null, error: null, overridable: false })
  }

  /** Type the value, clearing any earlier failure.
   * @param value - the new value text.
   */
  setDraftValue(value: string): void {
    this.patchDraft({ value, errorKey: null, error: null, overridable: false })
  }

  /** Close the editor, discarding the draft. */
  cancelDraft(): void {
    this.set({ draft: null })
  }

  /** Submit the draft without overriding the content guard. */
  async confirmDraft(): Promise<void> {
    await this.submitDraft(false)
  }

  /** Re-submit after a guard rejection, persisting the human's confirmation. */
  async overrideDraft(): Promise<void> {
    await this.submitDraft(true)
  }

  /**
   * Build the namespace's next entries for a draft save: bump the version and
   * timestamp of the targeted topic, or append a fresh version-1 entry.
   * Everything a person writes here is authored by the user.
   * @param draft - the validated draft.
   * @param confirmed - whether the content guard override was confirmed.
   * @returns the complete next entry list.
   */
  private buildNextEntries(draft: MemoryDraft, confirmed: boolean): MemoryEntry[] {
    const before = this.store.getSnapshot()
    const topic = draft.topic.trim()
    const now = Date.now()
    const exists = before.entries.some(entry => entry.topic === topic)
    const next = before.entries.map(entry => entry.topic === topic
      ? {
        topic,
        value: draft.value,
        source: 'user' as const,
        ...(confirmed ? { guardConfirmed: true as const } : {}),
        version: entry.version + 1,
        updatedAt: now,
      }
      : entry)
    if (!exists) {
      next.push({
        topic,
        value: draft.value,
        source: 'user',
        ...(confirmed ? { guardConfirmed: true as const } : {}),
        version: 1,
        updatedAt: now,
      })
      next.sort((a, b) => (a.topic < b.topic ? -1 : 1))
    }
    return next
  }

  /**
   * Submit the open draft. Local rules (topic shape, non-empty value) reject
   * with a localized key; the host's namespace validation rejects over-budget
   * content hard and guard-failing content until `confirmed`. A successful
   * write re-reads the namespace so the snapshot always reflects the host.
   * @param confirmed - whether the content guard override was confirmed.
   */
  private async submitDraft(confirmed: boolean): Promise<void> {
    const before = this.store.getSnapshot()
    const draft = before.draft
    if (draft === null || draft.saving || before.status !== 'ready') return
    const topic = draft.topic.trim()
    if (!TOPIC_PATTERN.test(topic)) {
      this.patchDraft({ errorKey: 'topicInvalid', error: null, overridable: false })
      return
    }
    if (draft.value.trim() === '') {
      this.patchDraft({ errorKey: 'valueRequired', error: null, overridable: false })
      return
    }
    const existing = before.entries.find(entry => entry.topic === topic)
    if (existing !== undefined && existing.value === draft.value) {
      // Nothing changed: close the editor without a write.
      this.set({ draft: null })
      return
    }
    this.patchDraft({ saving: true, errorKey: null, error: null })
    let response
    try {
      response = await this.api.settings.replace({
        ns: USER_HABITS_NS,
        section: { entries: this.buildNextEntries(draft, confirmed) },
        expectedRevision: before.revision,
      })
    } catch (error) {
      this.patchDraft({ saving: false, error: messageOf(error), overridable: !confirmed })
      return
    }
    if (!response.result.ok) {
      this.patchDraft({ saving: false, error: response.result.error.message, overridable: !confirmed })
      return
    }
    await this.load()
    this.set({ draft: null })
  }

  /** Ask for delete confirmation, or dismiss it with null.
   * @param topic - the entry to confirm deletion for, or null to clear.
   */
  confirmDelete(topic: string | null): void {
    this.set({ pendingDelete: topic })
  }

  /** Delete the entry awaiting confirmation. */
  async remove(): Promise<void> {
    const before = this.store.getSnapshot()
    const topic = before.pendingDelete
    if (topic === null || before.deleting) return
    this.set({ deleting: true })
    let response
    try {
      response = await this.api.settings.replace({
        ns: USER_HABITS_NS,
        section: { entries: before.entries.filter(entry => entry.topic !== topic) },
        expectedRevision: before.revision,
      })
    } catch (error) {
      this.set({ deleting: false, error: messageOf(error) })
      return
    }
    if (!response.result.ok) {
      this.set({ deleting: false, error: response.result.error.message })
      return
    }
    await this.load()
    this.set({ deleting: false, pendingDelete: null })
  }
}
