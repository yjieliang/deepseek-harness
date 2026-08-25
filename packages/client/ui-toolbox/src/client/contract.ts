// contract: the shared typed face of the developer toolbox — the `toolbox`
// locale merge, the inject face, and the composed props for the sidebar trigger
// and the overlay panel. Lives in a file the feature and its tests both import
// directly so the `toolbox` namespace merge loads in every program that
// compiles the surface (mirrors ui-kb).

import type {
  ToolboxTranslateResult,
  ToolboxUuidResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolboxKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The developer toolbox surface copy. */
    toolbox: ToolboxKey
  }
}

/** Shared UI state between the sidebar trigger and the overlay panel. */
export interface ToolboxUiState {
  /** Whether the toolbox panel is open. */
  open: boolean
}

/** Injected business face: the toolbox Remote calls plus the shared panel state. */
export interface ToolboxInject {
  hooks: {
    /** Panel open-state snapshot bound by the renderer as useToolboxUi. */
    toolboxUi: SnapshotStore<ToolboxUiState>
  }
  /** Translate text through the free API or the configured model. */
  translate: (request: {
    text: string
    source: string
    target: string
    engine: 'api' | 'model'
  }) => Promise<ToolboxTranslateResult>
  /** Generate UUIDs in v1 and v4 flavors. */
  uuid: (count: number) => Promise<ToolboxUuidResult>
  /** Toggle the panel open state. */
  toggle: () => void
  /** Close the panel. */
  close: () => void
}

/** Trigger props: sidebar foot action owner state + locale + inject. */
export type ToolboxTriggerProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'toolbox'> & InjectFace<ToolboxInject>

/** Panel props: overlay runtime share + locale + inject. */
export type ToolboxPanelProps = PropsRuntime<'shell.overlay'> & PropsLocale<'toolbox'> & InjectFace<ToolboxInject>
