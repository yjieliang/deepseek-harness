/**
 * Test support for the Host half: drive the board's real storage path — a
 * `DomainFacility` over a real backend adapter — without booting a Cordis
 * runtime.
 *
 * The plugin itself owns `ctx.storageDomain`; here a minimal context supplies
 * the only things `DomainFacility` reads: the backend registry, a logger, and
 * the `emit` that carries `domain/changed`. Every case runs against each backend
 * in {@link BACKENDS} so the durable behaviour is not accidentally tied to one
 * medium.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { bootstrapRequirementBoard, openBoardDomain, requirementBoardDomain } from '../host/domain.js'
import { registerBoardRoute } from '../host/http.js'
import { RequirementService } from '../host/service.js'
import { resolveConfig } from '../host/config.js'

/** Backends every domain case runs against. */
export const BACKENDS = ['json', 'sqlite']

/** Create a temporary directory to hold one board medium. */
export async function makeTempDir(prefix = 'requirement-board-') {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** Remove a directory created by {@link makeTempDir}. */
export async function removeTempDir(dir) {
  await rm(dir, { recursive: true, force: true })
}

/** The file one backend writes for the board unit, inside `dir`. */
export function mediumPath(backend, dir) {
  return backend === 'sqlite' ? join(dir, 'board.db') : join(dir, `${requirementBoardDomain.name}.json`)
}

/** One 24-bit little-endian value, as the WebP canvas size is encoded. */
function uint24le(value) {
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff])
}

/**
 * One encoded image of a given size, built header-first.
 *
 * The board stores bytes verbatim and reads only a header to record how large the
 * picture is, so a case needs encoded bytes that carry the container's own size
 * fields — not bytes a decoder would accept. Each accepted media type gets a
 * builder here so every case drives the same fixture.
 * @param mediaType - `image/png`, `image/jpeg`, `image/webp`, or `image/gif`.
 * @param width - Intrinsic width to encode.
 * @param height - Intrinsic height to encode.
 * @returns the encoded bytes.
 */
export function imageFixture(mediaType, width, height) {
  if (mediaType === 'image/png') {
    const png = Buffer.alloc(33)
    png.writeUInt32BE(0x89504e47, 0)
    png.writeUInt32BE(0x0d0a1a0a, 4)
    png.writeUInt32BE(13, 8)
    png.write('IHDR', 12, 'latin1')
    png.writeUInt32BE(width, 16)
    png.writeUInt32BE(height, 20)
    png[24] = 8
    png[25] = 6
    return png
  }
  if (mediaType === 'image/gif') {
    const gif = Buffer.alloc(14)
    gif.write('GIF89a', 0, 'latin1')
    gif.writeUInt16LE(width, 6)
    gif.writeUInt16LE(height, 8)
    gif[13] = 0x3b
    return gif
  }
  if (mediaType === 'image/jpeg') {
    const jpeg = Buffer.alloc(22)
    jpeg[0] = 0xff
    jpeg[1] = 0xd8
    jpeg[2] = 0xff
    jpeg[3] = 0xc0
    jpeg.writeUInt16BE(17, 4)
    jpeg[6] = 8
    jpeg.writeUInt16BE(height, 7)
    jpeg.writeUInt16BE(width, 9)
    jpeg[20] = 0xff
    jpeg[21] = 0xd9
    return jpeg
  }
  if (mediaType === 'image/webp') {
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'latin1')
    webp.writeUInt32LE(22, 4)
    webp.write('WEBP', 8, 'latin1')
    webp.write('VP8X', 12, 'latin1')
    webp.writeUInt32LE(10, 16)
    uint24le(width - 1).copy(webp, 24)
    uint24le(height - 1).copy(webp, 27)
    return webp
  }
  throw new Error(`imageFixture has no builder for "${mediaType}"`)
}

/** Assertion helper shared by the Host suites; prints one line per check. */
export function createReporter() {
  let checks = 0
  let failures = 0
  return {
    /** Assert a condition and record the outcome. */
    check(label, condition, detail = '') {
      checks += 1
      if (condition) {
        console.log(`  ok   ${label}`)
        return
      }
      failures += 1
      console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
    },
    /** Assert that a call rejects with a specific machine code. */
    async rejects(label, operation, code) {
      checks += 1
      let returned
      try {
        returned = await operation()
      } catch (error) {
        if (error?.code === code) {
          console.log(`  ok   ${label} (${code})`)
          return error
        }
        failures += 1
        console.log(`  FAIL ${label} — expected ${code}, received ${error?.code ?? error?.message}`)
        return error
      }
      failures += 1
      console.log(`  FAIL ${label} — expected ${code}, call resolved with ${JSON.stringify(returned)?.slice(0, 120)}`)
      return undefined
    },
    /** Print the summary and report whether every check passed. */
    finish() {
      console.log(`\n${checks - failures}/${checks} checks passed`)
      return failures === 0
    },
  }
}

