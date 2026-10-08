/**
 * Stage A1 cases: the role registry, the two-level resolution chain, the
 * derived role views, and the mount-time sweep (`ROLE-DISPATCH.md` §9 "A1 角色与解析链").
 *
 * Every case runs against every backend in {@link BACKENDS}, because the roles
 * table and the resolution chain meet in the same write path the other suites
 * exercise. The mount cases below drive `index.js` through a recording context,
 * so the `agent/created` listener, the registered tools, and the prompt section
 * under test are the plugin's own wiring rather than a copy of it.
 */

import { join } from 'node:path'
import { dispatchBoardCommand } from '../host/http.js'
import { resolveConfig } from '../host/config.js'
import { parseRoleDeclaration } from '../host/model.js'
import { apply as applyBoardPlugin } from '../index.js'
import { apply as applyRoleDeclaration } from '../role.js'
import {
  BACKENDS,
  boardService,
  createMountContext,
  createReporter,
  makeTempDir,
  openBoard,
  removeTempDir,
} from './harness.mjs'

const reporter = createReporter()
const { check } = reporter

/** The duties the fake preset declares for `art`. */
const ART_DUTIES = ['角色立绘', '场景概念图', 'UI 图标']

/** A live agent holding a declared role. */
function artAgent(id = 'ses_art', status = 'idle') {
  return { id, status, ctx: { preset: 'godot-review-board' } }
}

/**
 * The preset registry fake: `serviceFor` answers only for the agents whose id
 * appears in `declarations`, and `composedPreset` reads the agent context.
 */
function fakePresets(declarations = {}) {
  return {
    serviceFor: (agent, name) => (name === 'requirementBoardRole' ? declarations[agent.id] : undefined),
    composedPreset: ctx => ctx?.preset,
  }
}

/** An agent registry fake over a fixed list. */
function fakeAgents(agents) {
  return {
    list: () => [...agents],
    get: id => agents.find(agent => agent.id === id),
  }
}

/** Run one case for one backend in its own directory. */
async function onBackend(backend, name, body) {
  const dir = await makeTempDir(`rb-roles-${backend}-`)
  console.log(`\n[${backend}] ${name}`)
  try {
    await body(dir)
  } finally {
    await removeTempDir(dir)
  }
}

/** A declaration's shape is identical whichever agent holds it. */
function declarationOf(agent) {
  return { roleId: 'art', roleName: '美术', duties: ART_DUTIES }
}

/** The resolution chain has three outcomes: declared, preset-id fallback, none. */
async function caseResolutionChain(backend, name) {
  await onBackend(backend, name, async dir => {
    const art = artAgent()
    const board = await openBoard({ backend, dir, ports: { presets: () => fakePresets({ [art.id]: declarationOf(art) }) } })
    check('no role is recorded before a session exists', board.service.listRoles().items.length === 0)

    const declared = await promptFor(board.domain, { agents: fakeAgents([art]), presets: fakePresets({ [art.id]: declarationOf(art) }) }, art.id)
    check('a declared role names the id, the display name, and its duties', declared.includes(`You are role "art" (美术) — ${ART_DUTIES.join(', ')}.`), declared)

    const fallbackAgent = artAgent('ses_fallback')
    const fallback = await promptFor(board.domain, { agents: fakeAgents([fallbackAgent]), presets: fakePresets({}) }, fallbackAgent.id)
    check('an undeclared preset falls back to the preset id', fallback.includes('You are role "godot-review-board" (godot-review-board) — no duties recorded, so this role cannot be routed by function.'), fallback)

    const unboundAgent = { id: 'ses_none', status: 'idle', ctx: {} }
    const unboundAgentPrompt = await promptFor(board.domain, { agents: fakeAgents([unboundAgent]), presets: fakePresets({}) }, unboundAgent.id)
    check('a session with no bound preset gets no role paragraph', unboundAgentPrompt === '', unboundAgentPrompt)
    const unknownPrompt = await promptFor(board.domain, { agents: fakeAgents([unboundAgent]), presets: fakePresets({}) }, 'ses_missing')
    check('a session the registry does not know gets no role paragraph', unknownPrompt === '', unknownPrompt)
    const portless = await promptFor(board.domain, {}, art.id)
    check('a composition without the preset registry gets no role paragraph', portless === '', portless)
    check('reading the prompt recorded no role and wrote nothing', board.domain.table('roles').size === 0)
    await board.close()
  })
}

