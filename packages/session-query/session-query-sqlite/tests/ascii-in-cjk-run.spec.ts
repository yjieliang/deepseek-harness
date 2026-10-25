import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { isShortSeparatorFreeAsciiWord, routeSqliteQuery, widensToCompanionTrigram } from '../src/query.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryPath(name = 'search.db'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-search-ascii-'))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

async function liveContext(
  config: { path: string; snippetChars?: number } = { path: ':memory:' },
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SqliteSessionQueryEngine, config)
  return ctx
}

/** Append one user message and return the owning session id. */
function sessionWithText(ctx: Context, id: string, text: string): SessionId {
  const session = ctx.sessions.create(SessionId(id))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session.id
}

/** Mount the real JSONL persistence backend beside the engine. */
async function persistedContext(): Promise<{ ctx: Context; engine: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: await temporaryPath('sessions'), compression: 'none' })
  const engine = await ctx.plugin(SqliteSessionQueryEngine, { path: await temporaryPath('persisted.db') })
  return { ctx, engine }
}

function persistedHeader(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 10, isSeeded: false }
}

function messageEvents(text: string): SessionEvent[] {
  return [{
    type: 'user/message',
    seq: SessionSeq(0),
    time: 1,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }]
}

/** `unicode61` folds this whole run into the single token `本次dsh会话检索修复已完成`. */
const GLUED = '本次DSH会话检索修复已完成'

