#!/usr/bin/env node
/**
 * Independent verification of `ROLE-DISPATCH.md` §9-A3 ("A3 lock and decision
 * table" queueing half: soft reservations, `complete` auto-release, and the two
 * `claimable` readings), written by a member other than the implementation's
 * author.
 *
 * What this script is: the real `RequirementService` over the real storage domain
 * (`tests/harness.mjs` opens it exactly the way the plugin does), the real HTTP
 * route handler (`host/http.js` `createBoardHandler`) driven with a synthetic
 * `GET /snapshot` request, and the real `claimable()` formula imported from
 * `host/dispatch.js` and applied by this script to the raw stored records.
 * Nothing is asserted from the author's suites; every expectation is computed
 * here from a public surface (the route response, the stored records, the
 * `domain/changed` frames, and the queue receipts).
 *
 * Usage (from the repository root):
 *   TSX_TSCONFIG_PATH=<repo>/tsconfig.json node --import tsx/esm \
 *     .artifacts/requirement-board/tests/verification/a3-chain.mjs
 *   RB_A3_RED=1 …   # negative control: asserts the pre-fix behaviour, must FAIL
 *
 * Every world uses a temporary storage root that this script removes again; no
 * session is created and nothing outside those directories is written.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoard } from '../harness.mjs'
import { createBoardHandler, dispatchBoardCommand } from '../../host/http.js'
import { claimable, lockState } from '../../host/dispatch.js'
import { resolveConfig } from '../../host/config.js'

/** When set, the script asserts the pre-fix behaviour so the run must go red. */
const RED = process.env.RB_A3_RED === '1'

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

/** Assert that a call fails with one code and (optionally) one structured reason. */
async function expectFail(label, code, run, reason) {
  try {
    await run()
    check(label, false, `expected ${code}, nothing was thrown`)
  } catch (error) {
    const actual = `${error?.code ?? 'no-code'}/${error?.details?.reason ?? 'no-reason'}`
    check(label, error?.code === code && (reason === undefined || error?.details?.reason === reason), actual)
  }
}

/** Sorted id list, so two set-shaped answers compare as one string. */
function set(ids) {
  return [...ids].sort().join(',')
}

/* ------------------------------------------------------------------ harness */

/** The declaration the session `ses_art` resolves to. */
const DECLARATION = { roleId: 'art', roleName: 'Art Director', duties: ['美术与音频资产规范'] }

/** Sessions the board can resolve a role for. */
const ROSTER = [
  { id: 'ses_art', status: 'idle', ctx: { presetId: 'art' } },
  { id: 'ses_eng', status: 'idle', ctx: { presetId: 'eng' } },
  { id: 'ses_other', status: 'idle', ctx: { presetId: 'eng' } },
]

/** The agent and preset ports the resolution chain reads, as resolver functions. */
function ports() {
  const agents = { get: id => ROSTER.find(agent => agent.id === id), list: () => [...ROSTER] }
  const presets = {
    serviceFor(agent, key) {
      if (key !== 'requirementBoardRole') return undefined
      return agent?.ctx?.presetId === 'art' ? DECLARATION : undefined
    },
    composedPreset(target) {
      return typeof target?.presetId === 'string' ? target.presetId : undefined
    },
  }
  return { agents: () => agents, presets: () => presets }
}

/** Open one board on a fresh temporary root. */
async function openWorld({ backend = process.env.RB_A3_BACKEND ?? 'json', config } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'a3-verify-'))
  const world = await openBoard({ backend, dir, config: config ?? resolveConfig({}), ports: ports() })
  return { ...world, dir, backend }
}

/** Close one world and remove its root. */
async function closeWorld(world) {
  await world.close()
  await rm(world.dir, { recursive: true, force: true })
}

/* ------------------------------------------------------------ route helpers */

/** A minimal `GET` request for the board route. */
function fakeGet(url) {
  return { method: 'GET', url, headers: {} }
}

/** A minimal `POST /command` request for the board route. */
function fakePost(body) {
  const text = JSON.stringify(body)
  return {
    method: 'POST',
    url: '/api/requirement-board/command',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf8')
    },
  }
}

