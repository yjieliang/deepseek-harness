// contract: the shared typed face of the lookup overlay — the SlotMap locale
// merge, the inject face, and the composed props. Lives in a file the feature
// and its tests both import directly so the `lookup` namespace merge loads in
// every program that compiles the surface (mirrors ui-user-questions).

import type { LookupExplainResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LookupKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The word-lookup surface copy. */
    lookup: LookupKey
  }
}

/** Injected business face: the model-generated explanation call. */
export interface LookupInject {
  explain: (word: string, context: string, signal: AbortSignal) => Promise<LookupExplainResult>
}

/** Composed props: root-scope runtime share + the `lookup` locale seat + the inject face. */
export type LookupOverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<'lookup'> & LookupInject
