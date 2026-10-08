/**
 * The flow engine: derived node states, the transition rules that advance or
 * roll back a requirement, and the project statistics derived from the retained
 * transition history.
 *
 * Node status is never authored directly. {@link recomputeNodes} is the single
 * function that derives it — from the requirement's binding to a template and
 * from the progress it has already recorded — and every transition runs it, so
 * the flow chart, the statistics, and the history cannot disagree.
 */

import { elapsedMs, fail, mintId, nowIso } from './model.js'
import { dependenciesMet, nextNodeId, nodeIndex } from './templates.js'

/**
 * A node's checklist with every box unticked.
 * @param node - Template node.
 * @returns one `false` per declared checklist entry.
 */
function blankChecks(node) {
  return (node.completion?.checklist ?? []).map(() => false)
}

/**
 * Derive every node's display state for one requirement.
 *
 * `change` describes the transition being applied so that the derived state
 * cannot contradict it: nodes at or after `toIndex` lose their recorded
 * progress (a rollback re-opens them), and the entered/completed instants of
 * the nodes the transition touches are stamped with `at`.
 *
 * @param requirement - Requirement draft carrying `nodeId`, `status`, and the previous `nodes`.
 * @param template - Template the requirement is bound to.
 * @param at - Transition instant, ISO-8601.
 * @param change - `{ to, toIndex, completed }` describing the transition.
 * @returns the derived node map, keyed by node id.
 */
export function recomputeNodes(requirement, template, at, change = {}) {
  const nodes = {}
  const currentIndex = nodeIndex(template, requirement.nodeId)
  for (const [index, node] of template.nodes.entries()) {
    const previous = requirement.nodes?.[node.id]
    let status = 'pending'
    if (requirement.status === 'done') status = 'done'
    else if (index === currentIndex) status = 'active'
    else if (currentIndex >= 0 && index < currentIndex) status = 'done'
    const reopens = change.toIndex !== undefined && index >= change.toIndex
    const checks = reopens || previous?.checks?.length !== (node.completion?.checklist ?? []).length
      ? blankChecks(node)
      : [...previous.checks]
    nodes[node.id] = {
      status,
      enteredAt: previous?.enteredAt ?? null,
      completedAt: !reopens && status === 'done' ? (previous?.completedAt ?? null) : null,
      checks,
      assignee: previous?.assignee ?? node.assignee ?? '',
      note: previous?.note ?? '',
    }
  }
  if (change.to !== undefined && nodes[change.to] !== undefined) nodes[change.to].enteredAt = at
  if (change.completed !== undefined && nodes[change.completed] !== undefined) {
    nodes[change.completed].status = 'done'
    nodes[change.completed].completedAt = at
  }
  return nodes
}

/**
 * Whether the current node's declared completion condition is satisfied.
 * @param template - Template the requirement is bound to.
 * @param requirement - Requirement draft.
 * @param note - Transition note supplied by the caller.
 * @returns `{ ok: true }`, or `{ ok: false, reason, missing }`.
 */
function completionState(template, requirement, note) {
  const node = template.nodes.find(candidate => candidate.id === requirement.nodeId)
  if (node === undefined) return { ok: false, reason: 'unknown-node', missing: [requirement.nodeId] }
  const condition = node.completion ?? { type: 'manual', checklist: [], requireNote: false }
  if (condition.type === 'checklist') {
    const checks = requirement.nodes?.[node.id]?.checks ?? []
    const missing = (condition.checklist ?? []).filter((_, index) => checks[index] !== true)
    if (missing.length > 0) return { ok: false, reason: 'checklist-incomplete', missing }
  }
  if (condition.requireNote && (note ?? '').trim() === '') {
    return { ok: false, reason: 'note-required', missing: [] }
  }
  return { ok: true, missing: [] }
}

