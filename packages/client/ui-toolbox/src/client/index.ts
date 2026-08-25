/**
 * Web developer toolbox plugin, browser half: the sidebar footer trigger above
 * Settings and the overlay panel, both over the `toolbox` Remote namespace
 * (mounted by api-remotes). The two registers share one open-state controller
 * so toggling from either side converges the other.
 * Export discipline: packages/client/AGENTS.md — only the loader entry, the
 * register options, and the shared types leave this file.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale), the layout
// plugin's `shell.overlay` and the sidebar's `sidebar.footer.action` SlotMap
// declarations, and the `remote.toolbox` inject seat.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { ToolboxPanel } from './ToolboxPanel.tsx'
import { ToolboxTrigger } from './ToolboxTrigger.tsx'
import type { ToolboxInject } from './contract.ts'
import { en, zh } from './locales.ts'
import { ToolboxUiController } from './store.ts'

export type { ToolboxInject, ToolboxPanelProps, ToolboxTriggerProps, ToolboxUiState } from './contract.ts'
export { ToolboxUiController } from './store.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'toolbox'

/** Required services: the slot registry, the dictionaries, the Remote carrier, and the toolbox namespace. */
export const inject = ['slots', 'locale', 'remote', 'remote.toolbox']

/** Unwrap one Remote call's result envelope, folding failures into an Error. */
async function call<T>(
  invoke: (signal?: AbortSignal) => Promise<
    { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: object } }
  >,
): Promise<T> {
  const controller = new AbortController()
  const result = await invoke(controller.signal)
  if (result.ok) return result.value
  throw new Error(`${result.error.code}: ${result.error.message}`)
}

/**
 * Client plugin body: register the `toolbox` dictionaries, the sidebar trigger,
 * and the overlay panel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-toolbox: dictionaries')

  const controller = new ToolboxUiController()

  const injected = (): ToolboxInject => ({
    hooks: { toolboxUi: controller.store },
    translate: request => call(signal => ctx.remote.toolbox.translate(request, signal)),
    uuid: count => call(signal => ctx.remote.toolbox.uuid({ count }, signal)),
    toggle: () => { controller.toggle() },
    close: () => { controller.close() },
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dev-toolbox',
    order: 20,
    locale: NS,
    inject: injected,
  }, ToolboxTrigger))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dev-toolbox-panel',
    order: 50,
    locale: NS,
    inject: injected,
  }, ToolboxPanel))
}
