/**
 * The browser half's transport: one `prefix` route serving the snapshot, the
 * command endpoint, the bytes of pasted images, and a Server-Sent Events stream.
 *
 * The route is a thin adapter. It parses JSON at the wire boundary, forwards
 * the call to exactly the method the agent tools call, and serializes the
 * result — there is no second implementation of any board operation here.
 */

import { BoardError, fail } from './model.js'
import { IMAGE_MAX_BYTES } from './images.js'

/** Path prefix the browser half talks to. */
const ROUTE_PREFIX = '/api/requirement-board'

/** Path segment under the prefix that addresses one stored image. */
const IMAGE_PATH = '/image/'

/**
 * Largest accepted JSON command body, in bytes.
 *
 * A binary upload is not a command body: the image route has its own cap
 * ({@link IMAGE_MAX_BYTES}), so this one stays where it is.
 */
const MAX_BODY_BYTES = 256 * 1024

/** HTTP status of each image-route failure; an unlisted board failure stays a 409. */
const IMAGE_ERROR_STATUS = Object.freeze({
  'not-found': 404,
  'invalid-image': 400,
  'unsupported-media-type': 415,
  'image-too-large': 413,
})

/** SSE keep-alive period, in milliseconds. */
const HEARTBEAT_MS = 15_000

/** Reply with a JSON body. */
function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Reply with one stored image's bytes.
 * @param res - Response to write.
 * @param mediaType - The media type the image was stored under.
 * @param bytes - Encoded image bytes.
 */
function sendBytes(res, mediaType, bytes) {
  res.writeHead(200, {
    'content-type': mediaType,
    'cache-control': 'no-store',
    'content-length': bytes.byteLength,
  })
  res.end(bytes)
}

/** Reply with a failure envelope carrying the board's machine code. */
function sendError(res, error) {
  if (error instanceof BoardError) {
    sendJson(res, 409, { ok: false, error: error.toJSON() })
    return
  }
  sendJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
}

/** Read a bounded JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) fail('invalid-argument', `request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    fail('invalid-argument', `request body is not valid JSON: ${error.message}`)
  }
}

/**
 * Read a bounded raw image body.
 *
 * The cap is applied while reading rather than after buffering: an oversized
 * upload is refused without ever being held whole in memory, and the request
 * stream is torn down by the iterator's own early return. Storing enforces the
 * same cap again, because this reader is only one of the service's callers.
 * @param req - Incoming request whose body is the image bytes.
 * @returns the raw bytes.
 */
async function readImageBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > IMAGE_MAX_BYTES) {
      fail('image-too-large', `image upload exceeds ${IMAGE_MAX_BYTES} bytes`, { max: IMAGE_MAX_BYTES })
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Run one image-route operation, replying with that route's own statuses.
 *
 * The command endpoint answers one status for every board failure; an upload or
 * a fetch of bytes carries the ordinary HTTP reason instead — a missing image is
 * a 404 and a refused type or size keeps its own code — so the browser can tell
 * "not there" from "not acceptable". Only a {@link BoardError} is translated; a
 * real failure is left to the route's outer handler.
 * @param res - Response to write.
 * @param run - Operation that writes the successful reply.
 */
async function runImageRoute(res, run) {
  try {
    await run()
  } catch (error) {
    if (!(error instanceof BoardError)) throw error
    sendJson(res, IMAGE_ERROR_STATUS[error.code] ?? 409, { ok: false, error: error.toJSON() })
  }
}

/**
 * Reject a browser request whose Origin is not this loopback server.
 *
 * The web server carries no origin policy of its own; this route owns its own
 * because a cross-site page must not be able to drive the board.
 *
 * @param req - Incoming request.
 * @returns `true` when the request may proceed.
 */
function originAllowed(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    const parsed = new URL(origin)
    return (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1')
      && parsed.protocol === 'http:'
  } catch (error) {
    // An unparsable Origin cannot be shown to be this loopback server, so the
    // request is refused rather than treated as origin-less.
    void error
    return false
  }
}

/** Open the Server-Sent Events stream carrying committed board changes. */
function openEventStream(req, res, service) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': requirement-board connected\n\n')
  res.write(`event: ready\ndata: ${JSON.stringify({ revision: service.snapshot({ limit: 1 }).revision })}\n\n`)
  let closed = false
  const unsubscribe = service.subscribe(event => {
    if (closed) return
    res.write(`event: changed\ndata: ${JSON.stringify(event)}\n\n`)
  })
  const heartbeat = setInterval(() => {
    if (closed) return
    res.write(`: ping ${Date.now()}\n\n`)
  }, HEARTBEAT_MS)
  heartbeat.unref?.()
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  }
  req.on('close', close)
  req.on('error', close)
  res.on('close', close)
}

