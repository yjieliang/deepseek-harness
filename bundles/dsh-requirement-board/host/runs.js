/**
 * Execution synchronisation (`ROLE-DISPATCH.md` §4.2, §5.5, §5.12).
 *
 * The board observes two producers — the `subagent/start`/`subagent/end`
 * lifecycle and the background-job registry — and folds each observation into
 * one bounded execution unit on the requirement the owning session has locked.
 *
 * Every decision is a pure function of the records and one event, so a case can
 * drive the real handler without a Cordis context (§10). The service owns the
 * writes; nothing here reads a clock, a table, or a service: the observing
 * instant arrives with the event.
 */

/**
 * Tool names refused by `requireLockForExecution` when the calling session holds
 * no board lock (§5.4).
 *
 * The platform tags no tool with "starts execution", so this is a name list:
 * the tools that spawn a child agent or start a background job. It is a
 * protocol constant, not a config field, and the refusal names the way out —
 * turning the gate off, or claiming a requirement first.
 */
export const EXECUTION_TOOLS = Object.freeze([
  'subagent',
  'subagent_fork',
  'spawn_teammate',
  'workflow',
  'pwsh',
  'bash',
  'terminal',
])

/**
 * Decide one `tools/pre-execute` call under `requireLockForExecution` (§5.4).
 *
 * The gate is deliberately narrow: it applies to the execution tools above, to
 * a caller whose session is known, and only when that session holds no lock. A
 * call with no nameable session is not judged here — denying it would refuse
 * callers that never acted in a session — and non-execution tools pass through,
 * because the honest scope of this gate is execution, not the whole tool face.
 * The board's own tools are not execution tools, so the way out this refusal
 * names is always reachable.
 *
 * @param options - `name` of the tool being executed, the calling `session`, and
 * whether that session already `holdsLock`.
 * @returns a `deny` decision, or `undefined` when the call may proceed.
 */
export function executionGateDecision({ name, session, holdsLock }) {
  if (typeof name !== 'string' || !EXECUTION_TOOLS.includes(name)) return undefined
  if (typeof session !== 'string' || session === '') return undefined
  if (holdsLock === true) return undefined
  return {
    kind: 'deny',
    reason: 'This session holds no requirement-board lock, and requireLockForExecution is on: claim or queue a requirement first, or ask the operator to turn the setting off.',
  }
}

/**
 * Attribute one observed execution to the requirement whose lock it belongs to
 * (§5.5).
 *
 * A unit attaches to the task whose owning session holds the lock, and the
 * observation names a child session or a run: the lock holder is either that
 * subject itself — the child claimed its own task, which is the normal end of a
 * delegation — or the session that owns the subject, which is the delegating
 * parent that spawned it. The subject's own lock wins, because a session
 * executing work is the strongest statement about whose work it is; otherwise
 * the lowest requirement id decides, so two owners of one child cannot make the
 * attribution depend on table order.
 *
 * @param records - Every requirement record.
 * @param options - `subject`, the observed child or run id, and `owns`, the
 * ownership predicate `(target, caller) => boolean | undefined` (an undecidable
 * relation is not ownership).
 * @returns `{ requirementId, session }`, or `null` when no locked requirement
 * belongs to the observation.
 */
export function attributeExecution(records, { subject, owns }) {
  if (typeof subject !== 'string' || subject === '') return null
  const locked = records.filter(record => (record.lock?.session ?? '') !== '')
  const own = locked.find(record => record.lock.session === subject)
  if (own !== undefined) return { requirementId: own.id, session: own.lock.session }
  const owned = locked.filter(record => owns(subject, record.lock.session) === true)
  if (owned.length === 0) return null
  owned.sort((left, right) => left.id.localeCompare(right.id))
  return { requirementId: owned[0].id, session: owned[0].lock.session }
}

/**
 * Fold one subagent stop reason onto the unit vocabulary.
 *
 * The mapping is intentionally total: a reason this module does not know still
 * produced a finished child, and reporting it as `failed` keeps the unit
 * terminal instead of leaving it `running` forever.
 * @param stopReason - `SubagentResult['stopReason']`, or `undefined` when the
 * event carried none.
 * @returns one of {@link EXEC_STATUSES}.
 */
export function subagentStatus(stopReason) {
  if (stopReason === 'completed') return 'completed'
  if (stopReason === 'aborted') return 'killed'
  return 'failed'
}

/**
 * Build the execution unit of one subagent lifecycle edge.
 * @param info - `SubagentRunInfo`/`SubagentRunEndInfo` payload.
 * @param options - `at` (instant of the observation) and `phase`
 * (`'start'` or `'end'`).
 * @returns the unit, or `undefined` when the payload names no subject.
 */
export function unitFromSubagent(info, { at, phase }) {
  const subject = typeof info?.id === 'string' ? info.id : ''
  if (subject === '') return undefined
  const provider = typeof info?.provider === 'string' ? info.provider : ''
  if (phase === 'start') {
    return {
      ref: subject,
      kind: 'subagent',
      label: provider,
      status: 'running',
      progress: '',
      detail: '',
      startedAt: at,
      finishedAt: null,
      updatedAt: at,
    }
  }
  const stopReason = typeof info?.stopReason === 'string' ? info.stopReason : ''
  return {
    ref: subject,
    kind: 'subagent',
    label: provider,
    status: subagentStatus(stopReason),
    progress: '',
    detail: stopReason,
    startedAt: at,
    finishedAt: at,
    updatedAt: at,
  }
}

