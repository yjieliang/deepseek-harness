/**
 * Stage D cases: the cross-requirement gate and priority inheritance
 * (`ROLE-DISPATCH.md` §5.8, §5.9).
 *
 * A `blocksOn` link is a promise about *two* records, so every case here drives
 * the reader and the writer that share it: the gate is refused by `advance` and
 * `complete`, its links are validated as their own two graphs, and the derived
 * values (`blockedBy`, `gated`, `effectivePriority`, `escalated`, `advanceable`,
 * `children`, `stats.criticalPath`) are read back through the service, the tool,
 * and the panel route. Priority inheritance is never stored: every case asserts
 * what the board *reads* right now, then that finishing the blocker moves it.
 *
 * Every case runs against every backend in {@link BACKENDS}, because the links
 * and the parent are stored fields and have to survive a reopen.
 */

import { registerBoardRoute } from '../host/http.js'
import { resolveConfig } from '../host/config.js'
import { apply as applyBoardPlugin, createOwnershipPort } from '../index.js'
import {
  BACKENDS,
  createMountContext,
  createReporter,
  makeTempDir,
  openBoard,
  removeTempDir,
} from './harness.mjs'

const reporter = createReporter()
const { check } = reporter

/** The route the browser half calls. */
const ROUTE = '/api/requirement-board'

/** A flow whose single step is manual, so a case can move a requirement at will. */
const PLAIN_TEMPLATE = {
  id: 'tpl-gate-plain',
  name: '两步流程',
  nodes: [
    { id: 'p1', name: '第一步', dependsOn: [] },
    { id: 'p2', name: '第二步', dependsOn: ['p1'] },
  ],
}

/**
 * A flow whose second node waits on a node that comes later: advancing from the
 * first node is then refused by the *template* while the cross-requirement gate
 * is also unmet, which is what fixes the order the two refusals are judged in.
 */
const FORWARD_TEMPLATE = {
  id: 'tpl-gate-forward',
  name: '前向依赖',
  nodes: [
    { id: 'f1', name: '先做', dependsOn: [] },
    { id: 'f2', name: '依赖末尾', dependsOn: ['f3'] },
    { id: 'f3', name: '末尾', dependsOn: [] },
  ],
}

/** A live agent that resolves a role through its preset id (§2.1 fallback). */
function agentOf(id, preset, name = '') {
  return { id, name, status: 'idle', ctx: { preset } }
}

/** A fake agent registry, as `AgentRegistry` is: ownership compares parent identity. */
function fakeAgents(agents) {
  return {
    list: () => [...agents],
    get: id => agents.find(agent => agent.id === id),
    isOwnedBy: () => false,
  }
}

/** The preset registry fake: the composed preset id is the role id. */
function fakePresets() {
  return { composedPreset: ctx => ctx?.preset }
}

/** Drive the registered board route handler with one GET request. */
async function requestRoute(service, target) {
  let handler
  registerBoardRoute({ register: entry => { handler = entry.handler; return () => {} } }, service)
  const chunks = []
  const res = {
    statusCode: 0,
    setHeader: () => {},
    writeHead: status => { res.statusCode = status },
    on: () => {},
    end: chunk => { if (chunk !== undefined) chunks.push(String(chunk)) },
  }
  await handler({ method: 'GET', url: `${ROUTE}${target}`, headers: {}, on: () => {} }, res)
  const text = chunks.join('').trim()
  return { status: res.statusCode, body: text === '' ? null : JSON.parse(text) }
}

/** Run one case for one backend in its own directory. */
async function onBackend(backend, name, body) {
  const dir = await makeTempDir(`rb-gates-${backend}-`)
  console.log(`\n[${backend}] ${name}`)
  try {
    await body(dir)
  } finally {
    await removeTempDir(dir)
  }
}

/**
 * Open a board with the plugin mounted, so one domain backs the tool, the panel
 * route, and the prompt — the same wiring the Host uses.
 * @param options - Backend, directory, and the live agents to publish.
 * @returns the open board, its registry, and the registered board tool.
 */
async function openGateBoard({ backend, dir, agents = ['ses_A', 'ses_B', 'ses_C', 'ses_D', 'ses_E', 'ses_F', 'ses_G', 'ses_H', 'ses_I', 'ses_J'].map(id => agentOf(id, 'art-role', id)) } = {}) {
  const registry = fakeAgents(agents)
  const board = await openBoard({
    backend,
    dir,
    ports: {
      agents: () => registry,
      presets: () => fakePresets(),
      owns: createOwnershipPort({ get: serviceName => (serviceName === 'agents' ? registry : undefined) }),
    },
  })
  const mounted = createMountContext({
    storageDomain: { open: async () => board.domain },
    get: serviceName => {
      if (serviceName === 'agents') return registry
      if (serviceName === 'agentPresets') return fakePresets()
      return undefined
    },
  })
  await applyBoardPlugin(mounted.ctx, resolveConfig({ promptMaxItems: 12 }))
  return { ...board, registry, tool: mounted.records.tools[0], mounted }
}

/** Create the two custom flows every case that moves a requirement needs. */
async function seedTemplates(service, actor) {
  await service.createTemplate(PLAIN_TEMPLATE, actor)
  await service.createTemplate(FORWARD_TEMPLATE, actor)
}

