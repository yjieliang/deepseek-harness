/**
 * Stage A3 cases: the execution queue and its soft reservation
 * (`ROLE-DISPATCH.md` §9 "A3 执行队列").
 *
 * A reservation is derived state: it lives in a per-session `queues` row, never
 * on the requirement, so these cases check both readings of one fact — the queue
 * receipt and the requirement's derived `reservedBy`. Every case runs against
 * every backend in {@link BACKENDS}, because the reservation has to survive a
 * reopen the same way the lock does.
 *
 * `queue` judges through the same ordered table as `claim` minus its last row
 * (§5.4), so the cases that pin a row go through the service and assert the same
 * machine code `claim` would produce.
 */

import { dispatchBoardCommand } from '../host/http.js'
import { resolveConfig } from '../host/config.js'
import { judgeClaim } from '../host/dispatch.js'
import { apply as applyBoardPlugin } from '../index.js'
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

/** An instant a number of hours before now. */
function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

/** Seed one lock without going through a claim, as a restored document would. */
async function seedLock(domain, id, lock) {
  await domain.table('requirements').update(id, record => ({ ...record, lock }))
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

/** Run one case for one backend in its own directory. */
async function onBackend(backend, name, body) {
  const dir = await makeTempDir(`rb-queue-${backend}-`)
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
    .map(line => line.match(/^- (req_[0-9a-f]+)/)?.[1])
    .filter(Boolean)
}

/** A reservation takes no lock, writes no requirement, and survives a repeat. */
async function caseReserveWithoutLock(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const first = await service.createRequirement({ title: '排队一' }, a)
    const second = await service.createRequirement({ title: '排队二' }, a)

    const framesBefore = board.changes.length
    const receipt = await service.queue(first.id, {}, a)
    check('a queue append reserves the requirement for the calling session', receipt.changed === true && receipt.length === 1 && receipt.head?.id === first.id)
    check('the receipt names the reserving session and its row', receipt.session === 'ses_A' && receipt.sessionName === 'A' && receipt.items[0].id === first.id && typeof receipt.items[0].at === 'string')
    check('the reservation is stored in the queues row, not on the record', board.domain.table('queues').get('ses_A').items[0].id === first.id)

    const frames = board.changes.slice(framesBefore)
    check('a first append is two durable writes, one per record', frames.length === 2, frames.map(frame => `${frame.table || 'global'}:${frame.operation}`).join(','))
    check('the two writes are the queue row and the global revision', frames[0]?.table === 'queues' && frames[0]?.key === 'ses_A' && frames[1]?.table === '' && frames[1]?.operation === 'put')

    const stored = board.domain.table('requirements').get(first.id)
    check('queueing takes no lock', stored.lock === null)
    check('queueing does not write the requirement', stored.rev === 1 && stored.updatedAt === first.updatedAt)
    check('queueing creates no execution unit', stored.executions === undefined)
    check('the requirement reports its reservation as a derived field', (await service.getRequirement(first.id)).reservedBy === 'ses_A')

    const repeatFrames = board.changes.length
    const repeat = await service.queue(first.id, {}, a)
    check('appending the same requirement twice changes nothing', repeat.changed === false && repeat.length === 1 && repeat.updatedAt === receipt.updatedAt)
    check('an idempotent append writes nothing', board.changes.length === repeatFrames)

    const secondReceipt = await service.queue(second.id, {}, a)
    check('the queue is append-ordered and its head is the first reservation', secondReceipt.length === 2 && secondReceipt.items[1].id === second.id && secondReceipt.head.id === first.id)
    check('the reading is the same through queueOf', JSON.stringify(service.queueOf('ses_A').items) === JSON.stringify(secondReceipt.items))
    check('a session that reserved nothing reads an empty receipt', service.queueOf('ses_Z').length === 0 && service.queueOf('ses_Z').head === null && service.queueOf('ses_Z').updatedAt === null)
    check('the panel keeps no queue of its own', service.queueOf('').length === 0)

    const stats = service.stats()
    check('statistics observe the reservations', stats.queues === 1 && stats.queued === 2 && stats.reserved === 2)

    const other = { session: 'ses_B', name: 'B' }
    const taken = await reporter.rejects('another session cannot reserve what a queue already holds', () => service.queue(second.id, {}, other), 'conflict')
    check('the refusal is the claim-table reservation row', taken.details?.reason === 'reserved' && taken.details?.reservedBy === 'ses_A')
    check('the refusal left the holder\'s queue untouched', service.queueOf('ses_A').length === 2 && (await service.getRequirement(second.id)).reservedBy === 'ses_A')
    check('a refused append leaves no row of its own behind', board.domain.table('queues').get('ses_B') === undefined && service.queueOf('ses_B').updatedAt === null)
    await board.close()
  })
}

