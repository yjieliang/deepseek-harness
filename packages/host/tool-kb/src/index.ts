/**
 * Model-facing knowledge-base tools over `ctx.kb` (the `@deepseek-ai/dsh-host-kb`
 * gateway service): search/add/get/update/move/delete/links/tags/stats/archive/
 * organize/images/import/export/clip for the `kb/` workspace root.
 *
 * This package owns the tool schemas, argument validation, field-syntax
 * parsing, prompt section, and composite orchestration (archive, organize,
 * import, export, clip); it never touches files or the index itself. The
 * engine and every read/write operation live in the host service, so both the
 * browser panel and the agent tools share one implementation.
 * @module @deepseek-ai/dsh-tool-kb
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Loads the `ctx.web` declaration so `ctx.get('web')` resolves the typed overload.
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-host-kb'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { KbSaveRequest, KbStatusFilter } from '@deepseek-ai/dsh-host-kb/types'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-kb'

/** Services required by the knowledge-base tool suite; `web` stays optional. */
export const inject = ['tools', 'kb', 'systemPrompt']

/** Plugin config; every key is optional and `Config` supplies the defaults. */
export interface Config {
  /** Default result cap for `kb_search` when the call omits `topK`. */
  searchTopK?: number
  /** Bulk operations at or above this many documents refuse without a prior preview. */
  batchConfirmN?: number
  /** Default age threshold (days) for `kb_archive` when the call omits `days`. */
  archiveDays?: number
  /** Maximum characters of a clipped page body kept by `kb_clip`. */
  clipMaxBodyChars?: number
}

