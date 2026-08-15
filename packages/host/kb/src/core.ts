/**
 * Knowledge-base engine: the in-memory markdown index over the `kb/` workspace
 * root and every read/write operation the browser panel and the image route
 * need. Owns the 2-gram inverted index, frontmatter parsing, optimistic-lock
 * writes, and the `.trash` recycle path with time-based retention sweep.
 *
 * The engine is lazy: the first operation scans the library and rebuilds
 * `kb/_meta/index.json`; later operations serve from memory and rewrite the
 * index after every mutation. Paths are library-relative and sandbox-checked
 * through {@link FileSystem.contains}.
 * @module @deepseek-ai/dsh-host-kb/core
 */

import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type {
  KbCreateDirRequest, KbCreateDirResult, KbCreateRequest, KbCreateResult, KbDeleteRequest,
  KbDeleteResult, KbDocStatus, KbDocSummary, KbGetRequest, KbGetResult, KbImagesResult,
  KbLinksResult, KbListRequest, KbMoveRequest, KbMoveResult, KbPurgeRequest, KbPurgeResult,
  KbRenameDirRequest, KbRenameDirResult, KbResolveRequest, KbResolveResult, KbRestoreRequest,
  KbRestoreResult, KbSaveRequest, KbSaveResult, KbSearchFilters, KbSearchResult,
  KbStatusFilter, KbTrashEntry, KbTrashResult,
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

/** Default retention window for trashed documents, in days; `0` disables the sweep. */
export const DEFAULT_TRASH_RETENTION_DAYS = 30

/** Sidecar registry of deletion timestamps, keyed by trash-relative path. */
const TRASH_REGISTRY = '_meta/trash.json'

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

/** File extensions the image scan recognizes, lowercased with the dot. */
const IMAGE_EXT = Object.keys(IMAGE_MIME).map(ext => '.' + ext)

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

/** Resolve one image reference against a document directory to a library path, or null for a remote URL. */
function resolveImageRef(ref: string, docDir: string): string | null {
  const trimmed = ref.trim()
  if (/^https?:\/\//i.test(trimmed)) return null
  const rel = trimmed.replace(/^\/+/, '')
  if (rel.length === 0) return null
  return rel.includes('/') ? rel : (docDir === '' ? rel : docDir + '/' + rel)
}

/**
 * Image references in one body (`![[embed]]` and `![](...)`), resolved to
 * library-relative paths against the document's directory. Remote URLs are
 * skipped; references that start with `/` resolve against the library root.
 * @param body - the markdown body
 * @param docDir - directory of the document, library-relative ('' for root docs)
 * @returns the unique resolved image paths, in first-reference order
 */
export function extractImageRefs(body: string, docDir: string): string[] {
  const out: string[] = []
  const push = (ref: string): void => {
    const resolved = resolveImageRef(ref, docDir)
    if (resolved !== null && !out.includes(resolved)) out.push(resolved)
  }
  for (const match of body.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    const [file = ''] = (match[1] ?? '').split(/[|#]/)
    push(file)
  }
  for (const match of body.matchAll(/!\[([^\]]*)\]\(<([^)>]+)>\)/g)) push(match[2] ?? '')
  for (const match of body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) push(match[2] ?? '')
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
  private readonly inverted = new Map<string, Map<string, number>>()
  private readonly docLen = new Map<string, number>()
  private totalLen = 0
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

  /** Recursively index every `*.md` under a directory; blank files are purged markers and stay out. */
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
        const text = await this.fs.readText(entry.target, signal)
        // The engine blanks purged documents in place; a blank file is absent.
        if (text.trim().length === 0) continue
        sink(rel, parseFrontmatter(text))
      }
    }
  }

  /** Recursively collect every image path under a directory, excluding engine-owned dirs. */
  private async scanImagePaths(
    relDir: string, signal: AbortSignal | undefined, sink: (rel: string) => void,
  ): Promise<void> {
    signal?.throwIfAborted()
    const dir = await this.locate(relDir, signal)
    const entries = await this.fs.listDir(dir, signal)
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (entry.type === 'directory') {
        if (EXCLUDE_DIRS.has(entry.name)) continue
        await this.scanImagePaths(relDir === '' ? entry.name : relDir + '/' + entry.name, signal, sink)
      } else if (entry.type === 'file' && IMAGE_EXT.some(ext => entry.name.toLowerCase().endsWith(ext))) {
        sink(relDir === '' ? entry.name : relDir + '/' + entry.name)
      }
    }
  }

  /**
   * Rebuild the in-memory index from disk, absorbing changes made outside the
   * engine (agent file writes, manual edits). The browser panel calls it when
   * it opens, so externally added or edited documents appear without a restart.
   * @param signal - abort signal for cooperative cancellation
   */
  async refresh(signal?: AbortSignal): Promise<void> {
    await this.ensureInit(signal)
    this.docs.clear()
    this.inverted.clear()
    this.docLen.clear()
    this.totalLen = 0
    await this.scan('', signal, (rel, doc) => {
      this.docs.set(rel, doc)
      this.indexDoc(rel, doc)
    })
    await this.writeIndex(signal)
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
 * 2-gram BM25 search over title/aliases/tags/summary/body.
 *
 * The inverted index is per-document weighted term counts, so hits are scored
 * by field-weighted BM25 instead of strict AND membership: a partial query
 * still returns ranked hits (docs matching more query grams rank first), and
 * a query gram with no exact postings falls back to single-character
 * neighbors, tolerating one-character typos in either language. Optional
 * field filters (status/tag/directory/title) restrict the scored candidates.
 * @param query - the search terms
 * @param topK - the result cap
 * @param filters - optional field filters applied to the scored candidates
 * @param signal - abort signal for cooperative cancellation
 * @returns the top hits and the total match count
 */
  async search(
    query: string, topK: number, filters?: KbSearchFilters, signal?: AbortSignal,
  ): Promise<KbSearchResult> {
    await this.ensureInit(signal)
    const q = query.trim()
    if (q.length === 0) return { hits: [], total: 0 }
    const qgrams = [...grams(q)]
    // A one-character query has no 2-grams and matches nothing.
    if (qgrams.length === 0) return { hits: [], total: 0 }
    const n = this.docs.size
    if (n === 0) return { hits: [], total: 0 }
    const avgLen = this.totalLen / n
    const scores = new Map<string, number>()
    const accumulate = (gram: string, weight: number): void => {
      const posts = this.inverted.get(gram)
      if (posts === undefined) return
      const idf = Math.log((n - posts.size + 0.5) / (posts.size + 0.5) + 1)
      for (const [rel, tf] of posts) {
        const len = this.docLen.get(rel) ?? avgLen
        const norm = len === 0 ? 0 : (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * len / avgLen))
        scores.set(rel, (scores.get(rel) ?? 0) + weight * idf * norm)
      }
    }
    for (const gram of qgrams) accumulate(gram, 1)
    // A query gram without exact postings tolerates one-character typos by
    // scoring its single-character neighbors at a discount.
    for (const gram of qgrams) {
      if (this.inverted.has(gram)) continue
      for (const key of this.inverted.keys()) {
        if (nearGram(key, gram)) accumulate(key, FUZZY_GRAM_WEIGHT)
      }
    }
    if (scores.size === 0) return { hits: [], total: 0 }
    const scored: Array<KbDocSummary & { score: number }> = []
    for (const [rel, score] of scores) {
      const doc = this.docs.get(rel)
      if (doc === undefined) continue
      if (filters !== undefined && !this.matches(rel, doc, filters.status, filters.tag, filters.directory)) continue
      const titleTerm = filters?.title
      if (titleTerm !== undefined && !titleOf(rel, doc).toLowerCase().includes(titleTerm.toLowerCase())) continue
      scored.push({ ...summaryOf(rel, doc, this.archiveDir), score })
    }
    scored.sort((a, b) =>
      b.score - a.score || Number(b.pinned) - Number(a.pinned) || b.updated.localeCompare(a.updated))
    const hits = scored.slice(0, topK).map(({ score: _score, ...rest }) => rest)
    return { hits, total: scored.length }
  }

  /**
 * One document's link view: outlinks and backlinks, for the tool surface.
 * @param path - library-relative document path
 * @param signal - abort signal for cooperative cancellation
 * @returns outlinks, backlinks, and the echoed path
 */
  async links(path: string, signal?: AbortSignal): Promise<KbLinksResult> {
    await this.ensureInit(signal)
    const rel = stripLeadingSlash(path)
    const doc = this.docs.get(rel)
    if (doc === undefined) throw new Error(`kb: 文档不存在: ${rel}`)
    return { path: rel, outLinks: extractLinks(doc.body), backlinks: this.backlinksOf(rel, doc) }
  }

  /**
 * Rebuild the image registry from disk as the unified object format, list
 * orphaned images, and return the scan. The registry maps each image path to
 * `{ name, referenced }`; both `imageTarget` and `resolve` read this shape.
 * @param signal - abort signal for cooperative cancellation
 * @returns totals, every image path, and orphaned images
 */
  async images(signal?: AbortSignal): Promise<KbImagesResult> {
    await this.ensureInit(signal)
    const images: string[] = []
    await this.scanImagePaths('', signal, rel => images.push(rel))
    const referenced = new Set<string>()
    for (const [rel, doc] of this.docs) {
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      for (const ref of extractImageRefs(doc.body, dir)) {
        const target = await this.imageTarget(ref, signal)
        if (target !== null) referenced.add(target)
      }
    }
    const registry: Record<string, { name: string; referenced: boolean }> = {}
    for (const image of images) registry[image] = { name: image.split('/').pop() ?? '', referenced: referenced.has(image) }
    await this.fs.writeText(await this.locate('_meta/images.json', signal), JSON.stringify({
      schemaVersion: 1, savedAt: new Date().toISOString(), images: registry,
    }, null, 2))
    return {
      total: images.length,
      images,
      orphans: images.filter(image => !referenced.has(image)).map(image => ({ path: image, name: image.split('/').pop() ?? '' })),
    }
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
      backlinks: this.backlinksOf(rel, doc),
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
      try {
        // The guard compares against the CLIENT's observed version, so a stale
        // writer is rejected; the fresh stat is not the expected version.
        outcome = await this.fs.writeText(
          target, text, { kind: 'replaceIfVersion', version: FsVersion(request.expectVersion) }, signal,
        )
      } catch (error) {
        // A stale optimistic lock refuses the write; report it as a conflict
        // instead of throwing, and leave the in-memory index untouched.
        if (error instanceof FsError && error.code === 'FS_STALE_VERSION') {
          return { path: rel, conflict: true }
        }
        throw error
      }
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
 * Move a document into `.trash` (recoverable), blanking the original and
 * recording the deletion time for the retention sweep.
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
    await this.recordTrash(trashRel, new Date(), signal)
    await this.writeIndex(signal)
    return { path: rel, trash: trashRel }
  }

  /**
 * List the recoverable trash with their deletion times.
 * @param signal - abort signal for cooperative cancellation
 * @returns the trashed documents
 */
  async trash(signal?: AbortSignal): Promise<KbTrashResult> {
    await this.ensureInit(signal)
    const dir = await this.locate('.trash', signal)
    if ((await this.fs.stat(dir, signal)) === undefined) return { docs: [] }
    const registry = await this.readTrashRegistry(signal)
    const entries = await this.fs.listDir(dir, signal)
    const docs: KbTrashEntry[] = []
    const survivors = new Set<string>()
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.name.endsWith('.md')) continue
      const path = '.trash/' + entry.name
      const text = await this.fs.readText(entry.target, signal)
      // A blank file is a purged entry: skip it and drop it from the registry
      // below, because the fs seam has no delete primitive.
      if (text.trim().length === 0) continue
      survivors.add(path)
      const doc = parseFrontmatter(text)
      const when = registry[path]
      docs.push({
        path,
        name: entry.name,
        title: scalar(doc.meta.title) || entry.name.replace(/\.md$/, ''),
        body: doc.body,
        ...when === undefined ? {} : { deletedAt: when },
      })
    }
    // Entries whose file is blank or gone are stale; rewrite the registry
    // without them so it never grows unbounded.
    if ([...Object.keys(registry)].some(path => !survivors.has(path))) {
      const next: Record<string, string> = {}
      for (const path of survivors) {
        const when = registry[path]
        if (when !== undefined) next[path] = when
      }
      await this.writeTrashRegistry(next, signal)
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
    await this.unregisterTrash(trashRel, signal)
    await this.writeIndex(signal)
    return { from: trashRel, to }
  }

  /**
   * Permanently clear one trashed document. The fs seam has no delete
   * primitive, so files are blanked in place; the trash listing skips blank
   * files, and the bytes stay on disk until a future fs delete lands. Images
   * the purged document referenced are blanked and unregistered too, but only
   * when no other document references them.
   * @param request - the trash path
   * @param signal - abort signal for cooperative cancellation
   * @returns the purged path
   */
  async purge(request: KbPurgeRequest, signal?: AbortSignal): Promise<KbPurgeResult> {
    await this.ensureInit(signal)
    const trashRel = stripLeadingSlash(request.path)
    if (!trashRel.startsWith('.trash/')) throw new Error('kb: 只能清除回收站文档')
    const target = await this.target(trashRel, signal)
    const text = await this.fs.readText(target, signal)
    // The trash copy carries no origin directory, so image references resolve
    // against the library root and fall back to the registry by basename.
    await this.cascadePurgeImages(extractImageRefs(text, ''), signal)
    await this.fs.writeText(target, ' ', undefined, signal)
    await this.unregisterTrash(trashRel, signal)
    return { path: trashRel, purged: true }
  }

  /**
   * Permanently clear every trashed document whose recorded deletion predates
   * the retention window, cascading to images only that document referenced.
   * Entries without a recorded timestamp (deleted before the registry existed)
   * are kept: without an age, expiry cannot be judged.
   * @param now - the sweep time
   * @param retentionDays - retention window in days; `0` or negative disables
   * @param signal - abort signal for cooperative cancellation
   * @returns the number of purged entries
   */
  async sweepTrash(now: Date, retentionDays: number, signal?: AbortSignal): Promise<number> {
    await this.ensureInit(signal)
    if (retentionDays <= 0) return 0
    const registry = await this.readTrashRegistry(signal)
    const cutoff = now.getTime() - retentionDays * 86_400_000
    const purged = new Set<string>()
    for (const [trashRel, when] of Object.entries(registry)) {
      signal?.throwIfAborted()
      const deletedAt = Date.parse(when)
      if (Number.isNaN(deletedAt) || deletedAt > cutoff) continue
      const target = await this.target(trashRel, signal)
      const info = await this.fs.stat(target, signal)
      if (info !== undefined) {
        let text = ' '
        try {
          text = await this.fs.readText(target, signal)
        } catch {
          // The file vanished mid-sweep; only the registry entry is stale.
        }
        await this.cascadePurgeImages(extractImageRefs(text, ''), signal)
        await this.fs.writeText(target, ' ', undefined, signal)
      }
      purged.add(trashRel)
    }
    if (purged.size > 0) {
      const next: Record<string, string> = {}
      for (const [path, when] of Object.entries(registry)) {
        if (!purged.has(path)) next[path] = when
      }
      await this.writeTrashRegistry(next, signal)
    }
    return purged.size
  }

  /** Blank and unregister referenced images that no other document uses. */
  private async cascadePurgeImages(refs: readonly string[], signal?: AbortSignal): Promise<void> {
    if (refs.length === 0) return
    const referencedElsewhere = new Set<string>()
    for (const [rel, doc] of this.docs) {
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      for (const ref of extractImageRefs(doc.body, dir)) {
        const target = await this.imageTarget(ref, signal)
        if (target !== null) referencedElsewhere.add(target)
      }
    }
    for (const ref of refs) {
      const target = await this.imageTarget(ref, signal)
      if (target === null || referencedElsewhere.has(target)) continue
      await this.fs.writeText(await this.target(target, signal), '', undefined, signal)
      await this.removeImageRegistration(target, signal)
    }
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
        // The registry is the unified object format: path → { name, referenced }.
        const parsed = JSON.parse(await this.fs.readText(imageIndex, signal)) as
          { images?: Record<string, { name?: string } | undefined> }
        for (const [path, entry] of Object.entries(parsed.images ?? {})) {
          const entryName = entry?.name ?? path.split('/').pop() ?? ''
          if (entryName === name || entryName === name + '.png') return { path, kind: 'image' }
        }
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
   * Serve one image's raw bytes with its MIME type; throws when absent or
   * oversized. A document whose relative image reference no longer resolves
   * (it moved, was restored into another directory, or is previewed from the
   * trash) falls back to the image registry by basename.
   * @param rel - the library-relative image path
   * @param signal - abort signal for cooperative cancellation
   * @returns the bytes and MIME type
   */
  async image(rel: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }> {
    await this.ensureInit(signal)
    const resolved = await this.imageTarget(rel, signal)
    if (resolved === null) throw new Error(`kb: 图片不存在: ${rel}`)
    const ext = (resolved.split('.').pop() ?? '').toLowerCase()
    const mime = IMAGE_MIME[ext] ?? 'application/octet-stream'
    const bytes = await this.fs.readBytes(await this.target(resolved, signal), signal, 20 * 1024 * 1024)
    // A blank file is a purged image; treat it as absent so cleared images 404.
    if (bytes.length === 0) throw new Error(`kb: 图片不存在: ${rel}`)
    return { bytes, mime }
  }

  /**
   * Resolve one image path to the file that serves it: the exact path first,
   * then the registry by basename (documents move, but images stay put).
   * @param rel - the library-relative image path.
   * @param signal - abort signal for cooperative cancellation.
   * @returns the serving path, or null when nothing matches.
   */
  private async imageTarget(rel: string, signal?: AbortSignal): Promise<string | null> {
    const info = await this.fs.stat(await this.target(rel, signal), signal)
    if (info !== undefined && info.type === 'file') return rel
    const name = rel.split('/').pop() ?? ''
    const index = await this.locate('_meta/images.json', signal)
    const indexInfo = await this.fs.stat(index, signal)
    if (name.length === 0 || indexInfo === undefined) return null
    try {
      const parsed = JSON.parse(await this.fs.readText(index, signal)) as { images?: Record<string, unknown> }
      const hit = Object.keys(parsed.images ?? {}).find(path => (path.split('/').pop() ?? '') === name)
      return hit ?? null
    } catch {
      // A malformed registry is not an image-loading failure beyond the 404 below.
      return null
    }
  }

  /** Remove one image path from the registry when it is no longer referenced. */
  private async removeImageRegistration(rel: string, signal?: AbortSignal): Promise<void> {
    const index = await this.locate('_meta/images.json', signal)
    try {
      const parsed = JSON.parse(await this.fs.readText(index, signal)) as { images?: Record<string, unknown> }
      if (parsed.images !== undefined && rel in parsed.images) {
        // JSON.stringify omits undefined values, which removes the key without
        // a dynamic delete.
        parsed.images[rel] = undefined
        await this.fs.writeText(index, JSON.stringify(parsed, null, 2), undefined, signal)
      }
    } catch {
      // A malformed registry is left alone; the blanked file 404s on its own.
    }
  }

  /** Read the deletion-timestamp registry; a missing or malformed one is empty. */
  private async readTrashRegistry(signal?: AbortSignal): Promise<Record<string, string>> {
    const target = await this.locate(TRASH_REGISTRY, signal)
    try {
      const parsed = JSON.parse(await this.fs.readText(target, signal)) as { entries?: Record<string, unknown> }
      const entries: Record<string, string> = {}
      if (parsed.entries !== undefined) {
        for (const [path, when] of Object.entries(parsed.entries)) {
          if (typeof when === 'string') entries[path] = when
        }
      }
      return entries
    } catch {
      // A missing or malformed registry is empty; the next mutation rewrites it.
      return {}
    }
  }

  /** Persist the deletion-timestamp registry; a failed write is retried on the next mutation. */
  private async writeTrashRegistry(entries: Record<string, string>, signal?: AbortSignal): Promise<void> {
    const target = await this.locate(TRASH_REGISTRY, signal)
    try {
      await this.fs.writeText(target, JSON.stringify({ schemaVersion: 1, entries }, null, 2), undefined, signal)
    } catch {
      // Without the registry the entry is never auto-swept, only manually purged.
    }
  }

  /** Record one deletion time; the delete succeeds even when the registry cannot. */
  private async recordTrash(trashRel: string, deletedAt: Date, signal?: AbortSignal): Promise<void> {
    const registry = await this.readTrashRegistry(signal)
    registry[trashRel] = deletedAt.toISOString()
    await this.writeTrashRegistry(registry, signal)
  }

  /** Forget one trash path; a stale entry is pruned by the next listing or sweep. */
  private async unregisterTrash(trashRel: string, signal?: AbortSignal): Promise<void> {
    const registry = await this.readTrashRegistry(signal)
    if (!(trashRel in registry)) return
    const next: Record<string, string> = {}
    for (const [path, when] of Object.entries(registry)) {
      if (path !== trashRel) next[path] = when
    }
    await this.writeTrashRegistry(next, signal)
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
  private backlinksOf(rel: string, doc: KbDoc): string[] {
    const out: string[] = []
    const title = titleOf(rel, doc)
    for (const [other, otherDoc] of this.docs) {
      if (other === rel) continue
      if (extractLinks(otherDoc.body).some(link =>
        link === rel || link === rel.replace(/\.md$/, '') || (title.length > 0 && link === title))) out.push(other)
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
    const { counts, len } = weightedIndexOf(doc)
    for (const gram of counts.keys()) {
      const posts = this.inverted.get(gram)
      if (posts === undefined) continue
      posts.delete(rel)
      if (posts.size === 0) this.inverted.delete(gram)
    }
    if (this.docLen.has(rel)) {
      this.totalLen -= len
      this.docLen.delete(rel)
    }
  }

  /** Add one document's weighted grams to the inverted index. */
  private indexDoc(rel: string, doc: KbDoc): void {
    const { counts, len } = weightedIndexOf(doc)
    this.docLen.set(rel, len)
    this.totalLen += len
    for (const [gram, tf] of counts) {
      let posts = this.inverted.get(gram)
      if (posts === undefined) {
        posts = new Map()
        this.inverted.set(gram, posts)
      }
      posts.set(rel, tf)
    }
  }
}

/** Field weights used by the search scorer: headings and metadata outrank the body. */
const FIELD_WEIGHTS: ReadonlyArray<readonly [keyof SearchFields, number]> = [
  ['title', 3], ['aliases', 2.5], ['tags', 2], ['summary', 1.5], ['body', 1],
]

/** BM25 saturation and length-normalization parameters. */
const BM25_K1 = 1.5
const BM25_B = 0.75

/** Score discount applied to single-character-neighbor grams (typo tolerance). */
const FUZZY_GRAM_WEIGHT = 0.6

/** The field texts of one document, each searched with its own weight. */
interface SearchFields {
  title: string
  aliases: string
  tags: string
  summary: string
  body: string
}

/** Weighted 2-gram term frequencies and weighted length of one document. */
function weightedIndexOf(doc: KbDoc): { counts: Map<string, number>; len: number } {
  const counts = new Map<string, number>()
  let len = 0
  for (const [field, weight] of FIELD_WEIGHTS) {
    const text = fieldsOf(doc)[field]
    if (text.length === 0) continue
    len += weight * text.length
    for (const [gram, count] of gramCounts(text)) {
      counts.set(gram, (counts.get(gram) ?? 0) + weight * count)
    }
  }
  return { counts, len }
}

/** The searchable fields of one document. */
function fieldsOf(doc: KbDoc): SearchFields {
  return {
    title: scalar(doc.meta.title),
    aliases: arrayOf(doc.meta.aliases).join(' '),
    tags: arrayOf(doc.meta.tags).join(' '),
    summary: scalar(doc.meta.summary),
    body: doc.body,
  }
}

/** All 2-grams of a lowercase, whitespace-collapsed string. */
function grams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/\s+/g, ' ')
  const out = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2))
  return out
}

/** Counts of each 2-gram in a lowercase, whitespace-collapsed string. */
function gramCounts(text: string): Map<string, number> {
  const clean = text.toLowerCase().replace(/\s+/g, ' ')
  const out = new Map<string, number>()
  for (let i = 0; i < clean.length - 1; i++) {
    const gram = clean.slice(i, i + 2)
    out.set(gram, (out.get(gram) ?? 0) + 1)
  }
  return out
}

/** Whether two same-length 2-grams differ in exactly one character. */
function nearGram(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++
    if (diff > 1) return false
  }
  return diff === 1
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

/** Today's ISO date (YYYY-MM-DD) in local time. */
function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** A file-safe name derived from the title. */
function sanitizeName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '').trim() || 'untitled'
}
