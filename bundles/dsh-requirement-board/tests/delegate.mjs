/**
 * Stage B cases: sub-session delegation and the temporary role
 * (`ROLE-DISPATCH.md` §9 "B 子会话派发与临时角色").
 *
 * A delegation is two records written together: the requirement names a
 * temporary role and carries the binding, and the role row names the task it
 * belongs to. Every case runs against every backend in {@link BACKENDS}, because
 * a delegation has to survive a reopen the way a lock does — and so does the end
 * of one, which is the same settling `revoke`, `agent/disposed`, a replacing
 * `delegate`, completion, archiving, deletion, and the mount-time sweep all run.
 *
 * The ownership check is driven two ways: the board's own port contract —
 * `owns(target, caller)` in session ids — with a fake, and the adapter that turns
 * the platform's `isOwnedBy(id, ownerAgent)` into it, with a registry faked in the
 * platform's terms. This suite never creates a real sub-session and never writes
 * a profile.
 */

import { bootstrapRequirementBoard } from '../host/domain.js'
import { dispatchBoardCommand } from '../host/http.js'
import { resolveConfig } from '../host/config.js'
import { RequirementService } from '../host/service.js'
import { apply as applyBoardPlugin, createOwnershipPort } from '../index.js'
import {
  BACKENDS,
  createMountContext,
  createRecordingLogger,
  createReporter,
  makeTempDir,
  openRawBoard,
  removeTempDir,
} from './harness.mjs'

const reporter = createReporter()
const { check } = reporter

/** An instant a number of hours before now. */
function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

/** A live agent that resolves a role through its preset id (§2.1 fallback). */
function agentOf(id, preset, name = '') {
  return { id, name, status: 'idle', ctx: { preset } }
}

/**
 * A fake agent registry in the platform's own terms.
 *
 * `isOwnedBy` matches `AgentRegistry` (`packages/core/agent/src/index.ts`): the
 * second argument is the creating **Agent object** and ownership is object
 * identity, never an id string. A fake that accepted an id here would agree with
 * a bug that passes one, so `calls` records what actually arrived and the
 * contract case asserts it is the live parent object.
 * @param agents - Live agents.
 * @param ownership - `[childId, parentId]` pairs that really are owned.
 * @returns the fake registry, with `calls` recording every `isOwnedBy` argument.
 */
function fakeAgents(agents, ownership = []) {
  const calls = []
  return {
    calls,
    list: () => [...agents],
    get: id => agents.find(agent => agent.id === id),
    isOwnedBy(id, owner) {
      calls.push({ id, owner })
      return ownership.some(([child, parent]) => child === id && agents.find(agent => agent.id === parent) === owner)
    },
  }
}

/**
 * The board's ownership port as a fake: session ids in, `boolean | undefined` out.
 * @param pairs - `[target, caller]` pairs the registry can decide.
 * @param undecidable - When `true` the port cannot decide anything, which is the
 * degraded composition; when an array, only those callers are undecidable.
 */
function fakeOwnership(pairs = [], undecidable = false) {
  return (target, caller) => {
    if (undecidable === true) return undefined
    if (Array.isArray(undecidable) && undecidable.includes(caller)) return undefined
    return pairs.some(([child, parent]) => child === target && parent === caller)
  }
}

/** The preset registry fake: the composed preset id is the role id. */
function fakePresets() {
  return { composedPreset: ctx => ctx?.preset }
}

/** Seed one lock without going through a claim, as a restored document would. */
async function seedLock(domain, id, lock) {
  await domain.table('requirements').update(id, record => ({ ...record, lock }))
}

/** Open a board the way the plugin does, with fake ports and a recording logger. */
async function openDelegationBoard({ backend, dir, agents, owns, presets = fakePresets() } = {}) {
  const opened = await openRawBoard({ backend, dir })
  const logger = createRecordingLogger()
  await bootstrapRequirementBoard(opened.domain, { logger })
  const service = new RequirementService({
    domain: opened.domain,
    config: resolveConfig({}),
    ports: {
      ...(agents === undefined ? {} : { agents: () => agents }),
      ...(owns === undefined ? {} : { owns }),
      presets: () => presets,
    },
    logger,
  })
  return { ...opened, service, logger }
}

/** Run one case for one backend in its own directory. */
async function onBackend(backend, name, body) {
  const dir = await makeTempDir(`rb-delegate-${backend}-`)
  console.log(`\n[${backend}] ${name}`)
  try {
    await body(dir)
  } finally {
    await removeTempDir(dir)
  }
}

/** The `- id` lines of one prompt section, up to the next section header. */
function promptSection(text, header) {
  const lines = String(text).split('\n')
  const start = lines.findIndex(line => line.startsWith(header))
  if (start < 0) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => !line.startsWith('- '))
  return rest.slice(0, end < 0 ? rest.length : end)
}

/** The ids named in one prompt section. */
function promptIds(text, header) {
  return promptSection(text, header).map(line => line.match(/^- (req_[0-9a-f]+)/)?.[1]).filter(Boolean)
}

/** The whole board roles tool row for one role id. */
function roleRow(service, roleId) {
  return service.listRoles().items.find(item => item.id === roleId)
}

