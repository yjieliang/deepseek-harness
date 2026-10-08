#!/usr/bin/env node
/**
 * Stage E through the **real composition** (`index.js`), by a member other than
 * the author: the browser route's trust door, the request-fact shape the door is
 * given, the assembled prompt sections, and the fiber disposal that must end
 * every registration stage E adds.
 *
 * Usage (from the repository root):
 *   TSX_TSCONFIG_PATH=<repo>/tsconfig.json node --import tsx/esm \
 *     .artifacts/requirement-board/tests/verification/e-composition.mjs
 *   RB_E_INDEX=./_red-e-http/index.js    # composition root under test
 *
 * Temporary storage roots only; no session is created, no socket is opened, and
 * nothing under `~/.dsh` is written.
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '../../../../packages/storage/storage/src/index.ts'
import * as StorageJson from '../../../../packages/storage/storage-json/src/index.ts'
import * as StorageDomain from '../../../../packages/storage/storage-domain/src/index.ts'
import Tools from '../../../../packages/core/tools/src/index.ts'
import SystemPrompt, { renderContextSections } from '../../../../packages/core/system-prompt/src/index.ts'
import * as role from '../../role.js'

const ROOT = process.env.RB_E_INDEX ?? '../../index.js'
const board = await import(ROOT)

const DECLARATION = { roleId: 'art', roleName: '美术', duties: ['美术资产'] }
const TEMPLATE = 'tpl-e-compose'
const PARENT = { id: 'sess_e_parent', name: '甲', status: 'idle', ctx: { presetId: 'art' } }
const CHILD = { id: 'sess_e_child', name: '子', status: 'idle', ctx: { presetId: 'art' } }
const ROSTER = [PARENT, CHILD]

let checks = 0
let failures = 0
const failed = []

/** Assert one condition and record the outcome. */
function check(label, ok, detail = '') {
  checks += 1
  if (ok) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures += 1
  failed.push(label)
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  return false
}
/** Record a fact rather than assert it. */
function note(text) {
  console.log(`  note ${text}`)
}
/** Run one operation, capturing its rejection. */
async function attempt(operation) {
  try {
    return { value: await operation(), error: null }
  } catch (error) {
    return { value: undefined, error }
  }
}

/* ------------------------------------------------- complex service stubs */

/** A function plugin that publishes one service. */
function providerPlugin(pluginName, serviceName, build) {
  return {
    name: pluginName,
    inject: [],
    apply(ctx) {
      return ctx.provide(serviceName, build())
    },
  }
}

/** The preset stub: the declared preset resolves for the declared role id. */
function presetsPlugin() {
  return {
    name: 'e-verify-presets-stub',
    inject: [],
    apply(ctx) {
      ctx.provide('agentPresets', {
        serviceFor(agent, key) {
          if (key !== 'requirementBoardRole') return undefined
          const declared = ctx.get('requirementBoardRole')
          if (declared === undefined) return undefined
          return agent?.ctx?.presetId === DECLARATION.roleId ? declared : undefined
        },
        composedPreset: target => (typeof target?.presetId === 'string' ? target.presetId : undefined),
      })
    },
  }
}

/** The registry the lock/ownership predicates read. */
function platformRegistry(agents) {
  const store = new Map(agents.map(agent => [agent.id, agent]))
  return {
    get: id => store.get(id),
    list: () => [...store.values()],
    isOwnedBy: (id, owner) => store.get(id)?.owner === owner,
  }
}

/** The job registry stub, with the one subscription the plugin takes. */
function jobsStub() {
  const subscribers = []
  return {
    subscribers,
    list: () => [],
    events: {
      subscribe: (options, listener) => {
        subscribers.push({ options, listener })
        return () => {
          const index = subscribers.findIndex(entry => entry.listener === listener)
          if (index !== -1) subscribers.splice(index, 1)
        }
      },
    },
  }
}

