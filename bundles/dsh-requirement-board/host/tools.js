/**
 * Agent-facing tools.
 *
 * Each tool is a thin adapter over {@link RequirementService}: it parses the
 * model's JSON arguments, calls the same methods the browser routes call, and
 * renders a bounded text result. No board rule is implemented here.
 */

import { ENDPOINTS, imageUrl } from './http.js'
import { templateView } from './templates.js'

/** Requirement priorities, as the tool enum spells them. */
const PRIORITY_ENUM = ['low', 'normal', 'high', 'urgent']

/** Requirement states, plus `open` meaning "neither done nor archived". */
const STATUS_ENUM = ['active', 'blocked', 'done', 'archived', 'open']

/** Requirement kinds. A `decision` is the human's to advance. */
const KIND_ENUM = ['task', 'decision']

/** Transition verbs. */
const TRANSITION_ENUM = ['advance', 'rollback', 'jump', 'complete', 'reopen']

/** Largest rendered result, in characters. */
const MAX_RENDER = 6000

/** Render a JSON value as bounded text. */
function renderJson(value) {
  const text = JSON.stringify(value, null, 2) ?? 'null'
  if (text.length <= MAX_RENDER) return text
  return `${text.slice(0, MAX_RENDER)}\n… [truncated ${text.length - MAX_RENDER} of ${text.length} characters; narrow the filter or read one requirement with action "get"]`
}

/** Render a tool result as one text content block. */
function textContent(text) {
  return [{ type: 'text', text }]
}