/** Delegating mints one temporary role and binds the requirement to it. */
async function caseMintAndBind(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role', '小画家')]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const child = { session: 'ses_child', name: '乙' }
    const created = await service.createRequirement({ summary: '测试简述', title: '切图' }, parent)
    const before = board.domain.table('requirements').get(created.id)

    const receipt = await service.delegate(created.id, { session: child.session, duties: ['切图', '导出'] }, parent)
    const roleId = `tmp-${created.id}`
    check('the receipt names the temporary role it minted', receipt.roleId === roleId && receipt.id === created.id)
    check('the requirement routes to the temporary role', receipt.role === roleId)
    check('the binding records the session, its name, the role, and the role before', receipt.delegatedTo?.session === 'ses_child'
      && receipt.delegatedTo?.name === '小画家'
      && receipt.delegatedTo?.roleId === roleId
      && receipt.delegatedTo?.roleBefore === ''
      && typeof receipt.delegatedTo?.at === 'string', JSON.stringify(receipt.delegatedTo))
    check('delegating writes the requirement and its history', before.rev === receipt.rev - 1 && before.delegatedTo === null
      && receipt.history.at(-1)?.action === 'delegate' && receipt.history.at(-1)?.by === 'ses_parent')

    const stored = board.domain.table('requirements').get(created.id)
    check('the binding is stored, not derived', stored.delegatedTo?.session === 'ses_child' && stored.role === roleId)

    const role = roleRow(service, roleId)
    check('the temporary role is recorded as delegated and ephemeral', role?.source === 'delegated' && role?.ephemeral === true)
    check('the temporary role is bound to the task and the session', role?.boundTask === created.id && role?.boundSession === 'ses_child')
    check('the temporary role carries the duties the delegator gave', JSON.stringify(role?.duties) === JSON.stringify(['切图', '导出']) && role?.dutiesMissing === false)
    check('the role name defaults to the role id', role?.name === roleId)
    check('one task has exactly one temporary role', board.domain.table('roles').size === 1)

    const stats = service.stats()
    check('statistics observe the pending delegation', stats.pendingDelegations === 1)

    const named = await service.createRequirement({ summary: '测试简述', title: '命名角色' }, parent)
    const namedReceipt = await service.delegate(named.id, { session: child.session, roleName: '临时美术' }, parent)
    check('a named temporary role keeps the delegator\'s name', roleRow(service, namedReceipt.roleId)?.name === '临时美术')

    const bounded = await service.createRequirement({ summary: '测试简述', title: '边界' }, parent)
    const atMax = await service.delegate(bounded.id, { session: child.session, duties: Array.from({ length: 12 }, (_, index) => `duty ${index}`) }, parent)
    check('twelve duties are accepted', roleRow(service, atMax.roleId)?.duties.length === 12)
    await reporter.rejects('a thirteenth duty is refused', () => service.delegate(bounded.id, { session: child.session, duties: Array.from({ length: 13 }, (_, index) => `duty ${index}`) }, parent), 'invalid-argument')
    const nameAtMax = await service.delegate(bounded.id, { session: child.session, roleName: 'x'.repeat(40) }, parent)
    check('a forty character role name is accepted', roleRow(service, nameAtMax.roleId)?.name.length === 40)
    await reporter.rejects('a forty-one character role name is refused', () => service.delegate(bounded.id, { session: child.session, roleName: 'x'.repeat(41) }, parent), 'invalid-argument')

    const orphan = await service.delegate(created.id, { session: 'ses_lonely' }, parent)
    check('a panel-style delegation to a session with no agent records an empty name', orphan.delegatedTo?.name === '')
    await board.close()
  })
}

/** Every precondition refuses in the order §5.5 lists, before anything is written. */
async function casePreconditions(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([
        agentOf('ses_parent', 'art-role'),
        agentOf('ses_other', 'qa-role'),
        agentOf('ses_child', 'art-role'),
      ]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const other = { session: 'ses_other', name: '乙' }
    const child = { session: 'ses_child', name: '丙' }
    const changesBefore = board.changes.length

    const routed = await service.createRequirement({ summary: '测试简述', title: '别人的角色任务', role: 'qa-role' }, parent)
    const mismatch = await reporter.rejects('a caller that cannot take the task itself cannot delegate it', () => service.delegate(routed.id, { session: child.session }, parent), 'forbidden')
    check('the refusal is the claim table\'s role row', mismatch.details?.reason === 'role-mismatch' && mismatch.details?.role === 'qa-role' && mismatch.details?.myRole === 'art-role')

    const strangerTask = await service.createRequirement({ summary: '测试简述', title: '别人的任务' }, other)
    const unrelated = await reporter.rejects('a caller unrelated to the requirement cannot delegate it', () => service.delegate(strangerTask.id, { session: child.session }, parent), 'forbidden')
    check('the refusal names the missing relation', unrelated.details?.reason === 'not-related')

    const own = await service.createRequirement({ summary: '测试简述', title: '自己的任务' }, parent)
    const self = await reporter.rejects('a session cannot delegate a requirement to itself', () => service.delegate(own.id, { session: parent.session }, parent), 'invalid-input')
    check('delegating to self names the reason and points at claim', self.details?.reason === 'delegate-to-self' && String(self.message).includes('claim it instead'))

    const targetless = await reporter.rejects('a delegation names a target session', () => service.delegate(own.id, {}, parent), 'invalid-argument')
    check('the missing target is an argument failure', targetless !== undefined)

    const done = await service.createRequirement({ summary: '测试简述', title: '已完成' }, parent)
    await service.claim(done.id, {}, parent)
    await service.transitionRequirement(done.id, { action: 'complete' }, parent)
    const finished = await reporter.rejects('a finished requirement cannot be delegated', () => service.delegate(done.id, { session: child.session }, parent), 'invalid-state')
    check('the state refusal is the claim table\'s first row', finished.details?.reason === 'invalid-state' && finished.details?.status === 'done')

    const archived = await service.createRequirement({ summary: '测试简述', title: '已归档' }, parent)
    await service.setArchived(archived.id, { archived: true }, { session: '', name: '' })
    const gone = await reporter.rejects('an archived requirement cannot be delegated', () => service.delegate(archived.id, { session: child.session }, parent), 'invalid-state')
    check('the archived refusal names its state', gone.details?.reason === 'invalid-state' && gone.details?.status === 'archived')

    const held = await service.createRequirement({ summary: '测试简述', title: '别人锁着' }, parent)
    await seedLock(board.domain, held.id, { session: 'ses_other', name: '', at: hoursAgo(1), touchedAt: hoursAgo(1) })
    const locked = await reporter.rejects('a live holder other than the target refuses the delegation', () => service.delegate(held.id, { session: child.session }, parent), 'conflict')
    check('the lock refusal keeps the claim table\'s reason and the current holder', locked.details?.reason === 'locked' && locked.details?.current?.session === 'ses_other')

    const dead = await service.createRequirement({ summary: '测试简述', title: '死会话锁着' }, parent)
    await seedLock(board.domain, dead.id, { session: 'ses_dead', name: '', at: hoursAgo(1), touchedAt: hoursAgo(1), orphaned: true })
    const adopted = await service.delegate(dead.id, { session: child.session }, parent)
    check('an orphaned lock does not block a delegation: the task is takeable', adopted.delegatedTo?.session === 'ses_child' && adopted.lock?.orphaned === true)

    check('no refused delegation left a temporary role behind', board.domain.table('roles').size === 1 && board.domain.table('roles').get(`tmp-${dead.id}`) !== undefined)
    check('every refusal before the orphan case wrote nothing', board.domain.table('requirements').get(own.id).delegatedTo === null
      && board.domain.table('requirements').get(routed.id).rev === 1
      && board.changes.length > changesBefore)
    await board.close()
  })
}

/** A target that already holds the lock is adopted instead of refused. */
async function caseAdoption(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({ backend, dir, agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role')]) })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const child = { session: 'ses_child', name: '乙' }
    const created = await service.createRequirement({ summary: '测试简述', title: '先接后派' }, parent)

    const claimed = await service.claim(created.id, {}, child)
    check('a sub-session inheriting the parent role may claim before the delegation', claimed.lock?.session === 'ses_child')
    const takenAt = board.domain.table('requirements').get(created.id).lock.at

    const receipt = await service.delegate(created.id, { session: child.session }, parent)
    check('delegating to the holder is adopted, not refused', receipt.delegatedTo?.session === 'ses_child' && receipt.role === `tmp-${created.id}`)
    check('adoption leaves the holder\'s lock untouched', receipt.lock?.session === 'ses_child' && receipt.lock?.at === takenAt && receipt.lock?.touchedAt === takenAt)
    check('adoption records the role the requirement returns to', receipt.delegatedTo?.roleBefore === '')
    check('adoption is one history entry for the delegation', receipt.history.at(-1)?.action === 'delegate' && receipt.history.filter(entry => entry.action === 'delegate').length === 1)
    await board.close()
  })
}

