/**
 * The execution lock and the claim decision table (`ROLE-DISPATCH.md` §4.5,
 * §5.2, §5.4), together with the two derived answers built on them: the gate and
 * escalation index over `blocksOn` (§5.8, §5.9) and `advanceable` (§4.4).
 *
 * This module is the only place a lock is classified, a lease is judged, or a
 * claim is accepted. The service, the agent tools, the browser route, and the
 * prompt section all read {@link lockState} and {@link claimable} instead of
 * re-deriving eligibility, so one requirement cannot be reported claimable in
 * one surface and refused in another.
 *
 * The lock is per requirement id and never compares content: two requirements
 * with identical titles hold two independent locks.
 */

import { PRIORITIES, fail, nowIso } from './model.js'

/**
 * Lock lease in hours. A lock untouched for longer than this is taken over,
 * which is what keeps a lock from a crashed session from freezing the work.
 * The row config key is `staleClaimHours` (`host/config.js`).
 */
export const LOCK_LEASE_HOURS = 8

/** Milliseconds in one hour. */
const MS_PER_HOUR = 3_600_000

/**
 * How long a lock has gone untouched, clamped at zero so a `touchedAt` in the
 * future — two writers with skewed clocks — reads as fresh, not expired.
 * @param lock - Stored lock.
 * @param now - ISO instant to measure against.
 * @returns elapsed milliseconds.
 */
function idleMs(lock, now) {
  const touched = Date.parse(lock.touchedAt ?? lock.at)
  const at = Date.parse(now)
  if (!Number.isFinite(touched) || !Number.isFinite(at)) return 0
  return Math.max(0, at - touched)
}

/**
 * The lock as a receipt reports it: the stored fields plus the two derived
 * facts (`orphaned`, `expired`) that explain why it was takeable.
 * @param lock - Stored lock.
 * @param now - ISO instant the lease is measured at.
 * @param leaseHours - Lease length in hours.
 * @returns the reported lock.
 */
function lockView(lock, now, leaseHours) {
  return {
    session: lock.session,
    name: lock.name ?? '',
    at: lock.at,
    touchedAt: lock.touchedAt ?? lock.at,
    orphaned: lock.orphaned === true,
    expired: idleMs(lock, now) > leaseHours * MS_PER_HOUR,
  }
}

/**
 * Classify one requirement's lock for one caller (§5.2).
 *
 * `allows` is the whole lock rule: a free slot, the caller's own lock
 * (re-claiming is idempotent), a lock orphaned by a dead session, and a lock
 * past its lease are takeable; every other lock is not. `state` names which of
 * those applied, so a receipt can report more than "refused".
 *
 * @param record - Requirement record, with or without a `lock`.
 * @param me - Calling session id; `''` is the panel, which holds no lock.
 * @param now - ISO instant the lease is measured at.
 * @param leaseHours - Lease length in hours.
 * @returns `{ state, allows, current }`; `current` is the reported lock, or
 * `null` when the slot is free.
 */
export function lockState(record, me, now = nowIso(), leaseHours = LOCK_LEASE_HOURS) {
  const lock = record?.lock ?? null
  if (lock === null) return { state: 'free', allows: true, current: null }
  const current = lockView(lock, now, leaseHours)
  if (me !== '' && lock.session === me) return { state: 'mine', allows: true, current }
  if (current.orphaned) return { state: 'orphaned', allows: true, current }
  if (current.expired) return { state: 'expired', allows: true, current }
  return { state: 'other', allows: false, current }
}