/**
 * Read the prompt section the plugin registers for one session.
 *
 * The section is the model-visible surface, so a case reads it through the
 * plugin's own registration rather than through a helper that could agree with
 * a wrong implementation.
 * @param domain - An open board domain.
 * @param ports - `agents` and `presets` fakes, either may be absent.
 * @param session - Session id the step belongs to.
 * @returns the prompt text.
 */
async function promptFor(domain, ports, session) {
  const mounted = createMountContext({
    storageDomain: { open: async () => domain },
    get: serviceName => (serviceName === 'agents' ? ports.agents : serviceName === 'agentPresets' ? ports.presets : undefined),
  })
  await applyBoardPlugin(mounted.ctx, resolveConfig({}))
  return String(mounted.records.promptContexts[0]?.text({ scope: { id: session } }) ?? '')
}

/** Establishment records a declared role, then writes nothing while it holds. */
async function caseEstablish(backend, name) {
  await onBackend(backend, name, async dir => {
    const agent = artAgent()
    const board = await openBoard({ backend, dir, ports: { presets: () => fakePresets({ [agent.id]: declarationOf(agent) }) } })
    const before = board.changes.length
    const first = await board.service.establishRole(agent)
    check('the declared role is recorded', first?.id === 'art' && first?.name === '美术' && first?.source === 'preset' && first?.ephemeral === false)
    check('the declaration is stored as given', JSON.stringify(first?.duties) === JSON.stringify(ART_DUTIES))
    const writes = board.changes.length - before
    check('a record and its revision are two commits', writes === 2, `writes=${writes}`)

    const second = await board.service.establishRole(agent)
    check('establishing the same role again changes nothing', second?.id === 'art' && second?.updatedAt === first?.updatedAt)
    check('the common case performs no write at all', board.changes.length === before + writes, `writes=${board.changes.length - before - writes}`)
    check('the stored record still holds the declaration', JSON.stringify(board.service.listRoles().items[0].duties) === JSON.stringify(ART_DUTIES))

    const fallback = await board.service.establishRole({ id: 'ses_fallback', status: 'idle', ctx: { preset: 'cordis' } })
    check('an undeclared preset is recorded as an observed reference', fallback?.id === 'cordis' && fallback?.name === 'cordis' && fallback?.source === 'observed')
    check('the observed reference has no duties', Array.isArray(fallback?.duties) && fallback.duties.length === 0)

    check('a session that resolves no role records nothing', await board.service.establishRole(undefined) === undefined)
    await board.close()

    // The medium is read back through a fresh open, so the record is durable
    // rather than an in-memory artefact.
    const reopened = await openBoard({ backend, dir, ports: { presets: () => fakePresets({}) } })
    const items = reopened.service.listRoles().items
    check('the recorded roles survive a reopen', items.length === 2 && items.some(item => item.id === 'art'))
    await reopened.close()
  })
}

/** A panel edit outranks the preset, so a human's duties are never overwritten. */
async function caseManualOutranksPreset(backend, name) {
  await onBackend(backend, name, async dir => {
    const agent = artAgent()
    const board = await openBoard({ backend, dir, ports: { presets: () => fakePresets({ [agent.id]: declarationOf(agent) }) } })
    await board.service.establishRole(agent)
    const edited = await board.service.putRole({ roleId: 'art', roleName: '美术（人工）', duties: ['评审'] })
    check('the panel edit is recorded as manual', edited.source === 'manual' && edited.name === '美术（人工）')
    check('the original creation instant is kept', edited.createdAt === board.domain.table('roles').get('art').createdAt)

    await board.service.establishRole(agent)
    const stored = board.domain.table('roles').get('art')
    check('a later session does not overwrite the manual edit', stored.name === '美术（人工）' && JSON.stringify(stored.duties) === JSON.stringify(['评审']))
    check('the manual record keeps its source', stored.source === 'manual')

    // The record is the single owner of name and duties, so the model reads the
    // panel edit rather than the declaration it was seeded from (§2.1). The id
    // still comes from the resolution chain, so claiming is unaffected.
    const ports = { agents: fakeAgents([agent]), presets: fakePresets({ [agent.id]: declarationOf(agent) }) }
    const editedPrompt = await promptFor(board.domain, ports, agent.id)
    check('the model reads the panel name and duties, not the declaration', editedPrompt.includes('You are role "art" (美术（人工）) — 评审.'), editedPrompt)

    await board.service.deleteRole('art')
    const fallbackPrompt = await promptFor(board.domain, ports, agent.id)
    check('a deleted record falls back to the declaration', fallbackPrompt.includes(`You are role "art" (美术) — ${ART_DUTIES.join(', ')}.`), fallbackPrompt)
    await board.close()

    // The id a session claims with comes from the resolution chain, so neither a
    // panel rename nor the record's deletion can change it: the session still
    // takes what is routed to "art", and nobody else gains it.
    const live = await openBoard({
      backend,
      dir,
      ports: {
        agents: () => fakeAgents([agent]),
        presets: () => fakePresets({ [agent.id]: declarationOf(agent) }),
      },
    })
    const routed = await live.service.createRequirement({ title: '美术任务' }, { session: '', name: '面板' })
    await live.service.updateRequirement(routed.id, { role: 'art' }, { session: '', name: '面板' })
    const forArt = live.service.listRequirements({ claimable: true }, agent.id)
    check('a session with no role record still claims by the chain id', forArt.items.map(item => item.id).join(',') === routed.id, forArt.items.map(item => item.id).join(','))
    check('a session wearing no role does not gain the renamed one', live.service.listRequirements({ claimable: true }, 'ses_other').items.length === 0)
    await live.close()
  })
}

