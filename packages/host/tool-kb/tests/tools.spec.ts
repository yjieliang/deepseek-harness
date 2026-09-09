/**
 * Tests for the model-facing knowledge-base tools: they register through
 * `ctx.tools`, read and write through the REAL `ctx.kb` gateway over an
 * in-memory fs, and apply field-syntax parsing, bulk gates, and clip
 * degradation at the tool layer.
 */

import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { KbGateway } from '../../kb/src/index.ts'
import { MemoryFs } from '../../kb/tests/memory-fs.ts'
import { apply, inject } from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** A seeded markdown document with frontmatter. */
function doc(title: string, updated: string, extra = ''): string {
  return `---\ntitle: ${title}\nupdated: ${updated}\n${extra}---\n\n正文 ${title}\n`
}

/** One mounted tool suite over a fresh in-memory library. */
async function bench(seed: Record<string, string>): Promise<{
  ctx: Context
  root: string
  registry: Map<string, ToolDefinition>
  sections: unknown[]
  run: (name: string, args: unknown) => Promise<unknown>
}> {
  const ctx = new Context()
  await ctx.plugin(MemoryFs)
  const fs = ctx.fs as MemoryFs
  // A fresh absolute library root per suite; the memory fs keys by the path
  // string, so the engine's `/`-joined library paths must match exactly.
  const root = join(tmpdir(), `dsh-kb-tool-${Math.random().toString(36).slice(2)}`)
  for (const [path, text] of Object.entries(seed)) fs.seed(`${root}/${path}`, text)
  // Retention 0 disables the trash sweep timer so the test process stays clean.
  await ctx.plugin(KbGateway, { root, trashRetentionDays: 0 })

  const registry = new Map<string, ToolDefinition>()
  const sections: unknown[] = []
  ctx.provide('tools', {
    register: (def: ToolDefinition): (() => void) => {
      registry.set(def.name, def)
      return () => { registry.delete(def.name) }
    },
  } as unknown as ToolRuntime)
  ctx.provide('systemPrompt', {
    section: (spec: unknown): (() => void) => {
      sections.push(spec)
      return () => {}
    },
  } as never)

  const resolved: Config = {
    searchTopK: 10,
    batchConfirmN: 5,
    archiveDays: 90,
    clipMaxBodyChars: 20000,
  }
  await ctx.plugin({ name: 'tool-kb', inject, apply }, resolved)

  const exec = (): ToolRunContext => ({ signal: new AbortController().signal }) as ToolRunContext
  const run = async (name: string, args: unknown): Promise<unknown> => {
    const def = registry.get(name)
    if (def === undefined) throw new Error(`tool not registered: ${name}`)
    return await def.execute(args, exec())
  }
  return { ctx, root, registry, sections, run }
}

describe('tool-kb registration', () => {
  it('registers the 16 tools and the prompt section', async () => {
    const { registry, sections } = await bench({})
    expect([...registry.keys()].sort()).toEqual([
      'kb_add', 'kb_archive', 'kb_clip', 'kb_delete', 'kb_export', 'kb_get', 'kb_images',
      'kb_import', 'kb_links', 'kb_move', 'kb_organize', 'kb_rename', 'kb_search', 'kb_stats',
      'kb_tags', 'kb_update',
    ])
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ name: 'knowledge-base', order: 100 })
  })
})

describe('kb_search', () => {
  it('applies tag:/path:/status:/title: prefixes parsed from the query', async () => {
    const { run } = await bench({
      '00-inbox/2026-08-10-inbox.md': doc('收集箱条目', '2026-08-10', 'tags: [测试]\n'),
      '10-技术/2026-08-12-filed.md': doc('技术条目', '2026-08-12', 'tags: [测试]\n'),
      '10-技术/11-AI/2026-08-13-ai.md': doc('AI 笔记', '2026-08-13', 'tags: [AI]\n'),
    })
    const byTag = await run('kb_search', { query: 'tag:测试 条目' }) as { hits: { path: string }[] }
    expect(byTag.hits.map(hit => hit.path).sort()).toEqual([
      '00-inbox/2026-08-10-inbox.md', '10-技术/2026-08-12-filed.md',
    ])
    const byStatus = await run('kb_search', { query: 'status:inbox 条目' }) as { hits: { path: string }[] }
    expect(byStatus.hits.map(hit => hit.path)).toEqual(['00-inbox/2026-08-10-inbox.md'])
    const byPath = await run('kb_search', { query: 'path:10-技术/11-AI 正文' }) as { hits: { path: string }[] }
    expect(byPath.hits.map(hit => hit.path)).toEqual(['10-技术/11-AI/2026-08-13-ai.md'])
    const byTitle = await run('kb_search', { query: 'title:AI 正文' }) as { hits: { path: string }[] }
    expect(byTitle.hits.map(hit => hit.path)).toEqual(['10-技术/11-AI/2026-08-13-ai.md'])
  })
})

describe('kb_add / kb_get / kb_update', () => {
  it('creates a document and reads it back', async () => {
    const { run } = await bench({})
    const created = await run('kb_add', {
      title: '新文档', content: '这是正文', directory: '10-技术', tags: ['AI'],
    }) as { path: string }
    expect(created.path).toMatch(/^10-技术\/\d{4}-\d{2}-\d{2}-新文档\.md$/)
    const read = await run('kb_get', { path: created.path }) as { meta: { title: string }; content: string }
    expect(read.meta.title).toBe('新文档')
    expect(read.content).toContain('这是正文')
  })

  it('reports a stale expectVersion as a conflict', async () => {
    const { ctx, root, run } = await bench({
      '10-技术/2026-08-12-a.md': doc('甲', '2026-08-12'),
    })
    const read = await run('kb_get', { path: '10-技术/2026-08-12-a.md' }) as { version?: string }
    const fs = ctx.fs as MemoryFs
    fs.entries.get(`${root}/10-技术/2026-08-12-a.md`)!.version++
    await expect(run('kb_update', {
      path: '10-技术/2026-08-12-a.md', content: '覆盖', expectVersion: read.version,
    })).rejects.toThrow(/版本冲突/)
  })
})

