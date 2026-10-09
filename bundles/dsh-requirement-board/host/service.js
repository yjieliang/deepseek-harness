/**
 * The board's one operation surface.
 *
 * Every capability exists exactly once here; the agent tools (`host/tools.js`)
 * and the browser routes (`host/http.js`) are two callers of these methods with
 * identical meaning and identical failures. Nothing below this file knows about
 * tools, HTTP, or prompts.
 *
 * Storage is the platform domain form: the service reads the authoritative
 * in-memory tables synchronously and routes every write through the domain's
 * single write chain. Records handed out by `table.get()`/`entries()` are the
 * stored objects themselves, so a mutation is always built from a
 * `structuredClone` of the current record and committed with `put`/`update`.
 *
 * Compare-and-set lives inside the `table.update` transform, which the platform
 * runs in the write-chain slot for the record: the revision compared is the one
 * current at commit time, so a concurrent writer cannot slip between the check
 * and the write.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { DomainError } from '@deepseek-ai/dsh-storage-domain'
import {
  PRIORITIES,
  REQ_KINDS,
  REQ_STATUSES,
  ROLE_DUTIES_MAX,
  ROLE_DUTY_MAX,
  ROLE_NAME_MAX,
  TRANSITION_ACTIONS,
  asBoolean,
  asEnum,
  asNumber,
  asRoleId,
  asString,
  asStringArray,
  delegatedRoleId,
  fail,
  mintId,
  nowIso,
} from './model.js'
import { advanceable, assertLockHeld, claimable, escalationIndex, judgeClaim, lockState, newLock, renewedLock } from './dispatch.js'
import { applyTransition, computeStats, flowPrerequisiteMissing, recomputeNodes, setChecklistEntry } from './flow.js'
import { ImageStore, IMAGE_MAX_COUNT } from './images.js'
import { applyExecution, attributeExecution, runningCount, settleExecutions, unitFromJobEvent, unitFromSubagent, unitIsStale } from './runs.js'
import { nodeIndex, normalizeTemplate, templateAtRevision, templateNodeView, templateView } from './templates.js'
import { nextRevision } from './domain.js'
import { RoleRegistry } from './roles.js'

/** Fields a caller may change through `updateRequirement`. */
const UPDATABLE = ['title', 'summary', 'description', 'priority', 'owner', 'labels', 'sessions', 'templateId', 'role', 'parentId', 'blocksOn', 'images']

/**
 * Longest plain-language summary a requirement carries.
 *
 * The field is a reader's entry point, not a second description: a summary that
 * needs more than this has grown into the detail the description holds, so the
 * bound is what keeps the two from converging.
 */
const SUMMARY_MAX = 300

/**
 * Read the plain-language summary a write carries, refusing an empty one.
 *
 * The refusal states what the field is for instead of restating its name: a
 * caller that omitted the summary learns the rule from the same message. The
 * field is required because the panel reads it first — a requirement without one
 * shows its reader the description, which is what the summary exists to spare
 * them.
 * @param value - Raw `summary` value.
 * @returns the validated summary.
 */
function asSummary(value) {
  const text = asString(value, 'summary', { max: SUMMARY_MAX })
  if (text === '') {
    fail('invalid-argument', '"summary" is required: state the requirement in one or two plain-language sentences a person can read without the technical detail', { field: 'summary', max: SUMMARY_MAX })
  }
  return text
}

/** Most `blocksOn` links one requirement may carry (§4.2). */
const BLOCKS_ON_MAX = 20

/**
 * Most historical versions one template may hold (§11.4).
 *
 * The bound is an audit tail, not a runtime parameter, so it is fixed rather than
 * configured. Exceeding it is refused with `invalid-transition` instead of
 * dropping the oldest entry: a version a requirement is pinned to must survive,
 * which is why this differs deliberately from `maxExecutions` truncation.
 */
const TEMPLATE_VERSION_LIMIT = 20

/** Most template-side audit entries retained (§11.4); the oldest are dropped. */
const TEMPLATE_CHANGE_LIMIT = 20

/**
 * Summarize what one revision changed, for the template's own audit tail (§11.4).
 *
 * The clauses are the vocabulary §11.4 fixes: a renamed template, a description
 * edit, added and removed nodes (named by node id, because the id is a node's
 * identity and a rename is a label change), a renamed node, a changed `dependsOn`
 * list, and a checklist size change. An edit that changes nothing reports
 * `无变化`, and `reviseTemplate` still appends a version for it: the caller asked
 * for a new version, and a silent no-op would hide that.
 *
 * @param before - The current template before the revision.
 * @param after - The normalized name/description/nodes of the new revision.
 * @returns the summary text stored with the change.
 */
function templateChangeSummary(before, after) {
  const parts = []
  if (before.name !== after.name) parts.push(`改名 ${before.name}→${after.name}`)
  if (before.description !== after.description) parts.push('描述更新')
  const beforeNodes = new Map(before.nodes.map(node => [node.id, node]))
  const afterNodes = new Map(after.nodes.map(node => [node.id, node]))
  for (const id of beforeNodes.keys()) if (!afterNodes.has(id)) parts.push(`-节点 ${id}`)
  for (const id of afterNodes.keys()) if (!beforeNodes.has(id)) parts.push(`+节点 ${id}`)
  for (const [id, node] of afterNodes) {
    const previous = beforeNodes.get(id)
    if (previous === undefined) continue
    if (previous.name !== node.name) parts.push(`节点 ${id} 改名 ${previous.name}→${node.name}`)
    if (previous.dependsOn.join(',') !== node.dependsOn.join(',')) {
      parts.push(`依赖 ${previous.dependsOn.join(',') || '无'}→${node.dependsOn.join(',') || '无'}`)
    }
    const beforeChecks = previous.completion?.checklist?.length ?? 0
    const afterChecks = node.completion?.checklist?.length ?? 0
    if (beforeChecks !== afterChecks) parts.push(`checklist ${beforeChecks}→${afterChecks}`)
  }
  return parts.length === 0 ? '无变化' : parts.join('、')
}

/** The revision a stored template currently is; absent reads as the first version (§11.4). */
function currentTemplateRevision(template) {
  return template.revision ?? 1
}

/**
 * Read an optional positive integer revision reference.
 *
 * A revision number is compared for equality against stored numbers, so a
 * fractional value would silently address no version at all; the integer check
 * keeps the failure `invalid-argument` instead of a later `invalid-transition`.
 * @param value - Raw boundary value.
 * @param field - Field name used in the failure message.
 * @returns the validated integer, or `undefined` when the field is absent.
 */
function asRevision(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = asNumber(value, field, undefined, { min: 1 })
  if (!Number.isInteger(parsed)) fail('invalid-argument', `"${field}" must be a positive integer`)
  return parsed
}

/**
 * The fields an AI may still change on a decision requirement (§5.7).
 *
 * A decision is the human's to answer, so an agent keeps the parts that make the
 * question readable — its wording, its priority, its labels, the pictures that
 * show it, who shares it — and loses the routing, the flow, and the state changes
 * that would let it answer the question itself.
 */
const DECISION_UPDATABLE = ['title', 'summary', 'description', 'priority', 'labels', 'sessions', 'images']

/**
 * The fields whose change redefines the work: who may run it, which flow it
 * runs, and what it waits on. Everything in {@link UPDATABLE} outside this list
 * is prose a session may fix without owning the requirement (§5.4).
 */
const STRUCTURAL_FIELDS = ['role', 'templateId', 'blocksOn', 'parentId']

/** One history entry for an action that moves no flow node. */
function lockEntry(action, requirement, at, who, note = '') {
  return {
    id: mintId('evt'),
    at,
    by: who.session,
    byName: who.name,
    action,
    from: requirement.nodeId,
    fromName: requirement.nodeId,
    to: requirement.nodeId,
    toName: requirement.nodeId,
    fromStatus: requirement.status,
    toStatus: requirement.status,
    note,
    force: false,
    durationMs: null,
  }
}

/** One requirement id from a patch, or `null` for `''`/`null`/absent. */
function asOptionalId(value, field) {
  if (value === undefined || value === null || value === '') return null
  return asString(value, field, { max: 64 })
}

/** The `blocksOn` link list of one write: bounded, deduplicated, order kept. */
function asLinks(value) {
  const links = asStringArray(value, 'blocksOn', { max: BLOCKS_ON_MAX, itemMax: 64 })
  return [...new Set(links)]
}

/** Merge template node declarations with one requirement's recorded progress. */
function buildFlow(requirement, template) {
  return template.nodes.map(node => {
    const state = requirement.nodes?.[node.id] ?? {}
    return {
      id: node.id,
      name: node.name,
      order: node.order,
      dependsOn: node.dependsOn,
      assignee: state.assignee ?? node.assignee ?? '',
      description: node.description,
      completion: node.completion,
      status: state.status ?? 'pending',
      enteredAt: state.enteredAt ?? null,
      completedAt: state.completedAt ?? null,
      checks: state.checks ?? (node.completion?.checklist ?? []).map(() => false),
      note: state.note ?? '',
    }
  })
}

/** Project one stored requirement into the view the panel and tools read. */
function presentRequirement(requirement, template) {
  const flow = buildFlow(requirement, template)
  const done = flow.filter(node => node.status === 'done').length
  const active = flow.find(node => node.status === 'active') ?? null
  return {
    ...requirement,
    template: {
      id: template.id,
      name: template.name,
      version: template.version,
      builtin: template.builtin,
      nodeCount: template.nodes.length,
    },
    flow,
    progress: {
      done,
      total: flow.length,
      ratio: flow.length === 0 ? 0 : done / flow.length,
      activeNode: active === null ? null : { id: active.id, name: active.name, enteredAt: active.enteredAt },
    },
    // The receipt of the most recent transition, so every caller gets what just
    // happened without scanning `history` itself.
    lastTransition: (requirement.history ?? []).at(-1) ?? null,
  }
}

/**
 * Whether two stored string lists hold the same values in the same order.
 *
 * Order is stored, so a reordered list is a change; a missing list reads as the
 * empty one, which is what the record schema defaults to.
 * @param before - Stored list, or undefined.
 * @param next - Validated replacement list.
 * @returns `true` when nothing would change.
 */
function sameItems(before, next) {
  const stored = Array.isArray(before) ? before : []
  return stored.length === next.length && stored.every((value, index) => value === next[index])
}

/**
 * Whether two stored image lists name the same images in the same order.
 *
 * The bytes and a ref's metadata are immutable once stored, so the ids decide
 * identity and the two lists are not compared field by field. Order is stored, so
 * a reordered list is a change; an absent list reads as the empty one, which is
 * what a record written before images existed means.
 * @param before - Stored list, or undefined.
 * @param next - Resolved replacement list.
 * @returns `true` when nothing would change.
 */
function sameImageRefs(before, next) {
  const stored = Array.isArray(before) ? before : []
  return stored.length === next.length && stored.every((ref, index) => ref.id === next[index].id)
}

/**
 * A short, bounded requirement line for prompt context and list summaries.
 *
 * `template` arrives already resolved to the requirement's pinned revision
 * (§11.4), so `templateName`/`nodeName`/`nodeIndex`/`nodeCount` describe the flow
 * that requirement actually runs rather than the newest one.
 *
 * `derived` carries what only the board as a whole can answer (§4.4): the gate
 * and escalation values and the child lists from {@link escalationIndex} and the
 * `parentId` graph, and — for a reader with a session —
 * `claimable`/`advanceable`. Those two are left out rather than guessed when the
 * caller passes neither: a line that says a session may take something it may not
 * is worse than one that says nothing.
 */
function summarize(requirement, template, derived = {}) {
  const node = template.nodes.find(candidate => candidate.id === requirement.nodeId)
  const index = nodeIndex(template, requirement.nodeId)
  return {
    id: requirement.id,
    title: requirement.title,
    // The plain-language reading travels with the summary so a list, the panel's
    // cards, and `get` all show the same sentence. A record written before the
    // field existed reads as one carrying none.
    summary: requirement.summary ?? '',
    priority: requirement.priority,
    kind: requirement.kind ?? 'task',
    requestedBy: requirement.requestedBy ?? '',
    owner: requirement.owner,
    status: requirement.status,
    templateId: requirement.templateId,
    templateName: template.name,
    // The version this requirement runs on (§11.4); a record written before
    // template versions existed reads as pinned to the first one.
    templateRevision: requirement.templateRevision ?? 1,
    nodeId: requirement.nodeId,
    nodeName: node?.name ?? requirement.nodeId,
    nodeIndex: index,
    nodeCount: template.nodes.length,
    sessions: requirement.sessions ?? [],
    parentId: requirement.parentId ?? null,
    children: [...(derived.children ?? [])],
    blocksOn: [...(requirement.blocksOn ?? [])],
    // The refs travel with the summary so a list, a catch-up diff, and the panel
    // see the same pictures as `get`. The bytes stay outside the record.
    images: (requirement.images ?? []).map(ref => ({ ...ref })),
    blockedBy: [...(derived.blockedBy ?? [])],
    gated: derived.gated ?? false,
    effectivePriority: derived.effectivePriority ?? requirement.priority,
    escalated: derived.escalated ?? false,
    ...(derived.claimable === undefined ? {} : { claimable: derived.claimable }),
    ...(derived.advanceable === undefined ? {} : { advanceable: derived.advanceable }),
    // §4.4: how many execution units are still executing. A summary carries the
    // count, not the units: a list of twenty requirements must not ship every
    // observed job to the panel (§4.1 read amplification).
    running: derived.running ?? runningCount(requirement),
    executionsTruncated: requirement.executionsTruncated === true,
    updatedAt: requirement.updatedAt,
    blockedReason: requirement.blockReason,
  }
}

/**
 * Render how long one execution unit has been executing, for the prompt (§6).
 * @param startedAt - ISO instant the unit started.
 * @param at - ISO instant of the read.
 * @returns a short age (`2m`, `1h05m`), or `?` when a stamp is unreadable.
 */
