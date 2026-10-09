/**
 * Stage A2 cases: the execution lock, the ordered claim decision table, and the
 * one `claimable` formula (`ROLE-DISPATCH.md` §9 "A2 锁与判定表").
 *
 * Cases run against every backend in {@link BACKENDS} where the lock is stored,
 * because a lease and a takeover must read the same from either medium. Rows of
 * the table whose field arrives with a later stage (`kind`, `delegatedTo`) and
 * the four per-item bounds are driven directly: the row is proved where it is
 * implemented, and a bound is proved by its boundary.
 */

import { join } from 'node:path'
import { dispatchBoardCommand, registerBoardRoute } from '../host/http.js'
import { resolveConfig } from '../host/config.js'
import { LOCK_LEASE_HOURS, claimable, judgeClaim, lockState } from '../host/dispatch.js'
import { apply as applyBoardPlugin } from '../index.js'
import {
  BACKENDS,
  createMountContext,
  createReporter,
  imageFixture,
  makeTempDir,
  openBoard,
  removeTempDir,
} from './harness.mjs'

const reporter = createReporter()
const { check } = reporter

/** An instant a number of hours before now. */
function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

/** A live agent that resolves a role through its preset id (§2.1 fallback). */
function agentOf(id, preset) {
  return { id, status: 'idle', ctx: { preset } }
}

/** An agent registry fake over a fixed list. */
function fakeAgents(agents) {
  return {
    list: () => [...agents],
    get: id => agents.find(agent => agent.id === id),
  }
}

/** The preset registry fake: the composed preset id is the role id. */
function fakePresets() {
  return { composedPreset: ctx => ctx?.preset }
}

/** Ports for a board whose sessions resolve roles. */
function rolePorts(agents) {
  return { agents: () => fakeAgents(agents), presets: () => fakePresets() }
}

/** Seed one lock without going through a claim, as a crashed writer would. */
async function seedLock(domain, id, lock) {
  await domain.table('requirements').update(id, record => ({ ...record, lock }))
}

/** The route the browser half calls; the handler is mounted directly below. */
const ROUTE = '/api/requirement-board'

/**
 * Drive the registered board route handler with one GET request.
 *
 * The browser reaches the board through a query string, which is a second way
 * into the same filters the command body uses. `registerBoardRoute` is mounted on
 * a stub `webServer`, so no listener and no auth layer is involved.
 * @param service - The board service.
 * @param target - Path after the route prefix, query string included.
 * @param headers - Extra request headers, for the origin case.
 * @returns `{ status, body }` of the reply.
 */
async function requestRoute(service, target, headers = {}) {
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
  await handler({ method: 'GET', url: `${ROUTE}${target}`, headers, on: () => {} }, res)
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
  const dir = await makeTempDir(`rb-dispatch-${backend}-`)
  console.log(`\n[${backend}] ${name}`)
  try {
    await body(dir)
  } finally {
    await removeTempDir(dir)
  }
}

/** Claim and release write the lock, its history, and the revision. */
async function caseClaimAndRelease(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const actor = { session: 'ses_A', name: 'A' }
    const created = await service.createRequirement({ summary: '测试简述', title: '抢锁' }, actor)
    check('create leaves the requirement unlocked', created.lock === null)

    const claimed = await service.claim(created.id, {}, actor)
    check('claim stores the holder and its lease', claimed.lock.session === 'ses_A' && claimed.lock.name === 'A' && claimed.lock.at === claimed.lock.touchedAt)
    // One write chain reads the clock once, so the lock, the record, and the
    // history entry of a claim must agree on the instant exactly (§5.2 renewal).
    check('a claim stamps one instant across lock, record, and history', claimed.lock.at === claimed.updatedAt && claimed.history.at(-1).at === claimed.lock.at)
    check('claim is recorded in history', claimed.history.at(-1).action === 'claim')
    check('claim advances the record revision', claimed.rev === created.rev + 1)

    const again = await service.claim(created.id, {}, actor)
    check('re-claiming is idempotent', again.lock.session === 'ses_A' && again.history.filter(entry => entry.action === 'claim').length === 1)
    check('the idempotent claim still advances the revision', again.rev === claimed.rev + 1)

    const released = await service.release(created.id, { note: '交回' }, actor)
    check('release clears the lock', released.lock === null)
    check('release is recorded with its note', released.history.at(-1).action === 'release' && released.history.at(-1).note === '交回')

    const idle = await service.release(created.id, {}, actor)
    check('releasing an unlocked requirement writes nothing', idle.rev === released.rev && idle.lock === null)
    await board.close()
  })
}

