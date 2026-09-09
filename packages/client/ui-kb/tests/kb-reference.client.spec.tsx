// @vitest-environment jsdom
/**
 * Knowledge-base `@` reference coverage: the dedicated trigger source
 * (title/path prefix listing over `kb.list`, `kb:` namespace stripping,
 * quoted suppression, atomic `@kb:` inserts), the `kb` appearance
 * registration, and the two reference-glyph chain occupants.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { KbDocSummary } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CandidateRequest, ClientSessionContext, InputTriggerCandidate, InputTriggerSource,
  ReferenceAppearanceRegistration,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { apply, inject } from '../src/client/index.ts'
import { KB_APPEARANCE, KB_SOURCE_NAME } from '../src/client/reference-source.ts'
import { en } from '../src/client/locales.ts'

const sid = (value: string): SessionId => value as SessionId
const session: ClientSessionContext = { sessionId: sid('target') }

type RemoteEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: object } }

type RemoteKbList = (
  request: Record<string, never>,
  signal?: AbortSignal,
) => Promise<RemoteEnvelope<{ docs: KbDocSummary[] }>>

function request(
  query: string,
  options: { quoted?: boolean; signal?: AbortSignal } = {},
): CandidateRequest {
  return {
    query,
    quoted: options.quoted ?? false,
    position: 'inline',
    signal: options.signal ?? new AbortController().signal,
  }
}

const DOC_A: KbDocSummary = {
  path: '10-技术/note.md',
  title: '笔记',
  summary: '',
  tags: [],
  status: 'filed',
  updated: '',
  pinned: false,
}

async function bench(
  kb: RemoteKbList = () => Promise.resolve({ ok: true as const, value: { docs: [DOC_A] } }),
): Promise<{
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  source: InputTriggerSource
  appearance: ReferenceAppearanceRegistration | undefined
}> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  // Declare every slot this plugin contributes to: the two panel seats and
  // the two conversation reference-glyph chain slots.
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
      'conversation.input.refGlyph': { kind: 'chain', scope: 'root' },
      'conversation.chat.refGlyph': { kind: 'chain', scope: 'root' },
    },
  } as never, () => null)
  let source: InputTriggerSource | undefined
  ctx.provide('inputTriggers', {
    registerSource(candidate: InputTriggerSource) {
      source = candidate
      return () => { source = undefined }
    },
  })
  let appearance: ReferenceAppearanceRegistration | undefined
  ctx.provide('referenceAppearances', {
    register(registration: ReferenceAppearanceRegistration) {
      appearance = registration
      return () => { appearance = undefined }
    },
    kindForToken: () => undefined,
  })
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  ctx.provide('remote.kb', { list: kb })
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  if (source === undefined) throw new Error('kb reference source was not registered')
  return { ctx, fiber, source, appearance }
}

describe('apply registration', () => {
  it('declares its services and registers the source, appearance, and both glyph occupants', async () => {
    expect(inject).toEqual([
      'slots', 'locale', 'remote', 'remote.kb', 'inputTriggers', 'referenceAppearances',
    ])
    const { ctx, fiber, source, appearance } = await bench()
    expect(source).toMatchObject({ trigger: '@', name: KB_SOURCE_NAME, order: 1, showGroupTitle: false })
    expect(appearance).toEqual({ kind: 'kb', tokenPrefixes: ['kb:'] })
    expect(ctx.slots.entries('conversation.input.refGlyph')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.chat.refGlyph')).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.input.refGlyph')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.chat.refGlyph')).toHaveLength(0)
  })
})

describe('kb reference source candidates', () => {
  it('lists documents by title/path prefix, strips the kb: namespace, and caps the menu', async () => {
    const kb = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { docs: [
        DOC_A,
        { path: '20-学习/other.md', title: '其他', summary: '', tags: [], status: 'filed' as const, updated: '', pinned: false },
      ] },
    }))
    const { source } = await bench(kb)
    const hits = await source.candidates(session, request('note'))
    expect(kb).toHaveBeenCalledWith({}, expect.any(AbortSignal))
    expect(hits).toEqual([
      expect.objectContaining({ name: 'KB document · 笔记', description: '10-技术/note.md', section: 'Knowledge base' }),
    ])
    // A leading kb: namespace is stripped before the title/path prefix match.
    const namespaced = await source.candidates(session, request('kb:note'))
    expect(namespaced).toHaveLength(1)
  })

  it('skips the listing RPC for a quoted token', async () => {
    const kb = vi.fn(() => Promise.resolve({ ok: true as const, value: { docs: [DOC_A] } }))
    const { source } = await bench(kb)
    await expect(source.candidates(session, request('note', { quoted: true }))).resolves.toEqual([])
    expect(kb).not.toHaveBeenCalled()
  })

  it('folds listing failures into an empty group and drops unrepresentable paths', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('down')))
    const { source: failedSource } = await bench(failing)
    await expect(failedSource.candidates(session, request('note'))).resolves.toEqual([])
    const unrepresentable = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { docs: [
        { path: 'bad\nname.md', title: 'bad', summary: '', tags: [], status: 'filed' as const, updated: '', pinned: false },
      ] },
    }))
    const { source: droppedSource } = await bench(unrepresentable)
    await expect(droppedSource.candidates(session, request('bad'))).resolves.toEqual([])
  })

  it('applies the twenty-candidate cap over the prefix hits', async () => {
    const many = Array.from({ length: 30 }, (_, index): KbDocSummary => ({
      path: `10-技术/doc-${String(index).padStart(2, '0')}.md`,
      title: `文档${index}`,
      summary: '',
      tags: [],
      status: 'filed',
      updated: '',
      pinned: false,
    }))
    const { source } = await bench(() => Promise.resolve({ ok: true as const, value: { docs: many } }))
    const hits = await source.candidates(session, request('')) as InputTriggerCandidate[]
    expect(hits).toHaveLength(20)
  })
})

describe('kb pick and codec', () => {
  const pick = (source: InputTriggerSource, candidate: InputTriggerCandidate) => source.onPick({
    candidate,
    session,
    position: 'inline',
    via: 'menu',
    span: { start: 0, end: 1, draftRev: 1 },
  })

  it('inserts an atomic @kb: reference carrying the kb appearance', async () => {
    const { source } = await bench()
    const [candidate] = await source.candidates(session, request('note'))
    expect(pick(source, candidate!)).toEqual({
      insert: {
        source: KB_SOURCE_NAME,
        ref: '@kb:10-技术/note.md',
        label: '笔记',
        appearance: KB_APPEARANCE,
        clipboardText: '@kb:10-技术/note.md',
      },
    })
    expect(source.codec?.clipboardText('@kb:10-技术/note.md')).toBe('@kb:10-技术/note.md')
    await expect(source.codec?.serialize('@kb:10-技术/note.md', new AbortController().signal))
      .resolves.toBe('@kb:10-技术/note.md')
  })

  it('quotes paths containing whitespace in the mention', async () => {
    const spaced = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { docs: [
        { path: '10-技术/带 空格.md', title: '带空格', summary: '', tags: [], status: 'filed' as const, updated: '', pinned: false },
      ] },
    }))
    const { source } = await bench(spaced)
    const [candidate] = await source.candidates(session, request('空格'))
    expect(pick(source, candidate!)).toMatchObject({ insert: { ref: '@kb:"10-技术/带 空格.md"' } })
  })
})

describe('source factory locale copy', () => {
  it('labels candidates through the kb dictionary', async () => {
    const { source } = await bench()
    const [candidate] = await source.candidates(session, request('note'))
    // The spec harness binds the default (en) locale; the values are the
    // dictionary's own, so the assertion tracks the bound copy.
    expect(candidate?.name).toBe(`${en['reference.candidate']} · 笔记`)
    expect(candidate?.section).toBe(en['reference.section'])
  })
})
