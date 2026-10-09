/**
 * Stage E cases: execution synchronisation, and the three step-0 host gaps
 * (`ROLE-DISPATCH.md` §4.2, §5.4, §5.5, §9-E, §10).
 *
 * The synchronizer has two producers (the subagent lifecycle and the background
 * job registry) and one writer, so the cases are split the same way: pure
 * functions pin the fold itself, a mounted plugin pins the wiring and its
 * disposal, and the service cases pin what a locked requirement ends up
 * publishing — including the facts that must *not* move (`rev`, `history`,
 * `output` bytes) and the degradations that must stay visible (`ignored`,
 * `gaps`, `sync.gap`, `truncated`).
 *
 * The step-0 gaps are covered here too, because they are the prerequisites the
 * panel's execution view reads: the `role` filter, the per-session queue order
 * from one source, and the platform trust judgement on the route.
 *
 * Every storage case runs against every backend in {@link BACKENDS}: execution
 * units are stored fields and have to survive a reopen.
 */

import { join } from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { createBoardHandler, dispatchBoardCommand } from '../host/http.js'
import { resolveConfig } from '../host/config.js'
import { bootstrapRequirementBoard, requirementBoardDomain } from '../host/domain.js'
import { RequirementService } from '../host/service.js'
import { apply as applyBoardPlugin, forwardDomainChange } from '../index.js'
import { EXEC_STATUSES } from '../host/model.js'
import {
  applyExecution,
  attributeExecution,
  executionGateDecision,
  runningCount,
  settleExecutions,
  subagentStatus,
  unitFromJobEvent,
  unitFromSubagent,
} from '../host/runs.js'
import {
  BACKENDS,
  createRecordingLogger,
  createReporter,
  makeTempDir,
  openBoard,
  removeTempDir,
} from './harness.mjs'

const reporter = createReporter()
const { check } = reporter

/** A session that holds a lock in most cases. */
const A = { session: 'ses_A', name: '会话 A' }

/** A second session, used for the ownership, queue, and gate cases. */
const B = { session: 'ses_B', name: '会话 B' }

/** An ISO instant far enough in the past to be a stable fixture stamp. */
const T0 = '2026-01-01T00:00:00.000Z'

/** Sleep, for the merge-window cases that observe a timer. */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Forward every domain change the medium emitted since `from`, the way the
 * plugin's own `domain/changed` listener does.
 * @param board - Open board handle.
 * @param from - Index into `board.changes` to resume from.
 * @returns the new index.
 */
function forwardSince(board, from) {
  for (const change of board.changes.slice(from)) forwardDomainChange(change, board.service)
  return board.changes.length
}

/** One `JobView` with the fields the synchronizer reads. */
function jobView(overrides = {}) {
  return {
    id: 'pwsh-1',
    kind: 'pwsh',
    label: 'npm run build',
    owner: A.session,
    status: 'running',
    startedAt: Date.parse(T0),
    output: { total: 0, earliest: 0 },
    ...overrides,
  }
}

/** One `JobEvent` of the given type around one view. */
function jobEvent(type, overrides = {}) {
  const job = jobView(overrides)
  return type === 'settled' ? { type, job, cause: 'exit', awaited: false } : { type, job }
}

/** A registry fake: records subscriptions and pushes events into them. */
function fakeJobs(views = []) {
  const subscriptions = []
  return {
    views,
    subscriptions,
    list: caller => views.filter(view => view.owner === undefined || view.owner === caller),
    events: {
      subscribe(filter, listener) {
        const entry = { filter, listener, active: true, calls: 0 }
        subscriptions.push(entry)
        return () => {
          entry.active = false
        }
      },
    },
    emit(event) {
      for (const entry of subscriptions) {
        if (!entry.active) continue
        entry.calls += 1
        entry.listener(event)
      }
    },
  }
}

/** A registry fake whose `list` throws, for the contained-failure path. */
function brokenJobs() {
  return { ...fakeJobs(), list: () => { throw new Error('registry exploded') } }
}

/** An agent-registry fake that answers the one ownership question. */
function fakeAgents(owners = {}) {
  return {
    isOwnedBy: (target, owner) => owners[owner?.id]?.includes(target) === true,
    get: id => (id in owners ? { id } : undefined),
  }
}

/** The port set of a board whose `owned` map answers the ownership question. */
function portsFor({ jobs, agents, owned = { [A.session]: ['ses_child'] } } = {}) {
  return {
    jobs: () => jobs ?? fakeJobs(),
    agents: () => agents ?? fakeAgents(owned),
    presets: () => undefined,
    owns: (target, caller) => owned[caller]?.includes(target) === true,
  }
}

/** A response object that captures what the route wrote. */
function fakeResponse() {
  return {
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    end(body) {
      this.body = body ?? ''
      return this
    },
  }
}

/** A request object with the fields the route reads. */
function fakeRequest(headers = {}, method = 'GET', url = '/api/requirement-board/health') {
  return { method, url, headers }
}

/**
 * The minimal plugin context that records the disposer of every registration,
 * so a case can observe an HMR replacement the way the fiber does.
 *
 * `createMountContext` in the harness records labels only; this case needs the
 * disposers themselves, which is the whole point of §10's unloading case. The
 * `emit` dispatches to the listeners registered on this context, because that is
 * the only path by which the domain facility can reach the plugin's own
 * `domain/changed` listener.
 * @param options - `storageDomain`, `storage`, `get(name)`, a recording
 * `logger`, and an `onEmit` observer.
 * @returns the context, its records, `dispatch`, and `disposeAll()`.
 */
