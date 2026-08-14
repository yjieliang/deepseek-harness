/**
 * Knowledge-base engine: the in-memory markdown index over the `kb/` workspace
 * root and every read/write operation the browser panel and the image route
 * need. Owns the 2-gram inverted index, frontmatter parsing, optimistic-lock
 * writes, and the `.trash` recycle path.
 *
 * The engine is lazy: the first operation scans the library and rebuilds
 * `kb/_meta/index.json`; later operations serve from memory and rewrite the
 * index after every mutation. Paths are library-relative and sandbox-checked
 * through {@link FileSystem.contains}.
 * @module @deepseek-ai/dsh-host-kb/core
 */

import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type {
  KbCreateDirRequest, KbCreateDirResult, KbCreateRequest, KbCreateResult, KbDeleteRequest,
  KbDeleteResult, KbDocStatus, KbDocSummary, KbGetRequest, KbGetResult, KbListRequest,
  KbMoveRequest, KbMoveResult, KbPurgeRequest, KbPurgeResult, KbRenameDirRequest,
  KbRenameDirResult, KbResolveRequest, KbResolveResult, KbRestoreRequest, KbRestoreResult,
  KbSaveRequest, KbSaveResult, KbSearchResult, KbStatusFilter, KbTrashEntry, KbTrashResult,
} from './types.ts'

/** One parsed document: frontmatter plus body. */
export interface KbDoc {
  /** Flat frontmatter: scalar values, or inline `[a, b]` arrays. */
  readonly meta: Record<string, string | string[]>
  /** Markdown body without the frontmatter block. */
  readonly body: string
}

/** Directory layout the engine guarantees, plus the metadata dirs it maintains. */
export const KB_BASE_DIRS = [
  '00-inbox', '01-inbox', '10-技术', '20-学习笔记', '30-工作文档', '40-生活通用', 'templates', '_meta',
] as const

/** Library directories whose documents count as inbox. */
export const INBOX_DIRS = new Set(['00-inbox', '01-inbox'])

/** Directories a create/rename request may neither name nor touch. */
export const RESERVED_DIRS = new Set(['00-inbox', '01-inbox', '_meta', 'templates', '.trash'])

/** Default archive directory; the engine's `archiveDir` configuration replaces it. */
export const DEFAULT_ARCHIVE_DIR = '90-归档'

/** Directories excluded from the document index and image scan. */
const EXCLUDE_DIRS = new Set(['_meta', 'templates', '.trash'])

/** Extension → Content-Type for the image route. */
export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
}

/**
 * Derive the library status of a document from its path.
 * @param rel - library-relative document path.
 * @param archiveDir - the configured archive directory (default `90-归档`).
 * @returns inbox for the inbox roots, archived for the archive directory, filed otherwise.
 */
export function statusOf(rel: string, archiveDir = DEFAULT_ARCHIVE_DIR): KbDocStatus {
  for (const inbox of INBOX_DIRS) {
    if (rel.startsWith(inbox + '/')) return 'inbox'
  }
  if (rel.startsWith(archiveDir + '/')) return 'archived'
  return 'filed'
}

/**
 * Split leading `---` frontmatter from the body; a malformed block yields empty meta.
 * @param text - the raw markdown file text
 * @returns frontmatter and body
 */
export function parseFrontmatter(text: string): KbDoc {
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: text }
  const meta: Record<string, string | string[]> = {}
  for (const line of text.slice(3, end).split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value: string | string[] = line.slice(idx + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    }
    meta[key] = value
  }
  return { meta, body: text.slice(end + 4) }
}

/**
 * `[[title]]` link targets in one body, in document order.
 * @param body - the markdown body
 * @returns link targets in document order
 */
export function extractLinks(body: string): string[] {
  const out: string[] = []
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) {
    const target = match[1]
    if (target !== undefined) out.push(target.trim())
  }
  return out
}

/**
 * The knowledge-base engine. One instance per host process; all reads and
 * writes go through the sandboxed `fs` service under the `kb/` workspace root.
 */
