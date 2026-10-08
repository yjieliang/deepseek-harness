#!/usr/bin/env node
/**
 * Independent verification of stage B — sub-session delegation, temporary roles,
 * the shared settling implementation, ownership, `roleBefore`, and the sweep.
 *
 * The point of this script is the ownership port. `packages/core/agent/src/index.ts`
 * declares `isOwnedBy(id: SessionId, owner: Agent)`, and its body is
 * `store.get(id)?.owner === owner` — the second argument is an **Agent object**
 * compared by identity, not a session id. The board asks its own port in session
 * ids (`owns(targetId, callerId)`), and `index.js:createOwnershipPort` is the one
 * place that resolves the caller with `agents.get(caller)` before calling the
 * platform. This script runs the real `RequirementService` against
 *
 *   a) the id-shaped port the composition builds over a registry that mirrors the
 *      platform exactly (`ownsViaPlatform` + `platformRegistry`), and
 *   b) the same shape miswired the way the pre-fix revision was — the caller id
 *      handed to the platform's Agent slot — which must go red, and
 *   c) no port at all, and a port that cannot decide, which are different facts.
 *
 * `tests/verification/b-composition.mjs` repeats the ownership cases through the
 * real `index.js` plugin, so the boundary adapter itself is exercised.
 *
 * Usage (from the repository root):
 *   TSX_TSCONFIG_PATH=<repo>/tsconfig.json node --import tsx/esm \
 *     .artifacts/requirement-board/tests/verification/b-delegate.mjs
 *   RB_B_RED=1        # negative control: asserts the ownership check accepts the
 *                     # delegation against the real contract — must FAIL
 *   RB_B_OLD=1        # negative control: asserts the pre-B sweep leaves the
 *                     # binding in place — must FAIL
 *   RB_B_SERVICE=./_red-copy-b/service.js   # run against a mutated copy
 *
 * Written by a member other than the implementation's author. Temporary storage
 * roots under `%TEMP%`, removed afterwards; no session is created and nothing
 * under `~/.dsh` is written.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoard } from '../harness.mjs'
import { resolveConfig } from '../../host/config.js'
import { RequirementService } from '../../host/service.js'

const SERVICE_PATH = process.env.RB_B_SERVICE ?? '../../host/service.js'
const UnderTest = SERVICE_PATH === '../../host/service.js'
  ? RequirementService
  : (await import(SERVICE_PATH)).RequirementService
const RED = process.env.RB_B_RED === '1'
const OLD = process.env.RB_B_OLD === '1'
const BACKEND = process.env.RB_B_BACKEND ?? 'json'

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

/** Record a fact the report must state rather than assert. */
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

/** Assert a call fails with one code, one reason, and a detail field. */
async function refuses(label, expected, run) {
  const { error } = await attempt(run)
  const ok = error?.code === expected.code && error?.details?.reason === expected.reason
    && (expected.field === undefined || error?.details?.[expected.field.name] === expected.field.value)
  check(label, ok, `${error?.code ?? 'no-code'}/${error?.details?.reason ?? 'no-reason'}${expected.field === undefined ? '' : ` ${expected.field.name}=${error?.details?.[expected.field.name]}`}`)
  return error
}

/* --------------------------------------------------------------- fake ports */

/** A live agent that resolves a role through its preset id (§2.1 fallback). */
function agentOf(id, preset = 'art', name = '') {
  return { id, name: name === '' ? id : name, status: 'idle', ctx: { preset } }
}

/**
 * The preset registry fake the author's suite uses: the composed preset id is
 * the role id.
 */
function fakePresets() {
  return { composedPreset: ctx => (typeof ctx?.preset === 'string' ? ctx.preset : undefined) }
}

/**
 * A registry that mirrors `packages/core/agent/src/index.ts:578-580` exactly:
 * `isOwnedBy(id, owner) { return store.get(id)?.owner === owner }`, with owners
 * being Agent objects compared by identity.
 * @param agents - Live agents.
 * @param owners - `childId -> owning Agent` for children; absent means no owner.
 */
function platformRegistry(agents, owners = {}) {
  const store = new Map(agents.map(agent => [agent.id, { agent, owner: owners[agent.id] }]))
  const recorded = []
  return {
    recorded,
    list: () => [...store.values()].map(entry => entry.agent),
    get: id => store.get(id)?.agent,
    isOwnedBy(id, owner) {
      recorded.push([id, owner])
      return store.get(id)?.owner === owner
    },
  }
}

/** The id-shaped ownership port `index.js:createOwnershipPort` builds over the platform. */
function ownsViaPlatform(registry) {
  return (target, caller) => {
    if (typeof registry?.isOwnedBy !== 'function' || typeof registry?.get !== 'function') return undefined
    const owner = registry.get(caller)
    if (owner === undefined) return undefined
    return registry.isOwnedBy(target, owner) === true
  }
}