/** Drive one `advance` and report what the board actually did with it. */
async function advanceOnce(service, id, actor) {
  const before = service.getRequirement(id)
  try {
    await service.transitionRequirement(id, { action: 'advance' }, actor)
    const after = service.getRequirement(id)
    return { moved: after.nodeId !== before.nodeId || after.status !== before.status, code: '', details: {} }
  } catch (error) {
    return { moved: false, code: error?.code ?? 'threw', details: error?.details ?? {} }
  }
}

/** Whether a refusal comes from one of the two gates, rather than the node's own work. */
function gateRefusal(outcome) {
  return outcome.code === 'dependency-not-met'
    || (outcome.code === 'invalid-transition' && outcome.details?.reason === 'blocked-by')
}

/**
 * Hold §4.4's derived `advanceable` against the transition that shares its rules:
 * a `true` must move the requirement, and a `false` must leave it where it is.
 *
 * The node's own completion condition is not permission, so that one case is
 * asserted separately.
 */
function checkAgreement(label, presented, outcome) {
  const agreed = presented.advanceable ? outcome.moved : !outcome.moved
  check(label, agreed, `advanceable=${presented.advanceable} moved=${outcome.moved} code=${outcome.code}`)
}

/** The gate links are stored fields that need the lock, and each change is one history entry. */
async function caseLinksAndHistory(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openGateBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: '' }
    const panel = { session: '', name: '面板' }
    const requirements = board.domain.table('requirements')
    await seedTemplates(service, panel)

    const blocker = await service.createRequirement({ summary: '测试简述', title: '阻塞者' }, a)
    const blocked = await service.createRequirement({ summary: '测试简述', title: '被阻塞', priority: 'high' }, a)

    const unlocked = await reporter.rejects('an unlocked session cannot set a blocker', () => service.updateRequirement(blocked.id, { blocksOn: [blocker.id] }, a), 'forbidden')
    check('the refusal is the missing lock, not the link', unlocked.details?.reason === 'lock-required')
    check('an unset gate is empty and ungated', service.getRequirement(blocked.id, a.session).blocksOn.length === 0 && service.getRequirement(blocked.id, a.session).gated === false)

    await service.claim(blocked.id, {}, a)
    const linked = await service.updateRequirement(blocked.id, { blocksOn: [blocker.id] }, a)
    check('the holder sets the blocker', linked.blocksOn.length === 1 && linked.blocksOn[0] === blocker.id)
    check('the stored record carries it', (requirements.get(blocked.id).blocksOn ?? []).length === 1)
    check('the derived blockedBy names it and the requirement reads as gated', linked.blockedBy[0] === blocker.id && linked.gated === true)
    check('the summary in list carries the same derivation', service.listRequirements({}, a.session).items.find(item => item.id === blocked.id)?.blockedBy?.[0] === blocker.id)

    const history = requirements.get(blocked.id).history
    const gateEntry = history[history.length - 1]
    check('the gate change is one history entry that names the whole gate', gateEntry.action === 'update'
      && String(gateEntry.note).includes('gates:') && String(gateEntry.note).includes(`blocksOn [${blocker.id}]`))
    check('the entry shows the graph the write left unset', String(gateEntry.note).includes('parentId ""'))

    await service.updateRequirement(blocked.id, { blocksOn: [blocker.id] }, a)
    check('rewriting the same gate adds no history', requirements.get(blocked.id).history.length === history.length)

    const parent = await service.createRequirement({ summary: '测试简述', title: '父需求', templateId: PLAIN_TEMPLATE.id }, a)
    const nested = await service.updateRequirement(blocked.id, { parentId: parent.id }, a)
    check('the holder sets the parent', nested.parentId === parent.id)
    check('the parent reads its children back', service.getRequirement(parent.id, a.session).children.includes(blocked.id))
    check('the summary in list carries the child list', service.listRequirements({}, a.session).items.find(item => item.id === parent.id)?.children?.includes(blocked.id) === true)
    const parentEntry = requirements.get(blocked.id).history.at(-1)
    check('the second gate change names the parent it set and keeps the blocker it did not touch',
      String(parentEntry?.note).includes(`parentId "${parent.id}"`) && String(parentEntry?.note).includes(`blocksOn [${blocker.id}]`))
    const cleared = await service.updateRequirement(blocked.id, { parentId: '' }, a)
    check('an empty parent clears the link and the child list', cleared.parentId === null && !service.getRequirement(parent.id, a.session).children.includes(blocked.id))

    const legacy = await service.createRequirement({ summary: '测试简述', title: '旧记录' }, a)
    const stored = requirements.get(legacy.id)
    const { blocksOn: _links, parentId: _parent, ...withoutGates } = stored
    await requirements.put(legacy.id, withoutGates)
    const reread = service.getRequirement(legacy.id, a.session)
    check('a record written before gating reads as a root that waits on nothing',
      reread.parentId === null && reread.blocksOn.length === 0 && reread.blockedBy.length === 0
      && reread.gated === false && reread.escalated === false && reread.effectivePriority === reread.priority)

    const kept = await service.updateRequirement(blocked.id, { title: '改了标题' }, a)
    check('a prose write leaves both graphs alone', kept.blocksOn[0] === blocker.id && kept.parentId === null)
    await board.close()
  })
}