/**
 * Fold one background-job event onto a unit.
 *
 * `output` is not stored (§5.5): it carries byte coordinates that move on every
 * write, and a unit observes state, not bytes. `removed` is not a terminal
 * status either — it says the job left the visible set, which is what a
 * settlement looks like when nothing was listening — so it reports a gap and
 * leaves the stored unit alone rather than inventing an outcome.
 *
 * @param event - One `JobEvent`.
 * @param options - `at`, the instant of the observation (jobs stamp
 * `startedAt`/`finishedAt` in epoch milliseconds, which are converted here).
 * @returns `{ unit, gap }`: the unit to store (absent when the event stores
 * nothing) and whether the observation was lost.
 */
export function unitFromJobEvent(event, { at }) {
  if (event?.type === 'output') return { unit: undefined, gap: false }
  if (event?.type === 'removed') return { unit: undefined, gap: true }
  const job = event?.job
  if (job === undefined || typeof job.id !== 'string' || job.id === '') return { unit: undefined, gap: false }
  const settled = event.type === 'settled'
  const status = settled ? terminalJobStatus(job.status) : (job.status === 'stopping' ? 'stopping' : 'running')
  const unit = {
    ref: job.id,
    kind: 'job',
    label: typeof job.label === 'string' ? job.label : '',
    status,
    progress: typeof job.progress === 'string' ? job.progress : '',
    detail: typeof job.detail === 'string' ? job.detail : '',
    startedAt: epochIso(job.startedAt, at),
    finishedAt: settled ? epochIso(job.finishedAt, at) : null,
    updatedAt: at,
  }
  return { unit, gap: false }
}

/** Read one epoch-millisecond field as ISO, falling back to the observation instant. */
function epochIso(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : fallback
}

/**
 * The terminal status of a settled job.
 *
 * A settlement whose projection is still live contradicts the registry's own
 * lifecycle, so it is reported as `failed` rather than stored as a running unit
 * that can never settle.
 * @param status - `JobView['status']` at settlement.
 * @returns one of {@link EXEC_STATUSES}.
 */
function terminalJobStatus(status) {
  return status === 'running' || status === 'stopping' || status === undefined ? 'failed' : status
}

/**
 * Whether one observation differs from the stored unit in a stored field.
 *
 * `updatedAt` is deliberately not compared: it is the observation's own stamp,
 * and comparing it would write on every event, which is exactly the churn the
 * write discipline forbids (§5.5). `finishedAt` is not compared either: an end
 * edge stamps the current instant, so a repeat of the same terminal status would
 * look like news every time. The status is what carries the transition, and the
 * terminal stamp is written with it.
 * @param before - Stored unit.
 * @param next - Observed unit.
 * @returns `true` when a write is warranted.
 */
export function executionChanged(before, next) {
  return before.status !== next.status
    || before.progress !== next.progress
    || before.detail !== next.detail
}

/**
 * Fold one unit into a bounded list.
 *
 * The newest unit is appended and the oldest are dropped past `max`, so the
 * list answers "what is running now" rather than "everything that ever ran";
 * the caller marks the record truncated when a drop happened.
 *
 * @param units - Stored units.
 * @param unit - Observed unit; `undefined` stores nothing.
 * @param max - Maximum retained units.
 * @returns `{ units, changed, truncated }`.
 */
export function applyExecution(units, unit, max) {
  const list = [...(units ?? [])]
  if (unit === undefined) return { units: list, changed: false, truncated: false }
  const index = list.findIndex(candidate => candidate.ref === unit.ref)
  if (index === -1) {
    list.push(unit)
    let truncated = false
    while (list.length > max) {
      list.shift()
      truncated = true
    }
    return { units: list, changed: true, truncated }
  }
  if (!executionChanged(list[index], unit)) return { units: list, changed: false, truncated: false }
  list[index] = unit
  return { units: list, changed: true, truncated: false }
}

/**
 * How many units of one requirement are still executing (§4.4 `running`).
 * @param requirement - Stored record.
 * @returns the count of `running` and `stopping` units.
 */
export function runningCount(requirement) {
  return (requirement.executions ?? []).filter(unit => unit.status === 'running' || unit.status === 'stopping').length
}

/**
 * Whether one unit has gone quiet past the deployment's stall window.
 *
 * The unit is stale when it still claims to be executing but its last
 * observation is older than `stallAfterHours` — the same window the
 * requirement-level stall uses, so the panel's two "stale" marks cannot
 * disagree about how long is too long.
 *
 * @param unit - Stored unit.
 * @param now - ISO instant to measure against.
 * @param stallAfterHours - Window in hours.
 * @returns `true` when the unit looks abandoned.
 */
export function unitIsStale(unit, now, stallAfterHours) {
  if (unit.status !== 'running' && unit.status !== 'stopping') return false
  const seen = Date.parse(unit.updatedAt ?? unit.startedAt)
  const at = Date.parse(now)
  if (!Number.isFinite(seen) || !Number.isFinite(at)) return false
  return at - seen > stallAfterHours * 3_600_000
}

/**
 * Settle every still-executing unit of a requirement.
 *
 * The board calls this when the observation's own owner ends — a disposed
 * session, a revoked delegation (§5.5) — because nothing will report those
 * units again. `killed` is the honest terminal for that: the run did not
 * complete, and the board itself stopped following it.
 *
 * @param units - Stored units.
 * @param at - Instant of the settle.
 * @param reason - Why the observation ended; stored as each unit's `detail`.
 * @returns `{ units, changed }`.
 */
export function settleExecutions(units, at, reason) {
  let changed = false
  const list = (units ?? []).map(unit => {
    if (unit.status !== 'running' && unit.status !== 'stopping') return unit
    changed = true
    return { ...unit, status: 'killed', detail: reason, finishedAt: at, updatedAt: at }
  })
  return { units: list, changed }
}
