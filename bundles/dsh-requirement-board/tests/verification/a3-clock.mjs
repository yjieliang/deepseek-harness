#!/usr/bin/env node
/**
 * Flake stress proof for the A3 clock repair: one write chain reads the clock
 * exactly once, and every instant a chain stamps is that one instant.
 *
 * Method: the process replaces `Date` with a strictly advancing fake before the
 * service runs, so a second `nowIso()` inside one write chain cannot return the
 * same value as the first — the old defect (`lock.touchedAt` re-stamped by a
 * later read in the same commit) becomes a 250 ms jump instead of a same-
 * millisecond coincidence. The script counts the no-argument `Date` reads each
 * public action performs and asserts the stamps they produced agree.
 *
 * Usage (from the repository root):
 *   TSX_TSCONFIG_PATH=<repo>/tsconfig.json node --import tsx/esm \
 *     .artifacts/requirement-board/tests/verification/a3-clock.mjs
 *   RB_A3_RED=1 …   # negative control: asserts the pre-fix read count, must FAIL
 *
 * Written by a member other than the implementation's author. One temporary
 * storage root, removed afterwards; no session, no `~/.dsh` write.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoard } from '../harness.mjs'
import { resolveConfig } from '../../host/config.js'
import { RequirementService } from '../../host/service.js'

/** Class under test; `RB_A3_SERVICE=./_red-copy/service.js` runs the mutated copy. */
const SERVICE_PATH = process.env.RB_A3_SERVICE ?? '../../host/service.js'
const UnderTest = SERVICE_PATH === '../../host/service.js'
  ? RequirementService
  : (await import(SERVICE_PATH)).RequirementService

/** When set, the script asserts the pre-fix two-read behaviour so the run must go red. */
const RED = process.env.RB_A3_RED === '1'

/* ------------------------------------------------- the advancing fake clock */

const RealDate = Date
const BASE = RealDate.parse('2026-01-01T00:00:00.000Z')
const STEP_MS = 250
let reads = 0

/** A `Date` whose no-argument construction advances by `STEP_MS` and counts. */
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      reads += 1
      super(BASE + reads * STEP_MS)
      return
    }
    super(...args)
  }

  /** `Date.now()` counts as a read too. */
  static now() {
    reads += 1
    return BASE + reads * STEP_MS
  }
}
globalThis.Date = FakeDate

/** The instant the last counted read produced, without counting another read. */
function instant() {
  return new RealDate(BASE + reads * STEP_MS).toISOString()
}

/** Run one action and report how many clock reads it performed. */
async function counted(run) {
  const before = reads
  const value = await run()
  return { value, reads: reads - before, at: instant() }
}

/* ------------------------------------------------------------ check plumbing */

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

/** A session that resolves to the `art` role, so routing rules behave as usual. */
const ROSTER = [
  { id: 'ses_art', status: 'idle', ctx: { presetId: 'art' } },
  { id: 'ses_red', status: 'idle', ctx: { presetId: 'art' } },
]

/** The agent and preset ports the resolution chain reads. */
function ports() {
  const agents = { get: id => ROSTER.find(agent => agent.id === id), list: () => [...ROSTER] }
  const presets = {
    serviceFor: (agent, key) => (key === 'requirementBoardRole' ? { roleId: 'art', roleName: 'Art', duties: ['美术'] } : undefined),
    composedPreset: target => target?.presetId,
  }
  return { agents: () => agents, presets: () => presets }
}

const dir = await mkdtemp(join(tmpdir(), 'a3-clock-'))
const world = await openBoard({ backend: process.env.RB_A3_BACKEND ?? 'json', dir, config: resolveConfig({}), ports: ports() })
// The service is built here rather than taken from `world.service`, so the same
// assertions can run against the mutated copy under `_red-copy/`.
const service = new UnderTest({ domain: world.domain, config: resolveConfig({}), ports: ports() })
console.log(`service under test: ${SERVICE_PATH}`)
const panel = { session: '', name: '面板' }
const actor = { session: 'ses_art', name: 'A' }

