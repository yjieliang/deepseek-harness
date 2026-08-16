/**
 * Human-facing `/memory` slash command over the habits seam (`ctx.habits`):
 * add, list, and remove — the same write path the model tools use, so guard
 * and consolidation enforcement is identical for humans. Dispatches without
 * a model turn.
 *
 * @module @deepseek-ai/dsh-command-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-questions'
import { HabitError, habitId } from '@deepseek-ai/dsh-user-habits'
import type { HabitEntry } from '@deepseek-ai/dsh-user-habits'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'command-memory'

/** Services required before the command can register. */
export const inject = ['commands', 'habits']

/** Pinned help text for the bare command. */
const HELP = [
  '/memory add <内容>  记录一条用户习惯(主题 general)',
  '/memory list        列出当前已记录的习惯',
  '/memory remove <id> 按条目 id 删除(形如 global:general)',
].join('\n')

/** One parsed command line. */
type ParsedCommand =
  | { readonly sub: 'help' }
  | { readonly sub: 'add'; readonly value: string }
  | { readonly sub: 'list' }
  | { readonly sub: 'remove'; readonly id: string }

/** Parse the raw input after `/memory` into one subcommand. */
function parse(raw: string): ParsedCommand {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === 'help') return { sub: 'help' }
  const separator = trimmed.indexOf(' ')
  const sub = separator === -1 ? trimmed : trimmed.slice(0, separator)
  const rest = separator === -1 ? '' : trimmed.slice(separator).trim()
  if (sub === 'list') return { sub: 'list' }
  if (sub === 'add') return { sub: 'add', value: rest }
  if (sub === 'remove') return { sub: 'remove', id: rest }
  return { sub: 'help' }
}

/** Render one entry's list row for the human-facing output. */
const renderRow = (entry: HabitEntry): string => `- [${entry.topic}] ${entry.value}`

/**
 * Register the `/memory` command.
 * @param ctx - Cordis context carrying the commands and habits services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'memory',
    description: '管理用户习惯记忆(add/list/remove)',
    input: { hint: 'add <内容> | list | remove <id>' },
    handler: async ({ rawInput, agent, signal }): Promise<CommandResult> => {
      const parsed = parse(rawInput)
      switch (parsed.sub) {
        case 'help':
          return { kind: 'success', text: HELP }
        case 'list': {
          const entries = ctx.habits.list()
          if (entries.length === 0) return { kind: 'success', text: '(无已记录习惯)' }
          const lines: string[] = []
          const global = entries.filter(entry => entry.layer === 'global')
          const project = entries.filter(entry => entry.layer === 'project')
          if (global.length > 0) lines.push('全局习惯 (L1):', ...global.map(renderRow))
          if (project.length > 0) lines.push('项目习惯 (L2):', ...project.map(renderRow))
          lines.push(`共 ${entries.length} 条`)
          return { kind: 'success', text: lines.join('\n') }
        }
        case 'add': {
          if (parsed.value === '') {
            return { kind: 'error', text: '/memory add 需要习惯内容,如 /memory add 回复用中文' }
          }
          const writeConfirmed = async (userConfirmed: boolean): Promise<CommandResult> => {
            const { entry, op, replaced } = await ctx.habits.write({
              layer: 'global',
              topic: 'general',
              value: parsed.value,
              source: 'user',
            }, { userConfirmed })
            const lines = [`已记住:[${entry.topic}] ${entry.value}`]
            if (op === 'update' && replaced !== undefined) lines.push(`(已覆盖同主题旧条目:${replaced.value})`)
            return { kind: 'success', text: lines.join('\n') }
          }
          try {
            return await writeConfirmed(false)
          } catch (error) {
            if (!(error instanceof HabitError)
              || (error.code !== 'guard-injection' && error.code !== 'guard-secret')) {
              if (error instanceof HabitError) return { kind: 'error', text: error.message }
              throw error
            }
            // User-authored content: a human may confirm the warning and override.
            const questions = ctx.get('userQuestions')
            if (questions === undefined) return { kind: 'error', text: error.message }
            const answer = await questions.ask({
              questions: [{
                id: 'memory-add-confirm',
                question: '待确认:该内容包含疑似敏感信息,确认仍要记住吗?',
                options: [{ label: '仍然记住' }, { label: '算了' }],
              }],
              agent,
              signal,
            })
            const item = answer.answers.find(candidate => candidate.id === 'memory-add-confirm')
            if (item?.selected.includes('仍然记住')) return await writeConfirmed(true)
            return { kind: 'success', text: '未记录,已取消。' }
          }
        }
        case 'remove': {
          if (parsed.id === '') {
            return { kind: 'error', text: '/memory remove 需要条目 id(从 /memory list 获取)' }
          }
          try {
            const entry = await ctx.habits.remove(habitId(parsed.id))
            return { kind: 'success', text: `已删除:[${entry.topic}] ${entry.value}` }
          } catch (error) {
            if (error instanceof HabitError && error.code === 'not-found') {
              return { kind: 'error', text: '未找到该条目,先用 /memory list 查看当前条目。' }
            }
            if (error instanceof HabitError) return { kind: 'error', text: error.message }
            throw error
          }
        }
      }
    },
  }), 'command-memory: /memory')
}