/** A response object capturing status and body. */
function fakeResponse() {
  const state = { status: 0, body: '' }
  return {
    state,
    res: {
      writeHead(status) {
        state.status = status
      },
      end(chunk) {
        state.body = chunk === undefined ? '' : String(chunk)
      },
    },
  }
}

/** Drive the real route handler once and parse its JSON body. */
async function route(service, req) {
  const { state, res } = fakeResponse()
  await createBoardHandler(service)(req, res)
  return { status: state.status, body: state.body === '' ? null : JSON.parse(state.body) }
}

/** `GET /api/requirement-board/snapshot` with a raw query string. */
async function snapshot(service, queryString = '') {
  return await route(service, fakeGet(`/api/requirement-board/snapshot${queryString}`))
}

/** The requirement ids one snapshot answer carries. */
function snapshotIds(answer) {
  return (answer.body?.data?.requirements ?? []).map(requirement => requirement.id)
}

/** Run one call and hand back the error it threw, if any. */
async function capture(run) {
  try {
    await run()
    return null
  } catch (error) {
    return error
  }
}

/** The requirement ids listed under the prompt's `Claimable for you` header. */
function claimableSection(text) {
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex(line => line.startsWith('Claimable for you'))
  if (start < 0) return []
  const ids = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break
    const id = line.slice(2).split(' ')[0]
    if (id === '…') break
    ids.push(id)
  }
  return ids
}

/** The `domain/changed` frames one table received since a marker. */
function framesSince(world, marker, table) {
  return world.changes.slice(marker).filter(change => table === undefined || change.table === table)
}

/** The raw stored requirement record. */
function rawRequirement(world, id) {
  return world.domain.table('requirements').get(id)
}

/** The id -> reserving session join, computed here rather than read from a receipt. */
function reservations(world) {
  const map = new Map()
  for (const [session, row] of world.domain.table('queues').entries()) {
    for (const item of row.items) map.set(item.id, session)
  }
  return map
}

/** The pool this script computes from the raw records with the exported formula. */
function expectedPool(world, me, myRole) {
  const reserved = reservations(world)
  const pool = []
  for (const [id, record] of world.domain.table('requirements').entries()) {
    if (claimable(record, me, myRole, { reservedBy: reserved.get(id) ?? null })) pool.push(id)
  }
  return pool
}

/* -------------------------------------------------------- [1] query params */

