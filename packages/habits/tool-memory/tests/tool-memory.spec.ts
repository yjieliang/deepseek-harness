import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HabitService } from '@deepseek-ai/dsh-user-habits'
import type { HabitEntry, HabitId } from '@deepseek-ai/dsh-user-habits'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { Config, apply, inject, name } from '../src/index.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

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

interface SectionRegistration {
  name: string
  order: number
  text: string | (() => string)
}

interface MountOptions {
  config?: ConstructorParameters<typeof Config>[0]
  ask?: (request: AskUserQuestionRequest) => Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
}

const mount = async (options: MountOptions = {}): Promise<{
  ctx: Context
  tools: ToolDefinition[]
  sections: SectionRegistration[]
  asked: AskUserQuestionRequest[]
}> => {
  const ctx = new Context()
  const tools: ToolDefinition[] = []
  const sections: SectionRegistration[] = []
  const asked: AskUserQuestionRequest[] = []
  ctx.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.push(definition)
      return () => {}
    },
  })
  ctx.provide('systemPrompt', {
    section: (definition: SectionRegistration) => {
      sections.push(definition)
      return () => {}
    },
  })
  if (options.ask !== undefined) {
    ctx.provide('userQuestions', {
      ask: async (request: AskUserQuestionRequest) => {
        asked.push(request)
        return options.ask!(request)
      },
    })
  }
  await ctx.plugin(MemoryHabits)
  await ctx.plugin({ name, inject, Config, apply }, options.config)
  return { ctx, tools, sections, asked }
}

/** One preset confirmation answer. */
type AskFn = (request: AskUserQuestionRequest) => Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>

/** Preset answers for the confirmation question. */
const answer = (selected: string, custom?: string, id = 'memory-propose'): AskFn =>
  async () => ({ answers: [{ id, selected: [selected], ...custom === undefined ? {} : { custom } }] })

/** Execute one captured tool with minimal runtime plumbing. */
const run = async (tool: ToolDefinition, args: unknown): Promise<unknown> =>
  tool.execute(args, { signal: new AbortController().signal } as never)