/** `advance` and `complete` are refused by an unfinished blocker; `force` overrides and records it. */
async function caseProgressIsGated(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openGateBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: '' }
    const b = { session: 'ses_B', name: '' }
    const panel = { session: '', name: '面板' }
    const requirements = board.domain.table('requirements')
    await seedTemplates(service, panel)

    const blocker = await service.createRequirement({ summary: '测试简述', title: '阻塞者' }, a)
    const gated = await service.createRequirement({ summary: '测试简述', title: '被阻塞', templateId: PLAIN_TEMPLATE.id, blocksOn: [blocker.id] }, a)
    await service.claim(gated.id, {}, a)
    const before = service.getRequirement(gated.id, a.session)

    const advance = await reporter.rejects('advance is refused while a blocker is unfinished', () => service.transitionRequirement(gated.id, { action: 'advance' }, a), 'invalid-transition')
    check('the refusal names the reason, the blockers, and the verb', advance.details?.reason === 'blocked-by'
      && JSON.stringify(advance.details?.blockedBy) === JSON.stringify([blocker.id]) && advance.details?.action === 'advance')
    const complete = await reporter.rejects('complete goes through the same gate', () => service.transitionRequirement(gated.id, { action: 'complete' }, a), 'invalid-transition')
    check('the complete refusal carries the same blockers', complete.details?.reason === 'blocked-by' && JSON.stringify(complete.details?.blockedBy) === JSON.stringify([blocker.id]))

    const after = service.getRequirement(gated.id, a.session)
    check('a refused gate writes nothing at all', after.nodeId === before.nodeId && after.status === before.status
      && after.rev === before.rev && after.history.length === before.history.length)

    const forced = await service.transitionRequirement(gated.id, { action: 'complete', force: true, note: '紧急收尾' }, a)
    check('force overrides the gate', forced.status === 'done')
    const forcedEntry = requirements.get(gated.id).history.at(-1)
    check('the history records the override and the blockers it overrode', forcedEntry.force === true
      && JSON.stringify(forcedEntry.blockedBy) === JSON.stringify([blocker.id]) && forcedEntry.action === 'complete')

    const rework = await service.createRequirement({ summary: '测试简述', title: '返工', templateId: PLAIN_TEMPLATE.id, blocksOn: [blocker.id] }, a)
    await service.claim(rework.id, {}, a)
    await service.transitionRequirement(rework.id, { action: 'advance', force: true }, a)
    check('the forced advance moved it past the gate', service.getRequirement(rework.id).nodeId === 'p2')
    const back = await service.transitionRequirement(rework.id, { action: 'rollback', to: 'p1', note: '范围变了' }, a)
    check('rollback ignores the gate', back.nodeId === 'p1' && back.status === 'active')

    const shelved = await service.createRequirement({ summary: '测试简述', title: '搁置的阻塞者', templateId: PLAIN_TEMPLATE.id }, a)
    const waits = await service.createRequirement({ summary: '测试简述', title: '等待搁置者', templateId: PLAIN_TEMPLATE.id, blocksOn: [shelved.id] }, b)
    await service.claim(waits.id, {}, b)
    await service.setArchived(shelved.id, { archived: true }, panel)
    const presented = service.getRequirement(waits.id, b.session)
    check('an archived blocker is still a blocker', presented.gated === true && presented.blockedBy[0] === shelved.id)
    await reporter.rejects('shelving work is not finishing it', () => service.transitionRequirement(waits.id, { action: 'advance' }, b), 'invalid-transition')

    await service.setArchived(shelved.id, { archived: false }, panel)
    await service.transitionRequirement(shelved.id, { action: 'complete' }, panel)
    const cleared = service.getRequirement(waits.id, b.session)
    check('a finished blocker clears the gate', cleared.gated === false && cleared.blockedBy.length === 0)
    const advanced = await service.transitionRequirement(waits.id, { action: 'advance' }, b)
    check('the gate really opened: advance now moves it', advanced.nodeId === 'p2')
    await board.close()
  })
}