/** Collect a string field from a query string or a JSON body. */
function pick(source, key) {
  const value = source?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Collect one query-string parameter.
 *
 * A `URLSearchParams` is not an object of its parameters: bracket access returns
 * nothing, so reading the query has to go through `get`. Absent means `undefined`
 * rather than `''`, so the service applies its own defaults.
 * @param url - Parsed request URL.
 * @param key - Parameter name.
 * @returns the parameter value, or undefined when it is absent.
 */
function query(url, key) {
  const value = url.searchParams.get(key)
  return value === null ? undefined : value
}

/**
 * Dispatch one browser command onto the service surface.
 * @param service - The board service.
 * @param body - Parsed command body.
 * @returns the operation's result.
 */
async function dispatch(service, body) {
  const action = pick(body, 'action')
  if (action === undefined) fail('invalid-argument', '"action" is required')
  const actor = { session: pick(body, 'session') ?? '', name: pick(body, 'name') ?? '' }
  // The panel asks "what may this session claim" with `me`; `session` keeps its
  // separate meaning of "requirements shared with this session".
  const me = pick(body, 'me') ?? ''
  const id = pick(body, 'id')
  switch (action) {
    case 'refresh':
      return service.snapshot(body.filter ?? {}, me)
    case 'list':
      return service.listRequirements(body.filter ?? body, me)
    case 'create':
      return await service.createRequirement(body.requirement ?? body, actor)
    case 'update':
      if (id === undefined) fail('invalid-argument', '"id" is required for update')
      return await service.updateRequirement(id, { ...(body.patch ?? {}), expectedRev: body.expectedRev }, actor)
    case 'transition':
      if (id === undefined) fail('invalid-argument', '"id" is required for transition')
      // The browser names the verb `transition`; the agent tool names the same
      // value `transition` too, and both reach the service as `input.action`.
      return await service.transitionRequirement(id, {
        action: body.transition,
        to: body.to,
        note: body.note,
        force: body.force,
        expectedRev: body.expectedRev,
      }, actor)
    case 'checklist':
      if (id === undefined) fail('invalid-argument', '"id" is required for checklist')
      return await service.setChecklist(id, body, actor)
    // The panel releases a lock (its own or a stuck session's) but never claims
    // one: a lock owned by the human's empty session id would refuse every AI
    // session until the lease ran out.
    case 'release':
      if (id === undefined) fail('invalid-argument', '"id" is required for release')
      return await service.release(id, body, actor)
    // The panel clears any session's soft reservation by naming it in
    // `targetSession` — the human taking back work an AI reserved and stopped.
    // It never creates a reservation: queueing is the executing session's own act,
    // and a caller-supplied session must not be able to reserve on anyone's
    // behalf (§5.3).
    case 'unqueue':
      if (id === undefined) fail('invalid-argument', '"id" is required for unqueue')
      return await service.unqueue(id, body, actor)
    // The human delegates to any session, including one without an agent yet, so
    // this command is the panel's: the actor is `''` and the same `session` field
    // names the target. An agent session reaches this action through its tool,
    // where the actor is the calling session and ownership is checked (§5.5).
    case 'delegate':
      if (id === undefined) fail('invalid-argument', '"id" is required for delegate')
      return await service.delegate(id, {
        session: pick(body, 'session'),
        duties: body.duties,
        roleName: body.roleName,
        revoke: body.revoke,
        note: body.note,
        expectedRev: body.expectedRev,
      }, { session: '', name: pick(body, 'name') ?? '' })
    case 'block':
      if (id === undefined) fail('invalid-argument', '"id" is required for block')
      return await service.blockRequirement(id, body, actor)
    case 'unblock':
      if (id === undefined) fail('invalid-argument', '"id" is required for unblock')
      return await service.unblockRequirement(id, body, actor)
    case 'archive':
      if (id === undefined) fail('invalid-argument', '"id" is required for archive')
      return await service.setArchived(id, { ...body, archived: true }, actor)
    case 'restore':
      if (id === undefined) fail('invalid-argument', '"id" is required for restore')
      return await service.setArchived(id, { ...body, archived: false }, actor)
    case 'delete':
      if (id === undefined) fail('invalid-argument', '"id" is required for delete')
      return await service.deleteRequirement(id, body, actor)
    case 'template.create':
      return await service.createTemplate(body.template ?? body, actor)
    case 'template.get':
      if (id === undefined) fail('invalid-argument', '"id" is required for template.get')
      return service.getTemplate(id)
    case 'template.revise':
      if (id === undefined) fail('invalid-argument', '"id" is required for template.revise')
      return await service.reviseTemplate(id, body.patch ?? body, actor)
    case 'template.metadata':
      if (id === undefined) fail('invalid-argument', '"id" is required for template.metadata')
      return await service.setTemplateMetadata(id, body.patch ?? body, actor)
    case 'template.migrate':
      if (id === undefined) fail('invalid-argument', '"id" is required for template.migrate')
      return await service.migrateRequirementsToRevision(id, body.revision, { requirementIds: body.requirementIds }, actor, body.force)
    // Pruning a version is panel-only (§11.5): it is housekeeping rather than flow
    // authorship, so the model's tool surface has no action for it.
    case 'template.prune':
      if (id === undefined) fail('invalid-argument', '"id" is required for template.prune')
      return await service.pruneTemplateVersion(id, body.revision, actor)
    case 'template.archive':
      if (id === undefined) fail('invalid-argument', '"id" is required for template.archive')
      return await service.archiveTemplate(id, { archived: body.archived }, actor)
    case 'template.clone':
      if (id === undefined) fail('invalid-argument', '"id" is required for template.clone')
      return await service.cloneTemplate(id, { name: body.name }, actor)
    case 'template.delete':
      if (id === undefined) fail('invalid-argument', '"id" is required for template.delete')
      return await service.deleteTemplate(id, body, actor)
    case 'template.list':
      return service.listTemplates({ includeArchived: body.includeArchived })
    // Role management is panel-only: the model's `requirement_role` tool reads
    // roles and has no create, edit, or delete action. The panel's listing also
    // carries the live preset roster, which is the only place the two are tied
    // together for a reader.
    case 'role.list':
      return await service.listRoleCatalogue()
    case 'role.put':
      return await service.putRole(body.role ?? body)
    case 'role.delete':
      if (id === undefined) fail('invalid-argument', '"id" is required for role.delete')
      return await service.deleteRole(id)
    case 'stats':
      return service.stats()
    case 'changes':
      return service.changesSince(pick(body, 'since'))
    default:
      fail('invalid-argument', `unknown action "${action}"`)
  }
}

/**
 * Create the route handler bound to one board service.
 *
 * Requests are fenced by the platform's own API-request trust judgement when the
 * composition exposes it: `connection.requestRejection(request)` takes the
 * request facts (its `headers`, which carry `Host`, `Origin`, and the fetch
 * metadata) and answers `401` for a caller with no valid credential and `403` for
 * one whose origin is not trusted, and this route refuses either with that status.
 * A board mounted without a connection service keeps the loopback `Origin` check
 * below, which is the same fence narrowed to what a plugin can see on its own.
 * @param service - The board service.
 * @param connectionOf - Resolver for the `connection` service, or undefined when
 * the composition has none.
 * @returns the `webServer.register` handler.
 */
export function createBoardHandler(service, connectionOf) {
  return async function handleBoardRequest(req, res) {
    const connection = typeof connectionOf === 'function' ? connectionOf() : undefined
    if (typeof connection?.requestRejection === 'function') {
      // The judgement reads the request's own facts, so it is given the request
      // rather than its header bag: passing the bag makes the Host fence read
      // `undefined` and refuse — or throw — every call, the panel included.
      const rejected = connection.requestRejection(req)
      if (rejected === 401 || rejected === 403) {
        sendJson(res, rejected, {
          ok: false,
          error: {
            code: rejected === 401 ? 'unauthenticated' : 'forbidden-origin',
            message: rejected === 401
              ? 'this request carries no valid session credential for the board API'
              : 'cross-origin requests are not accepted',
          },
        })
        return
      }
    } else if (!originAllowed(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden-origin', message: 'cross-origin requests are not accepted' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && (path === '/snapshot' || path === '/')) {
        const filter = {
          session: query(url, 'session'),
          owner: query(url, 'owner'),
          status: query(url, 'status'),
          priority: query(url, 'priority'),
          kind: query(url, 'kind'),
          role: query(url, 'role'),
          templateId: query(url, 'templateId'),
          query: query(url, 'query'),
          claimable: query(url, 'claimable'),
          limit: query(url, 'limit'),
          offset: query(url, 'offset'),
        }
        sendJson(res, 200, { ok: true, data: service.snapshot(compact(filter), query(url, 'me') ?? '') })
        return
      }
      if (req.method === 'GET' && path === '/events') {
        openEventStream(req, res, service)
        return
      }
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, 200, { ok: true, data: { revision: service.snapshot({ limit: 1 }).revision } })
        return
      }
      if (req.method === 'POST' && path === '/command') {
        const body = await readJsonBody(req)
        sendJson(res, 200, { ok: true, data: await dispatch(service, body) })
        return
      }
      // One pasted image. The raw body *is* the image, so nothing here parses or
      // re-encodes it: the record later carries the ref, never the bytes.
      if (req.method === 'POST' && path === '/image') {
        await runImageRoute(res, async () => {
          const bytes = await readImageBody(req)
          const image = await service.storeImage({
            bytes,
            mediaType: req.headers['content-type'],
            name: query(url, 'name'),
          })
          sendJson(res, 200, { ok: true, data: { image } })
        })
        return
      }
      if (req.method === 'GET' && path.startsWith(IMAGE_PATH)) {
        await runImageRoute(res, async () => {
          const stored = await service.readImage(path.slice(IMAGE_PATH.length))
          sendBytes(res, stored.mediaType, stored.bytes)
        })
        return
      }
      if (req.method !== 'GET' && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `${req.method} is not supported` } })
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `no requirement board endpoint at ${path}` } })
    } catch (error) {
      sendError(res, error)
    }
  }
}