function createFiberContext({ storageDomain, storage, get, logger, onEmit } = {}) {
  const logs = logger ?? createRecordingLogger()
  const records = { effects: [], listeners: [], tools: [], routes: undefined }
  const disposers = []
  const runDisposer = entry => {
    if (entry.used === true) return
    entry.used = true
    entry.dispose()
  }
  const effect = (execute, label = 'anonymous') => {
    records.effects.push(label)
    const produced = execute()
    const dispose = typeof produced === 'function' ? produced : () => {}
    disposers.push({ label, dispose, used: false })
    return dispose
  }
  const ctx = {
    storageDomain,
    storage,
    logger: logs,
    get: name => (typeof get === 'function' ? get(name) : undefined),
    effect,
    emit: (event, payload) => {
      if (typeof onEmit === 'function') onEmit(event, payload)
      for (const entry of [...records.listeners]) {
        if (entry.event === event) entry.handler(payload)
      }
    },
    on: (event, handler) => {
      const entry = { event, handler }
      records.listeners.push(entry)
      const dispose = () => {
        const index = records.listeners.indexOf(entry)
        if (index >= 0) records.listeners.splice(index, 1)
      }
      disposers.push({ label: `on:${event}`, dispose, used: false })
      return dispose
    },
    inject: (deps, callback) => {
      callback({
        effect,
        systemPrompt: { context: () => () => {} },
        webServer: {
          register: spec => {
            records.routes = spec
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
    dispatch: (event, ...args) => records.listeners.filter(entry => entry.event === event).map(entry => entry.handler(...args)),
    /** Dispose one registration by its label, the way a replaced fiber would. */
    disposeLabel: label => {
      for (const entry of [...disposers].reverse()) {
        if (entry.label === label) runDisposer(entry)
      }
    },
    disposeAll: () => {
      for (const entry of [...disposers].reverse()) runDisposer(entry)
    },
  }
}

/**
 * Mount the plugin the way the runtime does: its own context owns the domain
 * facility, so the facility's `domain/changed` emit reaches the plugin's own
 * listener and the merge window is exercised end to end (§10).
 *
 * @param backend - Backend name from {@link BACKENDS}.
 * @param dir - Directory holding the medium.
 * @param options - `config`, and the port `services` the composition provides.
 * @returns the mount, the open `domain`, and the raw changes it emitted.
 */
async function openLiveBoard(backend, dir, { config, services = {}, logger } = {}) {
  const impl = backend === 'sqlite'
    ? new (await import('@deepseek-ai/dsh-storage-sqlite')).SqliteStorageBackend({ path: join(dir, 'board.db'), journalMode: 'wal' })
    : new JsonStorageBackend(dir)
  const changes = []
  const mounted = createFiberContext({
    // The facility reads the backend registry from the context that owns it, which
    // here is the plugin's own context — the same ownership the runtime gives it.
    storage: {
      backend: {
        get: requested => {
          if (requested !== backend) throw new Error(`the test context has no backend "${requested}"`)
          return impl
        },
      },
    },
    get: name => services[name],
    logger,
    onEmit: (event, payload) => {
      if (event === 'domain/changed') changes.push(payload)
    },
  })
  const facility = new DomainFacility(mounted.ctx, { backend, routes: {} })
  const domain = await facility.open(requirementBoardDomain)
  await bootstrapRequirementBoard(domain, { logger: mounted.logger })
  mounted.ctx.storageDomain = { open: async () => domain }
  await applyBoardPlugin(mounted.ctx, config ?? resolveConfig({}))
  return {
    ...mounted,
    domain,
    changes,
    close: async () => {
      mounted.disposeAll()
      await impl.close()
    },
  }
}

/** An agent registry that owns every `ses_child*` session on behalf of A. */
function permissiveAgents() {
  return {
    get: id => ({ id }),
    isOwnedBy: (target, owner) => owner?.id === A.session && String(target).startsWith('ses_child'),
  }
}

/** Call one board tool through the mounted plugin, the way the model does. */
async function callTool(mounted, args, session = A.session) {
  const tool = mounted.records.tools.find(candidate => candidate.name === 'requirement_board')
  return await tool.execute(args, { agent: { id: session } })
}

/**
 * Start an SSE stream on the mounted route and count the frames it forwards.
 *
 * The stream is what the panel actually receives, so one frame is one snapshot
 * the panel will ask for.
 * @param mounted - Mount from {@link openLiveBoard}.
 * @returns the frame counter, the frames, and a `close()`.
 */
function openStream(mounted) {
  const frames = []
  const handlers = new Map()
  const res = {
    status: 0,
    writeHead(status) {
      this.status = status
      return this
    },
    write(chunk) {
      const text = String(chunk)
      if (text.startsWith('event: changed')) frames.push(JSON.parse(text.split('data: ')[1]))
      return true
    },
    on(event, handler) {
      handlers.set(event, handler)
      return this
    },
    end() {
      return this
    },
    off() {
      return this
    },
    removeListener() {
      return this
    },
  }
  const req = {
    method: 'GET',
    url: '/api/requirement-board/events',
    headers: {},
    on(event, handler) {
      handlers.set(event, handler)
      return this
    },
    off() {
      return this
    },
    removeListener() {
      return this
    },
  }
  void mounted.records.routes.handler(req, res)
  return {
    frames,
    status: res.status,
    close: () => handlers.get('close')?.(),
  }
}

/** Create a requirement and take its lock with session A. */
async function lockedRequirement(board, title) {
  const requirement = await board.service.createRequirement({ summary: '测试简述', title }, A)
  await board.service.claim(requirement.id, {}, A)
  return requirement
}

/** The stored record behind one requirement id. */
function stored(board, id) {
  return board.domain.table('requirements').get(id)
}

/** Run one case against a fresh temporary directory. */
async function onBackend(backend, name, run) {
  const dir = await makeTempDir()
  try {
    console.log(`\n${backend}: ${name}`)
    await run(dir)
  } finally {
    await removeTempDir(dir)
  }
}

/** The pure fold and attribution rules (§10: the handler as a callable function). */
function casePureHandlers() {
  const start = unitFromSubagent({ id: 'ses_child', provider: 'in-process', runId: 'run_1', local: true }, { at: T0, phase: 'start' })
  check('a start event becomes a running subagent unit', start.ref === 'ses_child' && start.kind === 'subagent' && start.status === 'running' && start.startedAt === T0 && start.finishedAt === null)
  check('a start event with no subject stores nothing', unitFromSubagent({ provider: 'x' }, { at: T0, phase: 'start' }) === undefined)
  for (const [reason, expected] of [['completed', 'completed'], ['aborted', 'killed'], ['error', 'failed'], ['max-tokens', 'failed'], ['refusal', 'failed'], ['something-new', 'failed']]) {
    check(`the stop reason "${reason}" maps to ${expected}`, subagentStatus(reason) === expected)
  }
  const end = unitFromSubagent({ id: 'ses_child', provider: 'in-process', stopReason: 'aborted' }, { at: T0, phase: 'end' })
  check('an end event is terminal and carries the reason', end.status === 'killed' && end.detail === 'aborted' && end.finishedAt === T0)
  check('every unit status is a protocol status', EXEC_STATUSES.includes(start.status) && EXEC_STATUSES.includes(end.status))

  const registered = unitFromJobEvent(jobEvent('registered'), { at: T0 })
  check('a registered job becomes a running unit', registered.unit?.status === 'running' && registered.unit.kind === 'job' && registered.gap === false)
  check('no job kind is filtered out', unitFromJobEvent(jobEvent('registered', { kind: 'workflow' }), { at: T0 }).unit?.kind === 'job')
  const progress = unitFromJobEvent(jobEvent('progress', { progress: '3/10' }), { at: T0 })
  check('a progress event carries the producer text', progress.unit?.progress === '3/10')
  const settled = unitFromJobEvent(jobEvent('settled', { status: 'completed', finishedAt: Date.parse('2026-01-01T00:05:00.000Z') }), { at: T0 })
  check('a settled job is terminal with its own finishedAt', settled.unit?.status === 'completed' && settled.unit.finishedAt === '2026-01-01T00:05:00.000Z')
  check('a settlement that is still running is reported as failed', unitFromJobEvent(jobEvent('settled', { status: 'running' }), { at: T0 }).unit?.status === 'failed')
  const output = unitFromJobEvent({ type: 'output', id: 'pwsh-1', owner: A.session, total: 4096 }, { at: T0 })
  check('an output event stores nothing and is not a gap', output.unit === undefined && output.gap === false)
  const removed = unitFromJobEvent(jobEvent('removed'), { at: T0 })
  check('a removed job is an unobserved settlement, not a terminal status', removed.unit === undefined && removed.gap === true)

  const first = { ref: 'a', kind: 'job', label: 'x', status: 'running', progress: '', detail: '', startedAt: T0, finishedAt: null, updatedAt: T0 }
  const applied = applyExecution([], first, 20)
  check('a new unit is appended', applied.changed === true && applied.units.length === 1 && applied.truncated === false)
  check('the same status is not written again', applyExecution(applied.units, { ...first, updatedAt: '2026-01-01T00:10:00.000Z' }, 20).changed === false)
  check('a changed progress text is written', applyExecution(applied.units, { ...first, progress: '1/2' }, 20).changed === true)
  const bounded = applyExecution([first], { ...first, ref: 'b' }, 1)
  check('over the bound the oldest unit is dropped and the record is marked', bounded.units.length === 1 && bounded.units[0].ref === 'b' && bounded.truncated === true)

  const records = [
    { id: 'req_2', lock: { session: A.session } },
    { id: 'req_1', lock: { session: B.session } },
    { id: 'req_3', lock: null },
  ]
  check('a session executing its own locked task owns the observation', JSON.stringify(attributeExecution(records, { subject: A.session, owns: () => false })) === JSON.stringify({ requirementId: 'req_2', session: A.session }))
  const byOwner = attributeExecution(records, { subject: 'ses_child', owns: (target, caller) => caller === A.session && target === 'ses_child' })
  check('a child of the lock holder attaches to the holder\'s requirement', byOwner?.requirementId === 'req_2')
  check('an observation nobody owns is attributed to nothing', attributeExecution(records, { subject: 'ses_else', owns: () => false }) === null)
  const ambiguous = attributeExecution([
    { id: 'req_9', lock: { session: A.session } },
    { id: 'req_8', lock: { session: B.session } },
  ], { subject: 'ses_child', owns: () => true })
  check('two possible owners resolve by requirement id, not table order', ambiguous?.requirementId === 'req_8')
  check('the child\'s own lock wins over its parent\'s', attributeExecution([
    { id: 'req_9', lock: { session: A.session } },
    { id: 'req_10', lock: { session: 'ses_child' } },
  ], { subject: 'ses_child', owns: () => true })?.requirementId === 'req_10')

  const settledUnits = settleExecutions([first, { ...first, ref: 'b', status: 'completed', finishedAt: T0 }], T0, 'session gone')
  check('settling ends only the executing units', settledUnits.changed === true && settledUnits.units[0].status === 'killed' && settledUnits.units[0].detail === 'session gone' && settledUnits.units[1].status === 'completed')
  check('settling nothing reports no change', settleExecutions(settledUnits.units, T0, 'again').changed === false)
  check('running counts running and stopping', runningCount({ executions: [first, { ...first, ref: 'b', status: 'stopping' }, { ...first, ref: 'c', status: 'completed' }] }) === 2)

  const gate = executionGateDecision({ name: 'subagent', session: A.session, holdsLock: false })
  check('the gate refuses an execution tool without a lock', gate?.kind === 'deny' && gate.reason.includes('claim') && gate.reason.includes('requireLockForExecution'))
  check('the gate allows a lock holder', executionGateDecision({ name: 'subagent', session: A.session, holdsLock: true }) === undefined)
  check('the gate allows a non-execution tool', executionGateDecision({ name: 'web_search', session: A.session, holdsLock: false }) === undefined)
  check('the gate does not judge a caller it cannot name', executionGateDecision({ name: 'pwsh', session: '', holdsLock: false }) === undefined)
  check('the board\'s own tool is never gated', executionGateDecision({ name: 'requirement_board', session: A.session, holdsLock: false }) === undefined)
}

/** A subagent lifecycle edge is stored once, does not move `rev`, and is counted. */
async function caseSubagentLifecycle(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: portsFor() })
    const requirement = await lockedRequirement(board, '执行同步')
    const before = stored(board, requirement.id)
    const changesBefore = board.changes.length

    const started = await board.service.observeSubagent({ id: 'ses_child', provider: 'in-process', runId: 'run_1', local: true }, 'start')
    check('a subagent start is stored on the lock holder\'s requirement', started.stored === true && started.requirementId === requirement.id)
    const running = stored(board, requirement.id)
    check('the unit records its producer, its subject, and its start', running.executions.length === 1 && running.executions[0].ref === 'ses_child' && running.executions[0].label === 'in-process' && running.executions[0].status === 'running')
    check('the write records the observation revision and the sync instant', running.execRev === 1 && typeof running.sync.syncedAt === 'string' && running.sync.gap === false)
    check('the execution write does not move the record revision', running.rev === before.rev)
    check('the execution write records no history', running.history.length === before.history.length && running.updatedAt === before.updatedAt)
    check('one observation commits one record write and one revision bump', board.changes.length - changesBefore === 2, `${board.changes.length - changesBefore} changes`)

    const ended = await board.service.observeSubagent({ id: 'ses_child', provider: 'in-process', stopReason: 'completed' }, 'end')
    const completed = stored(board, requirement.id)
    check('the end edge is the same unit, now terminal', ended.stored === true && completed.executions.length === 1 && completed.executions[0].status === 'completed' && typeof completed.executions[0].finishedAt === 'string')
    const execRev = completed.execRev
    const settledChanges = board.changes.length
    const repeated = await board.service.observeSubagent({ id: 'ses_child', provider: 'in-process', stopReason: 'completed' }, 'end')
    check('repeating the same status writes nothing', repeated.stored === false && stored(board, requirement.id).execRev === execRev)
    check('the repeated status commits nothing to the medium', board.changes.length === settledChanges)

    const ignored = await board.service.observeSubagent({ id: 'ses_other', provider: 'in-process' }, 'start')
    check('an observation from a session without a lock is counted, not stored', ignored.stored === false && ignored.ignored === true && stored(board, requirement.id).executions.length === 1)
    check('the ignored count is visible in the statistics', board.service.stats().execSync.ignored === 1)
    check('the ignored count did not touch a requirement', stored(board, requirement.id).rev === before.rev)

    const read = board.service.getRequirement(requirement.id, A.session)
    check('get presents the units with their derived staleness', read.executions.length === 1 && read.executions[0].stale === false && read.running === 0)
    check('get presents the sync status as enabled and complete', read.sync.enabled === true && read.sync.gap === false && read.sync.reason === '')
    check('the summary counts what is still running', board.service.listRequirements({}, A.session).items[0].running === 0)
    await board.close()
  })
}

/** `rev` is not the execution revision: the CAS a model holds stays valid. */
async function caseExecutionSyncKeepsRev(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: portsFor() })
    const requirement = await lockedRequirement(board, 'CAS')
    const before = board.service.getRequirement(requirement.id, A.session)
    await board.service.observeSubagent({ id: 'ses_child', provider: 'in-process' }, 'start')
    await board.service.observeSubagent({ id: 'ses_other', provider: 'in-process' }, 'start')
    const after = board.service.getRequirement(requirement.id, A.session)
    check('the execution write moved only the observation revision', after.rev === before.rev && after.execRev === before.execRev + 1)
    const moved = await board.service.transitionRequirement(requirement.id, { action: 'advance', force: true, expectedRev: before.rev }, A)
    check('a transition holding the pre-observation revision still succeeds', moved.rev === before.rev + 1 && moved.nodeId !== before.nodeId)
    check('the transition itself is history, the observation was not', moved.history.length === before.history.length + 1)
    await board.close()
  })
}

