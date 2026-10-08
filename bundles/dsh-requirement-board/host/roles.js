/**
 * The role registry: one flat table of roles, the two-level chain that decides
 * a session's own role, and the derived views the tool, the panel, and the
 * prompt read (`ROLE-DISPATCH.md` §2.1, §3).
 *
 * Roles carry no relations to each other (§3.1): a record is a name, its
 * duties, and how it came to exist. Everything else the readers want —
 * `dutiesMissing`, `holders`, `open`, `unregistered` — is derived here and
 * never stored.
 *
 * Two rules shape every method:
 *
 * - establishment writes only what changed, so the common case of a session
 *   whose role is already recorded performs no write at all (§3.2);
 * - the read paths (`list`, `promptLine`, `holders`) never write, so a panel
 *   refresh or a prompt assembly cannot mutate the board (§3.2).
 */

import { TMP_ROLE_PREFIX, delegatedRoleId, fail, nowIso, parseRoleDeclaration } from './model.js'

/** Requirement states that no longer need an owner. */
const SETTLED_STATUSES = ['done', 'archived']

/**
 * Read an optional service port.
 *
 * Ports are resolvers rather than service instances because both the agent
 * registry and the preset registry are optional services that another plugin
 * may mount after this one: a captured instance would freeze the activation
 * order into the board's behaviour. Every read resolves again, so a port that
 * mounts — or unmounts — later is observed by the next call, and no caller may
 * cache the result across calls.
 * @param resolver - `() => service | undefined`, or undefined.
 * @returns the service as it exists now.
 */
function readPort(resolver) {
  return typeof resolver === 'function' ? resolver() : undefined
}

/** Read the id out of an Agent. */
function sessionOf(agent) {
  const id = agent?.id
  return typeof id === 'string' ? id : ''
}

/** Whether two role duty lists hold the same duties in the same order. */
function sameDuties(left, right) {
  return left.length === right.length && left.every((duty, index) => duty === right[index])
}

/** The role registry over one open board domain. */
export class RoleRegistry {
  /** @type {object} Roles table handle. */
  #roles
  /** @type {object} Requirements table handle. */
  #requirements
  /** @type {object} Queues table handle. */
  #queues
  /** @type {{ agents?: () => object | undefined, presets?: () => object | undefined }} */
  #ports
  /** @type {() => Promise<void>} Advances the document revision after a commit. */
  #bumpRevision

  /**
   * @param options - The open `domain`, the optional port `resolvers`, and
   * `bumpRevision`, the service's own revision write.
   */
  constructor({ domain, ports = {}, bumpRevision }) {
    this.#roles = domain.table('roles')
    this.#requirements = domain.table('requirements')
    this.#queues = domain.table('queues')
    this.#ports = { agents: ports.agents, presets: ports.presets }
    this.#bumpRevision = bumpRevision ?? (async () => {})
  }

  /** @returns the live agents service, or undefined when this composition has none. */
  #agents() {
    return readPort(this.#ports.agents)
  }

  /** @returns the live preset registry, or undefined when this composition has none. */
  #presets() {
    return readPort(this.#ports.presets)
  }

  /**
   * Resolve a live Agent's own role through the two-level chain.
   *
   * A role declared inside the Agent's preset group wins; otherwise the preset
   * id is the role, which is what gives every built-in preset a role with no
   * configuration at all (§2.1). A session with neither — no agent, no preset
   * registry, or an unbound agent — has no role, and the absence is reported as
   * `undefined` rather than invented.
   *
   * @param agent - Live Agent, or undefined.
   * @returns `{ roleId, roleName, duties, source }`, or undefined when the
   * session has no resolvable role.
   */
  resolveOwn(agent) {
    if (agent === undefined || agent === null) return undefined
    const presets = this.#presets()
    const declared = presets?.serviceFor?.(agent, 'requirementBoardRole')
    const declaredId = typeof declared?.roleId === 'string' ? declared.roleId.trim() : ''
    if (declaredId !== '') {
      const declaredName = typeof declared.roleName === 'string' ? declared.roleName.trim() : ''
      return {
        roleId: declaredId,
        roleName: declaredName === '' ? declaredId : declaredName,
        duties: Array.isArray(declared.duties) ? declared.duties.filter(duty => typeof duty === 'string' && duty !== '') : [],
        source: 'preset',
      }
    }
    const presetId = presets?.composedPreset?.(agent.ctx)
    if (typeof presetId !== 'string' || presetId.trim() === '') return undefined
    return { roleId: presetId.trim(), roleName: presetId.trim(), duties: [], source: 'observed' }
  }

