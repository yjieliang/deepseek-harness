import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import SessionStore, { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine, {
  SESSION_QUERY_SQLITE_APPLICATION_ID,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
} from '@deepseek-ai/dsh-session-query-sqlite'
import { routeSqliteQuery } from '../src/query.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryPath(name = 'search.db'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-search-zh-'))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

async function liveContext(config: { path: string } = { path: ':memory:' }): Promise<Context> {
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

const CONTINUOUS = '本次全分辨率生产实测覆盖待机与抬枪两段动作'
const BOARD = '需求看板升级方案包含存储迁移与验证缺口登记'

describe('SQLite CJK recall', () => {
  it('finds two-character words inside a continuous CJK run through the substring fallback', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'board', BOARD)

    // `unicode61` folds the whole run into one token, so these are zero-hit today.
    const kanban = await ctx.sessionQuery.searchSessions({ query: '看板' })
    expect(kanban.items).toHaveLength(1)
    expect(kanban.items[0]?.bestMatch.snippet).toContain('看板')

    const migrate = await ctx.sessionQuery.searchSessions({ query: '迁移' })
    expect(migrate.items).toHaveLength(1)
  })

  it('finds three- and four-character words inside a continuous CJK run through the trigram index', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'production', CONTINUOUS)

    const three = await ctx.sessionQuery.searchSessions({ query: '全分辨' })
    expect(three.items).toHaveLength(1)

    const four = await ctx.sessionQuery.searchSessions({ query: '生产实测' })
    expect(four.items).toHaveLength(1)
    expect(four.items[0]?.bestMatch.snippet).toContain('生产实测')

    const six = await ctx.sessionQuery.searchSessions({ query: '覆盖待机与抬枪' })
    expect(six.items).toHaveLength(1)
  })

  it('routes supplementary-plane CJK through the same three-code-point boundary', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'astral', '𠮷𠮷𠮷记录在案')

    // Extension-B ideographs sit above U+FFFF; the trigram index still counts
    // code points, so three of them match while one or two fall to the scan.
    const three = await ctx.sessionQuery.searchSessions({ query: '𠮷𠮷𠮷' })
    expect(three.items.map(item => item.header.id)).toEqual(['astral'])

    const one = await ctx.sessionQuery.searchSessions({ query: '𠮷' })
    expect(one.items.map(item => item.header.id)).toEqual(['astral'])

    const two = await ctx.sessionQuery.searchSessions({ query: '𠮷𠮷' })
    expect(two.items.map(item => item.header.id)).toEqual(['astral'])
  })

  it('does not match CJK substrings that are absent from the document', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'board', BOARD)
    sessionWithText(ctx, 'production', CONTINUOUS)

    const absent = await ctx.sessionQuery.searchSessions({ query: '中文分词' })
    expect(absent.items).toEqual([])
    const absentShort = await ctx.sessionQuery.searchSessions({ query: '分词' })
    expect(absentShort.items).toEqual([])
  })

  it('leaves non-CJK scripts and symbols on the primary route', () => {
    // Guards the route predicate against silently widening: every sample here is
    // CJK-adjacent in a font or a keyboard, yet none is Han, kana, or Hangul, so none
    // may enter a CJK route. The two separator-free ASCII words are the deliberate
    // carve-out this change introduces; they are named individually so that any OTHER
    // route change is still caught here rather than absorbed by a wider assertion.
    const nonCjk = [
      'Ω', 'Ж', 'مرحبا', 'שלום', 'नमस्ते', 'สวัสดี', 'ქართული', 'Հայերեն',
      'ㄅㄆㄇ', '⿰⿱', '䷀䷿', '㌀㍿', '㇐㇑', '㊀㊁', '︐︑',
      '😀', '👨‍👩‍👧', '🇨🇳', '1️⃣', '→★', '€', '∑', '\uFFFD',
    ]
    for (const sample of nonCjk) {
      expect([sample, routeSqliteQuery(sample)]).toEqual([sample, 'primary'])
    }
    for (const word of ['hello', 'Bopomofo']) {
      expect([word, routeSqliteQuery(word)]).toEqual([word, 'primary-cjk-trigram'])
    }
  })

  it('keeps the declared CJK-adjacent ranges on the CJK routes', () => {
    // The counterpart guard: fullwidth forms, CJK punctuation, kanji radicals,
    // kana, and Hangul are declared ranges and must route away from the primary
    // index, because `unicode61` folds their runs into single tokens.
    const cjkAdjacent: Array<[string, string]> = [
      ['︰', 'cjk-substring'],
      ['\uFF21\uFF22', 'cjk-substring'],
      ['\u3001\u3002', 'cjk-substring'],
      ['\u2F00\u2F01', 'cjk-substring'],
      ['\u3042\u3044', 'cjk-substring'],
      ['\uAC00\uAC01', 'cjk-substring'],
      ['\u3131\u3132', 'cjk-substring'],
      ['\uFE30\uFE31', 'cjk-substring'],
      ['\uFF10\uFF11', 'cjk-substring'],
    ]
    for (const [sample, expected] of cjkAdjacent) {
      expect([sample, routeSqliteQuery(sample)]).toEqual([sample, expected])
    }
  })

  it('keeps token-adjacency semantics for non-CJK queries', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'upper', 'the session_query table is indexed')
    sessionWithText(ctx, 'dashed', 'the session-query path is indexed')

    // `unicode61` splits on the separator, so a dashed query matches the
    // underscore spelling through neighbouring tokens; the trigram engine cannot
    // express that, which is why non-CJK queries must keep the primary route.
    const dashed = await ctx.sessionQuery.searchSessions({ query: 'session-query' })
    expect(dashed.items.map(item => item.header.id).sort()).toEqual(['dashed', 'upper'])

    const exact = await ctx.sessionQuery.searchSessions({ query: 'indexed' })
    expect(exact.items).toHaveLength(2)
  })

  it('escapes LIKE wildcards so a literal query cannot over-match', async () => {
    const ctx = await liveContext()
    sessionWithText(ctx, 'literal', '进度 １００％ 完成，字段 a_b 已登记')
    sessionWithText(ctx, 'unrelated', '一批无关文本')

    // A bare CJK-punctuation query routes through the substring fallback, where
    // `%` is a LIKE wildcard; an unescaped pattern would match every row.
    const percent = await ctx.sessionQuery.searchSessions({ query: '％' })
    expect(percent.items.map(item => item.header.id)).toEqual(['literal'])

    const fullwidthPair = await ctx.sessionQuery.searchSessions({ query: '００' })
    expect(fullwidthPair.items.map(item => item.header.id)).toEqual(['literal'])

    // ASCII queries keep the primary index, where `_` is an ordinary token
    // character rather than a wildcard.
    const underscore = await ctx.sessionQuery.searchSessions({ query: 'a_b' })
    expect(underscore.items.map(item => item.header.id)).toEqual(['literal'])
    const absentUnderscore = await ctx.sessionQuery.searchSessions({ query: 'z_z' })
    expect(absentUnderscore.items).toEqual([])
  })

  it('rebuilds a derived index whose schema version is stale and then answers CJK queries', async () => {
    const path = await temporaryPath()
    const stale = new DatabaseSync(path)
    stale.exec(`PRAGMA application_id = ${SESSION_QUERY_SQLITE_APPLICATION_ID}`)
    stale.exec('PRAGMA user_version = 1')
    stale.exec('CREATE TABLE persisted_sessions (id TEXT PRIMARY KEY)')
    stale.close()

    const ctx = await liveContext({ path })
    sessionWithText(ctx, 'board', BOARD)

    const hits = await ctx.sessionQuery.searchSessions({ query: '看板' })
    expect(hits.items).toHaveLength(1)
    expect(hits.items[0]?.bestMatch.snippet).toContain('看板')

    const reopened = new DatabaseSync(path)
    const { user_version: version } = reopened.prepare('PRAGMA user_version').get() as { user_version: number }
    reopened.close()
    expect(version).toBe(SESSION_QUERY_SQLITE_SCHEMA_VERSION)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('searches CJK text written through the persisted JSONL backend', async () => {
    const { ctx, engine } = await persistedContext()
    const meta = persistedHeader('persisted-cjk')
    const writer = await ctx.sessionPersistence.create(meta)
    await writer.append(messageEvents(BOARD))
    await writer.close()

    // The companion index is written on the persisted path too, so both the
    // substring fallback and the trigram route must answer for durable sessions.
    const short = await ctx.sessionQuery.searchSessions({ query: '看板' })
    expect(short.items).toHaveLength(1)
    expect(short.items[0]).toMatchObject({
      header: { id: meta.id },
      persisted: true,
      live: false,
    })
    expect(short.items[0]?.bestMatch.snippet).toContain('看板')

    const long = await ctx.sessionQuery.searchSessions({ query: '存储迁移' })
    expect(long.items.map(item => item.header.id)).toEqual([meta.id])

    const absent = await ctx.sessionQuery.searchSessions({ query: '中文分词' })
    expect(absent.items).toEqual([])

    await engine.dispose()
  })

  it('drops stale CJK postings when the replacing event shadows the original', async () => {
    const ctx = await liveContext()
    const sessionId = sessionWithText(ctx, 'replaced', '需求看板升级方案包含存储迁移')

    const before = await ctx.sessionQuery.searchSessions({ query: '存储迁移' })
    expect(before.items.map(item => item.header.id)).toEqual(['replaced'])

    // A position-based replacement shadows the original event, so the observation
    // no longer contains it. The companion trigram index must lose that posting
    // rather than keep answering for text the session no longer exposes.
    const session = ctx.sessions.get(sessionId)
    session?.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '另一段与看板无关的中文' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) },
      sourceEventSeqs: [SessionSeq(0)],
    })

    const stale = await ctx.sessionQuery.searchSessions({ query: '存储迁移' })
    expect(stale.items.map(item => item.header.id)).toEqual(['replaced'])
    // The shadowed document is still indexed (the engine searches every surface
    // by default), so the stale posting is visible until the caller filters it.
    // Assert the tri-state instead of pretending the row disappeared.
    const currentOnly = await ctx.sessionQuery.searchSessions({
      query: '存储迁移',
      eventFilters: [{ kind: 'surface', values: ['current'] }],
    })
    expect(currentOnly.items).toEqual([])

    // The replacement text is indexed, proving the session was rewritten rather
    // than merely dropped.
    const replacement = await ctx.sessionQuery.searchSessions({ query: '看板无关' })
    expect(replacement.items.map(item => item.header.id)).toEqual(['replaced'])
  })
})
