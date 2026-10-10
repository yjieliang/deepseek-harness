/**
 * The board's durable data form: one `ctx.storageDomain` domain holding the
 * requirement records, the flow templates, and the two tables later stages
 * fill (roles, queues), plus a global singleton carrying the document revision
 * and the one-time import receipt.
 *
 * The domain declaration is the single source of the record schemas. Records
 * are validated by zod at the durable read boundary — `open` parses every
 * stored record and a mismatch fails the whole open with `invalid-record` —
 * while in-process writes are NOT re-validated by the platform
 * (`storage-domain/src/domain.ts`, `put`/`update` call the backend directly),
 * so the write path must keep every record it persists inside these schemas.
 *
 * Version history: v2 splits the old self-managed document into typed tables
 * and a global. `compatibleVersions` is deliberately absent: with the media
 * this deployment selects (sqlite, and the JSON `single` layout), the version
 * stamp is compared for exact equality, so no older stamp is readable. Legacy
 * v1 data does not move through a domain version at all — it is read once by
 * {@link importLegacyDocument} from the old self-managed JSON file, which
 * carries no unit header.
 *
 * `images` was added after v2 shipped and deliberately did NOT raise the version:
 * it is an optional record field, so a v2 record written before it still parses
 * and reads as a requirement carrying no images, while raising the stamp would
 * make the platform refuse every stored board (exact-equality comparison, no
 * `compatibleVersions`), which is data loss this additive field does not justify.
 *
 * Template version management (`DESIGN.md` §11) follows that precedent: the
 * template fields `revision`/`versions`/`archived`/`updatedBy`/`supersedes`/
 * `changes` and the requirement field `templateRevision` are all optional, so a
 * record written before they existed still parses (a template reads as revision 1
 * with no history, a requirement as pinned to revision 1) and the domain version
 * stays 2. The medium validates the stamp for exact equality and has no
 * migration, so the cost is the same one-way door as `images`: a build that does
 * not know these fields refuses a record that carries them.
 */

import { readFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { EXEC_KINDS, EXEC_STATUSES, PRIORITIES, REQ_KINDS, REQ_STATUSES, SCHEMA_VERSION, fail, nowIso } from './model.js'
import { imageRefSchema } from './images.js'
import { STANDARD_TEMPLATE } from './templates.js'

/** Domain name. Must match `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`): a hyphen would silently route elsewhere. */
export const DOMAIN_NAME = 'requirement_board'

/** Per-node runtime state recorded on one requirement, keyed by template node id. */
const nodeStateSchema = z.object({
  status: z.enum(['pending', 'active', 'done']),
  enteredAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  checks: z.array(z.boolean()),
  assignee: z.string(),
  note: z.string(),
}).strict()

/**
 * One closed-set stored field, with an issue message that names the field and the
 * value it received.
 *
 * The platform's `invalid-record` message names only the table and key and carries
 * the zod error as its `cause`, so a stored value outside its declared set is the
 * one open failure a reader cannot diagnose from the message alone. The issue
 * message therefore ends with `; value <json>`: `openBoardDomain` reads that tail
 * back (zod's finalized issue drops the received value), so the field and the value
 * reach the error an operator sees without reading `cause`.
 * @param field - Stored field name, as it appears in the record.
 * @param values - The values the field is declared to hold.
 * @returns a zod enum for that field.
 */
function storedEnum(field, values) {
  return z.enum(values, {
    error: issue => `stored ${field} is not one of ${values.join('|')}; value ${JSON.stringify(issue.input)}`,
  })
}

/**
 * One appended transition receipt.
 *
 * `action` stays a plain non-empty string: the vocabulary is owned by the
 * service and grows in later stages, while a stored history entry is immutable
 * evidence that must keep parsing after the vocabulary widens.
 */
const historyEntrySchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  by: z.string(),
  byName: z.string(),
  action: z.string().min(1),
  from: z.string().nullable(),
  fromName: z.string(),
  to: z.string().nullable(),
  toName: z.string(),
  fromStatus: z.string().nullable(),
  toStatus: z.string(),
  note: z.string(),
  force: z.boolean(),
  durationMs: z.number().nullable(),
  // The gate a `force` overrode (§5.8): present only on a transition that moved
  // while `blocksOn` still named unfinished work.
  blockedBy: z.array(z.string()).optional(),
}).strict()