/** A live session whose role was deleted reads as unregistered, without repair. */
async function caseUnregistered(backend, name) {
  await onBackend(backend, name, async dir => {
    const agents = [artAgent(), artAgent('ses_art2', 'running')]
    const board = await openBoard({
      backend,
      dir,
      ports: {
        agents: () => fakeAgents(agents),
        presets: () => fakePresets({ [agents[0].id]: declarationOf(agents[0]), [agents[1].id]: declarationOf(agents[1]) }),
      },
    })
    await board.service.establishRole(agents[0])
    await board.service.establishRole(agents[1])
    check('both sessions hold the same role', board.service.listRoles().items.length === 1)
    check('the holders split idle from running', JSON.stringify(board.service.listRoles().items[0].holders) === JSON.stringify({ online: 2, idle: 1, running: 1 }))

    await board.service.deleteRole('art')
    const after = board.service.listRoles()
    check('the deleted role is gone from the registry', after.items.length === 0)
    check('the sessions that still hold it report it as unregistered', after.unregistered.length === 1 && after.unregistered[0].id === 'art')
    check('an unregistered role keeps the duties its declaration states', after.unregistered[0].dutiesMissing === false)
    check('an unregistered role still counts its holders', JSON.stringify(after.unregistered[0].holders) === JSON.stringify({ online: 2, idle: 1, running: 1 }))
    check('the deletion was not undone by a later resolution', board.domain.table('roles').get('art') === undefined)
    await board.close()
  })
}

/** Presence is derived: a missing agent registry reports null, never zero. */
async function caseHoldersDegrade(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, ports: { presets: () => fakePresets({}) } })
    await board.service.putRole({ roleId: 'art', roleName: '美术', duties: ART_DUTIES })
    const withoutAgents = board.service.listRoles().items[0].holders
    check('a missing agent registry reports an unknown count', withoutAgents.online === null && withoutAgents.idle === null && withoutAgents.running === null)
    check('the unknown count says why', typeof withoutAgents.note === 'string' && withoutAgents.note.includes('cannot be counted'), withoutAgents.note)

    const other = [artAgent('ses_other')]
    const withOther = boardService(board.domain, resolveConfig({}), { agents: () => fakeAgents(other), presets: () => fakePresets({}) })
    check('an agent holding a different role does not count under this one', withOther.listRoles().items[0].holders.online === 0)

    const artists = [artAgent('ses_artist')]
    const withSame = boardService(board.domain, resolveConfig({}), {
      agents: () => fakeAgents(artists),
      presets: () => fakePresets({ ses_artist: declarationOf(artists[0]) }),
    })
    check('an agent holding this role counts as a holder', withSame.listRoles().items[0].holders.online === 1)
    check('the holder count is derived, not stored', board.domain.table('roles').get('art').holders === undefined)
    await board.close()
  })
}