/** A held lock refuses a competitor, and every ineligible row has its own code. */
async function caseLockConflictAndRows(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const created = await service.createRequirement({ summary: '测试简述', title: '互斥' }, a)
    await service.claim(created.id, {}, a)
    const refused = await reporter.rejects('another session cannot take a held lock', () => service.claim(created.id, {}, b), 'conflict')
    check('the refusal names the lock and its holder', refused.details?.reason === 'locked' && refused.details?.current?.session === 'ses_A' && refused.details?.current?.expired === false)

    const free = { id: 'req_fixture', status: 'active', rev: 1 }
    await reporter.rejects('a done requirement cannot be claimed', () => judgeClaim({ record: { ...free, status: 'done' }, session: 'ses_A' }), 'invalid-state')
    await reporter.rejects('an archived requirement cannot be claimed', () => judgeClaim({ record: { ...free, status: 'archived' }, session: 'ses_A' }), 'invalid-state')

    const decision = await reporter.rejects('a decision requirement belongs to the human', () => judgeClaim({ record: { ...free, kind: 'decision' }, session: 'ses_A' }), 'forbidden')
    check('the decision refusal carries its reason', decision.details?.reason === 'decision-task')

    const mismatch = await reporter.rejects('a routed requirement refuses another role', () => judgeClaim({ record: { ...free, role: 'art' }, session: 'ses_A', myRole: 'qa' }), 'forbidden')
    check('the role refusal names both roles', mismatch.details?.reason === 'role-mismatch' && mismatch.details?.role === 'art' && mismatch.details?.myRole === 'qa')
    check('the routed role may claim', judgeClaim({ record: { ...free, role: 'art' }, session: 'ses_A', myRole: 'art' }).idempotent === false)
    check('a named delegate may claim a routed requirement', judgeClaim({ record: { ...free, role: 'art', delegatedTo: { session: 'ses_A' } }, session: 'ses_A', myRole: 'qa' }).idempotent === false)
    check('an unrouted requirement is open to every role', judgeClaim({ record: free, session: 'ses_A', myRole: '' }).idempotent === false)

    const held = { ...free, lock: { session: 'ses_B', name: 'B', at: hoursAgo(1), touchedAt: hoursAgo(1) } }
    const lockedRow = await reporter.rejects('a held lock is judged before a reservation', () => judgeClaim({ record: held, session: 'ses_A', reservedBy: 'ses_C' }), 'conflict')
    check('the lock row precedes the reservation row', lockedRow.details?.reason === 'locked')

    const reserved = await reporter.rejects('a session reservation refuses another claim', () => judgeClaim({ record: free, session: 'ses_A', reservedBy: 'ses_C' }), 'conflict')
    check('the reservation refusal names the reserver', reserved.details?.reason === 'reserved' && reserved.details?.reservedBy === 'ses_C')
    check('the reserving session may claim', judgeClaim({ record: free, session: 'ses_C', reservedBy: 'ses_C' }).idempotent === false)

    const holding = { id: 'req_other', lock: { session: 'ses_A', name: 'A', at: hoursAgo(1), touchedAt: hoursAgo(1) } }
    const busy = await reporter.rejects('a second lock for one session is refused', () => judgeClaim({ record: free, session: 'ses_A', holding }), 'conflict')
    check('session-busy reports the held lock and no queue head', busy.details?.reason === 'session-busy' && busy.details?.current?.session === 'ses_A' && busy.details?.queueHead === null)
    check('the session may re-claim the requirement it already holds', judgeClaim({ record: held, session: 'ses_B', holding }).idempotent === true)

    const second = await service.createRequirement({ summary: '测试简述', title: '第二把' }, a)
    const busyReal = await reporter.rejects('the board refuses a second lock for one session', () => service.claim(second.id, {}, a), 'conflict')
    check('the board reports session-busy with a null queue head', busyReal.details?.reason === 'session-busy' && busyReal.details?.queueHead === null)
    check('the first lock is still idempotent', (await service.claim(created.id, {}, a)).lock.session === 'ses_A')
    await board.close()
  })
}

/** Orphaned and expired locks are taken over; a fresh one is not. */
async function caseOrphanAndLease(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const created = await service.createRequirement({ summary: '测试简述', title: '租约' }, a)
    const record = () => board.domain.table('requirements').get(created.id)

    await seedLock(board.domain, created.id, { session: 'ses_dead', name: '', at: hoursAgo(1), touchedAt: hoursAgo(1), orphaned: true })
    check('an orphaned lock reads as takeable', lockState(record(), 'ses_A').state === 'orphaned' && lockState(record(), 'ses_A').allows === true)
    check('an orphaned lock is taken over at once', (await service.claim(created.id, {}, b)).lock.session === 'ses_B')
    await service.release(created.id, {}, b)

    const now = new Date().toISOString()
    await seedLock(board.domain, created.id, { session: 'ses_A', name: 'A', at: now, touchedAt: now })
    const fresh = await reporter.rejects('a lock touched now is not taken over', () => service.claim(created.id, {}, b), 'conflict')
    check('the fresh-lock refusal is a lock conflict', fresh.details?.reason === 'locked')
    check('the fresh lock reads as another session\'s', lockState(record(), 'ses_B').state === 'other' && lockState(record(), 'ses_B').allows === false)

    await seedLock(board.domain, created.id, { session: 'ses_A', name: 'A', at: hoursAgo(9), touchedAt: hoursAgo(9) })
    check('a lock idle past the lease reads as expired', lockState(record(), 'ses_B').state === 'expired')
    check('a lock idle past the lease is taken over', (await service.claim(created.id, {}, b)).lock.session === 'ses_B')

    check('a free slot reads as free', lockState({ id: 'x', status: 'active' }, 'ses_A').state === 'free')
    check('the holder reads its own lock as mine', lockState(record(), 'ses_B').state === 'mine' && lockState(record(), 'ses_B').allows === true)
    check('the holder is not the only session that may look', lockState(record(), 'ses_A').state === 'other')
    await board.close()
  })
}