/** Both link graphs are validated: existence, self-reference, cycle, bound, and independence. */
async function caseLinkValidation(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openGateBoard({ backend, dir })
    const service = board.service
    // One session holds one lock at a time (§5.5), so every linked record gets
    // its own session: the writes below are each made by the record's holder.
    const actors = Object.fromEntries(['ses_A', 'ses_B', 'ses_C', 'ses_D', 'ses_E', 'ses_F', 'ses_G', 'ses_H', 'ses_I', 'ses_J']
      .map(id => [id, { session: id, name: '' }]))
    const [soloActor, xActor, yActor, zActor, p1Actor, p2Actor, p3Actor, g1Actor, g2Actor, wideActor] = Object.values(actors)
    const panel = { session: '', name: '面板' }
    await seedTemplates(service, panel)

    const solo = await service.createRequirement({ summary: '测试简述', title: '独自' }, soloActor)
    await service.claim(solo.id, {}, soloActor)
    const selfBlock = await reporter.rejects('a requirement cannot block on itself', () => service.updateRequirement(solo.id, { blocksOn: [solo.id] }, soloActor), 'invalid-argument')
    check('the self-reference names the field it is in', selfBlock.details?.reason === 'self-reference' && selfBlock.details?.field === 'blocksOn')
    const selfParent = await reporter.rejects('a requirement cannot be its own parent', () => service.updateRequirement(solo.id, { parentId: solo.id }, soloActor), 'invalid-argument')
    check('the parent self-reference names its own field', selfParent.details?.reason === 'self-reference' && selfParent.details?.field === 'parentId')

    const missing = await reporter.rejects('a blocker must exist', () => service.updateRequirement(solo.id, { blocksOn: ['req_ghost'] }, soloActor), 'invalid-argument')
    check('the missing target is named', missing.details?.reason === 'missing-target' && missing.details?.target === 'req_ghost')
    await reporter.rejects('a parent must exist', () => service.updateRequirement(solo.id, { parentId: 'req_ghost' }, soloActor), 'invalid-argument')

    const x = await service.createRequirement({ summary: '测试简述', title: 'X' }, xActor)
    const y = await service.createRequirement({ summary: '测试简述', title: 'Y' }, yActor)
    const z = await service.createRequirement({ summary: '测试简述', title: 'Z' }, zActor)
    await service.claim(x.id, {}, xActor)
    await service.claim(y.id, {}, yActor)
    await service.claim(z.id, {}, zActor)
    await service.updateRequirement(x.id, { blocksOn: [y.id] }, xActor)
    const twoCycle = await reporter.rejects('a two-record blocker cycle is refused', () => service.updateRequirement(y.id, { blocksOn: [x.id] }, yActor), 'invalid-argument')
    check('the cycle names both ends', twoCycle.details?.reason === 'cycle' && twoCycle.details?.field === 'blocksOn'
      && Array.isArray(twoCycle.details?.path) && twoCycle.details.path.includes(x.id) && twoCycle.details.path.includes(y.id))
    await service.updateRequirement(y.id, { blocksOn: [z.id] }, yActor)
    const longCycle = await reporter.rejects('a three-record blocker cycle is refused', () => service.updateRequirement(z.id, { blocksOn: [x.id] }, zActor), 'invalid-argument')
    check('the long cycle reports the whole path', longCycle.details?.reason === 'cycle' && (longCycle.details?.path ?? []).length === 4)
    check('the refused cycle left the stored links alone', (board.domain.table('requirements').get(z.id).blocksOn ?? []).length === 0)

    const p1 = await service.createRequirement({ summary: '测试简述', title: 'P1' }, p1Actor)
    const p2 = await service.createRequirement({ summary: '测试简述', title: 'P2' }, p2Actor)
    const p3 = await service.createRequirement({ summary: '测试简述', title: 'P3' }, p3Actor)
    await service.claim(p1.id, {}, p1Actor)
    await service.claim(p2.id, {}, p2Actor)
    await service.claim(p3.id, {}, p3Actor)
    await service.updateRequirement(p2.id, { parentId: p1.id }, p2Actor)
    const parentCycle = await reporter.rejects('a parent chain cannot come back', () => service.updateRequirement(p1.id, { parentId: p2.id }, p1Actor), 'invalid-argument')
    check('the parent cycle is reported against the parent graph', parentCycle.details?.reason === 'cycle' && parentCycle.details?.field === 'parentId')
    await service.updateRequirement(p3.id, { parentId: p2.id }, p3Actor)
    await reporter.rejects('a longer parent chain cannot come back either', () => service.updateRequirement(p1.id, { parentId: p3.id }, p1Actor), 'invalid-argument')

    // The two graphs are separate: one may hold a link the other would call a cycle.
    const g1 = await service.createRequirement({ summary: '测试简述', title: 'G1' }, g1Actor)
    const g2 = await service.createRequirement({ summary: '测试简述', title: 'G2' }, g2Actor)
    await service.claim(g1.id, {}, g1Actor)
    await service.claim(g2.id, {}, g2Actor)
    const across = await service.updateRequirement(g2.id, { blocksOn: [g1.id] }, g2Actor)
    const crossGraph = await service.updateRequirement(g1.id, { parentId: g2.id }, g1Actor)
    check('a parent link is judged alone, not against the blocker graph', across.blocksOn[0] === g1.id && crossGraph.parentId === g2.id)
    // The same two records in one graph are a cycle; split across the two, they are not.
    await reporter.rejects('the same pair is still a cycle inside the blocker graph', () => service.updateRequirement(g1.id, { blocksOn: [g2.id] }, g1Actor), 'invalid-argument')
    await reporter.rejects('and inside the parent graph', () => service.updateRequirement(g2.id, { parentId: g1.id }, g2Actor), 'invalid-argument')

    const many = []
    for (let index = 0; index < 21; index += 1) many.push(await service.createRequirement({ summary: '测试简述', title: `批量 ${index}` }, soloActor))
    const wide = await service.createRequirement({ summary: '测试简述', title: '宽门禁' }, wideActor)
    await service.claim(wide.id, {}, wideActor)
    const over = await reporter.rejects('more than twenty blockers is refused', () => service.updateRequirement(wide.id, { blocksOn: many.map(item => item.id) }, wideActor), 'invalid-argument')
    check('the bound refusal names the field', String(over.message).includes('blocksOn'))
    check('the refused bound left the links empty', service.getRequirement(wide.id, wideActor.session).blocksOn.length === 0)
    const full = await service.updateRequirement(wide.id, { blocksOn: many.slice(0, 20).map(item => item.id) }, wideActor)
    check('exactly twenty blockers is accepted in order', full.blocksOn.length === 20 && full.blocksOn[0] === many[0].id)
    const deduped = await service.updateRequirement(wide.id, { blocksOn: [many[0].id, many[0].id, many[1].id] }, wideActor)
    check('a repeated id is kept once', deduped.blocksOn.length === 2 && deduped.blocksOn[0] === many[0].id)
    await board.close()
  })
}

