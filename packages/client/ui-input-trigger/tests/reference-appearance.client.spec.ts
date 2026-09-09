/**
 * ReferenceAppearanceService coverage: kind registration with longest-prefix
 * token mapping, duplicate refusal, and disposer removal.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
// Type-only: pulls the client entry's Context merges (inputTriggers,
// referenceAppearances) into this spec's program.
import type {} from '../src/client/index.ts'
import { ReferenceAppearanceService } from '../src/client/reference-appearance.ts'

describe('ReferenceAppearanceService', () => {
  it('registers kinds and maps tokens by longest prefix', async () => {
    const ctx = new Context()
    await ctx.plugin(ReferenceAppearanceService).await()
    const disposeKb = ctx.referenceAppearances.register({ kind: 'kb', tokenPrefixes: ['kb:'] })
    const disposeCode = ctx.referenceAppearances.register({ kind: 'code', tokenPrefixes: ['c', 'code:'] })
    expect(ctx.referenceAppearances.kindForToken('kb:10-技术/note.md')).toBe('kb')
    expect(ctx.referenceAppearances.kindForToken('code:x')).toBe('code')
    // Within one registration the longest prefix wins.
    expect(ctx.referenceAppearances.kindForToken('c:x')).toBe('code')
    expect(ctx.referenceAppearances.kindForToken('plain.md')).toBeUndefined()
    disposeKb()
    disposeCode()
    expect(ctx.referenceAppearances.kindForToken('kb:10-技术/note.md')).toBeUndefined()
  })

  it('refuses a duplicate kind and tolerates a kind without token prefixes', async () => {
    const ctx = new Context()
    await ctx.plugin(ReferenceAppearanceService).await()
    ctx.referenceAppearances.register({ kind: 'kb', tokenPrefixes: ['kb:'] })
    expect(() => ctx.referenceAppearances.register({ kind: 'kb', tokenPrefixes: ['other:'] })).toThrow(/already registered/)
    ctx.referenceAppearances.register({ kind: 'lookup-only' })
    expect(ctx.referenceAppearances.kindForToken('kb:x')).toBe('kb')
  })
})