/** The lease length is configuration, inside its own bounds. */
async function caseConfiguredLease(backend, name) {
  console.log(`\n[${backend}] ${name}`)
  const tight = await makeTempDir(`rb-lease-tight-${backend}-`)
  const loose = await makeTempDir(`rb-lease-loose-${backend}-`)
  try {
    check('the default lease is eight hours', LOCK_LEASE_HOURS === 8)
    check('the lease bounds are inclusive', resolveConfig({ staleClaimHours: 0.1 }).staleClaimHours === 0.1 && resolveConfig({ staleClaimHours: 720 }).staleClaimHours === 720)
    await reporter.rejects('a lease under the lower bound is refused', async () => resolveConfig({ staleClaimHours: 0.05 }), 'invalid-config')
    await reporter.rejects('a lease over the upper bound is refused', async () => resolveConfig({ staleClaimHours: 800 }), 'invalid-config')

    const actor = { session: 'ses_A', name: 'A' }
    const short = await openBoard({ backend, dir: tight, config: resolveConfig({ staleClaimHours: 0.25 }) })
    const created = await short.service.createRequirement({ summary: '测试简述', title: '短租约' }, actor)
    await seedLock(short.domain, created.id, { session: 'ses_hold', name: '', at: hoursAgo(0.5), touchedAt: hoursAgo(0.5) })
    check('a lock idle past a quarter-hour lease is taken over', (await short.service.claim(created.id, {}, actor)).lock.session === 'ses_A')
    await short.close()

    const long = await openBoard({ backend, dir: loose })
    const held = await long.service.createRequirement({ summary: '测试简述', title: '默认租约' }, actor)
    await seedLock(long.domain, held.id, { session: 'ses_hold', name: '', at: hoursAgo(0.5), touchedAt: hoursAgo(0.5) })
    await reporter.rejects('the same idle lock survives the default lease', () => long.service.claim(held.id, {}, actor), 'conflict')
    await long.close()
  } finally {
    await removeTempDir(tight)
    await removeTempDir(loose)
  }
}

/** A holder's write keeps its own lock alive, and nobody else's. */
async function caseLeaseRenewal(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const created = await service.createRequirement({ summary: '测试简述', title: '长任务' }, a)
    const claimed = await service.claim(created.id, {}, a)

    await new Promise(resolve => setTimeout(resolve, 15))
    const touched = await service.updateRequirement(created.id, { title: '长任务（进行中）' }, a)
    check('a prose write by the holder renews the lease', touched.lock.session === 'ses_A' && touched.lock.touchedAt > claimed.lock.touchedAt)
    check('the renewal keeps the original claim instant', touched.lock.at === claimed.lock.at)

    const byOther = await service.updateRequirement(created.id, { description: '旁观' }, b)
    check('another session\'s write leaves the lease alone', byOther.lock.touchedAt === touched.lock.touchedAt && byOther.lock.session === 'ses_A')

    const structural = await service.transitionRequirement(created.id, { action: 'advance', force: true }, a)
    check('a structural write by the holder renews the lease too', structural.lock.touchedAt >= touched.lock.touchedAt && structural.lock.session === 'ses_A')

    await seedLock(board.domain, created.id, { session: 'ses_B', name: 'B', at: hoursAgo(9), touchedAt: hoursAgo(9) })
    const renewed = await service.updateRequirement(created.id, { description: '仍在进行' }, b)
    check('a stale lock is made fresh by its holder\'s own write', renewed.lock.touchedAt > hoursAgo(9))
    await reporter.rejects('an active holder is not taken over', () => service.claim(created.id, {}, a), 'conflict')
    await board.close()
  })
}

/** Two sessions claiming one requirement at once: exactly one wins. */
async function caseConcurrentClaim(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const created = await service.createRequirement({ summary: '测试简述', title: '并发' }, a)

    const settled = await Promise.allSettled([
      service.claim(created.id, {}, a),
      service.claim(created.id, {}, b),
    ])
    const winners = settled.filter(result => result.status === 'fulfilled')
    const losers = settled.filter(result => result.status === 'rejected')
    check('exactly one concurrent claim wins', winners.length === 1, JSON.stringify(settled.map(result => result.status)))
    check('the loser is refused as a lock conflict', losers.length === 1 && losers[0].reason?.code === 'conflict')
    check('the stored lock belongs to the winner', winners[0].value.lock.session === service.getRequirement(created.id).lock.session)

    const winner = winners[0].value.lock.session
    const loser = winner === 'ses_A' ? b : a
    const third = await service.createRequirement({ summary: '测试简述', title: '第三个' }, a)
    await reporter.rejects('the winner cannot take a second lock', () => service.claim(third.id, {}, winner === 'ses_A' ? a : b), 'conflict')
    check('the loser holds nothing and may claim the next requirement', (await service.claim(third.id, {}, loser)).lock.session === loser.session)
    await board.close()
  })
}