/** Job events fold in, `output` never stores, and the bound marks truncation. */
async function caseJobEvents(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({ maxExecutions: 5 }), ports: portsFor() })
    const requirement = await lockedRequirement(board, '后台任务')

    const registered = await board.service.observeJobEvent(jobEvent('registered'))
    check('a registered job is stored as running', registered.stored === true && stored(board, requirement.id).executions[0].kind === 'job')
    const progress = await board.service.observeJobEvent(jobEvent('progress', { progress: '3/10' }))
    check('a progress change is written', progress.stored === true && stored(board, requirement.id).executions[0].progress === '3/10')
    const execRev = stored(board, requirement.id).execRev
    const output = await board.service.observeJobEvent({ type: 'output', id: 'pwsh-1', owner: A.session, total: 4096 })
    check('an output event is not stored, not a gap, and not ignored', output.stored === false && stored(board, requirement.id).execRev === execRev && board.service.stats().execSync.ignored === 0)
    const stopping = await board.service.observeJobEvent(jobEvent('stopping', { status: 'stopping' }))
    check('a stopping job is stored as stopping', stopping.stored === true && stored(board, requirement.id).executions[0].status === 'stopping')
    await board.service.observeJobEvent(jobEvent('settled', { status: 'completed', finishedAt: Date.parse('2026-01-01T00:05:00.000Z') }))
    const done = stored(board, requirement.id).executions[0]
    check('a settled job is terminal with its own finishedAt', done.status === 'completed' && done.finishedAt === '2026-01-01T00:05:00.000Z')

    for (let index = 0; index < 6; index += 1) {
      await board.service.observeJobEvent(jobEvent('registered', { id: `pwsh-${index + 2}` }))
    }
    const bounded = stored(board, requirement.id)
    check('the list is bounded by maxExecutions', bounded.executions.length === 5)
    check('dropping the oldest marks the record truncated', bounded.executionsTruncated === true && bounded.executions[0].ref === 'pwsh-3')
    check('get reports the truncation', board.service.getRequirement(requirement.id, A.session).executionsTruncated === true)

    const ownerless = await board.service.observeJobEvent(jobEvent('registered', { owner: undefined }))
    check('an unowned job is counted as ignored, not stored', ownerless.ignored === true && board.service.stats().execSync.ignored === 1)
    await board.close()
  })
}