const world1 = await openWorld()
try {
  const { service } = world1
  const panel = { session: '', name: '面板' }

  await service.createTemplate({ id: 'tpl-one', name: 'One node', nodes: [{ id: 'only', name: 'Only' }] }, panel)
  const rA = await service.createRequirement({ title: 'Alpha 美术', owner: 'ann', priority: 'high', sessions: ['ses_A'] }, panel)
  const rB = await service.createRequirement({ title: 'Beta 引擎', owner: 'bob', priority: 'low', sessions: ['ses_B'] }, panel)
  const rC = await service.createRequirement({ title: 'Gamma 美术', owner: 'bob', priority: 'urgent', sessions: ['ses_A', 'ses_B'] }, panel)
  const rD = await service.createRequirement({ title: 'Delta 评审', owner: 'ann', priority: 'normal', sessions: ['ses_A'], templateId: 'tpl-one' }, panel)
  const rE = await service.createRequirement({ title: 'Epsilon 角色任务', owner: 'ann', priority: 'normal', sessions: ['ses_A'], role: 'art' }, panel)
  await service.transitionRequirement(rC.id, { action: 'complete' }, panel)

  const all = [rA.id, rB.id, rC.id, rD.id, rE.id]
  const pool = [rA.id, rB.id, rD.id, rE.id]

  console.log('\n[1] the nine query parameters through the real route handler')
  const table = [
    ['owner', 'owner=ann', [rA.id, rD.id, rE.id]],
    ['owner (value that names nobody)', 'owner=nobody', []],
    ['status=done', 'status=done', [rC.id]],
    ['status=open', 'status=open', [rA.id, rB.id, rD.id, rE.id]],
    ['priority', 'priority=high', [rA.id]],
    ['priority (other value)', 'priority=low', [rB.id]],
    ['templateId', 'templateId=tpl-one', [rD.id]],
    ['templateId (other value)', 'templateId=tpl-standard', [rA.id, rB.id, rC.id, rE.id]],
    ['query', 'query=%E7%BE%8E%E6%9C%AF', [rA.id, rC.id]],
    ['query (no match)', 'query=zzz-no-such-word', []],
    ['session', 'session=ses_B', [rB.id, rC.id]],
    ['session (no member)', 'session=ses_nobody', []],
    ['me without claimable does not filter', 'me=ses_A', all],
    ['claimable=false does not filter', 'claimable=false', all],
    ['claimable=true (panel pool)', 'claimable=true', pool],
    ['claimable=true&me=ses_eng', 'claimable=true&me=ses_eng', [rA.id, rB.id, rD.id]],
    ['claimable=true&me=ses_art', 'claimable=true&me=ses_art', pool],
  ]
  for (const [label, queryString, expected] of table) {
    const answer = await snapshot(service, `?${queryString}`)
    check(`${label} changes the result set`, set(snapshotIds(answer)) === set(expected), `got ${set(snapshotIds(answer))}`)
  }
  // RED CONTROL: the pre-fix dispatcher read its parameters off a URLSearchParams
  // object, so every parameter was undefined and no filter applied. Asserting
  // that behaviour here must fail on the current build.
  if (RED) {
    const unfiltered = await snapshot(service, '?owner=nobody')
    check('RED CONTROL: a filter is ignored (pre-fix behaviour)', snapshotIds(unfiltered).length === all.length, `got ${snapshotIds(unfiltered).length} of ${all.length}`)
    const claimableIgnored = await snapshot(service, '?claimable=true&me=ses_eng')
    check('RED CONTROL: claimable is ignored for a session (pre-fix behaviour)', set(snapshotIds(claimableIgnored)) === set(all), `got ${set(snapshotIds(claimableIgnored))}`)
  }
  const bogusStatus = await snapshot(service, '?status=not-a-status')
  check('an out-of-enum filter fails loud instead of being ignored', bogusStatus.status === 409 && bogusStatus.body?.error?.code === 'invalid-argument', JSON.stringify({ status: bogusStatus.status, error: bogusStatus.body?.error?.code }))
  const bogusBoolean = await snapshot(service, '?claimable=1')
  check('a non-boolean claimable fails loud instead of reading as false', bogusBoolean.status === 409 && bogusBoolean.body?.error?.code === 'invalid-argument', JSON.stringify({ status: bogusBoolean.status, error: bogusBoolean.body?.error?.code }))

  const limited = await snapshot(service, '?limit=2')
  check('limit caps the page and reports the filtered total', (limited.body?.data?.requirements ?? []).length === 2 && limited.body?.data?.total === all.length, JSON.stringify({ n: limited.body?.data?.requirements?.length, total: limited.body?.data?.total }))
  const first = await snapshot(service, '?limit=2')
  const second = await snapshot(service, '?limit=2&offset=2')
  const firstIds = snapshotIds(first)
  const secondIds = snapshotIds(second)
  check('offset moves the page without changing the total', firstIds.length === 2 && secondIds.length === 2 && secondIds.every(id => !firstIds.includes(id)) && second.body?.data?.total === first.body?.data?.total, JSON.stringify({ first: firstIds, second: secondIds }))
  const commandView = await dispatchBoardCommand(service, { action: 'refresh', filter: { claimable: true }, me: 'ses_eng' })
  check('the command dispatcher agrees with the route handler', set(commandView.requirements.map(requirement => requirement.id)) === set([rA.id, rB.id, rD.id]), set(commandView.requirements.map(requirement => requirement.id)))

  /* ------------------------------------------------- [2] claimable two modes */

  console.log('\n[2] the two claimable readings, against the raw records')
  // Perturb one requirement per exclusion class.
  await service.claim(rB.id, {}, { session: 'ses_other', name: 'other' })
  await service.queue(rA.id, {}, { session: 'ses_other', name: 'other' })
  await service.setArchived(rD.id, { archived: true }, panel)

  const myRoleEng = 'eng'
  const myRoleArt = 'art'
  const panelView = await snapshot(service, '?claimable=true')
  const engView = await snapshot(service, '?claimable=true&me=ses_eng')
  const artView = await snapshot(service, '?claimable=true&me=ses_art')
  const computedPanel = expectedPool(world1, '', '')
  const computedEng = expectedPool(world1, 'ses_eng', myRoleEng)
  const computedArt = expectedPool(world1, 'ses_art', myRoleArt)
  check('the panel pool equals the formula applied to the stored records', set(snapshotIds(panelView)) === set(computedPanel), `route ${set(snapshotIds(panelView))} vs formula ${set(computedPanel)}`)
  check('a session without the role does not see the routed requirement', set(snapshotIds(engView)) === set(computedEng) && !snapshotIds(engView).includes(rE.id), `route ${set(snapshotIds(engView))}`)
  check('the session holding the role sees the routed requirement', set(snapshotIds(artView)) === set(computedArt) && snapshotIds(artView).includes(rE.id), `route ${set(snapshotIds(artView))}`)
  check('the panel pool contains the unlocked role-routed requirement', snapshotIds(panelView).includes(rE.id), set(snapshotIds(panelView)))
  check('the same requirement is invisible to the other role but visible to its own', !snapshotIds(engView).includes(rE.id) && snapshotIds(artView).includes(rE.id), 'contrast holds')
  const excluded = [rA.id, rB.id, rC.id, rD.id]
  check('a reservation by another session is outside every pool', excluded.every(id => !snapshotIds(computedPanel).includes(id) && !snapshotIds(computedEng).includes(id) && !snapshotIds(computedArt).includes(id)), JSON.stringify({ panel: computedPanel, eng: computedEng, art: computedArt }))
  check('the raw record of the reserved requirement carries no lock', rawRequirement(world1, rA.id).lock === null, JSON.stringify(rawRequirement(world1, rA.id).lock))
  check('the archived, done and locked records are all outside the pool', [rA.id, rB.id, rC.id, rD.id].every(id => !computedPanel.includes(id)), JSON.stringify(computedPanel))

  const promptEng = service.promptContext('ses_eng', 20)
  const promptArt = service.promptContext('ses_art', 20)
  check('the eng prompt offers no requirement it cannot take', claimableSection(promptEng).length === 0, JSON.stringify(claimableSection(promptEng)))
  check('the eng prompt does not offer the routed requirement', claimableSection(promptEng).includes(rE.id) === false, JSON.stringify(claimableSection(promptEng)))
  check('the art prompt offers the routed requirement and nothing else claimable', set(claimableSection(promptArt)) === set([rE.id]), JSON.stringify(claimableSection(promptArt)))
  check('the prompt section agrees with the route and the formula', set(claimableSection(promptArt)) === set(computedArt) && set(claimableSection(promptEng)) === set(computedEng), `prompt ${set(claimableSection(promptEng))} vs formula ${set(computedEng)}`)
  check('the panel prompt has no session claimable section', service.promptContext('', 20).includes('Claimable for you') === false, 'panel prompt')

  /* ----------------------------------------------------- [4] complete release */

  console.log('\n[3] complete releases the lock and ends its own reservation')
  const one = await service.createRequirement({ title: 'One node task', sessions: ['ses_A'] }, panel)
  const next = await service.createRequirement({ title: 'Next task', sessions: ['ses_A'] }, panel)
  const held = await service.claim(one.id, {}, { session: 'ses_A', name: 'A' })
  check('claim installs the lock with one instant', held.lock?.at === held.lock?.touchedAt && held.lock?.at === held.updatedAt, JSON.stringify(held.lock))
  await expectFail('a session already executing something else cannot claim another', 'conflict', () => service.claim(next.id, {}, { session: 'ses_A', name: 'A' }), 'session-busy')
  await service.queue(next.id, {}, { session: 'ses_A', name: 'A' })
  const beforeComplete = rawRequirement(world1, next.id)
  const finished = await service.transitionRequirement(one.id, { action: 'complete' }, { session: 'ses_A', name: 'A' })
  const doneRecord = rawRequirement(world1, one.id)
  check('completing finishes the requirement', finished.status === 'done' && doneRecord.status === 'done', JSON.stringify({ presented: finished.status, stored: doneRecord.status }))
  check('completion removed the lock in the same record', doneRecord.lock === null && finished.lock === null, JSON.stringify(finished.lock))
  check('the completion receipt names the queue head without taking it', finished.queueHead?.id === next.id && rawRequirement(world1, next.id).lock === null, JSON.stringify(finished.queueHead))
  check('the finished requirement released its own reservation only', finished.reservedBy === null && rawRequirement(world1, next.id).reservedBy === undefined && reservations(world1).get(next.id) === 'ses_A', JSON.stringify([...reservations(world1)]))
  check('the other requirement was not touched by the completion', JSON.stringify(rawRequirement(world1, next.id)) === JSON.stringify(beforeComplete), 'record bytes changed')
  check('completion wrote no separate release history entry', doneRecord.history.map(entry => entry.action).join(',') === 'create,claim,complete', doneRecord.history.map(entry => entry.action).join(','))
  await expectFail('a finished requirement can no longer be claimed', 'invalid-state', () => service.claim(one.id, {}, { session: 'ses_other', name: 'other' }))
  await expectFail('reopening needs the lock like any other transition', 'forbidden', () => service.transitionRequirement(one.id, { action: 'reopen' }, { session: 'ses_A', name: 'A' }), 'lock-required')
  const revBeforeRelease = rawRequirement(world1, one.id).rev
  await service.release(one.id, { note: 'nothing to release' }, panel)
  check('releasing a lock nobody holds writes nothing', rawRequirement(world1, one.id).rev === revBeforeRelease, String(rawRequirement(world1, one.id).rev))
  const reopened = await service.transitionRequirement(one.id, { action: 'reopen' }, panel)
  check('the panel reopens a finished requirement', reopened.status === 'active' && rawRequirement(world1, one.id).lock === null, reopened.status)
  await service.claim(one.id, {}, { session: 'ses_A', name: 'A' })
  const completedAgain = await service.transitionRequirement(one.id, { action: 'complete' }, { session: 'ses_A', name: 'A' })
  check('claim then complete again is the same result, not a second lock', completedAgain.status === 'done' && rawRequirement(world1, one.id).lock === null, JSON.stringify(completedAgain.lock))
  await expectFail('completing an already-done requirement is refused', 'invalid-transition', () => service.transitionRequirement(one.id, { action: 'complete' }, panel))

  console.log('\n[3b] archive and delete keep their own reservation semantics')
  const archivable = await service.createRequirement({ title: 'Archive me', sessions: [] }, panel)
  await service.queue(archivable.id, {}, { session: 'ses_other', name: 'other' })
  const archived = await service.setArchived(archivable.id, { archived: true }, panel)
  check('archiving releases the reservation on that requirement', archived.status === 'archived' && reservations(world1).get(archivable.id) === undefined, JSON.stringify([...reservations(world1)]))
  const deletable = await service.createRequirement({ title: 'Delete me', sessions: [] }, panel)
  await service.queue(deletable.id, {}, { session: 'ses_other', name: 'other' })
  const deleted = await service.deleteRequirement(deletable.id, {}, panel)
  check('deleting releases the reservation and removes the record', deleted.deleted === true && rawRequirement(world1, deletable.id) === undefined && reservations(world1).get(deletable.id) === undefined, JSON.stringify(deleted))
  check('a done requirement still takes the archive action', (await service.setArchived(one.id, { archived: true }, panel)).status === 'archived', 'archive over done')
} finally {
  await closeWorld(world1)
}