/** The board tool's parameter schema. */
const BOARD_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'get', 'create', 'update', 'claim', 'release', 'queue', 'unqueue', 'delegate', 'transition', 'checklist', 'block', 'unblock', 'archive', 'restore', 'delete', 'stats', 'changes'],
      description: 'Operation to perform. `claim` takes a requirement\'s execution lock, `release` gives it back, `queue` reserves your next requirement without locking it, and `unqueue` drops that reservation. `delegate` names a sub-session to run one requirement under a temporary role, and `delegate{revoke:true}` ends that delegation. A structural change (`update` of `role`/`templateId`, `transition`, `checklist`, `block`, `unblock`, `archive`, `delete`) needs the lock first. Each action applies the arguments this schema declares under their own names — `update` takes `title`, `priority`, `role`, and so on directly, not a nested patch object — and a value sent under a name this schema does not declare is not applied.',
    },
    id: { type: 'string', description: 'Requirement id, e.g. `req_1a2b3c4d5e`. Required for every action except `create`, `list`, `stats`, and `changes`.' },
    title: { type: 'string', description: 'Requirement title. Required for `create`.' },
    summary: {
      type: 'string',
      description: 'The requirement in one or two plain-language sentences for a reader who will not read `description`: what is wanted and why it matters, without implementation detail, at most 300 characters. Required for `create`; used by `update`.',
    },
    description: { type: 'string', description: 'Requirement detail: scope and boundaries, acceptance criteria, and where the deliverable lands. Used by `create` and `update`; `summary` is what a reader sees first.' },
    priority: { type: 'string', enum: PRIORITY_ENUM, description: 'Used by `create` and `update`. Defaults to `normal` on create.' },
    kind: {
      type: 'string',
      enum: KIND_ENUM,
      description: 'Used by `create`, and as a filter by `list`. A `decision` requirement is a question for the human: nobody may claim, move, delegate, archive, delete, or queue it, and `kind` cannot be changed after creation. Defaults to `task`.',
    },
    owner: { type: 'string', description: 'Person accountable for the requirement. Used by `create` and `update`.' },
    role: { type: 'string', description: 'Role id the requirement is routed to, or empty for "any role". Call `requirement_role` with action `list` for ids. Used by `create` and `update`; changing it needs the lock. Used by `list` as a filter: keep requirements routed to exactly this role now — a delegated requirement is found by its temporary role id, which is what makes `role: "human"` the human\'s inbox.' },
    claimable: { type: 'boolean', description: 'Used by `list`: keep only requirements this session may claim now (right role, no lock held by another session, not reserved).' },
    templateId: { type: 'string', description: 'Flow template the requirement is bound to. Used by `create` and `update`. Call `flow_template` with action `list` for ids.' },
    sessions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Session ids that share this requirement. Used by `create` and `update`; replaces the stored list. Your own session is added automatically on create.',
    },
    labels: { type: 'array', items: { type: 'string' }, description: 'Free-form labels. Used by `create` and `update`.' },
    images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Image ids of pictures attached to this requirement, in display order. Used by `create` and `update`; replaces the stored list, and an id that names no stored image fails with `invalid-image`. A person uploads a picture through the board panel before naming it here; every requirement these tools return lists `images`, each entry carrying `url` and `path` — the absolute file on this host, which you can open to read the picture.',
    },
    parentId: { type: 'string', description: 'Requirement this one is a part of, or empty for none. Used by `create` and `update`; changing it needs the lock. It must exist, and the parent chain must not come back to this requirement.' },
    blocksOn: {
      type: 'array',
      items: { type: 'string' },
      description: 'Requirements that must finish before this one may `advance` or `complete`. Used by `create` and `update`; changing it needs the lock. At most 20 ids; each must exist and must not lead back to this requirement.',
    },
    transition: {
      type: 'string',
      enum: TRANSITION_ENUM,
      description: 'Transition verb for `transition`. `advance` moves to the next node; `rollback` needs `to` and `note`; `jump` needs `to`, `note`, and `force`; `complete` finishes the whole requirement; `reopen` returns a done requirement to active.',
    },
    to: { type: 'string', description: 'Target node id for `rollback` and `jump`. Take it from the requirement\'s `flow` array.' },
    note: { type: 'string', description: 'Reason for the transition. Required for `rollback` and `jump`; also clears a node whose completion condition requires one. Used by `release` to say why the lock was dropped.' },
    force: { type: 'boolean', description: 'Set `true` to override an unmet completion condition or prerequisite, or to run `jump`. Recorded in the history.' },
    index: { type: 'integer', description: 'Checklist position for `checklist`, counting from 0 in the active node\'s declared order.' },
    checked: { type: 'boolean', description: 'Whether that checklist entry becomes ticked. Defaults to true.' },
    reason: { type: 'string', description: 'Why the requirement is blocked. Required for `block`.' },
    archived: { type: 'boolean', description: 'Unused; use `archive` and `restore`.' },
    session: { type: 'string', description: 'Used by `list` as a filter: keep requirements shared with this session id. Used by `delegate` as the operation target: the sub-session id to run the requirement.' },
    status: { type: 'string', enum: STATUS_ENUM, description: 'Filter by state. `open` means neither done nor archived.' },
    query: { type: 'string', description: 'Case-insensitive substring matched against title, description, and id.' },
    limit: { type: 'integer', description: 'Maximum rows returned by `list`. Defaults to 50, capped at 200.' },
    since: { type: 'string', description: 'ISO-8601 instant for `changes`; defaults to one hour ago.' },
    revoke: { type: 'boolean', description: 'Set `true` on `delegate` to revoke the requirement\'s delegation instead of making one: the named session is released, the temporary role is deleted, and the requirement returns to the role it had before. When there is no delegation to end the call still succeeds and reports `changed: false`.' },
    duties: { type: 'array', items: { type: 'string' }, description: 'Duties the temporary role declares for the delegated work. Used by `delegate`; optional, and never more than 12 entries of 40 characters.' },
    roleName: { type: 'string', description: 'Display name for the temporary role `delegate` mints. Defaults to the role id.' },
    expectedRev: { type: 'integer', description: 'Revision you last read. When the stored revision differs the call fails with `conflict` instead of overwriting another session\'s work.' },
  },
  required: ['action'],
  additionalProperties: false,
}

