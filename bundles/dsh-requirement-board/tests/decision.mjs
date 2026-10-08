/**
 * Stage C cases: the decision queue and the immutable kind
 * (`ROLE-DISPATCH.md` §9 "C 决策队列 + kind 不可变").
 *
 * A decision is an ordinary record carrying one extra promise: only the human
 * advances it (§5.7). That promise is enforced in the operations that make the
 * change, not in a prompt or a parameter schema, so every case drives a real
 * caller — the agent tool, the panel's HTTP command, or the panel's route — and
 * asserts the same service answer. `kind` is fixed at creation for the same
 * reason: a later write must not be able to turn a question into ordinary work.
 *
 * Every case runs against every backend in {@link BACKENDS}, because both the
 * kind and the requester are stored fields and have to survive a reopen.
 */

import { dispatchBoardCommand, registerBoardRoute } from '../host/http.js'
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

/** A live agent that resolves a role through its preset id (§2.1 fallback). */
function agentOf(id, preset, name = '') {
  return { id, name, status: 'idle', ctx: { preset } }
}

/**
 * A fake agent registry in the platform's own terms, as `AgentRegistry` is:
 * `isOwnedBy(id, owner)` compares the parent Agent by object identity.
 * @param agents - Live agents.
 * @param ownership - `[childId, parentId]` pairs that really are owned.
 */
function fakeAgents(agents, ownership = []) {
  return {
    list: () => [...agents],
    get: id => agents.find(agent => agent.id === id),
    isOwnedBy: (id, owner) => ownership.some(([child, parent]) => child === id && agents.find(agent => agent.id === parent) === owner),
  }
}

/** The preset registry fake: the composed preset id is the role id. */
function fakePresets() {
  return { composedPreset: ctx => ctx?.preset }
}

/**
 * Drive the registered board route handler with one GET request.
 *
 * The browser reaches the board through a query string, which is a second way
 * into the same filters the command body uses. The route is mounted on a stub
 * `webServer`, so no listener and no authentication is involved.
 * @param service - The board service.
 * @param target - Path after the route prefix, query string included.
 * @returns `{ status, body }` of the reply.
 */
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

/** The `- id` lines of one prompt section, up to the next section header. */
function promptSection(text, header) {
  const lines = String(text).split('\n')
  const start = lines.findIndex(line => line.startsWith(header))
  if (start < 0) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => !line.startsWith('- '))
  return rest.slice(0, end < 0 ? rest.length : end)
    .map(line => line.match(/^- (req_[0-9a-f]+)/)?.[1])
    .filter(Boolean)
}

/** Run one case for one backend in its own directory. */
async function onBackend(backend, name, body) {
  const dir = await makeTempDir(`rb-decision-${backend}-`)
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
async function openDecisionBoard({ backend, dir, agents = [agentOf('ses_A', 'art-role', '小画家'), agentOf('ses_child', 'art-role', '小助手')] } = {}) {
  const registry = fakeAgents(agents, [['ses_child', 'ses_A']])
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

/** `kind` defaults to a task, is fixed at creation, and reads back on every view. */
async function caseKindAtCreate(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDecisionBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: '' }
    const requirements = board.domain.table('requirements')

    const plain = await service.createRequirement({ title: '普通任务' }, a)
    check('kind defaults to a task', plain.kind === 'task' && requirements.get(plain.id).kind === 'task')
    check('an empty kind is the default, not a refusal', (await service.createRequirement({ title: '空 kind', kind: '' }, a)).kind === 'task')

    const question = await service.createRequirement({ title: '要不要上色', kind: 'decision' }, a)
    check('an explicit decision is stored and presented', question.kind === 'decision' && requirements.get(question.id).kind === 'decision')
    const listed = await service.listRequirements({}, '')
    check('a decision lists beside tasks by default', listed.items.some(item => item.id === question.id) && listed.items.some(item => item.id === plain.id))

    const before = requirements.size
    const refused = await reporter.rejects('an unknown kind is refused', () => service.createRequirement({ title: 'x', kind: 'epic' }, a), 'invalid-argument')
    check('the refusal carries the value it received', refused.details?.received === 'epic')
    check('the refused creation wrote nothing', requirements.size === before)

    // A record written before `kind` existed reads as an ordinary task.
    await requirements.update(plain.id, record => {
      const { kind, ...legacy } = record
      return legacy
    })
    const legacy = await service.getRequirement(plain.id)
    check('a record without kind reads as a task', legacy.kind === 'task')
    check('and it stays claimable', (await service.claim(plain.id, {}, a)).lock.session === 'ses_A')
    check('a decision with no kind field is not mistaken for one', (await service.listRequirements({ kind: 'decision' }, '')).items.every(item => item.kind === 'decision'))
    await board.close()
  })
}

