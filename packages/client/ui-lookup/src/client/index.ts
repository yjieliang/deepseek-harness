/**
 * Web word-lookup plugin, browser half: the selection-aware overlay registered
 * as one entry of the layout-declared `shell.overlay` frame-wide layer. The
 * entry declares the `lookup` dictionaries and injects the model-explanation
 * callback over the `lookupLlm` Remote namespace (mounted by api-remotes).
 * Export discipline: packages/client/AGENTS.md — only the loader entry, the
 * register options, and the shared types leave this file.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pull the locale plugin's Context merge (ctx.locale) and the
// layout plugin's `shell.overlay` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { LookupOverlay } from './LookupOverlay.tsx'
import type { LookupInject } from './contract.ts'
import { en, zh } from './locales.ts'

export type { LookupInject, LookupOverlayProps } from './contract.ts'
export type { SelectionAnchor } from './LookupOverlay.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'lookup'

/** Required services: the slot registry, the dictionaries, and the lookupLlm Remote namespace. */
export const inject = ['slots', 'locale', 'remote', 'remote.lookupLlm']

/**
 * Client plugin body: register the `lookup` dictionaries and the overlay into
 * the frame-wide `shell.overlay` list, waiting on the layout declaration.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-lookup: dictionaries')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'lookup',
      locale: NS,
      inject: (): LookupInject => ({
        explain: async (word, context, signal) => {
          const result = await ctx.remote.lookupLlm.explain({ word, context }, signal)
          if (result.ok) return result.value
          throw new Error(`${result.error.code}: ${result.error.message}`)
        },
      }),
    },
    LookupOverlay,
  ))
}
