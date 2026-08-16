import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HabitError, HabitService, habitId, renderHabitsSection } from '../src/index.ts'
import type { HabitEntry, HabitId, HabitOp } from '../src/index.ts'

/** In-memory provider over the contract hooks, for contract-level tests. */
class MemoryHabits extends HabitService {
  private readonly entries = new Map<string, HabitEntry>()

  protected listAll(): readonly HabitEntry[] {
    return Object.freeze([...this.entries.values()])
  }

  protected async persistWrite(entry: HabitEntry): Promise<void> {
    this.entries.set(entry.id, entry)
  }

  protected async persistRemove(id: HabitId): Promise<void> {
    this.entries.delete(id)
  }
}

const mount = async (): Promise<{ ctx: Context; committed: Array<[HabitEntry, HabitOp]> }> => {
  const ctx = new Context()
  const committed: Array<[HabitEntry, HabitOp]> = []
  ctx.on('user-habits/committed', (entry, op) => {
    committed.push([entry, op])
  })
  await ctx.plugin(MemoryHabits)
  return { ctx, committed }
}

describe('HabitService', () => {
  it('mounts on the context as ctx.habits', async () => {
    const { ctx } = await mount()
    expect(ctx.habits).toBeInstanceOf(HabitService)
  })

  it('adds an entry, emits the commit event, and lists it in id order', async () => {
    const { ctx, committed } = await mount()
    const outcome = await ctx.habits.write({ layer: 'global', topic: 'style', value: ' 简洁 ', source: 'user' })
    expect(outcome.op).toBe('add')
    expect(outcome.entry).toMatchObject({ id: habitId('global:style'), topic: 'style', value: '简洁', version: 1 })
    expect(committed).toEqual([[outcome.entry, 'add']])
    expect(ctx.habits.list()).toEqual([outcome.entry])
  })

  it('updates the same-topic entry instead of appending a sibling', async () => {
    const { ctx } = await mount()
    const first = await ctx.habits.write({ layer: 'global', topic: 'lang', value: '中文', source: 'user' })
    const second = await ctx.habits.write({ layer: 'global', topic: 'lang', value: '英文', source: 'agent-proposed' })
    expect(second.op).toBe('update')
    expect(second.replaced).toBe(first.entry)
    expect(second.entry).toMatchObject({ version: 2, value: '英文', source: 'agent-proposed' })
    expect(ctx.habits.list()).toEqual([second.entry])
  })

  it('keeps the same topic on different layers as independent entries', async () => {
    const { ctx } = await mount()
    await ctx.habits.write({ layer: 'global', topic: 'lang', value: '中文', source: 'user' })
    await ctx.habits.write({ layer: 'project', topic: 'lang', value: '英文', source: 'user' })
    expect(ctx.habits.list()).toHaveLength(2)
    expect(ctx.habits.list('global')).toHaveLength(1)
    expect(ctx.habits.list('project')).toHaveLength(1)
  })

  it('rejects an unchanged same-topic value as a duplicate', async () => {
    const { ctx } = await mount()
    await ctx.habits.write({ layer: 'global', topic: 'style', value: '简洁', source: 'user' })
    await expect(ctx.habits.write({ layer: 'global', topic: 'style', value: '简洁', source: 'user' }))
      .rejects.toThrowMatchingObject({ code: 'duplicate' })
  })

  it('rejects an invalid topic key', async () => {
    const { ctx } = await mount()
    await expect(ctx.habits.write({ layer: 'global', topic: 'not a topic', value: 'x', source: 'user' }))
      .rejects.toThrowMatchingObject({ code: 'invalid-topic' })
  })

  it('propagates guard rejections with their code', async () => {
    const { ctx } = await mount()
    await expect(ctx.habits.write({ layer: 'global', topic: 'style', value: 'api key sk-123', source: 'user' }))
      .rejects.toThrowMatchingObject({ code: 'guard-secret' })
  })

  it('admits user-authored hostile-looking content after a confirmed override', async () => {
    const { ctx } = await mount()
    const outcome = await ctx.habits.write(
      { layer: 'global', topic: 'style', value: 'api key sk-123', source: 'user' },
      { userConfirmed: true },
    )
    expect(outcome.entry.value).toBe('api key sk-123')
    // The override is recorded so settings-level validation can tell a
    // confirmed entry from one that never passed the guard.
    expect(outcome.entry.guardConfirmed).toBe(true)
    expect(ctx.habits.list()[0]?.guardConfirmed).toBe(true)
  })

  it('leaves the confirmation flag off a confirmed write of ordinary content', async () => {
    const { ctx } = await mount()
    const outcome = await ctx.habits.write(
      { layer: 'global', topic: 'style', value: '简洁', source: 'user' },
      { userConfirmed: true },
    )
    expect(outcome.entry.guardConfirmed).toBeUndefined()
  })

  it('keeps agent-proposed hostile content hard-rejected even with an override', async () => {
    const { ctx } = await mount()
    await expect(ctx.habits.write(
      { layer: 'global', topic: 'style', value: 'api key sk-123', source: 'agent-proposed' },
      { userConfirmed: true },
    )).rejects.toThrowMatchingObject({ code: 'guard-secret' })
  })

  it('removes an entry, emits the remove event, and rejects a second removal', async () => {
    const { ctx, committed } = await mount()
    const { entry } = await ctx.habits.write({ layer: 'global', topic: 'style', value: '简洁', source: 'user' })
    await expect(ctx.habits.remove(entry.id)).resolves.toBe(entry)
    expect(committed).toEqual([[entry, 'add'], [entry, 'remove']])
    expect(ctx.habits.list()).toEqual([])
    await expect(ctx.habits.remove(entry.id)).rejects.toThrowMatchingObject({ code: 'not-found' })
  })

  it('throws typed HabitError instances', async () => {
    const { ctx } = await mount()
    try {
      await ctx.habits.write({ layer: 'global', topic: 'bad topic', value: 'x', source: 'user' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(HabitError)
      expect((error as HabitError).code).toBe('invalid-topic')
    }
  })
})

describe('renderHabitsSection', () => {
  it('renders the empty string for no entries', () => {
    expect(renderHabitsSection([])).toBe('')
  })

  it('pins the canonical resident section text', () => {
    const entry: HabitEntry = {
      id: habitId('global:style'),
      layer: 'global',
      topic: 'style',
      value: '简洁',
      source: 'user',
      version: 1,
      updatedAt: 1,
    }
    expect(renderHabitsSection([entry])).toBe([
      '## 用户习惯',
      '',
      '以下为该用户确认过的偏好。撰写回复时主动遵守;同主题条目以项目级为准。',
      '',
      '- [style] 简洁',
    ].join('\n'))
  })
})

expect.extend({
  toThrowMatchingObject(received: unknown, expected: object) {
    let error: unknown
    try {
      if (typeof received === 'function') {
        ;(received as () => unknown)()
        return { pass: false, message: () => 'expected function to throw' }
      }
      error = received
    } catch (thrown) {
      error = thrown
    }
    const pass = Object.entries(expected).every(
      entry => (error as Record<string, unknown>)[entry[0]] === entry[1],
    )
    return { pass, message: () => `expected thrown error to match ${JSON.stringify(expected)}, got ${String(error)}` }
  },
})

declare module 'vitest' {
  interface Assertion<T> {
    toThrowMatchingObject(expected: object): T
  }
}