/** One world's registry plus the ownership port the composition would build over it. */
function ownershipWorld(agents = ALL_AGENTS, owners = OWNERS) {
  const registry = platformRegistry(agents, owners)
  return { registry, owns: ownsViaPlatform(registry) }
}

/** The role of one session through the same chain the service uses. */
const portsOf = (registry, owns = undefined, presets = fakePresets()) => ({
  agents: () => registry,
  presets: () => presets,
  owns,
})

/* ------------------------------------------------------------------- worlds */

/** Open one board with the class under test over a fresh root. */
async function openWorld({ registry, owns } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'b-verify-'))
  const config = resolveConfig({})
  const ports = portsOf(registry, owns)
  const board = await openBoard({ backend: BACKEND, dir, config, ports })
  const service = new UnderTest({ domain: board.domain, config, ports, logger: board.logger })
  return { board, service, registry, logger: board.logger, dir }
}

/** Close one world and remove its root. */
async function closeWorld(world) {
  await world.board.close()
  await rm(world.dir, { recursive: true, force: true })
}

/** The stored requirement record. */
const raw = (world, id) => world.board.domain.table('requirements').get(id)
/** The stored role row. */
const roleRow = (world, id) => world.board.domain.table('roles').get(id)

/** Close-ups the report quotes. */
function closeUp(world, id, tmpId) {
  const record = raw(world, id) ?? {}
  return {
    id,
    role: record.role ?? '',
    delegatedTo: record.delegatedTo ?? null,
    lock: record.lock ?? null,
    tempRoleRow: roleRow(world, tmpId) === undefined ? null : { ...roleRow(world, tmpId) },
    history: (record.history ?? []).map(entry => entry.action).join(','),
  }
}

/* ------------------------------------------------------------------ roster */

const ROSTER = {
  parent: agentOf('ses_parent', 'art', '甲'),
  child: agentOf('ses_child', 'art', '子'),
  child2: agentOf('ses_child2', 'art', '子二'),
  alien: agentOf('ses_alien', 'art', '他人子'),
  uncle: agentOf('ses_other_parent', 'art', '他人父'),
  stranger: agentOf('ses_stranger', 'eng', '旁人'),
  grand: agentOf('ses_grand', 'art', '孙'),
  sowned: agentOf('ses_sowned', 'eng', '旁人的子'),
}
const OWNERS = {
  ses_child: ROSTER.parent,
  ses_child2: ROSTER.parent,
  ses_alien: ROSTER.uncle,
  ses_grand: ROSTER.child,
  ses_sowned: ROSTER.stranger,
}
const ALL_AGENTS = Object.values(ROSTER)
const PARENT = { session: 'ses_parent', name: '甲' }
const CHILD = { session: 'ses_child', name: '子' }
const CHILD2 = { session: 'ses_child2', name: '子二' }

/** Delegate one requirement to `target` from the parent through a working port. */
async function delegated(world, target = 'ses_child') {
  const created = await world.service.createRequirement({ title: '派发的任务' }, PARENT)
  const receipt = await world.service.delegate(created.id, { session: target, duties: ['画贴图'], roleName: '临时画师' }, PARENT)
  return { id: created.id, receipt, tmpId: `tmp-${created.id}` }
}

/* ------------------------------------------------- [1] the ownership contract */

