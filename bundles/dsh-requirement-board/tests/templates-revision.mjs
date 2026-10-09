/**
 * Template version management (`DESIGN.md` §11) over the real storage path: the
 * host service surface that appends versions without touching requirements,
 * migrates requirements on demand, prunes and archives, reads a record written
 * before any of these fields as revision 1, and refuses a record carrying a
 * field the schema does not declare.
 *
 * Run with `node tests/templates-revision.mjs`.
 */

import { readFile } from 'node:fs/promises'
import { resolveConfig } from '../host/config.js'
import { dispatchBoardCommand } from '../host/http.js'
import { registerTools } from '../host/tools.js'
import {
  BACKENDS,
  createReporter,
  makeTempDir,
  openBoard,
  openRawBoard,
  removeTempDir,
} from './harness.mjs'

const reporter = createReporter()
const { check, rejects } = reporter
const actor = { session: 'ses_editor', name: '编辑者' }
const other = { session: 'ses_other', name: '另一位' }

/**
 * The functions that read a template's top-level `nodes`. §11.9 asks for one
 * mechanical check instead of an assertion per call site: every caller of these
 * must resolve the pinned version first, and a new reader has to be listed here
 * before the suite passes again.
 */
const RESOLVED_READERS = {
  'host/flow.js': ['recomputeNodes', 'completionState', 'applyTransition', 'setChecklistEntry'],
  'host/templates.js': ['templateView', 'dependenciesMet', 'nextNodeId', 'nodeIndex'],
}

/**
 * The statements that derive from the *current* version without consulting a
 * pin, and the reason each one may: a brand-new requirement (write point ① of
 * §11.4), a rebinding onto another template, and the open-time repair that moves
 * a dangling pin onto the current version.
 */
const RAW_CURRENT_DERIVATIONS = [
  'const template = this.#template(templateId)',
  "const template = this.#template(asString(patch.templateId, 'templateId', { max: 64 }))",
  'const template = this.#template(draft.templateId)',
]

/** The top-level function bodies of one host module that mention `template.nodes`. */
function readersOf(text) {
  const starts = [...text.matchAll(/^(?:export function|function) (\w+)/gm)]
  const found = []
  starts.forEach((match, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : text.length
    if (/template\.nodes\b/.test(text.slice(match.index, end))) found.push(match[1])
  })
  return found
}

/** The three-node template most cases build on: a checklist, then two manual nodes. */
function templateInput(overrides = {}) {
  return {
    id: 'tpl-custom',
    name: '自定义流程',
    description: '起草 → 评审 → 关闭',
    nodes: [
      { id: 'draft', name: '起草', completion: { type: 'checklist', checklist: ['范围明确', '干系人确认'] } },
      { id: 'review', name: '评审', dependsOn: ['draft'], completion: { type: 'manual', requireNote: true } },
      { id: 'close', name: '关闭', dependsOn: ['review'], completion: { type: 'manual' } },
    ],
    ...overrides,
  }
}

/** Two nodes whose ids survive a revision that adds a third. */
function growingNodes() {
  return [
    { id: 'draft', name: '起草', completion: { type: 'checklist', checklist: ['范围明确', '干系人确认'] } },
    { id: 'review', name: '评审', dependsOn: ['draft'], completion: { type: 'manual', requireNote: true } },
    { id: 'close', name: '关闭', dependsOn: ['review'], completion: { type: 'manual' } },
    { id: 'audit', name: '复盘', dependsOn: ['close'], completion: { type: 'manual' } },
  ]
}

/** Run one case for one backend, in a fresh temporary directory. */
async function onBackend(backend, name, body) {
  const dir = await makeTempDir(`rb-tpl-${backend}-`)
  console.log(`\n[${backend}] ${name}`)
  try {
    await body(dir)
  } finally {
    await removeTempDir(dir)
  }
}

/** The stored requirements as `{ id: record }`, for byte-level "nothing changed" checks. */
function requirementRecords(board) {
  return Object.fromEntries([...board.domain.table('requirements').entries()].map(([id, record]) => [id, JSON.stringify(record)]))
}

/** Tick every declared checklist entry of the requirement's current node. */
async function tickCurrentChecklist(service, id, actorForCall) {
  const requirement = await service.getRequirement(id)
  const node = service.getTemplate(requirement.templateId).nodes.find(candidate => candidate.id === requirement.nodeId)
  const entries = node?.completion?.checklist ?? []
  for (const [index] of entries.entries()) {
    await service.setChecklist(id, { index, checked: true }, actorForCall)
  }
}

/**
 * `revise` appends a version and leaves every requirement byte-for-byte alone.
 *
 * This is I3, the promise that makes revising a template safe: the requirement's
 * `nodeId`, derived nodes, ticks, and history are what a session is executing, and
 * a template edit must not move any of it.
 */