/** Both gates are judged in the order the tool description promises, template first. */
async function caseTemplateBeforeGate(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openGateBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: '' }
    const b = { session: 'ses_B', name: '' }
    const panel = { session: '', name: '面板' }
    const requirements = board.domain.table('requirements')
    await seedTemplates(service, panel)

    const blocker = await service.createRequirement({ summary: '测试简述', title: '阻塞者' }, a)
    const both = await service.createRequirement({ summary: '测试简述', title: '两重门禁', templateId: FORWARD_TEMPLATE.id, blocksOn: [blocker.id] }, a)
    await service.claim(both.id, {}, a)

    const template = await reporter.rejects('the template prerequisite is judged first', () => service.transitionRequirement(both.id, { action: 'advance' }, a), 'dependency-not-met')
    check('the prerequisite refusal names the node and what it still waits on',
      template.details?.node === 'f2' && (template.details?.missing ?? []).includes('f3'))

    const forced = await service.transitionRequirement(both.id, { action: 'advance', force: true }, a)
    check('one force flag overrides the template gate and the move lands', forced.nodeId === 'f2')
    const forcedEntry = requirements.get(both.id).history.at(-1)
    check('the same record keeps which gate force overrode', forcedEntry.force === true
      && JSON.stringify(forcedEntry.blockedBy) === JSON.stringify([blocker.id]))
    const atSecond = await reporter.rejects('on the next node the template is met and only the blocker gate is left', () => service.transitionRequirement(both.id, { action: 'advance' }, a), 'invalid-transition')
    check('the refusal is the blocker gate, not the template', atSecond.details?.reason === 'blocked-by' && JSON.stringify(atSecond.details?.blockedBy) === JSON.stringify([blocker.id]))

    const alone = await service.createRequirement({ summary: '测试简述', title: '只有模板门禁', templateId: FORWARD_TEMPLATE.id }, b)
    await service.claim(alone.id, {}, b)
    const aloneRefusal = await reporter.rejects('an ungated requirement still waits on the template', () => service.transitionRequirement(alone.id, { action: 'advance' }, b), 'dependency-not-met')
    check('the template refusal carries no blocker list', aloneRefusal.details?.blockedBy === undefined)

    await service.transitionRequirement(blocker.id, { action: 'complete' }, panel)
    const onward = await service.transitionRequirement(both.id, { action: 'advance' }, a)
    check('with the blocker finished the ordinary advance continues', onward.nodeId === 'f3')

    const description = String(board.tool.description)
    check('the tool description states the order the two gates are judged in',
      description.includes('dependency-not-met') && description.indexOf('dependency-not-met') < description.indexOf('invalid-transition'),
      description.slice(0, 160))
    check('the tool description keeps an archived blocker blocking', /archived blocker still blocks/.test(description))
    check('the tool takes both gate links', 'blocksOn' in board.tool.parameters.properties && 'parentId' in board.tool.parameters.properties)
    await board.close()
  })
}

/** Priority inheritance travels the blocker chain, caps at `urgent`, and is never stored. */
async function casePriorityInheritance(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openGateBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: '' }
    const panel = { session: '', name: '面板' }
    const requirements = board.domain.table('requirements')
    await seedTemplates(service, panel)

    const far = await service.createRequirement({ summary: '测试简述', title: '底层', priority: 'low', templateId: PLAIN_TEMPLATE.id }, a)
    const mid = await service.createRequirement({ summary: '测试简述', title: '中层', priority: 'normal', templateId: PLAIN_TEMPLATE.id, blocksOn: [far.id] }, a)
    const top = await service.createRequirement({ summary: '测试简述', title: '顶层', priority: 'high', templateId: PLAIN_TEMPLATE.id, blocksOn: [mid.id] }, a)
    const read = id => service.getRequirement(id, a.session)

    check('the blocker is raised by what it holds up', read(far.id).effectivePriority === 'high' && read(far.id).escalated === true)
    check('inheritance travels the whole chain', read(mid.id).effectivePriority === 'high' && read(mid.id).escalated === true)
    check('the requirement that waits is gated, not escalated', read(top.id).effectivePriority === 'high' && read(top.id).escalated === false && read(top.id).gated === true)
    check('the raised value is never written back', requirements.get(far.id).priority === 'low' && (requirements.get(far.id).blocksOn ?? []).length === 0)
    check('the statistic counts the raised requirements, not the blocked ones', service.stats().criticalPath === 2)

    const capBlocker = await service.createRequirement({ summary: '测试简述', title: '封顶阻塞者', priority: 'low', templateId: PLAIN_TEMPLATE.id }, a)
    const capHolder = await service.createRequirement({ summary: '测试简述', title: '紧急等待者', priority: 'urgent', templateId: PLAIN_TEMPLATE.id, blocksOn: [capBlocker.id] }, a)
    check('inheritance stops at the top of the ladder', read(capBlocker.id).effectivePriority === 'urgent' && read(capBlocker.id).escalated === true)
    check('the urgent end of the ladder is unchanged for its own holder', read(capHolder.id).effectivePriority === 'urgent' && read(capHolder.id).escalated === false)
    check('criticalPath counts every raised requirement once', service.stats().criticalPath === 3)

    await service.transitionRequirement(top.id, { action: 'complete', force: true }, panel)
    check('finishing the top drops its own escalation and lowers the chain', read(mid.id).effectivePriority === 'normal' && read(mid.id).escalated === false)
    check('the middle requirement still raises the lowest one', read(far.id).effectivePriority === 'normal' && read(far.id).escalated === true)
    check('the statistic follows the fallback', service.stats().criticalPath === 2)

    await service.transitionRequirement(far.id, { action: 'complete' }, panel)
    check('a finished blocker clears the requirement that waited on it', read(mid.id).gated === false && read(mid.id).blockedBy.length === 0)
    check('nothing is left raised for the cleared pair', service.stats().criticalPath === 1)

    const held = await service.createRequirement({ summary: '测试简述', title: '提示里的阻塞者', priority: 'normal', templateId: PLAIN_TEMPLATE.id }, a)
    const urgent = await service.createRequirement({ summary: '测试简述', title: '提示里的紧急者', priority: 'urgent', templateId: PLAIN_TEMPLATE.id, blocksOn: [held.id] }, a)
    const prompt = service.promptContext('ses_A', 12)
    const raisedLine = prompt.split('\n').find(line => line.includes(held.id)) ?? ''
    const waitingLine = prompt.split('\n').find(line => line.includes(urgent.id)) ?? ''
    check('the prompt tags the raised requirement with the arrow', raisedLine.includes('[urgent↑]'))
    check('the prompt tags the requirement that waits with its own priority', waitingLine.includes('[urgent]') && !waitingLine.includes('↑'))
    await board.close()
  })
}