describe('SQLite ASCII recall inside a CJK run', () => {
  it('routes a separator-free ASCII word additively and leaves every other shape alone', () => {
    for (const word of ['DSH', 'dsh', 'the', 'hello', 'Bopomofo', 'abc']) {
      expect([word, widensToCompanionTrigram(word)]).toEqual([word, true])
      expect([word, routeSqliteQuery(word)]).toEqual([word, 'primary-cjk-trigram'])
    }

    // Fewer than three code points cannot use a trigram index at all. Two of them take
    // the literal scan route; one code point is deliberately left on the primary index.
    for (const word of ['AI', 'v2', 'is', '5G']) {
      expect([word, widensToCompanionTrigram(word)]).toEqual([word, false])
      expect([word, isShortSeparatorFreeAsciiWord(word)]).toEqual([word, true])
      expect([word, routeSqliteQuery(word)]).toEqual([word, 'ascii-substring'])
    }
    for (const word of ['a', '5']) {
      expect([word, isShortSeparatorFreeAsciiWord(word)]).toEqual([word, false])
      expect([word, routeSqliteQuery(word)]).toEqual([word, 'primary'])
    }

    // A separator, an internal space, or a non-ASCII script is not this shape, and
    // must keep the primary index — the literal trigram engine cannot express
    // token adjacency, and `unicode61` folds case and diacritics.
    for (const sample of ['session-query', 'SESSION_QUERY', 'packages/session-query', 'v2.1', 'a_b', 'DSH tool', 'the tool', 'café', 'مرحبا']) {
      expect([sample, widensToCompanionTrigram(sample)]).toEqual([sample, false])
      expect([sample, routeSqliteQuery(sample)]).toEqual([sample, 'primary'])
    }

    // The CJK routes are untouched by this change.
    expect(['会话检索', routeSqliteQuery('会话检索')]).toEqual(['会话检索', 'cjk-trigram'])
    expect(['路径', routeSqliteQuery('路径')]).toEqual(['路径', 'cjk-substring'])
  })

  it('finds an ASCII word glued inside a continuous CJK run', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'glued', GLUED)

    // Zero-hit before this change: the query carries no CJK, so the primary index
    // answered it and folded the whole run into one unmatched token.
    const hits = await ctx.sessionQuery.searchSessions({ query: 'DSH' })
    expect(hits.items.map(item => item.header.id)).toEqual(['glued'])
    expect(hits.items[0]?.bestMatch.snippet).toContain('DSH')
  })

  it('keeps every document the primary engine already matched', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'exact', 'DSH')
    sessionWithText(ctx, 'spaced', 'DSH 会话检索修复已完成')
    sessionWithText(ctx, 'ascii', 'the DSH tool is here')
    sessionWithText(ctx, 'glued', GLUED)

    // The widening is additive. The companion index holds only CJK-bearing
    // documents, so routing this query to it instead of the primary engine would
    // drop `exact`, `spaced` and `ascii` — including the document spelled exactly
    // like the query.
    const hits = await ctx.sessionQuery.searchSessions({ query: 'DSH' })
    expect(hits.items.map(item => item.header.id).sort())
      .toEqual(['ascii', 'exact', 'glued', 'spaced'])
  })

  it('centres the snippet on a match only the companion probe found', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 40 })
    sessionWithText(ctx, 'long', `${'前置填充文字'.repeat(12)}DSH内核${'后续填充文字'.repeat(12)}`)

    const hits = await ctx.sessionQuery.searchSessions({ query: 'DSH' })
    expect(hits.items).toHaveLength(1)
    const snippet = hits.items[0]?.bestMatch.snippet ?? ''
    expect(snippet).toContain('DSH')
    // A leading ellipsis proves the window moved to the match instead of being cut
    // from the head of the document, which is what a zero `match_count` would do.
    expect(snippet.startsWith('…')).toBe(true)
  })

  it('keeps token-adjacency semantics for a separator-bearing query', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'dashed', 'the session-query path is indexed')
    sessionWithText(ctx, 'underscored', 'the session_query table is indexed')

    // `unicode61` splits on the separator, so the dashed query matches the
    // underscore spelling through neighbouring tokens; the trigram engine cannot
    // express that, which is why this shape keeps the primary route.
    const hits = await ctx.sessionQuery.searchSessions({ query: 'session-query' })
    expect(hits.items.map(item => item.header.id).sort()).toEqual(['dashed', 'underscored'])
  })

  it('finds the glued word through the persisted backend too', async () => {
    const { ctx, engine } = await persistedContext()
    const meta = persistedHeader('persisted-ascii')
    const writer = await ctx.sessionPersistence.create(meta)
    await writer.append(messageEvents(GLUED))
    await writer.close()

    const hits = await ctx.sessionQuery.searchSessions({ query: 'DSH' })
    expect(hits.items).toHaveLength(1)
    expect(hits.items[0]).toMatchObject({
      header: { id: meta.id },
      persisted: true,
      live: false,
    })
    expect(hits.items[0]?.bestMatch.snippet).toContain('DSH')
    await engine.dispose()
  })

  it('selects a case-mismatched query without marking the snippet', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'glued', GLUED)

    // The trigram engine folds case exactly as `unicode61` does, so the row is
    // found. The literal fallback is deliberately case-sensitive, so this
    // companion-only row reaches the caller unmarked: the documented limit of the
    // additive route, asserted here so a future change to it is deliberate.
    const hits = await ctx.sessionQuery.searchSessions({ query: 'dsh' })
    expect(hits.items.map(item => item.header.id)).toEqual(['glued'])
  })

  it('finds a two-code-point ASCII word glued inside a continuous CJK run', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'glued-ai', '实时AI推理已完成')

    // A trigram `MATCH` needs three code points, so `AI` cannot use the companion
    // index; it scans the primary table literally instead. This was zero-hit before.
    const hits = await ctx.sessionQuery.searchSessions({ query: 'AI' })
    expect(hits.items.map(item => item.header.id)).toEqual(['glued-ai'])
    // The snippet must carry the word and be centred on it, not cut from the head.
    expect(hits.items[0]?.bestMatch.snippet).toContain('AI')
  })

  it('keeps a two-code-point query case-sensitive, unlike the tokenizing routes', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'upper', '实时AI推理已完成')
    sessionWithText(ctx, 'lower', '实时ai推理已完成')

    // `instr()` is a literal test. The deliberate trade is that `AI` does not reach
    // the lowercase document, and `ai` does not reach the uppercase one — the opposite
    // of what `unicode61` would do when the word is separated from CJK by spaces.
    const upper = await ctx.sessionQuery.searchSessions({ query: 'AI' })
    expect(upper.items.map(item => item.header.id)).toEqual(['upper'])
    const lower = await ctx.sessionQuery.searchSessions({ query: 'ai' })
    expect(lower.items.map(item => item.header.id)).toEqual(['lower'])
  })

  it('does not inherit LIKE\'s character classes or its case folding', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'spelled', '实时AI推理已完成')
    // `LIKE '%AI%'` would reach this document through the letters in "plain".
    sessionWithText(ctx, 'collateral', 'plain ascii document with nothing glued')

    const hits = await ctx.sessionQuery.searchSessions({ query: 'AI' })
    expect(hits.items.map(item => item.header.id)).toEqual(['spelled'])

    // A `_` in a two-code-point-shaped query would be a LIKE wildcard; `instr()` is
    // literal, so this stays an ordinary absent substring rather than matching anything.
    const underscore = await ctx.sessionQuery.searchSessions({ query: 'a_' })
    expect(underscore.items).toEqual([])
  })

  it('finds the glued two-code-point word through the persisted backend too', async () => {
    const { ctx, engine } = await persistedContext()
    const meta = persistedHeader('persisted-short')
    const writer = await ctx.sessionPersistence.create(meta)
    await writer.append(messageEvents('实时AI推理已完成'))
    await writer.close()

    const hits = await ctx.sessionQuery.searchSessions({ query: 'AI' })
    expect(hits.items).toHaveLength(1)
    expect(hits.items[0]).toMatchObject({
      header: { id: meta.id },
      persisted: true,
      live: false,
    })
    expect(hits.items[0]?.bestMatch.snippet).toContain('AI')
    await engine.dispose()
  })

  it('centres the snippet on a short-word match late in a long document', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 40 })
    sessionWithText(ctx, 'long', `${'前置填充文字'.repeat(12)}AI内核${'后续填充文字'.repeat(12)}`)

    const hits = await ctx.sessionQuery.searchSessions({ query: 'AI' })
    expect(hits.items).toHaveLength(1)
    const snippet = hits.items[0]?.bestMatch.snippet ?? ''
    expect(snippet).toContain('AI')
    // A leading ellipsis proves the window moved to the match instead of being cut from
    // the head, which is what a zero `match_count` would produce.
    expect(snippet.startsWith('…')).toBe(true)
  })
})