/** The web server stub: records the route spec and hands back a disposer. */
function webServerStub(record) {
  return {
    name: 'e-verify-web-server-stub',
    inject: [],
    apply(ctx) {
      ctx.provide('webServer', {
        register(spec) {
          record.specs.push(spec)
          return () => record.disposed.push(spec.path)
        },
      })
    },
  }
}

const TOKENS = new Set(['e-token-a', 'e-token-b'])
const TRUSTED_ORIGINS = new Set(['http://127.0.0.1:3080', 'http://localhost:3080'])

/**
 * The `connection` stub: the platform's request-trust judgement, reduced to the
 * facts this route must hand it. It is deliberately strict about receiving a
 * *request*: a header bag (no `.headers` of its own) answers `400`, which the
 * route does not treat as a rejection — so a regression to `req.headers` shows
 * up as the wrong status instead of silently passing.
 */
function connectionStub(record) {
  return {
    name: 'e-verify-connection-stub',
    inject: [],
    apply(ctx) {
      ctx.provide('connection', {
        requestRejection(request) {
          record.calls.push(request)
          if (request === null || typeof request !== 'object' || typeof request.headers !== 'object' || typeof request.url !== 'string') {
            record.wrongShape += 1
            return 400
          }
          const cookie = String(request.headers.cookie ?? '')
          const token = /(?:^|;\s*)dsh_session=([^;]*)/.exec(cookie)?.[1] ?? ''
          if (token === '' || !TOKENS.has(token)) return 401
          const origin = request.headers.origin
          if (origin !== undefined && !TRUSTED_ORIGINS.has(origin)) return 403
          return undefined
        },
      })
    },
  }
}

/* ------------------------------------------------------------ HTTP fakes */

/** A request as `createBoardHandler` reads it: url, method, headers, async body. */
function fakeRequest({ method = 'GET', url = '/api/requirement-board/snapshot', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A response that records the status, headers, body, and whether it ended. */
function fakeResponse() {
  const state = { status: 0, headers: undefined, body: '', ended: false }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    setHeader() {},
    flushHeaders() {},
    write(chunk) {
      state.body += String(chunk)
    },
    end(chunk) {
      if (chunk !== undefined) state.body += String(chunk)
      state.ended = true
    },
    on() {},
  }
}

/* --------------------------------------------------------- board helpers */

/** Mount the real board on the real storage stack with the stubs above. */
async function mountBoard(root, { withConnection = true, config = {} } = {}) {
  const ctx = new Context()
  const route = { specs: [], disposed: [] }
  const connection = { calls: [], wrongShape: 0 }
  const jobs = jobsStub()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json', routes: { requirement_board: 'json' } })
  await ctx.plugin(Tools)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(providerPlugin('e-verify-agents-stub', 'agents', () => platformRegistry(ROSTER)))
  await ctx.plugin(providerPlugin('e-verify-jobs-stub', 'jobs', () => jobs))
  await ctx.plugin(webServerStub(route))
  if (withConnection) await ctx.plugin(connectionStub(connection))
  const realm = ctx.isolate('requirementBoardRole')
  const declared = realm.plugin(role, DECLARATION)
  await declared.await()
  await realm.plugin(presetsPlugin())
  const mounted = ctx.plugin(board, {
    defaultTemplateId: 'tpl-standard',
    stallAfterHours: 72,
    promptContext: true,
    promptMaxItems: 12,
    http: true,
    executionSync: true,
    sseCoalesceMs: 0,
    importLegacy: false,
    ...config,
  })
  await mounted.await()
  return { ctx, route, connection, root, jobs }
}

/** Drive one tool call; `agent` is the model's session, absent for the panel. */
async function callNamed(ctx, name, args, agent, callId) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId,
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
  const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
  return { isError: Boolean(result.isError), text }
}
const callTool = (ctx, args, agent, callId) => callNamed(ctx, 'requirement_board', args, agent, callId)