/** `kind` cannot be changed after creation, through any caller or entry point. */
async function caseKindImmutable(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDecisionBoard({ backend, dir })
    const service = board.service
    const agent = agentOf('ses_A', 'art-role', '小画家')
    const a = { session: 'ses_A', name: '小画家' }
    const question = await service.createRequirement({ title: '不可改', kind: 'decision' }, a)
    const before = board.domain.table('requirements').get(question.id)

    const viaService = await reporter.rejects('the service refuses a kind change', () => service.updateRequirement(question.id, { kind: 'task' }, a), 'invalid-argument')
    check('the refusal names the immutability rule and the value', viaService.details?.reason === 'kind-immutable' && viaService.details?.kind === 'task')
    const viaTool = await reporter.rejects('the tool refuses a kind change', () => board.tool.execute({ action: 'update', id: question.id, kind: 'task' }, { agent }), 'invalid-argument')
    check('the tool gets the same refusal', viaTool.details?.reason === 'kind-immutable')
    const viaCommand = await reporter.rejects('the panel command refuses a kind change', () => dispatchBoardCommand(service, { action: 'update', id: question.id, patch: { kind: 'task' }, session: 'ses_A' }), 'invalid-argument')
    check('the command gets the same refusal', viaCommand.details?.reason === 'kind-immutable')
    const viaPanel = await reporter.rejects('the human cannot change it either', () => dispatchBoardCommand(service, { action: 'update', id: question.id, patch: { kind: 'task' }, session: '' }), 'invalid-argument')
    check('immutability is not the human\'s to waive', viaPanel.details?.reason === 'kind-immutable')

    const after = board.domain.table('requirements').get(question.id)
    check('no refused attempt wrote the record', after.kind === 'decision' && after.rev === before.rev)
    const sinceCreation = service.changesSince(question.createdAt)
    check('and no refused attempt touched it after creation', !sinceCreation.requirements.some(item => item.id === question.id && item.rev > before.rev))

    const legal = await service.updateRequirement(question.id, { description: '补齐选项' }, a)
    check('a legal update still works and leaves the kind alone', legal.kind === 'decision' && legal.description === '补齐选项' && board.domain.table('requirements').get(question.id).rev > before.rev)
    await board.close()
  })
}