/** §4.4's `advanceable` and the transition answer the same question from one rule. */
async function caseAdvanceableAgrees(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openGateBoard({ backend, dir })
    const service = board.service
    // One session holds one lock at a time (§5.5), so each fixture is driven by
    // a session of its own and the derived flag is read for that same session.
    const of = id => ({ session: id, name: '' })
    const panel = { session: '', name: '面板' }
    await seedTemplates(service, panel)
    const held = async (id, title, input = {}) => {
      const actor = of(id)
      const requirement = await service.createRequirement({ summary: '测试简述', title, templateId: PLAIN_TEMPLATE.id, ...input }, actor)
      await service.claim(requirement.id, {}, actor)
      return { actor, requirement }
    }

    const free = await service.createRequirement({ summary: '测试简述', title: '无人认领', templateId: PLAIN_TEMPLATE.id }, of('ses_A'))
    checkAgreement('free work is takeable but not advanceable', service.getRequirement(free.id, 'ses_A'), await advanceOnce(service, free.id, of('ses_A')))

    const mine = await held('ses_B', '已持有')
    checkAgreement('held work with a clear gate is advanceable', service.getRequirement(mine.requirement.id, 'ses_B'), await advanceOnce(service, mine.requirement.id, mine.actor))

    const theirs = await held('ses_C', '别人持有')
    checkAgreement('another session\'s lock is not mine to advance', service.getRequirement(theirs.requirement.id, 'ses_A'), await advanceOnce(service, theirs.requirement.id, of('ses_A')))

    const unfinished = await service.createRequirement({ summary: '测试简述', title: '未完成' }, of('ses_D'))
    const waiting = await held('ses_D', '等未完成', { blocksOn: [unfinished.id] })
    checkAgreement('work waiting on an unfinished blocker is not advanceable', service.getRequirement(waiting.requirement.id, 'ses_D'), await advanceOnce(service, waiting.requirement.id, waiting.actor))

    const finished = await service.createRequirement({ summary: '测试简述', title: '已完成', templateId: PLAIN_TEMPLATE.id }, of('ses_E'))
    await service.transitionRequirement(finished.id, { action: 'complete' }, panel)
    const unblocked = await held('ses_E', '等已完成', { blocksOn: [finished.id] })
    checkAgreement('a finished blocker is not a gate at all', service.getRequirement(unblocked.requirement.id, 'ses_E'), await advanceOnce(service, unblocked.requirement.id, unblocked.actor))

    const forward = await held('ses_F', '前向依赖', { templateId: FORWARD_TEMPLATE.id })
    checkAgreement('an unmet node prerequisite is not advanceable', service.getRequirement(forward.requirement.id, 'ses_F'), await advanceOnce(service, forward.requirement.id, forward.actor))

    const done = await held('ses_G', '已完成两步')
    await service.transitionRequirement(done.requirement.id, { action: 'advance' }, done.actor)
    await service.transitionRequirement(done.requirement.id, { action: 'advance' }, done.actor)
    check('the fixture really is done', service.getRequirement(done.requirement.id).status === 'done')
    checkAgreement('finished work is not advanceable', service.getRequirement(done.requirement.id, 'ses_G'), await advanceOnce(service, done.requirement.id, done.actor))

    const archived = await held('ses_H', '已归档')
    await service.setArchived(archived.requirement.id, { archived: true }, archived.actor)
    checkAgreement('archived work is not advanceable', service.getRequirement(archived.requirement.id, 'ses_H'), await advanceOnce(service, archived.requirement.id, archived.actor))

    const last = await held('ses_I', '最后一步')
    await service.transitionRequirement(last.requirement.id, { action: 'advance' }, last.actor)
    checkAgreement('an advance that finishes the requirement still counts as moved', service.getRequirement(last.requirement.id, 'ses_I'), await advanceOnce(service, last.requirement.id, last.actor))

    const checklist = await held('ses_J', '未勾选', { templateId: 'tpl-standard' })
    const checklistOutcome = await advanceOnce(service, checklist.requirement.id, checklist.actor)
    check('the node\'s own completion condition is judged by the transition, not by the derived flag',
      service.getRequirement(checklist.requirement.id, 'ses_J').advanceable === true && checklistOutcome.code === 'completion-not-met')

    const question = await service.createRequirement({ summary: '测试简述', title: '要人回答', kind: 'decision', templateId: PLAIN_TEMPLATE.id }, of('ses_A'))
    const forSession = service.getRequirement(question.id, 'ses_A')
    checkAgreement('a decision is not a session\'s to advance', forSession, await advanceOnce(service, question.id, of('ses_A')))
    const forPanel = service.getRequirement(question.id, '')
    check('the panel may advance a decision, and says so', forPanel.advanceable === true)
    checkAgreement('the panel\'s own answer matches its transition', forPanel, await advanceOnce(service, question.id, panel))

    const twice = await held('ses_A', '两重门禁', { templateId: FORWARD_TEMPLATE.id, blocksOn: [unfinished.id] })
    checkAgreement('both gates unmet still answer false', service.getRequirement(twice.requirement.id, 'ses_A'), await advanceOnce(service, twice.requirement.id, twice.actor))

    const reserved = await service.createRequirement({ summary: '测试简述', title: '被预留', templateId: PLAIN_TEMPLATE.id }, of('ses_B'))
    await service.queue(reserved.id, {}, of('ses_C'))
    checkAgreement('a reservation by another session is not advanceable either', service.getRequirement(reserved.id, 'ses_B'), await advanceOnce(service, reserved.id, of('ses_B')))
    await board.close()
  })
}