/**
 * The template prerequisite an `advance` would have to satisfy (§5.8).
 *
 * The node being left counts as finished for the check: a caller that reaches
 * the next node has just completed the current one, and `recomputeNodes` stamps
 * that fact into the committed draft. `applyTransition` and `advanceable` both
 * call this, so the value a reader sees and the verdict a transition gives
 * cannot come from two different rules.
 *
 * @param requirement - Requirement record; never mutated.
 * @param template - Template the requirement is bound to.
 * @returns `{ node, missing }` for the next node that still waits on unfinished
 * nodes, or `null` when advancing is not gated (including on the last node,
 * where advancing finishes the requirement).
 */
export function flowPrerequisiteMissing(requirement, template) {
  const from = requirement.nodeId
  const next = nextNodeId(template, from)
  if (next === undefined) return null
  const nodes = { ...(requirement.nodes ?? {}) }
  const leaving = nodes[from]
  nodes[from] = { ...leaving, status: 'done' }
  const deps = dependenciesMet(template, { ...requirement, nodes }, next)
  return deps.ok ? null : { node: next, missing: deps.missing }
}

/**
 * Apply one transition to a requirement draft, appending its history record.
 *
 * The rules are deliberately explicit:
 * - `advance` moves to the immediate next node, or completes the requirement at
 *   the last node. The current node's completion condition and the target's
 *   `dependsOn` prerequisites must hold unless `force` overrides them.
 * - `rollback` re-opens an earlier node; it requires a `note` and clears the
 *   progress recorded on that node and every later one.
 * - `jump` sets an explicit node and always requires `force` and a `note`; it is
 *   the escape hatch for a template swap or an off-flow decision.
 * - `complete` and `reopen` change only the requirement's status.
 *
 * @param requirement - Requirement draft, mutated in place.
 * @param template - Template the requirement is bound to.
 * @param input - `{ action, to, note, force }`.
 * @param context - `{ at, actor }` for the retained history record.
 * @returns the appended history record.
 */
