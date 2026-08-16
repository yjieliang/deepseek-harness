/**
 * User-habit memory surface plugin, browser half: one settings section that
 * lists the `user-habits` namespace's global entries and edits them through
 * the settings wire. The namespace itself is a host contract owned by
 * `@deepseek-ai/dsh-habits-settings`; this plugin only surfaces it.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { MemorySection } from './MemorySection.tsx'
import type { MemorySectionInjected } from './MemorySection.tsx'
import { MemorySectionController, USER_HABITS_NS } from './section-store.ts'
import { en, zh } from './locales.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote']

/**
 * Mount the Memory settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const controller = new MemorySectionController(api)

  ctx.effect(() => ctx.locale.register('settings.memory', { zh, en }), 'ui-memory: section dictionaries')

  const sectionInjected = (): MemorySectionInjected => ({
    hooks: { memorySection: controller.store },
    load: () => controller.load(),
    beginAdd: () => { controller.beginAdd() },
    beginEdit: (topic: string) => { controller.beginEdit(topic) },
    setDraftTopic: (topic: string) => { controller.setDraftTopic(topic) },
    setDraftValue: (value: string) => { controller.setDraftValue(value) },
    confirmDraft: () => controller.confirmDraft(),
    overrideDraft: () => controller.overrideDraft(),
    cancelDraft: () => { controller.cancelDraft() },
    confirmDelete: (topic: string | null) => { controller.confirmDelete(topic) },
    remove: () => controller.remove(),
  })

  ctx.effect(() => {
    // A session's memory tool can write the namespace while the settings
    // panel stays open, so the section re-reads when the host announces the
    // change — the same invalidation every settings surface rides.
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns) => {
        if (ns !== USER_HABITS_NS) return
        void controller.load()
      }),
      ctx.on('connection/reset', () => { void controller.load() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-memory: settings refresh')

  // Ordered after the management-heavy sections: memory is consulted, not configured.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: 60,
    label: () => ctx.locale.bind('settings.memory')('nav'),
    locale: 'settings.memory',
    inject: sectionInjected,
  }, MemorySection))
}
