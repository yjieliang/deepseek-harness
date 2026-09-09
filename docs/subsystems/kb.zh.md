# 知识库

[English](kb.md) | 中文

知识库能力服务于机器全局 markdown 库（默认 `$DSH_HOME/kb`，被本机所有工作区共享）：宿主服务（`ctx.kb`）、浏览器面板与模型面向的工具共享同一引擎与同一写路径。引擎、索引与 wire 词汇位于 [`packages/host/kb`](../../packages/host/kb/README.md)；工具位于 [`@deepseek-ai/dsh-tool-kb`](../../packages/host/tool-kb/README.md)；面板位于 [`@deepseek-ai/dsh-client-ui-kb`](../../packages/client/ui-kb/README.md)。单引擎收敛决策记录在[引擎收敛 Agent Note](../../.agents/notes/implemented/feature/2026-08-15-kb-engine-convergence-tool-package.md)。

## 库模型

库根下的每个 `*.md` 都是一篇文档：扁平 frontmatter 块（title、aliases、tags、summary、source、created、updated、pinned）加 Markdown 正文。状态由所在目录推导——`00-inbox/` 或 `01-inbox/` → `inbox`，配置的归档目录 → `archived`，其余 → `filed`——因此移动文档即改变其状态，不存在第二事实源。删除把文档移入可恢复的 `.trash`；`kb/_meta/index.json` 是引擎每次变更后重写的可重建注册表。

引擎维护惰性内存 2-gram 倒排索引，并以标题/别名/标签/摘要/正文的分字段加权 BM25 打分（部分命中排序召回，经单字符邻居 gram 容错单字笔误）。`kb.refresh` 从磁盘重建索引，因此外部新增或编辑的文档无需重启即可出现。

## 服务行为

[`KbGateway`](../../packages/host/kb/src/index.ts) 是以 `ctx.kb` 注册的 `TypertRemoteService`：浏览器面板经 `kb` Remote 命名空间（list、search、get、save、create、move、trash、restore、purge、resolve、refresh……）读取它，`/dsh-kb` 图片路由提供文档图片。工具面追加了普通（非 Remote）方法——`searchFiltered`（超出面板 wire 的字段过滤）、`links`（出链+反链）与 `images`（图片注册表重建+孤儿检测）——`@deepseek-ai/dsh-tool-kb` 据此组合，无需拓宽 Remote wire。写入携带 `expectVersion` 乐观锁；过期锁以 `{ conflict: true }` 上报且不动索引。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxkb--kbgateway"></a>

### `ctx.kb` — `KbGateway`

Remote-only service exposing the knowledge base to the browser panel. One host instance; the engine is per-process and lazy.