console.log(`\n[1] the ownership port: the id-shaped contract and the boundary adapter (service: ${SERVICE_PATH})`)
{
  // (a) The composition's adapter, mirrored in-process: the board asks in
  //     session ids, the adapter resolves the caller to a live Agent, and the
  //     platform answers by object identity (`index.js:84-92`).
  const registry = platformRegistry(ALL_AGENTS, OWNERS)
  const owns = ownsViaPlatform(registry)
  const world = await openWorld({ registry, owns })
  const own = await world.service.createRequirement({ title: '自己的孩子' }, PARENT)
  const attemptResult = await attempt(() => world.service.delegate(own.id, { session: 'ses_child' }, PARENT))
  check('a session delegating to its own sub-session succeeds (spec §5.5 / D17)', attemptResult.error === null, `${attemptResult.error?.code}/${attemptResult.error?.details?.reason}: ${attemptResult.error?.message ?? ''}`)
  check('the binding was written', raw(world, own.id).delegatedTo?.session === 'ses_child', JSON.stringify(raw(world, own.id).delegatedTo))
  check('the adapter asked the platform with the caller resolved to its Agent', registry.recorded.length >= 1 && typeof registry.recorded[0][1] === 'object' && registry.recorded[0][1]?.id === 'ses_parent', JSON.stringify(registry.recorded.map(([, owner]) => (typeof owner === 'object' ? `Agent(${owner?.id})` : `${typeof owner}:${String(owner)}`))))
  check('the platform predicate answers true for the owning Agent', registry.isOwnedBy('ses_child', registry.get('ses_parent')) === true, 'platform predicate')
  const alien = await world.service.createRequirement({ title: '别人的孩子' }, PARENT)
  await refuses('another session\'s child is refused as not-owned', { code: 'forbidden', reason: 'not-owned', field: { name: 'owner', value: 'ses_parent' } }, () => world.service.delegate(alien.id, { session: 'ses_alien' }, PARENT))
  const panel = await world.service.delegate(alien.id, { session: 'ses_alien' }, { session: '', name: '' })
  check('the panel delegates to any session', panel.delegatedTo?.session === 'ses_alien', JSON.stringify(panel.delegatedTo))
  await closeWorld(world)

  // (b) The contract-shape anchor: a port that hands the caller **id** to the
  //     platform's Agent slot is the defect this verification found. It must go
  //     red, and the refusal must name the caller as the owner.
  const miswired = platformRegistry(ALL_AGENTS, OWNERS)
  const anchorWorld = await openWorld({ registry: miswired, owns: (target, caller) => miswired.isOwnedBy(target, caller) })
  const anchorOwn = await anchorWorld.service.createRequirement({ title: '自己的孩子' }, PARENT)
  const anchor = await attempt(() => anchorWorld.service.delegate(anchorOwn.id, { session: 'ses_child' }, PARENT))
  const anchorArgs = miswired.recorded.at(-1) ?? []
  check('ANCHOR: an id passed in the Agent slot refuses the caller\'s own child', anchor.error?.code === 'forbidden' && anchor.error?.details?.reason === 'not-owned', `${anchor.error?.code}/${anchor.error?.details?.reason}`)
  check('ANCHOR: the platform received a session id string in the Agent slot', typeof anchorArgs[1] === 'string' && anchorArgs[1] === 'ses_parent', `${typeof anchorArgs[1]} ${JSON.stringify(anchorArgs[1])}`)
  check('ANCHOR: that string cannot match the stored owner Agent by identity', miswired.isOwnedBy('ses_child', anchorArgs[1]) === false && miswired.isOwnedBy('ses_child', miswired.get('ses_parent')) === true, 'identity comparison')
  check('ANCHOR: no record was written by the refused delegation', (raw(anchorWorld, anchorOwn.id).delegatedTo ?? null) === null, JSON.stringify(raw(anchorWorld, anchorOwn.id).delegatedTo))
  if (RED) {
    check('RED CONTROL: the miswired port still refuses the owner (the anchor is live)', anchor.error !== null, 'the delegation was accepted')
  }
  await closeWorld(anchorWorld)

  // (c) No ownership port at all: allow, and report the reason exactly once.
  const degraded = await openWorld({ registry })
  const loose = await degraded.service.createRequirement({ title: '没有归属信息' }, PARENT)
  const allowed = await degraded.service.delegate(loose.id, { session: 'ses_anyone' }, PARENT)
  check('a composition without an ownership port allows the delegation instead of guessing', allowed.delegatedTo?.session === 'ses_anyone', JSON.stringify(allowed.delegatedTo?.session))
  const warnings = () => degraded.logger.lines.warn.filter(line => line.includes('delegation cannot check')).length
  check('the degradation is reported exactly once', warnings() === 1, `${warnings()}: ${degraded.logger.lines.warn.join(' | ')}`)
  const second = await degraded.service.createRequirement({ title: '再一次' }, PARENT)
  await degraded.service.delegate(second.id, { session: 'ses_anyone2' }, PARENT)
  check('a later delegation does not repeat the report', warnings() === 1, String(warnings()))
  check('the report names the missing port as the reason', degraded.logger.lines.warn.some(line => line.includes('injects no ownership port')), degraded.logger.lines.warn.join(' | '))
  await closeWorld(degraded)

  // (d) A port that answers "cannot decide": distinct from "not mine".
  const undecided = await openWorld({ registry, owns: () => undefined })
  const unsure = await undecided.service.createRequirement({ title: '无法判断' }, PARENT)
  const unsureAllowed = await undecided.service.delegate(unsure.id, { session: 'ses_anyone' }, PARENT)
  check('an undecidable port allows the delegation and says why', unsureAllowed.delegatedTo?.session === 'ses_anyone' && undecided.logger.lines.warn.some(line => line.includes('cannot say whose sub-session')), undecided.logger.lines.warn.join(' | '))
  await closeWorld(undecided)

  note('platform signature: isOwnedBy(id: SessionId, owner: Agent) → store.get(id)?.owner === owner (packages/core/agent/src/index.ts:578-580)')
  note('port contract: owns(targetId, callerId) -> boolean | undefined (service.js:1282-1297); the boundary adapter createOwnershipPort lives in index.js:84-92 and is wired at index.js:147')
}