/** A `removed` event marks a gap; the panel and the prompt say so. */
async function caseUnobservedSettlement(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: portsFor() })
    const requirement = await lockedRequirement(board, '未观测的结算')
    await board.service.observeJobEvent(jobEvent('registered'))
    const removed = await board.service.observeJobEvent(jobEvent('removed'))
    check('a removed job marks the requirement\'s sync gap', removed.stored === true && stored(board, requirement.id).sync.gap === true)
    const unit = stored(board, requirement.id).executions[0]
    check('the unobserved unit keeps its status instead of a guess', unit.status === 'running' && unit.finishedAt === null)
    const read = board.service.getRequirement(requirement.id, A.session)
    check('get renders the gap with its reason', read.sync.gap === true && read.sync.reason === 'unobserved-settlement')
    const prompt = board.service.promptContext(A.session, 12)
    check('the prompt says the execution state may be stale', prompt.includes('Executing now') && prompt.includes('execution sync has a gap'))
    check('the prompt names the lock holder\'s requirement', prompt.includes(requirement.id))
    await board.close()
  })
}

/** Reopening keeps the execution units: they are stored, not cached. */
async function caseUnitsSurviveReopen(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: portsFor() })
    const requirement = await lockedRequirement(board, '重启保留')
    await board.service.observeJobEvent(jobEvent('registered'))
    await board.close()
    const reopened = await openBoard({ backend, dir, config: resolveConfig({}), ports: portsFor() })
    const read = reopened.service.getRequirement(requirement.id, A.session)
    check('the unit survives a reopen with its sync state', read.executions.length === 1 && read.execRev === 1 && read.sync.enabled === true && read.sync.syncedAt !== null)
    check('the reopened board still counts it as running', read.running === 1 && reopened.service.stats().running === 1)
    await reopened.close()
  })
}

/** `claim` reconciles the session's live jobs, and reports what it cannot. */
async function caseClaimReconciles(backend, name) {
  await onBackend(backend, name, async dir => {
    const jobs = fakeJobs([
      jobView({ id: 'pwsh-7', status: 'running', progress: '2/4' }),
      jobView({ id: 'pwsh-8', status: 'completed', finishedAt: Date.parse('2026-01-01T00:09:00.000Z') }),
      jobView({ id: 'pwsh-9', owner: B.session, status: 'running' }),
    ])
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: portsFor({ jobs }) })
    const requirement = await board.service.createRequirement({ summary: '测试简述', title: '对账' }, A)
    const claimed = await board.service.claim(requirement.id, {}, A)
    check('claim reports the session\'s jobs it filled in', claimed.executions.length === 2)
    check('a live job arrives as running with its progress', claimed.executions.some(unit => unit.ref === 'pwsh-7' && unit.status === 'running' && unit.progress === '2/4'))
    check('a settled job arrives terminal with its finishedAt', claimed.executions.some(unit => unit.ref === 'pwsh-8' && unit.status === 'completed' && unit.finishedAt === '2026-01-01T00:09:00.000Z'))
    check('another session\'s jobs are not attributed here', claimed.executions.every(unit => unit.ref !== 'pwsh-9') && claimed.running === 1)

    // A unit still running that the registry no longer lists settled unobserved:
    // the board says so rather than inventing a status, and a later reconciliation
    // that accounts for it clears the mark.
    jobs.views.length = 0
    const first = await board.service.reconcileSession(A.session, requirement.id)
    check('an unlisted running unit is reported as an unobserved settlement', first.reason === 'unobserved-settlement' && board.service.getRequirement(requirement.id, A.session).sync.gap === true)
    check('the unlisted unit is not turned into a completed one', stored(board, requirement.id).executions.some(unit => unit.ref === 'pwsh-7' && unit.status === 'running'))
    jobs.views.push(jobView({ id: 'pwsh-7', status: 'completed', finishedAt: Date.parse('2026-01-01T00:11:00.000Z') }))
    const repaired = await board.service.reconcileSession(A.session, requirement.id)
    const fixed = board.service.getRequirement(requirement.id, A.session)
    check('reconciling again settles the unit and clears the gap', repaired.reason === '' && fixed.sync.gap === false && fixed.executions.find(unit => unit.ref === 'pwsh-7').status === 'completed')
    check('a reconciliation that finds nothing new writes nothing', (await board.service.reconcileSession(A.session, requirement.id)).reconciled === false)

    const brokenDir = await makeTempDir('requirement-board-broken-')
    const broken = await openBoard({ backend, dir: brokenDir, config: resolveConfig({}), ports: portsFor({ jobs: brokenJobs() }) })
    const target = await broken.service.createRequirement({ summary: '测试简述', title: '坏注册表' }, A)
    const survived = await broken.service.claim(target.id, {}, A)
    check('a claim still succeeds when the registry fails', survived.lock?.session === A.session)
    check('the registry failure is counted as a gap, not silently dropped', broken.service.getRequirement(target.id, A.session).sync.gap === true && broken.service.stats().execSync.gaps >= 1)
    check('the failed registry did not fail the claim receipt', survived.id === target.id && survived.lock.session === A.session)
    await broken.close()
    await removeTempDir(brokenDir)
    await board.close()
  })
}