/** The designated session claims through the delegation; nobody else can. */
async function caseDesignatedClaim(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role'), agentOf('ses_other', 'qa-role')]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const child = { session: 'ses_child', name: '乙' }
    const other = { session: 'ses_other', name: '丙' }
    const created = await service.createRequirement({ summary: '测试简述', title: '被指派' }, parent)
    await service.delegate(created.id, { session: child.session }, parent)

    check('the designated session is in its own claimable list', service.listRequirements({ claimable: true }, child.session).items.some(item => item.id === created.id))
    check('the panel pool still shows the delegated task', service.listRequirements({ claimable: true }, '').items.some(item => item.id === created.id))
    check('a session with another role does not see it', !service.listRequirements({ claimable: true }, other.session).items.some(item => item.id === created.id))

    const refused = await reporter.rejects('a session that is not the delegate cannot claim', () => service.claim(created.id, {}, other), 'forbidden')
    check('the refusal is the claim table\'s delegation row', refused.details?.reason === 'role-mismatch'
      && refused.details?.role === `tmp-${created.id}`
      && refused.details?.delegatedTo?.session === 'ses_child')

    const claimed = await service.claim(created.id, {}, child)
    check('the designated session claims through the delegation', claimed.lock?.session === 'ses_child' && claimed.lock?.orphaned === undefined)
    check('the temporary role is not the claimer\'s own role', service.listRoles().items.find(item => item.id === claimed.role)?.ephemeral === true)
    check('a claimed delegation is no longer pending', service.stats().pendingDelegations === 0)
    await board.close()
  })
}

/** `roleBefore` is the role at delegate time, not the value the record was created with. */
async function caseRoleBeforeIsCurrent(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role')]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const child = { session: 'ses_child', name: '乙' }
    const created = await service.createRequirement({ summary: '测试简述', title: '改过角色', role: 'art-role' }, parent)
    check('the record starts routed to the creation value', created.role === 'art-role')

    // A legal `update{role}` after creation: the creator claims, reroutes, releases.
    await service.claim(created.id, {}, parent)
    const rerouted = await service.updateRequirement(created.id, { role: '' }, parent)
    check('the reroute lands while the creator holds the lock', rerouted.role === '')
    await service.release(created.id, {}, parent)

    const receipt = await service.delegate(created.id, { session: child.session }, parent)
    check('a caller whose role matches may delegate', receipt.delegatedTo?.session === 'ses_child')
    check('the binding records the current role, not the creation value', receipt.delegatedTo?.roleBefore === '')
    check('the re-route is recorded in the flow history', board.domain.table('requirements').get(created.id).history
      .some(entry => entry.action === 'update' && String(entry.note).includes('role "art-role" -> ""')), JSON.stringify(board.domain.table('requirements').get(created.id).history.map(entry => [entry.action, entry.note])))

    await service.claim(created.id, {}, child)
    const revoked = await service.delegate(created.id, { revoke: true, note: '换人' }, parent)
    check('revoking returns the requirement to the role it had at delegate time', revoked.role === '' && revoked.delegatedTo === null)
    check('the creation value is not restored', revoked.role !== 'art-role')
    const history = board.domain.table('requirements').get(created.id).history
    check('revoking records the delegation end with the caller and the note', history.at(-1)?.action === 'revoke-delegation' && history.at(-1)?.by === 'ses_parent' && history.at(-1)?.note === '换人')
    await board.close()
  })
}

/** A repeated delegation settles the one it replaces first. */
async function caseRepeatDelegate(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([
        agentOf('ses_parent', 'art-role'),
        agentOf('ses_a', 'art-role'),
        agentOf('ses_b', 'art-role'),
      ], [['ses_a', 'ses_parent'], ['ses_b', 'ses_parent']]),
      owns: fakeOwnership([['ses_a', 'ses_parent'], ['ses_b', 'ses_parent']]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const first = { session: 'ses_a', name: 'A' }
    const second = { session: 'ses_b', name: 'B' }
    const created = await service.createRequirement({ summary: '测试简述', title: '换人重派' }, parent)
    const roleId = `tmp-${created.id}`

    await service.delegate(created.id, { session: first.session, duties: ['第一棒'] }, parent)
    await service.claim(created.id, {}, first)

    const replaced = await service.delegate(created.id, { session: second.session, duties: ['第二棒'] }, parent)
    check('the replaced delegation is gone', replaced.delegatedTo?.session === 'ses_b' && replaced.delegatedTo?.roleId === roleId)
    check('the previous holder\'s lock was released by the replacement', replaced.lock === null)
    check('the binding never records a temporary role as the fallback', replaced.delegatedTo?.roleBefore === '' && !String(replaced.delegatedTo?.roleBefore).startsWith('tmp-'))
    const actions = replaced.history.slice(-2).map(entry => entry.action)
    check('the replacement records both the end and the new delegation', JSON.stringify(actions) === JSON.stringify(['revoke-delegation', 'delegate']))
    check('one task still has exactly one temporary role', board.domain.table('roles').size === 1 && roleRow(service, roleId)?.boundSession === 'ses_b')
    check('the replaced row is the new delegation\'s row, freshly minted', roleRow(service, roleId)?.createdAt === roleRow(service, roleId)?.updatedAt)
    check('the temporary role now carries the new duties', JSON.stringify(roleRow(service, roleId)?.duties) === JSON.stringify(['第二棒']))

    const claimed = await service.claim(created.id, {}, second)
    check('the new delegate claims the requirement', claimed.lock?.session === 'ses_b')
    const refused = await reporter.rejects('the replaced session can no longer claim it', () => service.claim(created.id, {}, first), 'forbidden')
    check('the refusal is the delegation row, which the claim table judges first', refused.details?.reason === 'role-mismatch' && refused.details?.delegatedTo?.session === 'ses_b')
    await board.close()
  })
}