/** Drop absent filter fields so the service applies its own defaults. */
function compact(filter) {
  const out = {}
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

/**
 * Register the board route on the web server.
 * @param webServer - The `webServer` service.
 * @param service - The board service.
 * @param connectionOf - Resolver for the `connection` service; the platform trust
 * judgement is preferred over the loopback `Origin` check when it is present.
 * @returns the route disposer.
 */
export function registerBoardRoute(webServer, service, connectionOf) {
  return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createBoardHandler(service, connectionOf) })
}

/**
 * The board route one stored image is read from.
 *
 * The ref a record carries names an id, not a location: this builds the location
 * for the callers that need one, so the tool results and the README cannot drift
 * from the route the transport actually serves.
 * @param id - Image id.
 * @returns the route path serving that image's bytes.
 */
export function imageUrl(id) {
  return `${ROUTE_PREFIX}${IMAGE_PATH}${id}`
}

/** List the endpoints this route serves, for the README and diagnostics. */
export const ENDPOINTS = Object.freeze([
  `GET  ${ROUTE_PREFIX}/snapshot`,
  `GET  ${ROUTE_PREFIX}/events`,
  `GET  ${ROUTE_PREFIX}/health`,
  `POST ${ROUTE_PREFIX}/command`,
  `POST ${ROUTE_PREFIX}/image`,
  `GET  ${ROUTE_PREFIX}/image/<id>`,
])

/** Exported for tests that drive the command dispatcher directly. */
export { dispatch as dispatchBoardCommand }