/** Missing registries warn once, mark the gap, and never fake an observation. */
async function caseMissingRegistry(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: {} })
    // The service is built here rather than by the harness because the mount-time
    // warning is reported through the logger the runtime injects, and this is the
    // only place the case can pass one.
    const logger = createRecordingLogger()
    const service = new RequirementService({ domain: board.domain, config: resolveConfig({}), ports: {}, logger })
    const requirement = await service.createRequirement({ summary: '测试简述', title: '缺注册表' }, A)
    await service.claim(requirement.id, {}, A)
    const gapsBefore = service.stats().execSync.gaps
    const missing = service.assertExecutionPorts()
    check('the missing registries are reported once', missing.length === 2 && logger.lines.warn.length === 1 && logger.lines.warn[0].includes('executionSync is on'))
    service.assertExecutionPorts()
    check('a second check does not warn again', logger.lines.warn.length === 1)
    check('a registry that was never injected counts no lost observation', service.stats().execSync.gaps === gapsBefore)
    const read = service.getRequirement(requirement.id, A.session)
    check('the requirement reports the gap instead of looking idle', read.sync.enabled === true && read.sync.gap === true && read.sync.reason === 'missing-registry-jobs-agents')
    check('the gap is counted in the statistics', service.stats().execSync.gaps >= 1)
    check('the prompt warns that the state may be stale', service.promptContext(A.session, 12).includes('execution sync has a gap'))
    await board.close()

    const quietDir = await makeTempDir('requirement-board-off-')
    const quietLogger = createRecordingLogger()
    const quiet = await openBoard({ backend, dir: quietDir, config: resolveConfig({ executionSync: false }), ports: {}, logger: quietLogger })
    const mounted = createFiberContext({ storageDomain: { open: async () => quiet.domain }, logger: quietLogger })
    await applyBoardPlugin(mounted.ctx, resolveConfig({ executionSync: false }))
    check('switching sync off registers no producer listener', mounted.records.listeners.every(entry => !entry.event.startsWith('subagent/')))
    check('switching sync off warns about nothing and counts no gap', quietLogger.lines.warn.length === 0 && quiet.service.stats().execSync.gaps === 0)
    const idle = await quiet.service.createRequirement({ summary: '测试简述', title: '关闭同步' }, A)
    const view = quiet.service.getRequirement(idle.id, A.session)
    check('switching sync off says so instead of pretending it synced', view.sync.enabled === false && view.sync.reason === 'execution-sync-disabled' && view.executions.length === 0)
    await quiet.close()
    await removeTempDir(quietDir)
  })
}

/** The stored units of a disposed or un-delegated session are settled. */
async function caseSettledOnLifecycleEnd(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: portsFor() })
    const requirement = await lockedRequirement(board, '收尾')
    await board.service.observeSubagent({ id: 'ses_child', provider: 'in-process' }, 'start')
    const historyBefore = stored(board, requirement.id).history.length
    await board.service.disposeSession(A.session)
    const disposed = board.service.getRequirement(requirement.id, A.session)
    check('a disposed session settles the units it can no longer report', disposed.executions[0].status === 'killed' && disposed.executions[0].detail.includes('disposed') && disposed.running === 0)
    check('settling writes no history entry of its own', stored(board, requirement.id).history.length === historyBefore)
    await board.close()

    // A second board, because the delegation needs a lock holder that is not the
    // delegating session and the first session's orphaned lock still names it.
    const delegatedDir = await makeTempDir('requirement-board-delegate-')
    const next = await openBoard({ backend, dir: delegatedDir, config: resolveConfig({}), ports: portsFor() })
    const child = { session: 'ses_child', name: '' }
    const delegated = await next.service.createRequirement({ summary: '测试简述', title: '撤销派发' }, A)
    await next.service.claim(delegated.id, {}, child)
    await next.service.observeSubagent({ id: 'ses_child', provider: 'in-process' }, 'start')
    await next.service.delegate(delegated.id, { session: child.session, duties: ['跑'] }, A)
    check('a delegation keeps the units it observed', stored(next, delegated.id).executions.length === 1)
    check('the delegated session is the one that may claim it', next.service.getRequirement(delegated.id, child.session).delegatedTo.session === child.session)
    await next.service.delegate(delegated.id, { session: child.session, revoke: true }, A)
    const revoked = next.service.getRequirement(delegated.id, child.session)
    check('revoking the delegation settles the task\'s units', revoked.executions[0].status === 'killed' && revoked.executions[0].detail.includes('delegation'))
    check('revoking still returns the role it had before', revoked.role === '' && revoked.delegatedTo === null)
    await next.close()
    await removeTempDir(delegatedDir)
  })
}

/** The panel is notified once per merge window; `0` forwards every change. */
async function caseReadAmplification(backend, name) {
  await onBackend(backend, name, async dir => {
    const mounted = await openLiveBoard(backend, dir, {
      config: resolveConfig({ sseCoalesceMs: 200 }),
      services: { agents: permissiveAgents() },
    })
    const created = await callTool(mounted, { action: 'create', summary: '测试简述', title: '读放大' })
    await callTool(mounted, { action: 'claim', id: created.id })
    const stream = openStream(mounted)
    check('the stream opens on the board route and reports its revision', stream.status === 200)
    for (let count = 0; count < 10; count += 1) {
      await Promise.all(mounted.dispatch('subagent/start', { id: `ses_child-${count}`, provider: 'in-process' }))
    }
    check('ten execution events forward nothing while the window is open', stream.frames.length === 0, `${stream.frames.length} frames`)
    await sleep(260)
    check('ten execution events reach the panel as one frame', stream.frames.length === 1, `${stream.frames.length} frames`)
    check('the forwarded frame carries the newest revision', stream.frames[0].revision >= 1)
    const framesBefore = stream.frames.length
    const updated = await callTool(mounted, { action: 'update', id: created.id, priority: 'high' })
    check('the definition update landed', updated.priority === 'high', JSON.stringify({ priority: updated.priority, rev: updated.rev }))
    check('a definition write is forwarded immediately, without waiting for the window', stream.frames.length >= framesBefore + 1, `${stream.frames.length - framesBefore} new frames`)
    check('the forwarded frames name a monotonic revision', stream.frames.every((frame, index) => index === 0 || frame.revision >= stream.frames[index - 1].revision), JSON.stringify(stream.frames))
    stream.close()
    await mounted.close()

    const directDir = await makeTempDir('requirement-board-direct-')
    const direct = await openLiveBoard(backend, directDir, { config: resolveConfig({ sseCoalesceMs: 0 }), services: { agents: permissiveAgents() } })
    const directCreated = await callTool(direct, { action: 'create', summary: '测试简述', title: '对照' })
    await callTool(direct, { action: 'claim', id: directCreated.id })
    const directStream = openStream(direct)
    for (let count = 0; count < 10; count += 1) {
      await Promise.all(direct.dispatch('subagent/start', { id: `ses_child-${count}`, provider: 'in-process' }))
    }
    check('a zero window forwards the burst instead of merging it', directStream.frames.length >= 10, `${directStream.frames.length} frames`)
    directStream.close()
    await direct.close()
    await removeTempDir(directDir)
  })
}