describe('tool-memory', () => {
  it('registers the four tools and the guidance section', async () => {
    const { tools, sections } = await mount()
    expect(tools.map(tool => tool.name)).toEqual(['memory_add', 'memory_list', 'memory_remove', 'memory_propose'])
    expect(sections).toEqual([{ name: 'user-habits-guidance', order: 101, text: expect.any(String) }]) // oxlint-disable-line typescript/no-unsafe-assignment
  })

  it('memory_add returns the pinned confirmation and count', async () => {
    const { tools } = await mount()
    const add = tools.find(tool => tool.name === 'memory_add')
    expect(add).toBeDefined()
    expect(await run(add!, { topic: 'style', value: '简洁' })).toBe([
      '已记住:[style] 简洁',
      '习惯共 1 条',
    ].join('\n'))
  })

  it('memory_add defaults an empty topic to general', async () => {
    const { tools } = await mount()
    const add = tools.find(tool => tool.name === 'memory_add')
    expect(await run(add!, { value: '回复用中文' })).toContain('已记住:[general] 回复用中文')
  })

  it('memory_add names the replaced value when a same-topic entry updates', async () => {
    const { tools } = await mount()
    const add = tools.find(tool => tool.name === 'memory_add')
    await run(add!, { topic: 'lang', value: '中文' })
    expect(await run(add!, { topic: 'lang', value: '英文' })).toBe([
      '已记住:[lang] 英文',
      '(已覆盖同主题旧条目:中文)',
      '习惯共 1 条',
    ].join('\n'))
  })

  it('memory_add propagates guard rejections without a confirmation channel', async () => {
    const { tools } = await mount()
    const add = tools.find(tool => tool.name === 'memory_add')
    await expect(run(add!, { topic: 'style', value: 'api key sk-123' }))
      .rejects.toThrowMatchingObject({ code: 'guard-secret' })
  })

  it('memory_add asks for confirmation on guarded content and writes after override', async () => {
    const { ctx, tools, asked } = await mount({ ask: answer('仍然记住', undefined, 'memory-add-confirm') })
    const add = tools.find(tool => tool.name === 'memory_add')
    expect(await run(add!, { topic: 'style', value: 'api key sk-123' })).toContain('已记住:[style] api key sk-123')
    expect(asked[0]?.questions[0]).toMatchObject({ question: '待确认:该内容包含疑似敏感信息,确认仍要记住吗?' })
    expect(ctx.habits.list()).toHaveLength(1)
  })

  it('memory_add cancels the guarded write when the human declines', async () => {
    const { ctx, tools } = await mount({ ask: answer('算了', undefined, 'memory-add-confirm') })
    const add = tools.find(tool => tool.name === 'memory_add')
    expect(await run(add!, { topic: 'style', value: 'api key sk-123' })).toBe('未记录,已取消。')
    expect(ctx.habits.list()).toEqual([])
  })

  it('memory_add rejects the project layer and points at USER.md', async () => {
    const { tools } = await mount()
    const add = tools.find(tool => tool.name === 'memory_add')
    await expect(run(add!, { topic: 'style', value: '简洁', layer: 'project' }))
      .rejects.toThrow('项目层习惯请直接编辑工作区 USER.md')
  })

  it('memory_list renders the empty state and the grouped list', async () => {
    const { tools } = await mount()
    const list = tools.find(tool => tool.name === 'memory_list')
    expect(await run(list!, {})).toBe('(无已记录习惯)')
    const add = tools.find(tool => tool.name === 'memory_add')
    await run(add!, { topic: 'style', value: '简洁' })
    expect(await run(list!, {})).toBe([
      '全局习惯 (L1):',
      '- [style] 简洁',
      '共 1 条',
    ].join('\n'))
  })

  it('memory_list filters by layer', async () => {
    const { ctx, tools } = await mount()
    await ctx.habits.write({ layer: 'global', topic: 'lang', value: '中文', source: 'user' })
    await ctx.habits.write({ layer: 'project', topic: 'commit', value: 'conventional', source: 'user' })
    const list = tools.find(tool => tool.name === 'memory_list')
    const text = await run(list!, { layer: 'project' }) as string
    expect(text).toContain('项目习惯 (L2):')
    expect(text).not.toContain('全局习惯')
  })

  it('memory_remove deletes by id and pins the not-found message', async () => {
    const { ctx, tools } = await mount()
    const { entry } = await ctx.habits.write({ layer: 'global', topic: 'style', value: '简洁', source: 'user' })
    const remove = tools.find(tool => tool.name === 'memory_remove')
    expect(await run(remove!, { id: entry.id })).toBe('已删除:[style] 简洁')
    await expect(run(remove!, { id: entry.id })).rejects.toThrow('未找到该条目,先用 memory_list 查看当前条目。')
  })

  it('memory_propose writes on confirmation with the agent-proposed source', async () => {
    const { ctx, tools, asked } = await mount({ ask: answer('记住') })
    const propose = tools.find(tool => tool.name === 'memory_propose')
    expect(await run(propose!, { topic: 'style', value: '简洁', evidence: '你说喜欢简洁' }))
      .toBe('已记录:[style] 简洁')
    const entry = ctx.habits.list('global')[0]
    expect(entry).toMatchObject({ topic: 'style', source: 'agent-proposed' })
    expect(asked[0]?.questions[0]).toMatchObject({ question: '要记住这条用户习惯吗?' })
  })

  it('memory_propose does not write on rejection and remembers the rejection', async () => {
    const { ctx, tools } = await mount({ ask: answer('忽略') })
    const propose = tools.find(tool => tool.name === 'memory_propose')
    expect(await run(propose!, { topic: 'style', value: '简洁', evidence: '依据' }))
      .toBe('未记录,已忽略该建议。')
    expect(ctx.habits.list()).toEqual([])
    expect(await run(propose!, { topic: 'style', value: '简洁', evidence: '依据' }))
      .toBe('未记录。近期已提过相同建议,不再重复询问。')
  })

  it('memory_propose surfaces the typed custom answer', async () => {
    const { tools } = await mount({ ask: answer('忽略', '其实我想要的是详细风格') })
    const propose = tools.find(tool => tool.name === 'memory_propose')
    expect(await run(propose!, { topic: 'style', value: '简洁', evidence: '依据' }))
      .toBe('未记录,已忽略该建议。用户补充:其实我想要的是详细风格')
  })

  it('memory_propose hard-rejects guarded content before asking', async () => {
    const { tools, asked } = await mount({ ask: answer('记住') })
    const propose = tools.find(tool => tool.name === 'memory_propose')
    await expect(run(propose!, { topic: 'style', value: 'api key sk-123', evidence: '依据' }))
      .rejects.toThrow('未记录。该建议未通过安全校验(原因:guard-secret),已拒绝。')
    expect(asked).toHaveLength(0)
  })

  it('memory_propose rejects an invalid topic without asking', async () => {
    const { tools } = await mount({ ask: answer('记住') })
    const propose = tools.find(tool => tool.name === 'memory_propose')
    await expect(run(propose!, { topic: 'not a topic', value: 'x', evidence: '依据' }))
      .rejects.toThrow('主题键需匹配')
  })

  it('memory_propose reports a missing confirmation channel', async () => {
    const { tools } = await mount()
    const propose = tools.find(tool => tool.name === 'memory_propose')
    await expect(run(propose!, { topic: 'style', value: '简洁', evidence: '依据' }))
      .rejects.toThrow('当前环境没有可用的用户确认通道')
  })

  it('memory_propose skips asking when userQuestionAsk is disabled', async () => {
    const { tools, asked } = await mount({ config: { userQuestionAsk: false }, ask: answer('记住') })
    const propose = tools.find(tool => tool.name === 'memory_propose')
    expect(await run(propose!, { topic: 'style', value: '简洁', evidence: '依据' }))
      .toBe('未记录。当前已关闭提议确认,如需记录请让用户明确要求。')
    expect(asked).toHaveLength(0)
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