/** Identical content under different ids locks independently. */
async function caseSameContentDifferentIds(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const first = await service.createRequirement({ summary: '测试简述', title: '同名任务', description: '同一段描述' }, a)
    const second = await service.createRequirement({ summary: '测试简述', title: '同名任务', description: '同一段描述' }, a)
    check('the two requirements share their content and differ by id', first.title === second.title && first.description === second.description && first.id !== second.id)

    const one = await service.claim(first.id, {}, a)
    const other = await service.claim(second.id, {}, b)
    check('identical content with a different id locks independently', one.lock.session === 'ses_A' && other.lock.session === 'ses_B')
    check('each lock stays on its own requirement', service.getRequirement(first.id).lock.session === 'ses_A' && service.getRequirement(second.id).lock.session === 'ses_B')
    await board.close()
  })
}

/** Finishing the flow releases the lock in the same write (§5.1 step 5). */
async function caseCompletionReleases(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const ai = { session: 'ses_A', name: 'A' }
    const other = { session: 'ses_B', name: 'B' }
    const panel = { session: '', name: '面板' }
    const created = await service.createRequirement({ summary: '测试简述', title: '一次做完' }, ai)
    await service.claim(created.id, {}, ai)

    const done = await service.transitionRequirement(created.id, { action: 'complete', force: true }, ai)
    check('completing releases the lock in the same write', done.status === 'done' && done.lock === null)
    check('the claim and the completion both stay in history', done.history.some(entry => entry.action === 'claim') && done.history.at(-1).action === 'complete')
    check('the completion and the release share one instant', done.updatedAt === done.history.at(-1).at)

    await reporter.rejects('a released session cannot reopen without the lock', () => service.transitionRequirement(created.id, { action: 'reopen' }, ai), 'forbidden')
    await reporter.rejects('a finished requirement cannot be claimed again', () => service.claim(created.id, {}, ai), 'invalid-state')

    check('the panel reopens the finished requirement', (await service.transitionRequirement(created.id, { action: 'reopen' }, panel)).status === 'active')
    check('the reopened requirement is claimable again', (await service.claim(created.id, {}, ai)).lock.session === 'ses_A')
    await service.release(created.id, {}, ai)

    const next = await service.createRequirement({ summary: '测试简述', title: '接着做' }, other)
    check('the session that finished can take the next task at once', (await service.claim(next.id, {}, ai)).lock.session === 'ses_A')

    const byPanel = await service.createRequirement({ summary: '测试简述', title: '面板收尾' }, other)
    await service.claim(byPanel.id, {}, other)
    const panelDone = await service.transitionRequirement(byPanel.id, { action: 'complete', force: true }, panel)
    check('the panel completing a task drops its lock too', panelDone.status === 'done' && panelDone.lock === null)
    await board.close()
  })
}