/** The bound is configuration, and it refuses one append past it. */
async function caseQueueBound(backend, name) {
  await onBackend(backend, name, async dir => {
    check('the default bound is twenty', resolveConfig({}).maxQueueItems === 20)
    check('the smallest bound is accepted', resolveConfig({ maxQueueItems: 5 }).maxQueueItems === 5)
    check('the largest bound is accepted', resolveConfig({ maxQueueItems: 100 }).maxQueueItems === 100)
    await reporter.rejects('a bound below the minimum is refused', async () => resolveConfig({ maxQueueItems: 4 }), 'invalid-config')
    await reporter.rejects('a bound above the maximum is refused', async () => resolveConfig({ maxQueueItems: 101 }), 'invalid-config')
    await reporter.rejects('a fractional bound is refused', async () => resolveConfig({ maxQueueItems: 5.5 }), 'invalid-config')

    const board = await openBoard({ backend, dir, config: resolveConfig({ maxQueueItems: 5 }) })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const ids = []
    for (let index = 0; index < 5; index += 1) {
      ids.push((await service.createRequirement({ title: `排队 ${index}` }, a)).id)
    }
    for (const id of ids) await service.queue(id, {}, a)
    check('the queue accepts exactly the configured maximum', service.queueOf('ses_A').length === 5)

    const sixth = (await service.createRequirement({ title: '第六' }, a)).id
    const refused = await reporter.rejects('one past the bound is refused', () => service.queue(sixth, {}, a), 'invalid-input')
    check('the refusal names the bound and its reason', refused.details?.reason === 'queue-full' && refused.details?.max === 5)
    check('the refused append reserved nothing', (await service.getRequirement(sixth)).reservedBy === null && service.queueOf('ses_A').length === 5)

    const repeatAtBound = await service.queue(ids[0], {}, a)
    check('re-appending an item the queue already holds is still idempotent at the bound', repeatAtBound.changed === false && repeatAtBound.length === 5)
    check('the bounded queue left the next requirement free', (await service.queue(sixth, {}, b)).changed === true && (await service.getRequirement(sixth)).reservedBy === 'ses_B')
    await board.close()
  })
}

/** A reservation refuses another session's claim without moving anything. */
async function caseReservationBlocksClaim(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const created = await service.createRequirement({ title: '预留' }, a)
    await service.queue(created.id, {}, a)

    const refused = await reporter.rejects('another session cannot claim a reserved requirement', () => service.claim(created.id, {}, b), 'conflict')
    check('the refusal names the reservation and its holder', refused.details?.reason === 'reserved' && refused.details?.reservedBy === 'ses_A')
    check('the refusal leaves the reservation and the lock alone', service.queueOf('ses_A').length === 1 && board.domain.table('requirements').get(created.id).lock === null)

    const againstB = service.listRequirements({ claimable: true }, 'ses_B')
    const forA = service.listRequirements({ claimable: true }, 'ses_A')
    const forPanel = service.listRequirements({ claimable: true }, '')
    check('the reserved requirement leaves another session\'s claimable list', againstB.items.every(item => item.id !== created.id))
    check('the reserved requirement stays in its own session\'s claimable list', forA.items.some(item => item.id === created.id))
    check('the reserved requirement is out of the panel\'s takeable pool', forPanel.items.every(item => item.id !== created.id))

    const claimed = await service.claim(created.id, {}, a)
    check('the reserving session may claim its own reservation', claimed.lock.session === 'ses_A' && claimed.lock.at === claimed.lock.touchedAt)
    check('the reservation survives the claim it reserved for', (await service.getRequirement(created.id)).reservedBy === 'ses_A')
    await board.close()
  })
}

