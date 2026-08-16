import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HabitService } from '@deepseek-ai/dsh-user-habits'
import type { HabitEntry, HabitId } from '@deepseek-ai/dsh-user-habits'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { apply, inject, name } from '../src/index.ts'

/** In-memory habit store over the contract hooks. */
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

const mount = async (ask?: (request: AskUserQuestionRequest) => Promise<{ answers: Array<{ id: string; selected: string[] }> }>): Promise<{
  ctx: Context
  command: CommandDefinition
}> => {
  const ctx = new Context()
  let command: CommandDefinition | undefined
  ctx.provide('commands', {
    register: (definition: CommandDefinition) => {
      command = definition
      return () => {}
    },
  })
  if (ask !== undefined) {
    ctx.provide('userQuestions', {
      ask: async (request: AskUserQuestionRequest) => ask(request),
    })
  }
  await ctx.plugin(MemoryHabits)
  await ctx.plugin({ name, inject, apply })
  return { ctx, command: command! }
}

/** Invoke the command handler with minimal plumbing. */
const run = async (command: CommandDefinition, rawInput: string) =>
  command.handler({ commandId: 'cmd-1' as never, agent: undefined as never, rawInput, signal: new AbortController().signal })

describe('command-memory', () => {
  it('registers the /memory command recording raw input for traceability', async () => {
    const { command } = await mount()
    expect(command).toMatchObject({ name: 'memory' })
    expect(command.recordInput).toBeUndefined()
  })

  it('shows pinned help for the bare command', async () => {
    const { command } = await mount()
    expect(await run(command, '')).toEqual({ kind: 'success', text: expect.stringContaining('/memory add <内容>') }) // oxlint-disable-line typescript/no-unsafe-assignment
  })

  it('adds a habit as general and returns the pinned confirmation', async () => {
    const { command } = await mount()
    expect(await run(command, 'add 回复用中文')).toEqual({ kind: 'success', text: '已记住:[general] 回复用中文' })
  })

  it('rejects an empty add with a guidance error', async () => {
    const { command } = await mount()
    expect(await run(command, 'add   ')).toEqual({
      kind: 'error',
      text: '/memory add 需要习惯内容,如 /memory add 回复用中文',
    })
  })

  it('surfaces guard rejections as command errors without a confirmation channel', async () => {
    const { command } = await mount()
    const result = await run(command, 'add api key sk-123')
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('secret') }) // oxlint-disable-line typescript/no-unsafe-assignment
  })

  it('asks for confirmation on guarded content and writes after override', async () => {
    const { ctx, command } = await mount(async () => ({
      answers: [{ id: 'memory-add-confirm', selected: ['仍然记住'] }],
    }))
    expect(await run(command, 'add api key sk-123')).toEqual({ kind: 'success', text: '已记住:[general] api key sk-123' })
    expect(ctx.habits.list()).toHaveLength(1)
  })

  it('cancels the guarded write when the human declines', async () => {
    const { ctx, command } = await mount(async () => ({
      answers: [{ id: 'memory-add-confirm', selected: ['算了'] }],
    }))
    expect(await run(command, 'add api key sk-123')).toEqual({ kind: 'success', text: '未记录,已取消。' })
    expect(ctx.habits.list()).toEqual([])
  })

  it('lists habits and removes one by id', async () => {
    const { ctx, command } = await mount()
    const { entry } = await ctx.habits.write({ layer: 'global', topic: 'general', value: '回复用中文', source: 'user' })
    expect(await run(command, 'list')).toEqual({
      kind: 'success',
      text: ['全局习惯 (L1):', '- [general] 回复用中文', '共 1 条'].join('\n'),
    })
    expect(await run(command, `remove ${entry.id}`)).toEqual({ kind: 'success', text: '已删除:[general] 回复用中文' })
    expect(await run(command, `remove ${entry.id}`)).toEqual({
      kind: 'error',
      text: '未找到该条目,先用 /memory list 查看当前条目。',
    })
  })
})
