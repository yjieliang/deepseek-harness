/**
 * Model-facing user-habit memory tools over the habits seam (`ctx.habits`):
 * `memory_add`, `memory_list`, `memory_remove`, and `memory_propose`, plus the
 * tool-guidance prompt section. This package owns schemas, argument validation
 * at the model-JSON boundary, the user-confirmation flow, and the pinned
 * model-visible result text; the guard, consolidation, and storage live in the
 * contract and its provider, so every caller passes the same enforcement.
 *
 * `memory_propose` is the semi-automatic path: the model proposes an observed
 * habit, the guard pre-checks the candidate (agent-proposed content is hard-
 * rejected), a user question asks for confirmation, and only an accepted
 * proposal reaches the write path. Proposals never persist unless confirmed.
 *
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-user-questions'
import {
  HabitError,
  TOPIC_PATTERN,
  guardHabitContent,
  habitId,
} from '@deepseek-ai/dsh-user-habits'
import type { HabitEntry, HabitLayer } from '@deepseek-ai/dsh-user-habits'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-memory'

/** Services required by the habit tool suite; `userQuestions` stays optional. */
export const inject = ['tools', 'habits', 'systemPrompt']

/** Plugin config; every key is optional and `Config` supplies the defaults. */
export interface Config {
  /** Whether memory_propose asks the user before writing. */
  userQuestionAsk?: boolean
  /** Millisecond window inside which an identical proposal is not re-asked. */
  proposalDedupTtlMs?: number
}