/** `unqueue` frees the requirement, is idempotent, and leaves no empty row. */
async function caseUnqueueFrees(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const first = await service.createRequirement({ title: '放行一' }, a)
    const second = await service.createRequirement({ title: '放行二' }, a)
    await service.queue(first.id, {}, a)
    await service.queue(second.id, {}, a)

    const trimmed = await service.unqueue(first.id, {}, a)
    check('unqueue reports the row it shortened', trimmed.changed === true && trimmed.length === 1 && trimmed.head.id === second.id)
    check('the requirement reports its reservation gone', (await service.getRequirement(first.id)).reservedBy === null)
    check('unqueueing the head moves the head to the next reservation', service.queueOf('ses_A').head.id === second.id)

    const cleared = await service.unqueue(second.id, {}, a)
    check('emptying the queue reports an empty row', cleared.changed === true && cleared.length === 0 && cleared.head === null)
    check('an emptied queue row is deleted, not left behind', board.domain.table('queues').get('ses_A') === undefined)
    check('statistics no longer count the reservation', service.stats().reserved === 0 && service.stats().queues === 0)

    const taken = await service.claim(first.id, {}, b)
    check('another session claims the requirement after unqueue', taken.lock.session === 'ses_B')
    const again = await service.unqueue(second.id, {}, a)
    check('unqueue is idempotent', again.changed === false && again.length === 0)
    const unknown = await service.unqueue('req_unknown', {}, a)
    check('unqueueing an id nobody reserved writes nothing', unknown.changed === false && unknown.length === 0)
    await board.close()
  })
}

/** `queue` judges through the claim table minus its one-lock-per-session row. */
async function caseQueueUsesClaimTable(backend, name) {
  await onBackend(backend, name, async dir => {
    const agents = [agentOf('ses_A', 'art-role'), agentOf('ses_B', 'qa-role')]
    const board = await openBoard({ backend, dir, ports: { agents: () => fakeAgents(agents), presets: () => fakePresets() } })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }

    const routed = await service.createRequirement({ title: '美术活', role: 'art-role' }, a)
    const mismatch = await reporter.rejects('a session without the role cannot queue it', () => service.queue(routed.id, {}, b), 'forbidden')
    check('the role refusal carries the claim-table row and its details', mismatch.details?.reason === 'role-mismatch' && mismatch.details?.role === 'art-role' && mismatch.details?.myRole === 'qa-role')
    check('the session wearing the role may queue it', (await service.queue(routed.id, {}, a)).changed === true)

    const unrouted = await service.createRequirement({ title: '都能做' }, a)
    const finished = await service.createRequirement({ title: '已完成' }, a)
    await service.claim(finished.id, {}, a)
    await service.transitionRequirement(finished.id, { action: 'complete' }, a)
    const doneQueue = await reporter.rejects('a finished requirement cannot be queued', () => service.queue(finished.id, {}, a), 'invalid-state')
    const doneClaim = await reporter.rejects('the same finished requirement cannot be claimed', () => service.claim(finished.id, {}, a), 'invalid-state')
    check('queue and claim refuse a finished requirement with one code and reason', doneQueue.code === doneClaim.code && doneQueue.details?.reason === doneClaim.details?.reason)

    const held = await service.createRequirement({ title: '被占' }, a)
    await service.claim(held.id, {}, a)
    const lockedQueue = await reporter.rejects('a requirement locked by another session cannot be queued', () => service.queue(held.id, {}, b), 'conflict')
    check('the locked refusal is the claim-table lock row', lockedQueue.details?.reason === 'locked' && lockedQueue.details?.current?.session === 'ses_A')
    check('a requirement the caller did not queue carries no unqueue hint', lockedQueue.details?.queued === false)

    // §5.3: the head of my queue taken by someone else is refused with a pointer
    // to `unqueue`, and the queue itself is not changed. The service's own claim
    // path cannot produce this state — row 5 refuses any claimant while another
    // session reserves the requirement — so the lock is seeded directly, as a
    // restored document that carried a lock would.
    const mine = await service.createRequirement({ title: '我排的' }, b)
    await service.queue(mine.id, {}, b)
    await seedLock(board.domain, mine.id, { session: 'ses_A', name: 'A', at: hoursAgo(1), touchedAt: new Date().toISOString() })
    const headRefusal = await reporter.rejects('a queue head locked by another session cannot be claimed', () => service.claim(mine.id, {}, b), 'conflict')
    check('the refusal says the item is in the caller\'s queue', headRefusal.details?.reason === 'locked' && headRefusal.details?.queued === true && String(headRefusal.message).includes('unqueue'))
    check('the refusal does not change the queue', service.queueOf('ses_B').length === 1 && service.queueOf('ses_B').head.id === mine.id)
    const swapped = await service.unqueue(mine.id, {}, b)
    check('unqueueing the stuck head is what the refusal pointed at', swapped.changed === true && service.queueOf('ses_B').length === 0)

    // `kind: 'decision'` arrives with its own stage, so that row is driven through
    // the judge the queue calls rather than through a second table.
    const decisionRefusal = await reporter.rejects('the shared judge refuses a decision task', () => judgeClaim({
      record: { id: 'req_fixture', status: 'active', rev: 1, kind: 'decision' },
      session: 'ses_A',
    }), 'forbidden')
    check('the decision refusal is the claim-table reason', decisionRefusal.details?.reason === 'decision-task')

    const panelRefusal = await reporter.rejects('the panel queues nothing for itself', () => service.queue(unrouted.id, {}, { session: '', name: '面板' }), 'invalid-argument')
    check('the panel refusal names the missing session', panelRefusal.details?.reason === 'session-required')
    check('no refusal reserved anything', (await service.getRequirement(unrouted.id)).reservedBy === null)
    await board.close()
  })
}