/** Revoking releases the lock, deletes the role, and is idempotent. */
async function caseRevoke(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role'), agentOf('ses_qa', 'qa-role')]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const child = { session: 'ses_child', name: '乙' }
    const stranger = { session: 'ses_stranger', name: '丁' }
    const created = await service.createRequirement({ summary: '测试简述', title: '撤销' }, parent)
    const roleId = `tmp-${created.id}`
    await service.delegate(created.id, { session: child.session }, parent)
    await service.claim(created.id, {}, child)

    const refused = await reporter.rejects('a stranger cannot revoke the delegation', () => service.delegate(created.id, { revoke: true }, stranger), 'forbidden')
    check('the revoke refusal names the missing relation', refused.details?.reason === 'not-related' && board.domain.table('roles').get(roleId) !== undefined)

    // The target reserves and then claims through its own reservation, so the
    // settle below has both a lock and a queue item to release.
    await service.queue(created.id, {}, child)
    await service.claim(created.id, {}, child)
    const reservedBefore = service.stats().reserved
    check('the delegated target holds the reservation before the revoke', (await service.getRequirement(created.id)).reservedBy === 'ses_child')

    const revoked = await service.delegate(created.id, { revoke: true }, parent)
    check('revoking reports the role it removed and that it changed the record', revoked.roleId === roleId && revoked.changed === true && revoked.delegatedTo === null && revoked.role === '')
    check('revoking released the holder\'s lock', revoked.lock === null)
    check('revoking deleted the temporary role', board.domain.table('roles').get(roleId) === undefined && board.domain.table('roles').size === 0)
    check('revoking released the target\'s reservation in the same call', (await service.getRequirement(created.id)).reservedBy === null
      && service.queueOf(child.session).length === 0 && board.domain.table('queues').get(child.session) === undefined)
    check('the released reservation left the statistics', service.stats().reserved === reservedBefore - 1)

    const after = board.domain.table('requirements').get(created.id)
    const repeat = await service.delegate(created.id, { revoke: true }, parent)
    check('revoking what is not delegated succeeds without writing', repeat.roleId === '' && repeat.changed === false && repeat.delegatedTo === null)
    check('the no-op revoke left the record untouched', after.rev === board.domain.table('requirements').get(created.id).rev
      && after.history.length === board.domain.table('requirements').get(created.id).history.length
      && board.domain.table('roles').size === 0)
    const panelRepeat = await service.delegate(created.id, { revoke: true }, { session: '', name: '面板' })
    check('the panel gets the same no-op receipt', panelRepeat.changed === false && panelRepeat.roleId === '')
    check('the freed requirement is in the panel pool again', service.listRequirements({ claimable: true }, '').items.some(item => item.id === created.id))

    const taken = await service.claim(created.id, {}, parent)
    check('the requirement is takeable again after the revoke', taken.lock?.session === 'ses_parent')
    check('statistics no longer count a pending delegation', service.stats().pendingDelegations === 0)
    await board.close()
  })
}

/** A disposed delegate returns its requirement to the takeable pool. */
async function caseDisposeSettles(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role'), agentOf('ses_next', 'art-role')]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const child = { session: 'ses_child', name: '乙' }
    const next = { session: 'ses_next', name: '丙' }
    const created = await service.createRequirement({ summary: '测试简述', title: '会话没了' }, parent)
    const roleId = `tmp-${created.id}`
    await service.delegate(created.id, { session: child.session }, parent)
    await service.claim(created.id, {}, child)

    const report = await service.disposeSession({ id: child.session })
    check('disposal reports the delegation it settled', report.settledDelegations === 1 && report.session === 'ses_child')
    check('disposal orphaned the lock the delegate held', report.orphaned === 1)
    const settled = board.domain.table('requirements').get(created.id)
    check('the dead session leaves no binding behind', settled.delegatedTo === null && settled.role === '')
    check('the dead session leaves no temporary role behind', board.domain.table('roles').get(roleId) === undefined)
    check('the lock stays as evidence of who held it', settled.lock?.session === 'ses_child' && settled.lock?.orphaned === true)

    check('the requirement is back in the panel pool', service.listRequirements({ claimable: true }, '').items.some(item => item.id === created.id))
    check('another session sees it as claimable', service.listRequirements({ claimable: true }, next.session).items.some(item => item.id === created.id))
    const taken = await service.claim(created.id, {}, next)
    check('another session takes it over immediately', taken.lock?.session === 'ses_next' && taken.lock?.orphaned === undefined)
    check('no delegation is pending after disposal', service.stats().pendingDelegations === 0)
    await board.close()
  })
}

/** Completion, archiving, and deletion settle the delegation in the same write chain. */
async function caseCompleteArchiveDelete(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role')]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const child = { session: 'ses_child', name: '乙' }
    const panel = { session: '', name: '' }

    const finished = await service.createRequirement({ summary: '测试简述', title: '做完' }, parent)
    await service.delegate(finished.id, { session: child.session }, parent)
    await service.claim(finished.id, {}, child)
    const done = await service.transitionRequirement(finished.id, { action: 'complete' }, child)
    check('completing reverts the role and clears the binding', done.status === 'done' && done.role === '' && done.delegatedTo === null && done.lock === null)
    check('completing deletes the temporary role', board.domain.table('roles').get(`tmp-${finished.id}`) === undefined)
    check('completion writes no separate delegation end', done.history.filter(entry => entry.action === 'revoke-delegation').length === 0)

    const archived = await service.createRequirement({ summary: '测试简述', title: '归档' }, parent)
    await service.delegate(archived.id, { session: child.session }, parent)
    await service.claim(archived.id, {}, child)
    const gone = await service.setArchived(archived.id, { archived: true }, panel)
    check('archiving reverts the role and clears the binding', gone.status === 'archived' && gone.role === '' && gone.delegatedTo === null)
    check('archiving releases the delegated lock', gone.lock === null)
    check('archiving deletes the temporary role', board.domain.table('roles').get(`tmp-${archived.id}`) === undefined)

    const deleted = await service.createRequirement({ summary: '测试简述', title: '删除' }, parent)
    await service.delegate(deleted.id, { session: child.session }, parent)
    await service.claim(deleted.id, {}, child)
    await service.deleteRequirement(deleted.id, {}, panel)
    check('deleting removes the requirement and its temporary role', board.domain.table('requirements').get(deleted.id) === undefined
      && board.domain.table('roles').get(`tmp-${deleted.id}`) === undefined
      && board.domain.table('roles').size === 0)
    await board.close()
  })
}

/**
 * A delegation owns the routing id while it lasts (`ROLE-DISPATCH.md` §5.5).
 *
 * The binding wrote the temporary id and settles the requirement back to
 * `roleBefore`, so a re-route written in between would be erased at settlement.
 * It is refused rather than accepted-then-erased, while restating the stored id
 * — which is what the panel sends when it saves any other field of a delegated
 * requirement — stays the zero-change case.
 */
async function caseRerouteDuringDelegate(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role')]),
      owns: fakeOwnership([['ses_child', 'ses_parent']]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const child = { session: 'ses_child', name: '乙' }
    const created = await service.createRequirement({ summary: '测试简述', title: '派发期间改角色', role: 'art-role' }, parent)
    const delegated = await service.delegate(created.id, { session: child.session }, parent)
    check('the requirement routes to the temporary role', delegated.role === `tmp-${created.id}`)
    await service.claim(created.id, {}, child)

    const refused = await reporter.rejects('a re-route during a delegation is refused', () => service.updateRequirement(created.id, { role: 'other-role' }, child), 'conflict')
    check('the refusal names the binding and the requested role', refused.details?.reason === 'delegated-role' && refused.details?.delegatedTo?.session === child.session && refused.details?.role === 'other-role', JSON.stringify(refused.details))

    const restated = await service.updateRequirement(created.id, { role: `tmp-${created.id}`, priority: 'high' }, child)
    check('restating the stored role changes nothing but the other field', restated.role === `tmp-${created.id}` && restated.priority === 'high')

    const revoked = await service.delegate(created.id, { revoke: true }, parent)
    check('the settlement returns the role the binding recorded', revoked.role === 'art-role')
    await board.close()
  })
}

