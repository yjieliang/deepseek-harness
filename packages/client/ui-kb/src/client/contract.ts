// contract: the shared typed face of the knowledge-base surface — the `kb`
// locale merge, the inject face, and the composed props for the sidebar
// trigger and the overlay panel. Lives in a file the feature and its tests
// both import directly so the `kb` namespace merge loads in every program
// that compiles the surface (mirrors ui-user-questions).

import type {
  KbCreateRequest, KbCreateResult, KbDocSummary, KbGetResult, KbListRequest, KbSaveRequest,
  KbSaveResult, KbTrashEntry,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { KbKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The knowledge-base surface copy. */
    kb: KbKey
  }
}

/** Shared UI state between the sidebar trigger and the overlay panel. */
export interface KbUiState {
  /** Whether the knowledge-base panel is open. */
  open: boolean
}

/** Injected business face: kb Remote calls plus the shared panel state. */
export interface KbInject {
  hooks: {
    /** Panel open-state snapshot bound by the renderer as useKbUi. */
    kbUi: SnapshotStore<KbUiState>
  }
  /** List documents, most recently updated first. */
  list: (request: KbListRequest) => Promise<KbDocSummary[]>
  /** 2-gram AND search over the library. */
  search: (query: string) => Promise<KbDocSummary[]>
  /** Full read of one document. */
  get: (path: string) => Promise<KbGetResult>
  /** Available library directories. */
  dirs: () => Promise<string[]>
  /** Apply a field patch + body replacement. */
  save: (request: KbSaveRequest) => Promise<KbSaveResult>
  /** Create a dated document. */
  create: (request: KbCreateRequest) => Promise<KbCreateResult>
  /** Move a document into `.trash` (recoverable). */
  remove: (path: string) => Promise<void>
  /** List the recoverable trash. */
  trash: () => Promise<KbTrashEntry[]>
  /** Restore a trashed document into a directory. */
  restore: (path: string, targetDirectory?: string) => Promise<void>
  /** Permanently clear one trashed document. */
  purge: (path: string) => Promise<void>
  /** Absolute `/dsh-kb/...` URL for one library-relative asset path. */
  assetUrl: (path: string) => string
  /** Toggle the panel open state. */
  toggle: () => void
  /** Close the panel. */
  close: () => void
}

/** Trigger props: sidebar foot action owner state + locale + inject. */
export type KbTriggerProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'kb'> & InjectFace<KbInject>

/** Panel props: overlay runtime share + locale + inject. */
export type KbPanelProps = PropsRuntime<'shell.overlay'> & PropsLocale<'kb'> & InjectFace<KbInject>