export class KbEngine {
  private ready = false
  private initPromise: Promise<void> | null = null
  private readonly docs = new Map<string, KbDoc>()
  private readonly inverted = new Map<string, Set<string>>()
  /** Configured archive directory; documents beneath it derive status `archived`. */
  private readonly archiveDir: string

  constructor(
    private readonly fs: FileSystem,
    private readonly workspaceRoot: string | undefined,
    archiveDir = DEFAULT_ARCHIVE_DIR,
  ) {
    this.archiveDir = stripSlashes(archiveDir)
  }

  /** Resolve one library-relative path to a sandbox-checked target. */
  private async target(rel: string, signal?: AbortSignal): Promise<FsTarget> {
    await this.ensureInit(signal)
    const root = await this.locate('', signal)
    const target = await this.locate(rel, signal)
    if (!this.fs.contains(root, target)) throw new Error(`kb: 路径越界: ${rel}`)
    return target
  }

  /** Resolve a library-relative path under `kb/`, absolute against the workspace root. */
  private async locate(rel: string, signal?: AbortSignal): Promise<FsTarget> {
    const opts: { cwd: string } | { signal: AbortSignal } | { cwd: string; signal: AbortSignal } | undefined
      = this.workspaceRoot === undefined
        ? (signal === undefined ? undefined : { signal })
        : (signal === undefined ? { cwd: this.workspaceRoot } : { cwd: this.workspaceRoot, signal })
    return await this.fs.resolve(rel === '' ? 'kb' : 'kb/' + rel, opts)
  }