/* --------------------------------------------- [2] mint, bind, and the return */

console.log('\n[2] delegating mints the temporary role and writes the binding')
{
  const world = await openWorld(ownershipWorld())
  const { id, receipt, tmpId } = await delegated(world)
  const record = raw(world, id)
  check('the temporary role id derives from the task id', receipt.roleId === tmpId, `${receipt.roleId} vs ${tmpId}`)
  check('the requirement routes to the temporary role', record.role === tmpId, record.role)
  check('the binding names the session, the role and the role it returns to', record.delegatedTo?.session === 'ses_child' && record.delegatedTo?.roleId === tmpId && record.delegatedTo?.roleBefore === '', JSON.stringify(record.delegatedTo))
  check('the binding records the instant of the delegation', typeof record.delegatedTo?.at === 'string' && record.delegatedTo.at === record.updatedAt, `${record.delegatedTo?.at} vs ${record.updatedAt}`)
  const row = roleRow(world, tmpId)
  check('the role row is delegated, ephemeral and bound to session and task', row?.source === 'delegated' && row?.ephemeral === true && row?.boundSession === 'ses_child' && row?.boundTask === id, JSON.stringify(row))
  check('the declared duties and name reach the row', row?.duties?.includes('画贴图') && row?.name === '临时画师', JSON.stringify({ name: row?.name, duties: row?.duties }))
  check('history records the delegation', record.history.at(-1)?.action === 'delegate', record.history.map(entry => entry.action).join(','))
  await refuses('the panel cannot declare the reserved prefix', { code: 'invalid-role' }, () => world.service.putRole({ roleId: tmpId, roleName: 'x' }))
  check('the temporary row cannot be edited or deleted by hand', (await attempt(() => world.service.deleteRole(tmpId))).error?.code === 'conflict', 'deleteRole')
  await closeWorld(world)
}

/* ---------------------------------------------------- [3] `roleBefore` timing */

console.log('\n[3] `roleBefore` is the role at delegation time, never a temporary id')
{
  const world = await openWorld(ownershipWorld())
  const { service } = world
  const panel = { session: '', name: '面板' }
  const created = await service.createRequirement({ title: '先改角色再派发' }, PARENT)
  await service.claim(created.id, {}, PARENT)
  await service.updateRequirement(created.id, { role: 'art' }, PARENT)
  const done = await service.transitionRequirement(created.id, { action: 'complete' }, PARENT)
  check('the role was changed before the delegation', done.role === 'art' && done.lock === null, JSON.stringify({ role: done.role, lock: done.lock }))
  // §5.5 precondition "not archived, not finished": the task has to be active to
  // be delegated, so the lock is released by completing and the task reopened.
  await refuses('a finished requirement cannot be delegated', { code: 'invalid-state', reason: 'invalid-state' }, () => service.delegate(created.id, { session: 'ses_child' }, PARENT))
  await service.transitionRequirement(created.id, { action: 'reopen' }, panel)
  const first = await service.delegate(created.id, { session: 'ses_child' }, PARENT)
  check('roleBefore is the current role, not the creation value', first.delegatedTo?.roleBefore === 'art', JSON.stringify(first.delegatedTo))
  check('the requirement now routes to the temporary role', first.role === `tmp-${created.id}`, first.role)
  const revoked = await service.delegate(created.id, { revoke: true }, PARENT)
  check('revoking returns the requirement to roleBefore', revoked.role === 'art' && revoked.delegatedTo === null, JSON.stringify({ role: revoked.role, delegatedTo: revoked.delegatedTo }))
  check('the temporary role row is gone after the revoke', roleRow(world, `tmp-${created.id}`) === undefined, 'row still present')
  const second = await service.delegate(created.id, { session: 'ses_child2' }, PARENT)
  check('a second delegation records role art again, never the temporary id', second.delegatedTo?.roleBefore === 'art', JSON.stringify(second.delegatedTo))
  const replaced = await service.delegate(created.id, { session: 'ses_child' }, PARENT)
  check('replacing a live delegation also records role art', replaced.delegatedTo?.roleBefore === 'art', JSON.stringify(replaced.delegatedTo))
  check('the replacing delegation overwrote the same temporary row', roleRow(world, `tmp-${created.id}`)?.boundSession === 'ses_child', JSON.stringify(roleRow(world, `tmp-${created.id}`)))
  check('only one temporary row exists for the task', [...world.board.domain.table('roles').entries()].filter(([key]) => key.startsWith('tmp-')).length === 1, JSON.stringify([...world.board.domain.table('roles').keys()]))
  // The adversarial reading of "settled role": who else can re-delegate while a
  // delegation is live? The check measures the caller against `roleBefore`.
  const third = await service.createRequirement({ title: '第三方再派发', owner: 'ses_child', sessions: ['ses_stranger'] }, PARENT)
  await service.delegate(third.id, { session: 'ses_child2' }, PARENT)
  const byOwnerChild = await attempt(() => service.delegate(third.id, { session: 'ses_grand' }, CHILD))
  note(`the delegated session (also the owner) re-delegating to its own child: ${byOwnerChild.error === null ? 'ACCEPTED' : `${byOwnerChild.error.code}/${byOwnerChild.error.details?.reason}`}`)
  if (byOwnerChild.error === null) note(`  its new binding records roleBefore=${JSON.stringify(raw(world, third.id).delegatedTo?.roleBefore)} target=${raw(world, third.id).delegatedTo?.session}`)
  const byMember = await attempt(() => service.delegate(third.id, { session: 'ses_sowned' }, { session: 'ses_stranger', name: '旁人' }))
  note(`a member session (role eng, pre-delegation role "") re-delegating to its own child: ${byMember.error === null ? 'ACCEPTED' : `${byMember.error.code}/${byMember.error.details?.reason}`}`)
  await closeWorld(world)
}