async function caseReviseLeavesRequirements(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '在跑需求', templateId: 'tpl-custom' }, actor)
    await service.claim(created.id, {}, actor)
    await tickCurrentChecklist(service, created.id, actor)
    await service.transitionRequirement(created.id, { action: 'advance' }, actor)
    const before = board.domain.table('requirements').get(created.id)
    const beforeRecords = requirementRecords(board)
    const beforeTemplate = service.getTemplate('tpl-custom')

    const revised = await service.reviseTemplate('tpl-custom', {
      description: '起草 → 评审 → 关闭（第二版）',
      nodes: growingNodes(),
    }, actor)

    const after = board.domain.table('requirements').get(created.id)
    const stored = service.getTemplate('tpl-custom')
    check('revise moves the template to revision 2', revised.revision === 2)
    check('and reports the requirement still pinned to the old revision', revised.pinnedToOld === 1)
    check('the running requirement keeps its node id', after.nodeId === before.nodeId, `${after.nodeId} vs ${before.nodeId}`)
    check('its derived nodes and ticks are unchanged', JSON.stringify(after.nodes) === JSON.stringify(before.nodes))
    check('its history is unchanged', JSON.stringify(after.history) === JSON.stringify(before.history))
    check('and no requirement record changed at all', JSON.stringify(requirementRecords(board)) === JSON.stringify(beforeRecords))
    check('the template updatedAt moved forward', stored.updatedAt > beforeTemplate.updatedAt, `${stored.updatedAt} vs ${beforeTemplate.updatedAt}`)
    check('the top level becomes the new version', stored.revision === 2 && stored.nodes.length === 4)
    check('versions gained one entry holding the old top level', stored.versions.length === 1 && stored.versions[0].revision === 1 && stored.versions[0].nodes.length === 3)
    check('the first version carries no change summary', stored.versions[0].summary === '')
    check('changes gained one server-generated diff', stored.changes.length === 1 && stored.changes[0].revision === 2 && stored.changes[0].summary.includes('+节点 audit'), stored.changes[0].summary)
    check('updatedBy records the editor', stored.updatedBy === 'ses_editor')
    await board.close()
  })
}

/**
 * A requirement pinned to revision 1 keeps running revision 1 after the template
 * reaches 2, and a requirement created afterwards pins 2.
 */
async function casePinnedRevisionDerives(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '钉在第一版', templateId: 'tpl-custom' }, actor)
    check('a new requirement is pinned to the template current revision', created.templateRevision === 1)
    await service.claim(created.id, {}, actor)
    await tickCurrentChecklist(service, created.id, actor)
    await service.transitionRequirement(created.id, { action: 'advance' }, actor)

    // Revision 2 inserts `audit` before `close` and renames `close`: the two
    // versions disagree about what follows `review`.
    await service.reviseTemplate('tpl-custom', {
      nodes: [
        { id: 'draft', name: '起草', completion: { type: 'checklist', checklist: ['范围明确', '干系人确认'] } },
        { id: 'review', name: '评审', dependsOn: ['draft'], completion: { type: 'manual', requireNote: true } },
        { id: 'audit', name: '复盘', dependsOn: ['review'], completion: { type: 'manual' } },
        { id: 'close', name: '交付', dependsOn: ['audit'], completion: { type: 'manual' } },
      ],
    }, actor)

    const presented = await service.getRequirement(created.id)
    check('present derives the pinned version, not the newest', presented.progress.total === 3 && presented.flow.length === 3)
    check('and names the pinned version node', presented.flow[2].name === '关闭')
    check('while the template top level moved on', service.getTemplate('tpl-custom').nodes[2].id === 'audit')
    await service.transitionRequirement(created.id, { action: 'advance', note: '评审通过' }, actor)
    check('advance follows the pinned version', (await service.getRequirement(created.id)).nodeId === 'close')
    check('the pin is still revision 1', board.domain.table('requirements').get(created.id).templateRevision === 1)

    const fresh = await service.createRequirement({ summary: '测试简述', title: '改版后新建', templateId: 'tpl-custom' }, actor)
    check('a requirement created after the revision pins the current one', fresh.templateRevision === 2)
    check('and starts on that revision first node', fresh.flow.length === 4 && fresh.flow[0].id === 'draft')
    await board.close()
  })
}

/** Both rebinding paths reset the pin to the target template's current revision. */
async function caseRebindResetsPin(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    await service.createTemplate({ id: 'tpl-b', name: '另一个', nodes: [{ id: 'only', name: '唯一' }] }, actor)
    await service.reviseTemplate('tpl-b', { nodes: [{ id: 'only', name: '唯一' }, { id: 'extra', name: '追加', dependsOn: ['only'] }] }, actor)
    await service.createTemplate({ id: 'tpl-c', name: '第三个', nodes: [{ id: 'solo', name: '单' }] }, actor)
    await service.reviseTemplate('tpl-c', { nodes: [{ id: 'solo', name: '单' }, { id: 'next', name: '后续', dependsOn: ['solo'] }] }, actor)

    const created = await service.createRequirement({ summary: '测试简述', title: '改绑', templateId: 'tpl-custom' }, actor)
    await service.claim(created.id, {}, actor)
    check('the requirement starts pinned to revision 1', board.domain.table('requirements').get(created.id).templateRevision === 1)

    await service.updateRequirement(created.id, { templateId: 'tpl-b' }, actor)
    let stored = board.domain.table('requirements').get(created.id)
    check('updateRequirement resets the pin to the target current revision', stored.templateId === 'tpl-b' && stored.templateRevision === 2)
    check('and normalizes the node into the target version', stored.nodeId === 'only')
    check('and the rebind reads without invalid-transition', (await service.getRequirement(created.id)).progress.total === 2)
    check('the rebind history entry names the target template', stored.history.at(-1).action === 'retemplate' && stored.history.at(-1).note === 'bound to template tpl-b')

    await service.updateRequirement(created.id, { templateId: 'tpl-c' }, actor)
    stored = board.domain.table('requirements').get(created.id)
    check('a second rebind resets the pin again', stored.templateId === 'tpl-c' && stored.templateRevision === 2)

    await service.deleteTemplate('tpl-c', { force: true }, actor)
    stored = board.domain.table('requirements').get(created.id)
    const fallback = service.getTemplate('tpl-standard')
    check('deleteTemplate force rebind resets the pin to the default current revision', stored.templateId === 'tpl-standard' && stored.templateRevision === (fallback.revision ?? 1))
    check('and normalizes the node into the default template', fallback.nodes.some(node => node.id === stored.nodeId))
    check('and the requirement still reads without invalid-transition', (await service.getRequirement(created.id)).flow.length === fallback.nodes.length)
    check('the deletion rebind leaves its own history note', stored.history.at(-1).action === 'retemplate' && stored.history.at(-1).note === 'template tpl-c deleted → tpl-standard' && stored.history.at(-1).force === true)
    await board.close()
  })
}