/**
 * Construct the backend adapter for one medium.
 *
 * The sqlite adapter is imported on use: a static import reaches Node's built-in
 * sqlite from every suite, including the json-only runs, and puts
 * `ExperimentalWarning: SQLite` on their stderr where it masks real warnings.
 * @param backend - Backend name from {@link BACKENDS}.
 * @param dir - Directory holding the medium.
 * @returns the named adapter.
 */
async function createMedium(backend, dir) {
  if (backend === 'sqlite') {
    const { SqliteStorageBackend } = await import('@deepseek-ai/dsh-storage-sqlite')
    return { name: 'sqlite', impl: new SqliteStorageBackend({ path: mediumPath('sqlite', dir), journalMode: 'wal' }) }
  }
  return { name: 'json', impl: new JsonStorageBackend(dir) }
}

/** The minimal context `DomainFacility` reads, plus the changes it emitted. */
function createContext(medium) {
  const changes = []
  const ctx = {
    storage: {
      backend: {
        get: requested => {
          if (requested !== medium.name) throw new Error(`the test context has no backend "${requested}"`)
          return medium.impl
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    emit: (event, change) => {
      if (event === 'domain/changed') changes.push(change)
    },
  }
  return { ctx, changes }
}

/**
 * Open the board domain on a fresh facility, releasing the medium if it fails.
 *
 * The open goes through `openBoardDomain`, the plugin's own open step, so a case
 * that seeds an unreadable record sees the error an operator would: the same
 * message and `detail`, without reaching into `cause`.
 */
async function openDomain(medium) {
  const { ctx, changes } = createContext(medium)
  const facility = new DomainFacility(ctx, { backend: medium.name, routes: {} })
  try {
    const domain = await openBoardDomain({ open: name => facility.open(name) })
    return {
      domain,
      facility,
      changes,
      backend: medium.name,
      close: async () => {
        await domain.close()
        await medium.impl.close()
      },
    }
  } catch (error) {
    await medium.impl.close()
    throw error
  }
}

/**
 * Open one board domain without bootstrapping it.
 *
 * The cases that need to seed the medium first — a corrupt record, a trailing
 * revision — drive bootstrap themselves and only then let the plugin's own path
 * observe the medium.
 * @param options - `backend` and the medium directory `dir`.
 * @returns the open handle plus the emitted `domain/changed` records.
 */
export async function openRawBoard({ backend = 'json', dir } = {}) {
  return await openDomain(await createMedium(backend, dir))
}

/**
 * Open the board the way the plugin does: open, bootstrap, then build the service.
 * @param options - `backend`, `dir`, the bootstrap switches
 * `importLegacy`/`legacyPath`, the resolved `config`, the service `ports`
 * (each a `() => service | undefined` resolver), and a recording `logger`.
 * @returns the open handle, the built service, the healed revision, and the
 * logger that captured the bootstrap's reports.
 */
export async function openBoard({ backend = 'json', dir, importLegacy = false, legacyPath, config, ports, logger } = {}) {
  const medium = await createMedium(backend, dir)
  const opened = await openDomain(medium)
  const recorded = logger ?? createRecordingLogger()
  let revision
  try {
    revision = await bootstrapRequirementBoard(opened.domain, { importLegacy, legacyPath, logger: recorded })
  } catch (error) {
    await opened.close()
    throw error
  }
  const service = new RequirementService({ domain: opened.domain, config: config ?? resolveConfig({}), ports: ports ?? {}, logger: recorded })
  return { ...opened, service, revision, logger: recorded }
}

/** A logger that keeps every reported line, so a case can assert what was said. */
export function createRecordingLogger() {
  const lines = { info: [], warn: [], error: [] }
  return {
    lines,
    info: message => { lines.info.push(String(message)) },
    warn: message => { lines.warn.push(String(message)) },
    error: message => { lines.error.push(String(message)) },
  }
}

/** Build a board service over any open domain, with the default resolved config. */
export function boardService(domain, config = resolveConfig({}), ports = {}) {
  return new RequirementService({ domain, config, ports })
}

/** Whether a path exists; the suites read this for the renamed legacy document. */
export function pathExists(path) {
  return existsSync(path)
}

/**
 * Drive the registered board route handler with one request.
 *
 * The route is mounted on a stub `webServer`, so no listener, auth layer, or
 * socket is involved, and the request body is an async iterable exactly as an
 * HTTP request is — which is what the raw image upload path reads.
 * @param service - The board service.
 * @param options - `method`; `target`, the path after the route prefix with its
 * query string; `headers`; and `body`, bytes or a chunk list.
 * @returns `{ status, contentType, bytes, json }`; `json` is the parsed body when
 * it is JSON, else `null`.
 */
export async function requestBoardRoute(service, { method = 'GET', target = '/', headers = {}, body = [] } = {}) {
  let handler
  registerBoardRoute({ register: entry => { handler = entry.handler; return () => {} } }, service)
  const chunks = []
  const res = {
    statusCode: 0,
    contentType: '',
    setHeader() {},
    writeHead(status, outgoing = {}) {
      res.statusCode = status
      res.contentType = outgoing['content-type'] ?? res.contentType
    },
    on() {},
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    },
  }
  const list = Buffer.isBuffer(body) ? [body] : body
  const req = {
    method,
    url: `/api/requirement-board${target}`,
    headers,
    on() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of list) yield chunk
    },
  }
  await handler(req, res)
  const bytes = Buffer.concat(chunks)
  const text = bytes.toString('utf8')
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // A binary reply is not JSON; `bytes` is what the case reads.
    json = null
  }
  return { status: res.statusCode, contentType: res.contentType, bytes, json }
}