/* ------------------------------------------------------------ [4] the queue */

console.log('\n[4] the queue is a soft reservation')
const world2 = await openWorld({ config: resolveConfig({ maxQueueItems: 5 }) })
try {
  const { service } = world2
  const panel = { session: '', name: '面板' }
  const queued = []
  for (let index = 1; index <= 6; index += 1) {
    queued.push(await service.createRequirement({ title: `Queue ${index}`, priority: 'low' }, panel))
  }
  /** Frames from here on belong to the queue section, never to the creations. */
  const queueMarker = world2.changes.length

  let marker = world2.changes.length
  const first = await service.queue(queued[0].id, {}, { session: 'ses_art', name: 'A' })
  check('the first append reserves the requirement', first.changed === true && first.length === 1 && first.items[0].id === queued[0].id, JSON.stringify(first))
  const appendFrames = framesSince(world2, marker)
  check('the append committed the item into a queue row', appendFrames.some(change => change.table === 'queues' && (change.value?.items ?? []).some(item => item.id === queued[0].id)), JSON.stringify(appendFrames.map(change => change.table)))
  check('the append wrote no requirement row', appendFrames.every(change => change.table !== 'requirements'), JSON.stringify(appendFrames.map(change => change.table)))
  note(`one append produced ${appendFrames.length} frames: ${appendFrames.map(change => `${change.table === '' ? '(global)' : change.table}/${change.operation}`).join(', ')}`)
  marker = world2.changes.length
  const again = await service.queue(queued[0].id, {}, { session: 'ses_art', name: 'A' })
  check('appending twice is idempotent', again.changed === false && again.length === 1, JSON.stringify(again))
  check('the idempotent append wrote nothing at all', framesSince(world2, marker).length === 0, JSON.stringify(framesSince(world2, marker)))

  const recordBefore = JSON.stringify(rawRequirement(world2, queued[1].id))
  for (const requirement of queued.slice(1, 5)) await service.queue(requirement.id, {}, { session: 'ses_art', name: 'A' })
  const row = service.queueOf('ses_art')
  check('the queue holds exactly the reserved items', row.length === 5 && row.items.map(item => item.id).join(',') === queued.slice(0, 5).map(requirement => requirement.id).join(','), JSON.stringify(row.items.map(item => item.id)))
  check('reserving wrote no requirement record', recordBefore === JSON.stringify(rawRequirement(world2, queued[1].id)), 'record bytes changed')
  check('a reserved requirement carries no lock', rawRequirement(world2, queued[1].id).lock === null, JSON.stringify(rawRequirement(world2, queued[1].id).lock))
  check('the reserved requirement reports the reserving session', (await service.getRequirement(queued[1].id)).reservedBy === 'ses_art', String((await service.getRequirement(queued[1].id)).reservedBy))
  const requirementFrames = framesSince(world2, queueMarker, 'requirements')
  check('no queue action anywhere wrote a requirement row', requirementFrames.length === 0, JSON.stringify(requirementFrames.map(change => change.key)))
  await expectFail('the queue refuses past its configured bound', 'invalid-input', () => service.queue(queued[5].id, {}, { session: 'ses_art', name: 'A' }), 'queue-full')
  await expectFail('another session cannot claim a reserved requirement', 'conflict', () => service.claim(queued[1].id, {}, { session: 'ses_other', name: 'other' }), 'reserved')
  await expectFail('the panel cannot reserve work for a session', 'invalid-argument', () => service.queue(queued[5].id, {}, panel), 'session-required')

  const afterUnqueue = await service.unqueue(queued[1].id, {}, { session: 'ses_art', name: 'A' })
  check('unqueue drops the reservation', afterUnqueue.changed === true && afterUnqueue.items.every(item => item.id !== queued[1].id), JSON.stringify(afterUnqueue.items.map(item => item.id)))
  const claimed = await service.claim(queued[1].id, {}, { session: 'ses_other', name: 'other' })
  check('the requirement another session unreserved becomes claimable', claimed.lock?.session === 'ses_other', JSON.stringify(claimed.lock?.session))

  await expectFail('a session cannot clear another session\'s reservation', 'forbidden', () => service.unqueue(queued[2].id, { targetSession: 'ses_art' }, { session: 'ses_other', name: 'other' }), 'panel-only')
  const cleared = await service.unqueue(queued[2].id, { targetSession: 'ses_art' }, panel)
  check('the panel clears any session\'s reservation', cleared.changed === true && cleared.items.every(item => item.id !== queued[2].id), JSON.stringify(cleared.items.map(item => item.id)))
  check('clearing what is not reserved writes nothing and succeeds', (await service.unqueue(queued[5].id, {}, { session: 'ses_art', name: 'A' })).changed === false, 'changed')

  const disposed = await service.disposeSession('ses_art')
  check('disposing a session drops its queue row', disposed.releasedQueueItems === 3 && service.queueOf('ses_art').updatedAt === null, JSON.stringify(disposed))
  check('its reservations are released with the row', reservations(world2).size === 0 && (await service.getRequirement(queued[3].id)).reservedBy === null, JSON.stringify([...reservations(world2)]))
} finally {
  await closeWorld(world2)
}