/** A role with no duties is reported, in the list and in the prompt. */
async function caseDutiesMissing(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    await board.service.putRole({ roleId: 'plain', roleName: '普通' })
    const item = board.service.listRoles().items[0]
    check('a role declared without duties is recorded', item.id === 'plain' && item.name === '普通')
    check('the stored duties are empty', Array.isArray(item.duties) && item.duties.length === 0)
    check('missing duties are flagged', item.dutiesMissing === true)
    check('the model is told routing by function is unavailable', board.service.listRoles().items[0].dutiesMissing === true)

    // A preset declaration can still give a role a function after its record was
    // emptied or deleted; only "neither the record nor a declaration" is missing
    // duties (§3.4).
    await board.service.putRole({ roleId: 'art', roleName: '美术' })
    const declared = artAgent('ses_declared')
    const withDeclaration = boardService(board.domain, resolveConfig({}), {
      agents: () => fakeAgents([declared]),
      presets: () => fakePresets({ [declared.id]: declarationOf(declared) }),
    })
    const rows = withDeclaration.listRoles().items
    check('a record without duties is not missing them while its declaration has some', rows.find(row => row.id === 'art').dutiesMissing === false)
    check('a record without duties and without a declaration is missing them', rows.find(row => row.id === 'plain').dutiesMissing === true)
    await board.close()
  })
}

/** The same validator refuses the reserved and unusable role ids at every boundary. */
async function caseReservedRoleIds(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const before = board.changes.length
    await reporter.rejects('the panel refuses a human role', () => board.service.putRole({ roleId: 'human', roleName: '人' }), 'invalid-role')
    await reporter.rejects('the panel refuses the tmp- prefix', () => board.service.putRole({ roleId: 'tmp-req_1', roleName: '临时' }), 'invalid-role')
    await reporter.rejects('the panel refuses an id that does not match the form', () => board.service.putRole({ roleId: 'Art', roleName: '美术' }), 'invalid-role')
    await reporter.rejects('the panel refuses an over-long id', () => board.service.putRole({ roleId: `a${'b'.repeat(32)}` }), 'invalid-role')
    await reporter.rejects('the panel refuses a role with 13 duties', () => board.service.putRole({ roleId: 'many', duties: Array.from({ length: 13 }, (_, index) => `duty ${index}`) }), 'invalid-argument')
    await reporter.rejects('the panel refuses a duty over 40 characters', () => board.service.putRole({ roleId: 'long', duties: ['x'.repeat(41)] }), 'invalid-argument')
    await reporter.rejects('the panel refuses a role name over 40 characters', () => board.service.putRole({ roleId: 'name', roleName: 'x'.repeat(41) }), 'invalid-argument')
    await reporter.rejects('the panel refuses a missing role id', () => board.service.putRole({ roleName: '无名' }), 'invalid-argument')
    check('nothing was recorded by any refusal', board.service.listRoles().items.length === 0)
    check('no refusal reached the medium', board.domain.table('roles').size === 0)
    check('no refusal advanced the document revision', board.changes.length === before, `changes=${board.changes.length - before}`)

    const published = []
    const declaration = applyRoleDeclaration({ provide: (serviceName, value) => { published.push({ serviceName, value }); return () => {} } }, declarationOf(artAgent()))
    check('the role plugin publishes one service', published.length === 1 && published[0].serviceName === 'requirementBoardRole')
    check('the published declaration is the validated one', published[0].value.roleId === 'art' && published[0].value.roleName === '美术')
    check('the plugin returns its registration disposer', typeof declaration === 'function')
    const refused = await reporter.rejects('the role plugin refuses a human declaration at load', async () => applyRoleDeclaration({ provide: () => () => {} }, { roleId: 'human' }), 'invalid-role')
    check('the load failure names the reserved role', String(refused?.message).includes('human'), String(refused?.message))
    check('the shared validator is the one refusing it', parseRoleDeclaration({ roleId: 'art' }).roleName === 'art')
    await board.close()
  })
}

