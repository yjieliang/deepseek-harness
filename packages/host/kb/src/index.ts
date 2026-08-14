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
import type {
  KbCreateRequest, KbCreateResult, KbDeleteRequest, KbDeleteResult, KbDirsResult, KbEmptyRequest,
  KbGetRequest, KbGetResult, KbListRequest, KbListResult, KbMoveRequest, KbMoveResult,
  KbPurgeRequest, KbPurgeResult, KbResolveRequest, KbResolveResult, KbRestoreRequest,
  KbRestoreResult, KbSaveRequest, KbSaveResult, KbSearchRequest, KbSearchResult, KbStatsResult,
  KbTagsResult, KbTrashResult,
} from './types.ts'

export type * from './types.ts'

/** Image-serving route prefix under the web server. */
const IMAGE_ROUTE_PREFIX = '/dsh-kb'

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

  constructor(ctx: Context) {
    super(ctx, 'kb')
    const sandboxPolicy = ctx.get('sandboxPolicy') as { workspaceRoot?: string } | undefined
    this.engine = new KbEngine(ctx.fs, sandboxPolicy?.workspaceRoot)
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

  /** List documents with optional status/tag/directory filters. */
  @Remote('list')
  async list(request: KbListRequest, signal: AbortSignal): Promise<KbListResult> {
    signal.throwIfAborted()
    return { docs: await this.engine.list(request, signal) }
  }

  /** 2-gram AND search over title/aliases/tags/summary/body. */
  @Remote('search')
  async search(request: KbSearchRequest, signal: AbortSignal): Promise<KbSearchResult> {
    signal.throwIfAborted()
    const topK = Math.max(1, Math.min(50, Number(request.topK) || 10))
    return await this.engine.search(String(request.query ?? ''), topK, signal)
  }

  /** Full read of one document: body, frontmatter, backlinks, version. */
  @Remote('get')
  async get(request: KbGetRequest, signal: AbortSignal): Promise<KbGetResult> {
    signal.throwIfAborted()
    return await this.engine.get(request, signal)
  }

  /** Available library directories. */
  @Remote('dirs')
  async dirs(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbDirsResult> {
    signal.throwIfAborted()
    return { dirs: await this.engine.dirs(signal) }
  }

  /** Library statistics. */
  @Remote('stats')
  async stats(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbStatsResult> {
    signal.throwIfAborted()
    return await this.engine.stats(signal)
  }

  /** Tag index, most-used first. */
  @Remote('tags')
  async tags(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbTagsResult> {
    signal.throwIfAborted()
    return { tags: await this.engine.tags(signal) }
  }

  /** Apply a field patch + body replacement with an optional optimistic lock. */
  @Remote('saveDoc')
  async saveDoc(request: KbSaveRequest, signal: AbortSignal): Promise<KbSaveResult> {
    signal.throwIfAborted()
    return await this.engine.save(request, signal)
  }

  /** Create a dated document, minting a collision-free path. */
  @Remote('createDoc')
  async createDoc(request: KbCreateRequest, signal: AbortSignal): Promise<KbCreateResult> {
    signal.throwIfAborted()
    return await this.engine.create(request, signal)
  }

  /** Move a document into another directory. */
  @Remote('moveDoc')
  async moveDoc(request: KbMoveRequest, signal: AbortSignal): Promise<KbMoveResult> {
    signal.throwIfAborted()
    return await this.engine.move(request, signal)
  }

  /** Move a document into `.trash` (recoverable). */
  @Remote('deleteDoc')
  async deleteDoc(request: KbDeleteRequest, signal: AbortSignal): Promise<KbDeleteResult> {
    signal.throwIfAborted()
    return await this.engine.remove(request, signal)
  }

  /** List the recoverable trash. */
  @Remote('trash')
  async trash(_request: KbEmptyRequest, signal: AbortSignal): Promise<KbTrashResult> {
    signal.throwIfAborted()
    return await this.engine.trash(signal)
  }

  /** Restore a trashed document into a library directory. */
  @Remote('restoreDoc')
  async restoreDoc(request: KbRestoreRequest, signal: AbortSignal): Promise<KbRestoreResult> {
    signal.throwIfAborted()
    return await this.engine.restore(request, signal)
  }

  /** Permanently clear one trashed document. */
  @Remote('purgeDoc')
  async purgeDoc(request: KbPurgeRequest, signal: AbortSignal): Promise<KbPurgeResult> {
    signal.throwIfAborted()
    return await this.engine.purge(request, signal)
  }

  /** Resolve a `[[name]]` target: exact title/stem, image registry, then fuzzy. */
  @Remote('resolveLink')
  async resolveLink(request: KbResolveRequest, signal: AbortSignal): Promise<KbResolveResult> {
    signal.throwIfAborted()
    return await this.engine.resolve(request, signal)
  }
}

export default KbGateway