/**
 * One execution lock (`ROLE-DISPATCH.md` §4.2). `orphaned` is set when the owning
 * session is disposed, so the lock is takeable at once instead of waiting for the
 * lease; `touchedAt` moves on every write the holder makes, and the lease is
 * measured from it.
 */
const lockSchema = z.object({
  session: z.string().min(1),
  name: z.string(),
  at: z.string().min(1),
  touchedAt: z.string().min(1),
  orphaned: z.boolean().optional(),
}).strict()

/**
 * The named delegation one requirement carries (`ROLE-DISPATCH.md` §4.2).
 *
 * `roleBefore` is the `role` the requirement had when the delegation was made,
 * not the value it was created with: an `update{role}` between the two is a
 * legal change the end of a delegation has to return to.
 */
const delegatedToSchema = z.object({
  session: z.string().min(1),
  name: z.string(),
  roleId: z.string().min(1),
  roleBefore: z.string(),
  at: z.string().min(1),
}).strict()

/**
 * One execution unit (`ROLE-DISPATCH.md` §4.2): the board's observation of a
 * sub-agent or a background job the owning session started.
 *
 * `ref` is the identity the producer publishes — a child session id (or its run
 * id) for a sub-agent, a job id for a job — so repeated observations of the same
 * unit update one entry instead of appending. Nothing here is derived from the
 * unit's output: `progress` is the producer's own one-line progress, and byte
 * coordinates are never stored (§5.5).
 */
const executionUnitSchema = z.object({
  ref: z.string().min(1),
  kind: storedEnum('kind', EXEC_KINDS),
  label: z.string(),
  status: storedEnum('status', EXEC_STATUSES),
  progress: z.string(),
  detail: z.string(),
  startedAt: z.string().min(1),
  finishedAt: z.string().nullable(),
  updatedAt: z.string().min(1),
}).strict()

/**
 * One requirement's execution-sync status (`ROLE-DISPATCH.md` §4.2).
 *
 * `gap` records that the synchronizer could not observe this requirement — a
 * missing registry, or a unit that settled while nothing was listening — so a
 * reader can tell an empty observation from a broken one. `syncedAt` is the last
 * instant an execution write landed for this requirement.
 */
const executionSyncSchema = z.object({
  gap: z.boolean(),
  syncedAt: z.string().nullable(),
}).strict()

/**
 * One stored requirement. Derived values (`flow`, `progress`) are never
 * persisted.
 *
 * `role`, `lock`, and `delegatedTo` are optional so a record written before role
 * routing, locks, or delegation still validates; readers treat the absence as
 * `''`, `null`, and `null`. `kind` and `requestedBy` are optional for the same
 * reason — a record written before decision requirements existed reads as an
 * ordinary task whose requester is unknown. `parentId` and `blocksOn` follow:
 * a record written before gating reads as a root that waits on nothing. `images`
 * follows too: a record written before pasted images existed reads as one that
 * carries none, while the refs it does carry point at files outside the record
 * (see `host/images.js`). `templateRevision` follows: a record written before
 * template versions existed reads as one pinned to revision 1. `summary` follows
 * the same rule: a record written before the plain-language summary existed
 * reads as one carrying none, which is why the field is optional here while the
 * write path refuses an empty one. `project` follows as well, with the opposite
 * write rule: a record written before requirements could be grouped reads as one
 * belonging to no project, and clearing the field is itself a legitimate write.
 *
 * A record this schema refuses stops the whole open, and that is the design rather
 * than an accident: `kind`, `status`, and `priority` are closed sets the write path
 * enforces and `kind` additionally ends in `assertNever`, so a value outside them
 * can only come from a medium edited outside this plugin or written by a later
 * version. Reading such a value as `task` would reinterpret stored data silently,
 * which the platform's own rules forbid ("never silently skip a missing
 * referent"), so the board refuses and the operator repairs or removes the one
 * named record. The platform's `invalidRecords: 'backup-and-skip'` is for
 * disposable derived data; a requirement is the authoritative record, so it stays
 * unset. The issue message names the field and the value for that repair.
 */
const requirementRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  // The plain-language reading of this requirement, written for a person rather
  // than for its implementer. Absent on a record written before it existed, and
  // such a record reads as one whose summary is empty; every write that carries
  // the field requires a non-empty value.
  summary: z.string().optional(),
  // The project this requirement belongs to, as the short label the panel groups
  // and filters by rather than as a reference to a record: no project entity
  // exists, so the name is the whole fact. Absent on a record written before it
  // existed, and such a record reads as one belonging to no project — the same
  // fact an empty value carries, which is why clearing the field is a write the
  // service accepts.
  project: z.string().optional(),
  description: z.string(),
  kind: storedEnum('kind', REQ_KINDS).optional(),
  priority: storedEnum('priority', PRIORITIES),
  owner: z.string(),
  role: z.string().optional(),
  sessions: z.array(z.string()),
  // Optional gate links (§4.2): the parent requirement, and the requirements
  // that must finish first. Cycles are refused on write, not here: this schema
  // validates one record at a time and cannot see the graph.
  parentId: z.string().nullable().optional(),
  blocksOn: z.array(z.string()).optional(),
  templateId: z.string().min(1),
  nodeId: z.string().min(1),
  // The version of `templateId` this requirement runs on (§11.4). Absent on a
  // record written before template versions existed, and such a record reads as
  // one pinned to revision 1; every write made after that change carries it.
  templateRevision: z.number().int().positive().optional(),
  status: storedEnum('status', REQ_STATUSES),
  blockReason: z.string(),
  blockedAt: z.string().nullable(),
  labels: z.array(z.string()),
  // Stored image refs. The encoded bytes are files of their own under the
  // deployment's image directory (`host/images.js`); a record never inlines them.
  images: z.array(imageRefSchema).optional(),
  nodes: z.record(z.string(), nodeStateSchema),
  history: z.array(historyEntrySchema),
  lock: lockSchema.nullable().optional(),
  delegatedTo: delegatedToSchema.nullable().optional(),
  rev: z.number().int().nonnegative(),
  // Execution sync (§4.1, §5.5): a bounded array of observations plus its own
  // revision. `execRev` moves on every execution write while `rev` does not, so
  // progress churn cannot invalidate the `expectedRev` a model is holding.
  executions: z.array(executionUnitSchema).optional(),
  executionsTruncated: z.boolean().optional(),
  sync: executionSyncSchema.optional(),
  execRev: z.number().int().nonnegative().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  createdBy: z.string(),
  updatedBy: z.string(),
  requestedBy: z.string().optional(),
}).strict()

/** One node's declared shape and completion condition. */
const templateNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  order: z.number().int().nonnegative(),
  dependsOn: z.array(z.string()),
  assignee: z.string(),
  description: z.string(),
  completion: z.object({
    type: z.enum(['manual', 'checklist']),
    checklist: z.array(z.string()),
    requireNote: z.boolean(),
  }).strict(),
}).strict()

/** One historical template version (`DESIGN.md` §11.4); the current version stays at the record's top level. */
const templateVersionSchema = z.object({
  revision: z.number().int().positive(),
  at: z.string().min(1),
  by: z.string(),
  name: z.string(),
  description: z.string(),
  nodes: z.array(templateNodeSchema),
  summary: z.string(),
}).strict()

/** One template-side audit entry (§11.4): what a write changed and the revision it left current. */
const templateChangeSchema = z.object({
  at: z.string().min(1),
  by: z.string(),
  revision: z.number().int().positive(),
  summary: z.string(),
}).strict()

/**
 * One flow template. `createdBy` is absent on the built-in template.
 *
 * The top-level fields are always the current version, so every reader that
 * predates version management reads the same record it always read. The version
 * fields are optional for that reason: `revision` is the management version
 * (absent means 1; the legacy `version` field carries no management meaning),
 * `versions` holds the superseded versions oldest-first and excludes the current
 * one, and `archived`/`updatedBy`/`supersedes`/`changes` are the metadata and
 * audit tail §11.4 adds. Both arrays are bounded, and the bound is enforced by
 * the write path rather than silently truncating here.
 */
const templateRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  builtin: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  createdBy: z.string().optional(),
  nodes: z.array(templateNodeSchema),
  revision: z.number().int().positive().optional(),
  versions: z.array(templateVersionSchema).max(20).optional(),
  archived: z.boolean().optional(),
  updatedBy: z.string().optional(),
  supersedes: z.string().optional(),
  changes: z.array(templateChangeSchema).max(20).optional(),
}).strict()

/**
 * One role record (`ROLE-DISPATCH.md` §3.1). Stage 0 only declares the table;
 * the `source` vocabulary is owned by the stage-A1 role registry, so it stays a
 * plain string here rather than an enum this file would have to widen.
 */
const roleRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  duties: z.array(z.string()),
  source: z.string().min(1),
  ephemeral: z.boolean(),
  boundSession: z.string().optional(),
  boundTask: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict()

/** One session's execution queue (`ROLE-DISPATCH.md` §4.3); keyed by session id. */
const sessionQueueRecordSchema = z.object({
  sessionId: z.string().min(1),
  sessionName: z.string(),
  items: z.array(z.object({ id: z.string().min(1), at: z.string().min(1) }).strict()),
  updatedAt: z.string().min(1),
}).strict()

/**
 * Global singleton. `imported` is the replay guard: once present, the legacy
 * JSON is never imported again. `schemaVersion` is a literal so a global
 * written by a different fold version fails the open instead of being misread.
 */
const globalSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  execSync: z.object({
    ignored: z.number().int().nonnegative(),
    gaps: z.number().int().nonnegative(),
  }).strict(),
  imported: z.object({
    at: z.string().min(1),
    count: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict()

/** The board domain: four tables plus the document global. */
export const requirementBoardDomain = defineDomain({
  name: DOMAIN_NAME,
  version: 2,
  tables: {
    requirements: domainTable(requirementRecordSchema),
    templates: domainTable(templateRecordSchema),
    roles: domainTable(roleRecordSchema),
    queues: domainTable(sessionQueueRecordSchema),
  },
  global: {
    schema: globalSchema,
    initial: { schemaVersion: SCHEMA_VERSION, revision: 0, execSync: { ignored: 0, gaps: 0 } },
  },
})

/**
 * Open the board domain, naming the stored field an unreadable record broke on.
 *
 * The platform's `invalid-record` message names the table and key and carries the
 * zod failure only as `cause`, so the operator reading a failed boot would have to
 * write code to learn which field to repair. This is the board's own open step
 * (`index.js` calls it instead of `ctx.storageDomain.open`), and it appends the
 * first failing issue path and the value it received to the thrown error's message
 * and `detail` — the same facts a person needs, visible without reading `cause`.
 * Any other failure is rethrown untouched; the refusal itself is the design (see
 * {@link requirementRecordSchema}).
 * @param storageDomain - `ctx.storageDomain`.
 * @returns the open domain handle.
 */
export async function openBoardDomain(storageDomain) {
  try {
    return await storageDomain.open(requirementBoardDomain)
  } catch (error) {
    throw describedInvalidRecord(error)
  }
}

/**
 * The same error with the failing field and the received value made visible.
 *
 * `detail` keeps the platform's `{table, key}` and gains `field`, plus `received`
 * for the closed-set fields whose issue message ends in `; value <json>`. The
 * message gains the field and the issue text, so a boot log that prints either the
 * message or the detail identifies the record to repair.
 * @param error - The error the domain open threw.
 * @returns the error to throw, enriched when it is an unreadable stored record.
 */
function describedInvalidRecord(error) {
  if (error?.code !== 'invalid-record') return error
  const issue = Array.isArray(error?.cause?.issues) ? error.cause.issues[0] : undefined
  const path = Array.isArray(issue?.path) ? issue.path : []
  if (path.length === 0) return error
  const field = path.join('.')
  const message = String(issue.message ?? 'does not match its schema')
  error.message = `${error.message} — ${field}: ${message}`
  error.detail = { ...(error.detail ?? {}), field, ...receivedFrom(message) }
  return error
}

/**
 * The received value a closed-set issue message carries, when it carries one.
 *
 * `storedEnum` writes it because zod's finalized issue keeps neither the value nor
 * an input field; an issue from any other schema simply reports no value.
 * @param message - The issue message.
 * @returns `{received}` for a value the message names, otherwise an empty object.
 */
function receivedFrom(message) {
  const match = /; value (.+)$/.exec(message)
  if (match === null) return {}
  try {
    return { received: JSON.parse(match[1]) }
  } catch {
    // The tail is written by `storedEnum` from `JSON.stringify`, so this only runs
    // for a message a future schema wrote in another form; reporting no value is
    // better than reporting a misparsed one.
    return {}
  }
}

/** Record schema of each table, used to validate legacy documents before storing them. */
const tableSchemas = {
  requirements: requirementRecordSchema,
  templates: templateRecordSchema,
}

/**
 * The board's own directory on this deployment: the profile directory when the
 * runtime exposes one, else the user's `~/.dsh` tree.
 *
 * Every file the board keeps outside its storage medium is rooted here, so the
 * legacy document and the image directory cannot drift apart.
 * @returns the absolute board directory.
 */
function boardDirectory() {
  const profileDir = process.env.DSH_PROFILE_DIR
  return typeof profileDir === 'string' && profileDir !== ''
    ? join(profileDir, 'requirement-board')
    : join(homedir(), '.dsh', 'requirement-board')
}

/**
 * Default directory holding pasted image files, beside the board's own documents.
 * @returns the absolute image directory.
 */
export function defaultImageDir() {
  return join(boardDirectory(), 'images')
}

/**
 * Path of the pre-migration self-managed JSON document.
 *
 * `dataDir` is gone from the row config, so the importer owns this derivation:
 * the deployment's profile directory when the runtime exposes one, else the
 * user's `~/.dsh` tree. Stage R passes the same location the running profile
 * used before the migration.
 * @returns the absolute legacy document path.
 */
export function legacyDocumentPath() {
  return join(boardDirectory(), 'requirement-board.json')
}

/**
 * Prepare an opened domain for use: optionally import the legacy document,
 * seed the built-in template, then heal the document revision.
 * @param domain - An open board domain.
 * @param options - `importLegacy` enables the one-time import; `legacyPath`
 * overrides the derived legacy location (tests); `logger` receives outcomes.
 * @returns the healed document revision.
 */
export async function bootstrapRequirementBoard(domain, { importLegacy = false, legacyPath = legacyDocumentPath(), logger } = {}) {
  if (importLegacy) {
    const outcome = await importLegacyDocument(domain, { path: legacyPath, logger })
    if (outcome.imported) {
      logger?.info?.(`requirement-board: imported ${outcome.count} legacy record(s) from ${legacyPath}`)
    }
  }
  await seedStandardTemplate(domain)
  return await healRevision(domain)
}

/**
 * Store the built-in standard template when the templates table is empty, so a
 * fresh board has exactly the seed the old document carried.
 * @param domain - An open board domain.
 * @returns whether the template was written.
 */
export async function seedStandardTemplate(domain) {
  const templates = domain.table('templates')
  if (templates.get(STANDARD_TEMPLATE.id) !== undefined) return false
  await templates.put(STANDARD_TEMPLATE.id, structuredClone(STANDARD_TEMPLATE))
  return true
}

/**
 * The document revision the board should be at: the global's revision, raised
 * to the highest stored record revision so a restored or imported board never
 * reports a revision below its records.
 * @param domain - An open board domain.
 * @returns the healed revision.
 */
export function nextRevision(domain) {
  let revision = domain.global.get().revision
  for (const [, record] of domain.table('requirements').entries()) {
    if (record.rev > revision) revision = record.rev
  }
  return revision
}

/**
 * Write the healed revision back when the global trails the stored records.
 * @param domain - An open board domain.
 * @returns the healed revision.
 */
export async function healRevision(domain) {
  const global = domain.global.get()
  const revision = nextRevision(domain)
  if (revision === global.revision) return revision
  await domain.global.set({ ...global, revision })
  return revision
}

/**
 * Import the pre-migration JSON document once.
 *
 * Every guard is a reason to do nothing: an existing `imported` receipt, a
 * domain that already holds records, or an absent file. A present but
 * malformed or over-versioned file fails loud instead of being skipped. After
 * a successful import the global records the receipt and the source file is
 * renamed to `<path>.migrated` so it is preserved but never replayed.
 *
 * @param domain - An open board domain.
 * @param options - `path` is the legacy document; `logger` receives the outcome.
 * @returns `{ imported, count }` or `{ imported: false, reason }`.
 */
export async function importLegacyDocument(domain, { path, logger } = {}) {
  const global = domain.global.get()
  if (global.imported !== undefined) return { imported: false, reason: 'already-imported' }
  if (domain.table('requirements').size > 0 || domain.table('templates').size > 0) {
    // No receipt and no room to import: either the one-time import was
    // interrupted after its record writes and before its receipt, or this board
    // was populated without one. The legacy file stays replayable and the board
    // stays half-imported, so the state is reported rather than passed over.
    logger?.warn?.(
      `requirement-board: legacy import skipped: the board already holds records but the global carries no import receipt, so ${path} is left untouched; an interrupted one-time import leaves exactly this state and needs a human to confirm which side of the board is authoritative`,
    )
    return { imported: false, reason: 'domain-not-empty' }
  }
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { imported: false, reason: 'absent' }
    throw error
  }
  const document = parseLegacyDocument(text, path)
  let count = 0
  for (const [table, records] of [['templates', document.templates], ['requirements', document.requirements]]) {
    for (const [id, raw] of Object.entries(records)) {
      await domain.table(table).put(id, parseLegacyRecord(table, id, raw, path))
      count += 1
    }
  }
  await domain.global.set({ ...domain.global.get(), imported: { at: nowIso(), count } })
  await rename(path, `${path}.migrated`)
  logger?.info?.(`requirement-board: legacy document ${path} imported (${count} records) and renamed to ${path}.migrated`)
  return { imported: true, count }
}

/**
 * Project the board back into the pre-migration document format.
 *
 * The result is the v1 document shape, so it round-trips through
 * {@link importLegacyDocument}. The reverse direction exists for the stage-R
 * drill and for backing the board up before a layout change.
 *
 * @param domain - An open board domain.
 * @returns the legacy-shaped document.
 */
export function exportLegacyDocument(domain) {
  const global = domain.global.get()
  return {
    schemaVersion: 1,
    revision: global.revision,
    updatedAt: nowIso(),
    templates: Object.fromEntries(domain.table('templates').entries()),
    requirements: Object.fromEntries(domain.table('requirements').entries()),
  }
}

/** Parse the legacy document envelope, rejecting every unsupported fold version. */
function parseLegacyDocument(text, path) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    fail('malformed-legacy', `the legacy board document at ${path} is not valid JSON: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('malformed-legacy', `the legacy board document at ${path} is not a JSON object`)
  }
  if (parsed.schemaVersion !== 1) {
    fail('unsupported-legacy-version', `the legacy board document at ${path} has schemaVersion ${String(parsed.schemaVersion)}; only 1 can be imported`, {
      found: parsed.schemaVersion,
      supported: 1,
    })
  }
  return {
    templates: asLegacyTable(parsed.templates, path, 'templates'),
    requirements: asLegacyTable(parsed.requirements, path, 'requirements'),
  }
}

/** Read one legacy `{ id: record }` map, defaulting an absent table to empty. */
function asLegacyTable(value, path, field) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail('malformed-legacy', `the legacy board document at ${path} has a non-object "${field}" table`)
  }
  return value
}

/** Validate one legacy record with the domain's own schema before storing it. */
function parseLegacyRecord(table, id, raw, path) {
  try {
    return tableSchemas[table].parse(raw)
  } catch (error) {
    fail('malformed-legacy', `the legacy board document at ${path} holds an invalid ${table} record "${id}": ${error.message}`)
  }
}