/** A holder whose lease lapsed and who then writes again revives the lock under a standing reservation. */
async function caseRevivedLeaseRefusesQueuedClaim(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const task = await service.createRequirement({ title: '复活' }, a)
    const control = await service.createRequirement({ title: '对照' }, a)
    const longAgo = hoursAgo(9)

    // A claimed nine hours ago and has written nothing since, so its lease is
    // over: B may reserve the requirement while A still owns the lock.
    await seedLock(board.domain, task.id, { session: 'ses_A', name: 'A', at: longAgo, touchedAt: longAgo })
    const reserved = await service.queue(task.id, {}, b)
    check('an over-lease lock lets another session reserve the requirement', reserved.changed === true && reserved.head.id === task.id)
    check('the reservation took no lock of its own', board.domain.table('requirements').get(task.id).lock.session === 'ses_A')

    // A's next write is its own idempotent claim: the write chain renews the
    // lease in the same update, so the expired lock becomes live again.
    const revived = await service.claim(task.id, {}, a)
    check('the holder re-claiming its own lock is idempotent', revived.lock?.session === 'ses_A')
    check('the holder\'s write renewed the lease', Date.parse(revived.lock.touchedAt) > Date.parse(hoursAgo(1)) && revived.lock.at === longAgo)

    const stuck = await reporter.rejects('the reservation cannot take a lock its owner revived', () => service.claim(task.id, {}, b), 'conflict')
    check('the refusal is the lock row and names the reservation', stuck.details?.reason === 'locked' && stuck.details?.current?.session === 'ses_A' && stuck.details?.current?.expired === false)
    check('the refusal flags the caller\'s own queue item', stuck.details?.queued === true && String(stuck.message).includes('unqueue'))

    await service.unqueue(task.id, {}, b)
    const plain = await reporter.rejects('without the reservation the same refusal carries no queue flag', () => service.claim(task.id, {}, b), 'conflict')
    check('the lock alone refuses the claim once the reservation is gone', plain.details?.reason === 'locked' && plain.details?.queued === false)

    // The control pins the premise: had A not written again, the over-lease lock
    // would have been takeable and the reservation would not have refused anything.
    await seedLock(board.domain, control.id, { session: 'ses_A', name: 'A', at: longAgo, touchedAt: longAgo })
    await service.queue(control.id, {}, b)
    const taken = await service.claim(control.id, {}, b)
    check('an over-lease lock without a revival is taken over by the reserver', taken.lock?.session === 'ses_B' && taken.lock?.orphaned === undefined)
    await board.close()
  })
}

/** A session waiting on one lock reserves the next requirement; the lock still rules. */
async function caseReserveWhileExecuting(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const running = await service.createRequirement({ title: '手上的活' }, a)
    const next = await service.createRequirement({ title: '下一条' }, a)
    const later = await service.createRequirement({ title: '再下一条' }, a)
    await service.claim(running.id, {}, a)

    const reserved = await service.queue(next.id, {}, a)
    check('a session that is executing may reserve its next requirement', reserved.changed === true && reserved.head.id === next.id)
    check('the reservation took no second lock', board.domain.table('requirements').get(next.id).lock === null)

    const busy = await reporter.rejects('the one-lock rule still refuses a second claim', () => service.claim(later.id, {}, a), 'conflict')
    check('the refusal names the current lock and the caller\'s queue head', busy.details?.reason === 'session-busy' && busy.details?.current?.session === 'ses_A' && busy.details?.queueHead?.id === next.id)
    check('the busy refusal did not change the queue', service.queueOf('ses_A').length === 1 && service.queueOf('ses_A').head.id === next.id)
    await board.close()
  })
}