/** The 21st version is refused rather than dropping the oldest (I2). */
async function caseVersionLimit(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    for (let revision = 2; revision <= 21; revision += 1) await service.reviseTemplate('tpl-custom', {}, actor)
    const stored = service.getTemplate('tpl-custom')
    check('twenty historical versions are kept', stored.revision === 21 && stored.versions.length === 20)
    check('the audit tail is bounded at twenty too', stored.changes.length === 20)
    check('and keeps the most recent twenty', stored.changes[0].revision === 2 && stored.changes.at(-1).revision === 21, `${stored.changes[0].revision}..${stored.changes.at(-1).revision}`)
    await rejects('the 21st historical version is refused', () => service.reviseTemplate('tpl-custom', {}, actor), 'invalid-transition')
    const after = service.getTemplate('tpl-custom')
    check('the refusal dropped no version and moved no revision', after.revision === 21 && after.versions.length === 20 && after.versions[0].revision === 1 && after.changes.length === 20)
    await board.close()
  })
}

/** `revise` compare-and-set is judged at the commit slot, so racers serialize. */
async function caseReviseCompareAndSet(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    const first = await service.reviseTemplate('tpl-custom', { expectedRevision: 1 }, actor)
    check('a matching expectedRevision appends', first.revision === 2)
    const stale = await rejects('a stale expectedRevision is refused', () => service.reviseTemplate('tpl-custom', { expectedRevision: 1 }, actor), 'conflict')
    check('the refusal names the expected and current revision', stale?.details?.expected === 1 && stale?.details?.current === 2, JSON.stringify(stale?.details))
    check('and changed nothing', service.getTemplate('tpl-custom').revision === 2 && service.getTemplate('tpl-custom').versions.length === 1)

    const attempts = await Promise.allSettled([
      service.reviseTemplate('tpl-custom', { expectedRevision: 2 }, actor),
      service.reviseTemplate('tpl-custom', { expectedRevision: 2 }, other),
    ])
    const won = attempts.filter(attempt => attempt.status === 'fulfilled')
    const lost = attempts.filter(attempt => attempt.status === 'rejected')
    check('exactly one of two racers with the same expectedRevision commits', won.length === 1 && lost.length === 1, `won=${won.length}`)
    check('the loser is refused with a conflict', lost[0]?.reason?.code === 'conflict')
    check('the template advanced by exactly one revision', service.getTemplate('tpl-custom').revision === 3)
    await board.close()
  })
}

/** Pruning refuses a pinned revision (I2) and changes nothing when it does. */
async function casePrune(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '钉住第一版', templateId: 'tpl-custom' }, actor)
    await service.reviseTemplate('tpl-custom', { nodes: growingNodes() }, actor)
    const templateBefore = JSON.stringify(service.getTemplate('tpl-custom'))
    const requirementBefore = JSON.stringify(board.domain.table('requirements').get(created.id))

    const refused = await rejects('a pinned revision cannot be pruned', () => service.pruneTemplateVersion('tpl-custom', 1, actor), 'in-use')
    check('the refusal lists the pinning requirement', refused?.details?.requirements?.includes(created.id) === true, JSON.stringify(refused?.details))
    check('the refusal changed no template record', JSON.stringify(service.getTemplate('tpl-custom')) === templateBefore)
    check('and no requirement record', JSON.stringify(board.domain.table('requirements').get(created.id)) === requirementBefore)

    await rejects('the current revision cannot be pruned', () => service.pruneTemplateVersion('tpl-custom', 2, actor), 'invalid-argument')
    await rejects('a revision that was never stored cannot be pruned', () => service.pruneTemplateVersion('tpl-custom', 9, actor), 'invalid-argument')

    await service.migrateRequirementsToRevision('tpl-custom', 2, { requirementIds: [created.id] }, actor)
    const pruned = await service.pruneTemplateVersion('tpl-custom', 1, actor)
    check('an unpinned revision is removed', pruned.pruned === 1 && service.getTemplate('tpl-custom').versions.length === 0)
    check('and the current revision did not move', service.getTemplate('tpl-custom').revision === 2)
    check('the prune leaves an audit entry', service.getTemplate('tpl-custom').changes.at(-1).summary === 'pruned revision 1')
    await board.close()
  })
}