/**
 * A refused requirement write takes its freshly minted temporary role back
 * (`ROLE-DISPATCH.md` §5.5).
 *
 * The role is declared before the requirement names it, so every refusal inside
 * that write leaves a row the requirement does not route to. A stale
 * `expectedRev` is one such refusal and it reaches the write chain: the row must
 * not survive as residue for the panel to show.
 */
async function caseRefusedWriteTakesRoleBack(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role')]),
      owns: fakeOwnership([['ses_child', 'ses_parent']]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const created = await service.createRequirement({ summary: '测试简述', title: '写失败的派发' }, parent)
    await reporter.rejects('a stale revision refuses the delegation', () => service.delegate(created.id, { session: 'ses_child', expectedRev: (created.rev ?? 1) - 1 }, parent), 'conflict')
    check('the refused delegation left no temporary role', board.domain.table('roles').size === 0)
    check('no temporary role is listed either', service.listRoles().items.every(item => !item.id.startsWith('tmp-'))
      && service.listRoles().unregistered.every(entry => !entry.id.startsWith('tmp-')))
    const stored = board.domain.table('requirements').get(created.id)
    check('the requirement was not bound', stored.delegatedTo === null && stored.role === '')

    const landed = await service.delegate(created.id, { session: 'ses_child' }, parent)
    check('the same delegation lands once the write is accepted', landed.delegatedTo?.session === 'ses_child' && board.domain.table('roles').size === 1)
    await board.close()
  })
}

/** The ownership check refuses another session's child, degrades once, and the
 * adapter hands the platform the Agent object its predicate compares. */
async function caseOwnership(backend, name) {
  await onBackend(backend, name, async dir => {
    const owned = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role'), agentOf('ses_alien', 'art-role')]),
      owns: fakeOwnership([['ses_child', 'ses_parent']]),
    })
    const parent = { session: 'ses_parent', name: '甲' }
    const own = await owned.service.createRequirement({ summary: '测试简述', title: '自己的孩子' }, parent)
    const accepted = await owned.service.delegate(own.id, { session: 'ses_child' }, parent)
    check('a session may delegate to its own sub-session', accepted.delegatedTo?.session === 'ses_child')

    const alien = await owned.service.createRequirement({ summary: '测试简述', title: '别人的孩子' }, parent)
    const refused = await reporter.rejects('a session cannot delegate to another session\'s child', () => owned.service.delegate(alien.id, { session: 'ses_alien' }, parent), 'forbidden')
    check('the refusal names the ownership check and both sessions', refused.details?.reason === 'not-owned' && refused.details?.target === 'ses_alien' && refused.details?.owner === 'ses_parent')
    check('the refused delegation wrote neither record', owned.domain.table('requirements').get(alien.id).delegatedTo === null
      && owned.domain.table('roles').size === 1)

    const panel = await owned.service.delegate(alien.id, { session: 'ses_alien' }, { session: '', name: '' })
    check('the panel delegates to any session, owned or not', panel.delegatedTo?.session === 'ses_alien')
    await owned.close()

    // The port is the board's own contract: ids in, a verdict out. An absent port
    // and an undecidable one both skip the check, and say so once.
    const missing = await openDelegationBoard({ backend, dir, agents: fakeAgents([agentOf('ses_parent', 'art-role')]) })
    const loose = await missing.service.createRequirement({ summary: '测试简述', title: '没有归属端口' }, parent)
    const allowed = await missing.service.delegate(loose.id, { session: 'ses_anyone' }, parent)
    check('a composition without the ownership port delegates instead of guessing', allowed.delegatedTo?.session === 'ses_anyone')
    check('the missing port is reported once and named', missing.logger.lines.warn.filter(line => line.includes('no ownership port')).length === 1, missing.logger.lines.warn.join(' | '))
    const again = await missing.service.createRequirement({ summary: '测试简述', title: '再一次' }, parent)
    await missing.service.delegate(again.id, { session: 'ses_anyone' }, parent)
    check('a second delegation does not repeat the report', missing.logger.lines.warn.filter(line => line.includes('no ownership port')).length === 1)
    await missing.close()

    const undecided = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([agentOf('ses_parent', 'art-role')]),
      owns: fakeOwnership([], true),
    })
    const unknown = await undecided.service.createRequirement({ summary: '测试简述', title: '注册表答不了' }, parent)
    const taken = await undecided.service.delegate(unknown.id, { session: 'ses_anyone' }, parent)
    check('an undecidable relation delegates instead of refusing', taken.delegatedTo?.session === 'ses_anyone')
    check('the undecidable relation is reported once with its reason', undecided.logger.lines.warn.filter(line => line.includes('cannot say whose sub-session')).length === 1, undecided.logger.lines.warn.join(' | '))
    await undecided.close()
  })
}

/**
 * The adapter is the only place the platform's ownership predicate appears, and
 * it must call it with an Agent object.
 *
 * `AgentRegistry.isOwnedBy(id, owner)` compares `owner` by object identity, so a
 * session id passed as the second argument can never match a live child: every
 * AI delegation would be refused while the panel path — which skips the check —
 * stayed green. The first assertions pin the verdicts; the last ones pin the
 * argument, which is what a regression would break.
 */