/** The mounted plugin subscribes, observes, and gives every registration back. */
async function caseMountWiringAndHmr(backend, name) {
  await onBackend(backend, name, async dir => {
    const jobs = fakeJobs([jobView({ id: 'pwsh-21', status: 'running' })])
    const mounted = await openLiveBoard(backend, dir, {
      config: resolveConfig({ executionSync: true }),
      services: { jobs, agents: fakeAgents({ [A.session]: ['ses_child', 'ses_child-2'] }) },
    })
    const requirement = await callTool(mounted, { action: 'create', summary: '测试简述', title: '挂载接线' })
    await callTool(mounted, { action: 'claim', id: requirement.id })
    const storedRecord = () => mounted.domain.table('requirements').get(requirement.id)

    check('the mount subscribed to the job stream once for every owner', jobs.subscriptions.length === 1 && JSON.stringify(jobs.subscriptions[0].filter) === JSON.stringify({ owners: 'all' }))
    check('the mount registered both subagent edges', mounted.records.listeners.filter(entry => entry.event.startsWith('subagent/')).length === 2)
    check('the merge window is registered as an effect', mounted.records.effects.includes('requirement-board: execution sync window'))
    check('the mount registered the browser route as a prefix route', mounted.records.routes?.kind === 'prefix' && mounted.records.routes.path === '/api/requirement-board')

    jobs.emit(jobEvent('registered', { id: 'pwsh-22', status: 'running' }))
    await sleep(20)
    check('a job event through the subscription reaches the locked requirement', storedRecord().executions.some(unit => unit.ref === 'pwsh-22'))

    const results = await Promise.all(mounted.dispatch('subagent/start', { id: 'ses_child', provider: 'in-process', local: true }))
    check('the subagent edge the mount registered writes through the same service', results.length === 1 && storedRecord().executions.some(unit => unit.ref === 'ses_child'))
    check('the subagent edge settles without rejecting into the lifecycle that emitted it', results.every(value => value !== undefined))

    // The producer subscription is the piece an HMR replacement must give back, so
// this disposes exactly that registration and leaves the rest of the mount up:
// the board is still readable, which is what makes the "not observed" claim
// below a real observation rather than a stored object's memory.
    mounted.disposeLabel('requirement-board: execution sync')
    check('disposal calls the subscription\'s disposer', jobs.subscriptions[0].active === false)
    check('disposal touches only the registration it owns', mounted.records.listeners.filter(entry => entry.event.startsWith('subagent/')).length === 2)
    jobs.emit(jobEvent('registered', { id: 'pwsh-23' }))
    await sleep(10)
    check('an event after disposal is not observed', storedRecord().executions.every(unit => unit.ref !== 'pwsh-23'))

    const subagentAfter = await Promise.all(mounted.dispatch('subagent/start', { id: 'ses_child-2', provider: 'in-process' }))
    check('the rest of the mount still observes', subagentAfter.length === 1 && storedRecord().executions.some(unit => unit.ref === 'ses_child-2'))
    mounted.disposeAll()
    check('disposing the whole mount removes every listener it registered', mounted.records.listeners.length === 0)
    await mounted.close()
  })
}

/** The optional hard gate refuses execution tools and delegates everything else. */
async function caseExecutionGate(backend, name) {
  await onBackend(backend, name, async dir => {
    const mounted = await openLiveBoard(backend, dir, { config: resolveConfig({ requireLockForExecution: true, executionSync: false }) })
    const gate = mounted.records.listeners.find(entry => entry.event === 'tools/pre-execute')
    check('the gate mounts as the pre-execute listener when it is switched on', gate !== undefined)

    let nexted = 0
    const next = async () => {
      nexted += 1
      return { kind: 'allow' }
    }
    const refused = await gate.handler({ name: 'subagent', agent: { id: A.session } }, next)
    check('an execution tool without a lock is refused', refused.kind === 'deny')
    check('the refusal gives the way out instead of a dead end', refused.reason.includes('claim') && refused.reason.includes('requireLockForExecution'))
    check('a refused call never reached the rest of the chain', nexted === 0)

    const background = await gate.handler({ name: 'pwsh', agent: { id: A.session } }, next)
    check('a background-job tool is refused the same way', background.kind === 'deny' && nexted === 0)

    const requirement = await callTool(mounted, { action: 'create', summary: '测试简述', title: '门禁放行' })
    await callTool(mounted, { action: 'claim', id: requirement.id })
    const allowed = await gate.handler({ name: 'pwsh', agent: { id: A.session } }, next)
    check('the same call is allowed once the session holds a lock', nexted === 1 && allowed.kind === 'allow')
    check('the allowed branch returned what the chain produced, unchanged', JSON.stringify(allowed) === JSON.stringify({ kind: 'allow' }))
    const boardTool = await gate.handler({ name: 'requirement_board', agent: { id: A.session } }, next)
    check('the board\'s own tool is never gated, lock or no lock', boardTool.kind === 'allow' && nexted === 2)
    const other = await gate.handler({ name: 'web_search', agent: { id: B.session } }, next)
    check('a non-execution tool is never gated', other.kind === 'allow' && nexted === 3)
    await mounted.close()

    const offDir = await makeTempDir('requirement-board-gateoff-')
    const off = await openLiveBoard(backend, offDir, { config: resolveConfig({ requireLockForExecution: false, executionSync: false }) })
    check('switching the gate off registers no pre-execute listener', off.records.listeners.every(entry => entry.event !== 'tools/pre-execute'))
    await off.close()
    await removeTempDir(offDir)
  })
}

/**
 * A record whose stored kind is not a task cannot be claimed.
 *
 * `claim` and the claimable pool use one criterion, so a kind the write path
 * never produced — a hand-written record, a medium edited outside this plugin —
 * is refused by both instead of being lockable through one and invisible to the
 * other.
 */