function ageText(startedAt, at) {
  const from = Date.parse(startedAt)
  const to = Date.parse(at)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '?'
  const minutes = Math.max(0, Math.round((to - from) / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** The board service. */
export class RequirementService {
  /** @type {object} Open board domain handle; the caller owns its lifecycle. */
  #domain
  /** @type {import('./config.js').ResolvedConfig} */
  #config
  /** @type {{ agents?: object, presets?: object, jobs?: object, owns?: (target: string, caller: string) => boolean | undefined }} */
  #ports
  /** @type {object} Requirements table handle. */
  #requirements
  /** @type {object} Templates table handle. */
  #templates
  /** @type {object} Queues table handle: one row per session, keyed by session id. */
  #queues
  /** @type {ImageStore} The board's pasted-image files, outside the records. */
  #images
  /** @type {RoleRegistry} Roles table, resolution chain, and derived role views. */
  #roles
  /** @type {{ warn?: (message: string) => void } | undefined} Host logger for degradations. */
  #logger
  /** @type {boolean} Whether the missing-ownership-port warning was already reported. */
  #ownershipWarned = false
  /** @type {number} Last document revision this service wrote, bumped synchronously. */
  #revision
  /**
   * @type {Map<string, Promise<void>>} Tail of each serialized write chain, keyed
   * as `requirement:<id>` or `session:<id>`; see `#serialize`.
   */
  #writeChains = new Map()
  /**
   * @type {AsyncLocalStorage<string>} Key the calling context currently holds, so
   * `#serialize` can tell a re-entrant call from a queued one.
   */
  #chainContext = new AsyncLocalStorage()
  /** @type {Set<(change: object) => void>} Change subscribers. */
  #listeners = new Set()
  /** @type {boolean} Whether the missing-execution-registry warning was already reported. */
  #executionWarned = false
  /**
   * Depth of execution-sync writes in flight. Their `domain/changed` frames are
   * the ones the merge window exists for: a burst of progress events must cost
   * one panel refetch, while a business write still notifies immediately.
   */
  #executionWrites = 0
  /** @type {object | null} Change frame waiting for the merge window to close. */
  #pendingFrame = null
  /** @type {ReturnType<typeof setTimeout> | null} Open merge window. */
  #coalesceTimer = null

  /**
   * @param options - `domain` (an open board domain), the resolved `config`,
   * the injected service `ports`, and the optional `logger` that receives named
   * degradations (a missing port is reported once, never per call). Each port is
   * a resolver (`() => service | undefined`) rather than a captured service,
   * because both the agent registry and the preset registry are optional services
   * that may mount after this plugin. Every read resolves again, so a port that
   * mounts later is observed by the next call.
   */
  constructor({ domain, config, ports = {}, logger }) {
    this.#domain = domain
    this.#config = config
    this.#ports = { agents: ports.agents, presets: ports.presets, jobs: ports.jobs, owns: ports.owns }
    this.#logger = logger
    this.#requirements = domain.table('requirements')
    this.#templates = domain.table('templates')
    this.#queues = domain.table('queues')
    this.#images = new ImageStore(config.imageDir)
    this.#roles = new RoleRegistry({ domain, ports: this.#ports, bumpRevision: () => this.#bumpRevision(), logger })
    // Seed from the healed revision so this service never writes one below the
    // stored records, even when it is built on a domain that was not bootstrapped.
    this.#revision = nextRevision(domain)
  }

  /** @returns the resolved config this service was built with. */
  get config() {
    return this.#config
  }

  /** @returns the injected optional service ports. */
  get ports() {
    return this.#ports
  }

  /**
   * Subscribe to committed changes.
   * @param listener - Called with the change frame after a commit.
   * @returns the unsubscribe function.
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Forward one committed domain change to the subscribers (§4.1).
   *
   * The frame is compact — the panel refetches its own snapshot on any change,
   * so shipping the whole record to every open stream would only add bytes.
   *
   * Execution-sync writes are merged: ten progress events on one requirement
   * must cost the panel one refetch, so those frames wait for the deployment's
   * `sseCoalesceMs` window and are then delivered once with the newest revision.
   * Definition and flow writes still forward immediately — a model waiting for
   * its own `claim` to appear must not wait on a read-amplification guard.
   * `sseCoalesceMs: 0` forwards every frame, which is the configuration the read
   * amplification case compares against.
   * @param change - The `domain/changed` payload for this domain.
   */
  publishDomainChange(change) {
    const frame = {
      revision: this.#revision,
      table: change.table,
      key: change.key,
      operation: change.operation,
    }
    if (this.#executionWrites === 0 || this.#config.sseCoalesceMs <= 0) {
      this.#deliverFrame(frame)
      return
    }
    this.#pendingFrame = frame
    if (this.#coalesceTimer !== null) return
    this.#coalesceTimer = setTimeout(() => {
      this.#coalesceTimer = null
      const pending = this.#pendingFrame
      this.#pendingFrame = null
      if (pending !== null) this.#deliverFrame(pending)
    }, this.#config.sseCoalesceMs)
    // A pending frame must never keep the process alive.
    this.#coalesceTimer.unref?.()
  }

  /**
   * Stop the merge window and drop queued frames.
   *
   * The plugin calls this when its own fiber is disposed: an HMR replacement
   * builds a new service, and a timer left behind would publish a frame for a
   * board that no longer exists.
   */
  close() {
    if (this.#coalesceTimer !== null) {
      clearTimeout(this.#coalesceTimer)
      this.#coalesceTimer = null
    }
    this.#pendingFrame = null
    this.#listeners.clear()
  }

  /**
   * Hand one frame to every subscriber, containing their failures.
   * @param frame - Compact change frame.
   */
  #deliverFrame(frame) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(frame)
      } catch (error) {
        // One broken subscriber must not stop the others, and the write it
        // describes is already committed, so there is nothing to roll back.
        void error
      }
    }
  }

  /** Resolve a template by id, failing loud when the domain has none. */
  #template(id) {
    const template = this.#templates.get(id)
    if (template === undefined) {
      fail('not-found', `no flow template with id "${id}"`, { id, known: [...this.#templates.keys()] })
    }
    return template
  }

  /**
   * Resolve one revision of an already-loaded template (§11.4).
   *
   * Every read that derives flow from a template goes through here, so a
   * requirement keeps running the flow it recorded after the template moves on. A
   * pin naming no stored version can only come from a medium edited outside this
   * plugin — the prune gate and the open-time sweep both prevent it — and it is
   * refused loud rather than silently read as the newest version.
   * @param template - Stored template record.
   * @param revision - Pinned revision, or `undefined` for the oldest reading (1).
   * @returns the resolved template.
   */
  #atRevision(template, revision) {
    const resolved = templateAtRevision(template, revision)
    if (resolved === null) {
      fail('invalid-transition', `template "${template.id}" has no revision ${revision ?? 1}`, {
        templateId: template.id,
        revision: revision ?? 1,
        current: currentTemplateRevision(template),
      })
    }
    return resolved
  }

  /**
   * The template a stored requirement runs on, resolved to its pinned revision.
   * @param requirement - Stored requirement record.
   * @returns the resolved template.
   */
  #templateFor(requirement) {
    return this.#atRevision(this.#template(requirement.templateId), requirement.templateRevision)
  }

  /**
   * Commit one transform of a template record through the domain write chain.
   *
   * Compare-and-set is judged inside the transform, at the record's commit slot,
   * so two editors appending with the same `expectedRevision` serialize: the
   * first commits `revision + 1`, and the second's transform then fails with
   * `conflict` instead of quietly pushing the version to one past it.
   * @param id - Template id.
   * @param transform - Synchronous transform of a private clone of the stored record.
   * @returns the committed record.
   */
  async #mutateTemplate(id, transform) {
    if (this.#templates.get(id) === undefined) fail('not-found', `no flow template with id "${id}"`, { id })
    let next
    try {
      next = await this.#templates.update(id, record => {
        const draft = structuredClone(record)
        return transform(draft) ?? draft
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') {
        fail('not-found', `no flow template with id "${id}"`, { id })
      }
      throw error
    }
    await this.#bumpRevision()
    return next
  }

  /**
   * The requirements bound to one template, whatever their status (§11.5).
   *
   * Prune's "is any requirement pinned here" judgment and delete's reference set
   * are the same set: a done or archived requirement still resolves its flow when
   * it is reopened, so looking only at open work would let a revision disappear
   * from under it.
   * @param templateId - Template id.
   * @returns the bound requirement records.
   */
  #requirementsBoundTo(templateId) {
    return this.#allRequirements().filter(requirement => requirement.templateId === templateId)
  }

  /** Normalize an actor record from a tool or route caller. */
  #actor(actor) {
    const source = actor ?? {}
    return {
      session: asString(source.session, 'actor.session', { max: 200 }),
      name: asString(source.name, 'actor.name', { max: 120 }),
    }
  }

  /** The requirements as the shape `flow.js` statistics consume. */
  #requirementsView() {
    return { requirements: Object.fromEntries(this.#requirements.entries()) }
  }

  /**
   * The role id one session resolves to, or `''` when it resolves none.
   * @param session - Session id.
   * @returns the role id.
   */
  #roleIdOf(session) {
    return this.#roles.roleIdOf(session)
  }

  /**
   * The requirement this session already executes besides `excludeId` (§5.4
   * row 6): one session runs one locked requirement at a time. A session that
   * holds none answers `null`.
   * @param session - Session id; `''` holds nothing.
   * @param excludeId - Requirement being claimed, which is not "another" lock.
   * @returns the locked requirement, or `null`.
   */
  #lockHeldBy(session, excludeId) {
    if (session === '') return null
    for (const [, requirement] of this.#requirements.entries()) {
      if (requirement.id === excludeId) continue
      if (requirement.lock?.session === session) return requirement
    }
    return null
  }

  /**
   * The session whose queue soft-reserves one requirement, or `null`.
   *
   * A reservation is derived from the queues table (§4.1): no record stores
   * `reservedBy`. At most one session holds it, because `queue` refuses an append
   * while another session's row names the requirement and both decisions run on
   * the domain's single write chain.
   * @param id - Requirement id.
   * @returns the reserving session id, or `null`.
   */
  #reservationOf(id) {
    for (const [session, row] of this.#queues.entries()) {
      if (row.items.some(item => item.id === id)) return session
    }
    return null
  }

  /**
   * Every stored requirement, in table order.
   *
   * The domain table handle offers `get`/`entries`/`keys`/`put`/`delete`/`update`
   * and no `values()`, so reads that need the whole board go through here.
   * @returns the requirement records.
   */
  #allRequirements() {
    return [...this.#requirements.entries()].map(([, requirement]) => requirement)
  }

  /**
   * Everything a read derives from the board as a whole (§5.9): the gate and
   * escalation index, and the child lists of the `parentId` graph.
   *
   * Recomputed per read rather than stored, so finishing a blocker lowers the
   * escalation with no write and no cache to invalidate. A read path computes it
   * once and hands the same object to every record it presents.
   * @returns `{ index, children }`; `children` maps a requirement id to the ids
   * of the requirements naming it as their parent.
   */
  #derive() {
    const records = this.#allRequirements()
    const children = new Map()
    for (const requirement of records) {
      const parent = requirement.parentId ?? null
      if (parent === null) continue
      const list = children.get(parent)
      if (list === undefined) children.set(parent, [requirement.id])
      else list.push(requirement.id)
    }
    return { index: escalationIndex(records), children }
  }

  /**
   * The two answers that belong to one reader rather than to the record (§4.4,
   * §4.5): whether this caller may take the requirement now, and whether it may
   * advance it without `force` — which asks for the lock in hand, not for the
   * claimability `claimable` answers.
   *
   * Both are asked on every read, for the session that asked: a receipt is not a
   * place for them, because a writer's receipt is not a reader's question.
   * @param requirement - Stored record.
   * @param me - Session the question is asked for; `''` asks for the panel.
   * @param derived - Value returned by `#derive()`.
   * @returns `{ claimable, advanceable }`.
   */
  #eligibility(requirement, me, derived) {
    const myRole = me === '' ? '' : this.#roleIdOf(me)
    const reservedBy = this.#reservationOf(requirement.id)
    const template = this.#templateFor(requirement)
    return {
      claimable: claimable(requirement, me, myRole, { reservedBy }),
      advanceable: advanceable(requirement, me, {
        gated: derived.index.get(requirement.id)?.gated === true,
        prerequisiteMissing: flowPrerequisiteMissing(requirement, template) !== null,
      }),
    }
  }

  /**
   * Present one stored requirement with its derived fields (§4.1).
   *
   * `reservedBy` is the join over the queues table, read here so every caller —
   * tools, panel, and prompt — sees the same value without repeating the lookup.
   * `kind` and `requestedBy` are normalized the same way: a record written before
   * they existed reads as an ordinary task with no recorded requester, and a
   * record written before pasted images existed reads as one carrying none. The gate
   * and escalation values come from `derived`, so a caller presenting many
   * requirements pays for the graph once; `claimable` and `advanceable` are per
   * reader and are added by `#eligibility` on the read paths.
   * @param requirement - Stored record.
   * @param derived - Value returned by `#derive()`.
   * @returns the presented requirement.
   */
  #present(requirement, derived = this.#derive()) {
    const presented = presentRequirement(requirement, this.#templateFor(requirement))
    const gate = derived.index.get(requirement.id)
    presented.reservedBy = this.#reservationOf(requirement.id)
    // The routing this record names may have no role record at all — a typo, or a
    // role whose record was deleted. Reporting it is what keeps unroutable work
    // visible instead of silently claimable by nobody (§3.4).
    presented.roleUnregistered = (requirement.role ?? '') !== '' && !this.#roles.has(requirement.role)
    presented.kind = requirement.kind ?? 'task'
    presented.requestedBy = requirement.requestedBy ?? ''
    // A record written before the plain-language summary existed validates
    // without the field, so every reader gets the empty string it means rather
    // than an absent key the panel would have to test for.
    presented.summary = requirement.summary ?? ''
    // A record written before template versions existed validates without the
    // field, so every reader gets the revision it runs on rather than an absent key.
    presented.templateRevision = requirement.templateRevision ?? 1
    // A record written before delegation validates without the field; every
    // reader gets the same `null` instead of an absent key.
    presented.delegatedTo = requirement.delegatedTo ?? null
    presented.parentId = requirement.parentId ?? null
    presented.blocksOn = [...(requirement.blocksOn ?? [])]
    // A record written before pasted images existed validates without the field,
    // so every reader gets the same empty list instead of an absent key.
    presented.images = (requirement.images ?? []).map(ref => ({ ...ref }))
    presented.children = [...(derived.children.get(requirement.id) ?? [])]
    presented.blockedBy = [...(gate?.blockedBy ?? [])]
    presented.gated = gate?.gated === true
    presented.effectivePriority = gate?.effectivePriority ?? requirement.priority
    presented.escalated = gate?.escalated === true
    // Execution sync (§4.2, §5.5). `execrev` is the observation revision, which
    // moves independently of `rev` so an execution write cannot invalidate the
    // `expectedRev` a caller is holding. `stale` is derived per read against the
    // deployment's stall window rather than stored, because time is not a fact a
    // write can fix.
    presented.executions = (requirement.executions ?? []).map(unit => ({
      ...unit,
      stale: unitIsStale(unit, nowIso(), this.#config.stallAfterHours),
    }))
    presented.executionsTruncated = requirement.executionsTruncated === true
    presented.execRev = requirement.execRev ?? 0
    presented.running = runningCount(requirement)
    presented.sync = this.#syncView(requirement)
    return presented
  }

  /**
   * The reader-facing execution-sync status of one requirement (§5.5).
   *
   * Three states must stay distinguishable, because they are not the same fact:
   * sync turned off, sync unable to observe, and sync observing nothing. `reason`
   * names which one holds; `gap` stays the stored "an observation was lost" mark.
   * A missing registry is reported here without writing: the deployment is
   * broken for every requirement at once, so stamping each record would turn one
   * composition mistake into a write storm.
   * @param requirement - Stored record.
   * @returns `{ enabled, gap, syncedAt, reason }`.
   */
  #syncView(requirement) {
    const stored = requirement.sync ?? { gap: false, syncedAt: null }
    if (!this.#config.executionSync) {
      return { enabled: false, gap: false, syncedAt: null, reason: 'execution-sync-disabled' }
    }
    const missing = this.#missingExecutionPorts()
    if (missing.length > 0) {
      return { enabled: true, gap: true, syncedAt: stored.syncedAt ?? null, reason: `missing-registry-${missing.join('-')}` }
    }
    return {
      enabled: true,
      gap: stored.gap === true,
      syncedAt: stored.syncedAt ?? null,
      reason: stored.gap === true ? 'unobserved-settlement' : '',
    }
  }

  /**
   * Which execution-sync ports are absent from this composition.
   *
   * Both are optional services: a board mounted without the job registry or the
   * agent registry still serves every definition write, and says so per
   * requirement instead of pretending it observed nothing.
   * @returns the missing port names, in a stable order.
   */
  #missingExecutionPorts() {
    const missing = []
    if (this.#portService('jobs') === undefined) missing.push('jobs')
    if (this.#portService('agents') === undefined) missing.push('agents')
    return missing
  }

  /**
   * One optional service port, resolved per call.
   *
   * The resolver, not the service, is held: a replacement plugin instance must be
   * observed without rebuilding this service.
   * @param name - Port name among the resolver ports (`agents`, `jobs`, `presets`).
   * @returns the live service, or `undefined` when the composition has none.
   */
  #portService(name) {
    const resolver = this.#ports[name]
    return typeof resolver === 'function' ? resolver() : undefined
  }

  /**
   * Whether one session currently holds a lock (§5.4's gate, §5.5's attribution).
   * @param session - Session id.
   * @returns the locked requirement id, or `''`.
   */
  lockHeldBy(session) {
    const record = this.#lockHeldBy(session)
    return record === null ? '' : record.id
  }

  /**
   * Report the execution-sync composition once at mount (§5.5).
   *
   * A board that cannot observe execution must say so rather than look idle: the
   * warning names the missing registry once, and the unobservable state is
   * derived per requirement so nothing has to be written to make it visible. No
   * counter moves here either — `execSync.gaps` counts observations that were
   * lost, and a registry that was never injected did not lose one; the named
   * reason in `sync` is what reports it, without a write at mount time.
   * @returns the missing port names.
   */
  assertExecutionPorts() {
    if (!this.#config.executionSync) return []
    const missing = this.#missingExecutionPorts()
    if (missing.length === 0 || this.#executionWarned) return missing
    this.#executionWarned = true
    this.#logger?.warn?.(`requirement-board: executionSync is on but this composition injects no ${missing.join('/')} service; requirements report sync.gap and execution units stay empty`)
    return missing
  }

  /**
   * One session's queue row, or undefined when it reserves nothing.
   * @param session - Session id; `''` keeps no row.
   * @returns the stored queue record.
   */
  #queueRow(session) {
    return session === '' ? undefined : this.#queues.get(session)
  }

  /**
   * The next requirement of one session's queue, or `null`.
   * @param session - Session id.
   * @returns `{ id, at }` of the head item, or `null`.
   */
  #queueHeadOf(session) {
    return this.#queueRow(session)?.items?.[0] ?? null
  }

  /**
   * Project a queue row into the receipt every queue action returns.
   * @param session - Session id the row belongs to.
   * @param record - Stored row, or undefined when the session reserves nothing.
   * @param changed - Whether the call being reported wrote.
   * @returns `{ session, sessionName, items, head, length, updatedAt, changed }`.
   */
  #presentQueue(session, record, changed) {
    const items = record?.items ?? []
    return {
      session,
      sessionName: record?.sessionName ?? '',
      items: items.map(item => ({ ...item })),
      head: items[0] === undefined ? null : { ...items[0] },
      length: items.length,
      updatedAt: record?.updatedAt ?? null,
      changed,
    }
  }

  /**
   * Run one operation after every operation already chained on `key`.
   *
   * Two kinds of key are used, and the order between them is an invariant: a
   * queue append takes `requirement:<id>` for the reservation and then
   * `session:<id>` for the row inside `#mutateQueue`, and no path takes them the
   * other way around. Nesting only ever moves inward along that order.
   *
   * The guard turns a violated order into a named error instead of a wait that
   * never ends. A context that already holds a key may take a `session:` key only
   * while holding a `requirement:` key; anything else — the same key again,
   * `session:` before `requirement:`, or a key taken from a slot that already
   * holds a session — fails with `invalid-state`. An asynchronous context is what
   * makes this decidable: a second caller waiting on a busy key is a different
   * context and queues normally, while a call made from inside the running slot
   * inherits the held key and is refused.
   *
   * The stored tail resolves on rejection, so one failed operation neither
   * rejects the next caller's turn nor loses its place in the chain, and the entry
   * is dropped once its chain has drained.
   * @param key - Chain key, `requirement:<id>`, `session:<id>`, or
   * `global:execSync` for the execution counters.
   * @param run - Operation to serialize.
   * @returns whatever `run` returns, or rejects with.
   */
  async #serialize(key, run) {
    const held = this.#chainContext.getStore()
    if (held !== undefined && !(held.startsWith('requirement:') && key.startsWith('session:'))) {
      fail('invalid-state', `write chain "${key}" was taken from inside "${held}"`, { reason: 'write-chain-order', held, key })
    }
    const task = (this.#writeChains.get(key) ?? Promise.resolve())
      .then(() => this.#chainContext.run(key, run), () => this.#chainContext.run(key, run))
    const tail = task.catch(() => {})
    this.#writeChains.set(key, tail)
    try {
      return await task
    } finally {
      if (this.#writeChains.get(key) === tail) this.#writeChains.delete(key)
    }
  }

  /**
   * Read-modify-write one session's queue row, serialized per session.
   *
   * A session that has never queued has no row to update, and the first append
   * writes the row already holding this call's item: one durable write for one
   * record, not an empty row followed by an update. That insert replaces the whole
   * row, so it would overwrite a concurrent append from the same session; the
   * session's own chain is what makes the row read, the insert, and the update
   * exclusive (§5.3: only that session writes its row). A transform that returns
   * the row unchanged commits it unchanged and leaves `updatedAt` alone, so an
   * idempotent call changes no value.
   * @param session - Session id; never `''`.
   * @param sessionName - Display name to record, or `''` to keep the stored one.
   * @param at - The instant of this write chain.
   * @param transform - `(row) => row`, run at the row's chain slot.
   * @returns the committed row.
   */
  async #mutateQueue(session, sessionName, at, transform) {
    const normalize = row => ({ ...row, sessionId: session, sessionName: sessionName === '' ? row.sessionName : sessionName })
    return await this.#serialize(`session:${session}`, async () => {
      try {
        return await this.#queues.update(session, record => {
          const next = transform(record)
          if (next === record) return record
          return normalize(next)
        })
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'missing-key')) throw error
        // The row is absent at this slot — never created, or deleted between the
        // read and the update by disposal or by an `unqueue` that emptied it.
        await this.#queues.put(session, normalize(transform({ sessionId: session, sessionName, items: [], updatedAt: at })))
        const stored = this.#queues.get(session)
        if (stored === undefined) fail('conflict', `the queue of session "${session}" disappeared while it was being written`, { session })
        return stored
      }
    })
  }

  /**
   * Drop one requirement from every queue (§5.3).
   *
   * Finishing, archiving, or deleting a requirement ends whatever reserved it: a
   * surviving reservation would keep the requirement out of every other session's
   * takeable pool. Each row is written separately, because the domain has no
   * cross-record transaction.
   * @param id - Requirement id.
   * @returns the number of reservations released.
   */
  async #releaseReservation(id) {
    let released = 0
    for (const [session, row] of [...this.#queues.entries()]) {
      if (!row.items.some(item => item.id === id)) continue
      let removed = false
      const at = nowIso()
      const queue = await this.#mutateQueue(session, '', at, record => {
        const items = record.items.filter(item => item.id !== id)
        if (items.length === record.items.length) return record
        removed = true
        return { ...record, items, updatedAt: at }
      })
      if (!removed) continue
      if (queue.items.length === 0) await this.#queues.delete(session)
      released += 1
    }
    if (released > 0) await this.#bumpRevision()
    return released
  }

  /**
   * Drop one requirement from one session's queue (§5.3).
   *
   * A delegation settlement uses this: the soft reservation was taken for a
   * binding that has just ended, and after settling the named session can no
   * longer claim the requirement at all, so leaving its reservation in place
   * would keep the requirement behind a session that cannot take it until the
   * panel cleared it by hand. A missing row, or a row that does not name the
   * requirement, releases nothing — repeating a settlement is a no-op.
   * @param session - Session whose row is checked; `''` keeps no row.
   * @param id - Requirement id.
   * @param at - Instant of the operation this release belongs to, so the queue row
   * and the record it follows carry one timestamp.
   * @returns `true` when a reservation was released.
   */
  async #releaseReservationFor(session, id, at = nowIso()) {
    if (session === '') return false
    const row = this.#queues.get(session)
    if (row === undefined || !row.items.some(item => item.id === id)) return false
    let removed = false
    await this.#mutateQueue(session, '', at, record => {
      const items = record.items.filter(item => item.id !== id)
      if (items.length === record.items.length) return record
      removed = true
      return { ...record, items, updatedAt: at }
    })
    if (!removed) return false
    const queue = this.#queues.get(session)
    if (queue !== undefined && queue.items.length === 0) await this.#queues.delete(session)
    await this.#bumpRevision()
    return true
  }

  /**
   * Name the acting session's queue head on a completion or release receipt
   * (§5.1 step 5). The hint is text for the model: nothing is claimed, nothing is
   * reserved, and no queue row is touched.
   * @param presented - The receipt being returned.
   * @param session - Acting session id.
   * @returns the receipt, with `queueHead` when this session has queued work.
   */
  #withQueueHead(presented, session) {
    const head = this.#queueHeadOf(session)
    return head === null ? presented : { ...presented, queueHead: { ...head } }
  }

  /**
   * Advance the document revision after a committed requirement or template
   * write.
   *
   * The counter moves synchronously so two writers in one tick cannot mint the
   * same revision, and the global is written with its full value because
   * `global.set` replaces rather than merges. A failure here reaches the caller
   * even though the record write already committed — the medium has no
   * multi-record transaction — and the trailing global is repaired by
   * `healRevision` on the next open.
   */
  async #bumpRevision() {
    this.#revision += 1
    const global = this.#domain.global.get()
    await this.#domain.global.set({ ...global, revision: this.#revision })
  }

  /**
   * Commit one transform of a requirement through the write chain.
   *
   * The presence check gives the ordinary `not-found`; the transform re-checks
   * at its chain slot because a queued delete can remove the record first, in
   * which case the platform rejects with `missing-key` and this maps it back.
   *
   * One write chain reads the clock once: `at` is the instant the caller's
   * transform stamps, and the lease refresh below reuses it. A second reading
   * would let `lock.touchedAt` drift past the `lock.at` just written in the same
   * commit, which would both misjudge a fresh lock as touched later and make
   * "claim" and "renewal" disagree about one instant.
   *
   * @param id - Requirement id.
   * @param expectedRev - Revision the caller read, or `undefined` for last-writer-wins.
   * @param transform - Synchronous transform of a private clone of the stored record.
   * @param touch - Session the write is made under; when it holds this
   * requirement's lock, the lease is refreshed in the same update (§5.2).
   * @param at - The instant of this write chain.
   * @returns the committed record.
   */
  async #mutateRequirement(id, expectedRev, transform, touch = '', at = nowIso()) {
    if (this.#requirements.get(id) === undefined) fail('not-found', `no requirement with id "${id}"`, { id })
    let next
    try {
      next = await this.#requirements.update(id, record => {
        if (expectedRev !== undefined && expectedRev !== null && record.rev !== expectedRev) {
          fail('conflict', `requirement "${id}" changed since revision ${expectedRev}`, {
            expected: expectedRev,
            current: record.rev,
          })
        }
        const draft = structuredClone(record)
        const result = transform(draft) ?? draft
        if (touch !== '' && result.lock != null) result.lock = renewedLock(result, touch, at)
        return result
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') {
        fail('not-found', `no requirement with id "${id}"`, { id })
      }
      throw error
    }
    await this.#bumpRevision()
    return next
  }

  /**
   * Commit one execution observation through the write chain (§4.1, §5.5).
   *
   * Execution sync is observation, not authorship: the write moves `execRev` and
   * `sync.syncedAt` and leaves `rev`, `updatedAt`, `updatedBy`, and `history`
   * alone, so progress churn cannot invalidate an `expectedRev` a caller holds
   * and cannot make a task look edited. The record's own read and the decision to
   * write happen inside this entry's chain slot, so an unchanged observation
   * costs no write at all rather than rewriting the same bytes.
   *
   * The returned `changed` says whether a commit landed, which is what the caller
   * reports; a requirement deleted mid-flight is not an error (the observation
   * has no referent and is dropped).
   * @param id - Requirement id.
   * @param transform - Synchronous transform of a private clone; returns
   * `{ changed, gap }`, where `gap` is `undefined` to leave the stored mark alone
   * and a boolean to set it.
   * @param at - Instant of the observation, written as `sync.syncedAt`.
   * @returns `{ changed, gap }`.
   */
  async #mutateExecutions(id, transform, at) {
    return await this.#serialize(`requirement:${id}`, async () => {
      const stored = this.#requirements.get(id)
      if (stored === undefined) return { changed: false, gap: false }
      const draft = structuredClone(stored)
      const outcome = transform(draft) ?? { changed: false }
      if (outcome.changed !== true) return { changed: false, gap: false }
      draft.execRev = (draft.execRev ?? 0) + 1
      draft.sync = {
        gap: outcome.gap ?? draft.sync?.gap === true,
        syncedAt: at,
      }
      this.#executionWrites += 1
      try {
        await this.#requirements.put(draft.id, draft)
        await this.#bumpRevision()
      } finally {
        this.#executionWrites -= 1
      }
      return { changed: true, gap: draft.sync.gap }
    })
  }

  /**
   * Fold one subagent lifecycle edge into the board (§5.5).
   *
   * The observed child attaches to the requirement whose owning session holds the
   * lock — the child itself after a delegation, or the parent that spawned it —
   * and an observation that matches no locked requirement is counted, not
   * stored: a session running without a lock is the normal case, not data loss.
   * @param info - `SubagentRunInfo` or `SubagentRunEndInfo` payload.
   * @param phase - `'start'` or `'end'`.
   * @returns `{ stored, ignored, requirementId }`.
   */
  async observeSubagent(info, phase) {
    if (!this.#config.executionSync) return { stored: false, ignored: false, requirementId: '' }
    const at = nowIso()
    const target = attributeExecution(this.#allRequirements(), { subject: info?.id, owns: this.#ownsPort() })
    if (target === null) {
      await this.#countIgnored()
      return { stored: false, ignored: true, requirementId: '' }
    }
    const unit = unitFromSubagent(info, { at, phase })
    const outcome = await this.#mutateExecutions(target.requirementId, draft => {
      const applied = applyExecution(draft.executions, unit, this.#config.maxExecutions)
      if (!applied.changed) return { changed: false }
      draft.executions = applied.units
      if (applied.truncated) draft.executionsTruncated = true
      return { changed: true }
    }, at)
    return { stored: outcome.changed, ignored: false, requirementId: target.requirementId }
  }

  /**
   * Fold one background-job event into the board (§5.5).
   *
   * `output` events store nothing and are not counted as ignored: they carry byte
   * coordinates, and the unit they belong to is already stored. A `removed` event
   * means the job left the visible set, which is what an unobserved settlement
   * looks like, so it marks the requirement's `sync.gap` instead of inventing an
   * outcome for a unit that is still `running`.
   * @param event - One `JobEvent` from the registry's stream.
   * @returns `{ stored, ignored, requirementId }`.
   */
  async observeJobEvent(event) {
    if (!this.#config.executionSync) return { stored: false, ignored: false, requirementId: '' }
    const at = nowIso()
    const { unit, gap } = unitFromJobEvent(event, { at })
    const owner = typeof event?.job?.owner === 'string' ? event.job.owner : (typeof event?.owner === 'string' ? event.owner : '')
    const target = attributeExecution(this.#allRequirements(), { subject: owner, owns: this.#ownsPort() })
    if (target === null) {
      // An output event for a job whose owner holds no lock is not an ignored
      // execution observation: nothing about it was ever meant to be stored.
      if (event?.type !== 'output') await this.#countIgnored()
      return { stored: false, ignored: event?.type !== 'output', requirementId: '' }
    }
    if (unit === undefined && !gap) return { stored: false, ignored: false, requirementId: target.requirementId }
    const outcome = await this.#mutateExecutions(target.requirementId, draft => {
      const applied = applyExecution(draft.executions, unit, this.#config.maxExecutions)
      if (!applied.changed) {
        return gap ? { changed: true, gap: true } : { changed: false }
      }
      draft.executions = applied.units
      if (applied.truncated) draft.executionsTruncated = true
      return { changed: true, ...(gap ? { gap: true } : {}) }
    }, at)
    return { stored: outcome.changed, ignored: false, requirementId: target.requirementId }
  }

  /**
   * Reconcile one session's live jobs against a requirement it just claimed
   * (§9-E, claim-time gap repair).
   *
   * The registry's event stream only helps while something is listening, so a job
   * that started before this plugin mounted — or while the registry was replaced
   * — exists only in `jobs.list(owner)`. Reconciliation therefore fills in what
   * the session owns now, and reports a gap for a stored `running` unit the
   * registry no longer lists: that unit settled unobserved, and guessing its
   * outcome would be worse than saying so.
   *
   * Failures are contained: a broken registry must not fail a claim that already
   * committed.
   * @param session - Claiming session id.
   * @param requirementId - Requirement it now holds.
   * @returns `{ reconciled, reason }`.
   */
  async reconcileSession(session, requirementId) {
    if (!this.#config.executionSync) return { reconciled: false, reason: 'execution-sync-disabled' }
    const jobs = this.#portService('jobs')
    if (jobs === undefined || typeof jobs.list !== 'function') {
      // Nothing can be read at all: the derived view already reports this as a
      // missing registry, so only the diagnostic counter moves.
      await this.#countGapQuietly()
      return { reconciled: false, reason: 'missing-jobs-registry' }
    }
    let listed
    try {
      listed = jobs.list(session)
    } catch (error) {
      this.#logger?.warn?.(`requirement-board: jobs.list("${session}") failed during claim reconciliation: ${String(error)}`)
      await this.#reportReconciliationFailure(requirementId, error)
      return { reconciled: false, reason: 'registry-error' }
    }
    const at = nowIso()
    const view = (Array.isArray(listed) ? listed : []).filter(job => job?.owner === session && typeof job.id === 'string')
    const live = new Set(view.map(job => job.id))
    let gap = false
    let outcome
    try {
      outcome = await this.#mutateExecutions(requirementId, draft => {
        let changed = false
        let units = [...(draft.executions ?? [])]
        for (const job of view) {
          const phase = job.status === 'running' || job.status === 'stopping' ? 'registered' : 'settled'
          const { unit } = unitFromJobEvent({ type: phase, job }, { at })
          const applied = applyExecution(units, unit, this.#config.maxExecutions)
          units = applied.units
          if (applied.changed) changed = true
          if (applied.truncated) draft.executionsTruncated = true
        }
        for (const unit of units) {
          if (unit.kind !== 'job') continue
          if (unit.status !== 'running' && unit.status !== 'stopping') continue
          if (live.has(unit.ref)) continue
          // Listed nowhere while still claiming to run: the settlement happened
          // while nothing was listening, and only the gap can say so.
          gap = true
        }
        if (changed) draft.executions = units
        // A reconciliation that accounts for every stored unit clears the gap: the
        // mark says "an observation was lost", and this is the call that repairs it.
        const wasGap = draft.sync?.gap === true
        if (!changed && !gap && !wasGap) return { changed: false }
        return { changed: true, gap }
      }, at)
    } catch (error) {
      // The claim this reconciliation follows has already committed, so a failed
      // observation write is reported and left to the next reconciliation.
      this.#logger?.warn?.(`requirement-board: reconciling the jobs of session "${session}" against "${requirementId}" failed and was ignored: ${String(error)}`)
      await this.#reportReconciliationFailure(requirementId, error)
      return { reconciled: false, reason: 'write-failed' }
    }
    return { reconciled: outcome.changed, reason: gap ? 'unobserved-settlement' : '' }
  }

  /**
   * Report a reconciliation that could not look at the registry (§5.5).
   *
   * "Could not read" and "nothing is running" are different facts, so the
   * requirement keeps a gap the next successful reconciliation clears. Both steps
   * are contained: this runs after the operation that committed, and a diagnostic
   * must never fail it.
   * @param id - Requirement the reconciliation was for.
   */
  async #reportReconciliationFailure(id) {
    try {
      await this.#mutateExecutions(id, draft => (draft.sync?.gap === true ? { changed: false } : { changed: true, gap: true }), nowIso())
    } catch (writeError) {
      this.#logger?.warn?.(`requirement-board: marking the lost execution observation on "${id}" failed: ${String(writeError)}`)
    }
    await this.#countGapQuietly()
  }

  /**
   * Move the gap counter without ever failing the caller.
   *
   * The counter is diagnostics, and it is bumped from paths that follow a commit,
   * including a synchronous mount check whose promise nobody awaits.
   */
  async #countGapQuietly() {
    try {
      await this.#countGap()
    } catch (error) {
      this.#logger?.warn?.(`requirement-board: recording the execution-sync gap failed: ${String(error)}`)
    }
  }

  /**
   * Settle the still-executing units of one requirement (§5.5).
   *
   * Called when nothing will report those units again — a disposed session, a
   * revoked delegation — so a unit cannot stay `running` forever.
   * @param id - Requirement id.
   * @param reason - Why the observation ended, stored as each unit's `detail`.
   * @returns `true` when a commit landed.
   */
  async settleExecutionUnits(id, reason) {
    if (!this.#config.executionSync) return false
    const at = nowIso()
    const outcome = await this.#mutateExecutions(id, draft => {
      const settled = settleExecutions(draft.executions, at, reason)
      if (!settled.changed) return { changed: false }
      draft.executions = settled.units
      return { changed: true }
    }, at)
    return outcome.changed
  }

  /**
   * The ownership predicate, when this composition injects one.
   * @returns `(target, caller) => boolean | undefined`, or a predicate that
   * cannot decide anything.
   */
  #ownsPort() {
    const owns = typeof this.#ports.owns === 'function' ? this.#ports.owns : undefined
    return owns ?? (() => undefined)
  }

  /**
   * Count one observation from a session without a lock (§5.5).
   *
   * The counter is a statistic, not a board change: it must not move the
   * revision, or every lockless subagent would wake every open panel.
   */
  async #countIgnored() {
    await this.#bumpExecutionCounter('ignored')
  }

  /** Count one composition gap that lost an observation (§5.5). */
  async #countGap() {
    await this.#bumpExecutionCounter('gaps')
  }

  /**
   * Increment one field of the domain's execution counters.
   * @param field - `ignored` or `gaps`.
   */
  async #bumpExecutionCounter(field) {
    await this.#serialize('global:execSync', async () => {
      const global = this.#domain.global.get()
      const execSync = { ignored: 0, gaps: 0, ...global.execSync }
      await this.#domain.global.set({ ...global, execSync: { ...execSync, [field]: (execSync[field] ?? 0) + 1 } })
    })
  }

  /**
   * List requirements with optional filters.
   * @param filter - `session`, `owner`, `status`, `priority`, `kind`, `templateId`,
   * `role`, `query`, `claimable`, `limit`, `offset`.
   * @param me - Session the `claimable` filter is asked for (`''` asks for the
   * panel); ignored by every other filter.
   * @returns `{ items, total, limit, offset }`.
   */
  listRequirements(filter = {}, me = '') {
    const session = asString(filter.session, 'session', { max: 200 })
    const owner = asString(filter.owner, 'owner', { max: 120 })
    const status = filter.status === undefined || filter.status === null || filter.status === ''
      ? undefined
      : asEnum(filter.status, [...REQ_STATUSES, 'open'], 'status')
    const priority = filter.priority === undefined || filter.priority === null || filter.priority === ''
      ? undefined
      : asEnum(filter.priority, PRIORITIES, 'priority')
    // The kind filter is a read, so it applies to an agent as well: the decision
    // queue is what the board is waiting on, and §5.6 keeps that question on the
    // server so the panel and the model answer it the same way.
    const kind = filter.kind === undefined || filter.kind === null || filter.kind === ''
      ? undefined
      : asEnum(filter.kind, REQ_KINDS, 'kind')
    const templateId = asString(filter.templateId, 'templateId', { max: 64 })
    const query = asString(filter.query, 'query', { max: 200 }).toLowerCase()
    const limit = asNumber(filter.limit, 'limit', 50, { min: 1, max: 200 })
    const offset = asNumber(filter.offset, 'offset', 0, { min: 0, max: 100000 })
    const claimableOnly = asBoolean(filter.claimable, 'claimable', false)
    // The role filter reports the routing the board is using right now: a
    // requirement delegated to a session carries that delegation's temporary role
    // id, and is found by it rather than by the role it returns to when the
    // delegation ends. §5.5 stores that role id on the record, so the filter needs
    // no second source of truth — and `?role=human` is the human's inbox without
    // also claiming work that is currently with a sub-session.
    const role = filter.role === undefined || filter.role === null || filter.role === '' ? '' : asRoleId(filter.role)
    const myRole = me === '' ? '' : this.#roleIdOf(me)
    const derived = this.#derive()
    const items = []
    for (const [, requirement] of this.#requirements.entries()) {
      const settled = requirement.status === 'done' || requirement.status === 'archived'
      if (status === 'open' ? settled : status !== undefined && requirement.status !== status) continue
      if (priority !== undefined && requirement.priority !== priority) continue
      if (kind !== undefined && (requirement.kind ?? 'task') !== kind) continue
      if (owner !== '' && requirement.owner !== owner) continue
      if (templateId !== '' && requirement.templateId !== templateId) continue
      if (session !== '' && !(requirement.sessions ?? []).includes(session)) continue
      if (role !== '' && (requirement.role ?? '') !== role) continue
      if (query !== '' && !`${requirement.title}\n${requirement.summary ?? ''}\n${requirement.description}\n${requirement.id}`.toLowerCase().includes(query)) continue
      if (claimableOnly && !claimable(requirement, me, myRole, { reservedBy: this.#reservationOf(requirement.id) })) continue
      items.push(requirement)
    }
    items.sort((a, b) => {
      const byUpdate = String(b.updatedAt).localeCompare(String(a.updatedAt))
      return byUpdate !== 0 ? byUpdate : a.id.localeCompare(b.id)
    })
    const page = items.slice(offset, offset + limit).map(requirement => {
      const template = this.#templates.get(requirement.templateId) ?? { id: requirement.templateId, name: requirement.templateId, nodes: [] }
      return summarize(requirement, this.#atRevision(template, requirement.templateRevision), {
        ...derived.index.get(requirement.id),
        children: derived.children.get(requirement.id) ?? [],
        ...this.#eligibility(requirement, me, derived),
      })
    })
    return { items: page, total: items.length, limit, offset }
  }

  /**
   * Read one requirement with its flow, its gates, and its full retained history.
   *
   * `claimable` and `advanceable` are answered for `me` (§5.6): "get before you
   * claim" has to answer whether *this* session may take it or move it on, which
   * is why the reader's session is a parameter here while the receipts elsewhere
   * carry the record's own values only.
   * @param id - Requirement id.
   * @param me - Session the two eligibility values are asked for; `''` asks for
   * the panel.
   * @returns the presented requirement.
   */
  getRequirement(id, me = '') {
    const session = asString(me, 'session', { max: 200 })
    const requirement = this.#requirements.get(id)
    if (requirement === undefined) fail('not-found', `no requirement with id "${id}"`, { id })
    const derived = this.#derive()
    return {
      ...this.#present(requirement, derived),
      ...this.#eligibility(requirement, session, derived),
    }
  }

  /**
   * Store one pasted image and answer with the ref a requirement then carries.
   *
   * The bytes never enter a record: one file — and the metadata file beside it —
   * lands under this deployment's image directory, and the returned ref is what a
   * later `images` field names. The media type is the upload's own header value
   * and must be one of the four accepted still-image types; an unsupported type,
   * an empty body, and a body past the cap are refused before a byte is written.
   * @param input - `{ bytes, mediaType, name }`; `bytes` is the raw request body,
   * `mediaType` its `content-type`, and `name` the original file name (absent
   * means unnamed).
   * @returns the stored image ref.
   */
  async storeImage(input = {}) {
    return await this.#images.put(input)
  }

  /**
   * The bytes and media type of one stored image.
   * @param id - Image id, as an `images` entry names it.
   * @returns `{ mediaType, bytes }`.
   */
  async readImage(id) {
    const key = asString(id, 'id', { max: 64 })
    const stored = await this.#images.read(key)
    if (stored === undefined) fail('not-found', `no stored image with id "${key}"`, { id: key })
    return stored
  }

  /**
   * The absolute file path of one image ref, which is how an agent opens it.
   *
   * Paths are a host fact rather than a wire one, so they are produced here and
   * nowhere else: the panel builds its own URL from the ref's id, while a tool
   * result carries both locations for the model.
   * @param ref - Stored image ref.
   * @returns the absolute path of the ref's bytes file.
   */
  imageFilePath(ref) {
    return this.#images.filePath(ref)
  }

  /**
   * Resolve the image ids one write carries into the refs they name.
   *
   * The ids are the record's own reference form; an id naming no stored image is
   * refused loud rather than stored as a dangling ref, so a caller learns at the
   * write that the upload never landed.
   * @param ids - Image ids from a `create`/`update` payload, or absent.
   * @returns the resolved refs, in the order given.
   */
  async #imageRefs(ids) {
    const refs = []
    for (const id of asStringArray(ids, 'images', { max: IMAGE_MAX_COUNT, itemMax: 64 })) {
      const ref = await this.#images.ref(id)
      if (ref === undefined) fail('invalid-image', `no stored image with id "${id}"`, { id })
      refs.push(ref)
    }
    return refs
  }

  /**
   * Create a requirement bound to a flow template.
   *
   * `kind` is fixed here and never again (§5.7): a `decision` requirement asks a
   * person to choose, so no later write may turn it into ordinary work. Together
   * with `requestedBy` — the caller as a person reads it, so the name the caller
   * gave, else the name the agent registry holds for it, else its session id — this
   * is the whole of the decision queue's "who is waiting for you". A tool call
   * carries no display name, so without the registry step every agent-created
   * decision would read as a bare session id.
   * @param input - `title`, `summary`, `description`, `kind`, `priority`, `owner`, `sessions`, `labels`, `templateId`, `parentId`, `blocksOn`, `images`, `note`.
   * @param actor - `{ session, name }` of the caller.
   * @returns the presented requirement.
   */
  async createRequirement(input = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const title = asString(input.title, 'title', { required: true, max: 200 })
    const namedTemplate = input.templateId !== undefined && input.templateId !== null && input.templateId !== ''
    const templateId = namedTemplate ? asString(input.templateId, 'templateId', { max: 64 }) : this.#config.defaultTemplateId
    const template = this.#template(templateId)
    // An archived template stays readable and keeps serving the requirements
    // already bound to it, but it is not offered as a new binding (§11.5). The
    // deployment's default template cannot be archived, so the implicit path
    // never reaches this refusal.
    if (namedTemplate && template.archived === true) {
      fail('invalid-transition', `template "${template.id}" is archived and cannot be bound to a new requirement`, { id: template.id })
    }
    const first = template.nodes[0]
    const sessions = asStringArray(input.sessions, 'sessions', { max: 50, itemMax: 200 })
    if (who.session !== '' && !sessions.includes(who.session)) sessions.unshift(who.session)
    const id = mintId('req')
    const parentId = asOptionalId(input.parentId, 'parentId')
    const blocksOn = asLinks(input.blocksOn)
    this.#assertLinks({ id, parentId, blocksOn })
    const requirement = {
      id,
      title,
      summary: asSummary(input.summary),
      description: asString(input.description, 'description', { max: 8000 }),
      kind: asEnum(input.kind, REQ_KINDS, 'kind', 'task'),
      priority: asEnum(input.priority, PRIORITIES, 'priority', 'normal'),
      owner: asString(input.owner, 'owner', { max: 120 }),
      role: asRoleId(input.role),
      sessions,
      templateId: template.id,
      // §11.4 write point ①: a new requirement is pinned to the template's
      // *current* revision. Reading the absent field as 1 is only for records
      // written before template versions existed; without this write a
      // requirement created after the template reached v2 would keep running v1.
      templateRevision: currentTemplateRevision(template),
      nodeId: first.id,
      status: 'active',
      blockReason: '',
      blockedAt: null,
      labels: asStringArray(input.labels, 'labels', { max: 20, itemMax: 60 }),
      // `images` arrives as stored ids and leaves as the refs they name, so an
      // unknown id is refused before any part of the record is written.
      images: await this.#imageRefs(input.images),
      parentId,
      blocksOn,
      nodes: {},
      history: [],
      // `create` never locks: the creator owns the requirement, but the work
      // starts only when someone claims it (§5.1).
      lock: null,
      // A delegation is always an explicit later step (`delegate`); a created
      // requirement is routed by `role` alone.
      delegatedTo: null,
      rev: 1,
      createdAt: at,
      updatedAt: at,
      createdBy: who.session,
      updatedBy: who.session,
      requestedBy: who.name !== '' ? who.name : (this.#sessionName(who.session) || who.session),
    }
    requirement.nodes = recomputeNodes(requirement, template, at, { to: first.id })
    requirement.history.push({
      id: mintId('evt'),
      at,
      by: who.session,
      byName: who.name,
      action: 'create',
      from: null,
      fromName: '',
      to: first.id,
      toName: first.name,
      fromStatus: null,
      toStatus: 'active',
      note: asString(input.note, 'note', { max: 500 }),
      force: false,
      durationMs: null,
    })
    await this.#requirements.put(id, requirement)
    await this.#bumpRevision()
    return this.#present(requirement)
  }

  /**
   * Take the execution lock for one requirement (§5.1 step 2).
   *
   * The judgment runs inside the write chain, so two sessions claiming the same
   * requirement at once are serialized by that record's update slot and exactly
   * one wins. A session that already holds the lock renews its lease and adds
   * no second history entry. The panel has no claim at all: a lock owned by the
   * human's empty session id would refuse every AI session until the lease ran
   * out.
   *
   * A soft reservation by another session refuses the claim with
   * `conflict{reserved}` and changes no queue; a session that is already
   * executing something else is refused with `conflict{session-busy}`, whose
   * details name that session's own queue head so the receipt can say what is
   * next (§5.3, §5.4).
   *
   * @param id - Requirement id.
   * @param input - `{ expectedRev }`.
   * @param actor - `{ session, name }` of the caller; `session` must be set.
   * @returns the presented requirement, locked by this session.
   */
  async claim(id, input = {}, actor) {
    const who = this.#actor(actor)
    if (who.session === '') {
      fail('invalid-argument', 'claim needs the calling session: the panel holds no lock and cannot take one', { reason: 'session-required' })
    }
    const at = nowIso()
    const requirement = await this.#mutateRequirement(id, input.expectedRev, draft => {
      const verdict = judgeClaim({
        record: draft,
        session: who.session,
        myRole: this.#roleIdOf(who.session),
        holding: this.#lockHeldBy(who.session, draft.id),
        reservedBy: this.#reservationOf(draft.id),
        queueHead: this.#queueHeadOf(who.session),
        now: at,
        leaseHours: this.#config.staleClaimHours,
      })
      draft.lock = verdict.idempotent ? { ...draft.lock, touchedAt: at } : newLock(who.session, who.name, at)
      draft.updatedAt = at
      draft.updatedBy = who.session
      draft.rev = (draft.rev ?? 0) + 1
      if (!verdict.idempotent) draft.history.push(lockEntry('claim', draft, at, who))
      return draft
    }, who.session, at)
    // Claim is the point where the board learns the requirement's owner and can
    // bound the window a registry event was missed in (§9-E): the session's live
    // jobs are read once and folded in. The claim already committed, so a broken
    // registry downgrades to a gap instead of failing a write that landed.
    await this.reconcileSession(who.session, id)
    const fresh = this.#requirements.get(id)
    return this.#present(fresh ?? requirement)
  }

  /**
   * Release the execution lock (§5.1 step 5).
   *
   * Releasing a requirement nobody locked writes nothing and succeeds: the
   * caller asked for a state the requirement is already in. A session may
   * release only its own lock; the panel (`session === ''`) is the human and
   * may release anyone's, which is how work left by a dead session is recovered
   * before its lease expires. The receipt names the acting session's queue head
   * when it has one, so the next requirement is visible without another read.
   *
   * @param id - Requirement id.
   * @param input - `{ note, expectedRev }`.
   * @param actor - `{ session, name }` of the caller.
   * @returns the presented requirement.
   */
  async release(id, input = {}, actor) {
    const who = this.#actor(actor)
    const stored = this.#requirements.get(id)
    if (stored === undefined) fail('not-found', `no requirement with id "${id}"`, { id })
    if (stored.lock === null || stored.lock === undefined) {
      return this.#present(stored)
    }
    const at = nowIso()
    const note = asString(input.note, 'note', { max: 500 })
    const requirement = await this.#mutateRequirement(id, input.expectedRev, draft => {
      const lock = draft.lock ?? null
      if (lock === null) return draft
      if (who.session !== '' && lock.session !== who.session) {
        fail('forbidden', `"${draft.id}" is locked by session "${lock.session}"`, { reason: 'not-lock-holder', id: draft.id, current: lock })
      }
      draft.lock = null
      draft.updatedAt = at
      draft.updatedBy = who.session
      draft.rev = (draft.rev ?? 0) + 1
      draft.history.push(lockEntry('release', draft, at, who, note))
      return draft
    }, who.session, at)
    return this.#withQueueHead(this.#present(requirement), who.session)
  }

  /**
   * Reserve one requirement in the calling session's queue (§5.3).
   *
   * Queueing is a soft reservation, not a lock: it takes nothing, starts
   * nothing, and does not write the requirement at all, so a queue append never
   * advances that record's revision. The judgment is the claim table without its
   * last row (`judgeClaim` with `holding: null`), so "may I queue this" and "may
   * I claim this" cannot disagree — in particular a session that is already
   * executing something may reserve its next requirement.
   *
   * Appending a requirement the queue already holds changes nothing. Beyond
   * `maxQueueItems` the append is refused rather than dropping an earlier
   * reservation.
   *
   * A first append is two durable writes — the session's row, holding the item,
   * and the global revision — because the row is created with the item rather than
   * emptied first. Two sessions appending one requirement at the same instant are
   * arbitrated per requirement, so exactly one item is still recorded.
   *
   * @param id - Requirement id.
   * @param input - Unused; kept so every action takes the same argument list.
   * @param actor - `{ session, name }` of the caller; `session` must be set.
   * @returns the calling session's queue receipt.
   */
  async queue(id, input = {}, actor) {
    const who = this.#actor(actor)
    if (who.session === '') {
      fail('invalid-argument', 'queue needs the calling session: the panel reserves nothing, it hands work out; clear a reservation with "unqueue" and "targetSession"', { reason: 'session-required' })
    }
    const stored = this.#requirements.get(id)
    if (stored === undefined) fail('not-found', `no requirement with id "${id}"`, { id })
    const before = this.#queueRow(who.session)
    if (before?.items?.some(item => item.id === id) === true) {
      return this.#presentQueue(who.session, before, false)
    }
    const at = nowIso()
    // The reservation is arbitrated per requirement: queue rows are keyed per
    // session, so the storage layer's per-row chain cannot serialize two sessions
    // appending the same requirement. Holding this slot is what lets the first
    // append write its row once and still leave exactly one reservation.
    return await this.#serialize(`requirement:${id}`, async () => {
      let appended = false
      const row = await this.#mutateQueue(who.session, who.name, at, record => {
        if (record.items.some(item => item.id === id)) return record
        // The record is read again in this slot: a queued delete can remove it
        // before the append lands, and a reservation on a deleted requirement could
        // never be claimed.
        const requirement = this.#requirements.get(id)
        if (requirement === undefined) fail('not-found', `no requirement with id "${id}"`, { id })
        judgeClaim({
          record: requirement,
          session: who.session,
          myRole: this.#roleIdOf(who.session),
          holding: null,
          reservedBy: this.#reservationOf(id),
          now: at,
          leaseHours: this.#config.staleClaimHours,
        })
        if (record.items.length >= this.#config.maxQueueItems) {
          fail('invalid-input', `the queue of session "${who.session}" holds ${record.items.length} requirement(s), which is the configured maximum`, {
            reason: 'queue-full',
            max: this.#config.maxQueueItems,
          })
        }
        appended = true
        return { ...record, items: [...record.items, { id, at }], updatedAt: at }
      })
      // The delete can also land between the judgment above and the row write, so
      // the reservation is given back rather than left as an item nobody can claim.
      if (appended && this.#requirements.get(id) === undefined) {
        await this.unqueue(id, {}, actor)
        fail('not-found', `no requirement with id "${id}"`, { id })
      }
      if (appended) await this.#bumpRevision()
      return this.#presentQueue(who.session, row, appended)
    })
  }

  /**
   * Remove one requirement from a queue (§5.3).
   *
   * Removing what is not reserved writes nothing and succeeds. A session removes
   * only its own reservation; the panel passes `targetSession` — the operation
   * target, separate from the actor — and may clear any session's reservation,
   * which is how a person takes back work an AI reserved and stopped (§2.5).
   *
   * @param id - Requirement id.
   * @param input - `{ targetSession }`, accepted from the panel only.
   * @param actor - `{ session, name }` of the caller.
   * @returns the queue receipt of the session whose row was read.
   */
  async unqueue(id, input = {}, actor) {
    const who = this.#actor(actor)
    const targetSession = asString(input.targetSession, 'targetSession', { max: 200 })
    if (targetSession !== '' && who.session !== '') {
      fail('forbidden', `session "${who.session}" may only clear its own reservation`, { reason: 'panel-only', targetSession })
    }
    const session = targetSession === '' ? who.session : targetSession
    if (session === '') {
      fail('invalid-argument', 'unqueue needs a session: the panel passes "targetSession" to name whose reservation to clear', { reason: 'session-required' })
    }
    const before = this.#queueRow(session)
    if (before === undefined || !before.items.some(item => item.id === id)) {
      return this.#presentQueue(session, before, false)
    }
    const at = nowIso()
    let removed = false
    const row = await this.#mutateQueue(session, who.session === session ? who.name : '', at, record => {
      const items = record.items.filter(item => item.id !== id)
      if (items.length === record.items.length) return record
      removed = true
      return { ...record, items, updatedAt: at }
    })
    if (!removed) {
      // The row appeared between the read above and this slot, or the item was
      // already gone: an empty row is residue here, as it is after a removal.
      if (row.items.length === 0) await this.#dropQueueRow(session)
      return this.#presentQueue(session, row.items.length === 0 ? undefined : row, false)
    }
    if (row.items.length === 0) await this.#dropQueueRow(session)
    await this.#bumpRevision()
    return this.#presentQueue(session, row.items.length === 0 ? undefined : row, true)
  }

  /**
   * Delete one session's queue row after it was emptied.
   *
   * The check and the delete are two writes, because the domain has no
   * transaction across them, but both run on the session's chain: an append
   * queued behind the emptying append therefore re-creates the row instead of
   * having it deleted underneath the item it just wrote.
   * @param session - Session id of the empty row.
   */
  async #dropQueueRow(session) {
    await this.#serialize(`session:${session}`, async () => {
      if ((this.#queues.get(session)?.items?.length ?? 0) === 0) await this.#queues.delete(session)
    })
  }

  /**
   * Read one session's queue without writing (§5.3).
   * @param session - Session id; `''` reserves nothing.
   * @returns the queue receipt.
   */
  queueOf(session) {
    return this.#presentQueue(session, this.#queueRow(session), false)
  }

  /**
   * Name one session to run one requirement, under a temporary role (§5.5).
   *
   * `delegate{revoke:true}` is the other half of the same action: it ends the
   * delegation through the one settling implementation every end of a delegation
   * shares. Both forms refuse before they write, in the order the section lists:
   * the caller's own eligibility, its relation to the requirement, the target,
   * the state, then the lock.
   *
   * A target that already holds the lock is adopted, not refused: a sub-session
   * inherits its parent's role, so it may legitimately claim the requirement
   * before the parent delegates it, and the delegation then only records the
   * binding. Repeating a delegation settles the one it replaces first, so the
   * value the new binding records as `roleBefore` is the role the requirement
   * returns to — never a temporary id.
   *
   * The session a delegation already names may delegate onward to a sub-session of
   * its own: it is eligible for the requirement through that binding, so eligibility
   * and relation are not re-asked of the work it is handing down. A reservation by
   * a third session is refused (`conflict`), because the named session would then
   * be unable to claim what it was just given; the target's own reservation is the
   * adoption path; and the caller's own reservation is released by this call, since
   * the promise to run the requirement next ends when the requirement is handed on.
   *
   * @param id - Requirement id.
   * @param input - `{ session, duties, roleName, revoke, note, expectedRev }`.
   * @param actor - `{ session, name }` of the caller; `''` is the panel.
   * @returns the presented requirement plus `roleId`, the temporary role this
   * call minted or removed, and `changed` on a `revoke`: `false` when there was
   * no delegation to end, so the call is a no-op success like `unqueue` and a
   * lock-less `release`, and `true` when one was settled.
   */
  async delegate(id, input = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const stored = this.#requirements.get(id)
    if (stored === undefined) fail('not-found', `no requirement with id "${id}"`, { id })
    if (asBoolean(input.revoke, 'revoke', false)) {
      return await this.#revokeDelegation(id, input, who)
    }
    const session = asString(input.session, 'session', { required: true, max: 200 })
    // The role the caller's eligibility is measured against is the role the
    // requirement has once any current delegation is settled, because a repeating
    // delegation settles it first (§5.5). That is also why a stored `roleBefore`
    // can never be the temporary id the caller is looking at now.
    const bound = stored.delegatedTo ?? null
    const effectiveRole = bound === null ? (stored.role ?? '') : (bound.roleBefore ?? '')
    // A session already named by this delegation may delegate onward to a
    // sub-session of its own: it is the one session that can run the task now, so
    // the eligibility and relation checks below are both satisfied by its binding.
    const delegatedToMe = bound !== null && bound.session === who.session
    if (who.session !== '') {
      if ((stored.kind ?? 'task') === 'decision') {
        fail('forbidden', `"${id}" is a decision requirement: only the human decides it`, { reason: 'decision-task', id })
      }
      if (!delegatedToMe && !this.#roleAllows(effectiveRole, who.session)) {
        fail('forbidden', bound === null
          ? `session "${who.session}" cannot take "${id}" itself: it is routed to role "${effectiveRole}"`
          : `session "${who.session}" cannot take "${id}" itself: it returns to role "${effectiveRole}" when the current delegation ends`, {
          reason: 'role-mismatch',
          id,
          role: effectiveRole,
          myRole: this.#roleIdOf(who.session),
        })
      }
      if (!delegatedToMe && !this.#relatedTo(stored, who.session)) {
        fail('forbidden', `session "${who.session}" is neither the creator, the owner, nor a member of "${id}"`, { reason: 'not-related', id })
      }
    }
    if (session === who.session) {
      fail('invalid-input', `session "${who.session}" cannot delegate "${id}" to itself; claim it instead`, { reason: 'delegate-to-self', id })
    }
    if (stored.status === 'done' || stored.status === 'archived') {
      fail('invalid-state', `"${id}" is ${stored.status} and can no longer be delegated`, { reason: 'invalid-state', id, status: stored.status })
    }
    const holder = stored.lock?.session ?? ''
    const previous = bound?.session ?? ''
    // The same gate the claim table uses, so an orphaned or expired lock of a
    // session that is gone does not block a delegation while a live holder that
    // is not the target does. A holder that is exactly the delegation being
    // replaced is settled below, so it does not count here either.
    if (holder !== '' && holder !== session && holder !== previous
      && !lockState(stored, session, at, this.#config.staleClaimHours).allows) {
      fail('conflict', `"${id}" is locked by session "${holder}"`, { reason: 'locked', id, current: stored.lock })
    }
    // A reservation decides who is next, so it is judged like a claim's (§5.3):
    // the target's own reservation is the adoption path, and a reservation by
    // anyone else would leave the named session unable to claim what it was just
    // given, which is the state this refusal prevents.
    const reserving = this.#reservationOf(id)
    if (reserving !== null && reserving !== session && reserving !== who.session) {
      fail('conflict', `"${id}" is reserved by session "${reserving}"; the reservation must be cleared before it can be delegated`, {
        reason: 'reserved',
        id,
        reservedBy: reserving,
      })
    }
    // The delegating session's own reservation was its promise to run this next;
    // handing the requirement over ends that promise, so the reservation goes with
    // the delegation rather than blocking the session that was just named. The
    // target's own reservation stays — taking the task is what its queue was for.
    // The release runs after the requirement is written, not here: every refusal
    // above and inside that write must leave the caller's queue untouched, and a
    // delegation that did not land must not silently drop the reservation.
    const ownReservation = reserving !== null && who.session !== '' && reserving === who.session
    this.#assertOwnedTarget(session, who.session)
    if (bound !== null) {
      await this.#settleDelegation(id, {
        lock: 'release',
        actor: who,
        note: `replaced by a delegation to session "${session}"`,
      })
    }
    // Read after the settling above: this is the role the requirement returns to,
    // which is what makes a stored `roleBefore` never a temporary id (§5.5).
    const current = this.#requirements.get(id)
    if (current === undefined) fail('not-found', `no requirement with id "${id}"`, { id })
    const roleBefore = current.role ?? ''
    const roleId = delegatedRoleId(id)
    const duties = asStringArray(input.duties, 'duties', { max: ROLE_DUTIES_MAX, itemMax: ROLE_DUTY_MAX })
    const roleName = asString(input.roleName, 'roleName', { max: ROLE_NAME_MAX })
    // The role is declared before the requirement names it, so a requirement never
    // routes to an id that has no row. A refused requirement write — a concurrent
    // delegation, a lock that moved — would otherwise leave the declared row as
    // residue, so it is taken back here instead of waiting for the mount sweep.
    await this.#roles.mintDelegated({ taskId: id, session, duties, roleName, at })
    let requirement
    try {
      requirement = await this.#mutateRequirement(id, input.expectedRev, draft => {
        if (draft.status === 'done' || draft.status === 'archived') {
          fail('invalid-state', `"${id}" became ${draft.status} before the delegation landed`, { reason: 'invalid-state', id, status: draft.status })
        }
        if (!lockState(draft, session, at, this.#config.staleClaimHours).allows) {
          fail('conflict', `"${id}" is locked by session "${draft.lock?.session ?? ''}"`, { reason: 'locked', id, current: draft.lock })
        }
        const raced = draft.delegatedTo ?? null
        if (raced !== null) {
          fail('conflict', `"${id}" was delegated to session "${raced.session}" at the same time`, { reason: 'delegated', id, delegatedTo: raced })
        }
        draft.role = roleId
        draft.delegatedTo = { session, name: this.#sessionName(session), roleId, roleBefore, at }
        draft.updatedAt = at
        draft.updatedBy = who.session
        draft.rev = (draft.rev ?? 0) + 1
        draft.history.push(lockEntry('delegate', draft, at, who, `role "${roleBefore}" -> "${roleId}" for session "${session}"`))
        return draft
      }, who.session, at)
    } catch (error) {
      // The write can fail after it committed — the revision write or a change
      // subscriber throws — so only a row the requirement does not route to is
      // provably residue; the sweep would settle the rest.
      if ((this.#requirements.get(id)?.role ?? '') !== roleId) {
        await this.#roles.removeDelegated(roleId).catch(cleanupError => {
          this.#logger?.warn?.(`requirement-board: taking back the temporary role "${roleId}" after a refused delegation failed: ${String(cleanupError)}`)
        })
      }
      throw error
    }
    if (!ownReservation) return { ...this.#present(requirement), roleId }
    await this.#releaseReservationFor(who.session, id, at)
    return { ...this.#present(this.#requirements.get(id) ?? requirement), roleId }
  }

  /**
   * End one requirement's delegation on request (§5.5).
   *
   * Refuses with the caller's eligibility measured against the role the
   * requirement returns to, so the authority to end a delegation is the authority
   * that could have made it. Ending a delegation that is already gone writes
   * nothing and succeeds: the caller asked for a state the requirement is in.
   * @param id - Requirement id.
   * @param input - `{ note, expectedRev }`.
   * @param who - `{ session, name }` of the caller.
   * @returns the presented requirement plus `roleId`, `''` when nothing was bound,
   * and `changed`, `false` when this call had nothing to end.
   */
  async #revokeDelegation(id, input, who) {
    const stored = this.#requirements.get(id)
    if (stored === undefined) fail('not-found', `no requirement with id "${id}"`, { id })
    const note = asString(input.note, 'note', { max: 500 })
    const bound = stored.delegatedTo ?? null
    this.#assertHumanOnly(stored, who, 'revoke a delegation on')
    if (who.session !== '') {
      const role = bound?.roleBefore ?? ''
      if (!this.#roleAllows(role, who.session)) {
        fail('forbidden', `session "${who.session}" cannot take "${id}" itself: it is routed to role "${role}"`, {
          reason: 'role-mismatch',
          id,
          role,
          myRole: this.#roleIdOf(who.session),
        })
      }
      if (!this.#relatedTo(stored, who.session)) {
        fail('forbidden', `session "${who.session}" is neither the creator, the owner, nor a member of "${id}"`, { reason: 'not-related', id })
      }
    }
    if (bound === null) return { ...this.#present(stored), roleId: '', changed: false }
    await this.#settleDelegation(id, { lock: 'release', actor: who, note })
    const settled = this.#requirements.get(id) ?? stored
    return { ...this.#present(settled), roleId: bound.roleId, changed: true }
  }

  /**
   * End one requirement's delegation and settle what it owned (§3.3).
   *
   * Every end of a delegation runs this one implementation: `revoke`, the
   * `agent/disposed` listener, a replacing `delegate`, task completion, task
   * archiving, deletion, and the mount-time sweep. It reverts `role` to
   * `roleBefore`, clears `delegatedTo`, deletes the temporary role, and settles
   * the execution lock — `'release'` when the delegation ends while its session is
   * alive, `'orphan'` when that session is gone so another session may take over
   * at once and the record keeps the evidence, `'keep'` when only a missing role
   * row is being repaired and the live holder's lock must not move. Settling this
   * requirement's execution units joins here once `executions` exists (stage E);
   * today the lock and the temporary role are the whole state a delegation owns.
   *
   * `actor` names who the `revoke-delegation` entry is written for; without one
   * the call is lifecycle work and writes no history entry (§4.7).
   * @param id - Requirement id.
   * @param options - `lock` mode, `actor`, `note`.
   * @returns `{ roleId, releasedLock, orphaned, releasedReservation }`; `roleId`
   * is `''` when nothing was bound, and `releasedReservation` says whether the
   * named session's soft reservation on the requirement was dropped.
   */
  async #settleDelegation(id, { lock = 'release', actor, note = '' } = {}) {
    const stored = this.#requirements.get(id)
    const bound = stored?.delegatedTo ?? null
    if (stored === undefined || bound === null) return { roleId: '', releasedLock: false, orphaned: false }
    const at = nowIso()
    const who = actor === undefined ? { session: '', name: '' } : this.#actor(actor)
    let releasedLock = false
    let orphaned = false
    await this.#mutateRequirement(id, undefined, draft => {
      const delegation = draft.delegatedTo ?? null
      if (delegation === null) return draft
      draft.role = delegation.roleBefore ?? ''
      draft.delegatedTo = null
      const held = draft.lock ?? null
      if (held !== null && lock === 'release') {
        draft.lock = null
        releasedLock = true
      } else if (held !== null && lock === 'orphan' && held.orphaned !== true) {
        draft.lock = { ...held, orphaned: true }
        orphaned = true
      }
      draft.updatedAt = at
      draft.updatedBy = who.session
      draft.rev = (draft.rev ?? 0) + 1
      if (actor !== undefined) draft.history.push(lockEntry('revoke-delegation', draft, at, who, note))
      return draft
    }, '', at)
    await this.#roles.removeDelegated(bound.roleId)
    // §5.5 settles the task's execution units with its delegation: the session the
    // binding named is no longer the one the work runs under, so nothing will ever
    // report a unit it started, and leaving those units `running` would describe
    // execution that the board has stopped following.
    await this.settleExecutionUnits(id, `delegation to session "${bound.session}" ended`)
    // The reservation followed the binding, so it ends with it: §5.3 lists the
    // release points for finishing or deleting a requirement, and `revoke` is the
    // same situation from the delegation's side — the named session loses its
    // claim the moment the binding is gone.
    const releasedReservation = await this.#releaseReservationFor(bound.session, id, at)
    return { roleId: bound.roleId, releasedLock, orphaned, releasedReservation }
  }

  /** Whether a session's own role may take a requirement routed to `role`. */
  #roleAllows(role, session) {
    return role === '' || role === this.#roleIdOf(session)
  }

  /**
   * Refuse an AI session's attempt to move a decision requirement (§5.7).
   *
   * A `decision` requirement is a question for the human, so no session may claim
   * it, move its flow, finish, archive, or delete it, delegate it, or reserve it.
   * The panel (`session === ''`) is the human's path and is never refused, and
   * reads stay open to every session so the board can show what it is waiting for.
   * The refusal names the action and carries the stable `decision-task` reason.
   *
   * `block`, `unblock`, and `checklist` are deliberately outside the six actions
   * (§5.7): they change a status or a node's checklist and open no path to
   * execution. They still name this rule first, because the lock is not the
   * reason they fail: a decision's lock can never be held — `claim` and `queue`
   * are refused for it above — so `lock-required` would send a model after a lock
   * nobody can take. So this list is the whole of the rule an agent could
   * otherwise reach.
   * @param requirement - Stored requirement record.
   * @param who - `{ session, name }` of the caller.
   * @param action - Action being attempted, for the message.
   */
  #assertHumanOnly(requirement, who, action) {
    if (who.session === '') return
    if ((requirement.kind ?? 'task') !== 'decision') return
    fail('forbidden', `"${requirement.id}" is a decision requirement: only the human may ${action} it`, {
      reason: 'decision-task',
      id: requirement.id,
      action,
    })
  }

  /**
   * Refuse a gate link the board cannot hold (§5.8).
   *
   * The two graphs are checked separately because they fail differently: a
   * `blocksOn` cycle means a set of requirements can never come free, while a
   * `parentId` cycle means deriving `children` never terminates. Each check walks
   * only the graph the new link joins, and all three refusals are
   * `invalid-argument` with a stable `reason`: `missing-target`,
   * `self-reference`, or `cycle`.
   *
   * A link to a requirement that does not exist is refused rather than stored:
   * `delete` unbinds the links it removes and the startup sweep clears what an
   * interrupted write left behind, so a dangling link is either a caller mistake
   * or residue, and neither belongs in a new write.
   * @param id - Requirement being written.
   * @param parentId - Parent to store, or `null`; `undefined` leaves this graph
   * out of the write.
   * @param blocksOn - Blockers to store, in order; `undefined` leaves this graph
   * out of the write.
   */
  #assertLinks({ id, parentId = undefined, blocksOn = undefined }) {
    if (parentId !== undefined && parentId !== null) {
      if (parentId === id) {
        fail('invalid-argument', `"${id}" cannot be its own parent`, { reason: 'self-reference', id, field: 'parentId' })
      }
      const trail = [id, parentId]
      const seen = new Set([id])
      let cursor = parentId
      while (cursor !== null) {
        if (cursor === id) {
          fail('invalid-argument', `parent chain ${trail.join(' -> ')} would form a cycle`, { reason: 'cycle', id, field: 'parentId', path: trail })
        }
        if (seen.has(cursor)) break
        seen.add(cursor)
        if (this.#requirements.get(cursor) === undefined) {
          fail('invalid-argument', `parent requirement "${cursor}" does not exist`, { reason: 'missing-target', id, field: 'parentId', target: cursor })
        }
        cursor = this.#requirements.get(cursor)?.parentId ?? null
        if (cursor !== null) trail.push(cursor)
      }
    }
    for (const target of blocksOn ?? []) {
      if (target === id) {
        fail('invalid-argument', `"${id}" cannot block on itself`, { reason: 'self-reference', id, field: 'blocksOn' })
      }
    }
    const stack = (blocksOn ?? []).map(target => [id, target])
    const seen = new Set()
    while (stack.length > 0) {
      const trail = stack.pop()
      const cursor = trail[trail.length - 1]
      if (cursor === id) {
        fail('invalid-argument', `"${id}" would close a blocksOn cycle: ${trail.join(' -> ')}`, { reason: 'cycle', id, field: 'blocksOn', path: trail })
      }
      if (seen.has(cursor)) continue
      seen.add(cursor)
      if (this.#requirements.get(cursor) === undefined) {
        fail('invalid-argument', `requirement "${cursor}" does not exist`, { reason: 'missing-target', id, field: 'blocksOn', target: cursor })
      }
      for (const next of this.#requirements.get(cursor)?.blocksOn ?? []) stack.push([...trail, next])
    }
  }

  /**
   * Apply the gate links of one `update` patch to a draft (§5.8).
   *
   * Validation runs against the committed graph, so the cycle check sees every
   * other writer's links; the draft is only touched once both changed graphs are
   * accepted. An absent key leaves its graph alone, so one field can be changed
   * without restating the other — and without re-validating links that were
   * already stored.
   * @param patch - The update patch.
   * @param draft - Requirement draft, mutated in place.
   * @param id - Requirement id.
   * @returns `{ changed, note }`; `changed` is false when the patch asks for the
   * values already stored, so a repeated write records no history.
   */
  #gatePatch(patch, draft, id) {
    const wantsParent = patch.parentId !== undefined
    const wantsBlocks = patch.blocksOn !== undefined
    if (!wantsParent && !wantsBlocks) return { changed: false, note: '' }
    const parentId = wantsParent ? asOptionalId(patch.parentId, 'parentId') : (draft.parentId ?? null)
    const blocksOn = wantsBlocks ? asLinks(patch.blocksOn) : (draft.blocksOn ?? [])
    this.#assertLinks({
      id,
      ...(wantsParent ? { parentId } : {}),
      ...(wantsBlocks ? { blocksOn } : {}),
    })
    let changed = false
    if (wantsParent && parentId !== (draft.parentId ?? null)) {
      draft.parentId = parentId
      changed = true
    }
    if (wantsBlocks) {
      const before = draft.blocksOn ?? []
      if (blocksOn.length !== before.length || blocksOn.some((value, index) => value !== before[index])) {
        draft.blocksOn = blocksOn
        changed = true
      }
    }
    if (!changed) return { changed: false, note: '' }
    return {
      changed: true,
      note: `gates: parentId "${draft.parentId ?? ''}", blocksOn [${(draft.blocksOn ?? []).join(', ')}]`,
    }
  }

  /** Whether a session is the creator, the owner, or a member of a requirement. */
  #relatedTo(requirement, session) {
    return requirement.createdBy === session
      || requirement.owner === session
      || (requirement.sessions ?? []).includes(session)
  }

  /** The display name the agent registry holds for a session, or `''`. */
  #sessionName(session) {
    const agent = this.#sessionAgent(session)
    return typeof agent?.name === 'string' ? agent.name : ''
  }

  /** The live Agent for a session id, or undefined. */
  #sessionAgent(session) {
    const agents = typeof this.#ports.agents === 'function' ? this.#ports.agents() : undefined
    return typeof agents?.get === 'function' ? agents.get(session) : undefined
  }

  /**
   * Refuse a delegation whose target the caller does not own (§5.5).
   *
   * A session may name only a sub-session the agent registry reports as its own;
   * otherwise any session could hand work — and the one lock it implies — to a
   * stranger by id. The panel (`session === ''`) is the human and delegates to
   * any session.
   *
   * The port answers in session ids — `owns(target, caller)` — and returns
   * `undefined` when this composition cannot decide the relation, which is a
   * different fact from "not mine". Undecidable skips the check and reports it
   * once, naming the reason; a decided `false` refuses. Reading the platform's
   * own ownership predicate is the adapter's job at the port boundary, so nothing
   * here has to know what an Agent object is.
   * @param target - Session id the delegation names.
   * @param caller - Session id of the delegating session; `''` is the panel.
   */
  #assertOwnedTarget(target, caller) {
    if (caller === '') return
    const owns = typeof this.#ports.owns === 'function' ? this.#ports.owns : undefined
    if (owns === undefined) {
      this.#warnOwnership('this composition injects no ownership port')
      return
    }
    const verdict = owns(target, caller)
    if (verdict === undefined) {
      this.#warnOwnership(`the registry cannot say whose sub-session "${caller}" is`)
      return
    }
    if (verdict !== true) {
      fail('forbidden', `session "${caller}" does not own session "${target}"`, { reason: 'not-owned', target, owner: caller })
    }
  }

  /**
   * Report one undecidable ownership check, once per service.
   *
   * The degradation is visible rather than silent: the check is skipped, so
   * delegation to any session is allowed, and the log names the reason this
   * composition could not tell whose sub-session the caller is.
   * @param reason - Why the relation could not be decided.
   */
  #warnOwnership(reason) {
    if (this.#ownershipWarned) return
    this.#ownershipWarned = true
    this.#logger?.warn?.(`requirement-board: delegation cannot check that the target session is the caller's sub-session (${reason}); delegating to any session is allowed`)
  }

  /**
   * Settle the board state of one disposed session (§5.2, §5.3, §5.5).
   *
   * Its queue row is dropped, so its soft reservations are released at once
   * instead of waiting for the next sweep, and its delegations are settled: a
   * requirement it was named for returns to `roleBefore` with no temporary role
   * left behind, so it is takeable again rather than stuck behind a binding to a
   * session that no longer exists. Every lock it holds is then marked `orphaned`
   * rather than released: another session may take over an orphan immediately,
   * while the record keeps the evidence of who held it. The execution units of
   * those locks settle with them in stage E.
   *
   * This is lifecycle work, not a requirement action: it writes no history entry
   * beyond the settling itself, and no lock rewriting beyond the orphan flags.
   * @param agent - The disposed Agent, or its session id.
   * @returns `{ session, releasedQueueItems, settledDelegations, orphaned }`.
   */
  async disposeSession(agent) {
    const session = typeof agent === 'string' ? agent : (typeof agent?.id === 'string' ? agent.id : '')
    if (session === '') return { session: '', releasedQueueItems: 0, settledDelegations: 0, orphaned: 0 }
    const row = this.#queueRow(session)
    const releasedQueueItems = row?.items?.length ?? 0
    if (row !== undefined) {
      await this.#queues.delete(session)
      await this.#bumpRevision()
    }
    let settledDelegations = 0
    for (const [id, requirement] of [...this.#requirements.entries()]) {
      if (requirement.delegatedTo?.session !== session) continue
      const settled = await this.#settleDelegation(id, { lock: 'orphan' })
      if (settled.roleId !== '') settledDelegations += 1
    }
    let orphaned = 0
    const at = nowIso()
    for (const [id, requirement] of [...this.#requirements.entries()]) {
      if (requirement.lock?.session !== session) continue
      await this.#mutateRequirement(id, undefined, draft => {
        if (draft.lock?.session !== session) return draft
        draft.lock = { ...draft.lock, orphaned: true }
        orphaned += 1
        return draft
      }, '', at)
      // §5.5 settles the units of a disposed session's tasks with the same
      // teardown that orphans their locks: the sessions that could report them are
      // gone, so a unit left `running` would be a claim nothing can retract.
      await this.settleExecutionUnits(id, `owning session "${session}" was disposed`)
    }
    return { session, releasedQueueItems, settledDelegations, orphaned }
  }

  /**
   * Apply one `update` patch to a draft and report whether it changed a field.
   *
   * Everything the patch names is validated whether or not the value changes, so
   * an invalid value is refused even when the stored value would have been kept.
   * A patch that names only values already stored changes nothing: the caller
   * then commits no write at all, so another session's `expectedRev` is not
   * invalidated by a request that changed nothing (§4.1).
   *
   * A gate link (`blocksOn`/`parentId`) and a template change are structural and
   * are compared as well; the lock they require is judged by the caller before
   * this runs (§5.8).
   * @param draft - Mutable record clone.
   * @param patch - Patch fields, already filtered against {@link UPDATABLE};
   * `images` already resolved from stored ids to refs by the caller.
   * @param who - `{ session, name }` of the caller.
   * @param id - Requirement id, for the refusals.
   * @param at - Instant of this write chain.
   * @returns `{ changed }`.
   */
  #applyUpdate(draft, patch, who, id, at) {
    if (who.session !== '' && (draft.kind ?? 'task') === 'decision') {
      const refused = Object.keys(patch).filter(key => key !== 'expectedRev' && !DECISION_UPDATABLE.includes(key))
      if (refused.length > 0) {
        fail('forbidden', `"${id}" is a decision requirement: only the human may change ${refused.join(', ')}`, {
          reason: 'decision-task',
          id,
          fields: refused,
          allowed: DECISION_UPDATABLE,
        })
      }
    }
    const structural = Object.keys(patch).some(key => STRUCTURAL_FIELDS.includes(key))
    if (structural) assertLockHeld(draft, who.session)
    let changed = false
    const assign = (key, value) => {
      if (draft[key] === value) return
      draft[key] = value
      changed = true
    }
    if (patch.title !== undefined) assign('title', asString(patch.title, 'title', { required: true, max: 200 }))
    if (patch.summary !== undefined) assign('summary', asSummary(patch.summary))
    if (patch.description !== undefined) assign('description', asString(patch.description, 'description', { max: 8000 }))
    if (patch.priority !== undefined) assign('priority', asEnum(patch.priority, PRIORITIES, 'priority'))
    if (patch.owner !== undefined) assign('owner', asString(patch.owner, 'owner', { max: 120 }))
    if (patch.role !== undefined) {
      const next = asRoleId(patch.role)
      const delegated = draft.delegatedTo ?? null
      // A delegation owns the routing id while it lasts: it wrote the temporary
      // id and it settles the requirement back to `roleBefore`, so a re-route
      // written now would be discarded at settlement. A real change is refused
      // rather than accepted-then-erased; restating the stored id stays the
      // zero-change case, which is what the panel sends when it saves any other
      // field of a delegated requirement (§5.5).
      if (delegated !== null && next !== (draft.role ?? '')) {
        fail('conflict', `"${id}" is delegated to session "${delegated.session}": its routing role stays the temporary id "${delegated.roleId}" until the delegation ends`, {
          reason: 'delegated-role',
          id,
          role: next,
          delegatedTo: delegated,
        })
      }
      if (draft.role !== next) {
        draft.history.push(lockEntry('update', draft, at, who, `role "${draft.role ?? ''}" -> "${next}"`))
        draft.role = next
        changed = true
      }
    }
    if (patch.labels !== undefined) {
      const next = asStringArray(patch.labels, 'labels', { max: 20, itemMax: 60 })
      if (!sameItems(draft.labels, next)) assign('labels', next)
    }
    if (patch.sessions !== undefined) {
      const next = asStringArray(patch.sessions, 'sessions', { max: 50, itemMax: 200 })
      if (!sameItems(draft.sessions, next)) assign('sessions', next)
    }
    if (patch.images !== undefined) {
      // `patch.images` holds resolved refs: the caller turned the ids into them
      // before this ran, so an unknown id never reaches the write chain.
      if (!sameImageRefs(draft.images, patch.images)) assign('images', patch.images)
    }
    let retemplated = false
    if (patch.templateId !== undefined) {
      const template = this.#template(asString(patch.templateId, 'templateId', { max: 64 }))
      if (template.id !== draft.templateId) {
        if (template.archived === true) {
          fail('invalid-transition', `template "${template.id}" is archived and cannot be bound to a requirement`, { id: template.id })
        }
        draft.templateId = template.id
        // §11.4 write point ②: the pin is reset to the target template's current
        // revision. The old number names a version of the *old* template, so
        // keeping it would leave this requirement unresolvable — or, worse,
        // silently reading a same-numbered version of the new one.
        draft.templateRevision = currentTemplateRevision(template)
        if (nodeIndex(template, draft.nodeId) < 0) draft.nodeId = template.nodes[0].id
        draft.nodes = recomputeNodes(draft, template, at)
        retemplated = true
        changed = true
      }
    }
    // A gate link is structural (§5.8): the link is validated against the
    // committed graph here, and the change is the one part of an update that is
    // recorded in `history` — it changes what may advance, not how the work reads.
    const gate = this.#gatePatch(patch, draft, id)
    if (gate.changed) {
      draft.history.push(lockEntry('update', draft, at, who, gate.note))
      changed = true
    }
    if (!changed) return { changed: false }
    draft.updatedAt = at
    draft.updatedBy = who.session
    draft.rev = (draft.rev ?? 0) + 1
    if (retemplated) {
      draft.history.push(this.#retemplateEntry(draft, who, at, `bound to template ${draft.templateId}`, false))
    }
    return { changed: true }
  }

  /**
   * Update the mutable fields of a requirement.
   *
   * `kind` is refused before anything else: it is decided at creation and never
   * changes (§5.7), so the request that would turn a decision into ordinary work
   * — and then claim it — cannot be made at all, by the panel or by an agent. On
   * a decision requirement an agent is left with {@link DECISION_UPDATABLE}: it may
   * sharpen the question but not answer it.
   *
   * An update that changes no field is not a write: it neither advances `rev` nor
   * records history, so a caller repeating a value it already set cannot make
   * another session's `expectedRev` stale. `expectedRev` is still judged first, so
   * a stale revision is refused even when the patch would have changed nothing
   * (§4.1).
   * @param id - Requirement id.
   * @param patch - Any of {@link UPDATABLE}, plus `expectedRev`; `images` holds
   * stored image ids, which are resolved to the refs they name before the write.
   * @param actor - `{ session, name }` of the caller.
   * @returns the presented requirement.
   */
  async updateRequirement(id, patch = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    if ('kind' in patch) {
      fail('invalid-argument', '"kind" is fixed when a requirement is created and cannot be changed', {
        reason: 'kind-immutable',
        id,
        kind: patch.kind,
      })
    }
    const unknown = Object.keys(patch).filter(key => !UPDATABLE.includes(key) && key !== 'expectedRev')
    if (unknown.length > 0) fail('invalid-argument', `unsupported field(s): ${unknown.join(', ')}`, { supported: UPDATABLE })
    // An id that names no stored image is refused here, before the write chain is
    // entered and before the record is touched.
    const resolved = patch.images === undefined ? patch : { ...patch, images: await this.#imageRefs(patch.images) }
    return await this.#serialize(`requirement:${id}`, async () => {
      const stored = this.#requirements.get(id)
      if (stored === undefined) fail('not-found', `no requirement with id "${id}"`, { id })
      if (patch.expectedRev !== undefined && patch.expectedRev !== null && stored.rev !== patch.expectedRev) {
        fail('conflict', `requirement "${id}" changed since revision ${patch.expectedRev}`, {
          expected: patch.expectedRev,
          current: stored.rev,
        })
      }
      // Validate and apply on a copy first: the decision to write has to be made
      // from the value the store holds now, and a rejection must not have touched
      // it. Entering the write chain only for a real change is what makes an
      // unchanged update cost no revision.
      if (!this.#applyUpdate(structuredClone(stored), resolved, who, id, at).changed) return this.#present(stored)
      const committed = await this.#mutateRequirement(id, patch.expectedRev, draft => {
        this.#applyUpdate(draft, resolved, who, id, at)
        return draft
      }, who.session, at)
      return this.#present(committed)
    })
  }

  /**
   * Advance, roll back, jump, complete, or reopen a requirement.
   *
   * Like every other write, the returned value is the presented requirement, so
   * the receipt of this transition is `result.lastTransition` rather than a
   * second top-level field. A transition that finishes the flow (`complete`, or
   * an `advance` past the last node) also releases the lock, so continuing a
   * finished requirement means claiming it again.
   *
   * `advance` and `complete` are refused while `blocksOn` names unfinished work
   * (`invalid-transition`, with the blockers listed), judged after the template's
   * own node prerequisite (`dependency-not-met`) in the order §5.8 fixes. `force`
   * overrides both, and the history entry records which gate it overrode.
   * `rollback` is not gated — going back is not progress — and `jump` already
   * requires `force`.
   * @param id - Requirement id.
   * @param input - `{ action, to, note, force, expectedRev }`.
   * @param actor - `{ session, name }` of the caller.
   * @returns the presented requirement, with this transition as `lastTransition`.
   */
  async transitionRequirement(id, input = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const action = asEnum(input.action, TRANSITION_ACTIONS, 'action')
    const force = asBoolean(input.force, 'force', false)
    const requirement = await this.#mutateRequirement(id, input.expectedRev, draft => {
      this.#assertHumanOnly(draft, who, action)
      assertLockHeld(draft, who.session)
      // The flow this requirement runs is the one it pinned, not the newest one
      // (§11.4): a template revision it never migrated to must not move it.
      const template = this.#templateFor(draft)
      const record = applyTransition(draft, template, {
        action,
        ...(input.to === undefined || input.to === null ? {} : { to: asString(input.to, 'to', { max: 64 }) }),
        note: asString(input.note, 'note', { max: 500 }),
        force,
      }, { at, actor: who })
      // §5.8: the template's own prerequisite is judged inside `applyTransition`,
      // so this cross-requirement gate follows it — the error order the tool
      // description promises. A refusal here throws the draft away, so blocked
      // work is refused without a write, and a `force` that overrode blockers
      // names them in the history entry that records the move.
      if (action === 'advance' || action === 'complete') {
        const blockedBy = escalationIndex(this.#allRequirements()).get(id)?.blockedBy ?? []
        if (blockedBy.length > 0) {
          if (!force) {
            fail('invalid-transition', `"${id}" is blocked by unfinished requirement(s): ${blockedBy.join(', ')}`, {
              reason: 'blocked-by',
              id,
              action,
              blockedBy,
            })
          }
          record.blockedBy = [...blockedBy]
        }
      }
      // Finishing the flow releases the lock in the same update (§5.1 step 5):
      // a session holds one lock at a time, so keeping a finished task's lock
      // would block that session from taking the next one until the lease ran
      // out. Settling this lock's execution units belongs in this same slot once
      // executions exist (stage E); no separate history entry is written, the
      // transition is the record of the release.
      if (draft.status === 'done') draft.lock = null
      return draft
    }, who.session, at)
    let final = requirement
    if (requirement.status === 'done') {
      // A finished requirement ends any reservation on it, so a queue cannot keep
      // pointing at settled work (§5.3), and ends its delegation (§3.3): the lock
      // was released in the update above, so settling only reverts `role`, clears
      // the binding, and deletes the temporary role.
      await this.#releaseReservation(requirement.id)
      await this.#settleDelegation(requirement.id, { lock: 'release' })
      final = this.#requirements.get(requirement.id) ?? requirement
    }
    // The receipt then names the acting session's own queue head without claiming
    // it (§5.1 step 5).
    const presented = this.#present(final)
    return final.status === 'done' ? this.#withQueueHead(presented, who.session) : presented
  }

  /**
   * Tick or untick one checklist entry on the requirement's active node.
   * @param id - Requirement id.
   * @param input - `{ index, checked, expectedRev }`.
   * @param actor - `{ session, name }` of the caller.
   * @returns the presented requirement.
   */
  async setChecklist(id, input = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const index = asNumber(input.index, 'index', undefined, { min: 0, max: 1000 })
    if (index === undefined) fail('invalid-argument', '"index" is required')
    const checked = asBoolean(input.checked, 'checked', true)
    const requirement = await this.#mutateRequirement(id, input.expectedRev, draft => {
      // The human-only clause comes first: "this operation is not yours" is a
      // different refusal from "you have not taken the lock", and the checklist of
      // a decision belongs to the person who owns the decision (§2.5, §6) — a
      // session wearing the decision's role still may not tick it.
      this.#assertHumanOnly(draft, who, 'tick the checklist of')
      assertLockHeld(draft, who.session)
      if (draft.status !== 'active') fail('invalid-transition', `checklist entries can only change on an active requirement`)
      setChecklistEntry(draft, this.#templateFor(draft), index, checked, at)
      draft.updatedBy = who.session
      return draft
    }, who.session, at)
    return this.#present(requirement)
  }

  /**
   * Mark a requirement blocked and retain the reason.
   * @param id - Requirement id.
   * @param input - `{ reason, expectedRev }`.
   * @param actor - `{ session, name }` of the caller.
   * @returns the presented requirement.
   */
  async blockRequirement(id, input = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const reason = asString(input.reason, 'reason', { required: true, max: 500 })
    const requirement = await this.#mutateRequirement(id, input.expectedRev, draft => {
      this.#assertHumanOnly(draft, who, 'block')
      assertLockHeld(draft, who.session)
      if (draft.status === 'archived') fail('invalid-transition', 'an archived requirement cannot be blocked')
      if (draft.status === 'done') fail('invalid-transition', 'a done requirement cannot be blocked; reopen it first')
      draft.status = 'blocked'
      draft.blockReason = reason
      draft.blockedAt = at
      draft.updatedAt = at
      draft.updatedBy = who.session
      draft.rev = (draft.rev ?? 0) + 1
      draft.history.push({
        id: mintId('evt'), at, by: who.session, byName: who.name, action: 'block',
        from: draft.nodeId, fromName: draft.nodeId, to: draft.nodeId, toName: draft.nodeId,
        fromStatus: 'active', toStatus: 'blocked', note: reason, force: false, durationMs: null,
      })
      return draft
    }, who.session, at)
    return this.#present(requirement)
  }

  /**
   * Clear a block.
   * @param id - Requirement id.
   * @param input - `{ note }`.
   * @param actor - `{ session, name }` of the caller.
   * @returns the presented requirement.
   */
  async unblockRequirement(id, input = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const requirement = await this.#mutateRequirement(id, undefined, draft => {
      this.#assertHumanOnly(draft, who, 'unblock')
      assertLockHeld(draft, who.session)
      if (draft.status !== 'blocked') fail('invalid-transition', `requirement "${id}" is not blocked`)
      draft.status = 'active'
      const note = asString(input.note, 'note', { max: 500 })
      draft.blockReason = ''
      draft.blockedAt = null
      draft.updatedAt = at
      draft.updatedBy = who.session
      draft.rev = (draft.rev ?? 0) + 1
      draft.history.push({
        id: mintId('evt'), at, by: who.session, byName: who.name, action: 'unblock',
        from: draft.nodeId, fromName: draft.nodeId, to: draft.nodeId, toName: draft.nodeId,
        fromStatus: 'blocked', toStatus: 'active', note, force: false, durationMs: null,
      })
      return draft
    }, who.session, at)
    return this.#present(requirement)
  }

  /**
   * Archive or restore a requirement without deleting its history.
   *
   * An archived requirement keeps its image refs and its image files: shelving
   * work is not deleting it, and a restore brings the record back with the same
   * pictures. Nothing is removed from disk here.
   * @param id - Requirement id.
   * @param input - `{ archived }`.
   * @param actor - `{ session, name }` of the caller.
   * @returns the presented requirement.
   */
  async setArchived(id, input = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const archived = asBoolean(input.archived, 'archived', true)
    const requirement = await this.#mutateRequirement(id, undefined, draft => {
      this.#assertHumanOnly(draft, who, archived ? 'archive' : 'restore')
      assertLockHeld(draft, who.session)
      const fromStatus = draft.status
      if (archived && fromStatus === 'archived') fail('invalid-transition', `requirement "${id}" is already archived`)
      if (!archived && fromStatus !== 'archived') fail('invalid-transition', `requirement "${id}" is not archived`)
      draft.status = archived ? 'archived' : 'active'
      draft.updatedAt = at
      draft.updatedBy = who.session
      draft.rev = (draft.rev ?? 0) + 1
      draft.history.push({
        id: mintId('evt'), at, by: who.session, byName: who.name, action: archived ? 'archive' : 'restore',
        from: draft.nodeId, fromName: draft.nodeId, to: draft.nodeId, toName: draft.nodeId,
        fromStatus, toStatus: draft.status, note: '', force: false, durationMs: null,
      })
      return draft
    }, who.session, at)
    // Archiving ends whatever reserved it and whatever was delegated to it
    // (§3.3); restoring does not resurrect either.
    if (requirement.status === 'archived') {
      await this.#releaseReservation(requirement.id)
      await this.#settleDelegation(requirement.id, { lock: 'release' })
      return this.#present(this.#requirements.get(requirement.id) ?? requirement)
    }
    return this.#present(requirement)
  }

  /**
   * Delete a requirement and its history.
   *
   * `table.delete` has no transform hook, so a caller-supplied `expectedRev`
   * and the lock gate are checked by an `update` that returns the record
   * unchanged — both then run in the write-chain slot, atomically with respect
   * to other writers — before the delete that follows. Deleting also unbinds the
   * id from every `blocksOn` and `parentId` that names it and from every queue,
   * so no reference outlives its target.
   *
   * Image files are deliberately left on disk. A file is immutable and one image
   * id may be referenced by more than one record, so removing the files of this
   * record could break another one; what the board guarantees instead is that no
   * surviving record points at a missing file. The leftovers are orphan files
   * that nothing references, which is not a dangling ref.
   * @param id - Requirement id.
   * @param input - `{ expectedRev }`.
   * @param actor - `{ session, name }` of the caller.
   * @returns `{ id, deleted: true, unbound }`; `unbound` lists the requirements
   * whose gate links were removed.
   */
  async deleteRequirement(id, input = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    if (this.#requirements.get(id) === undefined) fail('not-found', `no requirement with id "${id}"`, { id })
    const expectedRev = input.expectedRev
    try {
      await this.#requirements.update(id, record => {
        if (expectedRev !== undefined && expectedRev !== null && record.rev !== expectedRev) {
          fail('conflict', `requirement "${id}" changed since revision ${expectedRev}`, { expected: expectedRev, current: record.rev })
        }
        this.#assertHumanOnly(record, who, 'delete')
        assertLockHeld(record, who.session)
        return record
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'missing-key') {
        fail('not-found', `no requirement with id "${id}"`, { id })
      }
      throw error
    }
    // A delegation's temporary role must not outlive its task (§3.3): settle it
    // while `delegatedTo` is still readable, before the record is gone.
    await this.#settleDelegation(id, { lock: 'release' })
    const deleted = await this.#requirements.delete(id)
    if (!deleted) fail('not-found', `no requirement with id "${id}"`, { id })
    // §5.8: the same write chain takes the id out of every link and every queue.
    // Both run after the record is gone, because a link whose target no longer
    // exists is ignored by the gate and cleared by the startup sweep, while a
    // delete that failed must not have released the gates it was still holding.
    const unbound = await this.#unbindLinks(id, who, at)
    // Deletion takes the id out of every queue as well (§5.2): a reservation on a
    // record that no longer exists can never be claimed.
    await this.#releaseReservation(id)
    await this.#bumpRevision()
    return { id, deleted: true, unbound }
  }

  /**
   * Remove one deleted requirement id from every link that names it (§5.8).
   *
   * A link to a record that no longer exists is a permanent dangling reference if
   * nothing removes it: it would keep naming a requirement no read can resolve.
   * Both graphs are unbound — `blocksOn` on any requirement, and the `parentId`
   * of a child, which becomes a root again — each in its own update under its own
   * write chain, with a history entry saying why the gate changed.
   * @param id - Requirement id that was deleted.
   * @param who - `{ session, name }` of the caller that deleted it.
   * @param at - Instant of the delete, shared by the unbinding writes.
   * @returns the ids of the requirements that were unbound.
   */
  async #unbindLinks(id, who, at) {
    const unbound = []
    for (const [otherId, other] of [...this.#requirements.entries()]) {
      if (otherId === id) continue
      const blocks = other.blocksOn ?? []
      const keepsBlocks = blocks.filter(target => target !== id)
      const parentGone = (other.parentId ?? null) === id
      if (keepsBlocks.length === blocks.length && !parentGone) continue
      await this.#mutateRequirement(otherId, undefined, draft => {
        const held = draft.blocksOn ?? []
        if (draft.blocksOn !== undefined && held.includes(id)) {
          draft.blocksOn = held.filter(target => target !== id)
        }
        if (parentGone) draft.parentId = null
        draft.updatedAt = at
        draft.updatedBy = who.session
        draft.rev = (draft.rev ?? 0) + 1
        draft.history.push(lockEntry('update', draft, at, who, `unbound from "${id}", which was deleted`))
        return draft
      }, who.session, at)
      unbound.push(otherId)
    }
    return unbound
  }

  /**
   * List flow templates.
   *
   * Archived templates are hidden by default (§11.5): the list is what the panel's
   * new-requirement selector and the model's `list` read, and a shelved template
   * must not be offered as a new binding. `includeArchived` is how the template
   * drawer still shows them; `getTemplate` always does.
   * @param filter - `{ includeArchived }`; archived templates are dropped unless it is `true`.
   * @returns `{ items }` in insertion order.
   */
  listTemplates({ includeArchived = false } = {}) {
    return {
      items: [...this.#templates.entries()]
        .filter(([, template]) => includeArchived === true || template.archived !== true)
        .map(([, template]) => ({
          id: template.id,
          name: template.name,
          description: template.description,
          builtin: template.builtin === true,
          version: template.version,
          revision: currentTemplateRevision(template),
          archived: template.archived === true,
          updatedBy: template.updatedBy ?? '',
          versionCount: (template.versions ?? []).length,
          createdAt: template.createdAt,
          updatedAt: template.updatedAt,
          nodes: template.nodes.map(templateNodeView),
        })),
    }
  }

  /**
   * Read one flow template, archived or not.
   *
   * The raw record is what the panel's detail view needs — the version history and
   * the audit tail live here and nowhere else (§11.5). The model-facing tool
   * projects this through `templateView`, which drops both arrays.
   * @param id - Template id.
   * @returns the stored template record.
   */
  getTemplate(id) {
    return this.#template(id)
  }

  /**
   * Create a custom flow template.
   * @param input - `{ name, description, nodes }`.
   * @param actor - `{ session, name }` of the caller.
   * @returns the created template.
   */
  async createTemplate(input = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const id = asString(input.id, 'id', { max: 64 }) || mintId('tpl')
    if (this.#templates.get(id) !== undefined) fail('conflict', `a flow template with id "${id}" already exists`, { id })
    const template = normalizeTemplate(input, { id, builtin: false, now: at })
    template.createdBy = who.session
    await this.#templates.put(id, template)
    await this.#bumpRevision()
    return template
  }

  /**
   * Append a version to a flow template (`DESIGN.md` §11.5).
   *
   * This is the whole of "change a template": the current top-level fields are
   * snapshotted into `versions`, the validated patch becomes the new top level,
   * `revision` moves by one, and the audit tail gains one summary. **No
   * requirement is touched** (I3) — the `nodeId`, node states, ticks, and history
   * of every requirement bound to this template stay exactly what they were, and
   * the returned view only reports how many remain pinned to an older revision.
   * Moving them is `migrateRequirementsToRevision`'s separate, explicitly
   * confirmed act.
   *
   * `patch.nodes` is the complete target node list, not a merge: a node whose id
   * is absent from it is removed, and a node without an id gets one derived from
   * its name. `expectedRevision` is the template's own `revision`, judged inside
   * the commit slot so two concurrent appends cannot both win; a mismatch is
   * `conflict` with `{ expected, current }`. The 20-version bound is refused
   * rather than truncated (I2), because the oldest version may be one a
   * requirement still runs on.
   *
   * @param id - Template id.
   * @param patch - `{ name?, description?, nodes?, expectedRevision? }`.
   * @param actor - `{ session, name }` of the caller.
   * @returns the projected template, with `pinnedToOld` counting requirements on an older revision.
   */
  async reviseTemplate(id, patch = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const template = this.#template(id)
    if (template.builtin) fail('invalid-transition', `the built-in template "${id}" cannot be revised; clone it first`, { id })
    const expected = asRevision(patch.expectedRevision, 'expectedRevision')
    const stored = await this.#mutateTemplate(id, draft => {
      const revision = currentTemplateRevision(draft)
      if (expected !== undefined && revision !== expected) {
        fail('conflict', `template "${id}" changed since revision ${expected}`, {
          expected,
          current: revision,
        })
      }
      const versions = draft.versions ?? []
      if (versions.length >= TEMPLATE_VERSION_LIMIT) {
        fail('invalid-transition', `template "${id}" already holds ${TEMPLATE_VERSION_LIMIT} historical versions; prune an older revision first`, {
          id,
          limit: TEMPLATE_VERSION_LIMIT,
        })
      }
      const next = normalizeTemplate({
        name: patch.name === undefined ? draft.name : patch.name,
        description: patch.description === undefined ? draft.description : patch.description,
        nodes: patch.nodes === undefined ? draft.nodes : patch.nodes,
      }, { id: draft.id, builtin: false, now: at })
      return {
        ...draft,
        name: next.name,
        description: next.description,
        nodes: next.nodes,
        revision: revision + 1,
        versions: [...versions, {
          revision,
          at: draft.updatedAt,
          by: draft.updatedBy ?? draft.createdBy ?? '',
          name: draft.name,
          description: draft.description,
          nodes: draft.nodes,
          summary: (draft.changes ?? []).find(entry => entry.revision === revision)?.summary ?? '',
        }],
        changes: [
          ...(draft.changes ?? []),
          { at, by: who.session, revision: revision + 1, summary: templateChangeSummary(draft, next) },
        ].slice(-TEMPLATE_CHANGE_LIMIT),
        updatedAt: at,
        updatedBy: who.session,
      }
    })
    const revision = currentTemplateRevision(stored)
    const pinnedToOld = this.#requirementsBoundTo(id).filter(requirement => (requirement.templateRevision ?? 1) !== revision).length
    return { ...templateView(stored), pinnedToOld }
  }

  /**
   * Change a template's own name or description in place (`DESIGN.md` §11.5).
   *
   * This is the metadata side of the line §11.5 draws: the label a template shows
   * changes no requirement's flow or progress, so it moves no `revision` and
   * enters no history. Any node-array change goes through `reviseTemplate`
   * instead. The panel is the only caller — the model renames through `revise`,
   * which leaves a trace — and a built-in template refuses both. A historical
   * version keeps the name the top level had when it was current, which is
   * intentional: each version records what was true then.
   *
   * @param id - Template id.
   * @param patch - `{ name?, description? }`.
   * @param actor - `{ session, name }` of the caller.
   * @returns the projected template.
   */
  async setTemplateMetadata(id, patch = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const template = this.#template(id)
    if (template.builtin) fail('invalid-transition', `the built-in template "${id}" cannot be edited; clone it first`, { id })
    const name = patch.name === undefined ? template.name : asString(patch.name, 'name', { required: true, max: 120 })
    const description = patch.description === undefined ? template.description : asString(patch.description, 'description', { max: 600 })
    if (name === template.name && description === template.description) return templateView(template)
    const stored = await this.#mutateTemplate(id, draft => ({ ...draft, name, description, updatedAt: at, updatedBy: who.session }))
    return templateView(stored)
  }

  /**
   * Move the requirements pinned to an older revision onto `revision` (§11.5).
   *
   * This is the only template-side operation that touches requirements (I4), and
   * it stays separate from `reviseTemplate` so the caller must confirm the impact.
   * That impact is computed before any write — one
   * `{ id, nodeId, revision, next, clearedChecks }` per candidate — and is both the
   * success receipt and the `in-use` detail a refusal carries, which is how a
   * caller without a preview action (the model) judges the cost from failure alone.
   *
   * Omitting `requirementIds` means "every requirement still on an older
   * revision", the bulk edit that must be confirmed with `force`; naming ids is the
   * confirmed form. A requirement whose current node is absent from the target
   * revision is normalized to that revision's first node (the same rule rebinding
   * uses), a changed checklist length blanks that node's ticks through
   * `recomputeNodes`, and every migrated requirement gains a `retemplate` history
   * entry whose note starts `migrated to revision <n> from <m>` — the prefix that
   * keeps it distinguishable from the rebinding path's `bound to template <id>`.
   *
   * @param id - Template id.
   * @param revision - Target revision; defaults to the current one and must exist.
   * @param options - `{ requirementIds }`; omitted means every requirement on an older revision.
   * @param actor - `{ session, name }` of the caller.
   * @param force - Required for the bulk form; recorded on each history entry.
   * @returns `{ id, revision, affected, migrated }`.
   */
  async migrateRequirementsToRevision(id, revision, { requirementIds } = {}, actor, force = false) {
    const who = this.#actor(actor)
    const at = nowIso()
    const template = this.#template(id)
    if (template.archived === true) fail('invalid-transition', `template "${id}" is archived and cannot be migrated`, { id })
    const requested = asRevision(revision, 'revision')
    const targetRevision = requested ?? currentTemplateRevision(template)
    const target = this.#atRevision(template, targetRevision)
    const named = requirementIds === undefined || requirementIds === null
      ? undefined
      : asStringArray(requirementIds, 'requirementIds', { max: 500, itemMax: 64 })
    if (named !== undefined) {
      for (const requirementId of named) {
        const requirement = this.#requirements.get(requirementId)
        if (requirement === undefined) fail('not-found', `no requirement with id "${requirementId}"`, { id: requirementId })
        if (requirement.templateId !== id) {
          fail('invalid-argument', `requirement "${requirementId}" is not bound to template "${id}"`, { id: requirementId, templateId: requirement.templateId })
        }
      }
    }
    const candidates = (named === undefined ? this.#requirementsBoundTo(id) : named.map(requirementId => this.#requirements.get(requirementId)))
      .filter(requirement => (requirement.templateRevision ?? 1) !== targetRevision)
    const affected = this.#migrationImpact(candidates, target, targetRevision)
    if (named === undefined && candidates.length > 0 && force !== true) {
      fail('in-use', `${candidates.length} requirement(s) still run an older revision of "${id}"`, {
        id,
        revision: targetRevision,
        requirements: candidates.map(requirement => requirement.id),
        affected,
      })
    }
    const migrated = []
    for (const requirement of candidates) {
      await this.#mutateRequirement(requirement.id, undefined, draft => {
        const from = draft.templateRevision ?? 1
        draft.templateRevision = targetRevision
        if (nodeIndex(target, draft.nodeId) < 0) draft.nodeId = target.nodes[0].id
        draft.nodes = recomputeNodes(draft, target, at)
        draft.updatedAt = at
        draft.updatedBy = who.session
        draft.rev = (draft.rev ?? 0) + 1
        draft.history.push(this.#retemplateEntry(draft, who, at, `migrated to revision ${targetRevision} from ${from}`, force === true))
        return draft
      }, who.session, at)
      migrated.push(requirement.id)
    }
    // Each requirement write above bumps the revision; a migration that changed
    // nothing must still tell the open panels something was asked, so the frame is
    // published for the empty case too (§11.9).
    if (migrated.length === 0) await this.#bumpRevision()
    return { id, revision: targetRevision, affected, migrated }
  }

  /**
   * What one migration would do to each candidate, computed before any write.
   * @param candidates - Requirement records the migration would touch.
   * @param target - Template resolved at the target revision.
   * @param revision - Target revision number.
   * @returns one `{ id, nodeId, revision, next, clearedChecks }` per candidate;
   * `clearedChecks` is `true` when the target node's checklist length differs from
   * what the requirement recorded, which is the condition `recomputeNodes` blanks
   * the ticks under.
   */
  #migrationImpact(candidates, target, revision) {
    return candidates.map(requirement => {
      const next = nodeIndex(target, requirement.nodeId) < 0 ? target.nodes[0].id : requirement.nodeId
      const node = target.nodes.find(candidate => candidate.id === next)
      const checks = requirement.nodes?.[next]?.checks
      return {
        id: requirement.id,
        nodeId: requirement.nodeId,
        revision: requirement.templateRevision ?? 1,
        next,
        clearedChecks: checks?.length !== (node?.completion?.checklist ?? []).length,
      }
    })
  }

  /**
   * Drop one historical version of a template (`DESIGN.md` §11.5).
   *
   * Panel-only: pruning is housekeeping rather than flow authorship, so the tool
   * surface has no action for it. A version any requirement is pinned to is
   * refused with `in-use` and those requirements' ids (I2) — that requirement's
   * whole flow would become unresolvable. The judgment set is the one deletion
   * uses: every requirement whose `templateId` matches, done and archived records
   * included, because a shelved requirement is reopened against the same pin.
   *
   * @param id - Template id.
   * @param revision - Historical revision to drop; must be below the current one and stored.
   * @param actor - `{ session, name }` of the caller.
   * @returns the projected template, with `pruned` naming the dropped revision.
   */
  async pruneTemplateVersion(id, revision, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const template = this.#template(id)
    if (template.archived === true) fail('invalid-transition', `template "${id}" is archived and cannot be pruned`, { id })
    const wanted = asRevision(revision, 'revision')
    if (wanted === undefined) fail('invalid-argument', '"revision" is required')
    // The revision's own validity is judged before the pin question: pruning the
    // current or an unstored revision is an argument error whatever is pinned to
    // it, and reporting `in-use` there would blame the requirements.
    const current = currentTemplateRevision(template)
    const versions = template.versions ?? []
    if (!(wanted < current) || !versions.some(entry => entry.revision === wanted)) {
      fail('invalid-argument', `template "${id}" has no historical revision ${wanted}`, { id, revision: wanted, current })
    }
    const pinned = this.#requirementsBoundTo(id).filter(requirement => (requirement.templateRevision ?? 1) === wanted)
    if (pinned.length > 0) {
      fail('in-use', `revision ${wanted} of template "${id}" is pinned by ${pinned.length} requirement(s)`, {
        id,
        revision: wanted,
        requirements: pinned.map(requirement => requirement.id),
      })
    }
    const stored = await this.#mutateTemplate(id, draft => {
      const live = currentTemplateRevision(draft)
      const liveVersions = draft.versions ?? []
      if (!(wanted < live) || !liveVersions.some(entry => entry.revision === wanted)) {
        fail('invalid-argument', `template "${id}" has no historical revision ${wanted}`, { id, revision: wanted, current: live })
      }
      return {
        ...draft,
        versions: liveVersions.filter(entry => entry.revision !== wanted),
        changes: [
          ...(draft.changes ?? []),
          { at, by: who.session, revision: live, summary: `pruned revision ${wanted}` },
        ].slice(-TEMPLATE_CHANGE_LIMIT),
        updatedAt: at,
        updatedBy: who.session,
      }
    })
    return { ...templateView(stored), pruned: wanted }
  }

  /**
   * Archive or restore a flow template (`DESIGN.md` §11.5).
   *
   * Archiving is the routine alternative to a hard delete: the template leaves the
   * new-requirement selector and the default `listTemplates` but keeps serving
   * every requirement already bound to it, because each of those runs its own
   * pinned revision. A built-in template (I6) and the deployment's configured
   * `defaultTemplateId` are refused with `invalid-transition`: the first cannot be
   * edited at all, and the last is what a new requirement with no named template
   * resolves to.
   *
   * @param id - Template id.
   * @param input - `{ archived }`; defaults to `true`, i.e. archive rather than restore.
   * @param actor - `{ session, name }` of the caller.
   * @returns the projected template.
   */
  async archiveTemplate(id, input = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const archived = asBoolean(input.archived, 'archived', true)
    const template = this.#template(id)
    if (template.builtin) fail('invalid-transition', `the built-in template "${id}" cannot be archived`, { id })
    if (archived && id === this.#config.defaultTemplateId) {
      fail('invalid-transition', `template "${id}" is this deployment's default template and cannot be archived`, { id })
    }
    if ((template.archived === true) === archived) return templateView(template)
    const stored = await this.#mutateTemplate(id, draft => ({ ...draft, archived, updatedAt: at, updatedBy: who.session }))
    return templateView(stored)
  }

  /**
   * Copy a template's current version into a new custom template (§11.5).
   *
   * This is the supported way to change a built-in flow (I6): the copy is
   * ordinary, editable, and records its origin in `supersedes`. It starts a fresh
   * version line (`revision` 1, no history) with the caller's name and the
   * source's current description and nodes, so revising the copy cannot disturb
   * the source or any requirement pinned to it.
   *
   * @param id - Source template id.
   * @param input - `{ name }`; required, because the name is how a person tells two templates apart.
   * @param actor - `{ session, name }` of the caller.
   * @returns the projected new template.
   */
  async cloneTemplate(id, input = {}, actor) {
    const who = this.#actor(actor)
    const at = nowIso()
    const source = this.#template(id)
    const name = asString(input.name, 'name', { required: true, max: 120 })
    const clone = normalizeTemplate({ name, description: source.description, nodes: source.nodes }, { id: mintId('tpl'), builtin: false, now: at })
    clone.createdBy = who.session
    clone.supersedes = source.id
    await this.#templates.put(clone.id, clone)
    await this.#bumpRevision()
    return templateView(clone)
  }

  /**
   * Delete a custom flow template.
   *
   * Non-transactional by construction: the platform serializes writes on one
   * chain but offers no multi-record transaction, so the bound requirements are
   * rebound and the template removed as consecutive chain writes. Because that
   * chain can fail halfway, the fallback is resolved before any write: an
   * unresolvable default template fails with `invalid-config` and changes no
   * requirement, and repeating the call is idempotent because already-rebound
   * requirements no longer match the reference set.
   *
   * Every bound requirement — done and archived ones included — is rebound to the
   * deployment's default template, its pin reset to that template's current
   * revision, and a `retemplate` history entry records the move (`force: true`).
   * The deployment's default template itself is refused, like a built-in one.
   *
   * @param id - Template id.
   * @param input - `{ force }` to delete one still bound by requirements.
   * @param actor - `{ session, name }` of the caller.
   * @returns `{ id, deleted: true }`.
   */
  async deleteTemplate(id, input = {}, actor) {
    const who = this.#actor(actor)
    const template = this.#template(id)
    if (template.builtin) fail('invalid-transition', `the built-in template "${id}" cannot be deleted`, { id })
    if (id === this.#config.defaultTemplateId) {
      fail('invalid-transition', `template "${id}" is this deployment's default template and cannot be deleted`, { id })
    }
    const bound = this.#requirementsBoundTo(id)
    if (bound.length > 0 && input.force !== true) {
      fail('in-use', `template "${id}" is bound by ${bound.length} requirement(s)`, { id, requirements: bound.map(requirement => requirement.id) })
    }
    if (bound.length > 0) {
      const fallbackId = this.#config.defaultTemplateId
      const fallback = this.#templates.get(fallbackId)
      if (fallback === undefined) {
        fail('invalid-config', `cannot rebind the requirements of "${id}": the default template "${fallbackId}" is not stored`, {
          id,
          defaultTemplateId: fallbackId,
          known: [...this.#templates.keys()],
        })
      }
      for (const requirement of bound) {
        const at = nowIso()
        await this.#mutateRequirement(requirement.id, undefined, draft => {
          draft.templateId = fallback.id
          draft.templateRevision = currentTemplateRevision(fallback)
          if (nodeIndex(fallback, draft.nodeId) < 0) draft.nodeId = fallback.nodes[0].id
          draft.nodes = recomputeNodes(draft, fallback, at)
          draft.updatedAt = at
          draft.updatedBy = who.session
          draft.rev = (draft.rev ?? 0) + 1
          draft.history.push(this.#retemplateEntry(draft, who, at, `template ${id} deleted → ${fallback.id}`, true))
          return draft
        }, '', at)
      }
    }
    await this.#templates.delete(id)
    await this.#bumpRevision()
    return { id, deleted: true }
  }

  /**
   * One `retemplate` history entry (I4/I5).
   * @param draft - Requirement draft after its binding moved.
   * @param who - `{ session, name }` of the caller.
   * @param at - Instant of the move.
   * @param note - Why the template changed, with the prefix that names the reason.
   * @param force - Whether the move overrode a gate.
   * @returns the history entry.
   */
  #retemplateEntry(draft, who, at, note, force) {
    return {
      id: mintId('evt'),
      at,
      by: who.session,
      byName: who.name,
      action: 'retemplate',
      from: null,
      fromName: '',
      to: draft.nodeId,
      toName: draft.nodeId,
      fromStatus: draft.status,
      toStatus: draft.status,
      note,
      force,
      durationMs: null,
    }
  }

  /**
   * Record the role a created session resolves to.
   *
   * The `agent/created` listener is the only caller, so this runs for every
   * session: it writes only when the stored record differs from the resolution,
   * and the listener owns the never-throw guarantee.
   * @param agent - The Agent from `agent/created`.
   * @returns the stored record, or undefined when the session resolves no role.
   */
  async establishRole(agent) {
    return await this.#roles.establish(agent)
  }

  /**
   * Every role the board knows, plus the ids that are in use but unrecorded.
   * @returns `{ items, unregistered }`.
   */
  listRoles() {
    return this.#roles.list()
  }

  /**
   * The panel's role catalogue: the role records plus the live preset roster.
   *
   * {@link listRoles} stays the synchronous record view every reader shares —
   * the snapshot, the prompt's role line, the model's `requirement_role` tool —
   * and its records are the same rows this returns. The preset half is
   * asynchronous because the registry audits each preset's activation while it
   * lists it, so it is read only where it is shown: when the role dialog opens.
   * @returns `{ items, unregistered, presets }`; `presets` is
   * `{ items, unavailable }` (`host/roles.js` `presetRoster`).
   */
  async listRoleCatalogue() {
    return { ...this.#roles.list(), presets: await this.#roles.presetRoster() }
  }

  /**
   * Create or edit a role by hand. The panel is the only caller: the model has
   * `requirement_role{list}` and no management action.
   * @param input - Raw `{ roleId, roleName, duties }`.
   * @returns the stored record.
   */
  async putRole(input) {
    return await this.#roles.put(input)
  }

  /**
   * Delete a role by hand. Requirements that still name it are left alone; an
   * unresolvable role is reported as `unregistered`, not repaired by a cascade.
   * @param id - Role id.
   * @returns `{ id, deleted: true }`.
   */
  async deleteRole(id) {
    return await this.#roles.remove(id)
  }

  /**
   * Clear the dangling references an interrupted write chain leaves behind, and
   * normalize a template pin that names no stored version (§11.4).
   * Mount-time work: the sweep itself writes no history and reports what it
   * removed, while a repaired pin does leave the `retemplate` entry that explains
   * why the requirement moved.
   *
   * The sweep detects them; settling a delegation is this service's own work,
   * because the write it needs is the one `revoke` and `agent/disposed` already
   * run. The lock mode follows the evidence the detection used: a session the
   * registry no longer knows is gone, so its lock is marked `orphaned` and the
   * requirement becomes takeable, while a row whose role was merely missing may
   * belong to a live holder whose lock must not move.
   * @returns `{ removedRoles, removedQueueItems, unboundLinks, dangledDelegations, settledDelegations, repairedPins, deferred }`.
   */
  async sweepDangling() {
    const swept = await this.#roles.sweep()
    const live = this.#roles.liveSessions()
    const settledDelegations = []
    for (const id of swept.dangledDelegations) {
      const session = this.#requirements.get(id)?.delegatedTo?.session ?? ''
      const lock = live !== undefined && session !== '' && !live.has(session) ? 'orphan' : 'keep'
      const settled = await this.#settleDelegation(id, { lock })
      if (settled.roleId !== '') settledDelegations.push({ id, roleId: settled.roleId })
    }
    const repairedPins = await this.#repairDanglingPins()
    return { ...swept, settledDelegations, repairedPins }
  }

  /**
   * Normalize the requirements whose pinned template revision no longer exists
   * (`DESIGN.md` §11.4).
   *
   * The public write path cannot produce this state — `pruneTemplateVersion`
   * refuses a pinned revision and `migrateRequirementsToRevision` validates its
   * target — so it can only come from a medium edited outside this plugin. Healing
   * it at open is what keeps `invalid-transition` from becoming a state a person
   * sees: the pin moves to the template's current revision, the node is normalized
   * by the same rule a rebinding uses (the target's first node, `checklist` ticks
   * blanked when the length changed), and a `retemplate` entry records it with a
   * `pinned revision <n> missing → <m>` note. A requirement with no pin at all is
   * left alone: it reads as revision 1, and the design backfills nothing.
   * @returns the ids of the requirements whose pin was repaired.
   */
  async #repairDanglingPins() {
    const repaired = []
    for (const requirement of this.#allRequirements()) {
      const stored = this.#templates.get(requirement.templateId)
      if (stored === undefined) continue
      if (templateAtRevision(stored, requirement.templateRevision) !== null) continue
      const at = nowIso()
      const who = { session: '', name: '' }
      await this.#mutateRequirement(requirement.id, undefined, draft => {
        const template = this.#template(draft.templateId)
        const revision = currentTemplateRevision(template)
        const missing = draft.templateRevision ?? 1
        draft.templateRevision = revision
        if (nodeIndex(template, draft.nodeId) < 0) draft.nodeId = template.nodes[0].id
        draft.nodes = recomputeNodes(draft, template, at)
        draft.updatedAt = at
        draft.updatedBy = ''
        draft.rev = (draft.rev ?? 0) + 1
        draft.history.push(this.#retemplateEntry(draft, who, at, `pinned revision ${missing} missing → ${revision}`, false))
        return draft
      }, '', at)
      repaired.push(requirement.id)
    }
    return repaired
  }

  /**
   * Project statistics over the whole board.
   *
   * The board-derived counts sit beside the flow statistics: reservations and
   * delegations come from the queues and requirement tables, orphaned locks from
   * the one lock classifier, and `byKind`/`byRole`/`decisions` from the records
   * themselves. Those three count open requirements only — a done or archived
   * record is history, so `decisions` is literally how many questions still wait
   * for a person. `byKind` keeps exactly the declared kinds: a stored kind outside
   * them is not counted, because the pool and `judgeClaim` treat it as no kind at
   * all and a third bucket here would report the same record under two readings.
   *
   * `criticalPath` is the one reading §5.9 fixes: the number of requirements
   * whose priority was raised by the work they hold up. It counts the raised
   * requirements, never the blocked ones, so the statistic and the prompt tag
   * (`[high↑]`) always name the same set. A raised requirement is one that holds
   * up work still in progress, so an archived blocker that still blocks is
   * counted and shelved or finished work raises nothing.
   *
   * `running` and `execSync` are §5.6's execution readings: how many requirements
   * have an execution unit still executing, and how much the synchronizer could
   * not attribute or could not observe. Both are counts of things that happened,
   * so a composition without the registries reports zeros with `sync.gap` set on
   * the requirements it could not follow, rather than pretending it watched them.
   * `execSync` reads the domain global, which is what the synchronizer updates
   * without moving the document revision.
   * @param options - `now` override, used by tests.
   * @returns the statistics payload.
   */
  stats(options = {}) {
    const now = options.now ?? nowIso()
    const stats = computeStats(this.#requirementsView(), {
      now,
      stallAfterHours: this.#config.stallAfterHours,
    })
    // Reservation observations (§5.3). A reservation is unique per requirement by
    // construction, so `queued` and `reserved` agree today; they stay separate
    // because they answer different questions — how much work is waiting in
    // queues, and how many requirements that waiting keeps out of the pool.
    const rows = [...this.#queues.entries()].filter(([, row]) => row.items.length > 0)
    // A delegation whose named session has not taken the lock is waiting to be
    // picked up (§5.6): the work is public knowledge but nothing has started.
    const pendingDelegations = [...this.#requirements.entries()].filter(([, requirement]) => {
      const bound = requirement.delegatedTo ?? null
      if (bound === null || requirement.status === 'done' || requirement.status === 'archived') return false
      return requirement.lock?.session !== bound.session
    }).length
    const byKind = { task: 0, decision: 0 }
    const byRole = new Map()
    const escalation = this.#derive().index
    let decisions = 0
    let orphanedLocks = 0
    let criticalPath = 0
    let running = 0
    for (const [, requirement] of this.#requirements.entries()) {
      const settled = requirement.status === 'done' || requirement.status === 'archived'
      if (lockState(requirement, '', now, this.#config.staleClaimHours).state === 'orphaned') orphanedLocks += 1
      // Execution is counted whether or not the requirement is settled: a unit
      // still running on a done requirement is a fact the panel has to show, and
      // it is exactly the state a missed settlement leaves behind.
      running += runningCount(requirement)
      // A requirement raised above its own priority holds up work still in
      // progress; no open filter is needed, because escalation is derived from
      // that relation.
      if (escalation.get(requirement.id)?.escalated === true) criticalPath += 1
      if (settled) continue
      const kind = requirement.kind ?? 'task'
      // The same closed set the pool and `judgeClaim` use: a kind outside it is
      // not a third category to count, it is a record the write path never
      // produced, and inventing a bucket for it would report one fact under two
      // readings (§4.2). `byKind` therefore keeps exactly the two declared keys.
      if (kind === 'task' || kind === 'decision') byKind[kind] += 1
      // A decision is counted while it still waits for a person; once it is done
      // or archived it is history, like every other requirement.
      if (kind === 'decision') decisions += 1
      const role = requirement.role ?? ''
      const entry = byRole.get(role) ?? { role, total: 0, done: 0, blocked: 0, active: 0 }
      entry.total += 1
      entry[requirement.status] = (entry[requirement.status] ?? 0) + 1
      byRole.set(role, entry)
    }
    return {
      ...stats,
      byKind,
      // Unrouted work groups under `''`, the value the record holds, so one place
      // answers "how much work still needs a role chosen".
      byRole: [...byRole.values()].sort((a, b) => b.total - a.total || a.role.localeCompare(b.role)),
      decisions,
      criticalPath,
      queues: rows.length,
      queued: rows.reduce((total, [, row]) => total + row.items.length, 0),
      reserved: new Set(rows.flatMap(([, row]) => row.items.map(item => item.id))).size,
      orphanedLocks,
      pendingDelegations,
      running,
      execSync: { ignored: 0, gaps: 0, ...this.#domain.global.get().execSync },
    }
  }

  /**
   * Requirements and transitions touched after an instant. This is how a
   * session that was busy catches up without polling the whole board.
   *
   * The summaries carry the gate and escalation values but not `claimable` or
   * `advanceable`: a catch-up diff is asked for the board, not for one session's
   * eligibility, and those two are left out rather than answered for nobody.
   * @param since - ISO instant; defaults to one hour ago.
   * @returns `{ since, requirements, transitions, revision }`.
   */
  changesSince(since) {
    const cutoff = since === undefined || since === null || since === '' ? new Date(Date.now() - 3_600_000).toISOString() : new Date(since).toISOString()
    const requirements = []
    const transitions = []
    const derived = this.#derive()
    for (const [, requirement] of this.#requirements.entries()) {
      if (String(requirement.updatedAt) > cutoff) {
        const template = this.#templates.get(requirement.templateId)
        const gate = { ...derived.index.get(requirement.id), children: derived.children.get(requirement.id) ?? [] }
        requirements.push(template === undefined
          ? summarize(requirement, { id: requirement.templateId, name: requirement.templateId, nodes: [] }, gate)
          : summarize(requirement, this.#atRevision(template, requirement.templateRevision), gate))
      }
      for (const entry of requirement.history ?? []) {
        if (String(entry.at) > cutoff) transitions.push({ requirementId: requirement.id, title: requirement.title, ...entry })
      }
    }
    transitions.sort((a, b) => String(a.at).localeCompare(String(b.at)))
    return { since: cutoff, revision: this.#revision, requirements, transitions, truncated: transitions.length > 200 }
  }

  /**
   * The full board as the browser panel reads it.
   * @param filter - Optional list filter applied to `requirements`.
   * @param me - Session the `claimable` filter is asked for; `''` asks for the
   * panel.
   * @returns `{ revision, generatedAt, requirements, templates, stats, total, queues }`.
   */
  snapshot(filter = {}, me = '') {
    const listed = this.listRequirements({ ...filter, limit: filter.limit ?? 200, offset: filter.offset ?? 0 }, me)
    const requirements = listed.items.map(item => this.getRequirement(item.id, me))
    return {
      revision: this.#revision,
      generatedAt: nowIso(),
      requirements,
      total: listed.total,
      templates: this.listTemplates().items,
      roles: this.listRoles(),
      stats: this.stats(),
      // Every session's queue, in the order it will be taken (§5.3). The panel
      // renders positions from this projection rather than from its own ordering:
      // the server owns the queue, so a reservation's position and the position
      // the `queue`/`unqueue` receipts name come from one source.
      queues: this.#queueView(),
    }
  }

  /**
   * Every session's queue row as one list (§5.3).
   *
   * Rows are ordered by session id so two snapshots of an unchanged board list
   * them identically; each row keeps the stored item order, which is the order
   * the session will take them in.
   * @returns `[{ session, sessionName, items, head, length, updatedAt }]`.
   */
  #queueView() {
    return [...this.#queues.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([session, row]) => {
        const { changed, ...rest } = this.#presentQueue(session, row, false)
        return rest
      })
  }

  /**
   * Build the bounded runtime-context text a model step sees for one session.
   *
   * The sections are the ones §6 fixes, and each requirement appears in exactly
   * one of them. A delegated decision is the one routing that has no claimant: the
   * human owns it whatever session was named, so it never enters "Delegated to you"
   * and stays in the human's section (§4.5, §5.7).
   * @param session - Session id the step belongs to, or `''` for the global view.
   * @param limit - Maximum number of requirements named.
   * @returns prompt text, empty when the board holds nothing worth reporting.
   */
  promptContext(session, limit) {
    const all = [...this.#requirements.entries()].map(([, requirement]) => requirement).filter(requirement => requirement.status !== 'archived')
    // The role paragraph is the section's first line and stands on its own: a
    // session whose board is empty still needs to know which role it holds.
    const role = this.#roles.promptLine(session)
    if (all.length === 0 && role === '') return ''
    const lines = []
    const mine = session === '' ? [] : all.filter(requirement => (requirement.sessions ?? []).includes(session))
    const others = all.filter(requirement => !mine.includes(requirement))
    // A decision belongs to its own section for every session (§6): it is not work
    // any session may take, so leaving it in "this session's" or "other sessions'"
    // would both duplicate it and describe it as something to pick up.
    const work = [mine, others].map(list => list.filter(requirement => (requirement.kind ?? 'task') !== 'decision'))
    const [ownWork, otherWork] = work
    const escalation = this.#derive().index
    // The escalation tag is §5.9's `[high↑]`: the priority the requirement reads
    // at, marked only when what it blocks raised it.
    const priorityTag = requirement => {
      const gate = escalation.get(requirement.id)
      return `${gate?.effectivePriority ?? requirement.priority}${gate?.escalated === true ? '↑' : ''}`
    }
    const name = requirement => {
      const stored = this.#templates.get(requirement.templateId)
      // A requirement the board lists must resolve its pinned revision; the
      // open-time sweep repairs a dangling pin before any step reads this, so a
      // miss here is a loud failure rather than a silently substituted version.
      const template = stored === undefined ? undefined : this.#atRevision(stored, requirement.templateRevision)
      const node = template?.nodes.find(candidate => candidate.id === requirement.nodeId)
      const index = template === undefined ? -1 : nodeIndex(template, requirement.nodeId)
      const total = template?.nodes.length ?? 0
      const parts = [
        requirement.id,
        `[${priorityTag(requirement)}]`,
        requirement.title,
        `· node ${index + 1}/${total} ${node?.name ?? requirement.nodeId}`,
        `· ${requirement.status}`,
        requirement.owner === '' ? '' : `· owner ${requirement.owner}`,
        requirement.status === 'blocked' && requirement.blockReason !== '' ? `· blocked: ${requirement.blockReason}` : '',
      ]
      return `- ${parts.filter(Boolean).join(' ')}`
    }
    lines.push('<requirement-board>')
    lines.push(`Shared requirement board: ${all.length} active requirement(s). Read and update it with the requirement_board tool; changes made in any session are visible here immediately.`)
    if (role !== '') lines.push(role)
    // One budget for every section, so a busy board cannot crowd out the role
    // line or the requirements this session can act on first. The decisions are
    // reserved before the other sections and emitted last: §6 fixes the order and
    // a decision the human owes is what unblocks work, so a long claimable list
    // must not starve it out of the prompt.
    let budget = limit
    // Only a question that still waits belongs here: a decision the human already
    // answered is history, and the header promises these are things to advance. This
    // is the same set `stats.decisions` counts, so the prompt and the statistics
    // never disagree about how many questions are outstanding.
    const decisions = all.filter(requirement => (requirement.kind ?? 'task') === 'decision' && requirement.status !== 'done')
    const decisionShown = decisions.slice(0, Math.max(0, budget))
    budget -= decisionShown.length
    // A delegation this session has not claimed yet (§5.5 step 5): the server
    // marks the temporary role the task runs under, so the session learns which
    // role id to run with from this section alone and a parent that forgets to
    // restate it in `send_message` cannot leave the child guessing. It comes
    // before the pool because that is the order the work must be taken in: one
    // lock exists per session, and spending it on a public task while a named
    // delegation waits is the mistake the wording below prevents.
    //
    // Only tasks are listed. A delegated decision has no claimant at all — the
    // human owns it whichever session it was routed to, and `claim` refuses it
    // with `decision-task` — so telling the session to claim it would be advice it
    // cannot follow. It stays in the human's own section below, which is where the
    // record says the work really waits.
    const delegatedForMe = session === ''
      ? []
      : all.filter(requirement => (requirement.kind ?? 'task') === 'task'
        && requirement.delegatedTo?.session === session
        && requirement.lock?.session !== session)
    const delegatedIds = new Set(delegatedForMe.map(requirement => requirement.id))
    // This session's soft reservations, in the order it made them (§5.3); the head
    // is named in the header so the model does not have to read the list to know
    // what is next. A queued requirement is left out of "Claimable" below for the
    // same reason a locked one is — one requirement belongs to one section (§6):
    // a requirement this session already locked is executing, and one it queued
    // is listed here.
    const queued = (session === '' ? [] : (this.#queueRow(session)?.items ?? []))
      .map(item => this.#requirements.get(item.id))
      .filter(requirement => requirement !== undefined)
    const queuedIds = new Set(queued.map(requirement => requirement.id))
    const takeable = session === ''
      ? []
      : all.filter(requirement => !queuedIds.has(requirement.id)
        && !delegatedIds.has(requirement.id)
        && requirement.lock?.session !== session
        && claimable(requirement, session, this.#roleIdOf(session), { reservedBy: this.#reservationOf(requirement.id) }))
    if (delegatedForMe.length > 0 && budget > 0) {
      lines.push(`Delegated to you (${delegatedForMe.length}) — claim it before you start:`)
      lines.push(...delegatedForMe.slice(0, budget).map(requirement => {
        // Who delegated it comes from the history entry that recorded the act, not
        // from `delegatedTo.name`, which names the session the work went to — this
        // section is read by that session, so it needs the other end (§6).
        const entry = [...(requirement.history ?? [])].reverse().find(candidate => candidate.action === 'delegate')
        const by = entry === undefined ? '' : (entry.byName === '' ? entry.by : `${entry.byName} (${entry.by})`)
        return [
          name(requirement),
          by === '' ? '' : `· delegated by ${by}`,
          `· your role for this task: ${requirement.delegatedTo.roleId}`,
        ].filter(Boolean).join(' ')
      }))
      if (delegatedForMe.length > budget) lines.push(`- … ${delegatedForMe.length - budget} more delegated`)
      budget -= Math.min(delegatedForMe.length, budget)
    }
    if (takeable.length > 0 && budget > 0) {
      lines.push(delegatedForMe.length > 0
        ? `Claimable for you (${takeable.length}) — take one of these only after the delegated work above:`
        : `Claimable for you (${takeable.length}) — claim one proactively:`)
      lines.push(...takeable.slice(0, budget).map(name))
      if (takeable.length > budget) lines.push(`- … ${takeable.length - budget} more claimable`)
      budget -= Math.min(takeable.length, budget)
    }
    if (queued.length > 0 && budget > 0) {
      lines.push(`Your queue (${queued.length} queued, next: ${queued[0].id}):`)
      lines.push(...queued.slice(0, budget).map(name))
      if (queued.length > budget) lines.push(`- … ${queued.length - budget} more queued`)
      budget -= Math.min(queued.length, budget)
    }
    // §6: the requirements this session already holds, with what is executing on
    // them. A locked requirement is deliberately absent from "Claimable", so this
    // is the only section that says the session's one lock is spent — and a model
    // that cannot see its own child will start a second one. A requirement whose
    // synchronizer could not observe it says so here rather than reading as idle.
    const executingNow = (session === ''
      ? all.filter(requirement => runningCount(requirement) > 0)
      : all.filter(requirement => requirement.lock?.session === session))
    if (executingNow.length > 0 && budget > 0) {
      const at = nowIso()
      lines.push(`Executing now (${executingNow.length} held by you):`)
      lines.push(...executingNow.slice(0, budget).map(requirement => {
        const units = [...(requirement.executions ?? [])]
          .filter(unit => unit.status === 'running' || unit.status === 'stopping')
          .map(unit => `${unit.kind} ${unit.status} (${ageText(unit.startedAt, at)})`)
        const sync = this.#syncView(requirement)
        return [
          name(requirement),
          units.join(' · '),
          sync.gap ? 'execution sync has a gap: state may be stale' : '',
          !sync.enabled ? 'execution sync is off: only the lock is known' : '',
        ].filter(Boolean).join(' · ')
      }))
      if (executingNow.length > budget) lines.push(`- … ${executingNow.length - budget} more held by you`)
      budget -= Math.min(executingNow.length, budget)
    }
    if (ownWork.length > 0 && budget > 0) {
      lines.push(`This session's requirements (${ownWork.length}):`)
      lines.push(...ownWork.slice(0, budget).map(name))
      if (ownWork.length > budget) lines.push(`- … ${ownWork.length - budget} more in this session`)
      budget -= Math.min(ownWork.length, budget)
    }
    if (otherWork.length > 0 && budget > 0) {
      lines.push(`Other sessions' requirements (${otherWork.length}):`)
      lines.push(...otherWork.slice(0, budget).map(name))
      if (otherWork.length > budget) lines.push(`- … ${otherWork.length - budget} more`)
    }
    if (decisions.length > 0 && decisionShown.length > 0) {
      // The wording is the whole point of the section: these are questions the
      // human answers in the panel, so an agent reading this board learns to wait
      // or to add context rather than to claim the decision it is waiting on.
      lines.push(`Waiting on the human (${decisions.length}) — only the human advances these:`)
      lines.push(...decisionShown.map(requirement => {
        const requestedBy = requirement.requestedBy ?? ''
        return [
          `- ${requirement.id} [${priorityTag(requirement)}] ${requirement.title}`,
          requirement.status === 'blocked' && requirement.blockReason !== '' ? `· blocked: ${requirement.blockReason}` : '',
          requestedBy === '' ? '' : `· requested by ${requestedBy}`,
        ].filter(Boolean).join(' ')
      }))
      if (decisions.length > decisionShown.length) lines.push(`- … ${decisions.length - decisionShown.length} more waiting on the human`)
    }
    lines.push('</requirement-board>')
    return lines.join('\n')
  }
}