/** Migration is explicit, pre-listed, and the only act that moves requirements (I4). */
async function caseMigrate(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '待迁移', templateId: 'tpl-custom' }, actor)
    await service.claim(created.id, {}, actor)
    await service.setChecklist(created.id, { index: 0, checked: true }, actor)
    await service.reviseTemplate('tpl-custom', {
      nodes: [
        { id: 'draft', name: '起草', completion: { type: 'checklist', checklist: ['范围明确', '干系人确认', '风险评估'] } },
        { id: 'review', name: '评审', dependsOn: ['draft'], completion: { type: 'manual', requireNote: true } },
        { id: 'close', name: '关闭', dependsOn: ['review'], completion: { type: 'manual' } },
      ],
    }, actor)
    const requirementBefore = JSON.stringify(board.domain.table('requirements').get(created.id))

    const refused = await rejects('an unconfirmed bulk migration is refused', () => service.migrateRequirementsToRevision('tpl-custom', 2, {}, actor), 'in-use')
    const impact = refused?.details?.affected?.[0]
    check('the refusal lists the affected requirement', refused?.details?.requirements?.includes(created.id) === true)
    check('and what it would become', impact?.id === created.id && impact?.nodeId === 'draft' && impact?.revision === 1 && impact?.next === 'draft', JSON.stringify(impact))
    check('including that the longer checklist clears the ticks', impact?.clearedChecks === true, JSON.stringify(impact))
    check('the refusal changed no requirement', JSON.stringify(board.domain.table('requirements').get(created.id)) === requirementBefore)

    const result = await service.migrateRequirementsToRevision('tpl-custom', 2, {}, actor, true)
    const after = board.domain.table('requirements').get(created.id)
    check('the confirmed bulk migration moves the requirement', result.migrated.includes(created.id) && after.templateRevision === 2)
    check('the migrated requirement keeps its node', after.nodeId === 'draft')
    check('and the longer checklist blanks its ticks', after.nodes.draft.checks.join(',') === 'false,false,false', after.nodes.draft.checks.join(','))
    const entry = after.history.at(-1)
    check('the migration writes a retemplate entry with the migration prefix', entry.action === 'retemplate' && entry.note === 'migrated to revision 2 from 1', entry.note)
    check('and records that it was forced', entry.force === true)

    await rejects('migrating to a revision that does not exist is refused', () => service.migrateRequirementsToRevision('tpl-custom', 9, { requirementIds: [created.id] }, actor), 'invalid-transition')
    await rejects('migrating a requirement that is not bound to the template is refused', () => service.migrateRequirementsToRevision('tpl-custom', 2, { requirementIds: ['req_missing'] }, actor), 'not-found')

    // A node the target revision no longer has is normalized to its first node,
    // and the note stays distinguishable from the rebinding path's.
    await service.createTemplate({ id: 'tpl-shrink', name: '收缩', nodes: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙', dependsOn: ['a'] }] }, actor)
    const shrink = await service.createRequirement({ summary: '测试简述', title: '节点被删', templateId: 'tpl-shrink' }, actor)
    await service.claim(shrink.id, {}, other)
    await service.transitionRequirement(shrink.id, { action: 'advance' }, other)
    await service.reviseTemplate('tpl-shrink', { nodes: [{ id: 'a', name: '甲' }] }, actor)
    const named = await service.migrateRequirementsToRevision('tpl-shrink', 2, { requirementIds: [shrink.id] }, actor)
    const afterShrink = board.domain.table('requirements').get(shrink.id)
    check('a named migration needs no force', named.migrated.includes(shrink.id) && afterShrink.templateRevision === 2)
    check('a node absent from the target revision is normalized to its first node', afterShrink.nodeId === 'a', afterShrink.nodeId)
    check('the migration note is distinguishable from a rebinding note', afterShrink.history.at(-1).note.startsWith('migrated to revision ') && !afterShrink.history.some(item => item.note.startsWith('bound to template ')))
    await board.close()
  })
}

/** Archiving shelves a template without taking it away from the requirements on it. */
async function caseArchive(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '归档前的需求', templateId: 'tpl-custom' }, actor)

    await service.archiveTemplate('tpl-custom', {}, actor)
    check('an archived template leaves the default list', !service.listTemplates().items.some(item => item.id === 'tpl-custom'))
    check('and appears when archived templates are asked for', service.listTemplates({ includeArchived: true }).items.some(item => item.id === 'tpl-custom' && item.archived === true))
    check('getTemplate still reads it', service.getTemplate('tpl-custom').archived === true)
    check('the requirement bound to it still resolves its flow', (await service.getRequirement(created.id)).progress.total === 3)
    check('the snapshot hides it too', !service.snapshot().templates.some(item => item.id === 'tpl-custom'))
    await rejects('a new requirement cannot bind an archived template', () => service.createRequirement({ summary: '测试简述', title: '新', templateId: 'tpl-custom' }, actor), 'invalid-transition')

    await service.archiveTemplate('tpl-custom', { archived: true }, actor)
    check('archiving an archived template is a no-op', service.getTemplate('tpl-custom').archived === true)
    await service.archiveTemplate('tpl-custom', { archived: false }, actor)
    check('restoring brings it back to the list', service.listTemplates().items.some(item => item.id === 'tpl-custom') && service.getTemplate('tpl-custom').archived === false)
    await rejects('the built-in template cannot be archived', () => service.archiveTemplate('tpl-standard', {}, actor), 'invalid-transition')
    await board.close()

    // A custom template configured as the deployment default is protected from
    // both archiving and deletion. The board is reopened over the same medium with
    // the default pointed at the custom template.
    const second = await openBoard({ backend, dir, config: resolveConfig({ defaultTemplateId: 'tpl-custom' }) })
    await rejects('the configured default template cannot be archived', () => second.service.archiveTemplate('tpl-custom', {}, actor), 'invalid-transition')
    await rejects('the configured default template cannot be deleted', () => second.service.deleteTemplate('tpl-custom', { force: true }, actor), 'invalid-transition')
    check('and it stays available', second.service.getTemplate('tpl-custom').archived !== true)
    await second.close()
  })
}