/**
 * The one `claimable` formula (§4.5), shared by `listRequirements`, the
 * prompt's claimable section, and the panel filter.
 *
 * Asked for a session, this is role eligibility (§4.5): the requirement must be
 * unrouted, routed to `myRole`, or delegated to `me`. Asked for the panel
 * (`me === ''`), the role clause does not apply and the answer is the takeable
 * pool: unfinished task, lock free/orphaned/expired, no soft reservation by
 * someone else. Routing is derived online state, not authorization (§3.5), and
 * the human is not restricted (§2.5) — the panel never claims, it needs the set
 * a person may hand out, which cannot depend on a role no person wears.
 *
 * @param record - Requirement record.
 * @param me - Session whose eligibility is asked; `''` asks for the panel pool.
 * @param myRole - Role id `me` resolves to, `''` when it resolves none.
 * @param options - `reservedBy` is the session whose queue soft-reserves this
 * requirement, or `null` when no queue holds it; `now` and `leaseHours` set the
 * lease reference.
 * @returns `true` when `me` may claim this requirement now, or — for the panel —
 * when this requirement is in the takeable pool.
 */
export function claimable(record, me, myRole = '', options = {}) {
  const { reservedBy = null, now = nowIso(), leaseHours = LOCK_LEASE_HOURS } = options
  if (record.status === 'done' || record.status === 'archived') return false
  if ((record.kind ?? 'task') !== 'task') return false
  if (!lockState(record, me, now, leaseHours).allows) return false
  if (reservedBy !== null && reservedBy !== me) return false
  if (me === '') return true
  const role = record.role ?? ''
  const delegated = record.delegatedTo ?? null
  return role === '' || role === myRole || delegated?.session === me
}

/**
 * Whether a requirement is finished for the gates (§5.8): only `done` counts.
 *
 * An archived requirement is shelved, not finished, so it still blocks whatever
 * waits on it until it is deleted or completed.
 * @param record - Requirement record.
 * @returns `true` when the requirement is done.
 */
function finished(record) {
  return record.status === 'done'
}

/** Whether a requirement is still being worked on, rather than done or shelved. */
function inProgress(record) {
  return record.status !== 'done' && record.status !== 'archived'
}

/**
 * The derived gate and priority state of every requirement (§4.4, §5.8, §5.9).
 *
 * One pass over the `blocksOn` links answers three questions per requirement:
 * which unfinished requirements it waits on, how urgent it reads once the work it
 * holds up is counted, and whether it is the one holding work up. Nothing is
 * stored — every read recomputes from the records, so a blocker that finishes
 * lowers the escalation with no write.
 *
 * A link counts while its target is not done: an archived blocker still blocks,
 * because shelving work is not finishing it. Escalation travels from a
 * requirement that is still being worked on to its blockers, so shelved or
 * finished work raises nothing, and it is capped at `urgent`. The "critical path"
 * reading is therefore the set of blockers whose priority was raised by work they
 * hold up, not the set of blocked requirements.
 *
 * @param records - Every requirement record.
 * @returns a `Map` keyed by requirement id; each value is
 * `{ blockedBy, gated, effectivePriority, escalated }`. `blockedBy` is
 * informational for a settled record — no gate consults it there.
 */
export function escalationIndex(records) {
  const list = [...records]
  const byId = new Map(list.map(record => [record.id, record]))
  const blockedBy = new Map()
  const raising = new Map()
  for (const record of list) {
    const blockers = []
    for (const target of record.blocksOn ?? []) {
      const blocker = byId.get(target)
      if (blocker === undefined || finished(blocker)) continue
      blockers.push(blocker.id)
      if (!inProgress(record)) continue
      const raised = raising.get(blocker.id)
      if (raised === undefined) raising.set(blocker.id, [record])
      else if (!raised.includes(record)) raised.push(record)
    }
    blockedBy.set(record.id, blockers)
  }
  // The rank a requirement reads at, memoized per requirement. `open` stops the
  // walk if a store was corrupted outside the write path (which refuses cycles):
  // a read must not hang, and the requirement keeps its own priority.
  const cap = PRIORITIES.length - 1
  const rankOf = record => Math.max(0, PRIORITIES.indexOf(record.priority))
  const ranks = new Map()
  const open = new Set()
  const effectiveRank = record => {
    const cached = ranks.get(record.id)
    if (cached !== undefined) return cached
    if (open.has(record.id)) return rankOf(record)
    open.add(record.id)
    let rank = rankOf(record)
    for (const raised of raising.get(record.id) ?? []) rank = Math.max(rank, effectiveRank(raised))
    open.delete(record.id)
    rank = Math.min(rank, cap)
    ranks.set(record.id, rank)
    return rank
  }
  const index = new Map()
  for (const record of list) {
    const blockers = blockedBy.get(record.id) ?? []
    const rank = effectiveRank(record)
    index.set(record.id, {
      blockedBy: blockers,
      gated: blockers.length > 0,
      effectivePriority: PRIORITIES[rank] ?? record.priority,
      escalated: rank > rankOf(record),
    })
  }
  return index
}

