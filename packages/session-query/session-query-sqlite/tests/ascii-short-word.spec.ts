import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQueryEngine, { assertStatementArity } from '@deepseek-ai/dsh-session-query-sqlite'

async function liveContext(config: { path: string; snippetChars?: number }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SqliteSessionQueryEngine, config)
  return ctx
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

/** One live session carrying a single appended user message. */
function sessionWithText(ctx: Context, id: string, text: string): SessionId {
  const session = ctx.sessions.create(SessionId(id))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session.id
}

describe('SQLite short ASCII word recall', () => {
  it('refuses a candidate statement whose placeholders and bindings disagree', () => {
    // The regression this guards: the scan route's binding list once omitted the live
    // branch's visibility value, so SQLite bound `LIMIT` to NULL and the route returned
    // nothing at all — a silent zero-hit that reads like a recall bug.
    expect(() => { assertStatementArity('SELECT 1 WHERE ? = ?', ['only-one']) })
      .toThrow(expect.objectContaining({ code: 'SESSION_QUERY_INVALID_QUERY' }))
    expect(() => { assertStatementArity('SELECT ? AS only', ['one', 'two']) })
      .toThrow(expect.objectContaining({ code: 'SESSION_QUERY_INVALID_QUERY' }))
    expect(() => { assertStatementArity('SELECT ? AS one, ? AS two', ['one', 'two']) }).not.toThrow()
    expect(() => { assertStatementArity('SELECT 1', []) }).not.toThrow()
  })

  it('answers a short word through the live branch that used to return nothing', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 20 })

    // The live branch is what carried the arity regression: the persisted branch is
    // empty here, so only its own predicate and the visibility flag are in play.
    const session = ctx.sessions.create(SessionId('live'), {
      seed: messageEvents('inherited context'),
      inheritedEventCount: SessionLogOffset(1),
      meta: { cwd: '/work', createdAt: 10, isSeeded: true, delegationDepth: 2, agentPreset: 'minimal' },
    })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'An AI helper' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )

    await expect(ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'AI' }))
      .resolves.toMatchObject({
        session: session.header,
        items: [{ sessionId: session.id, seq: SessionSeq(2), snippet: 'An AI helper' }],
      })
    await expect(ctx.sessionQuery.searchSessions({ query: 'AI' }))
      .resolves.toMatchObject({ items: [{ header: session.header, live: true, persisted: false }] })
  })

  it('scans only the two-code-point ASCII word shape', async () => {
    const ctx = await liveContext({ path: ':memory:' })
    sessionWithText(ctx, 'glued', '实时AI推理已完成')
    sessionWithText(ctx, 'single', '路径a存在')

    // The scan route is exactly two code points. A single-code-point query keeps the
    // tokenizer's answer rather than scanning the whole index.
    expect((await ctx.sessionQuery.searchSessions({ query: 'AI' })).items.map(item => item.header.id))
      .toEqual(['glued'])
    expect((await ctx.sessionQuery.searchSessions({ query: 'a' })).items).toEqual([])

    // Separator-bearing and three-code-point shapes keep their own routes.
    sessionWithText(ctx, 'dashed', 'the session-query path is indexed')
    expect((await ctx.sessionQuery.searchSessions({ query: 'a_b' })).items).toEqual([])
    expect((await ctx.sessionQuery.searchSessions({ query: 'session-query' })).items.map(item => item.header.id))
      .toEqual(['dashed'])
  })
})
