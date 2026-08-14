/**
 * Knowledge-base host Gateway: the browser panel's Remote namespace plus the
 * `/dsh-kb` image route over the `kb/` workspace root. The engine owns the
 * index; this service exposes it over the Typert Remote wire and serves
 * document images over HTTP.
 *
 * The model-facing kb TOOLS live in the agent preset (per-session), not here;
 * this package is the panel's data plane and the image carrier.
 * @module @deepseek-ai/dsh-host-kb
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { KbEngine } from './core.ts'
import { DEFAULT_ARCHIVE_DIR, DEFAULT_TRASH_RETENTION_DAYS, RESERVED_DIRS } from './core.ts'
import type {
  KbCreateDirRequest, KbCreateDirResult, KbCreateRequest, KbCreateResult, KbDeleteRequest,
  KbDeleteResult, KbDirsResult, KbEmptyRequest, KbEmptyResult, KbGetRequest, KbGetResult,
  KbListRequest, KbListResult, KbMoveRequest, KbMoveResult, KbPurgeRequest, KbPurgeResult,
  KbRenameDirRequest, KbRenameDirResult, KbResolveRequest, KbResolveResult, KbRestoreRequest,
  KbRestoreResult, KbSaveRequest, KbSaveResult, KbSearchRequest, KbSearchResult, KbStatsResult,
  KbTagsResult, KbTrashResult,
} from './types.ts'

export type * from './types.ts'

/** Image-serving route prefix under the web server. */
const IMAGE_ROUTE_PREFIX = '/dsh-kb'

/** How often the trash retention sweep runs after its startup pass. */
const TRASH_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Gateway configuration: archive directory and trash retention are deployment choices. */
export interface KbGatewayConfig {
  /** Directory whose documents derive status `archived`; default `90-归档`. */
  archiveDir?: string
  /** Days a trashed document is kept before automatic purge; `0` disables the sweep. Default 30. */
  trashRetentionDays?: number
}

/** Validate a configured archive directory; misconfiguration fails at load. */
function archiveDirOf(config: KbGatewayConfig | undefined): string {
  if (config?.archiveDir === undefined) return DEFAULT_ARCHIVE_DIR
  const dir = config.archiveDir.replace(/^\/+|\/+$/g, '')
  if (dir.length === 0 || dir.includes('/') || RESERVED_DIRS.has(dir)) {
    throw new Error(`kb: archiveDir must be a single non-reserved directory name, got "${config.archiveDir}"`)
  }
  return dir
}

/** Validate configured trash retention; misconfiguration fails at load. */
function trashRetentionOf(config: KbGatewayConfig | undefined): number {
  const days = config?.trashRetentionDays ?? DEFAULT_TRASH_RETENTION_DAYS
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`kb: trashRetentionDays must be a non-negative number of days, got "${config?.trashRetentionDays}"`)
  }
  return days
}

/** One image served with its MIME type; a missing or oversized file answers 404. */
async function serveImage(
  engine: KbEngine,
  rawUrl: string | undefined,
  req: Parameters<WebRoute['handler']>[0],
  res: Parameters<WebRoute['handler']>[1],
): Promise<void> {
  const pathname = (req.url ?? rawUrl ?? '').split('?')[0] ?? ''
  let rel = pathname.startsWith(IMAGE_ROUTE_PREFIX + '/')
    ? pathname.slice(IMAGE_ROUTE_PREFIX.length + 1)
    : pathname.slice(IMAGE_ROUTE_PREFIX.length)
  try {
    rel = decodeURIComponent(rel)
  } catch {
    // A malformed escape is a 404, not a crash.
  }
  if (rel.length === 0 || rel.includes('..')) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const { bytes, mime } = await engine.image(rel)
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' })
  res.end(bytes)
}

/**
 * Remote-only service exposing the knowledge base to the browser panel. One
 * host instance; the engine is per-process and lazy.
 */
export class KbGateway extends TypertRemoteService {
  static inject = ['fs']

  private readonly engine: KbEngine