/** The six actions an agent may not take on a decision, through both of its entry points. */
async function caseDecisionRefusals(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDecisionBoard({ backend, dir })
    const service = board.service
    const agent = agentOf('ses_A', 'art-role', '小画家')
    const question = await service.createRequirement({ title: '谁来决定', kind: 'decision' }, { session: 'ses_A', name: '小画家' })
    const before = board.domain.table('requirements').get(question.id)

    // The agent's own entry point: the tool, where the actor is the calling session.
    const toolAttempts = [
      ['claim', { action: 'claim', id: question.id }],
      ['queue', { action: 'queue', id: question.id }],
      ['delegate', { action: 'delegate', id: question.id, session: 'ses_child' }],
      ['transition', { action: 'transition', id: question.id, transition: 'complete' }],
      ['archive', { action: 'archive', id: question.id }],
      ['delete', { action: 'delete', id: question.id }],
    ]
    for (const [label, args] of toolAttempts) {
      const refused = await reporter.rejects(`the tool refuses to ${label} a decision`, () => board.tool.execute(args, { agent }), 'forbidden')
      check(`the tool names the decision rule for ${label}`, refused.details?.reason === 'decision-task' && refused.details?.id === question.id)
    }
    const revokeRefused = await reporter.rejects('the tool cannot revoke a delegation it could not make', () => board.tool.execute({ action: 'delegate', id: question.id, revoke: true }, { agent }), 'forbidden')
    check('the delegation end is refused by the same rule', revokeRefused.details?.reason === 'decision-task')

    // The panel's command surface: two of the six actions do not exist there at all
// (the panel holds no lock and reserves nothing, so `claim` and `queue` are not
// panel operations), and the rest reach the same service rule.
    const absentActions = [
      ['claim', { action: 'claim', id: question.id, session: 'ses_A' }],
      ['queue', { action: 'queue', id: question.id, session: 'ses_A' }],
    ]
    for (const [label, body] of absentActions) {
      const refused = await reporter.rejects(`the panel command has no ${label} action for a session to misuse`, () => dispatchBoardCommand(service, body), 'invalid-argument')
      check(`the missing ${label} action is refused as an unknown action`, String(refused.message).includes('unknown action'))
    }
    const commandAttempts = [
      ['transition', { action: 'transition', id: question.id, transition: 'complete', session: 'ses_A' }],
      ['archive', { action: 'archive', id: question.id, session: 'ses_A' }],
      ['delete', { action: 'delete', id: question.id, session: 'ses_A' }],
    ]
    for (const [label, body] of commandAttempts) {
      const refused = await reporter.rejects(`the command refuses to ${label} a decision for a session`, () => dispatchBoardCommand(service, body), 'forbidden')
      check(`the command names the decision rule for ${label}`, refused.details?.reason === 'decision-task')
    }
    // The same three at the service, which is where the rule lives: a surface
    // that lacks an action is not the enforcement (AGENTS.md).
    for (const [label, call] of [
      ['transition', () => service.transitionRequirement(question.id, { action: 'complete' }, { session: 'ses_A', name: '' })],
      ['archive', () => service.setArchived(question.id, { archived: true }, { session: 'ses_A', name: '' })],
      ['delete', () => service.deleteRequirement(question.id, {}, { session: 'ses_A', name: '' })],
    ]) {
      const refused = await reporter.rejects(`the service refuses to ${label} a decision for any surface`, call, 'forbidden')
      check(`the service refusal for ${label} is the decision rule`, refused.details?.reason === 'decision-task')
    }
    // The three actions outside the six (§5.7) are not a way around the rule: no
    // agent can hold a decision's lock because `claim` is refused above, so none of
    // them is reachable for an agent on a decision. Each names the human-only rule
    // and not the missing lock: the lock is not the reason it fails, and
    // `lock-required` would send the model after a lock nobody can take.
    for (const [label, call] of [
      ['block', () => service.blockRequirement(question.id, { reason: '想绕过' }, { session: 'ses_A', name: '' })],
      ['unblock', () => service.unblockRequirement(question.id, {}, { session: 'ses_A', name: '' })],
      ['checklist', () => service.setChecklist(question.id, { index: 0 }, { session: 'ses_A', name: '' })],
    ]) {
      const refused = await reporter.rejects(`an agent cannot ${label} a decision either`, call, 'forbidden')
      check(`the ${label} refusal names the decision rule, so no decision path exists`, refused.details?.reason === 'decision-task')
    }
    check('every refusal left the decision exactly as it was', board.domain.table('requirements').get(question.id).rev === before.rev
      && board.domain.table('requirements').get(question.id).status === before.status
      && board.domain.table('roles').size === 0
      && board.domain.table('queues').size === 0)
    await board.close()
  })
}