async function caseIllegalKind(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: portsFor() })
    const requirement = await board.service.createRequirement({ summary: '测试简述', title: '非法 kind' }, A)
    const legal = await board.service.createRequirement({ summary: '测试简述', title: '合法任务' }, A)
    const records = board.domain.table('requirements')
    await records.put(requirement.id, { ...records.get(requirement.id), kind: 'epic' })

    const refused = await reporter.rejects('a stored kind that is not a task cannot be claimed', () => board.service.claim(requirement.id, {}, A), 'forbidden')
    check('the refusal names the kind rather than a missing lock', refused.details?.reason === 'invalid-kind' && refused.details?.kind === 'epic')
    check('the refused claim left no lock behind', records.get(requirement.id).lock === null)
    check('the session pool does not offer it either', board.service.listRequirements({ claimable: true }, A.session).items.every(item => item.id !== requirement.id))
    check('the panel pool excludes it as well', board.service.listRequirements({ claimable: true }, '').items.every(item => item.id !== requirement.id))
    // One reading of the same data: the pool already treats the stored kind as no
    // kind at all, so the statistics must not invent a third bucket for it.
    const stats = board.service.stats()
    const pool = board.service.listRequirements({ claimable: true }, A.session).items.map(item => item.id)
    check('the statistics keep exactly the declared kinds', Object.keys(stats.byKind).sort().join(',') === 'decision,task', JSON.stringify(stats.byKind))
    check('and count the same records the pool offers', stats.byKind.task === 1 && stats.byKind.decision === 0 && pool.join(',') === legal.id, JSON.stringify({ byKind: stats.byKind, pool }))
    await board.close()
  })
}

/**
 * A delegated decision is never advertised as claimable work (§4.5).
 *
 * Only the panel may delegate a decision, and no session can claim one, so the
 * prompt must not send a session after it: it stays in the human's section.
 */
async function caseDelegatedDecision(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: portsFor() })
    const question = await board.service.createRequirement({ summary: '测试简述', title: '谁来决定', kind: 'decision' }, A)
    await board.service.delegate(question.id, { session: B.session, duties: ['答'] }, { session: '', name: '面板' })
    const prompt = board.service.promptContext(B.session, 12)
    check('a delegated decision is not put in "Delegated to you"', !prompt.includes('Delegated to you'))
    check('and the session is not told to claim it', !prompt.includes('claim it before you start'))
    check('the decision is still shown as waiting on the human', prompt.includes(question.id) && prompt.includes('Waiting on the human'))
    const refused = await reporter.rejects('the named session still cannot claim it', () => board.service.claim(question.id, {}, B), 'forbidden')
    check('the refusal is the decision rule, not a missing lock', refused.details?.reason === 'decision-task')
    await board.close()
  })
}

/**
 * An update that changes no field is not a write (§4.1).
 *
 * Advance a revision for a request that changed nothing and another session's
 * `expectedRev` fails over a no-op. A stale revision is still refused first, and
 * a value sent under a name the tool schema does not declare is not applied at
 * all — the tool reads only its declared parameters.
 */
async function caseEmptyUpdate(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: portsFor() })
    const requirement = await lockedRequirement(board, '空更新')
    const before = board.service.getRequirement(requirement.id, A.session)
    const changesBefore = board.changes.length

    const empty = await board.service.updateRequirement(requirement.id, {}, A)
    check('an empty patch is not a write', empty.rev === before.rev && empty.history.length === before.history.length)
    check('and it commits nothing to the medium', board.changes.length === changesBefore)
    const same = await board.service.updateRequirement(requirement.id, { title: before.title, priority: before.priority }, A)
    check('a patch that repeats the stored values is not a write either', same.rev === before.rev && board.changes.length === changesBefore)
    check('the previous revision is still the current one', board.domain.table('requirements').get(requirement.id).rev === before.rev)

    const real = await board.service.updateRequirement(requirement.id, { priority: 'urgent' }, A)
    check('a real change writes and moves the revision', real.priority === 'urgent' && real.rev === before.rev + 1)
    await reporter.rejects('a stale revision is refused even for a patch that changes nothing', () => board.service.updateRequirement(requirement.id, { title: before.title, expectedRev: before.rev }, A), 'conflict')

    // The tool path, over the same store: the value is sent under a name the schema
    // does not declare, so it is not applied and the revision does not move.
    const mounted = createFiberContext({ storageDomain: { open: async () => board.domain }, logger: createRecordingLogger() })
    await applyBoardPlugin(mounted.ctx, resolveConfig({ executionSync: false }))
    const ignored = await callTool(mounted, { action: 'update', id: requirement.id, patch: { priority: 'normal' } })
    check('a value under an undeclared name is not applied', ignored.priority === 'urgent' && ignored.rev === real.rev)
    await board.close()
  })
}

/** Step 0.1: the role filter is one clause over the stored routing. */
async function caseRoleFilter(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: {} })
    const service = board.service
    await service.createRequirement({ summary: '测试简述', title: '无角色' }, A)
    const art = await service.createRequirement({ summary: '测试简述', title: '美术', role: 'art' }, A)
    const human = await service.createRequirement({ summary: '测试简述', title: '等人的问题', kind: 'decision', role: 'human' }, A)
    const delegated = await service.createRequirement({ summary: '测试简述', title: '派发中' }, A)
    await service.claim(delegated.id, {}, A)
    await service.release(delegated.id, {}, A)
    await service.delegate(delegated.id, { session: B.session, duties: ['跑'] }, A)
    const tmpRole = service.getRequirement(delegated.id, '').delegatedTo.roleId

    const byHuman = service.listRequirements({ role: 'human' }, A.session)
    check('role "human" is the human\'s inbox', byHuman.items.length === 1 && byHuman.items[0].id === human.id)
    const byArt = service.listRequirements({ role: 'art' }, A.session)
    check('a delegated requirement no longer answers to the role it was created with', byArt.items.length === 1 && byArt.items[0].id === art.id && byArt.items.every(item => item.id !== delegated.id))
    const byTmp = service.listRequirements({ role: tmpRole }, A.session)
    check('the temporary role names the requirement it is running', byTmp.items.length === 1 && byTmp.items[0].id === delegated.id)
    check('an unknown role matches nothing instead of failing', service.listRequirements({ role: 'nobody' }, A.session).items.length === 0)
    await reporter.rejects('a malformed role filter is refused', () => Promise.resolve(service.listRequirements({ role: '不 合法' }, A.session)), 'invalid-role')

    const command = await dispatchBoardCommand(service, { action: 'list', role: 'human' })
    check('the panel command carries the role filter', command.items.length === 1 && command.items[0].id === human.id)
    const route = createBoardHandler(service, () => undefined)
    const res = fakeResponse()
    await route(fakeRequest({}, 'GET', '/api/requirement-board/snapshot?role=human'), res)
    const payload = JSON.parse(res.body)
    check('the snapshot route carries the role filter', res.status === 200 && payload.data.requirements.length === 1 && payload.data.requirements[0].id === human.id)

    const mounted = createFiberContext({ storageDomain: { open: async () => board.domain } })
    await applyBoardPlugin(mounted.ctx, resolveConfig({ executionSync: false }))
    const tool = mounted.records.tools.find(candidate => candidate.name === 'requirement_board')
    const listed = await tool.execute({ action: 'list', role: 'human' }, { agent: { id: A.session } })
    check('the tool carries the role filter', listed.items.length === 1 && listed.items[0].id === human.id)
    check('the tool describes role as a filter as well as a write field', tool.parameters.properties.role.description.includes('as a filter'))
    await board.close()
  })
}