/** Structural actions need the lock; prose and the panel do not. */
async function caseStructuralGate(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const ai = { session: 'ses_A', name: 'A' }
    const panel = { session: '', name: '面板' }
    const main = await service.createRequirement({ summary: '测试简述', title: '结构动作' }, ai)

    const refused = await reporter.rejects('an unlocked session cannot advance', () => service.transitionRequirement(main.id, { action: 'advance', force: true }, ai), 'forbidden')
    check('the refusal asks for the lock', refused.details?.reason === 'lock-required' && refused.details?.lock === null)
    await reporter.rejects('an unlocked session cannot tick a checklist entry', () => service.setChecklist(main.id, { index: 0, checked: true }, ai), 'forbidden')
    await reporter.rejects('an unlocked session cannot block', () => service.blockRequirement(main.id, { reason: 'x' }, ai), 'forbidden')
    await reporter.rejects('an unlocked session cannot archive', () => service.setArchived(main.id, { archived: true }, ai), 'forbidden')
    await reporter.rejects('an unlocked session cannot delete', () => service.deleteRequirement(main.id, {}, ai), 'forbidden')
    await reporter.rejects('an unlocked session cannot change the role', () => service.updateRequirement(main.id, { role: 'art' }, ai), 'forbidden')
    await reporter.rejects('an unlocked session cannot change the template', () => service.updateRequirement(main.id, { templateId: 'tpl-standard' }, ai), 'forbidden')
    // Stage D gives the gate links their fields; the lock is what still refuses
    // them, so the same unlocked session cannot set either graph (§5.4, §5.8).
    const gateLocked = await reporter.rejects('an unlocked session cannot set blocksOn either', () => service.updateRequirement(main.id, { blocksOn: [main.id] }, ai), 'forbidden')
    check('the gate link refusal is the missing lock, asked for before the link is judged', gateLocked.details?.reason === 'lock-required')
    await reporter.rejects('an unlocked session cannot set parentId either', () => service.updateRequirement(main.id, { parentId: main.id }, ai), 'forbidden')

    const edited = await service.updateRequirement(main.id, { title: '结构动作（改题）', labels: ['x'], owner: '张三' }, ai)
    check('prose fields need no lock', edited.title === '结构动作（改题）' && edited.labels.length === 1 && edited.owner === '张三')

    await service.setChecklist(main.id, { index: 0, checked: true }, panel)
    check('the panel ticks a checklist entry', service.getRequirement(main.id).flow[0].checks[0] === true)
    check('the panel changes the routing role', (await service.updateRequirement(main.id, { role: 'art' }, panel)).role === 'art')
    check('the panel routes it back to any role', (await service.updateRequirement(main.id, { role: '' }, panel)).role === '')
    check('the panel blocks', (await service.blockRequirement(main.id, { reason: '等人' }, panel)).status === 'blocked')
    check('the panel unblocks', (await service.unblockRequirement(main.id, {}, panel)).status === 'active')
    const advanced = await service.transitionRequirement(main.id, { action: 'advance', force: true }, panel)
    check('the panel advances without a lock', advanced.nodeId !== main.nodeId)
    check('the panel archives and restores', (await service.setArchived(main.id, { archived: true }, panel)).status === 'archived' && (await service.setArchived(main.id, { archived: false }, panel)).status === 'active')

    await service.claim(main.id, {}, ai)
    const aiAdvanced = await service.transitionRequirement(main.id, { action: 'advance', force: true }, ai)
    check('a lock holder advances', aiAdvanced.nodeId !== advanced.nodeId && aiAdvanced.lock.session === 'ses_A')
    check('a lock holder archives', (await service.setArchived(main.id, { archived: true }, ai)).status === 'archived')
    check('a lock holder releases', (await service.release(main.id, {}, ai)).lock === null)

    const victim = await service.createRequirement({ summary: '测试简述', title: '待删' }, ai)
    await service.claim(victim.id, {}, ai)
    check('a lock holder deletes', (await service.deleteRequirement(victim.id, {}, ai)).deleted === true)
    check('the deleted requirement is gone', board.domain.table('requirements').get(victim.id) === undefined)

    const cas = await service.createRequirement({ summary: '测试简述', title: '竞态' }, ai)
    const stale = await service.getRequirement(cas.id)
    await service.updateRequirement(cas.id, { title: '竞态（先行）' }, panel)
    const unlocked = await reporter.rejects('a stale revision is refused before the lock gate', () => service.updateRequirement(cas.id, { role: 'art', expectedRev: stale.rev }, ai), 'conflict')
    check('the unlocked stale write fails on the revision', unlocked.details?.expected === stale.rev)
    await service.claim(cas.id, {}, ai)
    await service.updateRequirement(cas.id, { title: '竞态（锁内）' }, panel)
    const held = await reporter.rejects('a holder with a stale revision fails on the revision too', () => service.transitionRequirement(cas.id, { action: 'advance', expectedRev: stale.rev }, ai), 'conflict')
    check('the holder\'s stale write fails on the revision', held.details?.expected === stale.rev)
    await board.close()
  })
}