  /**
 * Ensure the library directories exist and the index is loaded, once.
 * @param signal - abort signal for cooperative cancellation
 */
  async ensureInit(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.ready) return
    if (this.initPromise !== null) return this.initPromise
    this.initPromise = (async () => {
      for (const dir of [...KB_BASE_DIRS, this.archiveDir]) await this.ensureDir(dir, signal)
      await this.scan('', signal, (rel, doc) => {
        this.docs.set(rel, doc)
        this.indexDoc(rel, doc)
      })
      await this.writeIndex(signal)
      this.ready = true
    })()
    return this.initPromise
  }

  /** Create one library directory through a `.keep` marker when absent. */
  private async ensureDir(relDir: string, signal?: AbortSignal): Promise<void> {
    const dir = await this.locate(relDir, signal)
    if ((await this.fs.stat(dir, signal)) === undefined) {
      const keep = await this.locate(relDir + '/.keep', signal)
      await this.fs.writeText(keep, '')
    }
  }

  /** Recursively index every `*.md` under a directory. */
  private async scan(relDir: string, signal: AbortSignal | undefined, sink: (rel: string, doc: KbDoc) => void): Promise<void> {
    signal?.throwIfAborted()
    const dir = await this.locate(relDir, signal)
    const entries = await this.fs.listDir(dir, signal)
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (entry.type === 'directory') {
        if (EXCLUDE_DIRS.has(entry.name)) continue
        await this.scan(relDir === '' ? entry.name : relDir + '/' + entry.name, signal, sink)
      } else if (entry.type === 'file' && entry.name.endsWith('.md')) {
        const rel = relDir === '' ? entry.name : relDir + '/' + entry.name
        sink(rel, parseFrontmatter(await this.fs.readText(entry.target, signal)))
      }
    }
  }

  /** Rewrite `kb/_meta/index.json` from the in-memory index. */
  private async writeIndex(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const index: Record<string, unknown> = { schemaVersion: 3, savedAt: new Date().toISOString(), docs: {} }
    const docs: Record<string, unknown> = {}
    for (const [rel, doc] of this.docs) {
      docs[rel] = {
        title: titleOf(rel, doc),
        tags: arrayOf(doc.meta.tags),
        aliases: arrayOf(doc.meta.aliases),
        summary: scalar(doc.meta.summary),
        source: scalar(doc.meta.source),
        created: scalar(doc.meta.created),
        updated: scalar(doc.meta.updated),
        pinned: isPinned(doc),
        status: statusOf(rel, this.archiveDir),
        links: extractLinks(doc.body),
      }
    }
    index.docs = docs
    await this.fs.writeText(await this.locate('_meta/index.json', signal), JSON.stringify(index, null, 2))
  }

  /**
 * List documents with optional filters, pinned first then most recently updated.
 * @param request - the list filters (status/tag/directory)
 * @param signal - abort signal for cooperative cancellation
 * @returns the matching summaries, pinned first
 */
  async list(request: KbListRequest, signal?: AbortSignal): Promise<KbDocSummary[]> {
    await this.ensureInit(signal)
    const out: KbDocSummary[] = []
    for (const [rel, doc] of this.docs) {
      if (!this.matches(rel, doc, request.status, request.tag, request.directory)) continue
      out.push(summaryOf(rel, doc, this.archiveDir))
    }
    return sortDocs(out)
  }

  /**
 * 2-gram AND search over title/aliases/tags/summary/body.
 * @param query - the search terms
 * @param topK - the result cap
 * @param signal - abort signal for cooperative cancellation
 * @returns the top hits and the total match count
 */
  async search(query: string, topK: number, signal?: AbortSignal): Promise<KbSearchResult> {
    await this.ensureInit(signal)
    const q = query.trim()
    if (q.length === 0) return { hits: [], total: 0 }
    const qgrams = [...grams(q)]
    // A one-character query has no 2-grams and matches nothing.
    if (qgrams.length === 0) return { hits: [], total: 0 }
    let candidates: Set<string> | undefined
    for (const gram of qgrams) {
      const set = this.inverted.get(gram)
      if (set === undefined) return { hits: [], total: 0 }
      const next = candidates === undefined
        ? new Set(set)
        : new Set([...candidates].filter(candidate => set.has(candidate)))
      if (next.size === 0) return { hits: [], total: 0 }
      candidates = next
    }
    const hits: KbDocSummary[] = []
    for (const rel of candidates ?? new Set<string>()) {
      const doc = this.docs.get(rel)
      if (doc === undefined) continue
      hits.push(summaryOf(rel, doc, this.archiveDir))
    }
    const sorted = sortDocs(hits)
    return { hits: sorted.slice(0, topK), total: sorted.length }
  }

  /**
 * Full read of one document: body, frontmatter, backlinks, version.
 * @param request - the read request
 * @param signal - abort signal for cooperative cancellation
 * @returns body, frontmatter, backlinks, and version
 */
  async get(request: KbGetRequest, signal?: AbortSignal): Promise<KbGetResult> {
    await this.ensureInit(signal)
    const rel = stripLeadingSlash(request.path)
    const doc = this.docs.get(rel)
    if (doc === undefined) throw new Error(`kb: 文档不存在: ${rel}`)
    const info = await this.fs.stat(await this.target(rel, signal), signal)
    return {
      path: rel,
      content: doc.body,
      meta: { ...doc.meta, status: statusOf(rel, this.archiveDir) },
      backlinks: this.backlinksOf(rel),
      ...info === undefined ? {} : { version: String(info.version) },
    }
  }

  /**
 * Every available directory, sorted.
 * @param signal - abort signal for cooperative cancellation
 * @returns every available directory, sorted
 */
  async dirs(signal?: AbortSignal): Promise<string[]> {
    await this.ensureInit(signal)
    const dirs = new Set<string>(['00-inbox', '01-inbox', '10-技术', '20-学习笔记', '30-工作文档', '40-生活通用', this.archiveDir])
    for (const rel of this.docs.keys()) {
      const idx = rel.indexOf('/')
      if (idx !== -1) dirs.add(rel.slice(0, idx))
    }
    return [...dirs].sort()
  }

  /**
 * Library statistics.
 * @param signal - abort signal for cooperative cancellation
 * @returns totals, per-status counts, directories, and the archive directory
 */
  async stats(signal?: AbortSignal): Promise<{ total: number; byStatus: Record<KbDocStatus, number>; dirs: string[]; archiveDir: string }> {
    await this.ensureInit(signal)
    const byStatus: Record<KbDocStatus, number> = { inbox: 0, filed: 0, archived: 0 }
    for (const rel of this.docs.keys()) byStatus[statusOf(rel, this.archiveDir)]++
    return { total: this.docs.size, byStatus, dirs: await this.dirs(signal), archiveDir: this.archiveDir }
  }

  /**
 * Tag index, most-used first.
 * @param signal - abort signal for cooperative cancellation
 * @returns tag counts, most-used first
 */
  async tags(signal?: AbortSignal): Promise<{ tag: string; count: number }[]> {
    await this.ensureInit(signal)
    const counts = new Map<string, number>()
    for (const doc of this.docs.values()) {
      for (const tag of arrayOf(doc.meta.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
  }

  /**
 * Apply a field patch + body replacement with an optional optimistic lock.
 * @param request - the field patch and optional expectVersion
 * @param signal - abort signal for cooperative cancellation
 * @returns the write outcome
 */
  async save(request: KbSaveRequest, signal?: AbortSignal): Promise<KbSaveResult> {
    await this.ensureInit(signal)
    const rel = stripLeadingSlash(request.path)
    const doc = this.docs.get(rel)
    if (doc === undefined) throw new Error(`kb: 文档不存在: ${rel}`)
    const target = await this.target(rel, signal)
    const info = await this.fs.stat(target, signal)
    const meta: Record<string, string | string[]> = { ...doc.meta }
    if (request.summary !== undefined) meta.summary = request.summary
    if (request.tags !== undefined) meta.tags = request.tags
    if (request.pinned !== undefined) {
      if (request.pinned) meta.pinned = 'true'
      else delete meta.pinned
    }
    meta.updated = today()
    const text = renderDoc(meta, request.content === undefined ? doc.body : request.content)
    let outcome
    if (request.expectVersion !== undefined && info !== undefined) {
      outcome = await this.fs.writeText(target, text, { kind: 'replaceIfVersion', version: info.version }, signal)
    } else {
      outcome = await this.fs.writeText(target, text, undefined, signal)
    }
    this.replaceIndexed(rel, parseFrontmatter(text))
    await this.writeIndex(signal)
    return { path: rel, version: outcome.version, conflict: false }
  }

  /**
 * Create a dated document, minting a collision-free path.
 * @param request - title, directory, and optional initial fields
 * @param signal - abort signal for cooperative cancellation
 * @returns the minted path and version
 */
  async create(request: KbCreateRequest, signal?: AbortSignal): Promise<KbCreateResult> {
    await this.ensureInit(signal)
    const dir = stripSlashes(request.directory ?? '00-inbox')
    const stem = today() + '-' + sanitizeName(request.title)
    let rel = `${dir}/${stem}.md`
    for (let seq = 2; this.docs.has(rel); seq++) rel = `${dir}/${stem}-${seq}.md`
    const meta: Record<string, string | string[]> = { title: request.title.replace(/:/g, '：') }
    if (request.tags !== undefined && request.tags.length > 0) meta.tags = request.tags
    if (request.source !== undefined && request.source.length > 0) meta.source = request.source
    if (request.summary !== undefined && request.summary.length > 0) meta.summary = request.summary
    if (request.pinned === true) meta.pinned = 'true'
    meta.created = today()
    meta.updated = today()
    const text = renderDoc(meta, request.content === undefined ? '' : request.content)
    const target = await this.target(rel, signal)
    const outcome = await this.fs.writeText(target, text, undefined, signal)
    this.replaceIndexed(rel, parseFrontmatter(text))
    await this.writeIndex(signal)
    return { path: rel, version: outcome.version }
  }

  /**
 * Move a document into another directory, renaming on collision.
 * @param request - source path and target directory
 * @param signal - abort signal for cooperative cancellation
 * @returns source and destination paths
 */
  async move(request: KbMoveRequest, signal?: AbortSignal): Promise<KbMoveResult> {
    await this.ensureInit(signal)
    const rel = stripLeadingSlash(request.path)
    const doc = this.docs.get(rel)
    if (doc === undefined) throw new Error(`kb: 文档不存在: ${rel}`)
    const dir = stripSlashes(request.targetDirectory)
    const base = rel.split('/').pop() ?? ''
    let to = `${dir}/${base}`
    for (let seq = 2; this.docs.has(to); seq++) {
      to = `${dir}/${base.replace(/\.md$/, '')}-${seq}.md`
    }
    const from = await this.target(rel, signal)
    const destination = await this.target(to, signal)
    const text = await this.fs.readText(from, signal)
    await this.fs.writeText(destination, text, undefined, signal)
    await this.fs.writeText(from, ' ', undefined, signal)
    this.dropIndexed(rel)
    this.docs.delete(rel)
    const next = parseFrontmatter(await this.fs.readText(destination, signal))
    this.docs.set(to, next)
    this.indexDoc(to, next)
    await this.writeIndex(signal)
    return { from: rel, to }
  }

  /**
 * Create a library directory through a `.keep` marker; reserved roots are refused.
 * @param request - the library-relative directory path
 * @param signal - abort signal for cooperative cancellation
 * @returns the created directory
 */
  async createDir(request: KbCreateDirRequest, signal?: AbortSignal): Promise<KbCreateDirResult> {
    await this.ensureInit(signal)
    const dir = stripSlashes(request.directory)
    if (dir.length === 0 || dir.includes('..') || dir.split('/').some(segment => segment.length === 0)) {
      throw new Error(`kb: 目录名无效: ${request.directory}`)
    }
    const root = dir.split('/')[0] ?? ''
    if (RESERVED_DIRS.has(root)) throw new Error(`kb: 保留目录不可新建: ${root}`)
    const keep = await this.locate(dir + '/.keep', signal)
    const exists = (await this.fs.stat(keep, signal)) !== undefined
      || [...this.docs.keys()].some(rel => rel.startsWith(dir + '/'))
    if (exists) throw new Error(`kb: 目录已存在: ${dir}`)
    await this.fs.writeText(keep, '')
    return { directory: dir }
  }

  /**
   * Rename a library directory, relocating every entry beneath it. Reserved
   * roots and the archive directory are refused; a binary entry fails the call
   * because the text-only fs seam cannot move bytes.
   * @param request - the directory and its replacement name
   * @param signal - abort signal for cooperative cancellation
   * @returns source, destination, and moved entry count
   */
  async renameDir(request: KbRenameDirRequest, signal?: AbortSignal): Promise<KbRenameDirResult> {
    await this.ensureInit(signal)
    const dir = stripSlashes(request.directory)
    const name = stripSlashes(request.name)
    if (name.length === 0 || name.includes('/')) throw new Error(`kb: 目录名无效: ${request.name}`)
    if (RESERVED_DIRS.has(dir) || dir === this.archiveDir) {
      throw new Error(`kb: 保留目录不可重命名: ${dir}`)
    }
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
    const to = parent === '' ? name : `${parent}/${name}`
    if (to === dir) return { from: dir, to, moved: 0 }
    if (RESERVED_DIRS.has(to)) throw new Error(`kb: 保留目录不可作为新名称: ${to}`)
    const keep = await this.locate(dir + '/.keep', signal)
    const exists = (await this.fs.stat(keep, signal)) !== undefined
      || [...this.docs.keys()].some(rel => rel.startsWith(dir + '/'))
    if (!exists) throw new Error(`kb: 目录不存在: ${dir}`)
    const toKeep = await this.locate(to + '/.keep', signal)
    const taken = (await this.fs.stat(toKeep, signal)) !== undefined
      || [...this.docs.keys()].some(rel => rel.startsWith(to + '/'))
    if (taken) throw new Error(`kb: 目标目录已存在: ${to}`)
    // Create the destination directory first, so relocation never writes into
    // a path whose parents do not exist yet.
    await this.fs.writeText(toKeep, '')
    const moved = await this.relocateDir(dir, to, signal)
    await this.fs.writeText(await this.locate(dir + '/.keep', signal), ' ')
    await this.writeIndex(signal)
    return { from: dir, to, moved }
  }

  /** Recursively relocate every entry under a directory prefix, updating the document index. */
  private async relocateDir(fromRel: string, toRel: string, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted()
    const dir = await this.locate(fromRel, signal)
    const entries = await this.fs.listDir(dir, signal)
    let moved = 0
    for (const entry of entries) {
      signal?.throwIfAborted()
      const fromPath = fromRel + '/' + entry.name
      const toPath = toRel + '/' + entry.name
      if (entry.type === 'directory') {
        moved += await this.relocateDir(fromPath, toPath, signal)
        continue
      }
      const text = await this.fs.readText(entry.target, signal)
      await this.fs.writeText(await this.locate(toPath, signal), text, undefined, signal)
      await this.fs.writeText(entry.target, ' ', undefined, signal)
      if (entry.name.endsWith('.md') && this.docs.has(fromPath)) {
        this.dropIndexed(fromPath)
        this.docs.delete(fromPath)
        const next = parseFrontmatter(text)
        this.docs.set(toPath, next)
        this.indexDoc(toPath, next)
      }
      moved++
    }
    return moved
  }

  /**
 * Move a document into `.trash` (recoverable), blanking the original.
 * @param request - the delete request
 * @param signal - abort signal for cooperative cancellation
 * @returns the deleted and trash paths
 */
  async remove(request: KbDeleteRequest, signal?: AbortSignal): Promise<KbDeleteResult> {
    await this.ensureInit(signal)
    const rel = stripLeadingSlash(request.path)
    const doc = this.docs.get(rel)
    if (doc === undefined) throw new Error(`kb: 文档不存在: ${rel}`)
    const trashRel = '.trash/' + (rel.split('/').pop() ?? '')
    const from = await this.target(rel, signal)
    const trash = await this.target(trashRel, signal)
    await this.fs.writeText(trash, await this.fs.readText(from, signal), undefined, signal)
    await this.fs.writeText(from, ' ', undefined, signal)
    this.dropIndexed(rel)
    this.docs.delete(rel)
    await this.writeIndex(signal)
    return { path: rel, trash: trashRel }
  }

  /**
 * List the recoverable trash.
 * @param signal - abort signal for cooperative cancellation
 * @returns the trashed documents
 */
  async trash(signal?: AbortSignal): Promise<KbTrashResult> {
    await this.ensureInit(signal)
    const dir = await this.locate('.trash', signal)
    if ((await this.fs.stat(dir, signal)) === undefined) return { docs: [] }
    const entries = await this.fs.listDir(dir, signal)
    const docs: KbTrashEntry[] = []
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.name.endsWith('.md')) continue
      const doc = parseFrontmatter(await this.fs.readText(entry.target, signal))
      docs.push({
        path: '.trash/' + entry.name,
        name: entry.name,
        title: scalar(doc.meta.title) || entry.name.replace(/\.md$/, ''),
        body: doc.body,
      })
    }
    return { docs }
  }

  /**
 * Restore a trashed document into a library directory, renaming on collision.
 * @param request - the trash path and optional target directory
 * @param signal - abort signal for cooperative cancellation
 * @returns source and destination paths
 */
  async restore(request: KbRestoreRequest, signal?: AbortSignal): Promise<KbRestoreResult> {
    await this.ensureInit(signal)
    const trashRel = stripLeadingSlash(request.path)
    if (!trashRel.startsWith('.trash/')) throw new Error('kb: 只能从回收站恢复')
    const name = (trashRel.split('/').pop() ?? '').replace(/\.md$/, '')
    const dir = stripSlashes(request.targetDirectory ?? '00-inbox')
    let to = `${dir}/${name}.md`
    for (let seq = 2; this.docs.has(to); seq++) to = `${dir}/${name}-${seq}.md`
    const from = await this.target(trashRel, signal)
    const text = await this.fs.readText(from, signal)
    const destination = await this.target(to, signal)
    await this.fs.writeText(destination, text, undefined, signal)
    await this.fs.writeText(from, ' ', undefined, signal)
    const next = parseFrontmatter(text)
    this.docs.set(to, next)
    this.indexDoc(to, next)
    await this.writeIndex(signal)
    return { from: trashRel, to }
  }

  /**
 * Permanently clear one trashed document.
 * @param request - the trash path
 * @param signal - abort signal for cooperative cancellation
 * @returns the purged path
 */
  async purge(request: KbPurgeRequest, signal?: AbortSignal): Promise<KbPurgeResult> {
    await this.ensureInit(signal)
    const trashRel = stripLeadingSlash(request.path)
    if (!trashRel.startsWith('.trash/')) throw new Error('kb: 只能清除回收站文档')
    await this.fs.writeText(await this.target(trashRel, signal), ' ', undefined, signal)
    return { path: trashRel, purged: true }
  }

  /**
 * Resolve a `[[name]]` target: exact title/stem, image registry, then fuzzy.
 * @param request - the link name
 * @param signal - abort signal for cooperative cancellation
 * @returns the resolved target
 */
  async resolve(request: KbResolveRequest, signal?: AbortSignal): Promise<KbResolveResult> {
    await this.ensureInit(signal)
    const name = request.name.trim().replace(/\.md$/, '')
    for (const [rel, doc] of this.docs) {
      if (scalar(doc.meta.title).trim() === name || rel.replace(/\.md$/, '') === name || rel === name) {
        return { path: rel, kind: 'doc' }
      }
    }
    const imageIndex = await this.locate('_meta/images.json', signal)
    const imageInfo = await this.fs.stat(imageIndex, signal)
    if (imageInfo !== undefined) {
      try {
        const parsed = JSON.parse(await this.fs.readText(imageIndex, signal)) as { images?: { name?: string; path?: string }[] }
        const hit = (parsed.images ?? []).find(image => image.name === name || image.name === name + '.png')
        if (hit !== undefined && typeof hit.path === 'string') return { path: hit.path, kind: 'image' }
      } catch {
        // A malformed image registry is not a link-resolution failure; fall through to fuzzy.
      }
    }
    const fuzzy = [...this.docs.entries()].find(([rel, doc]) =>
      scalar(doc.meta.title).includes(name) || rel.includes(name))
    if (fuzzy !== undefined) return { path: fuzzy[0], kind: 'doc' }
    return { path: null, kind: 'missing' }
  }

  /**
 * Serve one image's raw bytes with its MIME type; throws when absent or oversized.
 * @param rel - the library-relative image path
 * @param signal - abort signal for cooperative cancellation
 * @returns the bytes and MIME type
 */
  async image(rel: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }> {
    await this.ensureInit(signal)
    const target = await this.target(rel, signal)
    const info = await this.fs.stat(target, signal)
    if (info === undefined || info.type !== 'file') throw new Error(`kb: 图片不存在: ${rel}`)
    const ext = (rel.split('.').pop() ?? '').toLowerCase()
    const mime = IMAGE_MIME[ext] ?? 'application/octet-stream'
    const bytes = await this.fs.readBytes(target, signal, 20 * 1024 * 1024)
    return { bytes, mime }
  }

  /** Whether one document matches the list filters. */
  private matches(
    rel: string,
    doc: KbDoc,
    status: KbStatusFilter | undefined,
    tag: string | undefined,
    directory: string | undefined,
  ): boolean {
    if (status !== undefined && status !== 'all' && status !== statusOf(rel, this.archiveDir)) return false
    if (tag !== undefined && !arrayOf(doc.meta.tags).includes(tag)) return false
    if (directory !== undefined && !rel.startsWith(directory + '/')) return false
    return true
  }

  /** Documents linking to `rel` by title, stem, or exact path. */
  private backlinksOf(rel: string): string[] {
    const out: string[] = []
    for (const [other, doc] of this.docs) {
      if (other === rel) continue
      if (extractLinks(doc.body).some(link => link === rel || link === rel.replace(/\.md$/, ''))) out.push(other)
    }
    return out
  }

  /** Replace one document in the index and re-invert its grams. */
  private replaceIndexed(rel: string, doc: KbDoc): void {
    this.dropIndexed(rel)
    this.docs.set(rel, doc)
    this.indexDoc(rel, doc)
  }

  /** Remove one document from the index and its inverted grams. */
  private dropIndexed(rel: string): void {
    const doc = this.docs.get(rel)
    if (doc === undefined) return
    for (const gram of grams(haystackOf(doc))) {
      const set = this.inverted.get(gram)
      if (set !== undefined) set.delete(rel)
    }
  }

  /** Add one document's grams to the inverted index. */
  private indexDoc(rel: string, doc: KbDoc): void {
    for (const gram of grams(haystackOf(doc))) {
      let set = this.inverted.get(gram)
      if (set === undefined) {
        set = new Set()
        this.inverted.set(gram, set)
      }
      set.add(rel)
    }
  }
}