/**
 * The one `advanceable` formula (§4.4): may this caller move the requirement on
 * to its next node now, without `force`?
 *
 * The answer is, in full:
 *
 * - the lock is in the caller's hand — or the caller is the panel (`me === ''`),
 *   which holds no lock and which §5.7 never refuses, so that clause is always
 *   true for it;
 * - the cross-requirement gate is clear (`!gated`: no unfinished `blocksOn`
 *   target, §5.8);
 * - the flow node's own prerequisite is met (`!prerequisiteMissing`, §3.5);
 * - the requirement is neither `done` nor `archived`;
 * - the kind allows it: a decision is the human's, so only the panel reads
 *   `advanceable` for one.
 *
 * The node's own completion condition is deliberately not part of this answer:
 * `transition` judges it (`completion-not-met`) and no permission is involved —
 * a caller holding the lock is allowed to try and be told the node is unfinished.
 * A requirement this session could still *claim* is not one it can advance:
 * `claimable` answers that other question, and the prompt keeps them apart by
 * separating "Claimable for you" from what this session already holds.
 *
 * @param record - Requirement record.
 * @param me - Session whose ability is asked; `''` asks for the panel.
 * @param options - `gated`, the requirement's value from {@link escalationIndex};
 * `prerequisiteMissing`, whether the flow engine's `flowPrerequisiteMissing`
 * found an unmet node dependency; `now` and `leaseHours` for the lock comparison.
 * @returns `true` when `me` may advance this requirement now.
 */
export function advanceable(record, me, options = {}) {
  const { gated = false, prerequisiteMissing = false, now = nowIso(), leaseHours = LOCK_LEASE_HOURS } = options
  if (record.status === 'done' || record.status === 'archived') return false
  if (gated || prerequisiteMissing) return false
  if ((record.kind ?? 'task') === 'decision') return me === ''
  if (me === '') return true
  return lockState(record, me, now, leaseHours).state === 'mine'
}

/**
 * Refuse a structural change by a session that does not hold the lock (§5.4).
 *
 * Call this inside the write-chain transform, so the lock compared is the one
 * current at commit time. The panel (`session === ''`) is the human and is not
 * restricted; every AI session needs the lock, including one wearing the role
 * the requirement is routed to.
 *
 * @param record - Requirement record read at its chain slot.
 * @param session - Calling session id.
 */
export function assertLockHeld(record, session) {
  if (session === '') return
  if (record.lock?.session !== session) {
    fail('forbidden', `"${record.id}" requires its execution lock: session "${session}" does not hold it`, {
      reason: 'lock-required',
      id: record.id,
      lock: record.lock ?? null,
    })
  }
}

/**
 * Judge one `claim` against the ordered table in §5.4.
 *
 * The order is the rule: state, then the human-only decision kind, then role
 * eligibility, then the lock, then the soft reservation, then the one-lock-per-
 * session rule. Each refusal carries a stable `details.reason` so no caller has
 * to match on prose.
 *
 * Precondition: `session` is a non-empty session id. The panel has no claim at
 * all — a lock owned by `''` would refuse every AI session until the lease ran
 * out (§8).
 *
 * `queue` judges through this same table with `holding: null`, so the last row
 * does not apply to a session that is already executing: reserving the next
 * requirement is exactly what an executing session should do (§5.4).
 *
 * @param options - `record`; the claiming `session`; its `myRole`; `holding`,
 * the other requirement this session has locked, or `null`; `reservedBy`, the
 * session whose queue soft-reserves this requirement, or `null` when none does
 * (a reservation is derived from the queues table, never stored on the record);
 * `queueHead`, the next item of the calling session's own queue, or `null`;
 * `now`; `leaseHours`.
 * @returns `{ idempotent }` — `true` when this session already held the lock.
 */