/** `claimable`, the prompt section, and the panel filter answer from one formula. */
async function caseClaimableSingleSource(backend, name) {
  await onBackend(backend, name, async dir => {
    const agents = [agentOf('ses_art', 'art-role'), agentOf('ses_qa', 'qa-role')]
    const board = await openBoard({ backend, dir, ports: rolePorts(agents) })
    const service = board.service
    const art = { session: 'ses_art', name: 'Art' }
    const qa = { session: 'ses_qa', name: 'QA' }
    const other = { session: 'ses_other', name: 'Other' }
    const panel = { session: '', name: '面板' }

    const open = await service.createRequirement({ summary: '测试简述', title: '任意角色可接' }, other)
    const routed = await service.createRequirement({ summary: '测试简述', title: '美术任务' }, other)
    await service.updateRequirement(routed.id, { role: 'art-role' }, panel)
    const elsewhere = await service.createRequirement({ summary: '测试简述', title: '待其他角色' }, other)
    await service.updateRequirement(elsewhere.id, { role: 'qa-role' }, panel)
    const busy = await service.createRequirement({ summary: '测试简述', title: 'QA 在做' }, other)
    await service.claim(busy.id, {}, qa)
    const mine = await service.createRequirement({ summary: '测试简述', title: '我已持锁' }, other)
    await service.claim(mine.id, {}, art)
    const finished = await service.createRequirement({ summary: '测试简述', title: '已完成' }, other)
    await service.transitionRequirement(finished.id, { action: 'complete', force: true }, panel)

    const expected = [open.id, mine.id, routed.id].sort()
    const formula = service.listRequirements({ limit: 200 })
      .items.filter(item => claimable(service.getRequirement(item.id), art.session, 'art-role', { reservedBy: null }))
      .map(item => item.id)
      .sort()
    check('the formula accepts the open, the routed, and my own requirement', formula.join(',') === expected.join(','), formula.join(','))

    const filtered = service.listRequirements({ claimable: true }, art.session)
    check('the claimable filter is the formula and nothing else', filtered.items.map(item => item.id).sort().join(',') === expected.join(','), filtered.items.map(item => item.id).join(','))
    check('a requirement held by another session is not claimable', !filtered.items.some(item => item.id === busy.id))
    check('a requirement routed to another role is not claimable', !filtered.items.some(item => item.id === elsewhere.id))
    check('a finished requirement is not claimable', !filtered.items.some(item => item.id === finished.id))

    const states = { [open.id]: 'free', [mine.id]: 'mine', [busy.id]: 'other' }
    check('the states behind the filter agree with lockState', Object.entries(states).every(([id, state]) => lockState(service.getRequirement(id), art.session).state === state))

    const viaPanel = await dispatchBoardCommand(service, { action: 'list', filter: { claimable: true }, me: art.session })
    check('the panel filter lists the same ids', viaPanel.items.map(item => item.id).sort().join(',') === expected.join(','))

    // The panel asks for the takeable pool, not for its own eligibility: it
    // wears no role, so the role clause must not narrow the answer (§3.5).
    const pool = [open.id, routed.id, elsewhere.id].sort()
    const panelView = await dispatchBoardCommand(service, { action: 'list', filter: { claimable: true } })
    check('without a session the filter answers with the takeable pool', panelView.items.map(item => item.id).sort().join(',') === pool.join(','), panelView.items.map(item => item.id).join(','))
    check('the pool includes a requirement routed to a role nobody here wears', panelView.items.some(item => item.id === elsewhere.id))
    check('that same requirement is not claimable for a session without its role', !filtered.items.some(item => item.id === elsewhere.id))
    check('the pool differs in membership, not only in size', panelView.items.some(item => item.id === elsewhere.id) && !filtered.items.some(item => item.id === elsewhere.id)
      && filtered.items.some(item => item.id === mine.id) && !panelView.items.some(item => item.id === mine.id))
    check('the pool still excludes what another session holds', !panelView.items.some(item => item.id === busy.id || item.id === mine.id))
    check('the pool still excludes finished work', !panelView.items.some(item => item.id === finished.id))
    check('the two readings come from the one formula', claimable({ id: 'req_x', status: 'active', rev: 1, role: 'art-role' }, '', '') === true
      && claimable({ id: 'req_x', status: 'active', rev: 1, role: 'art-role' }, 'ses_qa', 'qa-role') === false)

    const viaRoute = await dispatchBoardCommand(service, { action: 'refresh', filter: { claimable: true }, me: art.session })
    check('the snapshot route filters the same way', viaRoute.requirements.map(item => item.id).sort().join(',') === expected.join(','))
    const routePool = await dispatchBoardCommand(service, { action: 'refresh', filter: { claimable: true } })
    check('the snapshot route answers with the pool for the panel', routePool.requirements.map(item => item.id).sort().join(',') === pool.join(','))

    // The same three readings over the query string. A `URLSearchParams` is not a
    // plain object of its parameters, so bracket access reads nothing and every
    // filter below would answer as if its parameter were absent.
    const viaQuery = await requestRoute(service, `/snapshot?claimable=true&me=${art.session}`)
    check('the query string carries "me" into the filter', viaQuery.body.data.requirements.map(item => item.id).sort().join(',') === expected.join(','), viaQuery.body.data.requirements.map(item => item.id).join(','))
    const queryPool = await requestRoute(service, '/snapshot?claimable=true')
    check('the query string answers with the pool when "me" is absent', queryPool.body.data.requirements.map(item => item.id).sort().join(',') === pool.join(','), queryPool.body.data.requirements.map(item => item.id).join(','))
    const qaQuery = await requestRoute(service, `/snapshot?claimable=true&me=${qa.session}`)
    check('the query string resolves "me" to its own role, not to a match-all', qaQuery.body.data.requirements.some(item => item.id === elsewhere.id) && !qaQuery.body.data.requirements.some(item => item.id === routed.id), qaQuery.body.data.requirements.map(item => item.id).join(','))
    const byTitle = await requestRoute(service, `/snapshot?query=${encodeURIComponent('美术')}`)
    check('the other query parameters reach the service as well', byTitle.body.data.requirements.map(item => item.id).join(',') === routed.id, byTitle.body.data.requirements.map(item => item.id).join(','))
    const crossOrigin = await requestRoute(service, '/snapshot', { origin: 'http://evil.example' })
    check('a cross-origin read is refused by the route', crossOrigin.status === 403 && crossOrigin.body.error.code === 'forbidden-origin')

    const prompt = service.promptContext(art.session, 12)
    const listed = promptSection(prompt, 'Claimable for you')
    check('the prompt lists what this session may take', listed.slice().sort().join(',') === [open.id, routed.id].sort().join(','), listed.join(','))
    check('the prompt leaves out the requirement this session already holds', !listed.includes(mine.id))
    check('the prompt leaves out the other sessions\' and other roles\' work', !listed.includes(busy.id) && !listed.includes(elsewhere.id) && !listed.includes(finished.id))
    check('the prompt still names the shared board', prompt.includes('Shared requirement board'))
    await board.close()
  })
}