/** The human's path reaches every one of those operations. */
async function casePanelAdvances(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDecisionBoard({ backend, dir })
    const service = board.service
    const panel = { session: '', name: '面板' }
    const ask = title => service.createRequirement({ title, kind: 'decision' }, { session: 'ses_A', name: '小画家' })

    const answered = await ask('人拍板：完成')
    const done = await dispatchBoardCommand(service, { action: 'transition', id: answered.id, transition: 'complete', session: '', name: '面板' })
    check('the human completes a decision without holding a lock', done.status === 'done' && done.kind === 'decision')
    check('the completed decision is out of the waiting count', service.stats().decisions === 0)

    const closing = await ask('人拍板：归档')
    const archived = await dispatchBoardCommand(service, { action: 'archive', id: closing.id, session: '', name: '面板' })
    check('the human archives one', archived.status === 'archived')
    const removed = await ask('人拍板：删除')
    await dispatchBoardCommand(service, { action: 'delete', id: removed.id, session: '', name: '面板' })
    check('the human deletes one', board.domain.table('requirements').get(removed.id) === undefined)

    const routed = await ask('人拍板：派人')
    const delegated = await dispatchBoardCommand(service, { action: 'delegate', id: routed.id, session: 'ses_child', name: '面板' })
    check('the human hands a decision to a session', delegated.delegatedTo?.session === 'ses_child')
    check('the temporary role is minted for it', board.domain.table('roles').get(`tmp-${routed.id}`)?.boundSession === 'ses_child')

    const edited = await ask('人拍板：改写')
    const changed = await dispatchBoardCommand(service, { action: 'update', id: edited.id, patch: { role: 'art-role', priority: 'high' }, session: '', name: '面板' })
    check('the human may re-route and reprioritize a decision', changed.role === 'art-role' && changed.priority === 'high')

    // The two operations that exist only for an executing session stay refused for
    // the human, but for their own reason — not as a decision. The panel command has
    // neither action, so this is asked of the service directly.
    const claimed = await reporter.rejects('the panel still holds no lock', () => service.claim(edited.id, {}, panel), 'invalid-argument')
    check('the claim refusal is the missing session, not the kind', claimed.details?.reason === 'session-required')
    const queued = await reporter.rejects('the panel still reserves nothing', () => service.queue(edited.id, {}, panel), 'invalid-argument')
    check('the queue refusal is the missing session, not the kind', queued.details?.reason === 'session-required')
    // A decision is never claimable, by anyone: `claimable()` keeps it out of every
    // pool, so delegating one assigns the question to a session for context and
    // nobody can lock it. The human's answer is the only way it moves.
    check('the delegated decision is in no claim pool either', !service.listRequirements({ claimable: true }, 'ses_child').items.some(item => item.id === routed.id))
    check('and the delegated session still cannot claim it', (await reporter.rejects('the named session cannot lock a decision', () => service.claim(routed.id, {}, { session: 'ses_child', name: '小助手' }), 'forbidden')).details?.reason === 'decision-task')
    await board.close()
  })
}

/** An agent may still add context to a decision, but may not re-route or rebind it. */
async function caseDecisionUpdateBoundary(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDecisionBoard({ backend, dir })
    const service = board.service
    const agent = agentOf('ses_A', 'art-role', '小画家')
    const a = { session: 'ses_A', name: '小画家' }
    const question = await service.createRequirement({ title: '边界', kind: 'decision' }, a)

    const refused = await reporter.rejects('an agent cannot re-route a decision', () => board.tool.execute({ action: 'update', id: question.id, role: 'art-role' }, { agent }), 'forbidden')
    // `images` is on the allowed list with the rest of the readable side: a
    // picture attached to the description is context for the person answering,
    // like the wording and the labels, not a change to who may answer or how.
    check('the refusal names the refused field and the allowed list', refused.details?.reason === 'decision-task'
      && refused.details?.fields.join(',') === 'role'
      && refused.details?.allowed.join(',') === 'title,description,priority,labels,sessions,images')
    const templateRefused = await reporter.rejects('and cannot rebind its flow', () => board.tool.execute({ action: 'update', id: question.id, templateId: 'tpl-standard' }, { agent }), 'forbidden')
    check('the template field is refused the same way', templateRefused.details?.fields.join(',') === 'templateId')
    check('neither refused update wrote anything', board.domain.table('requirements').get(question.id).role === '' && board.domain.table('requirements').get(question.id).kind === 'decision')

    const updated = await board.tool.execute({
      action: 'update',
      id: question.id,
      title: '新的问法',
      description: '两个选项',
      priority: 'high',
      labels: ['等待拍板'],
      sessions: ['ses_A', 'ses_child'],
    }, { agent })
    check('every allowed field goes through', updated.title === '新的问法' && updated.description === '两个选项' && updated.priority === 'high'
      && updated.labels.join(',') === '等待拍板' && updated.sessions.includes('ses_child'))
    check('the kind is untouched by all of it', updated.kind === 'decision' && board.domain.table('requirements').get(question.id).kind === 'decision')

    const viaGet = await board.tool.execute({ action: 'get', id: question.id }, { agent })
    check('the model reads the kind back from get', viaGet.kind === 'decision')
    const description = String(board.tool.description)
    check('the tool contract tells the model whose decision it is', description.includes('kind: "decision"')
      && description.includes('no session may claim, advance, delegate, archive, delete, or queue it'))
    check('and the kind parameter says it never changes', String(board.tool.parameters.properties.kind.description).includes('cannot be changed after creation'))
    await board.close()
  })
}