/** Step 0.2: the queue order has one source, and the panel reads that source. */
async function caseQueueView(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: {} })
    const service = board.service
    const first = await service.createRequirement({ summary: '测试简述', title: '第一个' }, A)
    const second = await service.createRequirement({ summary: '测试简述', title: '第二个' }, A)
    const other = await service.createRequirement({ summary: '测试简述', title: '别人的' }, B)

    const queuedFirst = await service.queue(first.id, {}, A)
    await service.queue(second.id, {}, A)
    await service.queue(other.id, {}, B)
    const snapshot = service.snapshot({}, '')
    const rowA = snapshot.queues.find(row => row.session === A.session)
    const rowB = snapshot.queues.find(row => row.session === B.session)
    check('the snapshot projects every session\'s queue', snapshot.queues.length === 2 && rowA !== undefined && rowB !== undefined)
    check('the projected head is the receipt\'s head', JSON.stringify(rowA.head) === JSON.stringify(queuedFirst.head) && rowA.head.id === first.id)
    check('the projected order is the stored order, not the panel\'s', rowA.items.map(item => item.id).join(',') === `${first.id},${second.id}`)
    check('a session\'s queue holds only its own reservations', rowB.items.length === 1 && rowB.items[0].id === other.id)
    check('the queue view carries no per-call field', rowA.changed === undefined && rowA.length === 2)

    const dropped = await service.unqueue(first.id, {}, A)
    check('the unqueue receipt names the next head', dropped.head.id === second.id && dropped.length === 1)
    const after = service.snapshot({}, '').queues.find(row => row.session === A.session)
    check('the panel agrees with the receipt about the new head', after.head.id === dropped.head.id && after.items.length === 1)
    check('the panel command reads the same projection', (await dispatchBoardCommand(service, { action: 'refresh' })).queues.length === 2)
    await board.close()
  })
}

/** Step 0.3: the platform trust judgement fences the route, with a fallback. */
async function caseRequestTrust(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: {} })
    const decisions = []
    const connection = {
      // The platform contract is the request facts, not the header bag: a fake
      // that accepted headers would agree with the defect the live route hit.
      requestRejection(request) {
        decisions.push(request)
        const marker = request?.headers?.['x-test']
        return marker === 'none' ? undefined : marker === 'no-cookie' ? 401 : 403
      },
    }
    const route = createBoardHandler(board.service, () => connection)

    const anonymous = fakeResponse()
    await route(fakeRequest({ 'x-test': 'no-cookie' }), anonymous)
    check('a request the platform rejects as unauthenticated fails with 401', anonymous.status === 401)
    check('the 401 body carries the board\'s error envelope', JSON.parse(anonymous.body).error.code === 'unauthenticated')
    const crossOrigin = fakeResponse()
    await route(fakeRequest({ 'x-test': 'cross-site' }), crossOrigin)
    check('a request the platform rejects as untrusted fails with 403', crossOrigin.status === 403 && JSON.parse(crossOrigin.body).error.code === 'forbidden-origin')
    const trusted = fakeResponse()
    await route(fakeRequest({ 'x-test': 'none' }), trusted)
    check('a trusted request reaches the board', trusted.status === 200 && JSON.parse(trusted.body).ok === true)
    check('the platform judgement saw the request facts', decisions.length === 3 && decisions[0]?.headers?.['x-test'] === 'no-cookie')

    const fallback = createBoardHandler(board.service, () => undefined)
    const foreign = fakeResponse()
    await fallback(fakeRequest({ origin: 'http://evil.test' }), foreign)
    check('without the port the loopback Origin check still refuses', foreign.status === 403)
    const loopback = fakeResponse()
    await fallback(fakeRequest({ origin: 'http://127.0.0.1:3080' }), loopback)
    check('a loopback Origin is accepted by the fallback', loopback.status === 200)
    const noOrigin = fakeResponse()
    await fallback(fakeRequest({}), noOrigin)
    check('a request without an Origin is accepted, as before', noOrigin.status === 200)
    await board.close()
  })
}

/** The prompt's execution section is the model-visible half of the same state. */
async function casePromptExecutionSection(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, config: resolveConfig({}), ports: portsFor() })
    const requirement = await lockedRequirement(board, '执行中提示')
    const idle = board.service.promptContext(A.session, 12)
    check('a locked requirement appears under Executing now even when nothing runs', idle.includes('Executing now (1 held by you)') && idle.includes(requirement.id))
    // A fresh `startedAt`, so the age the section prints is the one a just-started
// unit reads: the older fixtures pin a stamp months in the past on purpose.
    await board.service.observeJobEvent(jobEvent('registered', { label: 'npm run build', startedAt: Date.now() }))
    const busy = board.service.promptContext(A.session, 12)
    check('the section names the executing unit and its age', busy.includes('job running') && busy.includes('0m'))
    check('another session does not see this one\'s lock as its own', !board.service.promptContext(B.session, 12).includes('held by you'))
    check('but it can still read the requirement as other work', board.service.promptContext(B.session, 12).includes(requirement.id))

    const offDir = await makeTempDir('requirement-board-promptoff-')
    const off = await openBoard({ backend, dir: offDir, config: resolveConfig({ executionSync: false }), ports: {} })
    const other = await off.service.createRequirement({ summary: '测试简述', title: '关闭' }, A)
    await off.service.claim(other.id, {}, A)
    check('a switched-off synchronizer says the lock is all that is known', off.service.promptContext(A.session, 12).includes('execution sync is off'))
    await off.close()
    await removeTempDir(offDir)
    await board.close()
  })
}

casePureHandlers()
for (const backend of BACKENDS) {
  await caseSubagentLifecycle(backend, 'a subagent edge is stored once, without moving rev')
  await caseExecutionSyncKeepsRev(backend, 'the execution revision never invalidates the CAS revision')
  await caseJobEvents(backend, 'job events fold in, output never stores, and the bound truncates')
  await caseUnobservedSettlement(backend, 'an unobserved settlement is a visible gap, not a guess')
  await caseUnitsSurviveReopen(backend, 'execution units are durable state')
  await caseClaimReconciles(backend, 'claim reconciles the session\'s jobs and reports what it cannot')
  await caseMissingRegistry(backend, 'missing registries warn once and mark the gap')
  await caseSettledOnLifecycleEnd(backend, 'disposal and revocation settle the units they own')
  await caseReadAmplification(backend, 'ten execution events cost the panel one frame')
  await caseMountWiringAndHmr(backend, 'the mount wires both producers and disposes cleanly')
  await caseExecutionGate(backend, 'the optional hard gate refuses and delegates')
  await caseIllegalKind(backend, 'a stored kind that is not a task is not claimable')
  await caseDelegatedDecision(backend, 'a delegated decision is never advertised as claimable')
  await caseEmptyUpdate(backend, 'an update that changes nothing writes nothing')
  await caseRoleFilter(backend, 'the role filter reads the stored routing')
  await caseQueueView(backend, 'the queue view and the receipts share one order')
  await caseRequestTrust(backend, 'the route prefers the platform trust judgement')
  await casePromptExecutionSection(backend, 'the prompt carries the execution section')
}

process.exit(reporter.finish() ? 0 : 1)