async function caseOwnershipAdapter(backend, name) {
  await onBackend(backend, name, async dir => {
    const parentAgent = agentOf('ses_parent', 'art-role')
    const childAgent = agentOf('ses_child', 'art-role')
    const registry = fakeAgents([parentAgent, childAgent, agentOf('ses_alien', 'art-role')], [['ses_child', 'ses_parent']])
    const port = createOwnershipPort({ get: serviceName => (serviceName === 'agents' ? registry : undefined) })

    check('the adapter resolves a real child through the platform predicate', port('ses_child', 'ses_parent') === true)
    check('the adapter refuses another session\'s child', port('ses_alien', 'ses_parent') === false)
    check('a target with no live Agent is undecidable, not a refusal', port('ses_ghost', 'ses_parent') === undefined)
    check('the platform predicate is always asked first, with the parent Agent object', registry.calls.length === 3
      && registry.calls.every(call => typeof call.owner === 'object' && call.owner !== null && call.owner.id === 'ses_parent'),
    JSON.stringify(registry.calls.map(call => ({ id: call.id, owner: typeof call.owner === 'string' ? call.owner : call.owner?.id }))))
    check('the argument is the exact live parent Agent, not a copy of its id', registry.calls[0].owner === parentAgent && registry.calls[0].id === 'ses_child')

    // A continuable child is materialized on demand and keeps its creator in its
    // own session header, so two states the platform predicate alone cannot
    // answer are decided from that recorded lineage: no live Agent yet, and a
    // runtime owner object replaced by a parent resume.
    const resumedParent = agentOf('ses_parent', 'art-role')
    const resumedChild = { ...childAgent, session: { header: { parentSession: 'ses_parent' } } }
    const unmaterialized = createOwnershipPort({ get: () => fakeAgents([resumedParent], []) })
    check('a child with no live Agent yet cannot be decided', unmaterialized('ses_child', 'ses_parent') === undefined)
    const lived = createOwnershipPort({ get: () => fakeAgents([resumedParent, resumedChild], []) })
    check('a child whose runtime owner moved is decided by its recorded header', lived('ses_child', 'ses_parent') === true)
    const foreign = createOwnershipPort({ get: () => fakeAgents([agentOf('ses_other_parent', 'art-role'), resumedChild], []) })
    check('a recorded lineage naming another session stays a refusal', foreign('ses_child', 'ses_other_parent') === false)

    const noRegistry = createOwnershipPort({ get: () => undefined })
    check('no registry is undecidable, not a refusal', noRegistry('ses_child', 'ses_parent') === undefined)
    const noPredicate = createOwnershipPort({ get: () => ({ get: () => parentAgent }) })
    check('a registry without an ownership predicate is undecidable', noPredicate('ses_child', 'ses_parent') === undefined)
    const noParent = createOwnershipPort({ get: () => fakeAgents([childAgent], []) })
    check('a caller with no live Agent is undecidable, so a stale id cannot refuse everyone', noParent('ses_child', 'ses_parent') === undefined)

    // The same adapter through the mounted plugin, driven by the tool: this is the
    // real composition path, with only the registry faked.
    const board = await openDelegationBoard({ backend, dir, agents: registry, owns: createOwnershipPort({ get: () => registry }) })
    const mounted = createMountContext({
      storageDomain: { open: async () => board.domain },
      get: serviceName => {
        if (serviceName === 'agents') return registry
        if (serviceName === 'agentPresets') return fakePresets()
        return undefined
      },
    })
    await applyBoardPlugin(mounted.ctx, resolveConfig({ promptMaxItems: 12 }))
    const tool = mounted.records.tools[0]
    const parent = { session: 'ses_parent', name: '甲' }
    const viaTool = await board.service.createRequirement({ summary: '测试简述', title: '真组合通道' }, parent)
    const delegated = await tool.execute({ action: 'delegate', id: viaTool.id, session: 'ses_child' }, { agent: parentAgent })
    check('the tool delegates through the adapter to the caller\'s own child', delegated.delegatedTo?.session === 'ses_child' && delegated.roleId === `tmp-${viaTool.id}`)
    const stranger = await board.service.createRequirement({ summary: '测试简述', title: '陌生会话' }, parent)
    const denied = await reporter.rejects('the tool refuses another session\'s child through the same adapter', () => tool.execute({ action: 'delegate', id: stranger.id, session: 'ses_alien' }, { agent: parentAgent }), 'forbidden')
    check('the refusal is the ownership one', denied.details?.reason === 'not-owned' && denied.details?.target === 'ses_alien')
    check('every platform call carried the parent Agent object', registry.calls.every(call => typeof call.owner === 'object' && call.owner !== null))
    await board.close()
  })
}

/**
 * A reservation decides who is next, so a delegation judges it like a claim.
 *
 * The point of the refusal is the state it prevents: a requirement handed to one
 * session while another session's queue reserves it cannot be claimed by the
 * session that was just named. The target's own reservation is the adoption path
 * and must stay claimable, or delegating to a session that already queued the
 * work would deadlock it.
 */
async function caseDelegationReservation(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role'), agentOf('ses_third', 'art-role')]),
      owns: fakeOwnership([['ses_child', 'ses_parent'], ['ses_second', 'ses_parent']]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const child = { session: 'ses_child', name: '小画家' }
    const third = { session: 'ses_third', name: '丙' }

    const contested = await service.createRequirement({ summary: '测试简述', title: '被第三方预留' }, parent)
    await service.queue(contested.id, {}, third)
    const refused = await reporter.rejects('a third session\'s reservation refuses the delegation', () => service.delegate(contested.id, { session: 'ses_child' }, parent), 'conflict')
    check('the refusal is the reservation, not the ownership or the lock', refused.details?.reason === 'reserved' && refused.details?.reservedBy === 'ses_third')
    check('the refused delegation wrote nothing', board.domain.table('requirements').get(contested.id).delegatedTo === null)
    await service.unqueue(contested.id, {}, third)
    const afterClear = await service.delegate(contested.id, { session: 'ses_child' }, parent)
    check('clearing the reservation lets the delegation through', afterClear.delegatedTo?.session === 'ses_child')
    check('the named session can then claim what it was given', (await service.claim(contested.id, {}, child)).lock?.session === 'ses_child')
    // One lock per session: give this one back before the next requirement.
    await service.release(contested.id, {}, child)

    const adopted = await service.createRequirement({ summary: '测试简述', title: '目标自己预留' }, parent)
    await service.queue(adopted.id, {}, child)
    const given = await service.delegate(adopted.id, { session: 'ses_child' }, parent)
    check('the target\'s own reservation is not a refusal', given.delegatedTo?.session === 'ses_child')
    const claimed = await service.claim(adopted.id, {}, child)
    check('the reserved target still claims its delegation', claimed.lock?.session === 'ses_child')
    // The claim does not clear the reservation (a stage-A3 decision: `unqueue` and
    // the task's own end are the release points), so the item is still this
    // session's queue head; the case pins that, then clears it by hand.
    check('the reservation survives the claim it no longer blocks', service.queueOf('ses_child').items.some(item => item.id === adopted.id))
    await service.unqueue(adopted.id, {}, child)
    await service.release(adopted.id, {}, child)

    // The caller's own reservation is released by the delegation itself: the promise
// to run the requirement next ends when the requirement is handed on, and leaving
// it would block the session that was just named — the same state the third-party
// refusal prevents. The reservation is not moved into the target's queue; that
// session's own queue is its business.
    const selfQueued = await service.createRequirement({ summary: '测试简述', title: '调用方自己预留' }, parent)
    await service.queue(selfQueued.id, {}, parent)
    const beforeHandoff = service.stats().reserved
    check('the caller holds the reservation before handing the requirement on', (await service.getRequirement(selfQueued.id)).reservedBy === 'ses_parent')
    const handedOn = await service.delegate(selfQueued.id, { session: 'ses_child' }, parent)
    check('the caller\'s own reservation does not block its delegation', handedOn.delegatedTo?.session === 'ses_child')
    check('handing it on releases the caller\'s reservation', handedOn.reservedBy === null && (await service.getRequirement(selfQueued.id)).reservedBy === null)
    check('the released reservation is gone from the statistics', service.stats().reserved === beforeHandoff - 1)
    check('and the target\'s queue was not touched', service.queueOf('ses_child').items.length === 0)
    const unblocked = await service.claim(selfQueued.id, {}, child)
    check('the session that was just named can claim it', unblocked.lock?.session === 'ses_child')
    await service.release(selfQueued.id, {}, child)

    // A refused delegation must not release anything: the reservation is the
    // caller's promise, and it survives until the hand-off actually lands.
    const refusedHandoff = await service.createRequirement({ summary: '测试简述', title: '被拒的交接' }, parent)
    await service.queue(refusedHandoff.id, {}, parent)
    await reporter.rejects('the caller cannot delegate to itself', () => service.delegate(refusedHandoff.id, { session: parent.session }, parent), 'invalid-input')
    check('the refused delegation left the caller\'s reservation standing', (await service.getRequirement(refusedHandoff.id)).reservedBy === 'ses_parent'
      && service.queueOf('ses_parent').items.some(item => item.id === refusedHandoff.id))
    const stillRefused = await reporter.rejects('and the reservation still refuses the other session', () => service.claim(refusedHandoff.id, {}, child), 'conflict')
    check('the standing reservation is the one that refuses it', stillRefused.details?.reason === 'reserved' && stillRefused.details?.reservedBy === 'ses_parent')
    await board.close()
  })
}