console.log('\n[0] the injected clock is the one the service reads')
{
  const before = reads
  const created = await service.createRequirement({ summary: '测试简述', title: 'Clock probe', sessions: ['ses_art'] }, panel)
  const used = reads - before
  check('creating a requirement reads the clock once', used === 1, String(used))
  check('the creation stamps both fields with that one instant', created.createdAt === created.updatedAt && created.createdAt === instant(), `${created.createdAt} vs ${instant()}`)
  const second = await service.createRequirement({ summary: '测试简述', title: 'Clock probe 2' }, panel)
  check('a later chain gets a later instant, so a second read inside one chain is visible', second.createdAt !== created.createdAt, `${created.createdAt} vs ${second.createdAt}`)
  note(`the fake clock advances ${STEP_MS} ms per counted read, so any intra-chain second read shows up as a jump`)
}

console.log('\n[1] one read per write chain, and the stamps agree')
{
  const task = await service.createRequirement({ summary: '测试简述', title: 'Locked task', sessions: ['ses_art'] }, panel)
  const next = await service.createRequirement({ summary: '测试简述', title: 'Queued task', sessions: ['ses_art'] }, panel)

  const claim = await counted(() => service.claim(task.id, {}, actor))
  check('claim reads the clock once', claim.reads === 1, String(claim.reads))
  check('claim stamps the lock, the record and the history with one instant', claim.value.lock.at === claim.value.lock.touchedAt && claim.value.lock.at === claim.value.updatedAt && claim.value.lock.at === claim.value.history.at(-1).at, JSON.stringify({ lock: claim.value.lock, updatedAt: claim.value.updatedAt, history: claim.value.history.at(-1).at }))
  check('the claimed instant is the one the chain read', claim.value.lock.at === claim.at, `${claim.value.lock.at} vs ${claim.at}`)

  const renew = await counted(() => service.claim(task.id, {}, actor))
  check(
    'a repeated claim reads once and moves only the touch instant',
    renew.reads === 1 && renew.value.lock.touchedAt === renew.value.updatedAt && renew.value.lock.at === claim.value.lock.at,
    JSON.stringify({ reads: renew.reads, lock: renew.value.lock, updatedAt: renew.value.updatedAt }),
  )
  check('the renewal instant is later than the first, so the lease really moves', renew.value.lock.touchedAt > claim.value.lock.touchedAt, `${claim.value.lock.touchedAt} -> ${renew.value.lock.touchedAt}`)
  note('`lock.at` is the take instant and survives a renewal by design; `touchedAt` and `updatedAt` are the renewal chain\'s one instant')

  const update = await counted(() => service.updateRequirement(task.id, { title: 'Renamed' }, actor))
  check('update reads the clock once', update.reads === 1, String(update.reads))
  check('update stamps the record and refreshes the lease with that instant', update.value.updatedAt === update.at && update.value.lock.touchedAt === update.at, JSON.stringify({ updatedAt: update.value.updatedAt, touchedAt: update.value.lock.touchedAt, at: update.at }))

  const queued = await counted(() => service.queue(next.id, {}, actor))
  check('queue reads the clock once', queued.reads === 1, String(queued.reads))
  check('the queue item and the row carry one instant', queued.value.items[0].at === queued.value.updatedAt && queued.value.updatedAt === queued.at, JSON.stringify({ item: queued.value.items[0].at, row: queued.value.updatedAt, at: queued.at }))

  const again = await counted(() => service.queue(next.id, {}, actor))
  check('an idempotent append reads nothing', again.reads === 0 && again.value.changed === false, JSON.stringify({ reads: again.reads, changed: again.value.changed }))

  const checklist = await counted(() => service.setChecklist(task.id, { index: 0, checked: true }, actor))
  check('checklist reads the clock once', checklist.reads === 1, String(checklist.reads))
  check('checklist stamps the record with that instant', checklist.value.updatedAt === checklist.at, `${checklist.value.updatedAt} vs ${checklist.at}`)

  const blocked = await counted(() => service.blockRequirement(task.id, { reason: 'waiting' }, actor))
  check('block reads the clock once', blocked.reads === 1, String(blocked.reads))
  check('block stamps the record, the block instant and the history with one instant', blocked.value.updatedAt === blocked.value.blockedAt && blocked.value.updatedAt === blocked.value.history.at(-1).at && blocked.value.updatedAt === blocked.at, JSON.stringify({ updatedAt: blocked.value.updatedAt, blockedAt: blocked.value.blockedAt, history: blocked.value.history.at(-1).at }))

  const unblocked = await counted(() => service.unblockRequirement(task.id, {}, actor))
  check('unblock reads the clock once and stamps one instant', unblocked.reads === 1 && unblocked.value.updatedAt === unblocked.value.history.at(-1).at && unblocked.value.updatedAt === unblocked.at, JSON.stringify({ reads: unblocked.reads, updatedAt: unblocked.value.updatedAt, at: unblocked.at }))

  const transition = await counted(() => service.transitionRequirement(task.id, { action: 'complete' }, actor))
  check('a transition reads the clock once and stamps one instant', transition.reads === 1 && transition.value.updatedAt === transition.value.history.at(-1).at && transition.value.updatedAt === transition.at, JSON.stringify({ reads: transition.reads, updatedAt: transition.value.updatedAt, history: transition.value.history.at(-1).at, at: transition.at }))
  check('completing released the lock in that same commit', transition.value.lock === null && transition.value.status === 'done', JSON.stringify({ lock: transition.value.lock, status: transition.value.status }))

  const reopen = await counted(() => service.transitionRequirement(task.id, { action: 'reopen' }, panel))
  check('the panel reopen reads the clock once and stamps one instant', reopen.reads === 1 && reopen.value.updatedAt === reopen.value.history.at(-1).at && reopen.value.updatedAt === reopen.at, JSON.stringify({ reads: reopen.reads, updatedAt: reopen.value.updatedAt, at: reopen.at }))

  const archive = await counted(() => service.setArchived(task.id, { archived: true }, panel))
  check('archive reads the clock once and stamps one instant', archive.reads === 1 && archive.value.updatedAt === archive.value.history.at(-1).at && archive.value.updatedAt === archive.at, JSON.stringify({ reads: archive.reads, updatedAt: archive.value.updatedAt, at: archive.at }))
  const restore = await counted(() => service.setArchived(task.id, { archived: false }, panel))
  check('restore reads the clock once and stamps one instant', restore.reads === 1 && restore.value.updatedAt === restore.at, JSON.stringify({ reads: restore.reads, updatedAt: restore.value.updatedAt, at: restore.at }))

  const release = await counted(() => service.release(task.id, {}, panel))
  check('releasing a lock nobody holds reads nothing', release.reads === 0, String(release.reads))

  /* The completion-plus-reservation path is two writes (the transition, then the
   * reservation cleanup), so it may read once per write — but the requirement's
   * own stamps must still come from the transition's single instant. */
  await service.claim(next.id, {}, actor)
  const queuedTwo = await service.createRequirement({ summary: '测试简述', title: 'Reserved by A', sessions: ['ses_art'] }, panel)
  await service.queue(queuedTwo.id, {}, actor)
  const completing = await counted(() => service.transitionRequirement(next.id, { action: 'complete' }, actor))
  check('completing a requirement with a live reservation reads once per write, not once per stamp', completing.reads === 2, String(completing.reads))
  check('the requirement stamps still come from one instant while the queue row comes from its own write', completing.value.updatedAt === completing.value.history.at(-1).at, JSON.stringify({ updatedAt: completing.value.updatedAt, history: completing.value.history.at(-1).at }))
  note('the second read belongs to the separate queue-row write that releases the finished requirement\'s reservation; the requirement record is untouched by it')

  const dispose = await counted(() => service.disposeSession('ses_art'))
  check('disposing a session reads the clock once', dispose.reads === 1, String(dispose.reads))

  /* A3 measured `delete` as zero clock reads because it stamped nothing; from D on
   * it writes the unbound-reference history itself, so it must read. What is kept
   * here is the invariant A3 really guards — one write chain reads the clock
   * exactly once and every write in that chain shares the instant it read
   * (`host/service.js`:2476-2511 reads `at` once and hands it to `#unbindLinks`,
   * whose per-record writes reuse it, `:2526-2548`). The richer case below unbound
   * two records inside that one chain and compares their history instants, so a
   * second intra-chain read would show up as a jump between them. */
  const removed = await counted(() => service.deleteRequirement(queuedTwo.id, {}, panel))
  check(
    'deleting a record with nothing to unbind still reads the clock once for its own finishing chain',
    removed.reads === 1 && removed.value.deleted === true && removed.value.unbound.length === 0,
    JSON.stringify({ reads: removed.reads, unbound: removed.value.unbound }),
  )

  const pinned = await service.createRequirement({ summary: '测试简述', title: 'Gate target', sessions: ['ses_art'] }, panel)
  const gateLeft = await service.createRequirement({ summary: '测试简述', title: 'Gate A', sessions: ['ses_art'] }, panel)
  const gateRight = await service.createRequirement({ summary: '测试简述', title: 'Gate B', sessions: ['ses_art'] }, panel)
  const gatedAt = instant()
  for (const gate of [gateLeft, gateRight]) {
    const record = world.domain.table('requirements').get(gate.id)
    await world.domain.table('requirements').put(gate.id, { ...record, blocksOn: [pinned.id], rev: (record.rev ?? 0) + 1, updatedAt: gatedAt })
  }
  const multi = await counted(() => service.deleteRequirement(pinned.id, {}, panel))
  check(
    'delete unbound both gate links, so its one chain did more than one write',
    multi.reads === 1 && (multi.value.unbound ?? []).length === 2 && multi.value.unbound.includes(gateLeft.id) && multi.value.unbound.includes(gateRight.id),
    JSON.stringify({ reads: multi.reads, unbound: multi.value.unbound }),
  )
  const unboundStamps = [gateLeft.id, gateRight.id].map(id => world.domain.table('requirements').get(id)?.history?.at(-1)?.at)
  check(
    'the two unbound writes share the one instant that chain read, so no chain reads twice',
    unboundStamps[0] !== undefined && unboundStamps[0] === unboundStamps[1],
    JSON.stringify(unboundStamps),
  )
}