export function applyTransition(requirement, template, input, { at = nowIso(), actor = {} } = {}) {
  const action = input.action
  const note = (input.note ?? '').trim()
  const force = input.force === true
  if (nodeIndex(template, requirement.nodeId) < 0) {
    requirement.nodeId = template.nodes[0].id
  }
  const from = requirement.nodeId
  const fromIndex = nodeIndex(template, from)
  const fromStatus = requirement.status
  let to = from
  let completed
  let toIndex = fromIndex

  if (action === 'advance') {
    if (fromStatus === 'done') fail('invalid-transition', `requirement is already done; reopen it before advancing`)
    if (fromStatus === 'archived') fail('invalid-transition', 'an archived requirement must be restored before advancing')
    const gate = completionState(template, requirement, note)
    if (!gate.ok && !force) {
      fail('completion-not-met', `the current node "${from}" is not finished: ${gate.reason}`, {
        node: from,
        reason: gate.reason,
        missing: gate.missing,
      })
    }
    const next = nextNodeId(template, from)
    if (next === undefined) {
      requirement.status = 'done'
      completed = from
    } else {
      // The node being left counts as finished for the prerequisite check; the
      // same function answers `advanceable`, and `recomputeNodes` stamps the
      // same fact into the committed draft.
      const missing = flowPrerequisiteMissing(requirement, template)
      if (missing !== null && !force) {
        fail('dependency-not-met', `node "${missing.node}" still depends on unfinished nodes`, missing)
      }
      to = next
      toIndex = nodeIndex(template, to)
      completed = from
    }
  } else if (action === 'rollback') {
    if (input.to === undefined) fail('invalid-argument', '"to" is required for a rollback')
    to = input.to
    toIndex = nodeIndex(template, to)
    if (toIndex < 0) fail('not-found', `template "${template.id}" has no node "${to}"`, { templateId: template.id, node: to })
    if (toIndex >= fromIndex) fail('invalid-transition', `rollback target "${to}" must precede the current node "${from}"`)
    if (note === '') fail('invalid-argument', 'a rollback requires a note explaining the rework')
    if (requirement.status === 'done') requirement.status = 'active'
    if (requirement.status === 'archived') fail('invalid-transition', 'an archived requirement must be restored before rolling back')
  } else if (action === 'jump') {
    if (input.to === undefined) fail('invalid-argument', '"to" is required for a jump')
    if (!force) fail('invalid-transition', 'a jump requires "force: true"')
    if (note === '') fail('invalid-argument', 'a jump requires a note explaining the move')
    to = input.to
    toIndex = nodeIndex(template, to)
    if (toIndex < 0) fail('not-found', `template "${template.id}" has no node "${to}"`, { templateId: template.id, node: to })
    if (requirement.status === 'done' || requirement.status === 'archived') requirement.status = 'active'
    if (toIndex > fromIndex) completed = from
  } else if (action === 'complete') {
    if (fromStatus === 'done') fail('invalid-transition', 'requirement is already done')
    requirement.status = 'done'
    completed = from
  } else if (action === 'reopen') {
    if (fromStatus !== 'done') fail('invalid-transition', 'only a done requirement can be reopened')
    requirement.status = 'active'
  } else {
    fail('invalid-argument', `unknown transition action "${action}"`)
  }

  const previousEnteredAt = requirement.nodes?.[from]?.enteredAt ?? null
  const reopens = action === 'rollback' || (action === 'jump' && toIndex < fromIndex)
  requirement.nodeId = to
  requirement.nodes = recomputeNodes(requirement, template, at, {
    ...(reopens ? { toIndex } : {}),
    ...(to !== from ? { to } : {}),
    ...(completed !== undefined ? { completed } : {}),
  })
  if (action === 'rollback') {
    requirement.nodes[from].enteredAt = null
    requirement.nodes[from].completedAt = null
  }
  requirement.updatedAt = at
  requirement.rev = (requirement.rev ?? 0) + 1
  if (requirement.status !== 'blocked') {
    requirement.blockReason = ''
    requirement.blockedAt = null
  }

  const record = {
    id: mintId('evt'),
    at,
    by: actor.session ?? '',
    byName: actor.name ?? '',
    action,
    from,
    fromName: template.nodes[fromIndex]?.name ?? from,
    to,
    toName: template.nodes[toIndex]?.name ?? to,
    fromStatus,
    toStatus: requirement.status,
    note,
    force,
    durationMs: action === 'rollback' ? null : elapsedMs(previousEnteredAt, at),
  }
  requirement.history = [...(requirement.history ?? []), record]
  if (requirement.history.length > 500) requirement.history = requirement.history.slice(-500)
  return record
}

/**
 * Tick or untick one checklist entry on the currently active node.
 * @param requirement - Requirement draft, mutated in place.
 * @param template - Template the requirement is bound to.
 * @param index - Checklist position.
 * @param checked - Whether the entry becomes ticked.
 * @param at - Mutation instant, ISO-8601.
 */
export function setChecklistEntry(requirement, template, index, checked, at = nowIso()) {
  const node = template.nodes.find(candidate => candidate.id === requirement.nodeId)
  if (node === undefined) fail('not-found', `template "${template.id}" has no node "${requirement.nodeId}"`)
  const size = (node.completion?.checklist ?? []).length
  if (!Number.isInteger(index) || index < 0 || index >= size) {
    fail('invalid-argument', `checklist index ${index} is outside 0..${Math.max(0, size - 1)} for node "${node.id}"`)
  }
  const state = requirement.nodes[node.id]
  state.checks = [...state.checks]
  state.checks[index] = checked
  requirement.updatedAt = at
  requirement.rev = (requirement.rev ?? 0) + 1
}

/** Round a millisecond figure for presentation, or `null`. */
function round(value) {
  return value === null ? null : Math.round(value)
}

/**
 * Derive project statistics from the committed document.
 * @param document - Store document.
 * @param options - `now`, `stallAfterHours`.
 * @returns the statistics payload served to the panel and the tools.
 */