/** The `kind` filter answers the same on the service, the tool, and the route. */
async function caseKindFilterSurfaces(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDecisionBoard({ backend, dir })
    const service = board.service
    const agent = agentOf('ses_A', 'art-role', '小画家')
    const a = { session: 'ses_A', name: '小画家' }
    const task = await service.createRequirement({ title: '普通任务' }, a)
    const question = await service.createRequirement({ title: '决策项', kind: 'decision' }, a)

    const decisions = await service.listRequirements({ kind: 'decision' }, '')
    check('the service filter keeps decisions', decisions.items.length === 1 && decisions.items[0].id === question.id)
    const tasks = await service.listRequirements({ kind: 'task' }, '')
    check('the service filter keeps tasks', tasks.items.some(item => item.id === task.id) && !tasks.items.some(item => item.id === question.id))

    const viaTool = await board.tool.execute({ action: 'list', kind: 'decision', limit: 200 }, { agent })
    check('the tool filter reaches the same rows', viaTool.items.length === 1 && viaTool.items[0].id === question.id && viaTool.items[0].kind === 'decision')

    const viaCommand = await dispatchBoardCommand(service, { action: 'list', filter: { kind: 'decision' }, session: '' })
    check('the flat command body filters too', viaCommand.items.length === 1 && viaCommand.items[0].id === question.id)
    const viaFlat = await dispatchBoardCommand(service, { action: 'list', kind: 'task', session: '' })
    check('an unwrapped filter object works as well', viaFlat.items.some(item => item.id === task.id) && !viaFlat.items.some(item => item.id === question.id))

    const byQuery = await requestRoute(service, '/snapshot?kind=decision')
    check('the route reads the filter out of the query string', byQuery.status === 200 && byQuery.body.data.requirements.length === 1 && byQuery.body.data.requirements[0].id === question.id)
    const byQueryTask = await requestRoute(service, '/snapshot?kind=task')
    check('the same query with task keeps only tasks', byQueryTask.body.data.requirements.some(item => item.id === task.id) && !byQueryTask.body.data.requirements.some(item => item.id === question.id))
    const bad = await requestRoute(service, '/snapshot?kind=epic')
    check('an unknown kind in the query is refused, not ignored', bad.status === 409 && bad.body.error.code === 'invalid-argument')
    check('the refusal is the enum one and carries the value', bad.body.error.details?.received === 'epic')
    await board.close()
  })
}

/** A decision waits for the human: it is in no claim pool and it reads last in the prompt. */
async function caseDecisionPoolAndPrompt(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDecisionBoard({ backend, dir })
    const service = board.service
    const agent = agentOf('ses_A', 'art-role', '小画家')
    const a = { session: 'ses_A', name: '小画家' }
    const mine = await service.createRequirement({ title: '我能做的' }, a)
    const blocked = await service.createRequirement({ title: '第二个问题', kind: 'decision', priority: 'high' }, a)
    const question = await service.createRequirement({ title: '需要人拍板', kind: 'decision' }, a)
    await dispatchBoardCommand(service, { action: 'block', id: blocked.id, reason: '等预算', session: '', name: '面板' })

    check('the decision is not in this session\'s claim pool', !service.listRequirements({ claimable: true }, 'ses_A').items.some(item => item.id === question.id))
    check('it is not in the panel pool either', !service.listRequirements({ claimable: true }, '').items.some(item => item.id === question.id))
    const viaTool = await board.tool.execute({ action: 'list', claimable: true, limit: 200 }, { agent })
    check('the tool pool excludes it too', !viaTool.items.some(item => item.id === question.id) && viaTool.items.some(item => item.id === mine.id))

    const text = service.promptContext('ses_A', 12)
    const section = promptSection(text, 'Waiting on the human')
    check('the prompt has a section for the human', text.includes('Waiting on the human (2) — only the human advances these:') && section.length === 2)
    check('the section names both decisions', section.includes(question.id) && section.includes(blocked.id))
    check('the decision is in exactly one section', !promptSection(text, 'This session\'s requirements').includes(question.id)
      && !promptSection(text, 'Other sessions\' requirements').includes(question.id)
      && promptSection(text, 'This session\'s requirements').includes(mine.id))
    check('a blocked decision says why it waits', text.includes('· blocked: 等预算'))
    check('the requester reads as a name a person knows', text.includes('· requested by 小画家'))
    const order = ['Delegated to you', 'Claimable for you', 'Your queue', 'This session\'s requirements', 'Other sessions\' requirements', 'Waiting on the human']
      .map(header => text.indexOf(header))
      .filter(index => index >= 0)
    check('the decision section is last', order.at(-1) === text.indexOf('Waiting on the human') && order.every((index, position) => position === 0 || order[position - 1] < index))

    const tight = service.promptContext('ses_A', 1)
    check('an exhausted budget shows one decision and counts the rest', promptSection(tight, 'Waiting on the human').length === 1
      && tight.includes('- … 1 more waiting on the human'))
    check('the budget never drops the header', tight.includes('Waiting on the human (2)'))

    const stranger = await service.createRequirement({ title: '无名会话' }, { session: 'ses_ghost', name: '' })
    check('a requester with no live agent falls back to its session id', (await service.getRequirement(stranger.id)).requestedBy === 'ses_ghost')

    await dispatchBoardCommand(service, { action: 'transition', id: question.id, transition: 'complete', session: '', name: '面板' })
    check('answering one shrinks the waiting section', service.promptContext('ses_A', 12).includes('Waiting on the human (1)'))
    await board.close()
  })
}