/** The flow-template tool's parameter schema. */
const TEMPLATE_PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'get', 'create', 'revise', 'migrate', 'archive', 'clone', 'delete'], description: 'Operation to perform.' },
    id: { type: 'string', description: 'Template id. Required for `get`, `revise`, `migrate`, `archive`, `clone`, and `delete`; optional for `create`, which mints one.' },
    name: { type: 'string', description: 'Template name. Required for `create` and `clone`; used by `revise` to rename within the new version.' },
    description: { type: 'string', description: 'Template summary. Used by `create` and `revise`.' },
    nodes: {
      type: 'array',
      description: 'Template nodes in flow order, each `{ name, id?, assignee?, description?, dependsOn?, completion? }`. `completion` is `{ type: "manual" | "checklist", checklist?: string[], requireNote?: boolean }`. `dependsOn` names other node ids in this template. Used by `create` and `revise`, and for `revise` it is the complete target list: a node id absent from it is removed, and a node without an id gets one derived from its name.',
      items: { type: 'object' },
    },
    expectedRevision: { type: 'integer', description: 'Template `revision` you last read. `revise` fails with `conflict` (carrying `{ expected, current }`) when the stored revision differs, instead of appending onto another editor\'s version.' },
    revision: { type: 'integer', description: 'Target revision for `migrate`; defaults to the template\'s current revision. A revision the template does not store is refused with `invalid-transition`.' },
    requirementIds: { type: 'array', items: { type: 'string' }, description: '`migrate` only: the requirements to move. Omit it to mean "every requirement still on an older revision", which requires `force`.' },
    force: { type: 'boolean', description: 'Set `true` on `delete` to rebind requirements still using the template onto the default one, and on a bulk `migrate` (one with no `requirementIds`) to confirm moving every requirement still on an older revision. A `migrate` that names `requirementIds` needs no `force`.' },
    archived: { type: 'boolean', description: '`archive` only: `true` (the default when omitted) shelves the template, `false` restores it. An archived template stays readable but is not offered to a new requirement.' },
    includeArchived: { type: 'boolean', description: '`list` only: include archived templates. Defaults to `false`.' },
  },
  required: ['action'],
  additionalProperties: false,
}

/** The role tool's parameter schema. Roles are managed in the board panel. */
const ROLE_PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list'], description: 'Operation to perform.' },
  },
  required: ['action'],
  additionalProperties: false,
}

/**
 * Build the actor record for a tool call.
 * @param exec - Tool run context.
 * @returns `{ session, name }`.
 */
function actorOf(exec) {
  const agent = exec?.agent
  return { session: typeof agent?.id === 'string' ? agent.id : '', name: '' }
}

/**
 * Point the model at the bytes of every image one result carries.
 *
 * A requirement payload lists `images` refs, and the model reads a picture by
 * opening its file, so each ref gains the two locations it can act on: `url`, the
 * board route the browser reads it from, and `path`, the absolute file on this
 * host. The stored ref keeps its own fields, so the record and the result show
 * the same image metadata.
 * @param service - The board service, which owns the on-disk layout.
 * @param result - One tool result.
 * @returns the result with every listed image located.
 */
function locateImages(service, result) {
  if (result === null || typeof result !== 'object') return result
  const locate = value => {
    if (value === null || typeof value !== 'object' || !Array.isArray(value.images)) return value
    return {
      ...value,
      images: value.images.map(ref => ({ ...ref, url: imageUrl(ref.id), path: service.imageFilePath(ref) })),
    }
  }
  // `list` carries its requirement rows under `items`, the catch-up diff under
  // `requirements`, and every single-requirement receipt at the top level.
  let located = locate(result)
  for (const key of ['items', 'requirements']) {
    if (Array.isArray(located[key])) located = { ...located, [key]: located[key].map(locate) }
  }
  return located
}

/**
 * Execute one `requirement_board` call.
 * @param service - The board service.
 * @param args - Parsed tool arguments.
 * @param exec - Tool run context.
 * @returns the operation's result.
 */