  /**
   * Record the role a freshly created session resolves to.
   *
   * The stored record is left alone unless the resolution carries more than it
   * already holds: an `observed` reference never overwrites a declaration, and
   * a panel edit is never overwritten by a preset at all, so a human's naming
   * and duties survive every later session — and because `promptLine` reads this
   * record, that survival is what the model sees.
   *
   * @param agent - The Agent from `agent/created`.
   * @returns the stored record, or undefined when the session has no role.
   */
  async establish(agent) {
    const resolved = this.resolveOwn(agent)
    if (resolved === undefined) return undefined
    const existing = this.#roles.get(resolved.roleId)
    if (existing !== undefined) {
      if (existing.source === 'manual' || existing.source === 'delegated') return this.#detach(existing)
      if (resolved.source !== 'preset') return this.#detach(existing)
      if (existing.name === resolved.roleName && sameDuties(existing.duties, resolved.duties)) return this.#detach(existing)
    }
    const at = nowIso()
    const record = {
      id: resolved.roleId,
      name: resolved.roleName,
      duties: [...resolved.duties],
      source: resolved.source,
      ephemeral: false,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }
    await this.#roles.put(record.id, record)
    await this.#bumpRevision()
    return this.#detach(record)
  }

  /**
   * Create or edit a role by hand (the panel's `put`; the model has no such action).
   * @param input - Raw `{ roleId, roleName, duties }`.
   * @returns the stored record.
   */
  async put(input) {
    const declaration = parseRoleDeclaration(input)
    const existing = this.#roles.get(declaration.roleId)
    const at = nowIso()
    const record = {
      id: declaration.roleId,
      name: declaration.roleName,
      duties: declaration.duties,
      source: 'manual',
      ephemeral: false,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }
    await this.#roles.put(record.id, record)
    await this.#bumpRevision()
    return this.#detach(record)
  }

  /**
   * Delete a role by hand (the panel's `delete`).
   *
   * Requirements that still name the role are left alone: an unresolvable role
   * is a reported state (`unregistered`), not a write cascade (§3.4).
   * @param id - Role id.
   * @returns `{ id, deleted: true }`.
   */
  async remove(id) {
    const record = this.#roles.get(id)
    if (record === undefined) fail('not-found', `no role with id "${id}"`, { id })
    // Every temporary role is named `tmp-<task>`, so `put` refuses one on the
    // reserved prefix alone; deletion has no such gate and states the ownership.
    if (record.ephemeral === true) {
      fail('conflict', `role "${id}" is a temporary role bound to task "${record.boundTask ?? ''}"; task delegation owns it`, { id })
    }
    await this.#roles.delete(id)
    await this.#bumpRevision()
    return { id, deleted: true }
  }

  /**
   * Mint or replace the temporary role one task's delegation runs under
   * (`ROLE-DISPATCH.md` §3.3, §5.5 step 3).
   *
   * The id derives from the task, so one task has at most one temporary role and
   * a replacing delegation overwrites the row the previous one left. `name`
   * defaults to the id, and `duties` are whatever the delegating session passed:
   * a temporary role is routed by its binding, not by function (§3.4).
   *
   * @param input - `{ taskId, session, duties, roleName, at }`.
   * @returns the stored record.
   */
  async mintDelegated({ taskId, session, duties = [], roleName = '', at = nowIso() }) {
    const roleId = delegatedRoleId(taskId)
    const existing = this.#roles.get(roleId)
    const record = {
      id: roleId,
      name: roleName === '' ? roleId : roleName,
      duties: [...duties],
      source: 'delegated',
      ephemeral: true,
      boundSession: session,
      boundTask: taskId,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }
    await this.#roles.put(roleId, record)
    await this.#bumpRevision()
    return this.#detach(record)
  }