```ts cordis-catalog
/**
 * List documents with optional status/tag/directory filters.
 * @param request - the list filters
 * @param signal - abort signal for cooperative cancellation
 * @returns the matching documents
 */
@Remote('list') async list(request: KbListRequest, signal: AbortSignal): Promise<KbListResult>

/**
 * 2-gram AND search over title/aliases/tags/summary/body.
 * @param request - the search query and cap
 * @param signal - abort signal for cooperative cancellation
 * @returns the hits and total
 */
@Remote('search') async search(request: KbSearchRequest, signal: AbortSignal): Promise<KbSearchResult>

/**
 * Tool-facing search with field filters; not part of the panel Remote wire.
 * @param request - the query, filters, and cap
 * @param signal - abort signal for cooperative cancellation
 * @returns the filtered hits and total
 */
async searchFiltered(request: KbToolSearchRequest, signal: AbortSignal): Promise<KbSearchResult>

/**
 * One document's link view (outlinks + backlinks); not part of the panel wire.
 * @param path - library-relative document path
 * @param signal - abort signal for cooperative cancellation
 * @returns the link view
 */
async links(path: string, signal: AbortSignal): Promise<KbLinksResult>

/**
 * Rebuild the image registry, list orphaned images; not part of the panel wire.
 * @param signal - abort signal for cooperative cancellation
 * @returns the image scan result
 */
async images(signal: AbortSignal): Promise<KbImagesResult>

/**
 * Full read of one document: body, frontmatter, backlinks, version.
 * @param request - the read request
 * @param signal - abort signal for cooperative cancellation
 * @returns the full read result
 */
@Remote('get') async get(request: KbGetRequest, signal: AbortSignal): Promise<KbGetResult>

/**
 * Available library directories.
 * @param _request - unused
 * @param signal - abort signal for cooperative cancellation
 * @returns the directory list
 */
@Remote('dirs') async dirs(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbDirsResult>

/**
 * Library statistics.
 * @param _request - unused
 * @param signal - abort signal for cooperative cancellation
 * @returns totals, per-status counts, directories, and the archive directory
 */
@Remote('stats') async stats(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbStatsResult>

/**
 * Tag index, most-used first.
 * @param _request - unused
 * @param signal - abort signal for cooperative cancellation
 * @returns tag counts
 */
@Remote('tags') async tags(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbTagsResult>

/**
 * Rebuild the in-memory index from disk, absorbing changes made outside the
 * engine; the panel calls it when it opens.
 * @param _request - unused
 * @param signal - abort signal for cooperative cancellation
 * @returns no data
 */
@Remote('refresh') async refresh(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbEmptyResult>

/**
 * Apply a field patch + body replacement with an optional optimistic lock.
 * @param request - the field patch
 * @param signal - abort signal for cooperative cancellation
 * @returns the write outcome
 */
@Remote('saveDoc') async saveDoc(request: KbSaveRequest, signal: AbortSignal): Promise<KbSaveResult>

/**
 * Create a dated document, minting a collision-free path.
 * @param request - title, directory, and optional initial fields
 * @param signal - abort signal for cooperative cancellation
 * @returns the created document
 */
@Remote('createDoc') async createDoc(request: KbCreateRequest, signal: AbortSignal): Promise<KbCreateResult>

/**
 * Move a document into another directory.
 * @param request - source path and target directory
 * @param signal - abort signal for cooperative cancellation
 * @returns source and destination paths
 */
@Remote('moveDoc') async moveDoc(request: KbMoveRequest, signal: AbortSignal): Promise<KbMoveResult>

/**
 * Rename a document within the same directory, updating the frontmatter title.
 * @param request - source path and new stem name
 * @param signal - abort signal for cooperative cancellation
 * @returns source and destination paths
 */
@Remote('renameDoc') async renameDoc(request: KbRenameRequest, signal: AbortSignal): Promise<KbRenameResult>

/**
 * Create a library directory through a `.keep` marker.
 * @param request - the library-relative directory path
 * @param signal - abort signal for cooperative cancellation
 * @returns the created directory
 */
@Remote('createDir') async createDir(request: KbCreateDirRequest, signal: AbortSignal): Promise<KbCreateDirResult>

/**
 * Rename a library directory, relocating every entry beneath it.
 * @param request - the directory and its replacement name
 * @param signal - abort signal for cooperative cancellation
 * @returns source, destination, and moved entry count
 */
@Remote('renameDir') async renameDir(request: KbRenameDirRequest, signal: AbortSignal): Promise<KbRenameDirResult>

/**
 * Move a document into `.trash` (recoverable).
 * @param request - the delete request
 * @param signal - abort signal for cooperative cancellation
 * @returns the deleted and trash paths
 */
@Remote('deleteDoc') async deleteDoc(request: KbDeleteRequest, signal: AbortSignal): Promise<KbDeleteResult>

/**
 * List the recoverable trash.
 * @param _request - unused
 * @param signal - abort signal for cooperative cancellation
 * @returns the trashed documents
 */
@Remote('trash') async trash(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbTrashResult>

/**
 * Restore a trashed document into a library directory.
 * @param request - the trash path and optional target directory
 * @param signal - abort signal for cooperative cancellation
 * @returns source and destination paths
 */
@Remote('restoreDoc') async restoreDoc(request: KbRestoreRequest, signal: AbortSignal): Promise<KbRestoreResult>

/**
 * Permanently clear one trashed document.
 * @param request - the trash path
 * @param signal - abort signal for cooperative cancellation
 * @returns the purged path
 */
@Remote('purgeDoc') async purgeDoc(request: KbPurgeRequest, signal: AbortSignal): Promise<KbPurgeResult>

/**
 * Resolve a `[[name]]` target: exact title/stem, image registry, then fuzzy.
 * @param request - the link name
 * @param signal - abort signal for cooperative cancellation
 * @returns the resolved target
 */
@Remote('resolveLink') async resolveLink(request: KbResolveRequest, signal: AbortSignal): Promise<KbResolveResult>
```

Source: [`packages/host/kb/src/index.ts:116`](../../packages/host/kb/src/index.ts)
<!-- END GENERATED cordis-surface -->