async function runBoardAction(service, args, exec) {
  const actor = actorOf(exec)
  switch (args.action) {
    case 'list':
      return service.listRequirements({
        session: args.session,
        owner: args.owner,
        status: args.status,
        priority: args.priority,
        kind: args.kind,
        role: args.role,
        templateId: args.templateId,
        query: args.query,
        claimable: args.claimable,
        limit: args.limit,
      }, actor.session)
    case 'get':
      // The session's own queue rides along with the requirement (§5.6): "get
      // before you claim" then answers "what am I already holding" in one call.
      // The session is also what `claimable`/`advanceable` in the result are
      // answered for, so a model reading them reads its own answer.
      return { ...service.getRequirement(args.id, actor.session), queue: service.queueOf(actor.session) }
    case 'create':
      return await service.createRequirement({
        title: args.title,
        summary: args.summary,
        description: args.description,
        kind: args.kind,
        priority: args.priority,
        owner: args.owner,
        templateId: args.templateId,
        role: args.role,
        sessions: args.sessions,
        labels: args.labels,
        images: args.images,
        parentId: args.parentId,
        blocksOn: args.blocksOn,
        note: args.note,
      }, actor)
    case 'claim':
      return await service.claim(args.id, { expectedRev: args.expectedRev }, actor)
    case 'release':
      return await service.release(args.id, { note: args.note, expectedRev: args.expectedRev }, actor)
    case 'queue':
      return await service.queue(args.id, {}, actor)
    case 'unqueue':
      // The tool has no `targetSession`: a session clears only its own
      // reservation, and the panel that may clear anyone's does not run tools.
      return await service.unqueue(args.id, {}, actor)
    case 'delegate':
      // The tool names the target in `session`; the actor stays the calling
      // session, which is what the ownership check is made against.
      return await service.delegate(args.id, {
        session: args.session,
        duties: args.duties,
        roleName: args.roleName,
        revoke: args.revoke,
        note: args.note,
        expectedRev: args.expectedRev,
      }, actor)
    case 'update':
      return await service.updateRequirement(args.id, {
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.summary === undefined ? {} : { summary: args.summary }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        ...(args.owner === undefined ? {} : { owner: args.owner }),
        ...(args.templateId === undefined ? {} : { templateId: args.templateId }),
        ...(args.role === undefined ? {} : { role: args.role }),
        ...(args.sessions === undefined ? {} : { sessions: args.sessions }),
        ...(args.labels === undefined ? {} : { labels: args.labels }),
        ...(args.images === undefined ? {} : { images: args.images }),
        ...(args.parentId === undefined ? {} : { parentId: args.parentId }),
        ...(args.blocksOn === undefined ? {} : { blocksOn: args.blocksOn }),
        ...(args.expectedRev === undefined ? {} : { expectedRev: args.expectedRev }),
      }, actor)
    case 'transition':
      return await service.transitionRequirement(args.id, {
        action: args.transition,
        to: args.to,
        note: args.note,
        force: args.force,
        expectedRev: args.expectedRev,
      }, actor)
    case 'checklist':
      return await service.setChecklist(args.id, { index: args.index, checked: args.checked, expectedRev: args.expectedRev }, actor)
    case 'block':
      return await service.blockRequirement(args.id, { reason: args.reason, expectedRev: args.expectedRev }, actor)
    case 'unblock':
      return await service.unblockRequirement(args.id, { note: args.note, expectedRev: args.expectedRev }, actor)
    case 'archive':
      return await service.setArchived(args.id, { archived: true, expectedRev: args.expectedRev }, actor)
    case 'restore':
      return await service.setArchived(args.id, { archived: false, expectedRev: args.expectedRev }, actor)
    case 'delete':
      return await service.deleteRequirement(args.id, { expectedRev: args.expectedRev }, actor)
    case 'stats':
      return service.stats()
    case 'changes':
      return service.changesSince(args.since)
    default:
      return { error: `unknown action "${String(args.action)}"` }
  }
}

/**
 * Register every tool on the calling context.
 *
 * The schemas are strict (`additionalProperties: false`), and the platform's tool
 * executor drops an argument a schema does not declare rather than failing the
 * call. A caller therefore has to use the declared name: a field sent under any
 * other name — a nested `patch` on `update`, for instance — is silently not
 * applied, which is why each description says which arguments its action reads.
 * The tool body reads only its declared parameters, so this holds whether or not
 * a future executor starts validating instead of dropping.
 * @param ctx - Host plugin context carrying the `tools` service.
 * @param service - The board service.
 * @returns the disposer removing every registration.
 */