export function computeStats(document, { now = nowIso(), stallAfterHours = 72 } = {}) {
  const all = Object.values(document.requirements)
  const counted = all.filter(requirement => requirement.status !== 'archived')
  const byStatus = { active: 0, blocked: 0, done: 0, archived: 0 }
  const byPriority = { low: 0, normal: 0, high: 0, urgent: 0 }
  const owners = new Map()
  const sessions = new Map()
  const durations = new Map()
  const blocked = []
  const stalled = []
  const idleLimit = stallAfterHours * 3_600_000

  for (const requirement of all) {
    byStatus[requirement.status] = (byStatus[requirement.status] ?? 0) + 1
    if (requirement.status === 'archived') continue
    byPriority[requirement.priority] = (byPriority[requirement.priority] ?? 0) + 1
    const owner = requirement.owner || '(unassigned)'
    const ownerEntry = owners.get(owner) ?? { owner, total: 0, done: 0, blocked: 0, active: 0 }
    ownerEntry.total += 1
    ownerEntry[requirement.status] = (ownerEntry[requirement.status] ?? 0) + 1
    owners.set(owner, ownerEntry)
    for (const session of requirement.sessions ?? []) {
      const sessionEntry = sessions.get(session) ?? { session, total: 0, done: 0, blocked: 0, active: 0 }
      sessionEntry.total += 1
      sessionEntry[requirement.status] = (sessionEntry[requirement.status] ?? 0) + 1
      sessions.set(session, sessionEntry)
    }
    if (requirement.status === 'blocked') {
      blocked.push({
        id: requirement.id,
        title: requirement.title,
        owner: requirement.owner,
        reason: requirement.blockReason,
        since: requirement.blockedAt,
        blockedMs: elapsedMs(requirement.blockedAt, now),
        node: requirement.nodeId,
      })
    }
    const activeNode = requirement.nodes?.[requirement.nodeId]
    if (requirement.status === 'active' && activeNode?.enteredAt) {
      const idleMs = elapsedMs(activeNode.enteredAt, now)
      if (idleMs !== null && idleMs > idleLimit) {
        stalled.push({
          id: requirement.id,
          title: requirement.title,
          owner: requirement.owner,
          node: requirement.nodeId,
          enteredAt: activeNode.enteredAt,
          idleMs,
        })
      }
    }
    for (const entry of requirement.history ?? []) {
      if (entry.durationMs === null || entry.durationMs === undefined) continue
      if (entry.action !== 'advance' && entry.action !== 'complete') continue
      const key = `${requirement.templateId}::${entry.from}`
      const bucket = durations.get(key) ?? {
        templateId: requirement.templateId,
        nodeId: entry.from,
        name: entry.fromName,
        samples: 0,
        totalMs: 0,
        minMs: null,
        maxMs: null,
      }
      bucket.samples += 1
      bucket.totalMs += entry.durationMs
      bucket.minMs = bucket.minMs === null ? entry.durationMs : Math.min(bucket.minMs, entry.durationMs)
      bucket.maxMs = bucket.maxMs === null ? entry.durationMs : Math.max(bucket.maxMs, entry.durationMs)
      durations.set(key, bucket)
    }
  }

  const doneCount = counted.filter(requirement => requirement.status === 'done').length
  return {
    generatedAt: now,
    total: counted.length,
    archived: byStatus.archived,
    byStatus,
    byPriority,
    completionRate: counted.length === 0 ? 0 : doneCount / counted.length,
    byOwner: [...owners.values()].sort((a, b) => b.total - a.total),
    bySession: [...sessions.values()].sort((a, b) => b.total - a.total),
    nodeDurations: [...durations.values()]
      .map(bucket => ({
        templateId: bucket.templateId,
        nodeId: bucket.nodeId,
        name: bucket.name,
        samples: bucket.samples,
        avgMs: round(bucket.totalMs / bucket.samples),
        minMs: round(bucket.minMs),
        maxMs: round(bucket.maxMs),
      }))
      .sort((a, b) => b.avgMs - a.avgMs),
    blocked,
    stalled,
  }
}
