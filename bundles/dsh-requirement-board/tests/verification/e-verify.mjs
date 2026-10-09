/**
 * Independent verification instrument for stage E (task-19), service and domain
 * level. Falsification view: every claim in `ROLE-DISPATCH.md` §9-E gets a case
 * built from the board's own service surface, with the execution producers
 * (subagent lifecycle, job registry) faked so an observation can be fired
 * deterministically.
 *
 * Run from the repository root:
 *   TSX_TSCONFIG_PATH=C:\code\deepseek-harness\tsconfig.json \
 *     node --import tsx/esm .artifacts/requirement-board/tests/verification/e-verify.mjs
 *
 * Switches:
 *   RB_E_BACKEND=sqlite     run against the sqlite medium (default json)
 *   RB_E_SERVICE=./_red-x/host/service.js   substitute a mutant service
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const HARNESS = new URL('../harness.mjs', import.meta.url)
const { openRawBoard, makeTempDir, removeTempDir, mediumPath, createRecordingLogger } = await import(HARNESS)
const { bootstrapRequirementBoard, requirementBoardDomain } = await import(new URL('../../host/domain.js', import.meta.url))
const { resolveConfig } = await import(new URL('../../host/config.js', import.meta.url))
const runs = await import(new URL('../../host/runs.js', import.meta.url))
const { apply } = await import(new URL('../../index.js', import.meta.url))
const { RequirementService } = await import(new URL(process.env.RB_E_SERVICE ?? '../../host/service.js', import.meta.url))

const BACKEND = process.env.RB_E_BACKEND ?? 'json'
const BOARD = new URL('../../', import.meta.url)

const lateRejections = []
process.on('uncaughtException', error => {
  lateRejections.push(`uncaught ${error?.code ?? ''} ${error?.message ?? ''}`)
  console.log(`UNCAUGHT ${error?.code ?? ''} ${error?.message ?? ''}`)
  console.log((error?.stack ?? '').split('\n').slice(0, 20).join('\n'))
  process.exitCode = 1
})
process.on('unhandledRejection', reason => {
  lateRejections.push(`unhandled ${reason?.code ?? ''} ${reason?.message ?? ''}`)
  console.log(`UNHANDLED ${reason?.code ?? ''} ${reason?.message ?? ''}`)
  console.log((reason?.stack ?? '').split('\n').slice(0, 20).join('\n'))
  process.exitCode = 1
})

let checks = 0
let failures = 0
const failed = []
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures += 1
  failed.push(label)
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  return false
}
function note(message) {
  console.log(`  note ${message}`)
}
async function attempt(operation) {
  try {
    return { value: await operation(), error: null }
  } catch (error) {
    return { value: undefined, error }
  }
}
async function refuses(label, expected, operation) {
  const { error } = await attempt(operation)
  if (error === null) {
    return check(label, false, 'the call resolved')
  }
  const code = `${error.code}/${error.details?.reason ?? ''}`
  const ok = error.code === expected.code && (expected.reason === undefined || error.details?.reason === expected.reason)
  return check(label, ok, ok ? code : `expected ${expected.code}/${expected.reason ?? ''}, received ${code}`)
}
async function allows(label, operation) {
  const { value, error } = await attempt(operation)
  return check(label, error === null, error === null ? '' : `${error.code}/${error.details?.reason ?? ''} ${error.message ?? ''}`)
}

/* ------------------------------------------------------------------ world */

const AI = { session: 'ses_e_worker', name: '甲' }
const AI2 = { session: 'ses_e_other', name: '乙' }
const PANEL = { session: '', name: '面板人' }

/**
 * Forward every committed domain write to the service's subscribers the way the
 * plugin does, so the SSE merge window is driven by the real write path.
 */