/** Cloning is the supported way to change a built-in template. */
async function caseClone(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const source = service.getTemplate('tpl-standard')
    const clone = await service.cloneTemplate('tpl-standard', { name: '标准副本' }, actor)
    check('the clone starts a fresh version line', clone.revision === 1 && clone.versionCount === 0 && clone.changeCount === 0)
    check('the clone records its source', clone.supersedes === 'tpl-standard' && clone.builtin === false)
    check('the clone copies the source current nodes', clone.nodes.map(node => node.id).join(',') === source.nodes.map(node => node.id).join(','))
    const revised = await service.reviseTemplate(clone.id, { nodes: [{ id: 'only', name: '唯一' }] }, actor)
    check('the clone is editable', revised.revision === 2 && revised.nodes.length === 1)
    check('the source template is untouched by revising the clone', service.getTemplate('tpl-standard').nodes.length === source.nodes.length)
    await rejects('the built-in template still refuses revise', () => service.reviseTemplate('tpl-standard', {}, actor), 'invalid-transition')
    await rejects('and refuses a metadata edit', () => service.setTemplateMetadata('tpl-standard', { name: '改名' }, actor), 'invalid-transition')
    await rejects('and a clone needs a name', () => service.cloneTemplate('tpl-standard', {}, actor), 'invalid-argument')
    await board.close()
  })
}

/** Metadata edits move no revision, and a later revision preserves the old name in history. */
async function caseMetadata(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '改名前后的需求', templateId: 'tpl-custom' }, actor)
    const derivedBefore = JSON.stringify(await service.getRequirement(created.id))
    const derivation = view => ({ nodeId: view.nodeId, flow: view.flow, progress: view.progress, templateRevision: view.templateRevision })
    const before = service.getTemplate('tpl-custom')
    const edited = await service.setTemplateMetadata('tpl-custom', { name: '改名后的模板' }, actor)
    const stored = service.getTemplate('tpl-custom')
    check('metadata edits the top level in place', edited.name === '改名后的模板' && stored.name === '改名后的模板')
    check('and keeps the description', stored.description === before.description)
    check('and moves no revision, version, or change', (stored.revision ?? 1) === 1 && (stored.versions ?? []).length === 0 && (stored.changes ?? []).length === 0)
    check('and records who edited it', stored.updatedBy === 'ses_editor')
    check('and changes no requirement derivation', JSON.stringify(derivation(await service.getRequirement(created.id))) === JSON.stringify(derivation(JSON.parse(derivedBefore))))
    const untouched = await service.setTemplateMetadata('tpl-custom', {}, actor)
    check('an empty metadata call is a no-op', untouched.name === '改名后的模板' && service.getTemplate('tpl-custom').updatedAt === stored.updatedAt)
    await service.reviseTemplate('tpl-custom', { description: '第二版' }, actor)
    check('the superseded version keeps the name it had', service.getTemplate('tpl-custom').versions[0].name === '改名后的模板')
    check('and the new revision summarizes the description edit', service.getTemplate('tpl-custom').changes[0].summary.includes('描述更新'))
    await board.close()
  })
}

/** The structural red cases §11.9 lists, on both the create and the revise path. */
async function caseStructureRedCases(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const nodes = count => Array.from({ length: count }, (_, index) => ({ id: `n${index}`, name: `节点${index}` }))
    await rejects('no nodes is refused', () => service.createTemplate({ name: '空', nodes: [] }, actor), 'invalid-argument')
    await rejects('fifty-one nodes is refused', () => service.createTemplate({ name: '过长', nodes: nodes(51) }, actor), 'invalid-argument')
    await rejects('an unknown dependsOn is refused', () => service.createTemplate({ name: '悬空依赖', nodes: [{ id: 'a', name: '甲', dependsOn: ['ghost'] }] }, actor), 'invalid-argument')
    await rejects('a duplicated node id is refused', () => service.createTemplate({ name: '重名', nodes: [{ id: 'a', name: '甲' }, { id: 'a', name: '乙' }] }, actor), 'invalid-argument')
    await rejects('a dependency cycle is refused', () => service.createTemplate({ name: '成环', nodes: [{ id: 'a', name: '甲', dependsOn: ['b'] }, { id: 'b', name: '乙', dependsOn: ['a'] }] }, actor), 'invalid-argument')
    await rejects('an over-long checklist is refused', () => service.createTemplate({
      name: '长清单',
      nodes: [{ id: 'a', name: '甲', completion: { type: 'checklist', checklist: Array.from({ length: 21 }, (_, index) => `项${index}`) } }],
    }, actor), 'invalid-argument')

    // A revision is normalized by the same rules, so a malformed version cannot
    // enter the history the older ones are read from.
    await service.createTemplate(templateInput(), actor)
    const before = JSON.stringify(service.getTemplate('tpl-custom'))
    await rejects('revise applies the same structural rules', () => service.reviseTemplate('tpl-custom', { nodes: [{ id: 'a', name: '甲', dependsOn: ['ghost'] }] }, actor), 'invalid-argument')
    check('a refused revision wrote nothing', JSON.stringify(service.getTemplate('tpl-custom')) === before)
    await board.close()
  })
}