/* --------------------------------------------- [4] claim first, then delegate */

console.log('\n[4] a session that claimed first is adopted idempotently')
{
  const world = await openWorld(ownershipWorld())
  const { service } = world
  const created = await service.createRequirement({ title: '子会话先接' }, PARENT)
  const held = await service.claim(created.id, {}, CHILD)
  const receipt = await service.delegate(created.id, { session: 'ses_child' }, PARENT)
  const record = raw(world, created.id)
  check('the delegation is accepted, not refused as a conflict', receipt.delegatedTo?.session === 'ses_child', JSON.stringify(receipt.delegatedTo))
  check('the lock stays with the adopting session and keeps its instant', record.lock?.session === 'ses_child' && record.lock.at === held.lock.at, JSON.stringify(record.lock))
  check('roleBefore is the role at claim time', receipt.delegatedTo?.roleBefore === '', JSON.stringify(receipt.delegatedTo))
  check('history records the claim before the delegation', record.history.map(entry => entry.action).join(',') === 'create,claim,delegate', record.history.map(entry => entry.action).join(','))
  const again = await service.claim(created.id, {}, CHILD)
  check('the named session claims again idempotently', again.lock?.session === 'ses_child' && again.lock.at === held.lock.at, JSON.stringify(again.lock))
  await closeWorld(world)
}

/* ------------------------------------------------------- [5] the claim table */

console.log('\n[5] claim eligibility through the delegation (row 3 of the table)')
{
  const world = await openWorld(ownershipWorld())
  const { service } = world
  const { id, tmpId } = await delegated(world)
  check('the requirement routes to the temporary role', raw(world, id).role === tmpId, raw(world, id).role)
  const claimed = await service.claim(id, {}, CHILD)
  check('the named session claims a temporary-role requirement', claimed.lock?.session === 'ses_child', JSON.stringify(claimed.lock))
  await refuses('a session that is not named is refused as role-mismatch', { code: 'forbidden', reason: 'role-mismatch' }, () => service.claim(id, {}, { session: 'ses_stranger', name: '旁人' }))
  const other = await service.createRequirement({ title: '没被指名的活' }, PARENT)
  await refuses('a session with another lock cannot claim', { code: 'conflict', reason: 'session-busy' }, () => service.claim(other.id, {}, CHILD))
  const idempotent = await service.claim(id, {}, CHILD)
  check('the named session claiming twice is idempotent', idempotent.lock.at === claimed.lock.at, JSON.stringify(idempotent.lock))
  await closeWorld(world)
}

/* ----------------------------------------------- [6] the shared settling step */