console.log('\n[4b] two sessions queueing one requirement: exactly one reservation')
const world3 = await openWorld()
try {
  const { service } = world3
  const target = await service.createRequirement({ title: 'Contested', priority: 'low' }, { session: '', name: '面板' })
  const settled = await Promise.allSettled([
    service.queue(target.id, {}, { session: 'ses_art', name: 'A' }),
    service.queue(target.id, {}, { session: 'ses_eng', name: 'E' }),
  ])
  const winners = settled.filter(outcome => outcome.status === 'fulfilled')
  const losers = settled.filter(outcome => outcome.status === 'rejected')
  check('exactly one queue call wins', winners.length === 1 && losers.length === 1, JSON.stringify(settled.map(outcome => outcome.status)))
  check('the loser is refused as reserved', losers[0]?.reason?.code === 'conflict' && losers[0]?.reason?.details?.reason === 'reserved', `${losers[0]?.reason?.code}/${losers[0]?.reason?.details?.reason}`)
  const holders = [...reservations(world3).entries()].filter(([, session]) => session !== undefined)
  check('exactly one row names the requirement', reservations(world3).size === 1 && holders.length === 1, JSON.stringify([...reservations(world3)]))
  check('the winning row reports one item', service.queueOf(holders[0][1]).length === 1, JSON.stringify(service.queueOf(holders[0][1])))
} finally {
  await closeWorld(world3)
}