describe('kb_rename', () => {
  it('renames a document within the same directory and updates the title', async () => {
    const { run } = await bench({
      '10-技术/2026-08-12-旧文档.md': doc('旧文档', '2026-08-12', 'tags: [AI]\nsummary: 旧文档摘要\n'),
    })
    const result = await run('kb_rename', { path: '10-技术/2026-08-12-旧文档.md', name: '新文档' }) as { from: string; to: string }
    expect(result.from).toBe('10-技术/2026-08-12-旧文档.md')
    expect(result.to).toBe('10-技术/新文档.md')
    // The old file should be blanked.
    const oldContent = await run('kb_get', { path: '10-技术/2026-08-12-旧文档.md' })
    expect((oldContent as { content: string }).content).toBe('')
    // The new file should have the updated title and preserved metadata.
    const read = await run('kb_get', { path: '10-技术/新文档.md' }) as { meta: Record<string, unknown>; content: string }
    expect(read.meta.title).toBe('新文档')
    expect(read.meta.tags).toEqual(['AI'])
    expect(read.meta.summary).toBe('旧文档摘要')
    expect(read.content).toContain('正文 旧文档')
  })

  it('refuses missing path', async () => {
    const { run } = await bench({})
    await expect(run('kb_rename', { path: '不存在.md', name: '新' })).rejects.toThrow()
  })

  it('refuses empty name', async () => {
    const { run } = await bench({
      '00-inbox/2026-08-12-a.md': doc('甲', '2026-08-12'),
    })
    await expect(run('kb_rename', { path: '00-inbox/2026-08-12-a.md', name: '  ' })).rejects.toThrow()
  })
})

describe('kb_links', () => {
  it('reports outlinks and backlinks through the shared engine', async () => {
    const { run } = await bench({
      '10-技术/2026-08-12-a.md': doc('甲', '2026-08-12', '') + '见 [[乙]]',
      '10-技术/2026-08-13-b.md': doc('乙', '2026-08-13', '') + '回链 [[甲]]',
    })
    const view = await run('kb_links', { path: '10-技术/2026-08-12-a.md' }) as { outLinks: string[]; backlinks: string[] }
    expect(view.outLinks).toEqual(['乙'])
    expect(view.backlinks).toEqual(['10-技术/2026-08-13-b.md'])
  })
})

describe('kb_archive', () => {
  it('previews by default and refuses bulk execution past the confirm threshold', async () => {
    const { run } = await bench({
      '00-inbox/2026-08-01-a.md': doc('甲', '2026-08-01'),
      '00-inbox/2026-08-02-b.md': doc('乙', '2026-08-02'),
      '00-inbox/2026-08-03-c.md': doc('丙', '2026-08-03'),
      '00-inbox/2026-08-04-d.md': doc('丁', '2026-08-04'),
      '00-inbox/2026-08-05-e.md': doc('戊', '2026-08-05'),
      '00-inbox/2026-08-06-f.md': doc('己', '2026-08-06'),
    })
    const preview = await run('kb_archive', { days: 7 }) as { dryRun: boolean; count: number }
    expect(preview.dryRun).toBe(true)
    expect(preview.count).toBe(6)
    await expect(run('kb_archive', { days: 7, dryRun: false })).rejects.toThrow(/确认阈值/)
  })
})

describe('kb_import', () => {
  it('refuses a batch past the confirm threshold', async () => {
    const { run } = await bench({})
    const files = [1, 2, 3, 4, 5, 6].map(n => ({ title: `文档${n}` }))
    await expect(run('kb_import', { files })).rejects.toThrow(/确认阈值/)
  })

  it('imports a small batch', async () => {
    const { run } = await bench({})
    const result = await run('kb_import', { files: [{ title: '一' }, { title: '二' }] }) as { count: number; imported: string[] }
    expect(result.count).toBe(2)
    expect(result.imported).toHaveLength(2)
  })
})

describe('kb_clip', () => {
  it('degrades to URL-only when no web service is mounted', async () => {
    const { run } = await bench({})
    const result = await run('kb_clip', { url: 'https://example.com/x', title: '示例' }) as
      { path: string; degraded: boolean; note: string }
    expect(result.degraded).toBe(true)
    expect(result.note).toContain('web 服务不可用')
    const read = await run('kb_get', { path: result.path }) as { content: string }
    expect(read.content).toContain('https://example.com/x')
  })
})

describe('kb_tags / kb_stats / kb_images', () => {
  it('reports tags, stats, and rebuilds the image registry', async () => {
    const { run } = await bench({
      '10-技术/2026-08-12-a.md': doc('甲', '2026-08-12', 'tags: [AI]\n') + '正文 ![[diagram.png]]',
      '10-技术/diagram.png': 'png-bytes',
      '10-技术/orphan.png': 'png-bytes',
    })
    const tags = await run('kb_tags', {}) as { tags: { tag: string; count: number }[] }
    expect(tags.tags).toEqual([{ tag: 'AI', count: 1 }])
    const stats = await run('kb_stats', {}) as { total: number; archiveDir: string }
    expect(stats.total).toBe(1)
    expect(stats.archiveDir).toBe('90-归档')
    const images = await run('kb_images', {}) as { total: number; orphans: { path: string }[] }
    expect(images.total).toBe(2)
    expect(images.orphans).toEqual([{ path: '10-技术/orphan.png', name: 'orphan.png' }])
  })
})