/** Two sessions queueing one requirement concurrently: exactly one reservation. */
async function caseConcurrentReservation(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const created = await service.createRequirement({ title: '并发排队' }, a)

    const [first, second] = await Promise.allSettled([
      service.queue(created.id, {}, a),
      service.queue(created.id, {}, b),
    ])
    const winners = [first, second].filter(entry => entry.status === 'fulfilled')
    const losers = [first, second].filter(entry => entry.status === 'rejected')
    check('exactly one of two concurrent queue appends wins', winners.length === 1 && losers.length === 1)
    check('the loser is refused as reserved', losers[0].reason?.code === 'conflict' && losers[0].reason?.details?.reason === 'reserved')
    check('the loser names the winner as the holder of the reservation', losers[0].reason?.details?.reservedBy === winners[0].value.session)

    const rows = [...board.domain.table('queues').entries()].filter(([, row]) => row.items.some(item => item.id === created.id))
    check('only one queue row names the requirement', rows.length === 1)
    check('the winner\'s row holds exactly one item', rows[0][1].items.length === 1)
    check('the derived reading agrees with the winning session', (await service.getRequirement(created.id)).reservedBy === winners[0].value.session)

    // Two appends from one session for two requirements: the first writes the
    // session's whole row, so the session's own chain is what keeps both items.
    const c = { session: 'ses_C', name: 'C' }
    const left = await service.createRequirement({ title: '同会话一' }, a)
    const right = await service.createRequirement({ title: '同会话二' }, a)
    const [one, two] = await Promise.allSettled([service.queue(left.id, {}, c), service.queue(right.id, {}, c)])
    check('both concurrent appends from one session succeed', one.status === 'fulfilled' && two.status === 'fulfilled')
    check('the session row created by the first append holds both items', service.queueOf('ses_C').length === 2)
    check('both reservations are readable as derived state', (await service.getRequirement(left.id)).reservedBy === 'ses_C' && (await service.getRequirement(right.id)).reservedBy === 'ses_C')
    await board.close()
  })
}

/** Completion releases both the lock and the reservation, and only hints the head. */
async function caseCompletionReleasesReservation(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const first = await service.createRequirement({ title: '第一条' }, a)
    const second = await service.createRequirement({ title: '第二条' }, a)
    await service.queue(first.id, {}, a)
    await service.queue(second.id, {}, a)

    const claimed = await service.claim(first.id, {}, a)
    check('a queued requirement claims like any other', claimed.lock.session === 'ses_A' && claimed.lock.at === claimed.lock.touchedAt)
    const done = await service.transitionRequirement(first.id, { action: 'complete' }, a)
    check('completion releases the lock in the same write', done.lock === null)
    check('completion releases the completed reservation', done.reservedBy === null && service.queueOf('ses_A').length === 1 && service.queueOf('ses_A').head.id === second.id)
    check('the completion receipt names the queue head', done.queueHead?.id === second.id && typeof done.queueHead?.at === 'string')
    check('nothing was auto-claimed: the head is still unlocked', board.domain.table('requirements').get(second.id).lock === null)
    check('the head is still reserved by the same session', (await service.getRequirement(second.id)).reservedBy === 'ses_A')

    const next = await service.claim(second.id, {}, a)
    check('the session takes the head next', next.lock.session === 'ses_A' && next.lock.orphaned === undefined)
    const finished = await service.transitionRequirement(second.id, { action: 'complete' }, a)
    check('the emptied queue leaves no row behind', board.domain.table('queues').get('ses_A') === undefined && service.queueOf('ses_A').length === 0)
    check('a completion with an empty queue carries no head hint', finished.queueHead === undefined)

    const third = await service.createRequirement({ title: '第三条' }, a)
    const fourth = await service.createRequirement({ title: '第四条' }, a)
    await service.claim(third.id, {}, a)
    await service.queue(fourth.id, {}, a)
    const released = await service.release(third.id, {}, a)
    check('a release receipt names the head as well', released.lock === null && released.queueHead?.id === fourth.id)
    await board.close()
  })
}