/** The mount-time sweep clears the dangling references and reports the rest. */
async function caseSweep(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const live = await board.service.createRequirement({ title: '活着的任务' }, { session: 'ses_a', name: '' })
    const stale = await board.service.createRequirement({ title: '换了角色的任务' }, { session: 'ses_a', name: '' })
    const dangled = await board.service.createRequirement({ title: '指向死会话的任务' }, { session: 'ses_a', name: '' })
    const roles = board.domain.table('roles')
    const queues = board.domain.table('queues')
    const requirements = board.domain.table('requirements')
    const at = '2026-01-01T00:00:00.000Z'
    const tempRole = (id, boundTask) => ({
      id,
      name: id,
      duties: [],
      source: 'delegated',
      ephemeral: true,
      ...(boundTask === undefined ? {} : { boundTask }),
      createdAt: at,
      updatedAt: at,
    })
    // Five shapes an interrupted write chain leaves behind: an orphan with no
    // task, one whose task is gone, one whose live task routes elsewhere, a live
    // delegation, and a binding whose role row never landed. Then queue items
    // naming requirements that do not exist.
    await roles.put('tmp-orphan', tempRole('tmp-orphan'))
    await roles.put('tmp-gone', tempRole('tmp-gone', 'req_missing'))
    await roles.put('tmp-stale', tempRole('tmp-stale', stale.id))
    await roles.put('tmp-live', tempRole('tmp-live', live.id))
    await requirements.put(live.id, {
      ...requirements.get(live.id),
      role: 'tmp-live',
      delegatedTo: { session: 'ses_a', name: '', roleId: 'tmp-live', roleBefore: '', at },
    })
    await requirements.put(dangled.id, {
      ...requirements.get(dangled.id),
      role: 'tmp-nowhere',
      delegatedTo: { session: 'ses_dead', name: '', roleId: 'tmp-nowhere', roleBefore: '', at },
      lock: { session: 'ses_dead', name: '', at, touchedAt: at },
    })
    await queues.put('ses_a', { sessionId: 'ses_a', sessionName: 'A', items: [{ id: live.id, at }, { id: 'req_ghost', at }], updatedAt: at })
    await queues.put('ses_b', { sessionId: 'ses_b', sessionName: 'B', items: [{ id: 'req_ghost', at }], updatedAt: at })
    const historyBefore = requirements.get(stale.id).history.length

    const report = await board.service.sweepDangling()
    check('the orphan with no task is removed', report.removedRoles.includes('tmp-orphan'))
    check('the temporary role whose task is gone is removed', report.removedRoles.includes('tmp-gone'))
    check('a temporary role its live task no longer routes to is removed', report.removedRoles.includes('tmp-stale'))
    check('a temporary role its live task routes to survives', roles.get('tmp-live') !== undefined && !report.removedRoles.includes('tmp-live'))
    check('the live delegation is not settled', report.settledDelegations.length === 1 && report.settledDelegations[0].id === dangled.id)
    check('the dangling binding is settled, not just reported', requirements.get(dangled.id).delegatedTo === null && requirements.get(dangled.id).role === '')
    check('the settled delegation keeps a live holder\'s lock without an agent registry', requirements.get(dangled.id).lock?.session === 'ses_dead' && requirements.get(dangled.id).lock?.orphaned !== true)
    check('both dangling queue items are reported', report.removedQueueItems.length === 2 && report.removedQueueItems.every(id => id === 'req_ghost'))
    check('the queue keeps its live item', queues.get('ses_a')?.items.length === 1 && queues.get('ses_a').items[0].id === live.id)
    check('a queue row with no live item is removed', queues.get('ses_b') === undefined)
    check('the sweep writes no requirement history', requirements.get(stale.id).history.length === historyBefore)
    check('the classes it cannot decide are reported, not skipped', report.deferred.length === 1 && report.deferred.every(entry => typeof entry.reference === 'string' && typeof entry.reason === 'string'))
    check('an absent agent registry is named as the reason for the one class left', JSON.stringify(report.deferred.map(entry => entry.reference)) === JSON.stringify(['delegatedTo'])
      && String(report.deferred[0].reason).includes('agent registry'))
    check('the surviving temporary role is still delegated', roles.get('tmp-live').source === 'delegated')

    const settled = await board.service.sweepDangling()
    check('a second sweep finds nothing to remove', settled.removedRoles.length === 0 && settled.removedQueueItems.length === 0 && settled.unboundLinks.length === 0)
    check('a second sweep settles nothing twice', settled.settledDelegations.length === 0)
    await board.close()
  })
}

