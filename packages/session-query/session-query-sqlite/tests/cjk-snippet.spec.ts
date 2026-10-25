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
import { routeSqliteQuery } from '../src/query.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryPath(name = 'search.db'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-search-cjk-snippet-'))
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
  const engine = await ctx.plugin(SqliteSessionQueryEngine, { path: await temporaryPath('persisted.db'), snippetChars: 40 })
  return { ctx, engine }
}

function persistedHeader(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 10, isSeeded: false }
}

function messageEvent(text: string, seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: 1 + seq,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }
}

/** 300 code points of filler, so a 40-code-point window can only show the document head. */
const PAD_BEFORE = '前置填充文字'.repeat(50)
const PAD_AFTER = '后续填充文字'.repeat(50)

/** The same document head, with the match 300 code points in. */
const LATE_TRIGRAM = `${PAD_BEFORE}存储迁移${PAD_AFTER}`
const LATE_SUBSTRING = `${PAD_BEFORE}迁移${PAD_AFTER}`

/** Corpus whose CJK hit sets are asserted exactly, route by route. */
const CORPUS: Array<[string, string]> = [
  ['trigram-late', LATE_TRIGRAM],
  ['substring-late', LATE_SUBSTRING],
  ['both', '存储迁移与迁移登记'],
  ['absent', '与查询词无关的一段中文'],
  ['astral', '𠮷𠮷𠮷记录在案'],
]

describe('SQLite CJK snippet marking', () => {
  it('centres a cjk-trigram snippet on a match past the head of the document', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 40 })
    sessionWithText(ctx, 'late', LATE_TRIGRAM)

    // The companion trigram index answers this query, and no `MATCH` reaches the text
    // table on that route; an unmarked `marked_text` would cut the window from the head.
    expect(routeSqliteQuery('存储迁移')).toBe('cjk-trigram')
    const page = await ctx.sessionQuery.searchSessions({ query: '存储迁移' })
    expect(page.items.map(item => item.header.id)).toEqual(['late'])
    const snippet = page.items[0]?.bestMatch.snippet ?? ''
    expect(snippet).toContain('存储迁移')
    expect(snippet.startsWith('…')).toBe(true)
    expect(Array.from(snippet).length).toBeLessThanOrEqual(40)
    // The window that an unmarked document produces: the 39 head code points, then an
    // ellipsis, with the match 300 code points further in left out entirely.
    expect(snippet).not.toBe(`${PAD_BEFORE.slice(0, 39)}…`)
  })

  it('centres a cjk-substring snippet on a match past the head of the document', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 40 })
    sessionWithText(ctx, 'late', LATE_SUBSTRING)

    // This route reduces candidates with `LIKE` and marks with a literal substitution,
    // whose needle must be the query: a `%query%` pattern never occurs in a document.
    expect(routeSqliteQuery('迁移')).toBe('cjk-substring')
    const page = await ctx.sessionQuery.searchSessions({ query: '迁移' })
    expect(page.items.map(item => item.header.id)).toEqual(['late'])
    const snippet = page.items[0]?.bestMatch.snippet ?? ''
    expect(snippet).toContain('迁移')
    expect(snippet.startsWith('…')).toBe(true)
    expect(Array.from(snippet).length).toBeLessThanOrEqual(40)
  })

  it('ranks by marked occurrences so a denser long document beats a shorter one', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 40 })
    // Two occurrences in a 604-code-point document against one occurrence in a
    // two-code-point document. With every `match_count` pinned at zero the tie-break
    // is `document_length ASC`, so the shorter document used to win outright.
    sessionWithText(ctx, 'dense', `${PAD_BEFORE}迁移迁移${PAD_AFTER}`)
    sessionWithText(ctx, 'short', '迁移')

    const page = await ctx.sessionQuery.searchSessions({ query: '迁移' })
    expect(page.items.map(item => item.header.id)).toEqual(['dense', 'short'])
  })

  it('marks the query rather than the LIKE pattern the predicate binds', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 40 })
    // A document that literally contains `%迁移%` is the only shape a LIKE-pattern
    // needle can mark; that needle also consumes itself, so the marker came out
    // one-sided and the window landed on the pattern rather than on the word.
    sessionWithText(ctx, 'pattern', '字段 %迁移% 已登记')
    sessionWithText(ctx, 'plain', LATE_SUBSTRING)

    const page = await ctx.sessionQuery.searchSessions({ query: '迁移' })
    expect(page.items.map(item => item.header.id)).toEqual(['pattern', 'plain'])
    const pattern = page.items.find(item => item.header.id === 'pattern')?.bestMatch.snippet ?? ''
    expect(pattern).toContain('迁移')
    const plain = page.items.find(item => item.header.id === 'plain')?.bestMatch.snippet ?? ''
    expect(plain).toContain('迁移')
    expect(plain.startsWith('…')).toBe(true)
  })

  it('keeps both CJK routes answering the same documents after the marking change', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 40 })
    for (const [id, text] of CORPUS) sessionWithText(ctx, id, text)

    const ids = async (query: string): Promise<string[]> => {
      const page = await ctx.sessionQuery.searchSessions({ query })
      return page.items.map(item => item.header.id).sort()
    }

    expect([routeSqliteQuery('存储迁移'), await ids('存储迁移')])
      .toEqual(['cjk-trigram', ['both', 'trigram-late']])
    expect([routeSqliteQuery('迁移'), await ids('迁移')])
      .toEqual(['cjk-substring', ['both', 'substring-late', 'trigram-late']])
    expect([routeSqliteQuery('𠮷𠮷𠮷'), await ids('𠮷𠮷𠮷')])
      .toEqual(['cjk-trigram', ['astral']])
    expect([routeSqliteQuery('无关译文'), await ids('无关译文')])
      .toEqual(['cjk-trigram', []])
  })

  it('centres the snippet on the persisted branch of both CJK routes', async () => {
    const { ctx, engine } = await persistedContext()
    const meta = persistedHeader('persisted-cjk-snippet')
    const writer = await ctx.sessionPersistence.create(meta)
    await writer.append([messageEvent(LATE_TRIGRAM, 0), messageEvent(LATE_SUBSTRING, 1)])
    await writer.close()

    const trigram = await ctx.sessionQuery.searchSessions({ query: '存储迁移' })
    expect(trigram.items.map(item => item.header.id)).toEqual([meta.id])
    expect(trigram.items[0]?.bestMatch.snippet).toContain('存储迁移')
    expect(trigram.items[0]?.bestMatch.snippet.startsWith('…')).toBe(true)

    const substring = await ctx.sessionQuery.searchSessions({ query: '迁移' })
    expect(substring.items.map(item => item.header.id)).toEqual([meta.id])
    expect(substring.items[0]?.bestMatch.snippet).toContain('迁移')
    expect(substring.items[0]?.bestMatch.snippet.startsWith('…')).toBe(true)

    await engine.dispose()
  })
})