export const Config: z<Config> = z.object({
  userQuestionAsk: z.boolean().default(true),
  proposalDedupTtlMs: z.number().min(1).default(7 * 24 * 60 * 60 * 1000),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** The guidance section text, stable for model-visible transcripts. */
const HABITS_PROMPT_SECTION = [
  '用户习惯(memory)工具:',
  '- 当用户明确表达「以后都…」「记住…」「我习惯…」「我一直都是…」等偏好、规范或约定,要把它落成可跨会话生效的记忆时:调用 memory_add 记录,而不是只在对话里口头应承。',
  '- 你观察到用户的稳定偏好但用户没有明确要求记录时,用 memory_propose 建议记录,经用户确认后再写。',
  '- 已有同主题习惯时,memory_add 会覆盖旧值(同 topic 合并),无需先删除。',
  '- 只有用户明确要求或确认的才写入;不要把未经确认的临时偏好自动写进长期习惯。',
  '- 记忆内容如需修改或删除,用 memory_list 查看后再 memory_remove。',
].join('\n')

/** Plain-text render shared by every tool (canonical values are strings). */
const textRender = (_args: unknown, value: JsonValue): ContentBlock[] =>
  [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]

/** Register one tool as a scoped effect of this plugin's fiber. */
const register = (ctx: Context, def: ToolDefinition): void => {
  ctx.effect(() => ctx.tools.register(def), `tool-memory: ${def.name}`)
}

/** Resolve the optional layer argument to one contract layer or undefined. */
function resolveLayer(raw: unknown): HabitLayer | undefined {
  return raw === 'global' || raw === 'project' ? raw : undefined
}

/** Render one entry's pinned list row. */
const renderRow = (entry: HabitEntry): string => `- [${entry.topic}] ${entry.value}`

/** The single question id shared by every proposal confirmation. */
const PROPOSE_QUESTION_ID = 'memory-propose'

/**
 * Register the habit tool suite plus its guidance section.
 * @param ctx - Cordis context carrying the tools, habits, and systemPrompt services.
 * @param config - validated config (schemastery filled the defaults).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = config as ResolvedConfig
  // Process-local proposal memory: recently asked or rejected proposals are
  // not re-asked inside the TTL window. Plugin-fiber scoped, so unloading the
  // plugin forgets it; persisted cross-session dedup is deferred work.
  const proposalSeen = new Map<string, number>()

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'user-habits-guidance',
    order: 101,
    text: HABITS_PROMPT_SECTION,
  }), 'tool-memory: prompt section')

  register(ctx, {
    name: 'memory_add',
    description: '记录一条用户习惯:用户明确要求记住的偏好、规范或约定',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '主题键(小写英文短横线),如 style/lang/commit;留空则记为 general' },
        value: { type: 'string', description: '习惯内容,精炼描述(单条 ≤ 200 字符)' },
        layer: { type: 'string', description: '作用层:global(全局)或 project(当前项目);project 层由工作区 USER.md 承载,本工具仅写 global' },
      },
      required: ['value'],
    },
    output: { schema: { type: 'string' }, render: textRender },
    execute: async (args, exec) => {
      const input = args as { topic?: unknown; value?: unknown; layer?: unknown }
      const layer: HabitLayer = input.layer === 'project' ? 'project' : 'global'
      if (layer === 'project') {
        throw new Error('项目层习惯请直接编辑工作区 USER.md(一个 `## topic` 小节一条,如 `## style`);memory_add 只写全局习惯。')
      }
      const topic = typeof input.topic === 'string' && input.topic.trim() !== '' ? input.topic : 'general'
      const value = typeof input.value === 'string' ? input.value : ''
      const writeConfirmed = async (userConfirmed: boolean): Promise<string> => {
        const { entry, op, replaced } = await ctx.habits.write(
          { layer, topic, value, source: 'user' },
          { userConfirmed },
        )
        const lines = [`已记住:[${entry.topic}] ${entry.value}`]
        if (op === 'update' && replaced !== undefined) {
          lines.push(`(已覆盖同主题旧条目:${replaced.value})`)
        }
        lines.push(`习惯共 ${ctx.habits.list().length} 条`)
        return lines.join('\n')
      }
      try {
        return await writeConfirmed(false)
      } catch (error) {
        if (!(error instanceof HabitError)
          || (error.code !== 'guard-injection' && error.code !== 'guard-secret')) {
          throw error
        }
        // User-authored content: a human may confirm the warning and override.
        const questions = ctx.get('userQuestions')
        if (questions === undefined) throw error
        const answer = await questions.ask({
          questions: [{
            id: 'memory-add-confirm',
            question: '待确认:该内容包含疑似敏感信息,确认仍要记住吗?',
            options: [{ label: '仍然记住' }, { label: '算了' }],
          }],
          ...exec.agent === undefined ? {} : { agent: exec.agent },
          signal: exec.signal,
        })
        const item = answer.answers.find(candidate => candidate.id === 'memory-add-confirm')
        if (item?.selected.includes('仍然记住')) return await writeConfirmed(true)
        return '未记录,已取消。'
      }
    },
  })

  register(ctx, {
    name: 'memory_list',
    description: '列出当前已记录的用户习惯(按主题分组)',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: '仅列 global(全局)或 project(项目);省略列出全部' },
      },
    },
    output: { schema: { type: 'string' }, render: textRender },
    // oxlint-disable-next-line typescript/require-await -- async keeps the tool-execute contract's promise rejection semantics
    execute: async (args) => {
      const input = args as { layer?: unknown }
      const entries = ctx.habits.list(resolveLayer(input.layer))
      if (entries.length === 0) return '(无已记录习惯)'
      const lines: string[] = []
      const global = entries.filter(entry => entry.layer === 'global')
      const project = entries.filter(entry => entry.layer === 'project')
      if (global.length > 0) lines.push('全局习惯 (L1):', ...global.map(renderRow))
      if (project.length > 0) lines.push('项目习惯 (L2):', ...project.map(renderRow))
      lines.push(`共 ${entries.length} 条`)
      return lines.join('\n')
    },
  })

  register(ctx, {
    name: 'memory_remove',
    description: '删除一条用户习惯(按 memory_list 给出的条目 id)',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '条目 id,从 memory_list 输出获取(形如 global:style)' },
      },
      required: ['id'],
    },
    output: { schema: { type: 'string' }, render: textRender },
    execute: async (args) => {
      const input = args as { id?: unknown }
      if (typeof input.id !== 'string' || input.id.length === 0) {
        throw new Error('memory_remove 需要条目 id(从 memory_list 获取)')
      }
      let entry: HabitEntry
      try {
        entry = await ctx.habits.remove(habitId(input.id))
      } catch (error) {
        if (error instanceof HabitError && error.code === 'not-found') {
          throw new Error('未找到该条目,先用 memory_list 查看当前条目。')
        }
        throw error
      }
      return `已删除:[${entry.topic}] ${entry.value}`
    },
  })

  register(ctx, {
    name: 'memory_propose',
    description: '提议记录一条你观察到的用户习惯,经用户确认后才写入',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '主题键(小写英文短横线),如 style/lang/commit' },
        value: { type: 'string', description: '建议的习惯内容,精炼描述' },
        evidence: { type: 'string', description: '你观察到该习惯的依据(用户原话或行为)' },
      },
      required: ['topic', 'value', 'evidence'],
    },
    output: { schema: { type: 'string' }, render: textRender },
    execute: async (args, exec) => {
      const input = args as { topic?: unknown; value?: unknown; evidence?: unknown }
      const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
      const value = typeof input.value === 'string' ? input.value : ''
      const evidence = typeof input.evidence === 'string' ? input.evidence : ''
      if (topic === '' || value === '' || evidence === '') {
        throw new Error('memory_propose 需要 topic、value 与 evidence(你观察到该习惯的依据)')
      }
      if (!TOPIC_PATTERN.test(topic)) {
        throw new Error(`主题键需匹配 ${String(TOPIC_PATTERN)}`)
      }
      // Agent-proposed content is hard-rejected before any human is asked.
      try {
        guardHabitContent(value)
      } catch (error) {
        if (error instanceof HabitError) {
          throw new Error(`未记录。该建议未通过安全校验(原因:${error.code}),已拒绝。`)
        }
        throw error
      }
      const key = `${topic}\n${value}`
      const seenAt = proposalSeen.get(key)
      if (seenAt !== undefined && Date.now() - seenAt < resolved.proposalDedupTtlMs) {
        return '未记录。近期已提过相同建议,不再重复询问。'
      }
      const questions = ctx.get('userQuestions')
      if (questions === undefined) {
        throw new Error('当前环境没有可用的用户确认通道,无法提议记忆;请让用户直接说明要记住的内容。')
      }
      if (!resolved.userQuestionAsk) {
        return '未记录。当前已关闭提议确认,如需记录请让用户明确要求。'
      }
      const answer = await questions.ask({
        questions: [{
          id: PROPOSE_QUESTION_ID,
          question: '要记住这条用户习惯吗?',
          detail: `[${topic}] ${value}\n依据:${evidence}\n想调整内容?选「忽略」后直接说要记住什么。`,
          options: [{ label: '记住' }, { label: '忽略' }],
        }],
        ...exec.agent === undefined ? {} : { agent: exec.agent },
        signal: exec.signal,
      })
      const item = answer.answers.find(candidate => candidate.id === PROPOSE_QUESTION_ID)
      const custom = item?.custom === undefined || item.custom.trim() === '' ? undefined : item.custom.trim()
      if (item?.selected.includes('记住')) {
        const { entry } = await ctx.habits.write({ layer: 'global', topic, value, source: 'agent-proposed' })
        return `已记录:[${entry.topic}] ${entry.value}`
      }
      proposalSeen.set(key, Date.now())
      return custom === undefined
        ? '未记录,已忽略该建议。'
        : `未记录,已忽略该建议。用户补充:${custom}`
    },
  })
}