/** Statistics count kinds, roles, waiting decisions, and orphaned locks. */
async function caseDecisionStats(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDecisionBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: '小画家' }
    const open = await service.createRequirement({ title: '无角色任务' }, a)
    const routed = await service.createRequirement({ title: '有角色任务', role: 'art-role' }, a)
    const waiting = await service.createRequirement({ title: '等待的问题', kind: 'decision' }, a)
    const answered = await service.createRequirement({ title: '已答的问题', kind: 'decision' }, a)
    await dispatchBoardCommand(service, { action: 'transition', id: answered.id, transition: 'complete', session: '', name: '面板' })

    const stats = service.stats()
    check('kinds are counted over open work', stats.byKind.task === 2 && stats.byKind.decision === 1)
    check('a done decision is history, not a waiting question', stats.decisions === 1 && stats.byKind.decision === 1 && (await service.getRequirement(waiting.id)).kind === 'decision')
    check('roles group unrouted work under the empty role', stats.byRole.some(entry => entry.role === '' && entry.total === 2) && stats.byRole.some(entry => entry.role === 'art-role' && entry.total === 1))
    check('the role groups carry their own status counts', stats.byRole.every(entry => entry.active + entry.blocked + entry.done === entry.total))
    check('the stage-A3 and stage-B counts are still there', stats.queued === 0 && stats.reserved === 0 && stats.orphanedLocks === 0 && stats.pendingDelegations === 0 && stats.queues === 0)
    // `gaps` counts the composition's own missing registries, which this case's mount
    // reports once; the guarantee asserted here is that no execution was observed
    // while nothing was running, and that a lockless observation was not invented.
    check('the execution readings report nothing observed, not a guess', 'criticalPath' in stats && stats.running === 0 && stats.execSync.ignored === 0 && Number.isInteger(stats.execSync.gaps))

    await service.claim(open.id, {}, a)
    const withOrphan = service.stats()
    check('a live lock is not an orphan', withOrphan.orphanedLocks === 0)
    await service.disposeSession({ id: 'ses_A' })
    check('a disposed session\'s lock is counted as orphaned', service.stats().orphanedLocks === 1)

    const viaTool = await board.tool.execute({ action: 'stats' }, { agent: a })
    check('the tool reports the same numbers', viaTool.byKind.decision === 1 && viaTool.decisions === 1 && viaTool.byKind.task === 2)
    check('the routed and unrouted rows are both accounted for', viaTool.byRole.reduce((total, entry) => total + entry.total, 0) === service.stats().byRole.reduce((total, entry) => total + entry.total, 0))
    await board.close()
  })
}

for (const backend of BACKENDS) {
  await caseKindAtCreate(backend, 'kind defaults to a task and is fixed at creation')
  await caseKindImmutable(backend, 'kind cannot be changed through any entry point')
  await caseDecisionRefusals(backend, 'the six agent actions are refused on a decision')
  await casePanelAdvances(backend, 'the human advances a decision without a lock')
  await caseDecisionUpdateBoundary(backend, 'an agent may add context to a decision but not re-route it')
  await caseKindFilterSurfaces(backend, 'the kind filter answers on the service, the tool, and the route')
  await caseDecisionPoolAndPrompt(backend, 'a decision is in no claim pool and reads last in the prompt')
  await caseDecisionStats(backend, 'statistics count kinds, roles, waiting decisions, and orphans')
}

process.exit(reporter.finish() ? 0 : 1)