console.log('\n[6] revoke, disposal and replacement settle the same state')
{
  /** Identical starting state for each path: routed role art, delegated, claimed. */
  async function seeded() {
    const world = await openWorld(ownershipWorld())
    const created = await world.service.createRequirement({ title: '派发的任务' }, PARENT)
    await world.service.claim(created.id, {}, PARENT)
    await world.service.updateRequirement(created.id, { role: 'art' }, PARENT)
    await world.service.release(created.id, {}, PARENT)
    await world.service.delegate(created.id, { session: 'ses_child' }, PARENT)
    await world.service.claim(created.id, {}, CHILD)
    return { world, id: created.id, tmpId: `tmp-${created.id}` }
  }
  const byRevoke = await seeded()
  await byRevoke.world.service.delegate(byRevoke.id, { revoke: true }, PARENT)
  const revoked = closeUp(byRevoke.world, byRevoke.id, byRevoke.tmpId)
  await closeWorld(byRevoke.world)

  const byDispose = await seeded()
  await byDispose.world.service.disposeSession('ses_child')
  const disposed = closeUp(byDispose.world, byDispose.id, byDispose.tmpId)
  const pooled = await byDispose.world.service.listRequirements({ claimable: true }, '')
  check('a disposed session\'s requirement returns to the takeable pool', pooled.items.some(item => item.id === byDispose.id), JSON.stringify(pooled.items.map(item => item.id)))
  await closeWorld(byDispose.world)

  const byReplace = await seeded()
  const replacement = await byReplace.world.service.delegate(byReplace.id, { session: 'ses_child2' }, PARENT)
  const replaced = closeUp(byReplace.world, byReplace.id, byReplace.tmpId)
  await closeWorld(byReplace.world)

  console.log(`  revoke   ${JSON.stringify(revoked)}`)
  console.log(`  dispose  ${JSON.stringify(disposed)}`)
  console.log(`  replace  ${JSON.stringify(replaced)}`)
  check('all three end the binding and the temporary role row', revoked.delegatedTo === null && disposed.delegatedTo === null && revoked.tempRoleRow === null && disposed.tempRoleRow === null, JSON.stringify({ revoked: revoked.tempRoleRow, disposed: disposed.tempRoleRow }))
  check('revoke and disposal both restore the pre-delegation role', revoked.role === 'art' && disposed.role === 'art', `${JSON.stringify(revoked.role)} / ${JSON.stringify(disposed.role)}`)
  check('revoke releases the lock, disposal orphans it, and the replacement clears it', revoked.lock === null && disposed.lock?.orphaned === true && disposed.lock.session === 'ses_child' && replaced.lock === null, JSON.stringify({ revoked: revoked.lock, disposed: disposed.lock, replaced: replaced.lock }))
  check('the replacement keeps a live binding and a live row for the new target', replaced.role === byReplace.tmpId && replaced.delegatedTo.session === 'ses_child2' && replaced.tempRoleRow?.boundSession === 'ses_child2', JSON.stringify(replaced))
  check('revoke writes the revoke-delegation entry and disposal writes none', revoked.history.endsWith('revoke-delegation') && disposed.history.endsWith('claim'), `${revoked.history} / ${disposed.history}`)
  note('lock mode is the one intended difference: revoke=release, disposal=orphan (service.js:1058-1060), replacement=release so the new target claims fresh')

  // The target's soft reservation survives a revoke (recorded as fact; Lead has
  // already judged this a C-stage defect).
  const reserved = await openWorld(ownershipWorld())
  const { id } = await delegated(reserved)
  const waiting = await reserved.service.createRequirement({ title: '另一条' }, PARENT)
  await reserved.service.queue(waiting.id, {}, CHILD)
  await reserved.service.delegate(id, { revoke: true }, PARENT)
  const row = reserved.board.domain.table('queues').get('ses_child')
  check('revoking leaves the target session\'s soft reservation in place', (row?.items ?? []).some(item => item.id === waiting.id), JSON.stringify(row))
  await closeWorld(reserved)
}

/* ---------------------------------------------------- [7] the sweep really cleans */