/** Archiving and deleting end a reservation; restoring does not bring it back. */
async function caseArchiveAndDeleteRelease(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const panel = { session: '', name: '面板' }

    const reserved = await service.createRequirement({ title: '归档' }, a)
    await service.queue(reserved.id, {}, a)
    const archived = await service.setArchived(reserved.id, { archived: true }, panel)
    check('archiving releases the reservation', archived.reservedBy === null && service.queueOf('ses_A').length === 0)
    const restored = await service.setArchived(reserved.id, { archived: false }, panel)
    check('restoring does not resurrect the reservation', restored.reservedBy === null && service.queueOf('ses_A').length === 0)

    const doomed = await service.createRequirement({ title: '删除' }, a)
    await service.queue(doomed.id, {}, a)
    const deleted = await service.deleteRequirement(doomed.id, {}, panel)
    check('a reserved requirement can be deleted', deleted.deleted === true)
    check('deleting releases the reservation everywhere', service.queueOf('ses_A').length === 0
      && [...board.domain.table('queues').entries()].every(([, row]) => row.items.every(item => item.id !== doomed.id)))
    check('the emptied row is gone', board.domain.table('queues').get('ses_A') === undefined)
    await board.close()
  })
}

/** A disposed session releases its reservations and orphans the locks it held. */
async function caseDisposal(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const running = await service.createRequirement({ title: '在跑' }, a)
    const waiting = await service.createRequirement({ title: '在等' }, a)
    await service.claim(running.id, {}, a)
    await service.queue(waiting.id, {}, a)
    check('a live lock is not counted as orphaned', service.stats().orphanedLocks === 0)

    const report = await service.disposeSession({ id: 'ses_A' })
    check('disposal reports what it released and orphaned', report.session === 'ses_A' && report.releasedQueueItems === 1 && report.orphaned === 1)
    check('the lock disposal orphaned is counted', service.stats().orphanedLocks === 1)
    check('the disposed session keeps no queue row', board.domain.table('queues').get('ses_A') === undefined && service.queueOf('ses_A').length === 0)
    const orphan = board.domain.table('requirements').get(running.id).lock
    check('the lock it held is marked orphaned, not released', orphan.orphaned === true && orphan.session === 'ses_A' && orphan.name === 'A')
    check('the orphan keeps the instant it was taken', orphan.at === orphan.touchedAt && orphan.at === board.domain.table('requirements').get(running.id).updatedAt)

    const taken = await service.claim(running.id, {}, b)
    check('another session takes over the orphan immediately', taken.lock.session === 'ses_B' && taken.lock.orphaned === undefined)
    check('the takeover clears the orphan from the statistics', service.stats().orphanedLocks === 0)
    check('the waiting requirement is free again after disposal', (await service.getRequirement(waiting.id)).reservedBy === null)
    check('the freed requirement is in the panel pool again', service.listRequirements({ claimable: true }, '').items.some(item => item.id === waiting.id))

    check('a session with nothing to settle reports zero', JSON.stringify(await service.disposeSession('ses_ZZ')) === JSON.stringify({ session: 'ses_ZZ', releasedQueueItems: 0, settledDelegations: 0, orphaned: 0 }))
    check('disposal ignores an id-less report', (await service.disposeSession(undefined)).session === '')
    await board.close()
  })
}

/**
 * A nested write chain fails loud instead of waiting for itself.
 *
 * The service serializes writes per requirement and per session, and permits one
 * nesting direction: a `requirement:<id>` chain may take `session:<id>`, never the
 * reverse. A caller that re-enters from inside a chain would otherwise await the
 * promise it is itself running inside and deadlock silently, so the invariant is
 * asserted: the nested call rejects, naming both keys, and the outer call still
 * commits. The seam is the agent registry, which `queue` reads through the role
 * registry while it holds both chains.
 */
