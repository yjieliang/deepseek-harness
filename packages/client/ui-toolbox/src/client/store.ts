/**
 * Shared panel open-state controller for the developer toolbox surface. One
 * instance created in the plugin body and handed to both the sidebar trigger
 * and the overlay panel, so toggling from either side converges the other.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolboxUiState } from './contract.ts'

/** Initial UI state: panel closed. */
const INITIAL: ToolboxUiState = { open: false }

/** Owns the open/close flag the trigger and the panel share. */
export class ToolboxUiController {
  /** Panel open-state snapshot the renderer binds as useToolboxUi. */
  readonly store: SnapshotStore<ToolboxUiState> = createSnapshotStore(INITIAL)

  /** Flip the panel open state. */
  toggle(): void {
    this.store.set({ open: !this.store.getSnapshot().open })
  }

  /** Close the panel. */
  close(): void {
    this.store.set({ open: false })
  }
}