/* ------------------------------ [5] the queue-head and queued hints, reachability */

console.log('\n[5] the queue-head hint and the queued flag: which paths can reach them')
{
  const panel = { session: '', name: '面板' }
  // Reachable: a session that holds a lock and names its own next item gets the
  // head in the refusal, so it can go straight to the queue.
  const world4 = await openWorld()
  try {
    const held = await world4.service.createRequirement({ title: 'Executing' }, panel)
    const head = await world4.service.createRequirement({ title: 'Queue head' }, panel)
    await world4.service.claim(held.id, {}, { session: 'ses_art', name: 'A' })
    await world4.service.queue(head.id, {}, { session: 'ses_art', name: 'A' })
    const busy = await capture(() => world4.service.claim(head.id, {}, { session: 'ses_art', name: 'A' }))
    check('claiming out of turn is refused as session-busy', busy?.code === 'conflict' && busy?.details?.reason === 'session-busy', `${busy?.code}/${busy?.details?.reason}`)
    check('the session-busy refusal names the caller\'s own queue head', busy?.details?.queueHead?.id === head.id, JSON.stringify(busy?.details?.queueHead))
  } finally {
    await closeWorld(world4)
  }

  // Ordering one: the reservation exists first, so nobody else can lock it.
  const world5 = await openWorld()
  try {
    const target = await world5.service.createRequirement({ title: 'Reserved first' }, panel)
    await world5.service.queue(target.id, {}, { session: 'ses_art', name: 'A' })
    const other = await capture(() => world5.service.claim(target.id, {}, { session: 'ses_eng', name: 'E' }))
    check('a reservation blocks the other session before the lock is ever consulted', other?.details?.reason === 'reserved', `${other?.code}/${other?.details?.reason}`)
  } finally {
    await closeWorld(world5)
  }

  // Ordering two: the lock exists first, so the queueing session is refused with
  // the lock branch and the `queued` flag reads false, because its own queue does
  // not name the requirement yet.
  const world6 = await openWorld()
  try {
    const target = await world6.service.createRequirement({ title: 'Locked first' }, panel)
    await world6.service.claim(target.id, {}, { session: 'ses_eng', name: 'E' })
    const late = await capture(() => world6.service.queue(target.id, {}, { session: 'ses_art', name: 'A' }))
    check('a locked requirement cannot be queued either', late?.code === 'conflict' && late?.details?.reason === 'locked', `${late?.code}/${late?.details?.reason}`)
    check('that refusal reports queued=false, so the reachable path never sets the flag', late?.details?.queued === false, JSON.stringify(late?.details))
    check('no public writer leaves a requirement both reserved by one session and locked by another', reservations(world6).size === 0, JSON.stringify([...reservations(world6)]))
  } finally {
    await closeWorld(world6)
  }

  // The flag's own branch, reached only by writing the tables directly (a
  // fixture). It behaves as documented, it simply has no public producer.
  const world7 = await openWorld()
  try {
    const target = await world7.service.createRequirement({ title: 'Fixture state' }, panel)
    await world7.service.queue(target.id, {}, { session: 'ses_art', name: 'A' })
    const raw = rawRequirement(world7, target.id)
    const stamp = new Date().toISOString()
    await world7.domain.table('requirements').put(target.id, { ...raw, lock: { session: 'ses_eng', name: 'E', at: stamp, touchedAt: stamp } })
    const fixture = await capture(() => world7.service.claim(target.id, {}, { session: 'ses_art', name: 'A' }))
    check('the fixture-only state is a locked refusal', fixture?.code === 'conflict' && fixture?.details?.reason === 'locked', `${fixture?.code}/${fixture?.details?.reason}`)
    check('the fixture-only state sets queued=true and points at unqueue', fixture?.details?.queued === true && /unqueue/.test(fixture?.message ?? ''), JSON.stringify(fixture?.details))
  } finally {
    await closeWorld(world7)
  }
}

