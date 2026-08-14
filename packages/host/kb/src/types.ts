/**
 * Wire vocabulary of the knowledge-base Remote and its browser panel.
 * Client-safe: plain JSON only, no branded ids, no service imports.
 */

/** Derivable library status of one document from its directory. */
export type KbDocStatus = 'inbox' | 'filed' | 'archived'

/** Status filter accepted by list/search; `all` is the neutral default. */
export type KbStatusFilter = 'all' | KbDocStatus

/** One document as the panel lists it. */
export interface KbDocSummary {
  /** Library-relative path, e.g. `00-inbox/2026-08-14-测试.md`. */
  path: string
  /** Document title (frontmatter, falling back to the file stem). */
  title: string
  /** One-sentence frontmatter summary, empty when absent. */
  summary: string
  /** Frontmatter tags. */
  tags: string[]
  /** Status derived from the containing directory. */
  status: KbDocStatus
  /** `updated` frontmatter date, empty when absent. */
  updated: string
}

/** List request: optional status/tag/directory filters. */
export interface KbListRequest {
  /** Status filter; `all` or absent lists every status. */
  status?: KbStatusFilter
  /** Only documents carrying this tag. */
  tag?: string
  /** Only documents under this directory prefix. */
  directory?: string
}

/** List response. */
export interface KbListResult {
  /** Documents matching the filters, most recently updated first. */
  docs: KbDocSummary[]
}

/** Search request: 2-gram AND matching over title/aliases/tags/summary/body. */
export interface KbSearchRequest {
  /** Search terms, whitespace-separated terms are ANDed. */
  query: string
  /** Result cap, clamped to 1..50; defaults to 10. */
  topK?: number
}

/** Search response. */
export interface KbSearchResult {
  /** Top matches in recency order. */
  hits: KbDocSummary[]
  /** Every matching document before the cap. */
  total: number
}

/** One frontmatter value crossing the wire: a scalar string or an inline array. */
export type KbFrontmatterValue = string | string[]

/** Parsed frontmatter of one document plus the derived status. */
export interface KbDocMeta {
  [key: string]: KbFrontmatterValue | KbDocStatus
  /** Derivable library status of the document. */
  status: KbDocStatus
}

/** Request type for Remote methods that take no input. */
export interface KbEmptyRequest {
}

/** Read request. */
export interface KbGetRequest {
  /** Library-relative document path. */
  path: string
}

/** One document's full read: body, frontmatter, and backlinks. */
export interface KbGetResult {
  /** Echoed library-relative path. */
  path: string
  /** Markdown body without the frontmatter block. */
  content: string
  /** Parsed frontmatter plus the derived `status` field. */
  meta: KbDocMeta
  /** Paths of documents linking to this one via `[[title]]`. */
  backlinks: string[]
  /** File version token for optimistic-lock writes; absent when unreadable. */
  version?: string
}

/** Available library directories, sorted. */
export interface KbDirsResult {
  dirs: string[]
}

/** Library statistics. */
export interface KbStatsResult {
  /** Total documents indexed. */
  total: number
  /** Documents per derived status. */
  byStatus: { inbox: number; filed: number; archived: number }
  /** Available directories, sorted. */
  dirs: string[]
}

/** One tag with its document count. */
export interface KbTagCount {
  tag: string
  count: number
}

/** Tag index, most-used first. */
export interface KbTagsResult {
  tags: KbTagCount[]
}

/** Update request: fields not supplied keep their current value. */
export interface KbSaveRequest {
  /** Library-relative document path. */
  path: string
  /** Replacement Markdown body (without frontmatter); absent keeps the body. */
  content?: string
  /** Replacement summary; absent keeps the current one. */
  summary?: string
  /** Replacement tag list; absent keeps the current one. */
  tags?: string[]
  /** Optimistic-lock version; a mismatch refuses the write with `conflict`. */
  expectVersion?: string
}

/** Update response. */
export interface KbSaveResult {
  /** Echoed library-relative path. */
  path: string
  /** Post-write file version when available. */
  version?: string
  /** True when `expectVersion` mismatched and nothing was written. */
  conflict: boolean
}

/** Create request: lands in `directory` (default `00-inbox`) dated today. */
export interface KbCreateRequest {
  /** Document title; also seeds the dated file name. */
  title: string
  /** Initial Markdown body, optional. */
  content?: string
  /** Target directory, default `00-inbox`. */
  directory?: string
  /** Frontmatter tags. */
  tags?: string[]
  /** Original source URL. */
  source?: string
  /** One-sentence summary. */
  summary?: string
}

/** Create response. */
export interface KbCreateResult {
  /** The minted library-relative path. */
  path: string
  /** Post-write file version when available. */
  version?: string
}

/** Move request: relocates the document to another directory. */
export interface KbMoveRequest {
  /** Library-relative source path. */
  path: string
  /** Target directory, e.g. `10-技术/11-AI`. */
  targetDirectory: string
}

/** Move response. */
export interface KbMoveResult {
  /** Source path. */
  from: string
  /** Destination path (renamed on collision). */
  to: string
}

/** Delete request: moves the document into the `.trash` directory. */
export interface KbDeleteRequest {
  /** Library-relative document path. */
  path: string
}

/** Delete response. */
export interface KbDeleteResult {
  /** Deleted path. */
  path: string
  /** Trash location (`.trash/<name>.md`). */
  trash: string
}

/** One trashed document. */
export interface KbTrashEntry {
  /** Trash-relative path. */
  path: string
  /** File name. */
  name: string
  /** Title parsed from the trashed body, or the file stem. */
  title: string
  /** Full Markdown body (frontmatter included). */
  body: string
}

/** Trash listing. */
export interface KbTrashResult {
  docs: KbTrashEntry[]
}

/** Restore request: returns a trashed document to a library directory. */
export interface KbRestoreRequest {
  /** Trash-relative path, e.g. `.trash/2026-08-14-测试.md`. */
  path: string
  /** Target directory, default `00-inbox`. */
  targetDirectory?: string
}

/** Restore response. */
export interface KbRestoreResult {
  /** Trash path restored from. */
  from: string
  /** Library path restored to (renamed on collision). */
  to: string
}

/** Purge request: permanently clears one trashed document. */
export interface KbPurgeRequest {
  /** Trash-relative path. */
  path: string
}

/** Purge response. */
export interface KbPurgeResult {
  /** Purged trash path. */
  path: string
  /** Always true. */
  purged: boolean
}

/** Link-resolution request: name or title to locate. */
export interface KbResolveRequest {
  /** `[[name]]` link target, title or file stem. */
  name: string
}

/** Link-resolution response. */
export interface KbResolveResult {
  /** Resolved library-relative path, null when nothing matched. */
  path: string | null
  /** What the name resolved to. */
  kind: 'doc' | 'image' | 'missing'
}