/**
 * The session a delegation names may delegate onward to its own sub-session.
 *
 * Eligibility and relation are satisfied by the binding it already holds, the new
 * binding keeps the role from before the first delegation rather than the
 * temporary id, and only one temporary role exists for the requirement.
 */
async function caseChainedRedelegation(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: fakeAgents([
        agentOf('ses_parent', 'art-role'),
        agentOf('ses_child', 'art-role'),
        agentOf('ses_grandchild', 'art-role'),
        agentOf('ses_alien', 'art-role'),
      ]),
      owns: fakeOwnership([['ses_child', 'ses_parent'], ['ses_grandchild', 'ses_child']]),
    })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const child = { session: 'ses_child', name: '小画家' }
    const grandchild = { session: 'ses_grandchild', name: '小助手' }
    const created = await service.createRequirement({ summary: '测试简述', title: '链式再派发', role: 'art-role' }, parent)
    const roleId = `tmp-${created.id}`

    const first = await service.delegate(created.id, { session: child.session, duties: ['初稿'] }, parent)
    check('the parent delegates to its own sub-session', first.delegatedTo?.session === 'ses_child' && first.delegatedTo?.roleBefore === 'art-role')
    const second = await service.delegate(created.id, { session: grandchild.session, duties: ['上色'] }, child)
    check('the delegated session delegates onward to its own child', second.delegatedTo?.session === 'ses_grandchild')
    check('the chain keeps the pre-delegation role, never a temporary id', second.delegatedTo?.roleBefore === 'art-role'
      && ![first, second].some(receipt => String(receipt.delegatedTo?.roleBefore ?? '').startsWith('tmp-')))
    check('one temporary role serves the requirement, now bound to the grandchild', board.domain.table('roles').size === 1
      && board.domain.table('roles').get(roleId)?.boundSession === 'ses_grandchild'
      && board.domain.table('roles').get(roleId)?.duties.join(',') === '上色')

    const refused = await reporter.rejects('the session it was taken from cannot claim it any more', () => service.claim(created.id, {}, child), 'forbidden')
    check('the superseded session is refused as a role mismatch', refused.details?.reason === 'role-mismatch')
    // Read the prompt before the claim: the delegated section names a requirement
    // only while its named session has not locked it yet (§5.5 step 5).
    check('the grandchild sees the task as delegated to it', service.promptContext(grandchild.session, 12).includes('Delegated to you (1)'))
    check('the superseded session no longer sees it as delegated to it', !service.promptContext(child.session, 12).includes('Delegated to you'))
    const claimed = await service.claim(created.id, {}, grandchild)
    check('the grandchild claims through the delegation it was named by', claimed.lock?.session === 'ses_grandchild')

    const alientarget = await service.createRequirement({ summary: '测试简述', title: '跨链派给别人的孩子' }, parent)
    await service.delegate(alientarget.id, { session: child.session }, parent)
    const crossChain = await reporter.rejects('a delegated session may not delegate to a session it does not own', () => service.delegate(alientarget.id, { session: 'ses_alien' }, child), 'forbidden')
    check('the ownership check still applies down the chain', crossChain.details?.reason === 'not-owned')
    await board.close()
  })
}