export const Config: z<Config> = z.object({
  searchTopK: z.number().default(10),
  batchConfirmN: z.number().default(5),
  archiveDays: z.number().default(90),
  clipMaxBodyChars: z.number().default(20000),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** The prompt section text, stable for model-visible transcripts. */
const KB_PROMPT_SECTION =
  '知识库(Knowledge Base)位于 $DSH_HOME/kb(不在工作区路径内,不要用 read 文件工具打开),提供 kb_search / kb_get / kb_add / kb_update / kb_move / kb_rename / kb_delete / kb_links / kb_tags / kb_stats / kb_archive / kb_organize / kb_images / kb_import / kb_export / kb_clip 共 16 个工具。\n\n'
  + '【按需检索】默认不要主动检索知识库。只有当用户明确表达参考知识库意图时才调用 kb_* 工具:\n'
  + '- 用户消息包含「知识库」「kb」「笔记」「根据XX文档」「我记得知识库里有」等明确指向词汇;\n'
  + '- 用户消息含 @kb:path 引用(用 kb_get 按路径读取)或 [[标题]] wiki 链接(用 kb_search 按标题定位,再 kb_get 读取);\n'
  + '- 用户明确要求「查知识库/查笔记/找那篇」。\n\n'
  + '【引用语法】@ 开头的路径默认是工作区文件,用 read 读取;但 @kb: 开头的引用(含 @kb:"带空格的路径")是 $DSH_HOME/kb 下的知识库文档,必须用 kb_get 按路径读取,不要用 read。\n\n'
  + '普通对话、工作区文件操作不要触发 kb_search。'

/** Canonical JSON-text render shared by every tool. */
const toolRender = (_args: unknown, value: JsonValue): ContentBlock[] =>
  [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/** Register one tool as a scoped effect of this plugin's fiber. */
const register = (ctx: Context, def: ToolDefinition): void => {
  ctx.effect(() => ctx.tools.register(def), `tool-kb: ${def.name}`)
}

/** A document title plus tags for the `kb_add`/`kb_import` surfaces. */
interface SeedArgs {
  title?: string
  content?: string
  directory?: string
  tags?: string[]
  source?: string
  summary?: string
}

/** Split `tag:`/`path:`/`status:`/`title:` prefixes out of a search query. */
function parseFieldFilters(query: string): { query: string; filters: KbSearchFiltersInput } {
  const filters: KbSearchFiltersInput = {}
  let rest = query.trim()
  for (const token of rest.match(/(tag|path|status|title):([^\s]+)/g) ?? []) {
    const sep = token.indexOf(':')
    const key = token.slice(0, sep)
    const value = token.slice(sep + 1)
    if (key === 'tag') filters.tag = value
    else if (key === 'path') filters.directory = value
    else if (key === 'status') filters.status = value as KbStatusFilter
    else filters.title = value
    rest = rest.replace(token, '').trim()
  }
  return { query: rest, filters }
}

/** Field filters accepted by the tool search surface. */
interface KbSearchFiltersInput {
  status?: KbStatusFilter
  tag?: string
  directory?: string
  title?: string
}

/** Clamp one topK argument to the wire range. */
function clampTopK(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(50, Number(value) || fallback))
}

/**
 * Register the full knowledge-base tool suite plus its prompt section.
 * @param ctx - Cordis context carrying the tools, kb, and systemPrompt services.
 * @param config - validated config (schemastery filled the defaults).
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  // Order 100 places this section after the file-reference section (order 99):
  // its 【引用语法】 paragraph is the model's latest word on the `@` grammar,
  // carving `@kb:` out of the workspace-file rule.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'knowledge-base',
    order: 100,
    text: KB_PROMPT_SECTION,
  }), 'tool-kb: prompt section')

  register(ctx, {
    name: 'kb_search',
    description: '检索知识库:关键词匹配标题/别名/摘要/标签/正文,支持 tag:xxx、path:xxx、status:inbox、title:xxx 语法。若用户表述口语化(如「那篇讲用户习惯的」),先把目标扩为 2-4 个候选关键词(中文原文 + 可能的技术/英文别名 + 标签词),用空格分隔再搜索,以提高召回。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词,多词空格为 AND;口语化表述请先展开为多组候选关键词再搜索;支持 tag:/path:/status:/title: 前缀过滤器' },
        topK: { type: 'integer', description: `返回条数上限,默认 ${resolved.searchTopK}` },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const input = args as { query?: string; topK?: number }
      const { query, filters } = parseFieldFilters(input.query ?? '')
      const topK = clampTopK(input.topK, resolved.searchTopK)
      const result = await ctx.kb.searchFiltered({ query, topK, ...filters }, exec.signal)
      return { hits: result.hits, total: result.total }
    },
  })

  register(ctx, {
    name: 'kb_add',
    description: '向知识库新建一篇文档,默认落入收集箱(00-inbox);自动生成标题和 frontmatter',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文档标题' },
        content: { type: 'string', description: 'Markdown 正文,可选' },
        directory: { type: 'string', description: '目标目录,默认 00-inbox' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
        source: { type: 'string', description: '原始来源 URL' },
        summary: { type: 'string', description: '一句话摘要' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const input = args as SeedArgs
      if (!input.title || input.title.trim().length === 0) throw new Error('kb: 标题不能为空')
      const result = await ctx.kb.createDoc(seedRequest(input), exec.signal)
      return { path: result.path }
    },
  })

  register(ctx, {
    name: 'kb_get',
    description: '读取知识库文档全文与元数据(含反向链接)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档相对路径,如 00-inbox/2026-08-14-测试文档.md' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const path = (args as { path?: string }).path ?? ''
      if (path.length === 0) throw new Error('kb: 缺少 path')
      return await ctx.kb.get({ path }, exec.signal)
    },
  })

  register(ctx, {
    name: 'kb_update',
    description: '更新知识库文档正文或元数据字段(带 expectVersion 乐观锁,冲突时提示重读)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档相对路径' },
        content: { type: 'string', description: '新的 Markdown 正文(不含 frontmatter),可选' },
        summary: { type: 'string', description: '更新摘要,可选' },
        tags: { type: 'array', items: { type: 'string' }, description: '替换标签列表' },
        expectVersion: { type: 'string', description: '读取时得到的版本令牌;不匹配则写失败返回冲突' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const input = args as { path?: string; content?: string; summary?: string; tags?: string[]; expectVersion?: string }
      const path = input.path ?? ''
      if (path.length === 0) throw new Error('kb: 缺少 path')
      const request: KbSaveRequest = {
        path,
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.expectVersion !== undefined ? { expectVersion: input.expectVersion } : {}),
      }
      const result = await ctx.kb.saveDoc(request, exec.signal)
      if (result.conflict) throw new Error('kb: 版本冲突,请重新读取后再更新')
      return { path: result.path, version: result.version, conflict: false }
    },
  })

  register(ctx, {
    name: 'kb_move',
    description: '移动/重命名知识库文档(移动即改变状态: 进 00-inbox 为 inbox,进归档目录为 archived)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档相对路径' },
        targetDirectory: { type: 'string', description: '目标目录,如 10-技术/11-AI' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const input = args as { path?: string; targetDirectory?: string }
      if (!input.path || !input.targetDirectory) throw new Error('kb: 缺少 path 或 targetDirectory')
      return await ctx.kb.moveDoc({ path: input.path, targetDirectory: input.targetDirectory }, exec.signal)
    },
  })

  register(ctx, {
    name: 'kb_rename',
    description: '重命名知识库文档(同一目录内更改文件名,同时更新文档标题)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档相对路径' },
        name: { type: 'string', description: '新文件名(不含扩展名和路径)' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const input = args as { path?: string; name?: string }
      if (!input.path || !input.name) throw new Error('kb: 缺少 path 或 name')
      return await ctx.kb.renameDoc({ path: input.path, name: input.name }, exec.signal)
    },
  })

  register(ctx, {
    name: 'kb_delete',
    description: '删除知识库文档(移入 .trash 回收站,不直接删除;可恢复)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档相对路径' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const path = (args as { path?: string }).path ?? ''
      if (path.length === 0) throw new Error('kb: 缺少 path')
      return await ctx.kb.deleteDoc({ path }, exec.signal)
    },
  })

  register(ctx, {
    name: 'kb_links',
    description: '查看知识库文档的出链与反向链接(知识网络)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档相对路径' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const path = (args as { path?: string }).path ?? ''
      if (path.length === 0) throw new Error('kb: 缺少 path')
      return await ctx.kb.links(path, exec.signal)
    },
  })

  register(ctx, {
    name: 'kb_tags',
    description: '列出知识库全部标签及其文档数',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (_args, exec) => await ctx.kb.tags({}, exec.signal),
  })

  register(ctx, {
    name: 'kb_stats',
    description: '知识库统计:文档总数、状态分布、目录、标签数',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (_args, exec) => {
      const stats = await ctx.kb.stats({}, exec.signal)
      return { total: stats.total, byStatus: stats.byStatus, dirs: stats.dirs, archiveDir: stats.archiveDir }
    },
  })

  register(ctx, {
    name: 'kb_archive',
    description: '将超过指定天数未更新的文档冷归档(dry-run 先行,默认只预览;超过确认阈值需先预览)',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: `阈值天数,默认 ${resolved.archiveDays}` },
        dryRun: { type: 'boolean', description: '仅预览不执行,默认 true' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const input = args as { days?: number; dryRun?: boolean }
      const days = Math.max(1, Number(input.days) || resolved.archiveDays)
      const dryRun = input.dryRun !== false
      const cutoff = Date.now() - days * 24 * 3600 * 1000
      const stats = await ctx.kb.stats({}, exec.signal)
      const list = await ctx.kb.list({}, exec.signal)
      const candidates = list.docs
        .filter(doc => doc.status !== 'archived')
        .filter((doc) => { const at = Date.parse(doc.updated); return !Number.isNaN(at) && at < cutoff })
      if (dryRun) return { dryRun, candidates: candidates.map(doc => doc.path), count: candidates.length }
      if (candidates.length > resolved.batchConfirmN) {
        throw new Error(
          `kb: 批量归档 ${candidates.length} 篇超过确认阈值 ${resolved.batchConfirmN},请先用 dry-run 预览确认`,
        )
      }
      const moved: string[] = []
      for (const doc of candidates) {
        const outcome = await ctx.kb.moveDoc({ path: doc.path, targetDirectory: stats.archiveDir }, exec.signal)
        moved.push(outcome.from + ' → ' + outcome.to)
      }
      return { dryRun, candidates: moved, count: moved.length }
    },
  })

  register(ctx, {
    name: 'kb_organize',
    description: '规则版整理报告(非 LLM):积压/重复/过期检测,供整理决策',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (_args, exec) => {
      const list = await ctx.kb.list({}, exec.signal)
      const inboxBacklog = list.docs.filter(doc => doc.status === 'inbox').length
      const seen = new Map<string, string>()
      const dupes: { a: string; b: string }[] = []
      for (const doc of list.docs) {
        const normalized = doc.title.replace(/[\s-]/g, '').toLowerCase()
        if (normalized.length < 2) continue
        const first = seen.get(normalized)
        if (first !== undefined) dupes.push({ a: first, b: doc.path })
        else seen.set(normalized, doc.path)
      }
      const cutoff = Date.now() - 90 * 24 * 3600 * 1000
      const stale = list.docs
        .filter((doc) => { const at = Date.parse(doc.updated); return !Number.isNaN(at) && at < cutoff })
        .map(doc => doc.path)
      return { report: { inboxBacklog, duplicateCandidates: dupes, staleDocs: stale } }
    },
  })

  register(ctx, {
    name: 'kb_images',
    description: '扫描知识库图片,重建 _meta/images.json,检测孤儿图片(未被任何文档引用)',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (_args, exec) => await ctx.kb.images(exec.signal),
  })

  register(ctx, {
    name: 'kb_import',
    description: '批量导入文档到知识库(每项为 {title, content, directory?, tags?};超过确认阈值请分批)',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '[{title, content, directory?, tags?}]' },
        directory: { type: 'string', description: '默认目标目录,默认 00-inbox' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const input = args as { files?: SeedArgs[]; directory?: string }
      const files = Array.isArray(input.files) ? input.files : []
      if (files.length === 0) throw new Error('kb: files 不能为空')
      if (files.length > resolved.batchConfirmN) {
        throw new Error(`kb: 批量导入 ${files.length} 篇超过确认阈值 ${resolved.batchConfirmN},请分批导入`)
      }
      const imported: string[] = []
      for (const file of files) {
        if (!file.title) continue
        const seeded = seedRequest({
          ...file,
          ...(file.directory === undefined && input.directory !== undefined ? { directory: input.directory } : {}),
        })
        const result = await ctx.kb.createDoc(seeded, exec.signal)
        imported.push(result.path)
      }
      return { imported, count: imported.length }
    },
  })

  register(ctx, {
    name: 'kb_export',
    description: '导出知识库文档全文(path 省略则导出全部;返回文件列表)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文档相对路径,可选;省略导出全部' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const input = args as { path?: string }
      const rels = input.path
        ? [input.path]
        : (await ctx.kb.list({}, exec.signal)).docs.map(doc => doc.path)
      const files: { path: string; content: string }[] = []
      for (const rel of rels) {
        const read = await ctx.kb.get({ path: rel }, exec.signal)
        files.push({ path: read.path, content: read.content })
      }
      return { files, count: files.length }
    },
  })

  register(ctx, {
    name: 'kb_clip',
    description: 'URL 剪藏:抓取网页正文存入知识库收集箱;抓取受限时降级为仅存 URL+标题',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL' },
        title: { type: 'string', description: '可选标题,默认用 URL' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: toolRender },
    execute: async (args, exec) => {
      const input = args as { url?: string; title?: string; tags?: string[] }
      const url = (input.url ?? '').trim()
      if (!/^https?:\/\//.test(url)) throw new Error('kb: 仅支持 http/https URL')
      const title = input.title || url
      const web = ctx.get('web')
      let content = ''
      let degraded = false
      let note = ''
      if (web !== undefined) {
        try {
          const result = await web.fetch({ url }, exec.signal)
          const candidate = result.body.content
          if (candidate.trim()) {
            content = candidate.trim().slice(0, resolved.clipMaxBodyChars)
            note = '已抓取正文'
          } else {
            degraded = true
            note = 'web fetch 未返回正文,降级为仅存 URL+标题'
          }
        } catch (error) {
          degraded = true
          note = '抓取失败: ' + String(error instanceof Error ? error.message : error)
        }
      } else {
        degraded = true
        note = 'web 服务不可用,降级为仅存 URL+标题'
      }
      const body = content ? '来源: ' + url + '\n\n' + content : '来源: ' + url
      const result = await ctx.kb.createDoc({
        title,
        content: body,
        directory: '00-inbox',
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        source: url,
        summary: degraded ? note : title,
      }, exec.signal)
      return { path: result.path, degraded, note }
    },
  })
}

/** Build one create request from the shared seed fields. */
function seedRequest(input: SeedArgs): {
  title: string
  content?: string
  directory?: string
  tags?: string[]
  source?: string
  summary?: string
} {
  const request: {
    title: string
    content?: string
    directory?: string
    tags?: string[]
    source?: string
    summary?: string
  } = { title: String(input.title).replace(/:/g, '：') }
  if (input.content !== undefined) request.content = input.content
  if (input.directory !== undefined) request.directory = input.directory
  if (Array.isArray(input.tags) && input.tags.length > 0) request.tags = input.tags
  if (input.source !== undefined) request.source = input.source
  if (input.summary !== undefined) request.summary = input.summary
  return request
}