/* ------------------------------------------- [6] disposal orphans, never deletes */

console.log('\n[6] disposing a session orphans its locks instead of deleting them')
{
  const panel = { session: '', name: '面板' }
  const world8 = await openWorld()
  try {
    const held = await world8.service.createRequirement({ title: 'Held at disposal' }, panel)
    const waiting = await world8.service.createRequirement({ title: 'Queued at disposal' }, panel)
    await world8.service.claim(held.id, {}, { session: 'ses_art', name: 'A' })
    await world8.service.queue(waiting.id, {}, { session: 'ses_art', name: 'A' })
    const before = rawRequirement(world8, held.id).lock
    const report = await world8.service.disposeSession('ses_art')
    const after = rawRequirement(world8, held.id).lock
    const orphanState = lockState(rawRequirement(world8, held.id), 'ses_eng')
    check('disposal reports the lock it orphaned', report.orphaned === 1 && after?.orphaned === true, JSON.stringify({ report, after }))
    check('the orphaned lock keeps its holder and take instant', after.session === 'ses_art' && after.at === before.at, JSON.stringify(after))
    check('disposal released the queue item it was reserving', reservations(world8).size === 0 && report.releasedQueueItems === 1, JSON.stringify({ report, reservations: [...reservations(world8)] }))
    check('the orphaned state allows a takeover in the table everyone reads', orphanState.state === 'orphaned' && orphanState.allows === true && orphanState.current?.session === 'ses_art', JSON.stringify(orphanState))
    check('the orphaned record is in the claimable pool for another session', claimable(rawRequirement(world8, held.id), 'ses_eng', 'eng', { reservedBy: null }) === true, 'pool formula said no')
    const taken = await world8.service.claim(held.id, {}, { session: 'ses_eng', name: 'E' })
    check('another session takes the orphan over at once', taken.lock?.session === 'ses_eng' && taken.lock?.orphaned === undefined, JSON.stringify(taken.lock))
  } finally {
    await closeWorld(world8)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed on the ${process.env.RB_A3_BACKEND ?? 'json'} backend${RED ? ' (RED CONTROL run)' : ''}`)
process.exit(failures === 0 ? 0 : 1)