/** The record a build without version management wrote reads as revision 1. */
async function caseLegacyRecord(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '存量需求', templateId: 'tpl-custom' }, actor)
    // Strip the field a record written before template versions carries: the
    // medium is not re-validated on write, and this is exactly the stored form
    // the older build produced.
    const stripped = board.domain.table('requirements').get(created.id)
    delete stripped.templateRevision
    await board.domain.table('requirements').put(created.id, stripped)
    const legacyTemplate = service.getTemplate('tpl-custom')
    check('a template with no version fields reads as revision 1', (legacyTemplate.revision ?? 1) === 1)
    check('and lists as revision 1 with no history', service.listTemplates().items[1].revision === 1 && service.listTemplates().items[1].versionCount === 0 && service.listTemplates().items[1].archived === false)
    check('a requirement with no pin reads as revision 1', (await service.getRequirement(created.id)).templateRevision === 1)
    check('and its flow still resolves', (await service.getRequirement(created.id)).progress.total === 3)
    await board.close()

    const reopened = await openBoard({ backend, dir })
    check('the legacy reading survives a reopen', reopened.service.getRequirement(created.id).templateRevision === 1 && (reopened.service.getTemplate('tpl-custom').revision ?? 1) === 1)
    await reopened.close()
  })
}

/** A record carrying a field the schema does not declare refuses the open. */
async function caseStrictRecord(backend, name) {
  await onBackend(backend, `${name} (top level)`, async dir => {
    const board = await openBoard({ backend, dir })
    await board.service.createTemplate(templateInput(), actor)
    const stored = board.domain.table('templates').get('tpl-custom')
    await board.domain.table('templates').put('tpl-custom', { ...stored, timing: 'soon' })
    await board.close()
    await rejects('a template carrying an undeclared field refuses to open', () => openRawBoard({ backend, dir }), 'invalid-record')
  })
  await onBackend(backend, `${name} (inside a version)`, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    await service.reviseTemplate('tpl-custom', {}, actor)
    const stored = board.domain.table('templates').get('tpl-custom')
    await board.domain.table('templates').put('tpl-custom', {
      ...stored,
      versions: stored.versions.map(version => ({ ...version, timing: 'soon' })),
    })
    await board.close()
    await rejects('a version carrying an undeclared field refuses to open', () => openRawBoard({ backend, dir }), 'invalid-record')
  })
}

/** A pin that names no stored version is normalized at the open-time sweep. */
async function caseSweepRepairsPin(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '钉子悬空', templateId: 'tpl-custom' }, actor)
    await service.reviseTemplate('tpl-custom', { nodes: growingNodes() }, actor)
    // Only a medium edited outside the plugin can produce this: prune refuses a
    // pinned revision and migrate validates its target.
    const stored = board.domain.table('requirements').get(created.id)
    await board.domain.table('requirements').put(created.id, { ...stored, templateRevision: 7 })
    await rejects('the dangling pin is refused loud before the sweep', () => service.getRequirement(created.id), 'invalid-transition')

    const swept = await service.sweepDangling()
    check('the sweep reports the repaired requirement', swept.repairedPins.includes(created.id))
    const repaired = board.domain.table('requirements').get(created.id)
    check('the pin is normalized to the current revision', repaired.templateRevision === 2)
    check('and the node is normalized by the rebinding rule', repaired.nodeId === 'draft')
    const entry = repaired.history.at(-1)
    check('a retemplate entry records why', entry.action === 'retemplate' && entry.note === 'pinned revision 7 missing → 2', entry.note)
    check('and the requirement reads again', (await service.getRequirement(created.id)).templateRevision === 2)
    await board.close()
  })
}