/** Mounting the plugin registers the listener, the tools, the prompt, and the sweep. */
async function caseMount(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const agents = [artAgent()]
    const mounted = createMountContext({
      storageDomain: { open: async () => board.domain },
      get: serviceName => {
        if (serviceName === 'agents') return fakeAgents(agents)
        if (serviceName === 'agentPresets') return fakePresets({ [agents[0].id]: declarationOf(agents[0]) })
        return undefined
      },
    })
    const disposer = await applyBoardPlugin(mounted.ctx, resolveConfig({ executionSync: false }))
    check('the mount returns the tool disposer', typeof disposer === 'function')
    check('the mount registers the domain listener and the two agent listeners', mounted.records.listeners.length === 3
      && mounted.records.listeners.some(listener => listener.event === 'agent/created')
      && mounted.records.listeners.some(listener => listener.event === 'agent/disposed'))
    check('the startup sweep ran once and reported what it settled and still defers', mounted.logger.lines.info.some(line => line.includes('startup sweep') && line.includes('settled 0 dangling delegation(s)') && line.includes('unbound 0 dangling gate link(s)')), mounted.logger.lines.info.join(' | '))
    check('the model sees exactly three tools', mounted.records.tools.length === 3, mounted.records.tools.map(tool => tool.name).join(','))
    check('the role tool reads roles only', mounted.records.tools[2].name === 'requirement_role' && JSON.stringify(mounted.records.tools[2].parameters.properties.action.enum) === JSON.stringify(['list']))
    check('the role tool declares no management parameter', mounted.records.tools[2].parameters.additionalProperties === false && mounted.records.tools[2].parameters.properties.roleId === undefined)

    const listed = await mounted.records.tools[2].execute({ action: 'list' }, {})
    check('the role tool lists what the panel would show', Array.isArray(listed.items) && Array.isArray(listed.unregistered))
    check('no role is recorded before the listener runs', listed.items.length === 0)

    const settled = await Promise.all(mounted.dispatch('agent/created', { agent: agents[0] }))
    check('the listener resolves with the recorded role and does not reject', settled.length === 1 && settled[0]?.id === 'art', JSON.stringify(settled[0]))
    check('the creation-time registration wrote the role', board.domain.table('roles').get('art')?.source === 'preset')
    check('a successful registration logs no warning', mounted.logger.lines.warn.length === 0, mounted.logger.lines.warn.join(' | '))

    const prompt = mounted.records.promptContexts[0]?.text({ scope: { id: agents[0].id } })
    check('the prompt section carries the role paragraph', String(prompt).includes('You are role "art" (美术) — 角色立绘, 场景概念图, UI 图标.'), String(prompt))
    check('the role paragraph stands on its own with an empty board', board.domain.table('requirements').size === 0 && String(prompt).includes('requirement-board'))
    check('a session without a role gets no role paragraph', mounted.records.promptContexts[0].text({ scope: { id: 'ses_none' } }) === '')
    check('the prompt context is registered as an effect', mounted.records.effects.includes('requirement-board: prompt context'))
    check('the browser route is registered as an effect', mounted.records.effects.includes('requirement-board: browser route'))
    await board.close()
  })
}

/** A failing role registration is logged and never reaches the creating caller. */
async function caseRegistrationFailure(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const throwing = {
      serviceFor: () => { throw new Error('preset registry exploded') },
      composedPreset: () => undefined,
    }
    const mounted = createMountContext({
      storageDomain: { open: async () => board.domain },
      get: serviceName => (serviceName === 'agentPresets' ? throwing : undefined),
    })
    await applyBoardPlugin(mounted.ctx, resolveConfig({ executionSync: false }))
    const results = await Promise.all(mounted.dispatch('agent/created', { agent: { id: 'ses_bad', status: 'idle', ctx: {} } }))
    check('the listener still resolves when registration fails', results.length === 1)
    check('the failure is reported once', mounted.logger.lines.warn.length === 1, mounted.logger.lines.warn.join(' | '))
    check('the report names the session and the contained error', mounted.logger.lines.warn[0]?.includes('ses_bad') === true && mounted.logger.lines.warn[0].includes('preset registry exploded'))
    check('the report says the session is still created', mounted.logger.lines.warn[0]?.includes('still created') === true)
    check('nothing was recorded for the failed session', board.domain.table('roles').size === 0)

    // A write failure is contained the same way: the roles table is wrapped so its
    // commit cannot succeed, which is what a full or failing medium looks like.
    const failing = createMountContext({
      storageDomain: { open: async () => failingRolesDomain(board.domain) },
      get: serviceName => (serviceName === 'agentPresets' ? fakePresets({ ses_write: declarationOf(artAgent('ses_write')) }) : undefined),
    })
    await applyBoardPlugin(failing.ctx, resolveConfig({ executionSync: false }))
    const written = await Promise.all(failing.dispatch('agent/created', { agent: artAgent('ses_write') }))
    check('a failing write is contained too', written.length === 1 && failing.logger.lines.warn.length === 1)
    check('the write failure names the error', failing.logger.lines.warn[0]?.includes('medium is full') === true, failing.logger.lines.warn.join(' | '))
    await board.close()
  })
}