console.log('\n[2] the whole record agrees after a claim (the old flake shape)')
{
  const task = await service.createRequirement({ summary: '测试简述', title: 'Flake probe', sessions: ['ses_art'] }, panel)
  const claimed = await service.claim(task.id, {}, actor)
  const stored = world.domain.table('requirements').get(task.id)
  const timestamps = [stored.createdAt, stored.updatedAt, stored.lock.at, stored.lock.touchedAt, ...stored.history.map(entry => entry.at)]
  const later = timestamps.filter(stamp => stamp > stored.lock.at)
  check('no stamp on the record is later than the lock instant it was claimed at', later.length === 0, JSON.stringify(later))
  check('the claim instant is at or after the creation instant', stored.lock.at >= stored.createdAt, `${stored.createdAt} -> ${stored.lock.at}`)
  note(`stored chain: created ${stored.createdAt}, claimed ${stored.lock.at}, touched ${stored.lock.touchedAt}, updated ${stored.updatedAt}`)
  void claimed
}

if (RED) {
  console.log('\n[3] RED CONTROL: the pre-fix behaviour asserts two reads in one chain')
  const redActor = { session: 'ses_red', name: 'R' }
  const task = await service.createRequirement({ summary: '测试简述', title: 'Red probe', sessions: ['ses_red'] }, panel)
  const red = await counted(() => service.claim(task.id, {}, redActor))
  check('RED CONTROL: claim reads the clock twice (pre-fix behaviour)', red.reads === 2, String(red.reads))
  check('RED CONTROL: the second read moved touchedAt past lock.at (pre-fix behaviour)', red.value.lock.touchedAt > red.value.lock.at, JSON.stringify(red.value.lock))
}

await world.close()
await rm(dir, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed on the ${process.env.RB_A3_BACKEND ?? 'json'} backend${RED ? ' (RED CONTROL run)' : ''}`)
process.exit(failures === 0 ? 0 : 1)