/** The model-facing tool exposes the new actions, hides the panel-only ones, and projects history away. */
async function caseToolSurface(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '工具面', templateId: 'tpl-custom' }, actor)
    await service.reviseTemplate('tpl-custom', { nodes: growingNodes() }, actor)
    const boardItems = service.listRequirements({}).items
    check('the requirement list carries the pinned revision', boardItems.every(item => item.templateRevision >= 1))
    check('the snapshot carries it too', service.snapshot().requirements.every(item => item.templateRevision >= 1))

    const specs = []
    registerTools({ tools: { register: spec => { specs.push(spec); return () => {} } } }, service)
    const tool = specs.find(spec => spec.name === 'flow_template')
    const actions = tool.parameters.properties.action.enum
    check('the tool offers revise, migrate, archive, and clone', ['revise', 'migrate', 'archive', 'clone'].every(action => actions.includes(action)))
    check('and offers no prune, metadata, or preview', !['prune', 'metadata', 'preview'].some(action => actions.includes(action)))
    for (const field of ['id', 'name', 'description', 'nodes', 'expectedRevision', 'revision', 'requirementIds', 'force', 'archived', 'includeArchived']) {
      check(`the tool declares "${field}"`, tool.parameters.properties[field] !== undefined)
    }
    check('the description says revise changes no requirement', /revise.*changes the template only/s.test(tool.description) && /never touches a requirement/s.test(tool.description))
    check('the description says migrate changes requirements and reports impact', tool.description.includes('"migrate" is the only action here that changes requirements') && tool.description.includes('affected'))
    check('the description points pruning and metadata at the panel', tool.description.includes('panel-only'))

    const fetched = await tool.execute({ action: 'get', id: 'tpl-custom' }, { agent: { id: 'ses_editor' } })
    check('the tool get drops the version history and audit tail', fetched.versions === undefined && fetched.changes === undefined)
    check('and reports the revision, nodes, and counts', fetched.revision === 2 && fetched.nodeCount === 4 && fetched.versionCount === 1 && fetched.changeCount === 1)
    const listed = await tool.execute({ action: 'list', includeArchived: true }, { agent: { id: 'ses_editor' } })
    check('the tool list reports each template revision and version count', listed.items.find(item => item.id === 'tpl-custom')?.revision === 2 && listed.items.find(item => item.id === 'tpl-custom')?.versionCount === 1)
    const revised = await tool.execute({ action: 'revise', id: 'tpl-custom', expectedRevision: 2, description: '经工具修订' }, { agent: { id: 'ses_editor' } })
    check('the tool revises with the calling session as the actor', revised.revision === 3 && service.getTemplate('tpl-custom').updatedBy === 'ses_editor')
    const cloned = await tool.execute({ action: 'clone', id: 'tpl-custom', name: '工具副本' }, { agent: { id: 'ses_editor' } })
    check('the tool clones', cloned.supersedes === 'tpl-custom' && cloned.revision === 1)
    // G7: the model may also migrate, archive, and delete; only pruning is panel-only.
    const migrated = await tool.execute({ action: 'migrate', id: 'tpl-custom', revision: 3, force: true }, { agent: { id: 'ses_editor' } })
    check('the tool migrates with a listed impact', Array.isArray(migrated.migrated) && migrated.revision === 3)
    const archived = await tool.execute({ action: 'archive', id: 'tpl-custom' }, { agent: { id: 'ses_editor' } })
    check('the tool archives', archived.archived === true)
    const deleted = await tool.execute({ action: 'delete', id: 'tpl-custom', force: true }, { agent: { id: 'ses_editor' } })
    check('the tool deletes and rebinds the bound requirement', deleted.deleted === true && board.domain.table('templates').get('tpl-custom') === undefined && board.domain.table('requirements').get(created.id).templateId === 'tpl-standard')
    await board.close()
  })
}

/** A write that moves no requirement still tells other panels (G3). */
async function caseBumpRevision(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    await service.reviseTemplate('tpl-custom', { nodes: growingNodes() }, actor)
    const start = board.domain.global.get().revision

    // Nothing is pinned to revision 1, so the bulk migration moves zero
    // requirements — and must still publish a revision.
    const migrated = await service.migrateRequirementsToRevision('tpl-custom', 2, {}, actor)
    check('a migration that moves nothing reports an empty list', migrated.migrated.length === 0 && migrated.affected.length === 0)
    const afterMigrate = board.domain.global.get().revision
    check('and still bumps the document revision', afterMigrate > start, `${start} -> ${afterMigrate}`)

    await service.cloneTemplate('tpl-custom', { name: '副本' }, actor)
    check('cloning bumps it as well', board.domain.global.get().revision > afterMigrate)
    const metaBefore = board.domain.global.get().revision
    await service.setTemplateMetadata('tpl-custom', {}, actor)
    check('a no-op metadata call writes nothing', board.domain.global.get().revision === metaBefore)
    await board.close()
  })
}

/**
 * The mechanical read-side check of §11.9: the set of functions reading a
 * template's top-level `nodes` is pinned, and every call site of them resolves
 * the requirement's version first instead of handing over the raw record.
 */
