/**
 * Web knowledge-base plugin, browser half: the sidebar footer trigger above
 * Settings and the browse/edit overlay panel, both over the `kb` Remote
 * namespace (mounted by api-remotes). The two registers share one open-state
 * controller so toggling from either side converges the other.
 * Export discipline: packages/client/AGENTS.md — only the loader entry, the
 * register options, and the shared types leave this file.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale), the layout
// plugin's `shell.overlay` and the sidebar's `sidebar.footer.action` SlotMap
// declarations, the `remote.kb` inject seat, the trigger pipeline's
// `inputTriggers`/`referenceAppearances` merges, and the conversation
// reference-glyph chain-slot declarations.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { KbPanel } from './KbPanel.tsx'
import { KbTrigger } from './KbTrigger.tsx'
import { KbRefGlyph, selectKbGlyph } from './KbRefGlyph.tsx'
import { createKbReferenceSource, KB_APPEARANCE } from './reference-source.ts'
import type { KbInject } from './contract.ts'
import { en, zh } from './locales.ts'
import { KbUiController } from './store.ts'

export type { KbInject, KbPanelProps, KbTriggerProps, KbUiState } from './contract.ts'
export { KbUiController } from './store.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'kb'

/**
 * Required services: the slot registry, the dictionaries, the Remote carrier, the kb namespace,
 * the trigger pipeline, and the appearance registry.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.kb', 'inputTriggers', 'referenceAppearances']

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
 * Client plugin body: register the `kb` dictionaries, the sidebar trigger,
 * and the overlay panel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-kb: dictionaries')

  const controller = new KbUiController()

  const injected = (): KbInject => ({
    hooks: { kbUi: controller.store },
    list: request => call(signal => ctx.remote.kb.list(request, signal)).then(result => result.docs),
    search: query => call(signal => ctx.remote.kb.search({ query }, signal))
      .then(result => ({ hits: result.hits, total: result.total })),
    get: path => call(signal => ctx.remote.kb.get({ path }, signal)),
    dirs: () => call(signal => ctx.remote.kb.dirs({}, signal)).then(result => result.dirs),
    save: request => call(signal => ctx.remote.kb.saveDoc(request, signal)),
    create: request => call(signal => ctx.remote.kb.createDoc(request, signal)),
    move: request => call(signal => ctx.remote.kb.moveDoc(request, signal)),
    rename: request => call(signal => ctx.remote.kb.renameDoc(request, signal)),
    remove: path => call(signal => ctx.remote.kb.deleteDoc({ path }, signal)).then(() => undefined),
    trash: () => call(signal => ctx.remote.kb.trash({}, signal)).then(result => result.docs),
    refresh: () => call(signal => ctx.remote.kb.refresh({}, signal)).then(() => undefined),
    restore: (path, targetDirectory) => call(signal => ctx.remote.kb.restoreDoc(
      { path, ...targetDirectory === undefined ? {} : { targetDirectory } }, signal,
    )).then(() => undefined),
    purge: path => call(signal => ctx.remote.kb.purgeDoc({ path }, signal)).then(() => undefined),
    stats: () => call(signal => ctx.remote.kb.stats({}, signal)),
    tags: () => call(signal => ctx.remote.kb.tags({}, signal)).then(result => result.tags),
    createDir: request => call(signal => ctx.remote.kb.createDir(request, signal)).then(() => undefined),
    renameDir: request => call(signal => ctx.remote.kb.renameDir(request, signal)).then(() => undefined),
    assetUrl: path => window.location.origin + '/dsh-kb/' + path.split('/').map(encodeURIComponent).join('/'),
    toggle: () => { controller.toggle() },
    close: () => { controller.close() },
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'kb-trigger',
    order: 10,
    locale: NS,
    inject: injected,
  }, KbTrigger))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'kb-panel',
    order: 100,
    locale: NS,
    inject: injected,
  }, KbPanel))

  // The kb domain of the unified `@` menu: its own trigger source beside the
  // file/session source, plus the plain-text `@kb:` appearance mapping and
  // one reference-glyph occupant per conversation chain slot.
  ctx.effect(() => ctx.inputTriggers.registerSource(createKbReferenceSource(
    signal => ctx.remote.kb.list({}, signal).then(result => result.ok ? result.value.docs : []),
    ctx.locale.bind(NS),
  )), 'ui-kb: @kb reference source')
  ctx.effect(
    () => ctx.referenceAppearances.register({ kind: KB_APPEARANCE, tokenPrefixes: ['kb:'] }),
    'ui-kb: kb reference appearance',
  )
  ctx.slots.inject('conversation.input.refGlyph', () => ctx.slots.register(
    { name: 'conversation.input.refGlyph', select: selectKbGlyph },
    KbRefGlyph,
  ))
  ctx.slots.inject('conversation.chat.refGlyph', () => ctx.slots.register(
    { name: 'conversation.chat.refGlyph', select: selectKbGlyph },
    KbRefGlyph,
  ))
}