async function caseWriteChainOrder(backend, name) {
  await onBackend(backend, name, async dir => {
    const a = { session: 'ses_A', name: 'A' }
    const agents = [agentOf('ses_A', 'art-role')]
    let service = null
    let armed = false
    let nested = null
    let outerSettled = false
    let refusedBeforeOuter = false
    const reentrant = {
      list: () => [...agents],
      get: id => {
        if (armed && service !== null && nested === null) {
          nested = service.queue(inner.id, {}, a).then(
            () => { refusedBeforeOuter = !outerSettled; return null },
            error => { refusedBeforeOuter = !outerSettled; return error },
          )
        }
        return agents.find(agent => agent.id === id)
      },
    }
    const board = await openBoard({ backend, dir, ports: { agents: () => reentrant, presets: () => fakePresets() } })
    service = board.service
    const inner = await service.createRequirement({ title: '重入的目标' }, a)
    const outer = await service.createRequirement({ title: '重入的来源' }, a)
    armed = true

    const receipt = await service.queue(outer.id, {}, a)
    outerSettled = true
    check('the outer queue still commits', receipt.changed === true && receipt.length === 1 && receipt.head.id === outer.id)
    const failure = await nested
    check('the nested acquisition rejects instead of deadlocking', failure?.code === 'invalid-state' && failure?.details?.reason === 'write-chain-order')
    check('it rejects while the outer call is still in flight, so nothing waits on itself', refusedBeforeOuter === true)
    check('the refusal names the chain it held and the chain it asked for', failure?.details?.held === 'session:ses_A' && failure?.details?.key === `requirement:${inner.id}`)
    check('the refused nested call wrote nothing', service.queueOf('ses_A').items.length === 1 && service.queueOf('ses_A').items[0].id === outer.id)
    check('the requirement it named is untouched', (await service.getRequirement(inner.id)).reservedBy === null)

    // The chain map must not be poisoned by the refusal: ordinary writes still work.
    armed = false
    const after = await service.queue(inner.id, {}, a)
    check('a later write finds the chains free again', after.changed === true && service.queueOf('ses_A').items.length === 2)
    await board.close()
  })
}

/** The panel clears any session's reservation; a session clears only its own. */
async function casePanelClearsReservation(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }
    const panel = { session: '', name: '面板' }
    const created = await service.createRequirement({ title: '人可清' }, a)
    await service.queue(created.id, {}, a)

    const crossSession = await reporter.rejects('a session may not clear another session\'s reservation', () => service.unqueue(created.id, { targetSession: 'ses_A' }, b), 'forbidden')
    check('the cross-session refusal names the panel-only rule', crossSession.details?.reason === 'panel-only' && crossSession.details?.targetSession === 'ses_A')
    const anonymous = await reporter.rejects('the panel must name whose reservation it clears', () => service.unqueue(created.id, {}, panel), 'invalid-argument')
    check('the anonymous refusal names the missing session', anonymous.details?.reason === 'session-required')
    check('neither refusal touched the reservation', service.queueOf('ses_A').length === 1)

    await reporter.rejects('the panel unqueue requires an id', async () => dispatchBoardCommand(service, { action: 'unqueue' }), 'invalid-argument')
    const cleared = await dispatchBoardCommand(service, { action: 'unqueue', id: created.id, targetSession: 'ses_A' })
    check('the panel clears any session\'s reservation', cleared.changed === true && cleared.session === 'ses_A' && cleared.length === 0)
    check('the cleared requirement returns to the panel pool', service.listRequirements({ claimable: true }, '').items.some(item => item.id === created.id))

    const reservedAgain = await service.queue(created.id, {}, a)
    check('the reservation can be made again after a panel clear', reservedAgain.changed === true && service.listRequirements({ claimable: true }, '').items.every(item => item.id !== created.id))
    const panelQueue = await reporter.rejects('the panel cannot reserve work on a session\'s behalf', async () => dispatchBoardCommand(service, { action: 'queue', id: created.id, session: 'ses_A' }), 'invalid-argument')
    check('the panel refusal names the unknown action', String(panelQueue.message).includes('unknown action "queue"'))
    check('the refused panel call reserved nothing', (await service.getRequirement(created.id)).reservedBy === 'ses_A' && board.domain.table('queues').size === 1)
    await board.close()
  })
}