/** The panel's snapshot, the tool's get/list, and the statistics carry the same derivations. */
async function caseReadersCarryGates(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openGateBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: '' }
    const b = { session: 'ses_B', name: '' }
    const panel = { session: '', name: '面板' }
    await seedTemplates(service, panel)

    const blocker = await service.createRequirement({ summary: '测试简述', title: '阻塞者', priority: 'low', templateId: PLAIN_TEMPLATE.id }, a)
    const gated = await service.createRequirement({ summary: '测试简述', title: '被阻塞', priority: 'urgent', templateId: PLAIN_TEMPLATE.id, blocksOn: [blocker.id] }, a)
    const free = await service.createRequirement({ summary: '测试简述', title: '自由', templateId: PLAIN_TEMPLATE.id }, a)
    await service.claim(gated.id, {}, a)

    const snapshot = await requestRoute(service, '/snapshot')
    check('the panel snapshot answered', snapshot.status === 200 && snapshot.body?.ok === true)
    const rows = snapshot.body?.data?.requirements ?? []
    const gatedRow = rows.find(item => item.id === gated.id)
    const blockerRow = rows.find(item => item.id === blocker.id)
    check('the snapshot carries the links and the derived gate', gatedRow?.blocksOn?.[0] === blocker.id && gatedRow?.blockedBy?.[0] === blocker.id && gatedRow?.gated === true)
    check('the snapshot carries the parent default and the child list', gatedRow?.parentId === null && Array.isArray(blockerRow?.children))
    check('the snapshot carries inheritance for the raised blocker', blockerRow?.effectivePriority === 'urgent' && blockerRow?.escalated === true)
    check('the snapshot answers the panel, which holds no lock', blockerRow?.advanceable === true)
    check('the statistics carry the critical path too', snapshot.body?.data?.stats?.criticalPath === service.stats().criticalPath && snapshot.body?.data?.stats?.criticalPath === 1)

    const forSession = await requestRoute(service, '/snapshot?me=ses_A')
    const sessionRow = (forSession.body?.data?.requirements ?? []).find(item => item.id === gated.id)
    check('the same route answers for a named session when asked', sessionRow?.gated === true && sessionRow?.advanceable === false && sessionRow?.claimable === true)

    // The tool reads its caller from the run context, so these calls pass the
    // agent the Host would.
    const tag = id => ({ agent: { id } })
    const viaGet = await board.tool.execute({ action: 'get', id: free.id }, tag('ses_B'))
    check('the tool distinguishes what a session may take from what it may advance', viaGet.claimable === true && viaGet.advanceable === false)
    const held = await board.tool.execute({ action: 'get', id: gated.id }, tag('ses_A'))
    check('the tool answers for the session that holds the lock', held.gated === true && held.advanceable === false && held.blockedBy[0] === blocker.id)
    const listed = await board.tool.execute({ action: 'list' }, tag('ses_A'))
    check('the tool list carries every gate field', listed.items.every(item => 'blocksOn' in item && 'parentId' in item && 'children' in item
      && 'blockedBy' in item && 'gated' in item && 'effectivePriority' in item && 'escalated' in item && 'claimable' in item && 'advanceable' in item))

    const catchup = service.changesSince(new Date(Date.now() - 60_000).toISOString())
    const caughtRow = catchup.requirements.find(item => item.id === gated.id)
    check('the catch-up diff carries the gate but no reader\'s eligibility', caughtRow?.gated === true && caughtRow?.escalated === false && !('advanceable' in (caughtRow ?? {})))
    await board.close()
  })
}