export function registerTools(ctx, service) {
  const board = ctx.tools.register({
    name: 'requirement_board',
    description: [
      'Read and change the shared cross-session requirement board.',
      'Requirements are visible to every session of this Harness process, so a change made here is what other sessions and their panels see.',
      'Every requirement carries `summary`: one or two plain-language sentences a person reads instead of the full `description`, which the panel keeps behind a fold. `create` requires it — at most 300 characters, and no implementation detail, since a summary that needs the detail has become the description.',
      'Use action "list" to find work — with `claimable: true` for what this session may take now — "get" for one requirement\'s flow, full transition history, and your own queue, "claim" to take a requirement\'s execution lock, "release" to give it back, and "stats" for project completion and blockers.',
      'You hold one lock at a time: while you execute something, reserve your next requirement with "queue" (a soft reservation — no lock, no work started) and claim it once the current one is done. A requirement another session reserved is reported as reserved, and one it locked is refused; "unqueue" drops a reservation you no longer want.',
      'To hand one requirement to a sub-session you own, use "delegate": it mints a temporary role for that task, and the sub-session claims the requirement through that delegation. Delegate only after you created the sub-session, tell it the requirement id, and end the delegation with "delegate" and `revoke: true` when it should stop.',
      'A requirement created with `kind: "decision"` is a question for the human: no session may claim, advance, delegate, archive, delete, or queue it, its `kind` never changes, and the panel is where a person answers it. Create one when a choice is genuinely the human\'s, and describe the options, their costs, and a default.',
      'The lock is required before advancing, ticking a checklist, blocking, archiving, deleting, or changing the role, flow template, parent, or blockers; a lock left untouched for the configured lease is taken over by the next claimant.',
      'Give a requirement `blocksOn` when other requirements must finish first: "advance" and "complete" are then refused until each of them is done — an archived blocker still blocks, because shelving work is not finishing it — unless you pass `force`, which records the gate it overrode in the history. The requirement\'s own flow node prerequisites are judged before those blockers, so an unmet node prerequisite reports `dependency-not-met` and only a cleared one reports `invalid-transition`. `parentId` groups work under a parent requirement, which "get" reports back as `children`.',
      '"get" and "list" report `gated`/`blockedBy` and the priority a requirement reads at: `effectivePriority` rises while the work it holds up is urgent, and `escalated` marks it as `[high↑]`. `claimable` and `advanceable` in those results are answered for the calling session: `claimable` means you could take it now, `advanceable` means you hold its lock and it is not `gated` and its node prerequisites are met — the same verdict "transition" gives without `force`, short of the node\'s own completion condition.',
      'The board follows what its locked requirements are executing: "get" reports `executions` (the sub-agents and background jobs observed for that requirement, each with `kind`, `label`, `status`, `progress`, and `startedAt`), `running` (how many are still executing), `execRev` (the observation revision — it moves on every observation, while `rev` moves only when the requirement itself is written), and `sync`, which says whether the observation is complete. `sync.enabled` false means execution sync is switched off, `sync.gap` true means an observation was lost, and `sync.reason` names which. Never treat `sync.gap` as "nothing is running".',
      'When `requireLockForExecution` is on, calling a tool that starts a sub-agent or a background job is refused unless your session holds a board lock; "claim" or "queue" a requirement first, or ask the operator to turn the setting off. The board\'s own tools stay available, so this refusal is never a dead end.',
      'A requirement may carry pasted pictures: `create` and `update` take `images`, the ids of images a person uploaded through the board panel (an id that names no stored image is refused as `invalid-image`), and every requirement these tools return lists `images`, each entry carrying `url` and `path` — the absolute file on this host, which you can open to read the picture.',
      'An execution observation never changes a requirement\'s `rev`, so a `rev` you read stays valid for your next write even while a job reports progress.',
    ].join(' '),
    parameters: BOARD_PARAMETERS,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textContent(renderJson(value)),
    },
    isConcurrencySafe: args => ['list', 'get', 'stats', 'changes'].includes(args?.action),
    presentCall: args => ({
      card: 'generic',
      title: typeof args?.action === 'string' ? `Requirement board · ${args.action}` : 'Requirement board',
      rawInput: args,
    }),
    async execute(args, exec) {
      const parsed = args === null || typeof args !== 'object' ? {} : args
      return locateImages(service, await runBoardAction(service, parsed, exec))
    },
  })

  const template = ctx.tools.register({
    name: 'flow_template',
    description: [
      'Define, inspect, and version the flow templates a requirement moves through.',
      'A template is an ordered list of nodes, each with a name, optional prerequisites, an assignee, and a completion condition; a requirement runs the revision it was pinned to, which may be older than the template\'s current one.',
      'Use action "list" before binding a requirement to a template so you can name real node ids; it reports each template\'s current `revision`, and `includeArchived` adds shelved ones.',
      '"revise" appends a version and changes the template only: it never touches a requirement, so requirements pinned to an older revision keep their node, states, ticks, and history exactly as they were.',
      '"migrate" is the only action here that changes requirements. It moves the ones you name onto a revision; omitting `requirementIds` means every requirement still on an older revision and requires `force`. A refused bulk migrate reports `in-use` with the affected requirements and what each would become, so you can judge the cost before confirming.',
      '"clone" copies a template\'s current version into an editable custom template, which is the supported way to change a built-in one; "archive" shelves or restores one; "delete" removes it and rebinds its requirements onto the default template, so it needs `force` and reports the impact.',
      'Pruning a historical version and editing a template\'s name in place are panel-only and have no action here.',
    ].join(' '),
    parameters: TEMPLATE_PARAMETERS,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textContent(renderJson(value)),
    },
    isConcurrencySafe: args => ['list', 'get'].includes(args?.action),
    presentCall: args => ({
      card: 'generic',
      title: typeof args?.action === 'string' ? `Flow template · ${args.action}` : 'Flow template',
      rawInput: args,
    }),
    async execute(args, exec) {
      const parsed = args === null || typeof args !== 'object' ? {} : args
      switch (parsed.action) {
        case 'list':
          return service.listTemplates({ includeArchived: parsed.includeArchived })
        case 'get':
          // The raw record carries the whole version history and audit tail, which
          // would run into the result cap; the model reads the current version and
          // the counts, and the panel is where the history is read (§11.7).
          return templateView(service.getTemplate(parsed.id))
        case 'create':
          return await service.createTemplate({ id: parsed.id, name: parsed.name, description: parsed.description, nodes: parsed.nodes }, actorOf(exec))
        case 'revise':
          return await service.reviseTemplate(parsed.id, {
            name: parsed.name,
            description: parsed.description,
            nodes: parsed.nodes,
            expectedRevision: parsed.expectedRevision,
          }, actorOf(exec))
        case 'migrate':
          return await service.migrateRequirementsToRevision(parsed.id, parsed.revision, { requirementIds: parsed.requirementIds }, actorOf(exec), parsed.force)
        case 'archive':
          return await service.archiveTemplate(parsed.id, { archived: parsed.archived }, actorOf(exec))
        case 'clone':
          return await service.cloneTemplate(parsed.id, { name: parsed.name }, actorOf(exec))
        case 'delete':
          return await service.deleteTemplate(parsed.id, { force: parsed.force }, actorOf(exec))
        default:
          return { error: `unknown action "${String(parsed.action)}"`, endpoints: ENDPOINTS }
      }
    },
  })

  const role = ctx.tools.register({
    name: 'requirement_role',
    description: [
      'List the roles this board knows, with the duties each one covers, so a requirement can be routed to a role by function.',
      'Roles come from agent presets and from edits in the board panel; this tool only reads them.',
      'An id under `unregistered` is in use but has no record of its own, so its duties may be unknown; treat `dutiesMissing` there as "cannot be routed by function".',
      'Read it before naming a role on a requirement, and leave the role empty when the work fits any role.',
    ].join(' '),
    parameters: ROLE_PARAMETERS,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textContent(renderJson(value)),
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      title: typeof args?.action === 'string' ? `Requirement role · ${args.action}` : 'Requirement role',
      rawInput: args,
    }),
    async execute(args) {
      const parsed = args === null || typeof args !== 'object' ? {} : args
      if (parsed.action !== 'list') return { error: `unknown action "${String(parsed.action)}"`, endpoints: ENDPOINTS }
      return service.listRoles()
    },
  })

  return () => {
    board()
    template()
    role()
  }
}