/** The panel releases locks but never takes one. */
async function casePanelCannotClaim(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const panel = { session: '', name: '面板' }
    const ai = { session: 'ses_A', name: 'A' }
    const created = await service.createRequirement({ summary: '测试简述', title: '面板不认领' }, panel)

    const refused = await reporter.rejects('the panel cannot claim', () => service.claim(created.id, {}, panel), 'invalid-argument')
    check('the refusal says a session is required', refused.details?.reason === 'session-required')
    await reporter.rejects('the panel command surface has no claim action', () => dispatchBoardCommand(service, { action: 'claim', id: created.id }), 'invalid-argument')

    await service.claim(created.id, {}, ai)
    const released = await dispatchBoardCommand(service, { action: 'release', id: created.id, note: '人工回收' })
    check('the panel releases a stuck session\'s lock', released.lock === null && released.history.at(-1).action === 'release' && released.history.at(-1).note === '人工回收')

    await service.claim(created.id, {}, ai)
    await reporter.rejects('a session cannot release another session\'s lock', () => service.release(created.id, {}, { session: 'ses_B' }), 'forbidden')
    check('the lock survived the refused release', service.getRequirement(created.id).lock.session === 'ses_A')
    await board.close()
  })
}

/** The model-facing tool claims, filters, and releases through the real service. */
async function caseToolSurface(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir, ports: rolePorts([agentOf('ses_art', 'art-role')]) })
    const mounted = createMountContext({
      storageDomain: { open: async () => board.domain },
      get: serviceName => (serviceName === 'agents' ? fakeAgents([agentOf('ses_art', 'art-role')]) : undefined),
    })
    await applyBoardPlugin(mounted.ctx, resolveConfig({}))
    const tool = mounted.records.tools.find(candidate => candidate.name === 'requirement_board')
    check('the board tool exposes claim and release', tool.parameters.properties.action.enum.includes('claim') && tool.parameters.properties.action.enum.includes('release'))
    check('the board tool exposes the claimable filter', tool.parameters.properties.claimable?.type === 'boolean')

    const exec = { agent: { id: 'ses_art' } }
    const created = await tool.execute({ action: 'create', summary: '测试简述', title: '工具面' }, exec)
    check('the tool creates through the same service', created.id.startsWith('req_') && created.lock === null)
    const claimed = await tool.execute({ action: 'claim', id: created.id }, exec)
    check('the tool claims with the calling session', claimed.lock?.session === 'ses_art')
    const listed = await tool.execute({ action: 'list', claimable: true }, exec)
    check('the tool lists claimable work for the same session', listed.items.length === 1 && listed.items[0].id === created.id)
    await reporter.rejects('the tool refuses a structural change without the lock', () => tool.execute({ action: 'archive', id: created.id }, { agent: { id: 'ses_other' } }), 'forbidden')
    const released = await tool.execute({ action: 'release', id: created.id }, exec)
    check('the tool releases the lock', released.lock === null)
    await board.close()
  })
}

/** Every bound this stage started enforcing refuses one step past it. */
async function caseValidationBounds(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const actor = { session: 'ses_A', name: 'A' }
    const created = await service.createRequirement({ summary: '测试简述', title: '上界' }, actor)

    check('a 60-character label is accepted', (await service.updateRequirement(created.id, { labels: ['x'.repeat(60)] }, actor)).labels[0].length === 60)
    await reporter.rejects('a 61-character label is refused', () => service.updateRequirement(created.id, { labels: ['x'.repeat(61)] }, actor), 'invalid-argument')

    check('a 200-character session id is accepted', (await service.updateRequirement(created.id, { sessions: ['s'.repeat(200)] }, actor)).sessions.some(id => id.length === 200))
    await reporter.rejects('a 201-character session id is refused', () => service.updateRequirement(created.id, { sessions: ['s'.repeat(201)] }, actor), 'invalid-argument')

    const dependency = 'd'.repeat(64)
    const template = await service.createTemplate({
      id: 'tpl-bounds',
      name: '边界',
      nodes: [
        { id: dependency, name: '前置', completion: { type: 'manual' } },
        { id: 'n1', name: '当前', dependsOn: [dependency], completion: { type: 'checklist', checklist: ['c'.repeat(160)] } },
      ],
    }, actor)
    check('a 160-character checklist entry and a 64-character dependency are accepted', template.nodes[1].completion.checklist[0].length === 160 && template.nodes[1].dependsOn[0].length === 64)
    const longCheck = await reporter.rejects('a 161-character checklist entry is refused', () => service.createTemplate({ name: '太长', nodes: [{ name: 'n', completion: { type: 'checklist', checklist: ['c'.repeat(161)] } }] }, actor), 'invalid-argument')
    check('the checklist refusal names its bound', String(longCheck.message).includes('160'))
    const longDep = await reporter.rejects('a 65-character dependency is refused', () => service.createTemplate({ name: '太长', nodes: [{ name: 'n', dependsOn: [dependency + 'd'] }] }, actor), 'invalid-argument')
    check('the dependency refusal names its bound', String(longDep.message).includes('64'))

    check('a 40-character duty is accepted', (await service.putRole({ roleId: 'bounded', duties: ['d'.repeat(40)] })).duties[0].length === 40)
    await reporter.rejects('a 41-character duty is refused', () => service.putRole({ roleId: 'bounded', duties: ['d'.repeat(41)] }), 'invalid-argument')

    const longRole = 'r'.repeat(33)
    await reporter.rejects('a 33-character role id is refused', () => service.putRole({ roleId: longRole }), 'invalid-role')
    await reporter.rejects('a requirement cannot name a malformed role', () => service.createRequirement({ summary: '测试简述', title: 'x', role: longRole }, actor), 'invalid-role')
    check('a requirement may name the human role', (await service.createRequirement({ summary: '测试简述', title: '拍板', role: 'human' }, actor)).role === 'human')
    await board.close()
  })
}