console.log('\n[7] the mount-time sweep settles a dangling binding')
{
  const world = await openWorld(ownershipWorld())
  const { id, tmpId } = await delegated(world)
  await world.service.claim(id, {}, CHILD)
  const before = closeUp(world, id, tmpId)
  console.log(`  before   ${JSON.stringify(before)}`)
  // The child is destroyed: it disappears from the live registry.
  const gone = ownershipWorld(ALL_AGENTS.filter(agent => agent.id !== 'ses_child'), OWNERS)
  const reopened = new UnderTest({ domain: world.board.domain, config: resolveConfig({}), ports: portsOf(gone.registry, gone.owns), logger: world.logger })
  const report = await reopened.sweepDangling()
  const after = closeUp(world, id, tmpId)
  console.log(`  after    ${JSON.stringify(after)}`)
  console.log(`  report   ${JSON.stringify({ dangledDelegations: report.dangledDelegations, settledDelegations: report.settledDelegations, deferred: report.deferred })}`)
  check('the sweep detects the dangling binding', report.dangledDelegations.includes(id), JSON.stringify(report.dangledDelegations))
  check('the sweep settles it through the one settling implementation', report.settledDelegations.some(entry => entry.id === id && entry.roleId === tmpId), JSON.stringify(report.settledDelegations))
  check('after the sweep the role is back and the binding is cleared', after.role === '' && after.delegatedTo === null, JSON.stringify({ role: after.role, delegatedTo: after.delegatedTo }))
  check('after the sweep the temporary role row is deleted', after.tempRoleRow === null, JSON.stringify(after.tempRoleRow))
  check('the dead holder\'s lock is orphaned, not released', after.lock?.orphaned === true && after.lock.session === 'ses_child', JSON.stringify(after.lock))
  check('the sweep no longer defers the delegatedTo class', !report.deferred.some(entry => entry.reference === 'delegatedTo'), JSON.stringify(report.deferred))
  if (OLD) {
    check('OLD CONTROL: the pre-B sweep left the binding in place', after.delegatedTo !== null && after.role === tmpId, JSON.stringify({ role: after.role, delegatedTo: after.delegatedTo }))
  }

  // A missing temporary row with a live holder: repair the role, keep the lock.
  const world2 = await openWorld(ownershipWorld())
  const second = await delegated(world2)
  const held = await world2.service.claim(second.id, {}, CHILD)
  await world2.board.domain.table('roles').delete(second.tmpId)
  const report2 = await world2.service.sweepDangling()
  const after2 = closeUp(world2, second.id, second.tmpId)
  check('a missing row with a live holder is repaired', report2.settledDelegations.some(entry => entry.id === second.id) && after2.delegatedTo === null, JSON.stringify(report2.settledDelegations))
  check('the live holder\'s lock is kept, not orphaned', after2.lock?.session === 'ses_child' && after2.lock?.orphaned === undefined && after2.lock.at === held.lock.at, JSON.stringify(after2.lock))
  await closeWorld(world2)

  // Without a registry the sweep cannot decide, and says so.
  const world3 = await openWorld({ registry: undefined })
  const third = await delegated(world3)
  const report3 = await world3.service.sweepDangling()
  const after3 = closeUp(world3, third.id, third.tmpId)
  check('without a registry the sweep defers instead of guessing', report3.deferred.some(entry => entry.reference === 'delegatedTo'), JSON.stringify(report3.deferred))
  check('without a registry the binding is left alone', after3.delegatedTo !== null, JSON.stringify(after3.delegatedTo))
  await closeWorld(world3)
  await closeWorld(world)
}

/* ----------------------------------------------------------- [8] prompt sections */

console.log('\n[8] the prompt sections a delegated session sees')
{
  const world = await openWorld(ownershipWorld())
  const { id, tmpId } = await delegated(world)
  await world.service.createRequirement({ title: '公共任务' }, PARENT)
  const childPrompt = world.service.promptContext('ses_child', 20)
  const parentPrompt = world.service.promptContext('ses_parent', 20)
  const panelPrompt = world.service.promptContext('', 20)
  const childDelegated = section(childPrompt, 'Delegated to you')
  const childClaimable = section(childPrompt, 'Claimable for you')
  check('the named session has a `Delegated to you` section naming the requirement', childDelegated.some(line => line.includes(id)), JSON.stringify(childDelegated))
  check('the section names the temporary role it holds for the task', childDelegated.some(line => line.includes(tmpId)), JSON.stringify(childDelegated))
  check('the delegated requirement is not offered again as claimable', !childClaimable.some(line => line.includes(id)), JSON.stringify(childClaimable))
  check('the claimable section is downgraded while a delegation is waiting', (firstHeader(childPrompt) ?? '').includes('only after the delegated work above'), String(firstHeader(childPrompt)))
  check('another session\'s prompt has no delegated section', section(parentPrompt, 'Delegated to you').length === 0, 'parent prompt')
  check('the panel prompt has neither section', section(panelPrompt, 'Delegated to you').length === 0 && section(panelPrompt, 'Claimable for you').length === 0, 'panel prompt')
  await closeWorld(world)
}

/* ------------------------------------------------- [9] reservations and the lock */