function forwardingDomain(domain, publish) {
  const wrapTable = name => {
    const table = domain.table(name)
    return new Proxy(table, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        if (property !== 'put' && property !== 'update' && property !== 'delete') return value.bind(target)
        return async (...args) => {
          const result = await value.apply(target, args)
          publish({ domain: requirementBoardDomain.name, table: name, key: String(args[0] ?? ''), operation: property })
          return result
        }
      },
    })
  }
  const wrapGlobal = () => {
    const global = domain.global
    return new Proxy(global, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        if (property !== 'set') return value.bind(target)
        return async (...args) => {
          const result = await value.apply(target, args)
          publish({ domain: requirementBoardDomain.name, table: 'global', key: 'global', operation: 'set' })
          return result
        }
      },
    })
  }
  return new Proxy(domain, {
    get(target, property) {
      if (property === 'table') return wrapTable
      if (property === 'global') return wrapGlobal()
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Open one board the way the plugin does, with fake execution producers.
 * @param options - `config` overrides, `jobs` registry fake, `owners` map used
 * by the ownership predicate, `coalesce` (subscribe to frames).
 */
async function openWorld({ config = {}, jobs, agents = { get: () => undefined, isOwnedBy: () => false }, owners = new Map(), forward = true, dir: reuse } = {}) {
  const dir = reuse ?? await makeTempDir('e-verify-')
  const opened = await openRawBoard({ backend: BACKEND, dir })
  await bootstrapRequirementBoard(opened.domain, { importLegacy: false })
  const frames = []
  let service
  const domain = forward
    ? forwardingDomain(opened.domain, change => service.publishDomainChange(change))
    : opened.domain
  service = new RequirementService({
    domain,
    config: resolveConfig({ executionSync: true, sseCoalesceMs: 30, ...config }),
    ports: {
      jobs: () => jobs,
      agents: () => agents,
      presets: () => undefined,
      owns: (target, caller) => owners.get(target) === caller,
    },
  })
  const unsubscribe = service.subscribe(frame => frames.push(frame))
  if (!service.listTemplates().items.some(entry => entry.id === 'tpl-e')) {
    await allows('the verification template is created', () => service.createTemplate({
      id: 'tpl-e',
      name: '验证流程',
      nodes: [{ id: 'n1', name: '一' }, { id: 'n2', name: '二' }, { id: 'n3', name: '三' }],
    }, PANEL))
  }
  return { dir, opened, domain, service, frames, unsubscribe, jobs, agents, owners, reuse }
}

async function closeWorld(world) {
  world.unsubscribe()
  world.service.close()
  await world.opened.close()
  if (world.reuse === undefined) await removeTempDir(world.dir)
}

/** Create one requirement on the verification template. */
async function task(world, title, extra = {}, actor = PANEL) {
  const created = await world.service.createRequirement({ summary: '测试简述', title, templateId: 'tpl-e', ...extra }, actor)
  return created.id
}

/** A fake job registry: `list(session)` plus a recording event subscription. */
function fakeJobs({ list = [], listError } = {}) {
  const subscribers = []
  let current = list
  return {
    subscribers,
    /** Replace what `list` would return, as a replacement registry would. */
    setList(next) { current = next },
    list: session => {
      if (listError !== undefined) throw listError
      return (current ?? []).filter(job => job.owner === session)
    },
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

/** A job payload as the registry would project it. */
function job(id, owner, status = 'running', extra = {}) {
  return { id, owner, status, label: `任务 ${id}`, progress: '', detail: '', startedAt: Date.now(), ...extra }
}

/** Read the stored record without presentation. */
function raw(world, id) {
  return world.opened.domain.table('requirements').get(id)
}

/* ------------------------------------------------- [1] rev discipline (§9-E) */

console.log('\n[1] execution writes move execRev and leave rev, updatedAt and history alone')
{
  const world = await openWorld()
  try {
    const id = await task(world, 'rev 纪律')
    await allows('the session claims the requirement', () => world.service.claim(id, {}, AI))
    const before = raw(world, id)
    const heldRev = before.rev
    const historyBefore = (before.history ?? []).length
    note(`after claim: rev=${heldRev} execRev=${before.execRev ?? 0} history=${historyBefore}`)

    const subjects = []
    for (let index = 0; index < 5; index += 1) {
      const subject = `sub_${index}`
      subjects.push(subject)
      world.owners.set(subject, AI.session)
      await world.service.observeSubagent({ id: subject, provider: 'deepseek' }, 'start')
    }
    for (let index = 0; index < 5; index += 1) {
      await world.service.observeJobEvent({ type: 'registered', job: job(`job_${index}`, AI.session) })
    }

    const after = raw(world, id)
    check('ten execution events wrote ten execRev steps', after.execRev === 10, `execRev=${after.execRev}`)
    check('the record revision did not move', after.rev === heldRev, `rev=${after.rev} held=${heldRev}`)
    check('updatedAt did not move', after.updatedAt === before.updatedAt, `${after.updatedAt} vs ${before.updatedAt}`)
    check('history did not grow', (after.history ?? []).length === historyBefore, `${(after.history ?? []).length}`)
    check('ten units are stored', (after.executions ?? []).length === 10, `${(after.executions ?? []).length}`)
    check('running counts the ten live units', world.service.getRequirement(id, AI.session).running === 10, `running=${world.service.getRequirement(id, AI.session).running}`)

    // The Lead's exact case: a transition holding the pre-observation revision
    // must still commit.
    const stale = await attempt(() => world.service.transitionRequirement(id, { action: 'advance', expectedRev: heldRev }, AI))
    check(
      'a transition holding the pre-observation revision still commits',
      stale.error === null && world.service.getRequirement(id, AI.session).nodeId === 'n2',
      stale.error === null ? `node=${world.service.getRequirement(id, AI.session).nodeId}` : `${stale.error.code}/${stale.error.details?.reason ?? ''}`,
    )
    await refuses('the same revision is stale after the transition', { code: 'conflict' }, () => world.service.transitionRequirement(id, { action: 'advance', expectedRev: heldRev }, AI))
    const late = raw(world, id)
    check('the transition is the only thing that moved rev', late.rev === heldRev + 1, `rev=${late.rev}`)
    check('a flow transition leaves execRev alone too', late.execRev === 10, `execRev=${late.execRev}`)
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------ [2] attribution and write discipline */

console.log('\n[2] lockless events count as ignored, repeats write nothing, output stores nothing')
{
  const world = await openWorld({ jobs: fakeJobs({ list: [] }) })
  try {
    const id = await task(world, '写纪律')
    await world.service.claim(id, {}, AI)
    const before = raw(world, id)
    const ignoredBefore = world.service.stats().execSync.ignored
    const revisionBefore = world.service.snapshot({ limit: 1 }).revision

    const lockless = await world.service.observeSubagent({ id: 'ses_e_ghost', provider: 'deepseek' }, 'start')
    check('a lockless observation is ignored, not stored', lockless.stored === false && lockless.ignored === true, JSON.stringify(lockless))
    check('the ignored counter moved', world.service.stats().execSync.ignored === ignoredBefore + 1, `ignored=${world.service.stats().execSync.ignored}`)
    check('the board revision did not move for a counter', world.service.snapshot({ limit: 1 }).revision === revisionBefore, `revision=${world.service.snapshot({ limit: 1 }).revision}`)
    check('nothing was stored on any record', (raw(world, id).executions ?? []).length === 0, `${(raw(world, id).executions ?? []).length}`)

    world.owners.set('sub_repeat', AI.session)
    const first = await world.service.observeSubagent({ id: 'sub_repeat', provider: 'deepseek' }, 'start')
    const execAfterFirst = raw(world, id).execRev
    check('the first observation stores', first.stored === true, JSON.stringify(first))
    const second = await world.service.observeSubagent({ id: 'sub_repeat', provider: 'deepseek' }, 'start')
    check('a repeat of the same start writes nothing', second.stored === false && raw(world, id).execRev === execAfterFirst, `stored=${second.stored} execRev=${raw(world, id).execRev} (was ${execAfterFirst})`)
    const third = await world.service.observeSubagent({ id: 'sub_repeat', provider: 'deepseek' }, 'end')
    check('the first end stores the terminal status', third.stored === true, JSON.stringify(third))
    const execAfterEnd = raw(world, id).execRev
    const fourth = await world.service.observeSubagent({ id: 'sub_repeat', provider: 'deepseek' }, 'end')
    check('a repeat of the same terminal status writes nothing', fourth.stored === false && raw(world, id).execRev === execAfterEnd, `stored=${fourth.stored} execRev=${raw(world, id).execRev} (was ${execAfterEnd})`)

    await world.service.observeJobEvent({ type: 'registered', job: job('job_out', AI.session) })
    const execBeforeOutput = raw(world, id).execRev
    const bytesBefore = BACKEND === 'json' ? readFileSync(mediumPath('json', world.dir)) : undefined
    const output = await world.service.observeJobEvent({
      type: 'output',
      job: job('job_out', AI.session, 'running', { output: { from: 0, to: 5_000_000, bytes: 5_000_000 } }),
    })
    check('an output event stores nothing and is not "ignored"', output.stored === false && output.ignored === false, JSON.stringify(output))
    check('the execRev did not move for output', raw(world, id).execRev === execBeforeOutput, `execRev=${raw(world, id).execRev}`)
    const unit = (raw(world, id).executions ?? []).find(candidate => candidate.ref === 'job_out')
    check('no stored unit carries an output field', unit !== undefined && !Object.hasOwn(unit, 'output'), JSON.stringify(Object.keys(unit ?? {})))
    if (bytesBefore !== undefined) {
      const bytesAfter = readFileSync(mediumPath('json', world.dir))
      check('the medium is byte-identical after an output event', bytesBefore.equals(bytesAfter), `${bytesBefore.length} vs ${bytesAfter.length}`)
    }

    const ignoredNow = world.service.stats().execSync.ignored
    await world.service.observeJobEvent({ type: 'output', job: job('job_lockless', 'ses_e_nobody') })
    check('an output event from a lockless owner is not counted either', world.service.stats().execSync.ignored === ignoredNow, `ignored=${world.service.stats().execSync.ignored}`)
    const removed = await world.service.observeJobEvent({ type: 'removed', job: job('job_gone', AI.session) })
    check('a removed settlement of a stored running unit is left alone', removed.stored === true && raw(world, id).sync.gap === true, JSON.stringify({ stored: removed.stored, gap: raw(world, id).sync.gap }))
    check('the sync view reports the stored gap', world.service.getRequirement(id, AI.session).sync.gap === true, JSON.stringify(world.service.getRequirement(id, AI.session).sync))
    note(`the sync reason is ${JSON.stringify(world.service.getRequirement(id, AI.session).sync.reason)} (this world injects no agent registry, which the view names first)`)
    check('nothing was written for the record fields', raw(world, id).rev === before.rev, `rev=${raw(world, id).rev}`)
  } finally {
    await closeWorld(world)
  }
}

/* -------------------------- [3] gaps, truncation and claim reconciliation */

console.log('\n[3] missing registry warns once, maxExecutions truncates, claim reconciles')
{
  const dir = await makeTempDir('e-verify-')
  const world = await openWorld({ dir, jobs: undefined, agents: undefined, config: { executionSync: true } })
  try {
    const id = await task(world, '缺注册表')
    const revBefore = raw(world, id).rev
    const logger = createRecordingLogger()
    const service = new RequirementService({
      domain: world.domain,
      config: resolveConfig({ executionSync: true }),
      ports: { jobs: () => undefined, agents: () => undefined },
      logger,
    })
    const missing = service.assertExecutionPorts()
    check('the missing ports are named in a stable order', JSON.stringify(missing) === JSON.stringify(['jobs', 'agents']), JSON.stringify(missing))
    service.assertExecutionPorts()
    service.assertExecutionPorts()
    check('the warning is emitted exactly once', logger.lines.warn.length === 1, `${logger.lines.warn.length}: ${logger.lines.warn.join(' | ')}`)
    const view = service.getRequirement(id, PANEL.session).sync
    check('the derived view reports the gap without a stored mark', view.enabled === true && view.gap === true && view.reason === 'missing-registry-jobs-agents', JSON.stringify(view))
    check('a missing registry does not write a requirement', raw(world, id).rev === revBefore && raw(world, id).sync === undefined, JSON.stringify(raw(world, id).sync))
    check('a missing registry does not move the gap counter', service.stats().execSync.gaps === 0, `gaps=${service.stats().execSync.gaps}`)

    const bound = await openWorld({ config: { maxExecutions: 5 } })
    try {
      const bounded = await task(bound, '上限')
      await bound.service.claim(bounded, {}, AI)
      for (let index = 0; index < 6; index += 1) {
        await bound.service.observeJobEvent({ type: 'registered', job: job(`job_cap_${index}`, AI.session) })
      }
      const stored = raw(bound, bounded)
      check('the unit list is bounded to maxExecutions', (stored.executions ?? []).length === 5, `${(stored.executions ?? []).length}`)
      check('the record is marked truncated', stored.executionsTruncated === true, `${stored.executionsTruncated}`)
      check('the oldest unit was dropped', !(stored.executions ?? []).some(unit => unit.ref === 'job_cap_0'), JSON.stringify((stored.executions ?? []).map(unit => unit.ref)))
      check('the newest unit was kept', (stored.executions ?? []).some(unit => unit.ref === 'job_cap_5'), JSON.stringify((stored.executions ?? []).map(unit => unit.ref)))
    } finally {
      await closeWorld(bound)
    }

    // Reconciliation: a job that started while nothing was listening exists only
    // in jobs.list, and a stored running unit the registry no longer lists is a
    // settlement that was missed.
    const registry = fakeJobs({ list: [] })
    const recon = await openWorld({ jobs: registry })
    try {
      const target = await task(recon, '对账')
      await recon.service.claim(target, {}, AI)
      await recon.service.observeJobEvent({ type: 'registered', job: job('job_stale', AI.session) })
      registry.setList([job('job_live', AI.session)])
      const receipt = await recon.service.reconcileSession(AI.session, target)
      note(`recon port resolution: resolver=${typeof recon.service.ports.jobs} resolved=${typeof recon.service.ports.jobs()} list=${typeof recon.jobs?.list}`)
      const stored = raw(recon, target)
      const refs = (stored.executions ?? []).map(unit => unit.ref)
      check('reconciliation added the live job the stream never saw', refs.includes('job_live'), JSON.stringify(refs))
      check('reconciliation reports the unobserved settlement', receipt.reason === 'unobserved-settlement', JSON.stringify(receipt))
      check('the stored gap marks the lost observation', stored.sync.gap === true, JSON.stringify(stored.sync))
      check('it left the unobserved unit rather than inventing an outcome', (stored.executions ?? []).some(unit => unit.ref === 'job_stale' && unit.status === 'running'), JSON.stringify((stored.executions ?? []).map(unit => [unit.ref, unit.status])))
      check('the sync view names the lost observation', recon.service.getRequirement(target, AI.session).sync.reason === 'unobserved-settlement', JSON.stringify(recon.service.getRequirement(target, AI.session).sync))

      // The claim path runs the same reconciliation: a job already registered
      // when the claim lands appears with no event at all.
      const second = await task(recon, '领时对账')
      registry.setList([job('job_pre', AI2.session)])
      await allows('the second claim lands', () => recon.service.claim(second, {}, AI2))
      check('claim reconciliation folds in a job registered before the claim', (raw(recon, second).executions ?? []).some(unit => unit.ref === 'job_pre'), JSON.stringify((raw(recon, second).executions ?? []).map(unit => unit.ref)))

      // A voluntary release is not disposal: the units stay, and only a later
      // claim can repair the gap a missed settlement left.
      await recon.service.release(second, {}, AI2)
      const released = (raw(recon, second).executions ?? []).map(unit => [unit.ref, unit.status])
      note(`after a voluntary release the units read ${JSON.stringify(released)}`)
      check('a voluntary release keeps the units it did not observe ending', released.every(([, status]) => status === 'running') || released.length === 0, JSON.stringify(released))

      const broken = fakeJobs({ listError: new Error('registry offline') })
      const failing = await openWorld({ jobs: broken })
      try {
        const id2 = await task(failing, '坏注册表')
        const claimed = await attempt(() => failing.service.claim(id2, {}, AI))
        check('a broken registry does not fail the claim', claimed.error === null, claimed.error === null ? '' : `${claimed.error.code}`)
        check('the lost observation is marked as a gap', raw(failing, id2).sync?.gap === true, JSON.stringify(raw(failing, id2).sync))
        check('the gap counter moved once', failing.service.stats().execSync.gaps === 1, `gaps=${failing.service.stats().execSync.gaps}`)
      } finally {
        await closeWorld(failing)
      }
    } finally {
      await closeWorld(recon)
    }
  } finally {
    world.reuse = dir
    await closeWorld(world)
    await removeTempDir(dir)
  }
}

/* --------------------------------------------- [4] read amplification (§4.1) */

console.log('\n[4] ten execution events cost one frame; sseCoalesceMs 0 does not merge; a transition is not swallowed')
{
  const world = await openWorld({ config: { sseCoalesceMs: 500 } })
  try {
    const id = await task(world, '合并')
    await world.service.claim(id, {}, AI)
    world.frames.length = 0
    const burstStart = Date.now()
    for (let index = 0; index < 10; index += 1) {
      await world.service.observeJobEvent({ type: 'registered', job: job(`job_merge_${index}`, AI.session) })
    }
    const burstMs = Date.now() - burstStart
    const revisionAfterBurst = world.service.snapshot({ limit: 1 }).revision
    const immediate = world.frames.length
    await new Promise(resolve => setTimeout(resolve, 700))
    note(`ten execution writes took ${burstMs}ms inside a 500ms window`)
    check('ten execution writes delivered exactly one frame', world.frames.length === 1, `${world.frames.length} frames (immediate ${immediate}, burst ${burstMs}ms)`)
    check('the merged frame carries the newest revision', world.frames[0]?.revision === revisionAfterBurst, JSON.stringify({ frame: world.frames[0], revisionAfterBurst }))

    // A definition write must not wait on the merge window.
    world.frames.length = 0
    for (let index = 0; index < 10; index += 1) {
      await world.service.observeJobEvent({ type: 'registered', job: job(`job_merge_b_${index}`, AI.session) })
    }
    const framesBeforeTransition = world.frames.length
    await world.service.transitionRequirement(id, { action: 'advance' }, AI)
    const framesAfterTransition = world.frames.length
    check('a transition is delivered without waiting for the window', framesAfterTransition > framesBeforeTransition, `${framesBeforeTransition} -> ${framesAfterTransition}`)
    check('the transition is visible immediately', world.service.getRequirement(id, AI.session).nodeId === 'n2', world.service.getRequirement(id, AI.session).nodeId)
    await new Promise(resolve => setTimeout(resolve, 700))
    check('the queued execution frame is still delivered afterwards', world.frames.length >= 3, `${world.frames.length}`)
  } finally {
    await closeWorld(world)
  }

  const plain = await openWorld({ config: { sseCoalesceMs: 0 } })
  try {
    const id = await task(plain, '不合并')
    await plain.service.claim(id, {}, AI)
    plain.frames.length = 0
    for (let index = 0; index < 10; index += 1) {
      await plain.service.observeJobEvent({ type: 'registered', job: job(`job_plain_${index}`, AI.session) })
    }
    await new Promise(resolve => setTimeout(resolve, 60))
    check('sseCoalesceMs 0 forwards every domain change', plain.frames.length === 20, `${plain.frames.length}`)
    note('without coalescing each execution write forwards two frames: the record and its global revision')
  } finally {
    await closeWorld(plain)
  }
}

/* ------------------------------------------- [5] executionSync off and on */

console.log('\n[5] executionSync false reports itself and can be switched back on')
{
  const dir = await makeTempDir('e-verify-')
  const off = await openWorld({ dir, config: { executionSync: false } })
  try {
    const id = await task(off, '关闭同步')
    check('the sync view says sync is off', JSON.stringify(off.service.getRequirement(id, PANEL.session).sync) === JSON.stringify({ enabled: false, gap: false, syncedAt: null, reason: 'execution-sync-disabled' }), JSON.stringify(off.service.getRequirement(id, PANEL.session).sync))
    const observed = await off.service.observeSubagent({ id: 'sub_off', provider: 'x' }, 'start')
    check('no observation is stored while sync is off', observed.stored === false && observed.ignored === false, JSON.stringify(observed))
    const reconciled = await off.service.reconcileSession(AI.session, id)
    check('reconciliation says sync is off', reconciled.reconciled === false && reconciled.reason === 'execution-sync-disabled', JSON.stringify(reconciled))
    check('settling is a no-op while sync is off', await off.service.settleExecutionUnits(id, 'because') === false, 'settle returned true')
  } finally {
    off.reuse = dir
    await closeWorld(off)
  }
  const on = await openWorld({ dir, config: { executionSync: true } })
  try {
    const id = await task(on, '恢复同步')
    check('the sync view reports enabled after reopening', on.service.getRequirement(id, PANEL.session).sync.enabled === true, JSON.stringify(on.service.getRequirement(id, PANEL.session).sync))
    await on.service.claim(id, {}, AI)
    const stored = await on.service.observeJobEvent({ type: 'registered', job: job('job_on', AI.session) })
    check('observations store again after reopening', stored.stored === true, JSON.stringify(stored))
  } finally {
    on.reuse = dir
    await closeWorld(on)
    await removeTempDir(dir)
  }
}

/* ------------------------------------------------- [6] ?role= filter (§9-E) */

console.log('\n[6] the role filter returns the exact set, and combines with claimable')
{
  const world = await openWorld()
  try {
    const one = await task(world, '角色一')
    const two = await task(world, '角色二')
    const three = await task(world, '无角色')
    const done = await task(world, '角色一已完成')
    await allows('the finished record is claimed before it is routed', () => world.service.claim(done, {}, AI))
    await allows('the finished record completes', () => world.service.transitionRequirement(done, { action: 'complete' }, AI))
    await allows('role one is assigned', () => world.service.updateRequirement(one, { role: 'role-e1' }, PANEL))
    await allows('role two is assigned', () => world.service.updateRequirement(two, { role: 'role-e2' }, PANEL))
    await allows('the finished record gets role one too', () => world.service.updateRequirement(done, { role: 'role-e1' }, PANEL))

    const filtered = world.service.listRequirements({ role: 'role-e1' })
    check('the role filter returns exactly the routing set', JSON.stringify(filtered.items.map(item => item.id).sort()) === JSON.stringify([one, done].sort()), JSON.stringify(filtered.items.map(item => item.id)))
    const open = world.service.listRequirements({ role: 'role-e1', status: 'open' })
    check('status open narrows it to the unfinished record', JSON.stringify(open.items.map(item => item.id)) === JSON.stringify([one]), JSON.stringify(open.items.map(item => item.id)))
    const claimable = world.service.listRequirements({ role: 'role-e1', claimable: true }, AI.session)
    check('claimable intersects the role filter instead of widening it', claimable.items.every(item => item.id === one), JSON.stringify(claimable.items.map(item => item.id)))
    const second = world.service.listRequirements({ role: 'role-e2' })
    check('the other role returns only its own record', JSON.stringify(second.items.map(item => item.id)) === JSON.stringify([two]), JSON.stringify(second.items.map(item => item.id)))
    const unrouted = world.service.listRequirements({ role: 'role-e1' }).items.length
    check('the unfiltered role is never in a role result', unrouted === 2, `${unrouted}`)
    const unknown = await attempt(() => world.service.listRequirements({ role: 'role-does-not-exist' }))
    check('an unknown role is an empty set, not an error', unknown.error === null && unknown.value.items.length === 0 && unknown.value.total === 0, unknown.error === null ? JSON.stringify({ total: unknown.value.total }) : `${unknown.error.code}/${unknown.error.details?.reason ?? ''}`)
    note('unknown role: empty set (no error) — the documented shape of a filter that matches nothing')
    const malformed = await attempt(() => world.service.listRequirements({ role: 'role e1!' }))
    check('a malformed role is refused or empty, never the whole board', malformed.error !== null || malformed.value.items.length === 0, malformed.error !== null ? `${malformed.error.code}` : `${malformed.value.items.length} items`)
    note(`malformed role: ${malformed.error === null ? 'empty set' : `${malformed.error.code}/${malformed.error.details?.reason ?? ''}`}`)
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------------------ [7] queue order and head */

console.log('\n[7] the snapshot queue order and the unqueue receipt share one source')
{
  const world = await openWorld()
  try {
    const first = await task(world, '排队一')
    const second = await task(world, '排队二')
    const third = await task(world, '排队三')
    await allows('the first reservation lands', () => world.service.queue(first, {}, AI))
    await allows('the second reservation lands', () => world.service.queue(second, {}, AI))
    await allows('the third reservation lands', () => world.service.queue(third, {}, AI))
    const row = world.service.snapshot({ limit: 50 }).queues.find(candidate => candidate.session === AI.session)
    check('the queue row keeps the reservation order', JSON.stringify(row.items.map(item => item.id)) === JSON.stringify([first, second, third]), JSON.stringify(row.items.map(item => item.id)))
    check('the head is the first stored item', row.head.id === row.items[0].id && row.head.id === first, JSON.stringify(row.head))
    const receipt = await world.service.unqueue(first, {}, AI)
    check('the unqueue receipt head matches the snapshot source', receipt.head.id === second && JSON.stringify(receipt.items.map(item => item.id)) === JSON.stringify([second, third]), JSON.stringify(receipt.head))
    const afterRow = world.service.snapshot({ limit: 50 }).queues.find(candidate => candidate.session === AI.session)
    check('the snapshot agrees with the receipt', JSON.stringify(afterRow.items.map(item => item.id)) === JSON.stringify(receipt.items.map(item => item.id)) && afterRow.head.id === receipt.head.id, JSON.stringify({ snapshot: afterRow.head, receipt: receipt.head }))
    const empty = await world.service.unqueue(third, {}, AI)
    check('clearing a tail item keeps the head', empty.head.id === second, JSON.stringify(empty.head))

    // The Lead's third case — a head locked by another session — is refused at
    // reservation time, so it cannot be built through the service at all.
    const lockedHead = await task(world, '已被别人上锁')
    await allows('the other session locks a record first', () => world.service.claim(lockedHead, {}, AI2))
    await refuses('reserving a record another session locked is refused', { code: 'conflict', reason: 'locked' }, () => world.service.queue(lockedHead, {}, AI))
    await refuses('reserving a record another session reserved is refused', { code: 'conflict', reason: 'reserved' }, () => world.service.queue(second, {}, AI2))
    const untouched = world.service.snapshot({ limit: 50 }).queues.find(candidate => candidate.session === AI.session)
    check('the refused reservation leaves the row untouched', JSON.stringify(untouched.items.map(item => item.id)) === JSON.stringify([second]), JSON.stringify(untouched.items.map(item => item.id)))
    const owned = await task(world, '自己上锁再排队')
    await allows('this session locks it', () => world.service.claim(owned, {}, AI))
    const selfLocked = await attempt(() => world.service.queue(owned, {}, AI))
    check('a target this session already holds the lock on is accepted into its own queue', selfLocked.error === null, selfLocked.error === null ? '' : `${selfLocked.error.code}/${selfLocked.error.details?.reason ?? ''}`)
    note('queue does not consult the caller\'s own lock: a record already locked by the same session can also be reserved, and the row head is then locked by its own session')
    const selfRow = await world.service.unqueue(owned, {}, AI)
    check('the redundant reservation can be taken back without touching the lock', !(selfRow.items ?? []).some(item => item.id === owned) && world.service.getRequirement(owned, AI.session).lock?.session === AI.session, JSON.stringify({ items: selfRow.items?.map(item => item.id), lock: world.service.getRequirement(owned, AI.session).lock }))
    check('a reserved item is never claimable by another session', world.service.getRequirement(second, AI2.session).claimable === false, JSON.stringify({ claimable: world.service.getRequirement(second, AI2.session).claimable }))
    note('a queue head locked by a third party is unreachable: reservation refuses a locked target, and a reserved item is refused to every other session — the head can only be locked by its own session')
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------- [8] F1: an unknown kind in the store */

console.log('\n[8] F1: an injected unknown kind is refused by claim, the pool, the vocabulary and the next open')
{
  const dir = await makeTempDir('e-verify-')
  const world = await openWorld({ dir })
  let injected = ''
  try {
    injected = await task(world, '非法 kind')
    const record = raw(world, injected)
    const forged = structuredClone(record)
    forged.kind = 'epic'
    forged.epicField = 1
    await world.opened.domain.table('requirements').put(injected, forged)
    check('the forged record is readable while the domain is open', raw(world, injected).kind === 'epic', `${raw(world, injected).kind}`)
    await refuses('claim refuses any non-task kind', { code: 'forbidden', reason: 'invalid-kind' }, () => world.service.claim(injected, {}, AI))
    const pool = world.service.listRequirements({ claimable: true }, AI.session)
    check('the pool does not offer it', !pool.items.some(item => item.id === injected), JSON.stringify(pool.items.map(item => item.id)))
    const byKind = world.service.stats().byKind
    check('the statistics vocabulary stays closed', JSON.stringify(Object.keys(byKind).sort()) === JSON.stringify(['decision', 'task']), JSON.stringify(byKind))
    const presented = world.service.getRequirement(injected, AI.session)
    check('it reads as unclaimable and not advanceable', presented.claimable === false && presented.advanceable === false, JSON.stringify({ claimable: presented.claimable, advanceable: presented.advanceable }))
  } finally {
    world.service.close()
    await world.opened.close()
  }
  const reopened = await attempt(() => openRawBoard({ backend: BACKEND, dir }))
  check('reopening a board that stores an unknown kind fails loud', reopened.error !== null && reopened.error.code === 'invalid-record', reopened.error === null ? 'the open was accepted' : `${reopened.error.code}: ${reopened.error.message}`)
  const diagnostic = reopened.error === null ? '' : String(reopened.error.message ?? '')
  check('the refusal names the offending field', /kind/.test(diagnostic), diagnostic.slice(0, 300))
  note(`the open refusal: ${diagnostic.slice(0, 300)}`)
  await attempt(() => reopened.value?.close())
  await removeTempDir(dir)
}

/* ------------------------------- [9] F3 diagnostics and F4 zero-write updates */

console.log('\n[9] F3 decision diagnostics and F4 zero-write updates')
{
  const world = await openWorld()
  try {
    const decision = (await world.service.createRequirement({ summary: '测试简述', title: '要拍板', kind: 'decision' }, PANEL)).id
    await refuses('checklist on a decision is refused as a decision', { code: 'forbidden', reason: 'decision-task' }, () => world.service.setChecklist(decision, { index: 0, checked: true }, AI))
    await refuses('block on a decision is refused as a decision', { code: 'forbidden', reason: 'decision-task' }, () => world.service.blockRequirement(decision, { reason: 'x' }, AI))
    await refuses('unblock on a decision is refused as a decision', { code: 'forbidden', reason: 'decision-task' }, () => world.service.unblockRequirement(decision, {}, AI))
    await refuses('transition on a decision is refused as a decision', { code: 'forbidden', reason: 'decision-task' }, () => world.service.transitionRequirement(decision, { action: 'advance' }, AI))

    const id = await task(world, '空更新')
    await world.service.claim(id, {}, AI)
    const before = raw(world, id)
    const bytesBefore = BACKEND === 'json' ? readFileSync(mediumPath('json', world.dir)) : undefined
    const revisionBefore = world.service.snapshot({ limit: 1 }).revision
    const empty = await world.service.updateRequirement(id, {}, AI)
    check('an empty patch reports the stored record', empty.id === id && empty.rev === before.rev, JSON.stringify({ rev: empty.rev }))
    check('an empty patch does not move rev', raw(world, id).rev === before.rev, `rev=${raw(world, id).rev}`)
    check('an empty patch writes no history', (raw(world, id).history ?? []).length === (before.history ?? []).length, `${(raw(world, id).history ?? []).length}`)
    check('an empty patch does not move updatedAt', raw(world, id).updatedAt === before.updatedAt, `${raw(world, id).updatedAt}`)
    check('an empty patch does not move the board revision', world.service.snapshot({ limit: 1 }).revision === revisionBefore, `${world.service.snapshot({ limit: 1 }).revision}`)
    await world.service.updateRequirement(id, { priority: before.priority, title: before.title }, AI)
    check('a same-value patch also writes nothing', raw(world, id).rev === before.rev && raw(world, id).updatedAt === before.updatedAt, JSON.stringify({ rev: raw(world, id).rev, updatedAt: raw(world, id).updatedAt }))
    if (bytesBefore !== undefined) {
      const bytesAfter = readFileSync(mediumPath('json', world.dir))
      check('the medium is byte-identical after the no-op updates', bytesBefore.equals(bytesAfter), `${bytesBefore.length} vs ${bytesAfter.length}`)
    }
    await refuses('a stale expectedRev is refused even for a no-op patch', { code: 'conflict' }, () => world.service.updateRequirement(id, { expectedRev: before.rev - 1, title: '别的' }, AI))
    await allows('a real change still commits', () => world.service.updateRequirement(id, { expectedRev: before.rev, title: '改了' }, AI))
    check('the real change moved rev exactly once', raw(world, id).rev === before.rev + 1, `rev=${raw(world, id).rev}`)
    check('the real change moved updatedAt', raw(world, id).updatedAt !== before.updatedAt, `${raw(world, id).updatedAt}`)
    note(`a plain field edit wrote no history entry (history=${(raw(world, id).history ?? []).length}, was ${(before.history ?? []).length}); only gate-link edits and locks append`)
    check('F5: the debug smoke file is gone from the tree', !existsSync(new URL('../../tests/_rb-debug-smoke.mjs', import.meta.url)), 'tests/_rb-debug-smoke.mjs still exists')
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------------ [10] the pure protocol module */

console.log('\n[10] runs.js protocol facts, driven without a context')
{
  check('the execution tool list names the execution tools only', runs.EXECUTION_TOOLS.includes('subagent') && runs.EXECUTION_TOOLS.includes('pwsh') && !runs.EXECUTION_TOOLS.includes('requirement_board'), JSON.stringify(runs.EXECUTION_TOOLS))
  check('the gate denies an execution tool from a lockless session', runs.executionGateDecision({ name: 'pwsh', session: 'ses_x', holdsLock: false })?.kind === 'deny', 'no denial')
  check('the gate allows the same call with the lock', runs.executionGateDecision({ name: 'pwsh', session: 'ses_x', holdsLock: true }) === undefined, 'denied')
  check('the gate ignores non-execution tools', runs.executionGateDecision({ name: 'requirement_board', session: 'ses_x', holdsLock: false }) === undefined, 'denied')
  check('the gate ignores a nameless session', runs.executionGateDecision({ name: 'pwsh', session: '', holdsLock: false }) === undefined, 'denied')
  check('the gate ignores a missing tool name', runs.executionGateDecision({ name: undefined, session: 'ses_x', holdsLock: false }) === undefined, 'denied')
  check('subagent stop reasons fold onto the unit vocabulary', runs.subagentStatus('completed') === 'completed' && runs.subagentStatus('aborted') === 'killed' && runs.subagentStatus('whatever') === 'failed', `${runs.subagentStatus('whatever')}`)
  const output = runs.unitFromJobEvent({ type: 'output', job: job('j', 'ses_x') }, { at: '2026-01-01T00:00:00.000Z' })
  check('an output event yields no unit and no gap', output.unit === undefined && output.gap === false, JSON.stringify(output))
  const removed = runs.unitFromJobEvent({ type: 'removed', job: job('j', 'ses_x') }, { at: '2026-01-01T00:00:00.000Z' })
  check('a removed event yields a gap and no unit', removed.unit === undefined && removed.gap === true, JSON.stringify(removed))
  const liveSettlement = runs.unitFromJobEvent({ type: 'settled', job: job('j', 'ses_x', 'running') }, { at: '2026-01-01T00:00:00.000Z' })
  check('a settlement that still reads running is stored as failed', liveSettlement.unit.status === 'failed', `${liveSettlement.unit.status}`)
  const stopping = runs.unitFromJobEvent({ type: 'registered', job: job('j', 'ses_x', 'stopping') }, { at: '2026-01-01T00:00:00.000Z' })
  check('a stopping projection is stored as stopping', stopping.unit.status === 'stopping', `${stopping.unit.status}`)
  check('updatedAt alone never warrants a write', runs.executionChanged({ status: 'running', progress: '', detail: '', updatedAt: 'a' }, { status: 'running', progress: '', detail: '', updatedAt: 'b' }) === false, 'a write was warranted')
  check('a status change warrants a write', runs.executionChanged({ status: 'running', progress: '', detail: '' }, { status: 'completed', progress: '', detail: '' }) === true, 'no write')
  const bounded = runs.applyExecution([{ ref: 'a', status: 'running' }, { ref: 'b', status: 'running' }], { ref: 'c', status: 'running' }, 2)
  check('applyExecution drops the oldest past the bound', bounded.units.length === 2 && bounded.units[0].ref === 'b' && bounded.truncated === true, JSON.stringify(bounded.units.map(unit => unit.ref)))
  check('runningCount counts running and stopping', runs.runningCount({ executions: [{ status: 'running' }, { status: 'stopping' }, { status: 'completed' }] }) === 2, 'count mismatch')
}

/* ------------------------------ [11] the mount writes nothing (write fault) */

console.log('\n[11] mounting the plugin against a write-fault store writes nothing')
{
  const dir = await makeTempDir('e-verify-')
  const opened = await openRawBoard({ backend: BACKEND, dir })
  await bootstrapRequirementBoard(opened.domain, { importLegacy: false })
  const storage = () => {
    const state = { writes: 0, attempts: [] }
    const fault = new Proxy(opened.domain, {
      get(target, property) {
        if (property === 'table') {
          return name => {
            const table = target.table(name)
            return new Proxy(table, {
              get(t, p) {
                const value = Reflect.get(t, p, t)
                if (typeof value !== 'function') return value
                if (p !== 'put' && p !== 'update' && p !== 'delete') return value.bind(t)
                return async () => {
                  state.writes += 1
                  state.attempts.push(`${name}.${p}`)
                  throw new Error(`write refused by the fault store: ${name}.${p}`)
                }
              },
            })
          }
        }
        if (property === 'global') {
          return new Proxy(target.global, {
            get(t, p) {
              const value = Reflect.get(t, p, t)
              if (typeof value !== 'function') return value
              if (p !== 'set') return value.bind(t)
              return async () => {
                state.writes += 1
                state.attempts.push('global.set')
                throw new Error('write refused by the fault store: global.set')
              }
            },
          })
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { state, domain: fault }
  }
  const { createMountContext } = await import(HARNESS)
  const registry = fakeJobs({ list: [] })
  for (const [label, get] of [
    ['with both registries', name => (name === 'jobs' ? registry : name === 'agents' ? { get: () => undefined, isOwnedBy: () => true } : undefined)],
    ['with no registry at all', () => undefined],
  ]) {
    const { state, domain } = storage()
    const mount = createMountContext({
      storageDomain: { open: async () => domain },
      get,
      logger: createRecordingLogger(),
    })
    const mounted = await attempt(() => apply(mount.ctx, { executionSync: true, promptContext: true, http: true, requireLockForExecution: false }))
    check(`mounting ${label} succeeds against a store that refuses every write`, mounted.error === null, mounted.error === null ? '' : `${mounted.error.code ?? ''} ${mounted.error.message}`)
    check(`mounting ${label} attempted no write`, state.writes === 0, `${state.writes}: ${state.attempts.join(', ')}`)
    if (label === 'with both registries') {
      check(`mounting ${label} logged no warning`, mount.logger.lines.warn.length === 0, mount.logger.lines.warn.join(' | '))
      check('the mount registered the execution listeners', mount.records.listeners.filter(listener => listener.event.startsWith('subagent/')).length === 2, JSON.stringify(mount.records.listeners.map(listener => listener.event)))
      check('the mount registered the browser route once', mount.records.routes.length === 1, `${mount.records.routes.length}`)
      check('the mount registered the prompt context once', mount.records.promptContexts.length === 1, `${mount.records.promptContexts.length}`)
      check('the mount registered the board tools', mount.records.tools.length >= 1, `${mount.records.tools.length}`)
    } else {
      check('a composition without registries warns exactly once about it', mount.logger.lines.warn.length === 1, mount.logger.lines.warn.join(' | '))
      check('and still attempted no write for the derived gap', state.writes === 0, `${state.writes}`)
    }
  }
  await opened.close()
  await removeTempDir(dir)
}

/* --------------------- [12] teardown after a refused queue write (probe) */

console.log('\n[12] closing the board right after a refused queue write')
{
  const world = await openWorld()
  const a = await task(world, '拒写一')
  const b = await task(world, '拒写二')
  await world.service.claim(a, {}, AI2)
  const refused = await attempt(() => world.service.queue(a, {}, AI))
  note(`the queue of a locked record: ${refused.error === null ? 'accepted' : `${refused.error.code}/${refused.error.details?.reason ?? ''}`}`)
  await allows('another reservation lands on the same session chain', () => world.service.queue(b, {}, AI))
  await allows('and can be taken back', () => world.service.unqueue(b, {}, AI))
  await new Promise(resolve => setTimeout(resolve, 120))
  world.unsubscribe()
  world.service.close()
  await world.opened.close()
  await new Promise(resolve => setTimeout(resolve, 120))
  check('closing a board whose queue write was refused did not reject a late write', lateRejections.length === 0, JSON.stringify(lateRejections))
  await removeTempDir(world.dir)
}

console.log(`\n${checks - failures}/${checks} checks passed on the ${BACKEND} backend`)
if (failed.length > 0) {
  console.log('failed checks:')
  for (const label of failed) console.log(`  - ${label}`)
}
process.exit(failures === 0 ? 0 : 1)
