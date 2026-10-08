#!/usr/bin/env node
/**
 * Independent verification of stage C (decision requirements, `kind` immutability)
 * and stage D (gates, cycles, delete unbinding, priority inheritance,
 * `advanceable`), by a member other than the implementation's author.
 *
 * The falsification targets, in the order the task names them:
 *
 *   1. `kind` immutability through the service, the browser command, the tool and
 *      the panel, plus the two bypass routes (a record written straight into the
 *      domain table, and a record written before `kind` existed).
 *   2. Human-only decisions enforced **in the operation**, not on the surface:
 *      every service method is called directly with a non-empty session.
 *   3. `requestedBy` is the first requester.
 *   4. A decision never reaches the claimable pool — tool, prompt, panel pool, and
 *      the delegated-decision case B left open.
 *   5. `stats` counts, and no placeholder field for a stage that does not exist.
 *   6. `advance`/`complete` gated by `blocksOn`, `force` overriding and recording,
 *      `rollback` ungated, a finished blocker freeing the gate.
 *   7. Cycle detection on both graphs, and cross-graph independence.
 *   8. `delete` unbinding the gate links, the child link, and the queues.
 *   9. Priority inheritance through a chain, capped, never persisted, and
 *      consistent between `gated`/`escalated`, `stats.criticalPath`, and §5.8.
 *  10. `advanceable` against what `transition` actually does, state by state —
 *      the §4.4 table's `claimable && !gated` is measured, not assumed.
 *  11. The four read paths agreeing on every derived field.
 *  12. The prompt's `[high↑]` tag by section, shared by tasks and decisions.
 *
 * Usage (from the repository root):
 *   TSX_TSCONFIG_PATH=<repo>/tsconfig.json node --import tsx/esm \
 *     .artifacts/requirement-board/tests/verification/cd-verify.mjs
 *   RB_CD_BACKEND=sqlite
 *   RB_CD_SERVICE=./_red-cd/host/service.js   # run against a mutated copy
 *   RB_CD_OLD=1                               # negative control for the mutated copy
 *
 * Temporary storage roots under `%TEMP%`, removed afterwards; no session is
 * created, no HTTP request is sent, and nothing under `~/.dsh` is written.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoard, openRawBoard } from '../harness.mjs'
import { resolveConfig } from '../../host/config.js'
import { dispatchBoardCommand } from '../../host/http.js'

const SERVICE_PATH = process.env.RB_CD_SERVICE ?? '../../host/service.js'
const UnderTest = (await import(SERVICE_PATH)).RequirementService
const BACKEND = process.env.RB_CD_BACKEND ?? 'json'
const OLD = process.env.RB_CD_OLD === '1'
const LIVE = process.env.RB_CD_LIVE === '1'

let checks = 0
let failures = 0

/** Assert one condition and record the outcome. */
function check(label, ok, detail = '') {
  checks += 1
  if (ok) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Record a fact rather than assert it. */
function note(text) {
  console.log(`  note ${text}`)
}

/** Run one call and hand back either its value or the error it threw. */
async function attempt(run) {
  try {
    return { value: await run(), error: null }
  } catch (error) {
    return { value: null, error }
  }
}

/** Assert a call fails with one code and, when given, one `details.reason`. */
async function refuses(label, expected, run) {
  const { error } = await attempt(run)
  const ok = error?.code === expected.code
    && (expected.reason === undefined || error?.details?.reason === expected.reason)
    && (expected.field === undefined || error?.details?.[expected.field.name] === expected.field.value)
  check(label, ok, `${error?.code ?? 'no-code'}/${error?.details?.reason ?? 'no-reason'}${error === null ? '' : ` ${JSON.stringify(error.details ?? {})}`}`.slice(0, 240))
  return error
}

/** Assert a call succeeds and hand back its value. */
async function allows(label, run, detail = '') {
  const { value, error } = await attempt(run)
  check(label, error === null, error === null ? detail : `${error?.code ?? 'no-code'}/${error?.details?.reason ?? 'no-reason'} ${String(error?.message ?? error)}`.slice(0, 240))
  return value
}

/* ------------------------------------------------------------------- ports */

/** A live agent whose preset id resolves its role. */
function agentOf(id, preset, name) {
  return { id, name, status: 'idle', ctx: { preset } }
}

const ROSTER = [
  agentOf('ses_art', 'art', '甲'),
  agentOf('ses_art2', 'art', '乙'),
  agentOf('ses_eng', 'eng', '旁人'),
]

/** The registry the role chain reads: `get`, `list`, and nothing else. */
function registryOf() {
  const store = new Map(ROSTER.map(agent => [agent.id, agent]))
  return { get: id => store.get(id), list: () => [...store.values()] }
}

/** The preset id is the composed preset (the stage-A convention). */
const fakePresets = () => ({ composedPreset: ctx => (typeof ctx?.preset === 'string' ? ctx.preset : undefined) })

const PANEL = { session: '', name: '面板人' }
const AI = { session: 'ses_art', name: '甲' }
const AI2 = { session: 'ses_art2', name: '乙' }
const ENG = { session: 'ses_eng', name: '旁人' }

/* ------------------------------------------------------------------ worlds */

/** Open one board with the class under test over a fresh root and one template. */
async function openWorld() {
  const dir = await mkdtemp(join(tmpdir(), 'cd-verify-'))
  const config = resolveConfig({})
  const ports = { agents: () => registryOf(), presets: () => fakePresets() }
  const board = await openBoard({ backend: BACKEND, dir, config, ports })
  const service = new UnderTest({ domain: board.domain, config, ports, logger: board.logger })
  await service.createTemplate({
    id: 'tpl-cd',
    name: '验证流程',
    nodes: [{ id: 'n1', name: '一' }, { id: 'n2', name: '二' }, { id: 'n3', name: '三' }],
  }, PANEL)
  return { board, service, dir }
}

/** Close one world and remove its root. */
async function closeWorld(world) {
  await world.board.close()
  await rm(world.dir, { recursive: true, force: true })
}

/** The stored requirement record. */
const raw = (world, id) => world.board.domain.table('requirements').get(id)
/** Write a record straight into the domain table, bypassing the service. */
const putRaw = (world, id, record) => world.board.domain.table('requirements').put(id, record)
/** One stored queue row. */
const queueRow = (world, session) => world.board.domain.table('queues').get(session)

/** Create one task on the verification template. */
async function task(world, title, extra = {}, actor = PANEL) {
  const created = await world.service.createRequirement({ title, templateId: 'tpl-cd', ...extra }, actor)
  return created.id
}

/* ------------------------------------------------------- [1] kind immutability */

console.log(`\n[1] kind immutability (service: ${SERVICE_PATH}, backend: ${BACKEND})`)
{
  const world = await openWorld()
  const { service } = world
  try {
    const id = await task(world, '一个任务')
    const before = raw(world, id)
    await refuses('service update{kind} is refused', { code: 'invalid-argument', reason: 'kind-immutable' }, () => service.updateRequirement(id, { kind: 'decision' }, PANEL))
    await refuses('the panel command update{kind} is refused', { code: 'invalid-argument', reason: 'kind-immutable' }, () => dispatchBoardCommand(service, { action: 'update', id, patch: { kind: 'decision' }, session: '', name: '' }))
    await refuses('an invalid kind is still refused first', { code: 'invalid-argument', reason: 'kind-immutable' }, () => service.updateRequirement(id, { kind: 'epic' }, PANEL))
    const after = raw(world, id)
    check('the refused update changed neither kind nor rev', after.kind === before.kind && after.rev === before.rev, JSON.stringify({ kind: after.kind, rev: after.rev, was: before.rev }))
    const decision = await task(world, '一个问题', { kind: 'decision' })
    await refuses('a decision cannot be turned back into a task', { code: 'invalid-argument', reason: 'kind-immutable' }, () => service.updateRequirement(decision, { kind: 'task' }, PANEL))
    check('the decision is still a decision', raw(world, decision).kind === 'decision', String(raw(world, decision).kind))

    await refuses('an invalid kind is refused at create with the value received', { code: 'invalid-argument', field: { name: 'received', value: 'epic' } }, () => service.createRequirement({ title: '怪类型', kind: 'epic', templateId: 'tpl-cd' }, PANEL))
    await refuses('an invalid kind is refused through the command path too', { code: 'invalid-argument', field: { name: 'received', value: 'epic' } }, () => dispatchBoardCommand(service, { action: 'create', session: '', name: '', requirement: { title: '怪类型', kind: 'epic', templateId: 'tpl-cd' } }))
    await refuses('the kind filter refuses an unknown kind', { code: 'invalid-argument' }, () => service.listRequirements({ kind: 'epic' }, ''))

    // Bypass: straight into the table, past the service. This is a different
    // question from the service's own refusal, so it is measured, not assumed.
    const valid = raw(world, id)
    const injected = await attempt(() => putRaw(world, 'req_injected1', { ...valid, id: 'req_injected1', kind: 'epic' }))
    note(`a direct table write with kind "epic": ${injected.error === null ? 'accepted' : `refused ${injected.error.code}`}`)
    const epic = service.getRequirement('req_injected1', AI.session)
    const epicClaim = await attempt(() => service.claim('req_injected1', {}, AI2))
    note(`the injected record reads kind=${JSON.stringify(epic.kind)} claimable=${epic.claimable} advanceable=${epic.advanceable} and claim ${epicClaim.error === null ? 'succeeded' : `was refused ${epicClaim.error.code}`}`)
    check('an unknown kind is not both unclaimable and claimable', !(epic.claimable === false && epicClaim.error === null), JSON.stringify({ claimable: epic.claimable, claim: epicClaim.error?.code ?? 'accepted' }))
    check('an unknown kind does not enlarge the byKind vocabulary', service.stats().byKind.epic === undefined, JSON.stringify(service.stats().byKind))
    await refuses('the injected kind cannot even be filtered by', { code: 'invalid-argument' }, () => service.listRequirements({ kind: 'epic' }, ''))
    const epicAfterClaim = service.getRequirement('req_injected1', AI2.session)
    note(`after the accepted claim the injected record reads claimable=${epicAfterClaim.claimable} advanceable=${epicAfterClaim.advanceable} status=${epicAfterClaim.status}`)
    note(`the prompt for the claimer lists it: ${service.promptContext(AI2.session, 20).split('\n').some(text => text.includes('req_injected1'))}`)
    const extra = await attempt(() => putRaw(world, 'req_injected2', { ...valid, id: 'req_injected2', kind: 'task', epicField: 1 }))
    note(`a direct table write with an unknown field: ${extra.error === null ? 'accepted' : `refused ${extra.error.code}`}`)

    // Bypass 2: a record written before `kind`/`requestedBy`/links existed.
    const legacy = {
      id: 'req_legacy01',
      title: '旧记录（没有 kind）',
      description: '写在 kind 与 requestedBy 之前',
      priority: 'normal',
      owner: '',
      sessions: [],
      templateId: 'tpl-cd',
      nodeId: 'n1',
      status: 'active',
      blockReason: '',
      blockedAt: null,
      labels: [],
      nodes: {},
      history: [],
      rev: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      createdBy: '',
      updatedBy: '',
    }
    await allows('the legacy record is written without kind, requestedBy, or links', () => putRaw(world, legacy.id, legacy))
    const read = service.getRequirement(legacy.id, AI.session)
    check('a legacy record reads as an ordinary task', read.kind === 'task' && read.requestedBy === '', JSON.stringify({ kind: read.kind, requestedBy: read.requestedBy }))
    const inList = service.listRequirements({}, AI.session).items.find(item => item.id === legacy.id)
    check('the list path reads it the same way', inList?.kind === 'task' && inList?.requestedBy === '', JSON.stringify({ kind: inList?.kind, requestedBy: inList?.requestedBy }))
    check('its absent links read as the normalized values', read.parentId === null && read.blocksOn.length === 0 && read.children.length === 0 && read.gated === false, JSON.stringify({ parentId: read.parentId, blocksOn: read.blocksOn, children: read.children, gated: read.gated }))
    const inDiff = service.changesSince('2025-01-01T00:00:00.000Z').requirements.find(item => item.id === legacy.id)
    check('the catch-up path reads it the same way', inDiff?.kind === 'task' && inDiff?.requestedBy === '', JSON.stringify({ kind: inDiff?.kind, requestedBy: inDiff?.requestedBy }))
    const legacySnap = service.snapshot({}, AI.session).requirements.find(item => item.id === legacy.id)
    check('the snapshot path reads it the same way', legacySnap?.kind === 'task' && legacySnap?.requestedBy === '', JSON.stringify({ kind: legacySnap?.kind }))

    // A decision written straight into the table is honoured by every reader.
    await allows('a decision written into the table is accepted', () => putRaw(world, 'req_rawdecision', { ...valid, id: 'req_rawdecision', kind: 'decision', requestedBy: '写库的人' }))
    check('the stored decision reads as a decision', raw(world, 'req_rawdecision').kind === 'decision', String(raw(world, 'req_rawdecision').kind))
    await refuses('the stored decision is human-only in the operation', { code: 'forbidden', reason: 'decision-task' }, () => service.transitionRequirement('req_rawdecision', { action: 'advance' }, AI))
    const prompt = service.promptContext(AI.session, 20)
    check('the stored decision is reported in the human section only', prompt.includes('Waiting on the human') && prompt.includes('req_rawdecision'), prompt.slice(prompt.indexOf('Waiting on the human'), prompt.indexOf('Waiting on the human') + 120))
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------- [1b] what a direct write does on reload */

console.log('\n[1b] a directly written out-of-vocabulary kind, seen by the load path')
{
  const world = await openWorld()
  const { service } = world
  let reopened
  let closed = false
  try {
    const id = await task(world, '将被塞入非法 kind')
    await putRaw(world, 'req_epicopen', { ...raw(world, id), id: 'req_epicopen', kind: 'epic' })
    check('the injected record is readable while the domain is open', service.getRequirement('req_epicopen', AI.session).kind === 'epic', String(service.getRequirement('req_epicopen', AI.session).kind))
    await world.board.close()
    closed = true
    const opened = await attempt(() => openRawBoard({ backend: BACKEND, dir: world.dir }))
    reopened = opened.error === null ? opened.value : undefined
    check('an out-of-vocabulary kind is refused by the load path', opened.error !== null, opened.error === null ? 'the domain opened with the record' : `${opened.error.code ?? opened.error.name}`)
    note(`reopening the domain over the injected record: ${opened.error === null ? 'accepted' : `refused ${opened.error.code ?? opened.error.name}`}`)
    if (opened.error !== null) {
      note(`the load failure reads: ${String(opened.error.message).slice(0, 200)}`)
    } else {
      const revived = new UnderTest({ domain: opened.value.domain, config: resolveConfig({}), ports: { agents: () => registryOf(), presets: () => fakePresets() } })
      const read = await attempt(() => revived.getRequirement('req_epicopen', AI.session))
      note(`the reloaded record reads: ${read.error === null ? `kind=${JSON.stringify(read.value.kind)} claimable=${read.value.claimable}` : `${read.error.code}/${read.error.details?.reason ?? ''}`}`)
    }
  } finally {
    if (reopened !== undefined) await reopened.close()
    else if (!closed) await world.board.close()
    await rm(world.dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------- [2] human-only in operations */

console.log('\n[2] human-only decisions: enforced in the operation, not on the surface')
{
  const world = await openWorld()
  const { service } = world
  try {
    const decision = () => task(world, '人拍板', { kind: 'decision' })
    const ids = {
      claim: await decision(),
      queue: await decision(),
      transition: await decision(),
      archive: await decision(),
      delete: await decision(),
      delegate: await decision(),
      revoke: await decision(),
    }
    await refuses('claim by a session refuses the decision', { code: 'forbidden', reason: 'decision-task' }, () => service.claim(ids.claim, {}, AI))
    await refuses('queue by a session refuses the decision', { code: 'forbidden', reason: 'decision-task' }, () => service.queue(ids.queue, {}, AI))
    await refuses('transition by a session refuses the decision', { code: 'forbidden', reason: 'decision-task' }, () => service.transitionRequirement(ids.transition, { action: 'advance' }, AI))
    await refuses('archive by a session refuses the decision', { code: 'forbidden', reason: 'decision-task' }, () => service.setArchived(ids.archive, { archived: true }, AI))
    await refuses('delete by a session refuses the decision', { code: 'forbidden', reason: 'decision-task' }, () => service.deleteRequirement(ids.delete, {}, AI))
    await refuses('delegate by a session refuses the decision', { code: 'forbidden', reason: 'decision-task' }, () => service.delegate(ids.delegate, { session: 'ses_art2' }, AI))
    await refuses('revoke by a session refuses the decision', { code: 'forbidden', reason: 'decision-task' }, () => service.delegate(ids.revoke, { revoke: true }, AI))
    await refuses('the decision cannot be claimed even by a session it is delegated to', { code: 'forbidden', reason: 'decision-task' }, async () => {
      await service.delegate(ids.delegate, { session: 'ses_art2', duties: ['看'], roleName: '临时' }, PANEL)
      return service.claim(ids.delegate, {}, AI2)
    })
    check('a delegated decision is still not claimable for its named session', service.getRequirement(ids.delegate, AI2.session).claimable === false, JSON.stringify(service.getRequirement(ids.delegate, AI2.session).claimable))

    // The panel: the four operations that exist for it run, the two that are the
    // executing session's own act stay reserved for a session.
    await allows('the panel advances the decision', () => service.transitionRequirement(ids.transition, { action: 'advance', note: '' }, PANEL))
    await allows('the panel archives the decision', () => service.setArchived(ids.archive, { archived: true }, PANEL))
    await allows('the panel deletes the decision', () => service.deleteRequirement(ids.delete, {}, PANEL))
    await allows('the panel delegates the decision', () => service.delegate(ids.claim, { session: 'ses_art2' }, PANEL))
    await refuses('the panel cannot claim: it holds no lock', { code: 'invalid-argument', reason: 'session-required' }, () => service.claim(ids.queue, {}, PANEL))
    await refuses('the panel cannot queue: it reserves nothing', { code: 'invalid-argument', reason: 'session-required' }, () => service.queue(ids.queue, {}, PANEL))

    // `update` on a decision: the whitelist, field by field.
    const open = await decision()
    await allows('a session may restate a decision\'s priority', () => service.updateRequirement(open, { priority: 'high' }, AI))
    await refuses('a session may not reroute a decision', { code: 'forbidden', reason: 'decision-task' }, () => service.updateRequirement(open, { role: 'art' }, AI))
    await refuses('a session may not change a decision\'s owner', { code: 'forbidden', reason: 'decision-task' }, () => service.updateRequirement(open, { owner: '某人' }, AI))
    await refuses('a session may not gate a decision', { code: 'forbidden', reason: 'decision-task' }, () => service.updateRequirement(open, { blocksOn: [] }, AI))
    await allows('the panel may reroute a decision', () => service.updateRequirement(open, { role: 'art' }, PANEL))

    // A task: `role` is structural and needs the lock, `priority` is not.
    const t = await task(world, '普通任务')
    await allows('a task\'s priority changes without a lock', () => service.updateRequirement(t, { priority: 'high' }, AI))
    await refuses('a task\'s role needs the lock', { code: 'forbidden', reason: 'lock-required' }, () => service.updateRequirement(t, { role: 'art' }, AI))
    await allows('the holder may reroute the task', async () => { await service.claim(t, {}, AI); return service.updateRequirement(t, { role: 'art' }, AI) })
  } finally {
    await closeWorld(world)
  }
}

/* ---------------------------------------------------------- [3] requestedBy */

console.log('\n[3] requestedBy records the first requester')
{
  const world = await openWorld()
  const { service } = world
  try {
    const first = await task(world, '同名问题', { kind: 'decision' }, AI)
    await allows('the first requester is the creating actor', async () => {
      const updated = await service.updateRequirement(first, { title: '改过名的问题' }, AI)
      return updated
    })
    check('a later update does not rewrite requestedBy', raw(world, first).requestedBy === '甲', String(raw(world, first).requestedBy))
    const second = await task(world, '同名问题', { kind: 'decision' }, AI2)
    check('a second record with the same title is a separate requester', raw(world, second).requestedBy === '乙' && first !== second, JSON.stringify({ first: raw(world, first).requestedBy, second: raw(world, second).requestedBy }))
    const byPanel = await task(world, '面板问的', { kind: 'decision' }, PANEL)
    check('a panel-created decision keeps the panel name', raw(world, byPanel).requestedBy === '面板人', String(raw(world, byPanel).requestedBy))
    const unnamed = await task(world, '工具问的', { kind: 'decision' }, { session: 'ses_art', name: '' })
    check('an unnamed actor falls back to the registry name', raw(world, unnamed).requestedBy === '甲', String(raw(world, unnamed).requestedBy))
    const ghost = await task(world, '没有注册表的会话', { kind: 'decision' }, { session: 'ses_ghost', name: '' })
    check('a session the registry does not know falls back to its id', raw(world, ghost).requestedBy === 'ses_ghost', String(raw(world, ghost).requestedBy))
    check('requestedBy is not touched by reads', service.getRequirement(first, AI.session).requestedBy === '甲', String(service.getRequirement(first, AI.session).requestedBy))
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------------- [4] decisions never in the pool */

console.log('\n[4] a decision reaches no claimable pool and no work section')
{
  const world = await openWorld()
  const { service } = world
  try {
    const mine = await task(world, '我的任务', {}, AI)
    const other = await task(world, '别人的任务', {}, AI2)
    const decision = await task(world, '该人决定', { kind: 'decision' }, AI)
    const listed = service.listRequirements({ claimable: true }, AI.session).items.map(item => item.id)
    check('the service pool has no decision', !listed.includes(decision), JSON.stringify(listed))
    const snap = service.snapshot({ claimable: true }, AI.session).requirements.map(item => item.id)
    check('the snapshot pool has no decision', !snap.includes(decision), JSON.stringify(snap))
    const panelPool = service.listRequirements({ claimable: true }, '').items.map(item => item.id)
    check('the panel pool has no decision', !panelPool.includes(decision), JSON.stringify(panelPool))
    const prompt = service.promptContext(AI.session, 20)
    const sections = splitSections(prompt)
    check('the decision is absent from every work section', !(sections['Claimable for you'] ?? '').includes(decision) && !(sections['Delegated to you'] ?? '').includes(decision) && !(sections["This session's requirements"] ?? '').includes(decision) && !(sections["Other sessions' requirements"] ?? '').includes(decision), prompt.replace(/\n/g, ' | ').slice(0, 300))
    check('the decision is present in the human section', (sections['Waiting on the human'] ?? '').includes(decision), String(sections['Waiting on the human']).slice(0, 160))
    check('the task sections still name the task', (sections['Claimable for you'] ?? '').includes(other) || (sections["Other sessions' requirements"] ?? '').includes(other), JSON.stringify({ mine, other }))

    // Adversarial probe: the panel may delegate a decision, so the named session
    // ends up with `delegatedTo.session === me` on a record it can never claim.
    // The three reading paths must still agree that it is not work for it.
    const delegatedDecision = await task(world, '被派发的问题', { kind: 'decision' })
    await service.delegate(delegatedDecision, { session: AI.session, duties: ['回答'], roleName: '临时决策' }, PANEL)
    const delegatePrompt = service.promptContext(AI.session, 20)
    const delegateSections = splitSections(delegatePrompt)
    const delegatedView = service.getRequirement(delegatedDecision, AI.session)
    check('a delegated decision is still not claimable for the named session', delegatedView.claimable === false && delegatedView.delegatedTo?.session === AI.session, JSON.stringify({ claimable: delegatedView.claimable, delegatedTo: delegatedView.delegatedTo?.session }))
    check('a delegated decision is not listed as delegated work for that session', !(delegateSections['Delegated to you'] ?? '').includes(delegatedDecision), (delegateSections['Delegated to you'] ?? '(no section)').replace(/\n/g, ' | ').slice(0, 200))
    check('and it is still named in the human section', (delegateSections['Waiting on the human'] ?? '').includes(delegatedDecision), (delegateSections['Waiting on the human'] ?? '').replace(/\n/g, ' | ').slice(0, 200))
    note(`a delegated decision appears ${(delegatePrompt.match(new RegExp(delegatedDecision, 'g')) ?? []).length} time(s) in the prompt for its named session`)
    note(`its "Delegated to you" line: ${(delegateSections['Delegated to you'] ?? '(none)').replace(/\n/g, ' | ').slice(0, 200)}`)
    note(`its "Waiting on the human" line: ${(delegateSections['Waiting on the human'] ?? '(none)').replace(/\n/g, ' | ').slice(0, 200)}`)
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------------------------------------ [5] stats */

console.log('\n[5] stats counts what it says, and holds no placeholder field')
{
  const world = await openWorld()
  const { service } = world
  try {
    const done = await task(world, '做完的', {}, AI)
    await service.claim(done, {}, AI)
    await service.transitionRequirement(done, { action: 'complete' }, AI)
    const active = await task(world, '在做的', {}, AI2)
    await service.claim(active, {}, AI2)
    const archived = await task(world, '归档的')
    await service.setArchived(archived, { archived: true }, PANEL)
    const decisionDone = await task(world, '已答的问题', { kind: 'decision' })
    await service.transitionRequirement(decisionDone, { action: 'complete' }, PANEL)
    const decision = await task(world, '待答的问题', { kind: 'decision' })
    const blocker = await task(world, '挡路的')
    const blocked = await task(world, '被挡的', { blocksOn: [blocker], priority: 'urgent' })
    await service.queue(blocked, {}, AI)
    // An orphaned lock left by a dead session (§5.2), written straight in.
    const orphan = await task(world, '死会话的锁')
    await putRaw(world, orphan, { ...raw(world, orphan), lock: { session: 'ses_dead', name: '', at: '2026-01-01T00:00:00.000Z', touchedAt: '2026-01-01T00:00:00.000Z', orphaned: true } })
    // A delegation the named session has not picked up (§5.6).
    const delegated = await service.delegate(await task(world, '等接的'), { session: 'ses_art2', duties: ['看'], roleName: '临时' }, PANEL)

    const stats = service.stats()
    // The scenario: seven tasks of which one is done and one archived (five open),
    // two decisions of which one is done (one open), one queued reservation, one
    // orphaned lock, one delegation waiting to be picked up.
    check('byKind counts open work per kind', stats.byKind.task === 5 && stats.byKind.decision === 1, JSON.stringify(stats.byKind))
    check('decisions counts the open question only', stats.decisions === 1, String(stats.decisions))
    check('byStatus keeps the finished and archived records', stats.byStatus.done === 2 && stats.byStatus.archived === 1 && stats.archived === 1, JSON.stringify({ byStatus: stats.byStatus, archived: stats.archived }))
    check('queued/reserved/queues agree on the one reservation', stats.queues === 1 && stats.queued === 1 && stats.reserved === 1, JSON.stringify({ queues: stats.queues, queued: stats.queued, reserved: stats.reserved }))
    check('orphanedLocks counts the lock a dead session left', stats.orphanedLocks === 1, String(stats.orphanedLocks))
    check('pendingDelegations counts the unclaimed delegation', stats.pendingDelegations === 1, String(stats.pendingDelegations))
    check('criticalPath is the number of raised blockers, by one reading', stats.criticalPath === 1, `${stats.criticalPath}`)
    check('the documented fields all exist', ['total', 'archived', 'byStatus', 'byPriority', 'completionRate', 'byOwner', 'bySession', 'nodeDurations', 'blocked', 'stalled', 'byKind', 'byRole', 'decisions', 'criticalPath', 'queues', 'queued', 'reserved', 'orphanedLocks', 'pendingDelegations'].every(key => stats[key] !== undefined), Object.keys(stats).join(','))
    const outOfScope = ['running', 'execSync', 'executions', 'inFlight'].filter(key => key in stats)
    const ownPlaceholders = ['executions', 'inFlight', 'tasksRunning', 'liveRuns'].filter(key => key in stats)
    const eFields = outOfScope.filter(key => key === 'running' || key === 'execSync')
    check('no placeholder field of C/D\'s own is present', ownPlaceholders.length === 0, ownPlaceholders.join(','))
    if (eFields.length > 0) note(`stage-E fields are present in stats at this digest (out of C/D scope): ${eFields.map(key => `${key}=${JSON.stringify(stats[key])}`).join(' ')}`)
    check('byRole groups unrouted work under the empty role', stats.byRole.some(entry => entry.role === '' && entry.total >= 2), JSON.stringify(stats.byRole))
    note(`stats at this state: byKind=${JSON.stringify(stats.byKind)} decisions=${stats.decisions} criticalPath=${stats.criticalPath} total=${stats.total} completionRate=${stats.completionRate}`)
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------------------------------- [6] the gates */

console.log('\n[6] blocksOn gates advance and complete, force overrides and records')
{
  const world = await openWorld()
  const { service } = world
  try {
    const blocker = await task(world, '挡路者')
    const gated = await task(world, '被挡者', { blocksOn: [blocker] })
    await service.claim(gated, {}, AI)
    await refuses('the holder cannot advance past an unfinished blocker', { code: 'invalid-transition', reason: 'blocked-by' }, () => service.transitionRequirement(gated, { action: 'advance' }, AI))
    const gateError = await attempt(() => service.transitionRequirement(gated, { action: 'advance' }, AI))
    note(`the gate refusal payload reads: ${JSON.stringify({ code: gateError.error?.code, details: gateError.error?.details })}`)
    check('the refusal wrote nothing', raw(world, gated).nodeId === 'n1' && raw(world, gated).status === 'active', JSON.stringify({ nodeId: raw(world, gated).nodeId, status: raw(world, gated).status }))
    await refuses('the holder cannot complete past an unfinished blocker', { code: 'invalid-transition', reason: 'blocked-by' }, () => service.transitionRequirement(gated, { action: 'complete' }, AI))
    check('the refused complete left the record active', raw(world, gated).status === 'active', String(raw(world, gated).status))
    await allows('force advances and records which gate it overrode', () => service.transitionRequirement(gated, { action: 'advance', force: true }, AI))
    const entry = raw(world, gated).history.at(-1)
    check('the history entry names the blocker it overrode', entry.force === true && Array.isArray(entry.blockedBy) && entry.blockedBy.includes(blocker), JSON.stringify(entry.blockedBy))
    await refuses('rollback is not gated, but still needs a preceding node', { code: 'invalid-argument' }, () => service.transitionRequirement(gated, { action: 'rollback', to: 'n1' }, AI))
    await allows('rollback from node two to node one is allowed while blocked', () => service.transitionRequirement(gated, { action: 'rollback', to: 'n1', note: '返工' }, AI))
    await refuses('jump insists on force', { code: 'invalid-transition' }, () => service.transitionRequirement(gated, { action: 'jump', to: 'n3', note: '跳' }, AI))
    // Writing a gate link is structural: it needs the lock and is recorded.
    await refuses('another session cannot rewrite the gate links', { code: 'forbidden', reason: 'lock-required' }, () => service.updateRequirement(gated, { blocksOn: [blocker] }, AI2))
    await allows('the holder clears the gate link', () => service.updateRequirement(gated, { blocksOn: [] }, AI))
    const clearedEntry = raw(world, gated).history.at(-1)
    check('clearing a gate link is recorded in the history', String(clearedEntry.note).includes('gates:') && String(clearedEntry.note).includes('blocksOn []'), JSON.stringify(clearedEntry.note))
    await allows('and sets it again', () => service.updateRequirement(gated, { blocksOn: [blocker] }, AI))
    const setEntry = raw(world, gated).history.at(-1)
    check('setting a gate link is recorded in the history', String(setEntry.note).includes('gates:') && String(setEntry.note).includes(blocker), JSON.stringify(setEntry.note))
    check('and the gate is armed again', service.getRequirement(gated, AI.session).gated === true, 'the gate is not armed')

    // The spec's error-code order (§9-D): the flow node's own prerequisite is
    // judged before the cross-requirement gate, so a record with both reports
    // `dependency-not-met`, not `blocked-by`.
    await allows('a template with a forward node dependency is created', () => service.createTemplate({
      id: 'tpl-fwd3',
      name: '前向依赖',
      nodes: [{ id: 'n1', name: '一' }, { id: 'n2', name: '二', dependsOn: ['n3'] }, { id: 'n3', name: '三' }],
    }, PANEL))
    const both = await task(world, '两者都不满足', { templateId: 'tpl-fwd3', blocksOn: [blocker] })
    await allows('a second session takes the lock on the doubly-gated record', () => service.claim(both, {}, ENG))
    await refuses('the node prerequisite is judged before the cross-requirement gate', { code: 'dependency-not-met' }, () => service.transitionRequirement(both, { action: 'advance' }, ENG))
    check('the gated record is still blocked after all that', service.getRequirement(gated, AI.session).gated === true, JSON.stringify(service.getRequirement(gated, AI.session).blockedBy))
    await allows('completing the blocker frees the gate', () => service.transitionRequirement(blocker, { action: 'complete' }, PANEL))
    check('the freed record reads ungated with no blockers', service.getRequirement(gated, AI.session).gated === false && service.getRequirement(gated, AI.session).blockedBy.length === 0, JSON.stringify(service.getRequirement(gated, AI.session).blockedBy))
    await allows('and it advances without force now', () => service.transitionRequirement(gated, { action: 'advance' }, AI))
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------- [6b] the completion condition is not a permission */

console.log('\n[6b] a node\'s own completion condition stays out of `advanceable`')
{
  const world = await openWorld()
  const { service } = world
  try {
    await allows('a template whose first node needs a checklist is created', () => service.createTemplate({
      id: 'tpl-check',
      name: '检查节点',
      nodes: [{ id: 'n1', name: '一', completion: { type: 'checklist', checklist: ['看过'] } }, { id: 'n2', name: '二' }],
    }, PANEL))
    const id = await task(world, '要打勾的', { templateId: 'tpl-check' })
    await allows('the session takes the lock', () => service.claim(id, {}, AI))
    const view = service.getRequirement(id, AI.session)
    check('the lock holder reads advanceable although the node needs a tick', view.advanceable === true && view.claimable === true, JSON.stringify({ advanceable: view.advanceable, claimable: view.claimable }))
    const { error } = await attempt(() => service.transitionRequirement(id, { action: 'advance' }, AI))
    check('and only `transition` judges the completion condition', error?.code === 'completion-not-met', `${error?.code}/${error?.details?.reason ?? ''}`)
    note(`the completion refusal reads: ${JSON.stringify({ code: error?.code, details: error?.details })}`)
    await allows('the checklist entry is ticked', () => service.setChecklist(id, { index: 0, checked: true }, AI))
    await allows('and then the same advance succeeds', () => service.transitionRequirement(id, { action: 'advance' }, AI))
  } finally {
    await closeWorld(world)
  }
}

/* ----------------------------------------------------------- [7] the cycles */

console.log('\n[7] cycles are refused per graph, and the graphs are independent')
{
  const world = await openWorld()
  const { service } = world
  try {
    const a = await task(world, '甲')
    const b = await task(world, '乙')
    const c = await task(world, '丙')
    await refuses('a requirement cannot be its own parent', { code: 'invalid-argument', reason: 'self-reference', field: { name: 'field', value: 'parentId' } }, () => service.updateRequirement(a, { parentId: a }, PANEL))
    await refuses('a requirement cannot block on itself', { code: 'invalid-argument', reason: 'self-reference', field: { name: 'field', value: 'blocksOn' } }, () => service.updateRequirement(a, { blocksOn: [a] }, PANEL))
    await allows('a parent link is accepted', () => service.updateRequirement(a, { parentId: b }, PANEL))
    await refuses('the reverse parent link would close a cycle', { code: 'invalid-argument', reason: 'cycle', field: { name: 'field', value: 'parentId' } }, () => service.updateRequirement(b, { parentId: a }, PANEL))
    await allows('a blocksOn link is accepted', () => service.updateRequirement(a, { blocksOn: [b] }, PANEL))
    const blocksCycle = await refuses('the reverse blocksOn link would close a cycle', { code: 'invalid-argument', reason: 'cycle', field: { name: 'field', value: 'blocksOn' } }, () => service.updateRequirement(b, { blocksOn: [a] }, PANEL))
    if (OLD) {
      check('OLD CONTROL: the pre-D board accepted the blocksOn cycle', blocksCycle === null, String(blocksCycle?.details?.reason ?? 'accepted'))
    }
    // The same pair, one graph a cycle and the other not. A fresh pair, because the
    // pair above already carries a legal `blocksOn` edge.
    const d = await task(world, '图甲')
    const e = await task(world, '图乙')
    await allows('a parent link is accepted on the fresh pair', () => service.updateRequirement(d, { parentId: e }, PANEL))
    await refuses('the reverse parent link is refused on the fresh pair', { code: 'invalid-argument', reason: 'cycle', field: { name: 'field', value: 'parentId' } }, () => service.updateRequirement(e, { parentId: d }, PANEL))
    await allows('the same pair is legal in the other graph', () => service.updateRequirement(e, { blocksOn: [d] }, PANEL))
    const crossE = service.getRequirement(e, AI.session)
    check('the pair is a parent cycle and a legal gate at the same time', crossE.gated === true && crossE.blockedBy.includes(d) && service.getRequirement(d, AI.session).kind === 'task', JSON.stringify({ parentId: service.getRequirement(d, AI.session).parentId, blockedBy: crossE.blockedBy }))
    await refuses('a link to a record that does not exist is refused', { code: 'invalid-argument', reason: 'missing-target' }, () => service.updateRequirement(c, { parentId: 'req_nowhere' }, PANEL))
    await refuses('a blocksOn link to a record that does not exist is refused', { code: 'invalid-argument', reason: 'missing-target' }, () => service.updateRequirement(c, { blocksOn: ['req_nowhere'] }, PANEL))

    // The declared bound on the link list (tool description: at most 20 ids).
    const many = []
    for (let index = 0; index < 21; index += 1) many.push(await task(world, `上限 ${index}`))
    await refuses('a gate list longer than the declared bound is refused', { code: 'invalid-argument' }, () => service.updateRequirement(c, { blocksOn: many }, PANEL))
    await allows('the same list at the declared bound is accepted', () => service.updateRequirement(c, { blocksOn: many.slice(0, 20) }, PANEL))
    check('all twenty links read back', service.getRequirement(c, AI.session).blocksOn.length === 20, String(service.getRequirement(c, AI.session).blocksOn.length))

    // A deep parent chain: `children` is one pass, so it must terminate, and the
    // parent walk that validates a new link must terminate too.
    let parent = c
    const startedAt = Date.now()
    for (let index = 0; index < 120; index += 1) {
      const child = await task(world, `链 ${index}`)
      await service.updateRequirement(child, { parentId: parent }, PANEL)
      parent = child
    }
    const elapsed = Date.now() - startedAt
    const deep = service.getRequirement(parent, AI.session)
    check('the deepest record has no children', Array.isArray(deep.children) && deep.children.length === 0, JSON.stringify(deep.children))
    check('the root of the chain has one child', service.getRequirement(c, AI.session).children.length === 1, JSON.stringify(service.getRequirement(c, AI.session).children))
    check('a 120-deep chain builds and reads without hanging', elapsed < 60_000 && typeof deep.id === 'string', `${elapsed}ms`)
    note(`120-deep parent chain built in ${elapsed}ms`)

    // A cycle written straight into the table (no service, no validation): reads
    // must not hang, and a record inside it keeps its own priority.
    const x = await task(world, '环甲')
    const y = await task(world, '环乙')
    await putRaw(world, x, { ...raw(world, x), parentId: y })
    await putRaw(world, y, { ...raw(world, y), parentId: x })
    const readAt = Date.now()
    const readX = service.getRequirement(x, AI.session)
    const all = service.listRequirements({}, AI.session)
    const snap = service.snapshot({}, AI.session)
    const stats = service.stats()
    const prompt = service.promptContext(AI.session, 10)
    const readMs = Date.now() - readAt
    check('a stored parent cycle still reads', readX.id === x && all.total > 0 && snap.requirements.length > 0 && stats.total > 0 && typeof prompt === 'string', `${readMs}ms`)
    check('a stored cycle does not hang the read paths', readMs < 20_000, `${readMs}ms`)
    note(`reads over a stored parent cycle took ${readMs}ms`)
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------------------------------ [8] delete unbind */

console.log('\n[8] delete unbinds the gate links, the parent link, and the queues')
{
  const world = await openWorld()
  const { service } = world
  try {
    const blocker = await task(world, '将被删的挡路者', { priority: 'high' })
    const blocked = await task(world, '被挡者', { blocksOn: [blocker], priority: 'urgent' })
    const child = await task(world, '孩子', { parentId: blocker })
    await service.queue(blocked, {}, AI)
    await service.queue(blocker, {}, AI2)
    const before = service.getRequirement(blocked, AI.session)
    check('the gate is armed before the delete', before.gated === true && before.blockedBy.includes(blocker) && service.stats().criticalPath === 1, JSON.stringify({ blockedBy: before.blockedBy, criticalPath: service.stats().criticalPath }))
    const receipt = await allows('the panel deletes the blocker', () => service.deleteRequirement(blocker, {}, PANEL))
    check('the receipt lists what was unbound', Array.isArray(receipt.unbound) && receipt.unbound.includes(blocked) && receipt.unbound.includes(child), JSON.stringify(receipt.unbound))
    const after = service.getRequirement(blocked, AI.session)
    check('the deleted id is out of blocksOn, blockedBy and gated', after.blocksOn.length === 0 && after.blockedBy.length === 0 && after.gated === false, JSON.stringify({ blocksOn: after.blocksOn, blockedBy: after.blockedBy, gated: after.gated }))
    check('the child lost its parent', service.getRequirement(child, AI.session).parentId === null, String(service.getRequirement(child, AI.session).parentId))
    check('the unbinding is recorded on the unbound record', raw(world, blocked).history.some(entry => String(entry.note).includes(`unbound from "${blocker}"`)), JSON.stringify(raw(world, blocked).history.at(-1)?.note))
    check('the deleted id left the queue that reserved it', (queueRow(world, 'ses_art2')?.items ?? []).every(item => item.id !== blocker), JSON.stringify(queueRow(world, 'ses_art2')?.items))
    check('a live reservation on another record is untouched', (queueRow(world, 'ses_art')?.items ?? []).some(item => item.id === blocked), JSON.stringify(queueRow(world, 'ses_art')?.items))
    check('criticalPath fell back to zero', service.stats().criticalPath === 0, String(service.stats().criticalPath))
    await refuses('the deleted record is gone', { code: 'not-found' }, () => service.getRequirement(blocker, AI.session))
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------------------- [9] priority inheritance */

console.log('\n[9] priority inheritance travels to the blockers, is capped, and is never stored')
{
  const world = await openWorld()
  const { service } = world
  try {
    // Escalation travels from work still in progress to the requirements it waits
    // on (dispatch.js `escalationIndex`): the blocker reads at the priority of the
    // work it holds up. So the urgent record must be the *waiter* here.
    const urgentWork = await task(world, '紧急的在做的活', { priority: 'urgent' })
    const middle = await task(world, '中层挡路者', { priority: 'normal' })
    const low = await task(world, '底层挡路者', { priority: 'low' })
    await service.updateRequirement(urgentWork, { blocksOn: [middle] }, PANEL)
    await service.updateRequirement(middle, { blocksOn: [low] }, PANEL)
    const storedBefore = JSON.stringify(raw(world, low))
    const readWork = service.getRequirement(urgentWork, AI.session)
    const readMiddle = service.getRequirement(middle, AI.session)
    const readLow = service.getRequirement(low, AI.session)
    check('the raised record is the blocker, not the waiter', readMiddle.escalated === true && readMiddle.effectivePriority === 'urgent', JSON.stringify({ p: readMiddle.effectivePriority, e: readMiddle.escalated }))
    check('the urgency travels one more level through the chain', readLow.escalated === true && readLow.effectivePriority === 'urgent', JSON.stringify({ p: readLow.effectivePriority, e: readLow.escalated }))
    check('the work that raises is not itself raised', readWork.effectivePriority === 'urgent' && readWork.escalated === false, JSON.stringify({ p: readWork.effectivePriority, e: readWork.escalated }))
    check('gated marks only the records that wait', readWork.gated === true && readMiddle.gated === true && readLow.gated === false, JSON.stringify({ work: readWork.gated, middle: readMiddle.gated, low: readLow.gated }))
    check('nothing was written by the reads', JSON.stringify(raw(world, low)) === storedBefore, 'the stored record changed')
    check('the stored record has no derived field', raw(world, low).effectivePriority === undefined && raw(world, low).escalated === undefined, JSON.stringify(Object.keys(raw(world, low)).filter(key => ['effectivePriority', 'escalated', 'gated', 'blockedBy'].includes(key))))
    check('the stored priority is byte-for-byte what was created', raw(world, low).priority === 'low', String(raw(world, low).priority))
    check('stats.criticalPath counts both raised blockers', service.stats().criticalPath === 2, String(service.stats().criticalPath))

    // Archiving the middle blocker: shelving is not finishing (§5.8), so it still
    // blocks and is still raised by the work it holds up — but a shelved record is
    // not "in progress", so it stops raising what *it* waits on.
    await allows('the middle blocker is archived', () => service.setArchived(middle, { archived: true }, PANEL))
    const archivedWork = service.getRequirement(urgentWork, AI.session)
    const archivedMiddle = service.getRequirement(middle, AI.session)
    const archivedLow = service.getRequirement(low, AI.session)
    check('an archived blocker still blocks', archivedWork.gated === true && archivedWork.blockedBy.includes(middle), JSON.stringify(archivedWork.blockedBy))
    check('an archived blocker is still raised by the work it holds up', archivedMiddle.escalated === true && archivedMiddle.effectivePriority === 'urgent', JSON.stringify({ p: archivedMiddle.effectivePriority, e: archivedMiddle.escalated }))
    note(`the archived middle blocker stops passing the raise on: low reads ${archivedLow.effectivePriority}/${archivedLow.escalated}`)
    check('a shelved link no longer raises what it waits on', archivedLow.escalated === false && archivedLow.effectivePriority === 'low', JSON.stringify({ p: archivedLow.effectivePriority, e: archivedLow.escalated }))
    check('criticalPath followed the shelving down', service.stats().criticalPath === 1, String(service.stats().criticalPath))
    check('the archived record is still never written to', raw(world, middle).priority === 'normal' && raw(world, middle).effectivePriority === undefined, JSON.stringify({ p: raw(world, middle).priority }))

    // Clearing the link lets the escalation fall back with no write.
    await allows('the urgent work drops its link', () => service.updateRequirement(urgentWork, { blocksOn: [] }, PANEL))
    const clearedWork = service.getRequirement(urgentWork, AI.session)
    const clearedMiddle = service.getRequirement(middle, AI.session)
    check('the escalation fell back for the unlinked record', clearedWork.escalated === false && clearedWork.effectivePriority === 'urgent' && clearedWork.gated === false, JSON.stringify({ p: clearedWork.effectivePriority, e: clearedWork.escalated }))
    check('the record with nothing left to hold up keeps its own priority', clearedMiddle.escalated === false && clearedMiddle.effectivePriority === 'normal', JSON.stringify({ p: clearedMiddle.effectivePriority, e: clearedMiddle.escalated }))
    check('criticalPath fell back with it', service.stats().criticalPath === 0, String(service.stats().criticalPath))
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------------- [10] advanceable vs what advance does */

console.log('\n[10] `advanceable` against what `transition` actually does, state by state')
{
  const CASES = [
    {
      name: 'idle task, session',
      build: async world => ({ id: await task(world, '空闲'), me: AI.session, actor: AI }),
    },
    {
      name: 'task locked by the session',
      build: async world => { const id = await task(world, '自己的锁'); await world.service.claim(id, {}, AI); return { id, me: AI.session, actor: AI } },
    },
    {
      name: 'task locked by another session',
      build: async world => { const id = await task(world, '别人的锁'); await world.service.claim(id, {}, AI2); return { id, me: AI.session, actor: AI } },
    },
    {
      name: 'gated task locked by the session',
      build: async world => { const blocker = await task(world, '门禁'); const id = await task(world, '被门禁挡的', { blocksOn: [blocker] }); await world.service.claim(id, {}, AI); return { id, me: AI.session, actor: AI } },
    },
    {
      name: 'finished task',
      build: async world => { const id = await task(world, '完成的'); await world.service.claim(id, {}, AI); await world.service.transitionRequirement(id, { action: 'complete' }, AI); return { id, me: AI.session, actor: AI } },
    },
    {
      name: 'archived task, lock retained',
      build: async world => { const id = await task(world, '归档的'); await world.service.claim(id, {}, AI); await world.service.setArchived(id, { archived: true }, PANEL); return { id, me: AI.session, actor: AI } },
    },
    {
      name: 'decision, session',
      build: async world => ({ id: await task(world, '问题', { kind: 'decision' }), me: AI.session, actor: AI }),
    },
    {
      name: 'decision, panel',
      build: async world => ({ id: await task(world, '问题', { kind: 'decision' }), me: '', actor: PANEL }),
    },
    {
      name: 'idle task, panel',
      build: async world => ({ id: await task(world, '空闲'), me: '', actor: PANEL }),
    },
    {
      name: 'gated task, panel',
      build: async world => { const blocker = await task(world, '门禁'); const id = await task(world, '被挡的', { blocksOn: [blocker] }); return { id, me: '', actor: PANEL } },
    },
    {
      name: 'task with an unmet node prerequisite',
      build: async world => {
        const template = await attempt(() => world.service.createTemplate({
          id: 'tpl-fwd',
          name: '前向依赖',
          nodes: [{ id: 'n1', name: '一' }, { id: 'n2', name: '二', dependsOn: ['n3'] }, { id: 'n3', name: '三' }],
        }, PANEL))
        if (template.error !== null) return { id: null, me: AI.session, actor: AI, unavailable: `the template was refused: ${template.error.code}/${template.error.details?.reason ?? ''}` }
        const id = await task(world, '前置未满足', { templateId: 'tpl-fwd' })
        await world.service.claim(id, {}, AI)
        return { id, me: AI.session, actor: AI }
      },
    },
  ]
  const rows = []
  for (const item of CASES) {
    const world = await openWorld()
    try {
      const built = await item.build(world)
      if (built.id === null) {
        note(`${item.name}: ${built.unavailable}`)
        continue
      }
      const { id, me, actor } = built
      const view = world.service.getRequirement(id, me)
      const { error } = await attempt(() => world.service.transitionRequirement(id, { action: 'advance' }, actor))
      const refusal = error === null ? null : `${error.code}/${error.details?.reason ?? ''}`
      const table = view.claimable && view.gated !== true
      rows.push({ name: item.name, claimable: view.claimable, advanceable: view.advanceable, gated: view.gated, refusal, table })
    } finally {
      await closeWorld(world)
    }
  }
  let mismatches = 0
  const PERMISSION_REFUSALS = ['forbidden', 'invalid-transition', 'dependency-not-met']
  for (const row of rows) {
    const refusedByPermission = row.refusal !== null && PERMISSION_REFUSALS.some(code => row.refusal.startsWith(`${code}/`))
    const agrees = row.advanceable === !refusedByPermission
    check(`advanceable agrees with the actual verdict — ${row.name}`, agrees, `advanceable=${row.advanceable} refusal=${row.refusal ?? 'none'}`)
    const tableAgrees = row.table === row.advanceable
    if (!tableAgrees) mismatches += 1
    note(`${row.name}: claimable=${row.claimable} gated=${row.gated} advanceable=${row.advanceable} actual=${row.refusal ?? 'advanced'} §4.4-table=${row.table}${tableAgrees ? '' : ' ← MISMATCH'}`)
  }
  check('the §4.4 table formula disagrees with the implementation in the idle case', rows[0].table === true && rows[0].advanceable === false && rows[0].refusal === 'forbidden/lock-required', JSON.stringify(rows[0]))
  check('the §4.4 table formula disagrees for a decision the panel may advance', rows[7].table === false && rows[7].advanceable === true && rows[7].refusal === null, JSON.stringify(rows[7]))
  const mismatching = rows.filter(row => row.table !== row.advanceable).map(row => row.name)
  const expectedMismatches = rows.some(row => row.name === 'task with an unmet node prerequisite')
    ? ['idle task, session', 'decision, panel', 'task with an unmet node prerequisite']
    : ['idle task, session', 'decision, panel']
  check('the table disagrees with the implementation only where measured', JSON.stringify(mismatching) === JSON.stringify(expectedMismatches), JSON.stringify({ mismatching, expectedMismatches, mismatches }))
  if (LIVE) {
    check('LIVE CONTROL: the pre-D implementation calls the idle record advanceable', rows[0].advanceable === true, JSON.stringify(rows[0]))
  }
}

/* ------------------------------------------------- [11] the four read paths */

console.log('\n[11] one derived value per record across get, list, snapshot and changesSince')
{
  const world = await openWorld()
  const { service } = world
  try {
    const blocker = await task(world, '挡路者', { priority: 'urgent' })
    const rich = await task(world, '主角', { blocksOn: [blocker], priority: 'normal' })
    const child = await task(world, '孩子', { parentId: rich })
    const legacyId = 'req_legacy02'
    await putRaw(world, legacyId, {
      id: legacyId, title: '旧记录', description: '', priority: 'normal', owner: '', sessions: [],
      templateId: 'tpl-cd', nodeId: 'n1', status: 'active', blockReason: '', blockedAt: null,
      labels: [], nodes: {}, history: [], rev: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      createdBy: '', updatedBy: '',
    })
    const fields = ['kind', 'requestedBy', 'parentId', 'blocksOn', 'children', 'blockedBy', 'gated', 'effectivePriority', 'escalated', 'status', 'priority', 'templateId', 'nodeId', 'sessions']
    const pick = record => Object.fromEntries(fields.map(key => [key, record?.[key]]))
    const get = service.getRequirement(rich, AI.session)
    const list = service.listRequirements({}, AI.session).items.find(item => item.id === rich)
    const snap = service.snapshot({}, AI.session).requirements.find(item => item.id === rich)
    const diff = service.changesSince('2025-01-01T00:00:00.000Z').requirements.find(item => item.id === rich)
    check('the rich record carries the derived set everywhere', Boolean(get && list && snap && diff), JSON.stringify({ get: Boolean(get), list: Boolean(list), snap: Boolean(snap), diff: Boolean(diff) }))
    check('get and list agree field by field', JSON.stringify(pick(get)) === JSON.stringify(pick(list)), JSON.stringify({ get: pick(get), list: pick(list) }).slice(0, 240))
    check('get and snapshot agree field by field', JSON.stringify(pick(get)) === JSON.stringify(pick(snap)), JSON.stringify({ get: pick(get), snap: pick(snap) }).slice(0, 240))
    const diffFields = fields.filter(key => key !== 'claimable' && key !== 'advanceable')
    const diffHasAll = diffFields.every(key => JSON.stringify(diff?.[key]) === JSON.stringify(get[key]))
    check('the catch-up path agrees on every shared field', diffHasAll, JSON.stringify({ get: pick(get), diff: pick(diff) }).slice(0, 240))
    check('the child link is derived, not stored', get.children.includes(child) && raw(world, rich).children === undefined, JSON.stringify({ children: get.children }))
    check('get, list and the snapshot all expose the two eligibility answers', [get, list, snap].every(record => typeof record?.claimable === 'boolean' && typeof record?.advanceable === 'boolean'), JSON.stringify({ get: [typeof get.claimable, typeof get.advanceable], list: [typeof list?.claimable, typeof list?.advanceable], snap: [typeof snap?.claimable, typeof snap?.advanceable] }))
    check('the catch-up path deliberately omits them', diff?.claimable === undefined && diff?.advanceable === undefined, JSON.stringify({ claimable: diff?.claimable, advanceable: diff?.advanceable }))
    const legacyGet = service.getRequirement(legacyId, AI.session)
    const legacyList = service.listRequirements({}, AI.session).items.find(item => item.id === legacyId)
    const legacyDiff = service.changesSince('2025-01-01T00:00:00.000Z').requirements.find(item => item.id === legacyId)
    check('a legacy record is normalized the same way on all paths', JSON.stringify(pick(legacyGet)) === JSON.stringify(pick(legacyList)) && JSON.stringify(pick(legacyGet)) === JSON.stringify({ ...pick(legacyGet), ...pick(legacyDiff) }), JSON.stringify({ get: pick(legacyGet), list: pick(legacyList), diff: pick(legacyDiff) }).slice(0, 300))
    check('the snapshot statistics come from the same stats', service.snapshot({}, '').stats.decisions === service.stats().decisions, `${service.snapshot({}, '').stats.decisions} vs ${service.stats().decisions}`)
  } finally {
    await closeWorld(world)
  }
}

/* ------------------------------------------------------------- [12] prompt tags */

console.log('\n[12] [high↑] appears only on raised records, by section, shared by decisions')
{
  const world = await openWorld()
  const { service } = world
  try {
    // Escalation raises the blocker, so the arrow belongs on a record some
    // in-progress work waits on — including a decision that gates urgent work.
    const source = await task(world, '紧急的在做的活', { priority: 'urgent' })
    const raised = await task(world, '被抬高的挡路者', { priority: 'low' })
    await service.updateRequirement(source, { blocksOn: [raised] }, PANEL)
    const plain = await task(world, '普通者', { priority: 'normal' })
    const decision = await task(world, '人决定的问题', { kind: 'decision', priority: 'high' })
    const decisionRaised = await task(world, '挡住紧急活的决策', { kind: 'decision', priority: 'low' })
    const worker = await task(world, '等决策的活', { priority: 'urgent' })
    await service.updateRequirement(worker, { blocksOn: [decisionRaised] }, PANEL)
    const prompt = service.promptContext(AI.session, 20)
    const sections = splitSections(prompt)
    const line = id => prompt.split('\n').find(text => text.includes(id)) ?? ''
    check('the raised task carries the arrow', line(raised).includes('[urgent↑]'), line(raised))
    check('the plain task carries no arrow', line(plain).includes('[normal]') && !line(plain).includes('↑'), line(plain))
    check('the work that raises is not marked as raised', line(source).includes('[urgent]') && !line(source).includes('↑'), line(source))
    check('a raised decision uses the same tag implementation', line(decisionRaised).includes('[urgent↑]'), line(decisionRaised))
    check('a plain decision carries no arrow', line(decision).includes('[high]') && !line(decision).includes('↑'), line(decision))
    const armed = prompt.split('\n').filter(text => text.includes('↑'))
    const armedIds = [raised, decisionRaised].filter(id => armed.some(text => text.includes(id)))
    check('the arrow names exactly the raised records', armed.every(text => text.includes(raised) || text.includes(decisionRaised)) && armedIds.length === 2, JSON.stringify(armed))
    check('both records sit in the section that means them', (sections['Waiting on the human'] ?? '').includes(decisionRaised) && (sections["Other sessions' requirements"] ?? '').includes(raised), JSON.stringify(Object.keys(sections)))
    check('a decision is never listed as claimable work', !(sections['Claimable for you'] ?? '').includes(decision) && !(sections["This session's requirements"] ?? '').includes(decision), (sections['Claimable for you'] ?? '').slice(0, 120))
    check('the decision really gates the urgent work behind it', service.getRequirement(worker, AI.session).gated === true && service.stats().criticalPath === 2, JSON.stringify({ gated: service.getRequirement(worker, AI.session).gated, criticalPath: service.stats().criticalPath }))
  } finally {
    await closeWorld(world)
  }
}

/** Split one prompt into its sections, keyed by the header before the colon. */
function splitSections(text) {
  const sections = {}
  let current = null
  for (const raw of String(text).split('\n')) {
    const header = raw.match(/^([A-Z][^:]*?) \(\d+/)
    if (header !== null && !raw.startsWith('-')) {
      current = header[1].trim()
      sections[current] = ''
      continue
    }
    if (current !== null) sections[current] += `${raw}\n`
  }
  return sections
}

console.log(`\n${checks - failures}/${checks} checks passed on the ${BACKEND} backend`)
process.exit(failures === 0 ? 0 : 1)