console.log('\n[9] delegating a requirement another session reserved (Lead ruling: refuse)')
{
  const world = await openWorld(ownershipWorld())
  const { service } = world
  const created = await service.createRequirement({ title: '别人预留了它' }, PARENT)
  await service.queue(created.id, {}, { session: 'ses_stranger', name: '旁人' })
  await refuses('a delegation is refused while a third session holds the reservation', { code: 'conflict', reason: 'reserved' }, () => service.delegate(created.id, { session: 'ses_child' }, PARENT))
  check('the refused delegation wrote neither record', (raw(world, created.id).delegatedTo ?? null) === null && roleRow(world, `tmp-${created.id}`) === undefined, JSON.stringify(raw(world, created.id).delegatedTo))
  // Clearing the third party's reservation lets the named session take the task.
  const panel = await service.unqueue(created.id, { targetSession: 'ses_stranger' }, { session: '', name: '' })
  const taken = await service.claim(created.id, {}, CHILD)
  check('clearing the reservation lets the named session take it', panel.changed === true && taken.lock?.session === 'ses_child', JSON.stringify(taken.lock))
  await service.release(created.id, {}, CHILD)
  // The reservation holder is the delegation target: that is the adoption path,
  // not a conflict (§5.4 row 3).
  const adopting = await service.createRequirement({ title: '预留者就是目标' }, PARENT)
  await service.queue(adopting.id, {}, CHILD)
  const receipt = await service.delegate(adopting.id, { session: 'ses_child' }, PARENT)
  check('the reservation holder delegated to itself is adopted, not refused', receipt.delegatedTo?.session === 'ses_child', JSON.stringify(receipt.delegatedTo))
  const claim = await service.claim(adopting.id, {}, CHILD)
  check('the adopted target claims its own reservation', claim.lock?.session === 'ses_child', JSON.stringify(claim.lock))
  note('ruling 1 applies: a third session\'s soft reservation blocks delegate with conflict{reserved}; the target session\'s own reservation is adoption')
  await closeWorld(world)
}

/* --------------------------------------------------- [10] the remaining preconditions */

console.log('\n[10] the delegation preconditions: self, relation, role, state')
{
  const world = await openWorld(ownershipWorld())
  const { service } = world
  const panel = { session: '', name: '面板' }
  const own = await service.createRequirement({ title: '派给自己' }, PARENT)
  await refuses('delegating to the caller itself is an argument failure', { code: 'invalid-input', reason: 'delegate-to-self' }, () => service.delegate(own.id, { session: 'ses_parent' }, PARENT))
  const stranger = { session: 'ses_stranger', name: '旁人' }
  const unrelated = await service.createRequirement({ title: '不相关的人派发' }, PARENT)
  await refuses('a session with no relation to the requirement is refused', { code: 'forbidden', reason: 'not-related' }, () => service.delegate(unrelated.id, { session: 'ses_sowned' }, stranger))
  const routed = await service.createRequirement({ title: '按角色路由的活', role: 'art' }, PARENT)
  await refuses('a caller whose role does not match the routed role is refused first', { code: 'forbidden', reason: 'role-mismatch' }, () => service.delegate(routed.id, { session: 'ses_sowned' }, stranger))
  const closed = await service.createRequirement({ title: '已完成的任务' }, PARENT)
  await service.claim(closed.id, {}, PARENT)
  await service.transitionRequirement(closed.id, { action: 'complete' }, PARENT)
  await refuses('a finished requirement cannot be delegated', { code: 'invalid-state', reason: 'invalid-state' }, () => service.delegate(closed.id, { session: 'ses_child' }, PARENT))
  const archived = await service.createRequirement({ title: '已归档的任务' }, PARENT)
  await service.setArchived(archived.id, { archived: true }, panel)
  await refuses('an archived requirement cannot be delegated', { code: 'invalid-state', reason: 'invalid-state' }, () => service.delegate(archived.id, { session: 'ses_child' }, PARENT))
  await refuses('an unknown requirement cannot be delegated', { code: 'not-found' }, () => service.delegate('req_missing1', { session: 'ses_child' }, PARENT))
  const revoked = await service.createRequirement({ title: '没有委托却撤销' }, PARENT)
  const noop = await service.delegate(revoked.id, { revoke: true }, PARENT)
  check('revoking a requirement with no delegation is a no-op', noop.delegatedTo === null && roleRow(world, `tmp-${revoked.id}`) === undefined, JSON.stringify({ delegatedTo: noop.delegatedTo, role: noop.role }))
  note('revoke on an undelegated requirement is idempotent (it returns the record unchanged instead of failing) — recorded as a fact, not a defect')
  await closeWorld(world)
}

/* ------------------------------------------------------------------- helpers */

/** The lines of one prompt section, without its header. */
function section(text, header) {
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex(line => line.startsWith(header))
  if (start < 0) return []
  const out = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break
    if (line.startsWith('- …')) break
    out.push(line.slice(2))
  }
  return out
}

/** The first claimable header line, wording included. */
function firstHeader(text) {
  return String(text ?? '').split('\n').find(line => line.startsWith('Claimable for you'))
}

console.log(`\n${checks - failures}/${checks} checks passed on the ${BACKEND} backend${RED ? ' (RED CONTROL run)' : ''}${OLD ? ' (OLD-GAP CONTROL run)' : ''}`)
process.exit(failures === 0 ? 0 : 1)