/** Create one requirement through the tool and hand back its id. */
async function createViaTool(ctx, agent, callId, args) {
  const result = await callTool(ctx, { action: 'create', templateId: TEMPLATE, ...args }, agent, callId)
  return result.isError ? { error: result.text, id: null } : { error: null, id: JSON.parse(result.text).id }
}

/** The `get` result as an object, or `null` when the tool refused. */
async function getRecord(ctx, id, agent, callId) {
  const result = await callTool(ctx, { action: 'get', id }, agent, callId)
  return result.isError ? null : JSON.parse(result.text)
}

/** One route call through the handler the mount registered. */
async function callHttp(board, { method = 'GET', path = '/snapshot', query = '', headers = {}, body, handler } = {}) {
  const target = handler ?? board.route.specs[0]?.handler
  const request = fakeRequest({ method, url: `/api/requirement-board${path}${query}`, headers, body })
  const response = fakeResponse()
  await target(request, response)
  let json
  try {
    json = JSON.parse(response.state.body)
  } catch {
    json = undefined
  }
  return { status: response.state.status, body: response.state.body, json, request }
}

const COOKIE = 'dsh_session=e-token-a'
const HOST = { host: '127.0.0.1:3080' }

/** The board's runtime-context text for one session, as the model receives it. */
async function contextText(ctx, agent) {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) return ''
  const assembly = await systemPrompt.assemble({ scope: agent })
  return (renderContextSections(assembly).find(section => section.name === 'requirement-board')?.text) ?? ''
}

const PROMPT_SECTIONS = ['Delegated to you', 'Claimable for you', 'Your queue', 'Executing now', 'Waiting on the human']

/** The text of one prompt section, cut at the next section header. */
function promptSection(text, title) {
  const start = text.indexOf(`${title} (`)
  if (start === -1) return ''
  const rest = text.slice(start)
  const cuts = PROMPT_SECTIONS.filter(name => name !== title)
    .map(name => rest.indexOf(`${name} (`, 1))
    .filter(index => index > 0)
  return cuts.length === 0 ? rest : rest.slice(0, Math.min(...cuts))
}

/** The medium bytes, so a no-write claim can be byte-exact. */
const mediumBytes = root => readFile(join(root, 'requirement_board.json'))

/* ------------------------------------------------------------------ phase */

