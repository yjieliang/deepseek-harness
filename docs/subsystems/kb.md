# Knowledge base

English | [中文](kb.zh.md)

The knowledge-base capability serves the machine-global markdown library (default `$DSH_HOME/kb`, shared by every workspace): the host service (`ctx.kb`), the browser panel, and the model-facing tools share one engine and one write path. The engine, the index, and the wire vocabulary live in [`packages/host/kb`](../../packages/host/kb/README.md); the tools live in [`@deepseek-ai/dsh-tool-kb`](../../packages/host/tool-kb/README.md); the panel lives in [`@deepseek-ai/dsh-client-ui-kb`](../../packages/client/ui-kb/README.md). The single-engine convergence decision is recorded in the [engine-convergence Agent Note](../../.agents/notes/implemented/feature/2026-08-15-kb-engine-convergence-tool-package.md).

## Library model

Every `*.md` under the library root is a document: a flat frontmatter block (title, aliases, tags, summary, source, created, updated, pinned) plus a Markdown body. Status is derived from the containing directory — `00-inbox/` or `01-inbox/` → `inbox`, the configured archive directory → `archived`, else `filed` — so moving a document changes its status and no second source of truth exists. Deletions move documents into a recoverable `.trash`; `kb/_meta/index.json` is a rebuildable registry written by the engine after every mutation.

The engine keeps a lazy in-memory 2-gram inverted index and scores hits with field-weighted BM25 over title/aliases/tags/summary/body (ranked partial-query hits, one-character typo tolerance through single-character neighbor grams). `kb.refresh` rebuilds the index from disk so externally added or edited documents appear without a restart.

## Service behavior

[`KbGateway`](../../packages/host/kb/src/index.ts) is a `TypertRemoteService` registered as `ctx.kb`: the browser panel reads it through the `kb` Remote namespace (list, search, get, save, create, move, trash, restore, purge, resolve, refresh, …) and the `/dsh-kb` image route serves document images. The tool-facing surface adds plain (non-Remote) methods — `searchFiltered` (field filters beyond the panel wire), `links` (outlinks + backlinks), and `images` (image registry rebuild + orphan detection) — so `@deepseek-ai/dsh-tool-kb` composes them without widening the Remote wire. Writes carry an `expectVersion` optimistic lock; a stale lock is reported as `{ conflict: true }` and leaves the index untouched.

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