/**
 * An attached image is prose, and an id that names no stored image is refused.
 *
 * `images` is part of what the description shows, so attaching one takes no lock —
 * the rule the title and the labels already follow — and it stays an agent-editable
 * part of a decision requirement, whose readable side belongs to the session
 * asking the question (§5.7). The id is the record's own reference form, so an id
 * nothing was stored under is refused before the write chain is entered.
 */
async function caseImagesAreProse(backend, name) {
  await onBackend(backend, name, async dir => {
    const config = resolveConfig({ imageDir: join(dir, 'images') })
    const board = await openBoard({ backend, dir, config })
    const service = board.service
    const ai = { session: 'ses_A', name: 'A' }
    const panel = { session: '', name: '面板' }
    const image = await service.storeImage({ bytes: imageFixture('image/webp', 7, 8), mediaType: 'image/webp', name: 'shot.webp' })

    const decision = await service.createRequirement({ summary: '测试简述', title: '拍板', kind: 'decision' }, panel)
    const attached = await service.updateRequirement(decision.id, { images: [image.id] }, ai)
    check('an agent may attach an image to a decision requirement', attached.images.length === 1 && attached.images[0].id === image.id)
    check('the attached ref keeps the encoded size', attached.images[0].width === 7 && attached.images[0].height === 8)
    check('an empty list detaches every image', (await service.updateRequirement(decision.id, { images: [] }, ai)).images.length === 0)
    await reporter.rejects('an unknown image id is refused loud', () => service.updateRequirement(decision.id, { images: ['img-00000000-0000-0000-0000-000000000000'] }, ai), 'invalid-image')
    await reporter.rejects('a malformed image id is refused too', () => service.updateRequirement(decision.id, { images: ['../../etc/passwd'] }, ai), 'invalid-image')
    check('the refused attachment left the record untouched', service.getRequirement(decision.id).images.length === 0)

    const work = await service.createRequirement({ summary: '测试简述', title: '普通任务' }, panel)
    const unlocked = await service.updateRequirement(work.id, { images: [image.id] }, ai)
    check('attaching an image needs no lock', unlocked.images[0].id === image.id)
    const before = service.getRequirement(work.id)
    const same = await service.updateRequirement(work.id, { images: [image.id] }, ai)
    check('re-naming the stored ids writes nothing', same.rev === before.rev && same.images[0].id === image.id)

    await reporter.rejects('an unknown id is refused on create as well', () => service.createRequirement({ summary: '测试简述', title: '写不进去', images: ['nope'] }, ai), 'invalid-image')
    check('the refused create wrote no requirement', [...board.domain.table('requirements').entries()].every(([, record]) => record.title !== '写不进去'))
    await board.close()
  })
}

for (const backend of BACKENDS) {
  await caseClaimAndRelease(backend, 'claim and release write the lock, its history, and the revision')
  await caseLockConflictAndRows(backend, 'a held lock refuses a competitor and each row has its own code')
  await caseOrphanAndLease(backend, 'orphaned and expired locks are taken over, a fresh one is not')
  await caseConfiguredLease(backend, 'the lease length is configuration, inside its own bounds')
  await caseLeaseRenewal(backend, 'a holder\'s write renews the lease and is not taken over')
  await caseConcurrentClaim(backend, 'one of two concurrent claims wins')
  await caseSameContentDifferentIds(backend, 'identical content under different ids locks independently')
  await caseStructuralGate(backend, 'structural actions need the lock; prose and the panel do not')
  await caseCompletionReleases(backend, 'finishing the flow releases the lock in the same write')
  await caseClaimableSingleSource(backend, 'claimable, the prompt, and the panel filter answer from one formula')
  await casePanelCannotClaim(backend, 'the panel releases locks but never takes one')
  await caseToolSurface(backend, 'the model-facing tool claims, filters, and releases')
  await caseValidationBounds(backend, 'every bound this stage enforces refuses one step past it')
  await caseImagesAreProse(backend, 'an attached image is prose and an unknown id is refused')
}

process.exit(reporter.finish() ? 0 : 1)