  /**
   * Delete the temporary role one task's delegation minted.
   *
   * `remove` refuses every temporary role because the panel owns that gate; this
   * is the delegation's own path to the same deletion, and it refuses a role that
   * is not temporary so a mis-named id cannot delete a declared role.
   *
   * @param roleId - Temporary role id.
   * @returns `{ id, deleted }`; `deleted` is `false` when the row was gone.
   */
  async removeDelegated(roleId) {
    if (roleId === '') return { id: '', deleted: false }
    const record = this.#roles.get(roleId)
    if (record === undefined) return { id: roleId, deleted: false }
    if (record.ephemeral !== true) {
      fail('conflict', `role "${roleId}" is not a temporary role, so no delegation owns it`, { id: roleId })
    }
    await this.#roles.delete(roleId)
    await this.#bumpRevision()
    return { id: roleId, deleted: true }
  }

  /**
   * Every role the board knows, plus the ids that are in use but unrecorded.
   * @returns `{ items, unregistered }`.
   */
  list() {
    const scan = this.#scan()
    const items = [...this.#roles.entries()].map(([, record]) => this.#present(record, scan))
    const unregistered = []
    if (scan !== undefined) {
      for (const [roleId, holders] of scan.presence) {
        if (this.#roles.get(roleId) !== undefined) continue
        unregistered.push({ id: roleId, dutiesMissing: (scan.declared.get(roleId) ?? []).length === 0, holders, open: this.#openCount(roleId) })
      }
      unregistered.sort((left, right) => left.id.localeCompare(right.id))
    }
    return { items, unregistered }
  }

  /**
   * How many live sessions currently resolve to a role.
   *
   * Presence is a routing hint, not liveness proof and not authorization
   * (§3.5): the counts come from the in-process agent registry, and a missing
   * agent service reports `online: null` instead of a fabricated zero.
   * @param roleId - Role id.
   * @returns `{ online, idle, running }`, or all-null with a `note` when the
   * agent registry is absent.
   */
  holders(roleId) {
    const presence = this.#presence()
    if (presence === undefined) return this.#unreachableHolders()
    return presence.get(roleId) ?? { online: 0, idle: 0, running: 0 }
  }

  /**
   * Clear the dangling references a crashed or interrupted write chain leaves
   * behind (`ROLE-DISPATCH.md` §4.1). Mount-time work: it writes no history and
   * reports what it removed.
   *
   * Three classes are settled here: a temporary role whose task is gone, a
   * queued item whose task is gone, and a role id that names a task whose
   * delegation ended without its role being deleted. The fourth class — a
   * `delegatedTo` that names a session which no longer exists — is only
   * *detected* here: the requirement write and the temporary-role deletion it
   * needs are the same settling `revoke` and `agent/disposed` run, so the ids
   * come back as `dangledDelegations` for the service to settle through that one
   * implementation.
   *
   * Gate links are settled too (§5.8): a `blocksOn` entry or a `parentId` naming
   * a requirement that does not exist is provably residue — `delete` unbinds the
   * links it removes — so the sweep drops the entry, counts the requirement as
   * unbound, and leaves a child that lost its parent as a root again.
   *
   * Detection needs the live agent registry: without it, a session that still
   * exists cannot be told from one that was destroyed, and only the rows whose
   * temporary role is already missing are provably residue. That narrower case
   * stays reported as `deferred` rather than being skipped silently.
   *
   * @returns `{ removedRoles, removedQueueItems, unboundLinks, dangledDelegations, deferred }`.
   */
  async sweep() {
    const removedRoles = []
    for (const [id, record] of [...this.#roles.entries()]) {
      if (!id.startsWith(TMP_ROLE_PREFIX)) continue
      const boundTask = typeof record.boundTask === 'string' ? record.boundTask : ''
      const task = boundTask === '' ? undefined : this.#requirements.get(boundTask)
      // A temporary role exists for exactly one task and that task names it
      // (§3.3): a row whose task is gone, or whose task routes elsewhere, is a
      // write chain that stopped between declaring the role and binding it.
      if (task !== undefined && (task.role ?? '') === id) continue
      await this.#roles.delete(id)
      removedRoles.push(id)
    }
    const removedQueueItems = []
    for (const [sessionId, queue] of [...this.#queues.entries()]) {
      const kept = []
      const dropped = []
      for (const item of queue.items) {
        if (this.#requirements.get(item.id) === undefined) dropped.push(item)
        else kept.push(item)
      }
      if (dropped.length === 0) continue
      removedQueueItems.push(...dropped.map(item => item.id))
      if (kept.length === 0) await this.#queues.delete(sessionId)
      else await this.#queues.put(sessionId, { ...queue, items: kept, updatedAt: nowIso() })
    }
    const live = this.liveSessions()
    const dangledDelegations = []
    let undecidable = 0
    for (const [id, requirement] of this.#requirements.entries()) {
      const bound = requirement.delegatedTo ?? null
      if (bound === null) continue
      if (this.#roles.get(bound.roleId) === undefined) dangledDelegations.push(id)
      else if (live === undefined) undecidable += 1
      else if (!live.has(bound.session)) dangledDelegations.push(id)
    }
    const unboundLinks = []
    for (const [id, requirement] of [...this.#requirements.entries()]) {
      const blocks = requirement.blocksOn ?? []
      const kept = blocks.filter(target => this.#requirements.get(target) !== undefined)
      const parent = requirement.parentId ?? null
      const parentGone = parent !== null && this.#requirements.get(parent) === undefined
      if (kept.length === blocks.length && !parentGone) continue
      await this.#requirements.put(id, {
        ...requirement,
        ...(kept.length === blocks.length ? {} : { blocksOn: kept }),
        ...(parentGone ? { parentId: null } : {}),
        rev: (requirement.rev ?? 0) + 1,
        updatedAt: nowIso(),
      })
      unboundLinks.push(id)
    }
    if (removedRoles.length > 0 || removedQueueItems.length > 0 || unboundLinks.length > 0) await this.#bumpRevision()
    return {
      removedRoles,
      removedQueueItems,
      unboundLinks,
      dangledDelegations,
      deferred: undecidable === 0 ? [] : [{
        reference: 'delegatedTo',
        reason: `the agent registry is absent, so ${undecidable} delegation(s) whose session may still exist cannot be told from one that was destroyed`,
      }],
    }
  }

  /**
   * The role id one live session resolves to, through the same chain the
   * prompt line uses (§2.1).
   *
   * `''` means the session resolves no role — an unbound agent, an absent
   * preset registry, or no agent at all — which is a different fact from
   * holding a role that happens to match nothing.
   * @param session - Session id; `''` resolves no role.
   * @returns the role id, or `''`.
   */
  roleIdOf(session) {
    if (session === '') return ''
    const resolved = this.resolveOwn(this.#agents()?.get?.(session))
    return resolved?.roleId ?? ''
  }

  /**
   * The sessions the live agent registry currently knows, or `undefined` when
   * this composition has no registry to ask.
   *
   * `undefined` is the answer, not an empty set: "no session exists" and "this
   * process cannot tell" lead callers to different decisions, and the sweep must
   * not treat every delegated session as destroyed merely because the registry
   * is absent.
   * @returns the session ids, or undefined.
   */
  liveSessions() {
    const agents = this.#agents()
    if (agents === undefined || typeof agents.list !== 'function') return undefined
    const ids = new Set()
    for (const agent of agents.list()) {
      const id = sessionOf(agent)
      if (id !== '') ids.add(id)
    }
    return ids
  }

  /**
   * The one prompt line naming a session's own role, or `''` when it has none.
   *
   * The role id comes from the resolution chain alone, so a panel rename never
   * changes which id a session claims work with. The name and the duties come
   * from the roles record when one exists — the table is their single owner, and
   * a human's naming survives into the model-visible layer — and from the preset
   * declaration, then the preset id, when the record was deleted or never
   * established (§2.1, §3.2).
   *
   * A role with no duties in either place says so instead of leaving the model to
   * assume it can be routed by function (§3.4).
   *
   * §6's role line still describes this paragraph as the preset's role plus its
   * duties; that wording is superseded here and corrected with the rest of §6 in
   * stage G.
   * @param session - Session id the step belongs to.
   * @returns the role paragraph.
   */
  promptLine(session) {
    if (session === '') return ''
    const agent = this.#agents()?.get?.(session)
    const resolved = this.resolveOwn(agent)
    if (resolved === undefined) return ''
    const record = this.#roles.get(resolved.roleId)
    const roleName = record?.name ?? resolved.roleName
    const duties = record?.duties ?? resolved.duties
    const abilities = duties.length === 0
      ? 'no duties recorded, so this role cannot be routed by function'
      : duties.join(', ')
    return `You are role "${resolved.roleId}" (${roleName}) — ${abilities}.`
  }

  /**
   * One pass over the live agents resolving their roles.
   *
   * `presence` counts holders per role id. `declared` keeps the duties each role
   * id's preset declares, which is what lets a role read as `dutiesMissing` only
   * when neither the table nor a declaration gives it any function.
   * @returns `{ presence, declared }`, or undefined when the agent registry is absent.
   */
  #scan() {
    const agents = this.#agents()
    if (agents === undefined || typeof agents.list !== 'function') return undefined
    const presence = new Map()
    const declared = new Map()
    for (const agent of agents.list()) {
      const resolved = this.resolveOwn(agent)
      if (resolved === undefined) continue
      const holders = presence.get(resolved.roleId) ?? { online: 0, idle: 0, running: 0 }
      holders.online += 1
      if (agent.status === 'running') holders.running += 1
      else holders.idle += 1
      presence.set(resolved.roleId, holders)
      // Only a declaration carries duties; the preset-id fallback declares none.
      if (resolved.source === 'preset' && resolved.duties.length > 0 && !declared.has(resolved.roleId)) {
        declared.set(resolved.roleId, [...resolved.duties])
      }
    }
    return { presence, declared }
  }

  /**
   * Presence of every recorded role, keyed by role id.
   * @returns the map, or undefined when the agent registry is absent.
   */
  #presence() {
    return this.#scan()?.presence
  }

  /** The holders value that reports an unreachable agent registry. */
  #unreachableHolders() {
    return { online: null, idle: null, running: null, note: 'the agent registry is absent, so presence cannot be counted' }
  }

  /**
   * How many unsettled requirements name a role.
   *
   * A requirement carries `role` since routing landed; the join counts only the
   * ones still holding work.
   * @param roleId - Role id.
   * @returns the count.
   */
  #openCount(roleId) {
    let count = 0
    for (const [, requirement] of this.#requirements.entries()) {
      if (requirement.role !== roleId) continue
      if (SETTLED_STATUSES.includes(requirement.status)) continue
      count += 1
    }
    return count
  }

  /** Project one stored record into the row the tool and the panel read. */
  #present(record, scan) {
    const holders = scan === undefined ? this.#unreachableHolders() : scan.presence.get(record.id) ?? { online: 0, idle: 0, running: 0 }
    return {
      id: record.id,
      name: record.name,
      duties: [...record.duties],
      source: record.source,
      ephemeral: record.ephemeral === true,
      ...(typeof record.boundSession === 'string' && record.boundSession !== '' ? { boundSession: record.boundSession } : {}),
      ...(typeof record.boundTask === 'string' && record.boundTask !== '' ? { boundTask: record.boundTask } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      // A role is only functionless when neither the record nor a preset
      // declaration gives it duties (§3.4).
      dutiesMissing: record.duties.length === 0 && (scan?.declared.get(record.id) ?? []).length === 0,
      holders,
      open: this.#openCount(record.id),
    }
  }

  /** A detached copy of a stored role record, so no caller mutates the table. */
  #detach(record) {
    return { ...record, duties: [...record.duties] }
  }
}