async function caseStaticResolution() {
  console.log('\n[static] read-side resolution')
  for (const [file, expected] of Object.entries(RESOLVED_READERS)) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    const found = readersOf(text)
    check(`${file} reads top-level nodes in exactly the documented functions`, found.join(',') === expected.join(','), found.join(','))
  }
  const source = await readFile(new URL('../host/service.js', import.meta.url), 'utf8')
  const lines = source.split('\n')
  const readers = Object.values(RESOLVED_READERS).flat()
  const sameLine = lines.filter(line => readers.some(name => new RegExp(`\\b${name}\\(`).test(line)) && line.includes('this.#template('))
  check('no call site derives from an unresolved template', sameLine.length === 0, sameLine.join(' | '))
  // Each reader must still be called from outside the module that defines it, or
  // a rename would leave the list above checking code that no longer exists.
  // `completionState` stays internal to `flow.js`, called by its sibling.
  const modules = {}
  for (const module of ['dispatch.js', 'flow.js', 'service.js', 'tools.js', 'http.js']) {
    modules[module] = await readFile(new URL(`../host/${module}`, import.meta.url), 'utf8')
  }
  const unconsumed = []
  for (const [file, names] of Object.entries(RESOLVED_READERS)) {
    const defining = file.split('/').pop()
    const callers = Object.entries(modules).filter(([module]) => module !== defining).map(([, text]) => text).join('\n')
    for (const name of names) if (name !== 'completionState' && !callers.includes(`${name}(`)) unconsumed.push(name)
  }
  check('every documented reader is still consumed outside its own module', unconsumed.length === 0, unconsumed.join(','))
  const raw = [...new Set(lines
    .filter(line => line.includes('this.#template(') && /templateId/.test(line))
    .map(line => line.trim()))]
  const unexplained = raw.filter(line => !line.includes('#atRevision(') && !RAW_CURRENT_DERIVATIONS.includes(line))
  check('every raw current-version read is one of the documented paths', unexplained.length === 0, unexplained.join(' | '))
  check('and those paths are still the ones the service uses', RAW_CURRENT_DERIVATIONS.every(statement => lines.some(line => line.trim() === statement)))
}

/** The panel's command surface carries the new template operations. */
async function caseHttpCommands(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate(templateInput(), actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '面板命令', templateId: 'tpl-custom' }, actor)

    const listed = await dispatchBoardCommand(service, { action: 'template.list', includeArchived: true })
    check('template.list answers the archived filter', listed.items.some(item => item.id === 'tpl-custom'))
    const revised = await dispatchBoardCommand(service, { action: 'template.revise', id: 'tpl-custom', patch: { nodes: growingNodes() }, session: 'ses_editor' })
    check('template.revise appends through the command body', revised.revision === 2)
    const fetched = await dispatchBoardCommand(service, { action: 'template.get', id: 'tpl-custom' })
    check('template.get returns the raw record with its history', Array.isArray(fetched.versions) && Array.isArray(fetched.changes) && fetched.versionCount === undefined)
    const untenanted = await dispatchBoardCommand(service, { action: 'template.metadata', id: 'tpl-custom', name: '面板改名', session: 'ses_editor' })
    check('template.metadata edits in place', untenanted.name === '面板改名' && untenanted.revision === 2)
    const migrated = await dispatchBoardCommand(service, { action: 'template.migrate', id: 'tpl-custom', revision: 2, requirementIds: [created.id], session: 'ses_editor' })
    check('template.migrate moves a named requirement', migrated.migrated.includes(created.id))
    const archived = await dispatchBoardCommand(service, { action: 'template.archive', id: 'tpl-custom', session: 'ses_editor' })
    check('template.archive shelves it', archived.archived === true)
    const cloned = await dispatchBoardCommand(service, { action: 'template.clone', id: 'tpl-custom', name: '命令副本', session: 'ses_editor' })
    check('template.clone copies the current version', cloned.supersedes === 'tpl-custom' && cloned.archived === false)
    const unarchived = await dispatchBoardCommand(service, { action: 'template.archive', id: 'tpl-custom', archived: false, session: 'ses_editor' })
    check('template.archive restores with archived: false', unarchived.archived === false)
    await service.migrateRequirementsToRevision('tpl-custom', 2, { requirementIds: [created.id] }, actor)
    const pruned = await dispatchBoardCommand(service, { action: 'template.prune', id: 'tpl-custom', revision: 1, session: 'ses_editor' })
    check('template.prune drops an unpinned version', pruned.pruned === 1)
    const refused = await dispatchBoardCommand(service, { action: 'template.prune', id: 'tpl-custom', revision: 2, session: 'ses_editor' })
      .then(() => undefined, error => error)
    check('a refused command carries the board failure code', refused?.code === 'invalid-argument' && refused?.details?.revision === 2)
    const deleted = await dispatchBoardCommand(service, { action: 'template.delete', id: 'tpl-custom', force: true, session: 'ses_editor' })
    check('template.delete rebinds with force', deleted.deleted === true && board.domain.table('requirements').get(created.id).templateId === 'tpl-standard')
    await board.close()
  })
}

const CASES = [
  ['revise appends without touching requirements', caseReviseLeavesRequirements],
  ['a pinned revision keeps running itself', casePinnedRevisionDerives],
  ['both rebinding paths reset the pin', caseRebindResetsPin],
  ['the version limit is refused, not truncated', caseVersionLimit],
  ['revise compare-and-set', caseReviseCompareAndSet],
  ['prune', casePrune],
  ['migrate', caseMigrate],
  ['archive', caseArchive],
  ['clone', caseClone],
  ['template metadata', caseMetadata],
  ['the structural red cases', caseStructureRedCases],
  ['a legacy record reads as revision 1', caseLegacyRecord],
  ['an undeclared field refuses the open', caseStrictRecord],
  ['the open-time sweep repairs a dangling pin', caseSweepRepairsPin],
  ['a write that moves no requirement still bumps', caseBumpRevision],
  ['the tool surface', caseToolSurface],
  ['the panel command surface', caseHttpCommands],
]

for (const backend of BACKENDS) {
  for (const [label, body] of CASES) await body(backend, label)
}
await caseStaticResolution()

process.exit(reporter.finish() ? 0 : 1)