/** Role management is panel-only, and the panel surface reaches the same rules. */
async function casePanelSurface(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const put = await dispatchBoardCommand(board.service, { action: 'role.put', role: { roleId: 'art', roleName: '美术', duties: ART_DUTIES } })
    check('the panel creates a role', put.id === 'art' && put.source === 'manual')
    const listed = await dispatchBoardCommand(board.service, { action: 'role.list' })
    check('the panel lists roles with their derived flags', listed.items.length === 1 && listed.items[0].dutiesMissing === false && listed.items[0].holders.online === null)
    check('the snapshot carries the role views', board.service.snapshot({ limit: 1 }).roles.items.length === 1)
    await reporter.rejects('the panel refuses a human role', () => dispatchBoardCommand(board.service, { action: 'role.put', role: { roleId: 'human' } }), 'invalid-role')
    await reporter.rejects('the panel refuses a delete without an id', () => dispatchBoardCommand(board.service, { action: 'role.delete' }), 'invalid-argument')
    const deleted = await dispatchBoardCommand(board.service, { action: 'role.delete', id: 'art' })
    check('the panel deletes a role', deleted.deleted === true && board.domain.table('roles').get('art') === undefined)
    await reporter.rejects('deleting an unknown role fails loud', () => board.service.deleteRole('art'), 'not-found')
    await board.close()
  })
}

/** A temporary role is owned by delegation: the panel may not edit or delete it. */
async function caseEphemeralOwnership(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const at = '2026-01-01T00:00:00.000Z'
    await board.domain.table('roles').put('tmp-req_1', { id: 'tmp-req_1', name: '临时', duties: ['x'], source: 'delegated', ephemeral: true, boundTask: 'req_1', createdAt: at, updatedAt: at })
    await reporter.rejects('the panel cannot declare the reserved temporary prefix', () => board.service.putRole({ roleId: 'tmp-req_1' }), 'invalid-role')
    await reporter.rejects('the panel cannot delete a temporary role', () => board.service.deleteRole('tmp-req_1'), 'conflict')
    check('the temporary role survived both refusals', board.domain.table('roles').get('tmp-req_1') !== undefined)
    const listed = board.service.listRoles().items[0]
    check('the temporary role is flagged and bound in the list', listed.ephemeral === true && listed.boundTask === 'req_1')
    await board.close()
  })
}

/**
 * A board domain whose `roles` table cannot commit, which is what a failing or
 * full medium looks like. Every other table and the global stay real, so the
 * failure under test is the storage write and nothing else.
 * @param domain - The open board domain to wrap.
 * @returns a domain handle that fails only on a role commit.
 */
function failingRolesDomain(domain) {
  return {
    table: name => {
      const real = domain.table(name)
      if (name !== 'roles') return real
      return new Proxy(real, {
        get(target, key) {
          if (key === 'put') return async () => { throw new Error('medium is full') }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    global: domain.global,
  }
}

for (const backend of BACKENDS) {
  await caseResolutionChain(backend, 'the resolution chain has three outcomes')
  await caseEstablish(backend, 'establishment records once and writes nothing after')
  await caseManualOutranksPreset(backend, 'a panel edit outranks the preset')
  await caseUnregistered(backend, 'a deleted role in use reports unregistered')
  await caseHoldersDegrade(backend, 'presence degrades to unknown')
  await caseDutiesMissing(backend, 'a role with no duties is flagged')
  await caseReservedRoleIds(backend, 'reserved and unusable role ids are refused')
  await caseSweep(backend, 'the startup sweep clears dangling references')
  await caseMount(backend, 'the mount wires the listener, tools, and prompt')
  await caseRegistrationFailure(backend, 'a failed registration never fails a creation')
  await casePanelSurface(backend, 'role management is panel-only')
  await caseEphemeralOwnership(backend, 'delegation owns temporary roles')
}

process.exit(reporter.finish() ? 0 : 1)