  constructor(ctx: Context, config?: KbGatewayConfig) {
    super(ctx, 'kb')
    const sandboxPolicy = ctx.get('sandboxPolicy') as { workspaceRoot?: string } | undefined
    this.engine = new KbEngine(ctx.fs, sandboxPolicy?.workspaceRoot, archiveDirOf(config))
    const retention = trashRetentionOf(config)
    if (retention > 0) this.startTrashSweep(ctx, retention)
    const webServer = ctx.get('webServer') as { register(route: WebRoute): () => void } | undefined
    if (webServer !== undefined) {
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: IMAGE_ROUTE_PREFIX,
        handler: (req, res) => {
          serveImage(this.engine, req.url, req, res).catch(() => {
            try {
              res.writeHead(404)
              res.end('not found')
            } catch {
              // The response already ended; nothing to report.
            }
          })
        },
      }), 'kb: image route')
    }
  }

  /** Run the retention sweep once at load and on the interval; the timer dies with the fiber. */
  private startTrashSweep(ctx: Context, retentionDays: number): void {
    ctx.effect(() => {
      const sweep = (): void => {
        this.engine.sweepTrash(new Date(), retentionDays).catch(() => {
          // A failed sweep is retried on the next tick; it must not take the gateway down.
        })
      }
      sweep()
      const timer = setInterval(sweep, TRASH_SWEEP_INTERVAL_MS)
      return () => { clearInterval(timer) }
    }, 'kb: trash retention sweep')
  }

  /**
 * List documents with optional status/tag/directory filters.
 * @param request - the list filters
 * @param signal - abort signal for cooperative cancellation
 * @returns the matching documents
 */
  @Remote('list')
  async list(request: KbListRequest, signal: AbortSignal): Promise<KbListResult> {
    signal.throwIfAborted()
    return { docs: await this.engine.list(request, signal) }
  }

  /**
 * 2-gram AND search over title/aliases/tags/summary/body.
 * @param request - the search query and cap
 * @param signal - abort signal for cooperative cancellation
 * @returns the hits and total
 */
  @Remote('search')
  async search(request: KbSearchRequest, signal: AbortSignal): Promise<KbSearchResult> {
    signal.throwIfAborted()
    const topK = Math.max(1, Math.min(50, Number(request.topK) || 10))
    return await this.engine.search(request.query, topK, signal)
  }

  /**
 * Full read of one document: body, frontmatter, backlinks, version.
 * @param request - the read request
 * @param signal - abort signal for cooperative cancellation
 * @returns the full read result
 */
  @Remote('get')
  async get(request: KbGetRequest, signal: AbortSignal): Promise<KbGetResult> {
    signal.throwIfAborted()
    return await this.engine.get(request, signal)
  }

  /**
 * Available library directories.
 * @param _request - unused
 * @param signal - abort signal for cooperative cancellation
 * @returns the directory list
 */
  @Remote('dirs')
  async dirs(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbDirsResult> {
    signal.throwIfAborted()
    return { dirs: await this.engine.dirs(signal) }
  }

  /**
 * Library statistics.
 * @param _request - unused
 * @param signal - abort signal for cooperative cancellation
 * @returns totals, per-status counts, directories, and the archive directory
 */
  @Remote('stats')
  async stats(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbStatsResult> {
    signal.throwIfAborted()
    return await this.engine.stats(signal)
  }

  /**
 * Tag index, most-used first.
 * @param _request - unused
 * @param signal - abort signal for cooperative cancellation
 * @returns tag counts
 */
  @Remote('tags')
  async tags(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbTagsResult> {
    signal.throwIfAborted()
    return { tags: await this.engine.tags(signal) }
  }

  /**
   * Rebuild the in-memory index from disk, absorbing changes made outside the
   * engine; the panel calls it when it opens.
   * @param _request - unused
   * @param signal - abort signal for cooperative cancellation
   * @returns no data
   */
  @Remote('refresh')
  async refresh(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbEmptyResult> {
    signal.throwIfAborted()
    await this.engine.refresh(signal)
    return {}
  }

  /**
 * Apply a field patch + body replacement with an optional optimistic lock.
 * @param request - the field patch
 * @param signal - abort signal for cooperative cancellation
 * @returns the write outcome
 */
  @Remote('saveDoc')
  async saveDoc(request: KbSaveRequest, signal: AbortSignal): Promise<KbSaveResult> {
    signal.throwIfAborted()
    return await this.engine.save(request, signal)
  }

  /**
 * Create a dated document, minting a collision-free path.
 * @param request - title, directory, and optional initial fields
 * @param signal - abort signal for cooperative cancellation
 * @returns the created document
 */
  @Remote('createDoc')
  async createDoc(request: KbCreateRequest, signal: AbortSignal): Promise<KbCreateResult> {
    signal.throwIfAborted()
    return await this.engine.create(request, signal)
  }

  /**
 * Move a document into another directory.
 * @param request - source path and target directory
 * @param signal - abort signal for cooperative cancellation
 * @returns source and destination paths
 */
  @Remote('moveDoc')
  async moveDoc(request: KbMoveRequest, signal: AbortSignal): Promise<KbMoveResult> {
    signal.throwIfAborted()
    return await this.engine.move(request, signal)
  }

  /**
 * Create a library directory through a `.keep` marker.
 * @param request - the library-relative directory path
 * @param signal - abort signal for cooperative cancellation
 * @returns the created directory
 */
  @Remote('createDir')
  async createDir(request: KbCreateDirRequest, signal: AbortSignal): Promise<KbCreateDirResult> {
    signal.throwIfAborted()
    return await this.engine.createDir(request, signal)
  }

  /**
 * Rename a library directory, relocating every entry beneath it.
 * @param request - the directory and its replacement name
 * @param signal - abort signal for cooperative cancellation
 * @returns source, destination, and moved entry count
 */
  @Remote('renameDir')
  async renameDir(request: KbRenameDirRequest, signal: AbortSignal): Promise<KbRenameDirResult> {
    signal.throwIfAborted()
    return await this.engine.renameDir(request, signal)
  }

  /**
 * Move a document into `.trash` (recoverable).
 * @param request - the delete request
 * @param signal - abort signal for cooperative cancellation
 * @returns the deleted and trash paths
 */
  @Remote('deleteDoc')
  async deleteDoc(request: KbDeleteRequest, signal: AbortSignal): Promise<KbDeleteResult> {
    signal.throwIfAborted()
    return await this.engine.remove(request, signal)
  }

  /**
 * List the recoverable trash.
 * @param _request - unused
 * @param signal - abort signal for cooperative cancellation
 * @returns the trashed documents
 */
  @Remote('trash')
  async trash(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbTrashResult> {
    signal.throwIfAborted()
    return await this.engine.trash(signal)
  }

  /**
 * Restore a trashed document into a library directory.
 * @param request - the trash path and optional target directory
 * @param signal - abort signal for cooperative cancellation
 * @returns source and destination paths
 */
  @Remote('restoreDoc')
  async restoreDoc(request: KbRestoreRequest, signal: AbortSignal): Promise<KbRestoreResult> {
    signal.throwIfAborted()
    return await this.engine.restore(request, signal)
  }

  /**
 * Permanently clear one trashed document.
 * @param request - the trash path
 * @param signal - abort signal for cooperative cancellation
 * @returns the purged path
 */
  @Remote('purgeDoc')
  async purgeDoc(request: KbPurgeRequest, signal: AbortSignal): Promise<KbPurgeResult> {
    signal.throwIfAborted()
    return await this.engine.purge(request, signal)
  }

  /**
 * Resolve a `[[name]]` target: exact title/stem, image registry, then fuzzy.
 * @param request - the link name
 * @param signal - abort signal for cooperative cancellation
 * @returns the resolved target
 */
  @Remote('resolveLink')
  async resolveLink(request: KbResolveRequest, signal: AbortSignal): Promise<KbResolveResult> {
    signal.throwIfAborted()
    return await this.engine.resolve(request, signal)
  }
}

export default KbGateway