/** Tool, HTTP command, and prompt expose one delegation through one service. */
async function caseToolHttpAndPrompt(backend, name) {
  await onBackend(backend, name, async dir => {
    const registry = fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_child', 'art-role')], [['ses_child', 'ses_parent']])
    const board = await openDelegationBoard({
      backend,
      dir,
      agents: registry,
      owns: createOwnershipPort({ get: serviceName => (serviceName === 'agents' ? registry : undefined) }),
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
    const tool = mounted.records.tools[0]
    const agent = agentOf('ses_parent', 'art-role')

    check('the tool offers delegate', tool.parameters.properties.action.enum.includes('delegate'))
    check('the tool names the delegation inputs', tool.parameters.properties.revoke !== undefined
      && tool.parameters.properties.duties !== undefined
      && tool.parameters.properties.roleName !== undefined)
    check('the tool keeps one session parameter for filter and target', tool.parameters.properties.targetSession === undefined)

    const parent = { session: 'ses_parent', name: '甲' }
    const created = await board.service.createRequirement({ summary: '测试简述', title: '工具派发' }, parent)
    const spare = await board.service.createRequirement({ summary: '测试简述', title: '公共任务' }, parent)
    const delegateTool = await tool.execute({ action: 'delegate', id: created.id, session: 'ses_child', duties: ['按图切'] }, { agent })
    check('the tool delegates as its own session', delegateTool.delegatedTo?.session === 'ses_child' && delegateTool.roleId === `tmp-${created.id}`)

    const prompt = String(mounted.records.promptContexts[0].text({ scope: { id: 'ses_child' } }))
    const delegated = promptSection(prompt, 'Delegated to you')
    check('the prompt injects the delegated section for the named session', delegated.length === 1 && delegated[0].includes(created.id))
    check('the section names the delegating session and the temporary role', delegated[0].includes('delegated by ses_parent') && delegated[0].includes(`your role for this task: tmp-${created.id}`))
    check('the section comes before the public pool', prompt.indexOf('Delegated to you') < prompt.indexOf('Claimable for you'))
    check('the pool is de-emphasized while a delegation waits', prompt.includes('take one of these only after the delegated work above'))
    check('the delegated task is not repeated in the pool', !promptIds(prompt, 'Claimable for you').includes(created.id))
    check('the pool still lists public work', promptIds(prompt, 'Claimable for you').includes(spare.id))
    check('the delegating session sees no delegated section for itself', !String(mounted.records.promptContexts[0].text({ scope: { id: 'ses_parent' } })).includes('Delegated to you'))

    const viaHttp = await dispatchBoardCommand(board.service, { action: 'delegate', id: spare.id, session: 'ses_child' })
    check('the panel command delegates with the panel as the actor', viaHttp.delegatedTo?.session === 'ses_child')
    const revoked = await dispatchBoardCommand(board.service, { action: 'delegate', id: spare.id, revoke: true })
    check('the panel command revokes the same delegation', revoked.delegatedTo === null && revoked.role === '' && revoked.changed === true)
    const toolRevoked = await tool.execute({ action: 'delegate', id: created.id, revoke: true }, { agent })
    check('the tool revokes the delegation it made', toolRevoked.delegatedTo === null && toolRevoked.roleId === `tmp-${created.id}` && toolRevoked.changed === true)
    const toolNoop = await tool.execute({ action: 'delegate', id: created.id, revoke: true }, { agent })
    check('the model sees the no-op receipt too, not a failure', toolNoop.changed === false && toolNoop.roleId === '')
    check('no temporary role survives either revoke', board.domain.table('roles').get(`tmp-${spare.id}`) === undefined
      && board.domain.table('roles').get(`tmp-${created.id}`) === undefined)

    // A named delegating session is named by its display name in the section.
    const named = await board.service.createRequirement({ summary: '测试简述', title: '具名派发' }, parent)
    await board.service.delegate(named.id, { session: 'ses_child' }, { session: 'ses_parent', name: '甲' })
    const namedPrompt = String(mounted.records.promptContexts[0].text({ scope: { id: 'ses_child' } }))
    check('the section names a delegating session through its display name', promptSection(namedPrompt, 'Delegated to you').some(line => line.includes('delegated by 甲 (ses_parent)')), namedPrompt)
    await board.service.delegate(named.id, { revoke: true }, parent)
    check('revoking the named delegation removes it from the section too', !String(mounted.records.promptContexts[0].text({ scope: { id: 'ses_child' } })).includes('Delegated to you'))

    // The mount's own `agent/disposed` listener settles the same state.
    const running = await board.service.createRequirement({ summary: '测试简述', title: '挂载收尾' }, parent)
    await board.service.delegate(running.id, { session: 'ses_child' }, parent)
    await board.service.claim(running.id, {}, { session: 'ses_child', name: '' })
    const settled = await Promise.all(mounted.dispatch('agent/disposed', { agent: agentOf('ses_child', 'art-role') }))
    check('the mount\'s dispose listener settles the delegation through the service', settled.length === 1 && settled[0]?.settledDelegations === 1)
    check('the mount listener left no binding or role behind', board.domain.table('requirements').get(running.id).delegatedTo === null
      && board.domain.table('roles').get(`tmp-${running.id}`) === undefined)
    await board.close()
  })
}

/** The sweep settles a delegation whose session the registry no longer knows. */
async function caseSweepDeadSession(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openDelegationBoard({ backend, dir, agents: fakeAgents([agentOf('ses_parent', 'art-role'), agentOf('ses_alive', 'art-role')]) })
    const service = board.service
    const parent = { session: 'ses_parent', name: '甲' }
    const roles = board.domain.table('roles')
    const requirements = board.domain.table('requirements')
    const at = '2026-01-01T00:00:00.000Z'

    // A live delegation (its session is in the registry) and a dangling one whose
    // session is gone, each seeded the way an interrupted chain would leave it.
    const alive = await service.createRequirement({ summary: '测试简述', title: '还在' }, parent)
    await service.delegate(alive.id, { session: 'ses_alive' }, parent)
    const dead = await service.createRequirement({ summary: '测试简述', title: '会话没了' }, parent)
    const deadRole = `tmp-${dead.id}`
    await roles.put(deadRole, { id: deadRole, name: deadRole, duties: [], source: 'delegated', ephemeral: true, boundSession: 'ses_gone', boundTask: dead.id, createdAt: at, updatedAt: at })
    await requirements.put(dead.id, {
      ...requirements.get(dead.id),
      role: deadRole,
      delegatedTo: { session: 'ses_gone', name: '', roleId: deadRole, roleBefore: '', at },
      lock: { session: 'ses_gone', name: '', at, touchedAt: at },
    })

    const report = await service.sweepDangling()
    check('the sweep settles only the dead session\'s delegation', report.settledDelegations.length === 1 && report.settledDelegations[0].id === dead.id)
    const settled = requirements.get(dead.id)
    check('the settled binding is gone and the role reverted', settled.delegatedTo === null && settled.role === '')
    check('the settled temporary role is deleted', roles.get(deadRole) === undefined)
    check('a dead holder\'s lock is marked orphaned, not dropped', settled.lock?.session === 'ses_gone' && settled.lock?.orphaned === true)
    check('the live delegation survives the sweep', requirements.get(alive.id).delegatedTo?.session === 'ses_alive' && roles.get(`tmp-${alive.id}`) !== undefined)
    check('nothing is left deferred once the registry can answer', !report.deferred.some(entry => entry.reference === 'delegatedTo'))

    const second = await service.sweepDangling()
    check('a second sweep settles nothing twice', second.settledDelegations.length === 0 && roles.get(`tmp-${alive.id}`) !== undefined)
    await board.close()
  })
}

for (const backend of BACKENDS) {
  await caseMintAndBind(backend, 'delegating mints one temporary role and binds the requirement')
  await casePreconditions(backend, 'every precondition refuses before it writes')
  await caseAdoption(backend, 'a target that already holds the lock is adopted')
  await caseDesignatedClaim(backend, 'only the delegated session claims through the delegation')
  await caseRoleBeforeIsCurrent(backend, 'roleBefore is the role at delegate time')
  await caseRerouteDuringDelegate(backend, 'the delegation owns the routing id while it lasts')
  await caseRefusedWriteTakesRoleBack(backend, 'a refused delegation write takes its temporary role back')
  await caseRepeatDelegate(backend, 'a repeated delegation settles the one it replaces')
  await caseRevoke(backend, 'revoking releases, deletes, and is idempotent')
  await caseDisposeSettles(backend, 'a disposed delegate returns the requirement to the pool')
  await caseCompleteArchiveDelete(backend, 'completion, archiving, and deletion settle the delegation')
  await caseOwnership(backend, 'ownership is checked when the registry can answer')
  await caseOwnershipAdapter(backend, 'the adapter hands the platform the parent Agent object')
  await caseDelegationReservation(backend, 'a reservation is judged like a claim')
  await caseChainedRedelegation(backend, 'a delegated session may delegate to its own child')
  await caseToolHttpAndPrompt(backend, 'the tool, the panel command, and the prompt share one path')
  await caseSweepDeadSession(backend, 'the mount-time sweep settles a dead session\'s delegation')
}

process.exit(reporter.finish() ? 0 : 1)