/** The tool and the prompt expose the queue through the same service methods. */
async function caseToolAndPromptSurface(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const agents = [agentOf('ses_A', 'art-role')]
    const mounted = createMountContext({
      storageDomain: { open: async () => board.domain },
      get: serviceName => {
        if (serviceName === 'agents') return fakeAgents(agents)
        if (serviceName === 'agentPresets') return fakePresets()
        return undefined
      },
    })
    await applyBoardPlugin(mounted.ctx, resolveConfig({ promptMaxItems: 12 }))
    const tool = mounted.records.tools[0]
    const a = { session: 'ses_A', name: 'A' }
    const b = { session: 'ses_B', name: 'B' }

    check('the tool offers queue and unqueue', ['queue', 'unqueue'].every(action => tool.parameters.properties.action.enum.includes(action)))
    check('the tool cannot name another session\'s reservation', tool.parameters.properties.targetSession === undefined)
    check('a queue append is not declared concurrency safe', tool.isConcurrencySafe({ action: 'queue' }) === false && tool.isConcurrencySafe({ action: 'unqueue' }) === false)

    const first = await board.service.createRequirement({ title: '工具排队一' }, a)
    const second = await board.service.createRequirement({ title: '工具排队二' }, a)
    const spare = await board.service.createRequirement({ title: '可接的' }, a)
    const queued = await tool.execute({ action: 'queue', id: first.id }, { agent: agents[0] })
    check('the tool queues for the calling session', queued.changed === true && queued.head.id === first.id && queued.session === 'ses_A')
    await board.service.queue(second.id, {}, a)

    const got = await tool.execute({ action: 'get', id: first.id }, { agent: agents[0] })
    check('get reports the session\'s own queue', got.queue.length === 2 && got.queue.head.id === first.id && got.reservedBy === 'ses_A')
    check('a sessionless read reports an empty queue', (await tool.execute({ action: 'get', id: first.id }, {})).queue.length === 0)

    const prompt = String(mounted.records.promptContexts[0].text({ scope: { id: 'ses_A' } }))
    check('the prompt carries one queue section naming its head', prompt.includes(`Your queue (2 queued, next: ${first.id}):`))
    check('the queue section lists the reservations in order', JSON.stringify(promptSection(prompt, 'Your queue')) === JSON.stringify([first.id, second.id]))
    check('an unqueued eligible requirement stays in the claimable section', promptSection(prompt, 'Claimable for you').includes(spare.id))
    check('a queued requirement is not repeated in the claimable section', !promptSection(prompt, 'Claimable for you').includes(first.id))

    await board.service.queue(spare.id, {}, b)
    const contested = String(mounted.records.promptContexts[0].text({ scope: { id: 'ses_A' } }))
    check('another session\'s reservation is out of this session\'s claimable section', !promptSection(contested, 'Claimable for you').includes(spare.id))
    check('the contested requirement is still reported as reserved', (await board.service.getRequirement(spare.id)).reservedBy === 'ses_B')

    const unqueued = await tool.execute({ action: 'unqueue', id: first.id }, { agent: agents[0] })
    check('the tool clears only the caller\'s own reservation', unqueued.changed === true && unqueued.length === 1 && board.service.queueOf('ses_A').head.id === second.id)

    // The mount's own `agent/disposed` listener settles the same service state.
    const running = await board.service.createRequirement({ title: '挂载释放' }, a)
    await board.service.claim(running.id, {}, a)
    const settled = await Promise.all(mounted.dispatch('agent/disposed', { agent: agents[0] }))
    check('the mount\'s dispose listener settles the session through the service', settled.length === 1 && settled[0]?.session === 'ses_A' && settled[0]?.orphaned === 1)
    check('the disposition reached the stored lock', board.domain.table('requirements').get(running.id).lock.orphaned === true)
    await board.close()
  })
}

for (const backend of BACKENDS) {
  await caseReserveWithoutLock(backend, 'a reservation is derived state that takes no lock')
  await caseQueueBound(backend, 'the queue bound is configuration and refuses one past it')
  await caseReservationBlocksClaim(backend, 'a soft reservation refuses another session\'s claim')
  await caseUnqueueFrees(backend, 'unqueue frees the requirement and leaves no empty row')
  await caseQueueUsesClaimTable(backend, 'queue judges through the claim table minus its last row')
  await caseRevivedLeaseRefusesQueuedClaim(backend, 'a revived lease turns a standing reservation into a queued refusal')
  await caseReserveWhileExecuting(backend, 'reserving under a held lock works; a second claim still fails')
  await caseConcurrentReservation(backend, 'two concurrent appends leave exactly one reservation')
  await caseWriteChainOrder(backend, 'a nested write chain fails loud instead of waiting')
  await caseCompletionReleasesReservation(backend, 'completion releases lock and reservation, and hints the head')
  await caseArchiveAndDeleteRelease(backend, 'archiving and deleting end a reservation')
  await caseDisposal(backend, 'a disposed session releases its queue and orphans its lock')
  await casePanelClearsReservation(backend, 'the panel clears any reservation, a session only its own')
  await caseToolAndPromptSurface(backend, 'the tool and the prompt read the queue from one service')
}

process.exit(reporter.finish() ? 0 : 1)