/** The searchable haystack of one document. */
function haystackOf(doc: KbDoc): string {
  return [
    scalar(doc.meta.title), arrayOf(doc.meta.aliases).join(' '), arrayOf(doc.meta.tags).join(' '),
    scalar(doc.meta.summary), doc.body,
  ].join(' ')
}

/** All 2-grams of a lowercase, whitespace-collapsed string. */
function grams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/\s+/g, ' ')
  const out = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2))
  return out
}

/** A string frontmatter value, or ''. */
function scalar(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : ''
}

/** A string-array frontmatter value, or []. */
function arrayOf(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : []
}

/** Document title: frontmatter, else the file stem. */
function titleOf(rel: string, doc: KbDoc): string {
  return scalar(doc.meta.title) || (rel.split('/').pop() ?? '').replace(/\.md$/, '')
}

/** One summary row for the list/search surfaces. */
function summaryOf(rel: string, doc: KbDoc, archiveDir: string): KbDocSummary {
  return {
    path: rel,
    title: titleOf(rel, doc),
    summary: scalar(doc.meta.summary),
    tags: arrayOf(doc.meta.tags),
    status: statusOf(rel, archiveDir),
    updated: scalar(doc.meta.updated),
    pinned: isPinned(doc),
  }
}

/** Whether a document's frontmatter marks it pinned. */
function isPinned(doc: KbDoc): boolean {
  return scalar(doc.meta.pinned) === 'true'
}

/** Pinned documents first, then most recently updated; stable for equal dates. */
function sortDocs(docs: KbDocSummary[]): KbDocSummary[] {
  return docs.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated.localeCompare(a.updated))
}

/** Render a document from frontmatter + body. */
function renderDoc(meta: Record<string, string | string[]>, body: string): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) lines.push(`${key}: [${value.join(', ')}]`)
    else if (value !== '') lines.push(`${key}: ${value}`)
  }
  lines.push('---')
  const trimmed = body.trim()
  return lines.join('\n') + (trimmed.length > 0 ? '\n\n' + trimmed + '\n' : '\n')
}

/** Strip a leading `/` so `resolveLink`-style inputs stay library-relative. */
function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, '')
}

/** Strip surrounding slashes from a directory name. */
function stripSlashes(dir: string): string {
  return dir.replace(/^\/+|\/+$/g, '')
}

/** Today's ISO date (YYYY-MM-DD, UTC). */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** A file-safe name derived from the title. */
function sanitizeName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '').trim() || 'untitled'
}
