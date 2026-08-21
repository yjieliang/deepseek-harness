/**
 * Boot-home settings row controller: reads the resolved harness home and its
 * source through `host.describe`, and persists a next-boot override through
 * `host.setDshHome` (the `~/.dsh-boot` file). The running process keeps its
 * current home — the change applies at the next launch, which the save
 * response names.
 */

import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Source of the resolved harness home. */
export type BootHomeSource = 'default' | 'env' | 'boot-file' | 'configured'

/** Row snapshot. */
export interface BootHomeState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** Absolute harness home the running process resolved. */
  home: string
  /** Where that home came from. */
  source: BootHomeSource
  /** The typed next-home draft. */
  draft: string
  /** Whether a save is in flight. */
  saving: boolean
  /** Success message of the last save, cleared by the next edit. */
  saved: string | null
}

const INITIAL: BootHomeState = {
  status: 'idle',
  error: null,
  home: '',
  source: 'default',
  draft: '',
  saving: false,
  saved: null,
}

/** Reads the resolved home and persists the next-boot override. */
export class BootHomeController {
  /** Row snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<BootHomeState> = createSnapshotStore(INITIAL)

  constructor(private readonly api: Pick<IApiClient, 'host'>) {}

  private set(patch: Partial<BootHomeState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /**
   * Read the resolved home and its source.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    if (this.store.getSnapshot().status === 'loading') return
    this.set({ status: 'loading', error: null })
    let response
    try {
      response = await this.api.host.describe({})
    } catch (error) {
      this.set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (!response.result.ok) {
      this.set({ status: 'error', error: response.result.error.message })
      return
    }
    this.set({
      status: 'ready',
      home: response.result.value.dshHome,
      source: response.result.value.dshHomeSource,
      draft: response.result.value.dshHome ?? '',
    })
  }

  /** Type the next home, clearing the last save message. */
  setDraft(draft: string): void {
    this.set({ draft, saved: null })
  }

  /** Persist the typed home for the next boot. */
  async save(): Promise<void> {
    const before = this.store.getSnapshot()
    if (before.saving) return
    this.set({ saving: true, error: null })
    let response
    try {
      response = await this.api.host.setDshHome({ path: before.draft })
    } catch (error) {
      this.set({ saving: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (!response.result.ok) {
      this.set({ saving: false, error: response.result.error.message })
      return
    }
    this.set({
      saving: false,
      home: response.result.value.nextHome,
      source: response.result.value.source,
      saved: response.result.value.source === 'env'
        ? 'env-wins'
        : 'saved-restart',
    })
  }

  /** Remove the persisted override; the next boot falls back to the default. */
  async clear(): Promise<void> {
    const before = this.store.getSnapshot()
    if (before.saving) return
    this.set({ saving: true, error: null })
    let response
    try {
      response = await this.api.host.setDshHome({ path: null })
    } catch (error) {
      this.set({ saving: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (!response.result.ok) {
      this.set({ saving: false, error: response.result.error.message })
      return
    }
    this.set({
      saving: false,
      home: response.result.value.nextHome,
      source: response.result.value.source,
      saved: response.result.value.source === 'env' ? 'env-wins' : 'cleared-restart',
    })
  }
}