/**
 * The minimal plugin context for driving `apply` directly.
 *
 * `inject` throws: reaching it proves activation continued past the storage
 * step, which is exactly what a failed mount must not do.
 * @param storageDomain - The `ctx.storageDomain` the plugin would receive.
 * @returns the context plus the registrations it recorded.
 */
export function createApplyContext(storageDomain) {
  const effects = []
  const listeners = []
  const ctx = {
    storageDomain,
    logger: { info() {}, warn() {}, error() {} },
    effect: (execute, label = 'anonymous') => {
      effects.push(label)
      const disposer = execute()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: (event, handler) => {
      listeners.push({ event, handler })
      return () => {}
    },
    inject: deps => {
      throw new Error(`apply reached ctx.inject(${deps.join(', ')})`)
    },
  }
  return { ctx, effects, listeners }
}

/**
 * The minimal plugin context for mounting the whole plugin.
 *
 * Unlike {@link createApplyContext} this one lets activation run to the end: it
 * answers `ctx.get` with the caller's fakes, records every event listener, tool
 * registration, and injected service, and invokes each `ctx.inject` callback
 * with a child context whose `systemPrompt.context` and `webServer.register`
 * only record their arguments. That is how a case reads the prompt text and the
 * tools the plugin actually registered without booting Cordis.
 *
 * @param options - `storageDomain`, a `get(name)` resolver for optional
 * services, and an optional recording `logger`.
 * @returns the context, everything it recorded, and `dispatch(event, payload)`
 * to drive a registered listener.
 */
export function createMountContext({ storageDomain, get, logger } = {}) {
  const logs = logger ?? createRecordingLogger()
  const records = { effects: [], listeners: [], injections: [], tools: [], promptContexts: [], routes: [] }
  const register = (execute, label = 'anonymous') => {
    records.effects.push(label)
    const disposer = execute()
    return typeof disposer === 'function' ? disposer : () => {}
  }
  const ctx = {
    storageDomain,
    logger: logs,
    get: name => (typeof get === 'function' ? get(name) : undefined),
    effect: register,
    on: (event, handler) => {
      records.listeners.push({ event, handler })
      return () => {}
    },
    inject: (deps, callback) => {
      records.injections.push(deps.join(','))
      callback({
        effect: register,
        systemPrompt: {
          context: spec => {
            records.promptContexts.push(spec)
            return () => {}
          },
        },
        webServer: {
          register: spec => {
            records.routes.push(spec)
            return () => {}
          },
        },
      })
      return () => {}
    },
    tools: {
      register: spec => {
        records.tools.push(spec)
        return () => {}
      },
    },
  }
  return {
    ctx,
    records,
    logger: logs,
    dispatch: (event, payload) => {
      const results = []
      for (const listener of records.listeners) {
        if (listener.event === event) results.push(listener.handler(payload))
      }
      return results
    },
  }
}