export function judgeClaim({ record, session, myRole = '', holding = null, reservedBy = null, queueHead = null, now = nowIso(), leaseHours = LOCK_LEASE_HOURS }) {
  if (record.status === 'done' || record.status === 'archived') {
    fail('invalid-state', `"${record.id}" is ${record.status} and can no longer be claimed`, { reason: 'invalid-state', id: record.id, status: record.status })
  }
  const kind = record.kind ?? 'task'
  // One criterion, the same one the pool uses: only a task is claimable. A
  // decision is the human's, and any other kind is not claimable work either —
  // refusing here keeps `claim` in step with `claimable`, so a record whose kind
  // was never written through this plugin's validated path cannot be locked.
  if (kind !== 'task') {
    fail('forbidden', kind === 'decision'
      ? `"${record.id}" is a decision requirement: only the human decides it`
      : `"${record.id}" has kind "${kind}": only a task can be claimed`, {
      reason: kind === 'decision' ? 'decision-task' : 'invalid-kind',
      id: record.id,
      kind,
    })
  }
  const role = record.role ?? ''
  const delegated = record.delegatedTo ?? null
  if (role !== '' && role !== myRole && delegated?.session !== session) {
    fail('forbidden', `"${record.id}" is routed to role "${role}"; session "${session}" holds "${myRole}"`, {
      reason: 'role-mismatch',
      id: record.id,
      role,
      myRole,
      delegatedTo: delegated,
    })
  }
  const lock = lockState(record, session, now, leaseHours)
  if (!lock.allows) {
    // A lock and a reservation are separate records, so this requirement can be
    // both locked by someone else and named by the caller's own queue. The
    // sequence that reaches it is a lapsed lease the holder then renews by
    // writing again: reserving was legal while the lease was over, and the
    // revived lock now refuses the claim the reservation was taken for. The flag
    // lets the refusal point at `unqueue` instead of leaving the caller stuck
    // with a queue head it cannot take (§5.3).
    const queued = reservedBy === session
    fail('conflict', queued
      ? `"${record.id}" is locked by session "${lock.current.session}", and it is an item of your queue: "unqueue" it to stop reserving it`
      : `"${record.id}" is locked by session "${lock.current.session}"`, {
      reason: 'locked',
      id: record.id,
      current: lock.current,
      queued,
    })
  }
  if (lock.state === 'mine') return { idempotent: true }
  if (reservedBy !== null && reservedBy !== session) {
    fail('conflict', `"${record.id}" is reserved by session "${reservedBy}"`, { reason: 'reserved', id: record.id, reservedBy })
  }
  if (holding !== null && holding.id !== record.id) {
    fail('conflict', `session "${session}" already executes "${holding.id}"`, {
      reason: 'session-busy',
      id: record.id,
      current: lockView(holding.lock, now, leaseHours),
      queueHead,
    })
  }
  return { idempotent: false }
}

/**
 * The lock a claim installs.
 * @param session - Claiming session id.
 * @param name - Display name to record for the holder.
 * @param at - ISO instant of the claim.
 * @returns the lock record to store.
 */
export function newLock(session, name, at) {
  return { session, name: name ?? '', at, touchedAt: at }
}

/**
 * Renew a lock this write is made under (§5.2: any successful write by the
 * holder refreshes the lease in that same update).
 * @param record - Requirement record the write is committed against.
 * @param session - Writing session id.
 * @param at - ISO instant of the write.
 * @returns the lock to store; the stored lock unchanged when this writer holds
 * none, so the caller can assign the result unconditionally.
 */
export function renewedLock(record, session, at) {
  const lock = record?.lock ?? null
  if (lock === null || session === '' || lock.session !== session) return lock
  return { ...lock, touchedAt: at }
}