/** Deleting a requirement unbinds both graphs and its queue entries in the same chain. */
async function caseDeleteUnbinds(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openGateBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: '' }
    const b = { session: 'ses_B', name: '' }
    const panel = { session: '', name: '面板' }
    const requirements = board.domain.table('requirements')
    const queues = board.domain.table('queues')
    await seedTemplates(service, panel)

    const other = await service.createRequirement({ summary: '测试简述', title: '留下的' }, a)
    const target = await service.createRequirement({ summary: '测试简述', title: '被删的目标' }, a)
    const waits = await service.createRequirement({ summary: '测试简述', title: '等待被删者', templateId: PLAIN_TEMPLATE.id, blocksOn: [target.id] }, a)
    const child = await service.createRequirement({ summary: '测试简述', title: '被删者的子', templateId: PLAIN_TEMPLATE.id, parentId: target.id }, a)
    const mixed = await service.createRequirement({ summary: '测试简述', title: '另一条链接', templateId: PLAIN_TEMPLATE.id, blocksOn: [other.id, target.id] }, a)
    await service.queue(target.id, {}, b)
    check('the fixture really reserved the doomed requirement', service.queueOf('ses_B').items.some(item => item.id === target.id))

    const receipt = await service.deleteRequirement(target.id, {}, panel)
    check('the receipt lists everything it unbound', Array.isArray(receipt.unbound)
      && receipt.unbound.includes(waits.id) && receipt.unbound.includes(child.id) && receipt.unbound.includes(mixed.id)
      && !receipt.unbound.includes(other.id))
    check('the waiter waits on nothing now', service.getRequirement(waits.id, a.session).blocksOn.length === 0)
    check('the mixed list keeps the links that were not deleted', service.getRequirement(mixed.id, a.session).blocksOn.length === 1
      && service.getRequirement(mixed.id, a.session).blocksOn[0] === other.id)
    check('a child of the deleted requirement is a root again', service.getRequirement(child.id, a.session).parentId === null)
    check('the unbinding is recorded as a gate change that says why', requirements.get(waits.id).history.at(-1).action === 'update'
      && String(requirements.get(waits.id).history.at(-1).note).includes('deleted'))
    check('the queue no longer names the deleted requirement', (queues.get('ses_B')?.items ?? []).every(item => item.id !== target.id) && service.stats().reserved === 0)

    const freed = await service.claim(waits.id, {}, a)
    check('the gate really opened for the waiter', freed.gated === false)
    const lonely = await service.createRequirement({ summary: '测试简述', title: '无人引用' }, a)
    const lonelyReceipt = await service.deleteRequirement(lonely.id, {}, panel)
    check('a delete with nothing to unbind reports an empty list', Array.isArray(lonelyReceipt.unbound) && lonelyReceipt.unbound.length === 0)
    await board.close()
  })
}

/** Crash residue: a dangling link is ignored by the gate and cleared by the sweep. */
async function caseSweepUnbinds(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openGateBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: '' }
    const panel = { session: '', name: '面板' }
    const requirements = board.domain.table('requirements')
    await seedTemplates(service, panel)

    const ghosted = await service.createRequirement({ summary: '测试简述', title: '残留引用', templateId: PLAIN_TEMPLATE.id }, a)
    const stored = requirements.get(ghosted.id)
    await requirements.put(ghosted.id, { ...stored, blocksOn: ['req_ghost'], parentId: 'req_missing' })
    const before = service.getRequirement(ghosted.id, a.session)
    check('a dangling blocker is not a gate', before.gated === false && before.blockedBy.length === 0)
    check('the dangling list is still shown for what it is', before.blocksOn[0] === 'req_ghost' && before.parentId === 'req_missing')
    check('a dangling link does not raise the priority either', before.effectivePriority === before.priority && before.escalated === false)

    const report = await service.sweepDangling()
    check('the sweep reports the requirement it unbound', report.unboundLinks.includes(ghosted.id))
    const swept = service.getRequirement(ghosted.id, a.session)
    check('the dangling blockers are dropped and the parent is cleared', swept.blocksOn.length === 0 && swept.parentId === null)
    check('the sweep bumped the revision instead of writing history', swept.rev > before.rev && swept.history.length === before.history.length)
    const twice = await service.sweepDangling()
    check('a second sweep finds nothing left to unbind', twice.unboundLinks.length === 0)
    await board.close()
  })
}

for (const backend of BACKENDS) {
  await caseLinksAndHistory(backend, 'the gate links need the lock and each change is recorded')
  await caseProgressIsGated(backend, 'advance and complete are gated, force overrides and records it')
  await caseLinkValidation(backend, 'both link graphs are validated for existence, self-reference, and cycles')
  await caseTemplateBeforeGate(backend, 'the template prerequisite is judged before the cross-requirement gate')
  await casePriorityInheritance(backend, 'priority inheritance travels the chain, caps, and is never stored')
  await caseAdvanceableAgrees(backend, 'the derived advanceable agrees with the transition that shares its rule')
  await caseReadersCarryGates(backend, 'the snapshot, the tool, and the catch-up diff carry the same derivations')
  await caseDeleteUnbinds(backend, 'deleting unbinds both graphs and the queues in the same chain')
  await caseSweepUnbinds(backend, 'a dangling link never gates, and the sweep removes it')
}

process.exit(reporter.finish() ? 0 : 1)