console.log(`E through the real composition (root: ${ROOT})`)
const root = await mkdtemp(join(tmpdir(), 'e-compose-'))
let mounted = await mountBoard(root)
let taskId = null
let decisionId = null
try {
  /* [0] the mount registers the route, the prompt context, the listeners, tools. */
  console.log('\n[0] what the mount registered')
  const routeSpec = mounted.route.specs[0]
  check('the browser route is registered once', mounted.route.specs.length === 1, `${mounted.route.specs.length}`)
  check('the route is a prefix route on the documented path', routeSpec?.kind === 'prefix' && routeSpec?.path === '/api/requirement-board', JSON.stringify({ kind: routeSpec?.kind, path: routeSpec?.path }))
  check('the route carries a handler', typeof routeSpec?.handler === 'function', typeof routeSpec?.handler)
  const madeTemplate = await callNamed(mounted.ctx, 'flow_template', {
    action: 'create',
    id: TEMPLATE,
    name: '验证流程',
    nodes: [{ id: 'n1', name: '一' }, { id: 'n2', name: '二' }, { id: 'n3', name: '三' }],
  }, PARENT, 'e-template')
  check('the flow template tool is registered', !madeTemplate.isError, madeTemplate.text.slice(0, 160))

  /* [1] the trust door. */
  console.log('\n[1] the trust door in front of every route path')
  const noCookie = await callHttp(mounted, { headers: { ...HOST } })
  check('a request with no credential is refused 401', noCookie.status === 401 && noCookie.json?.error?.code === 'unauthenticated', `${noCookie.status} ${noCookie.body.slice(0, 120)}`)
  const crossOrigin = await callHttp(mounted, { headers: { ...HOST, origin: 'http://evil.test', cookie: COOKIE } })
  check('a credentialed cross-origin request is refused 403', crossOrigin.status === 403 && crossOrigin.json?.error?.code === 'forbidden-origin', `${crossOrigin.status} ${crossOrigin.body.slice(0, 120)}`)
  const good = await callHttp(mounted, { headers: { ...HOST, cookie: COOKIE } })
  check('a credentialed loopback request is served 200', good.status === 200 && good.json?.ok === true, `${good.status} ${good.body.slice(0, 120)}`)
  const trustedOrigin = await callHttp(mounted, { headers: { ...HOST, cookie: COOKIE, origin: 'http://127.0.0.1:3080' } })
  check('a trusted origin is served', trustedOrigin.status === 200, `${trustedOrigin.status}`)
  const health = await callHttp(mounted, { path: '/health', headers: { ...HOST, cookie: COOKIE } })
  check('the door also fences the health path', health.status === 200, `${health.status}`)
  check('the door fences the events path too', (await callHttp(mounted, { path: '/events', headers: { ...HOST } })).status === 401, 'not 401')

  /* [2] bypass attempts stay refused, and the door is handed the request itself. */
  console.log('\n[2] bypass attempts')
  const attempts = [
    ['only an Origin header', { origin: 'http://127.0.0.1:3080' }, 401],
    ['only a Host header', { host: '127.0.0.1:3080' }, 401],
    ['a token in the query string only', { ...HOST }, 401, '?token=e-token-a'],
    ['an empty cookie value', { ...HOST, cookie: 'dsh_session=' }, 401],
    ['a forged cookie value', { ...HOST, cookie: 'dsh_session=forged' }, 401],
    ['an expired cookie value', { ...HOST, cookie: 'dsh_session=e-token-expired' }, 401],
    ['another user\'s valid credential', { ...HOST, cookie: 'dsh_session=e-token-b' }, 200],
    ['a valid credential with an untrusted origin', { ...HOST, cookie: COOKIE, origin: 'http://evil.test' }, 403],
  ]
  const callsBeforeAttempts = mounted.connection.calls.length
  for (const [label, headers, expected, query = ''] of attempts) {
    const result = await callHttp(mounted, { headers, query })
    check(`${label} answers ${expected}`, result.status === expected, `${result.status} ${result.body.slice(0, 100)}`)
  }
  const seen = mounted.connection.calls
  check('the door was handed the request object once per attempt', seen.length - callsBeforeAttempts === attempts.length, `${seen.length - callsBeforeAttempts} of ${attempts.length}`)
  check('the door saw the request for every call in this phase', seen.slice(callsBeforeAttempts).every(request => request !== null && typeof request === 'object' && typeof request.url === 'string' && typeof request.headers === 'object'), 'a header bag was passed')
  check('the door never saw a wrong-shaped argument', mounted.connection.wrongShape === 0, `wrongShape=${mounted.connection.wrongShape}`)
  const identity = await callHttp(mounted, { headers: { ...HOST, cookie: COOKIE } })
  check('the argument is the very request the handler received', identity.request === seen.at(-1), 'the door was given a copy or a bag')
  const stub = mounted.connection
  note(`the stub itself: a request answers ${String(stub.calls.at(-2)?.headers?.cookie ?? '')}, a header bag answers 400, and the route ignores 400`)
  check('the stub treats a request fact object as a request', (() => {
    const probe = mounted.ctx.get('connection')
    return probe.requestRejection({ url: '/x', headers: { cookie: COOKIE } }) === undefined
  })(), 'a request was refused')
  check('the stub treats a bare header bag as the wrong shape (400)', (() => {
    const probe = mounted.ctx.get('connection')
    const before = mounted.connection.wrongShape
    const answer = probe.requestRejection({ cookie: COOKIE })
    const counted = mounted.connection.wrongShape === before + 1
    mounted.connection.wrongShape = before
    return answer === 400 && counted
  })(), 'a header bag was not caught')

  /* [3] the role filter and the reservation flag through the route. */
  console.log('\n[3] the query filters through the route')
  const one = await createViaTool(mounted.ctx, PARENT, 'e-role-1', { title: '角色一', role: 'role-e1' })
  const two = await createViaTool(mounted.ctx, PARENT, 'e-role-2', { title: '角色二', role: 'role-e2' })
  const three = await createViaTool(mounted.ctx, PARENT, 'e-role-3', { title: '无角色' })
  taskId = one.id
  const byRole = await callHttp(mounted, { query: '?role=role-e1', headers: { ...HOST, cookie: COOKIE } })
  check('?role= returns exactly its set through the route', JSON.stringify(byRole.json?.data?.requirements?.map(item => item.id) ?? []) === JSON.stringify([one.id]), JSON.stringify(byRole.json?.data?.requirements?.map(item => item.id)))
  const unknownRole = await callHttp(mounted, { query: '?role=role-nope', headers: { ...HOST, cookie: COOKIE } })
  check('an unknown role is an empty set through the route', unknownRole.status === 200 && (unknownRole.json?.data?.requirements ?? [null]).length === 0, `${unknownRole.status} ${unknownRole.body.slice(0, 120)}`)
  const claimable = await callHttp(mounted, { query: '?claimable=true&me=sess_e_child', headers: { ...HOST, cookie: COOKIE } })
  const claimableIds = claimable.json?.data?.requirements?.map(item => item.id) ?? []
  check('claimable without a role names the role-free work for that session', (claimable.json?.data?.requirements ?? []).length > 0, claimable.body.slice(0, 160))
  const routed = await createViaTool(mounted.ctx, PARENT, 'e-role-mine', { title: '给我的角色', role: 'art' })
  const mine = (await callHttp(mounted, { query: '?role=art&claimable=true&me=sess_e_child', headers: { ...HOST, cookie: COOKIE } })).json?.data?.requirements?.map(item => item.id) ?? []
  check('role and claimable intersect exactly', JSON.stringify(mine) === JSON.stringify([routed.id]), JSON.stringify(mine))
  const crossFilter = (await callHttp(mounted, { query: '?role=role-e1&claimable=true&me=sess_e_child', headers: { ...HOST, cookie: COOKIE } })).json?.data?.requirements?.map(item => item.id) ?? []
  check('a role the session cannot take yields the empty intersection', crossFilter.length === 0, JSON.stringify(crossFilter))
  note(`claimable for the child session alone returned ${claimableIds.length} record(s) before the role-routed one existed`)
  const noRole = await callHttp(mounted, { query: '?role=role-e1&status=open', headers: { ...HOST, cookie: COOKIE } })
  check('status narrows a role result', JSON.stringify(noRole.json?.data?.requirements?.map(item => item.id) ?? []) === JSON.stringify([one.id]), JSON.stringify(noRole.json?.data?.requirements?.map(item => item.id)))
  note(`the third record (${three.id}) is routed nowhere and correctly absent; ${two.id} carries the other role`)
  const command = await callHttp(mounted, {
    method: 'POST',
    path: '/command',
    headers: { ...HOST, cookie: COOKIE, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list', filter: { role: 'role-e2' } }),
  })
  check('the POST command path applies the same filter', JSON.stringify(command.json?.data?.items?.map(item => item.id) ?? []) === JSON.stringify([two.id]), `${command.status} ${command.body.slice(0, 160)}`)

  /* [4] F2: the assembled prompt sections. */
  console.log('\n[4] the assembled prompt keeps a decision out of delegated work')
  const decision = await createViaTool(mounted.ctx, PARENT, 'e-decision', { title: '该人拍板', kind: 'decision' })
  decisionId = decision.id
  const childTask = await createViaTool(mounted.ctx, PARENT, 'e-child-task', { title: '给子会话的活' })
  const delegatedTask = await callTool(mounted.ctx, { action: 'delegate', id: childTask.id, session: CHILD.id }, undefined, 'e-delegate-task')
  check('the panel delegates a task to the child session', !delegatedTask.isError, delegatedTask.text.slice(0, 160))
  const delegatedDecision = await callTool(mounted.ctx, { action: 'delegate', id: decisionId, session: CHILD.id }, undefined, 'e-delegate-decision')
  check('the panel delegating a decision is accepted', !delegatedDecision.isError, delegatedDecision.text.slice(0, 160))
  const text = await contextText(mounted.ctx, CHILD)
  const delegated = promptSection(text, 'Delegated to you')
  const waiting = promptSection(text, 'Waiting on the human')
  check('the delegated task is in the delegated section', delegated.includes(childTask.id), delegated.replace(/\n/g, ' | ').slice(0, 200))
  check('the delegated decision is not in the delegated section', !delegated.includes(decisionId), delegated.replace(/\n/g, ' | ').slice(0, 200))
  check('the delegated decision is in the human section', waiting.includes(decisionId), waiting.replace(/\n/g, ' | ').slice(0, 200))
  check('the decision appears exactly once in the whole prompt', text.split('\n').filter(row => row.includes(decisionId)).length === 1, text.split('\n').filter(row => row.includes(decisionId)).join(' | ').slice(0, 200))
  check('the named session still cannot claim its decision', (await getRecord(mounted.ctx, decisionId, CHILD, 'e-child-decision'))?.claimable === false, 'the decision reads claimable')
  note(`assembled sections: ${PROMPT_SECTIONS.filter(name => promptSection(text, name) !== '').join(', ')}`)

  /* [5] disposal ends every registration this stage added. */
  console.log('\n[5] disposal of the fiber')
  await callTool(mounted.ctx, { action: 'claim', id: taskId }, PARENT, 'e-claim-for-sync')
  const listener = mounted.jobs.subscribers[0]?.listener
  check('the mount subscribed to the job registry stream', typeof listener === 'function', `${mounted.jobs.subscribers.length} subscribers`)
  const jobEvent = { type: 'registered', job: { id: 'job_e_dispose', owner: PARENT.id, status: 'running', label: '观察', progress: '', detail: '', startedAt: new Date().toISOString() } }
  const bytesBeforeEvent = await mediumBytes(root)
  await listener(jobEvent)
  await new Promise(resolve => setTimeout(resolve, 20))
  const bytesAfterEvent = await mediumBytes(root)
  check('a job registry event writes while mounted', !bytesBeforeEvent.equals(bytesAfterEvent), 'the medium is unchanged')
  const bytesBeforeEmit = await mediumBytes(root)
  const emittedWhileMounted = await attempt(() => mounted.ctx.emit('subagent/start', { id: PARENT.id, provider: 'e-stub' }))
  await new Promise(resolve => setTimeout(resolve, 20))
  const emitWrote = !(await mediumBytes(root)).equals(bytesBeforeEmit)
  note(`a directly emitted subagent/start ${emitWrote ? 'wrote' : 'did not write'}${emittedWhileMounted.error === null ? '' : ` (${emittedWhileMounted.error.message})`}`)
  const bytesMounted = await mediumBytes(root)
  const revBeforeRemount = (await getRecord(mounted.ctx, taskId, PARENT, 'e-get-before-dispose'))?.rev
  const toolBefore = await callTool(mounted.ctx, { action: 'stats' }, PARENT, 'e-stats-before')
  check('the tool answers before disposal', !toolBefore.isError, toolBefore.text.slice(0, 120))
  await mounted.ctx.fiber.dispose()
  await new Promise(resolve => setTimeout(resolve, 30))
  check('the route disposer ran with the fiber', mounted.route.disposed.length === 1, JSON.stringify(mounted.route.disposed))
  check('the job subscription was disposed with the fiber', mounted.jobs.subscribers.length === 0, `${mounted.jobs.subscribers.length} left`)
  const toolAfter = await attempt(() => callTool(mounted.ctx, { action: 'stats' }, PARENT, 'e-stats-after'))
  check('the board tool is gone after disposal', toolAfter.error !== null || toolAfter.value.isError === true, JSON.stringify(toolAfter.value?.text ?? String(toolAfter.error)))
  const promptAfter = await attempt(() => contextText(mounted.ctx, CHILD))
  check('the prompt context section is gone after disposal', promptAfter.error !== null || promptAfter.value === '', promptAfter.value?.slice(0, 120) ?? '')
  const emitted = await attempt(() => mounted.ctx.emit('subagent/start', { id: PARENT.id, provider: 'e-stub' }))
  check('emitting the lifecycle event after disposal does not throw', emitted.error === null, String(emitted.error))
  const replayed = await attempt(() => listener(jobEvent))
  check('replaying a job event through the disposed subscription is inert', replayed.error === null, String(replayed.error))
  const bytesAfterDispose = await mediumBytes(root)
  check('no execution write landed after disposal', bytesMounted.equals(bytesAfterDispose), `${bytesMounted.length} -> ${bytesAfterDispose.length}`)
  globalThis.__eRevBeforeRemount = revBeforeRemount
} finally {
  await mounted.ctx.fiber.dispose()
}

/* [6] a remount over the same medium writes nothing by itself. */
console.log('\n[6] a remount does not write')
{
  const before = await mediumBytes(root)
  const again = await mountBoard(root)
  try {
    const after = await mediumBytes(root)
    check('mounting a board over an existing medium writes nothing', before.equals(after), `${before.length} -> ${after.length}`)
    const records = await callHttp(again, { headers: { ...HOST, cookie: COOKIE } })
    check('the remounted route serves the board', records.status === 200 && typeof records.json?.data?.revision === 'number', `${records.status} ${records.body.slice(0, 120)}`)
    const revAfterRemount = (await getRecord(again.ctx, taskId, PARENT, 'e-get-after-remount'))?.rev
    check('the remount did not bump the record revision', revAfterRemount === globalThis.__eRevBeforeRemount, `${revAfterRemount} vs ${globalThis.__eRevBeforeRemount}`)
    check('the remount registered exactly one route', again.route.specs.length === 1, `${again.route.specs.length}`)
  } finally {
    await again.ctx.fiber.dispose()
  }
}

/* [7] without a connection service the route keeps its own loopback fence. */
console.log('\n[7] the route without a connection service')
{
  const bare = await mountBoard(root, { withConnection: false })
  try {
    const cross = await callHttp(bare, { headers: { ...HOST, origin: 'http://evil.test', cookie: COOKIE } })
    check('the origin-less fallback refuses a cross-origin request 403', cross.status === 403 && cross.json?.error?.code === 'forbidden-origin', `${cross.status} ${cross.body.slice(0, 120)}`)
    const loopback = await callHttp(bare, { headers: { ...HOST, origin: 'http://127.0.0.1:3080' } })
    check('the fallback serves a loopback-origin request', loopback.status === 200, `${loopback.status}`)
    const noOrigin = await callHttp(bare, { headers: { ...HOST } })
    check('the fallback serves a request with no Origin at all', noOrigin.status === 200, `${noOrigin.status}`)
    note('without the connection service the fence is the narrower Origin check: a request with no Origin header is served, which is the documented plugin-local limit')
  } finally {
    await bare.ctx.fiber.dispose()
  }
}

await rm(root, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed through the composition`)
if (failed.length > 0) {
  console.log('failed checks:')
  for (const label of failed) console.log(`  - ${label}`)
}
process.exit(failures === 0 ? 0 : 1)
