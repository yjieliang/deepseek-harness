/**
 * Template version management, second suite: the boundary cases `DESIGN.md`
 * §11.9 asks for that `tests/templates-revision.mjs` (316 checks) leaves open.
 *
 * `templates-revision.mjs` proves the happy paths end to end — `revise` moves no
 * requirement, a pinned revision keeps deriving itself, migrate/prune/archive/
 * clone/metadata each work, a legacy record reads as revision 1, the tool surface
 * names the new actions. This file adds the cases that suite does not reach:
 *
 * §11.9 mapping (bullet → case here, unless the mapping names the other suite):
 *  - "结构校验红例逐条对应 11.1 的规则" → `caseStructuralLengths` covers the
 *    per-field ceilings 11.1 lists (name/description/node name/node id/assignee/
 *    checklist item/dependsOn count/completion type); the node-count, cycle,
 *    duplicate-id and unknown-`dependsOn` red cases live in the 316 suite.
 *  - "机制 1 的核心钉子" (逐字段不变) → the 316 suite asserts it on the stored
 *    records; `caseProjectionAndChangeFeed` asserts the same promise at the
 *    observation face — the requirement record is compared as a whole across
 *    every template-only write, and `changesSince` must stay empty.
 *  - "钉住版本的解析 … advance/complete/快照 flow 都必须按第 1 版推导" →
 *    `casePinnedVersionGoverns`: the last node of the *pinned* version completes
 *    the requirement (revision 2's extra node is never entered), `complete` keeps
 *    the pinned node set, `snapshot().flow` and `promptContext` project revision 1.
 *  - "反向红例：钉到已被裁剪的 revision → invalid-transition" →
 *    `casePinnedVersionGoverns` also refuses `advance`/`complete` on such a pin.
 *  - "迁移语义 … 逐条断言迁移后的节点与勾选" → `caseMigrationBoundaries`:
 *    a checklist rewritten with the *same* row count keeps its ticks (the negative
 *    side of 11.9's "checklist 长度变化 → 清空勾选"), a done and an archived
 *    requirement are both migration candidates, and the migrated requirement's
 *    flow derives the target revision afterwards.
 *  - "裁剪门禁：被钉住 → in-use 且数据一个字节不改" → `casePinHeldByDoneOrArchived`
 *    pins the judgment set (§11.5: 判定集合与删除的引用集合相同，含 done/archived;
 *    只看在办会漏掉归档需求) and `caseArchiveBoundaries` covers an archived template
 *    refusing prune/migrate; `caseMigrationBoundaries` asserts the same set for the
 *    migration impact list.
 *  - "元数据边界" → the 316 suite covers the in-place edit; `caseProjectionAndChangeFeed`
 *    adds the document-revision bump every template-only write must publish.
 *  - "回归钉子：配置默认模板拒删（G4）；force 改绑写 retemplate（G5）" → 316.
 *  - "模板侧留痕与可见性 … listTemplates 的投影含 revision/updatedBy/archived/
 *    版本条数，versions/changes 只在 getTemplate 里；快照里能看到 templateRevision"
 *    → `caseProjectionAndChangeFeed` asserts the omission as well as the presence.
 *  - "读取容错与'只能前进'" → `caseLegacyRecordOnlyForward`: a template record with
 *    every new field *absent* (not merely a fresh one, which never carried them)
 *    reads as revision 1 / not archived, the first append snapshots it as version 1,
 *    and a requirement record with an undeclared field or a non-positive pin
 *    refuses the open.
 *  - "权限口径（G7）" / "工具面：动作枚举的变化要有断言钉住" →
 *    `caseToolSchema` pins the *exact* action enum and the exact flat parameter set
 *    of `flow_template` statically, and proves the strictness (`additionalProperties:
 *    false`) of all three tools. The 316 suite asserts act-by-act behaviour.
 *  - "并发：两个编辑者用同一个 expectedRevision 追加，后者必须 conflict" → 316
 *    (stale and concurrent cases); this file adds nothing there because the racer
 *    case already settles both orders.
 *  - "写入语义（三条阻断的钉子）" → 316 (create writes the current revision, both
 *    rebinding paths reset the pin, the 21st version is refused).
 *  - "读侧解析点（一条机械检查）" → the 316 suite owns the grep-shaped check.
 *  - "修复口径" (写库造一个悬空钉子，开域后归一) → 316, extended here by refusing
 *    `advance`/`complete` before the repair runs.
 *
 * Run with `node tests/templates-lifecycle.mjs`.
 */

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

/**
 * One actor per requirement.
 *
 * A session holds exactly one execution lock, so claiming two requirements as the
 * same actor is refused (`session-busy`) — a case that needs several claimed
 * requirements names a session per requirement.
 */
function actorFor(session) {
  return { session, name: session }
}

/** The two-node version a pinned requirement must keep running after revision 2. */
function pinnedV1() {
  return [
    { id: 'draft', name: '起草', completion: { type: 'checklist', checklist: ['范围明确', '干系人确认'] } },
    { id: 'review', name: '评审', dependsOn: ['draft'], completion: { type: 'manual' } },
  ]
}

/** Revision 2 renames the middle node and appends one after it. */
function pinnedV2() {
  return [
    { id: 'draft', name: '起草', completion: { type: 'checklist', checklist: ['范围明确', '干系人确认', '风险评估'] } },
    { id: 'review', name: '复核', dependsOn: ['draft'], completion: { type: 'manual' } },
    { id: 'ship', name: '交付', dependsOn: ['review'], completion: { type: 'manual' } },
  ]
}

/** Run one case for one backend, in a fresh temporary directory. */
async function onBackend(backend, name, body) {
  const dir = await makeTempDir(`rb-life-${backend}-`)
  console.log(`\n[${backend}] ${name}`)
  try {
    await body(dir)
  } finally {
    await removeTempDir(dir)
  }
}

/** Tick every checklist entry of the requirement's current node, as the pinned version declares it. */
async function tickAll(service, id, actorForCall) {
  const view = await service.getRequirement(id)
  const node = view.flow.find(entry => entry.id === view.nodeId)
  const entries = node?.completion?.checklist ?? []
  for (const [index] of entries.entries()) await service.setChecklist(id, { index, checked: true }, actorForCall)
}

/** The stored requirement record, for byte-level comparisons. */
function recordOf(board, id) {
  return board.domain.table('requirements').get(id)
}

/**
 * The pinned revision governs every derivation: `advance` off the pinned last
 * node, `complete`, the snapshot's `flow`, the prompt segment — and a pin naming
 * no stored revision is refused loud rather than silently read as the top level.
 */
async function casePinnedVersionGoverns(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate({ id: 'tpl-pin', name: '钉住解析', nodes: pinnedV1() }, actor)
    const last = await service.createRequirement({ summary: '测试简述', title: '钉住最后一节点', templateId: 'tpl-pin' }, actor)
    const completed = await service.createRequirement({ summary: '测试简述', title: '钉住并完成', templateId: 'tpl-pin' }, actor)
    const read = await service.createRequirement({ summary: '测试简述', title: '钉住并读取', templateId: 'tpl-pin' }, actor)
    const dangling = await service.createRequirement({ summary: '测试简述', title: '钉子悬空', templateId: 'tpl-pin' }, actor)
    const lastActor = actorFor('ses_last')
    const completedActor = actorFor('ses_complete')
    const readActor = actorFor('ses_read')
    const danglingActor = actorFor('ses_dangling')
    for (const [requirement, owner] of [[last, lastActor], [completed, completedActor], [read, readActor], [dangling, danglingActor]]) {
      await service.claim(requirement.id, {}, owner)
    }
    check('every requirement created before the revision is pinned to 1',
      [last, completed, read, dangling].every(requirement => requirement.templateRevision === 1))

    await service.reviseTemplate('tpl-pin', { nodes: pinnedV2() }, actor)

    const readView = await service.getRequirement(read.id)
    check('the pinned flow still holds the two nodes of revision 1',
      readView.flow.map(entry => entry.name).join(',') === '起草,评审', readView.flow.map(entry => entry.name).join(','))
    check('the snapshot projects the pinned flow, not the current revision',
      service.snapshot().requirements.find(row => row.id === read.id).flow.length === 2)
    const promptText = service.promptContext('ses_read', 12)
    check('the prompt counts the pinned flow', promptText.includes('· node 1/2 起草'), promptText.slice(0, 160))
    check('and never names a node only revision 2 has', !promptText.includes('复核') && !promptText.includes('交付'), promptText.slice(0, 160))

    // The last node of revision 1 completes the requirement. Were the top level
    // (revision 2) read instead, `advance` would move into `review` and on to `ship`.
    await tickAll(service, last.id, lastActor)
    await service.transitionRequirement(last.id, { action: 'advance' }, lastActor)
    const finished = await service.transitionRequirement(last.id, { action: 'advance' }, lastActor)
    const entry = recordOf(board, last.id).history.at(-1)
    check('advancing the pinned last node completes the requirement', finished.status === 'done', finished.status)
    check('and the history records the pinned node it left',
      entry.action === 'advance' && entry.from === 'review' && entry.toName === '评审' && entry.toStatus === 'done',
      JSON.stringify({ action: entry.action, from: entry.from, toName: entry.toName, toStatus: entry.toStatus }))
    check('so the node revision 2 appends after it is never entered', finished.nodeId === 'review')

    const completedView = await service.transitionRequirement(completed.id, { action: 'complete' }, completedActor)
    check('complete on a pinned requirement keeps its node', completedView.status === 'done' && completedView.nodeId === 'draft')
    check('and its derived node states stay the pinned ones',
      Object.keys(recordOf(board, completed.id).nodes).join(',') === 'draft,review',
      Object.keys(recordOf(board, completed.id).nodes).join(','))

    // A pin naming no stored revision cannot come from the public API (prune
    // refuses a pinned revision, migrate validates its target), so the medium is
    // written directly — the same state the open-time repair exists for.
    const stored = recordOf(board, dangling.id)
    await board.domain.table('requirements').put(dangling.id, { ...stored, templateRevision: 5 })
    await rejects('advance refuses a pin naming no stored revision',
      () => service.transitionRequirement(dangling.id, { action: 'advance', force: true }, danglingActor), 'invalid-transition')
    await rejects('and complete refuses it too',
      () => service.transitionRequirement(dangling.id, { action: 'complete' }, danglingActor), 'invalid-transition')
    await board.close()
  })
}

/**
 * Migration boundaries: the tick-clearing rule is about the checklist's *length*,
 * so a same-length rewrite keeps its ticks; the candidate set is every requirement
 * bound to the template, done and archived included.
 */
async function caseMigrationBoundaries(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate({ id: 'tpl-mig', name: '迁移边界', nodes: [
      { id: 'a', name: '甲', completion: { type: 'checklist', checklist: ['一', '二'] } },
      { id: 'b', name: '乙', dependsOn: ['a'], completion: { type: 'manual' } },
    ] }, actor)
    const kept = await service.createRequirement({ summary: '测试简述', title: '清单长度不变', templateId: 'tpl-mig' }, actor)
    const done = await service.createRequirement({ summary: '测试简述', title: '已完成', templateId: 'tpl-mig' }, actor)
    const shelved = await service.createRequirement({ summary: '测试简述', title: '已归档', templateId: 'tpl-mig' }, actor)
    const keptActor = actorFor('ses_kept')
    const doneActor = actorFor('ses_done')
    const shelvedActor = actorFor('ses_shelved')
    await service.claim(kept.id, {}, keptActor)
    await service.claim(done.id, {}, doneActor)
    await service.setChecklist(kept.id, { index: 0, checked: true }, keptActor)
    await tickAll(service, done.id, doneActor)
    await service.transitionRequirement(done.id, { action: 'advance' }, doneActor)
    await service.transitionRequirement(done.id, { action: 'advance' }, doneActor)
    await service.claim(shelved.id, {}, shelvedActor)
    await service.setArchived(shelved.id, { archived: true }, shelvedActor)
    check('the fixtures are pinned to revision 1', [kept, done, shelved].every(requirement => requirement.templateRevision === 1))
    check('the done fixture really is done', (await service.getRequirement(done.id)).status === 'done')
    check('the shelved fixture really is archived', (await service.getRequirement(shelved.id)).status === 'archived')

    // Revision 2 rewrites the same two checklist rows in place and renames `b`:
    // a length-based rule must not clear the ticks, and the target revision must
    // be what the requirement derives afterwards.
    await service.reviseTemplate('tpl-mig', { nodes: [
      { id: 'a', name: '甲', completion: { type: 'checklist', checklist: ['甲一', '甲二'] } },
      { id: 'b', name: '乙二', dependsOn: ['a'], completion: { type: 'manual' } },
    ] }, actor)

    const refused = await rejects('an unconfirmed bulk migration is refused',
      () => service.migrateRequirementsToRevision('tpl-mig', 2, {}, actor), 'in-use')
    const listed = refused?.details?.requirements ?? []
    check('the refusal lists every pinned requirement, done and archived included',
      listed.includes(kept.id) && listed.includes(done.id) && listed.includes(shelved.id), JSON.stringify(listed))
    const impact = (refused?.details?.affected ?? []).find(row => row.id === kept.id)
    check('the impact calls a same-length checklist rewrite "not cleared"', impact?.clearedChecks === false, JSON.stringify(impact))
    check('and names the node it keeps and the revision it leaves', impact?.nodeId === 'a' && impact?.next === 'a' && impact?.revision === 1, JSON.stringify(impact))
    check('the refusal moved no requirement',
      (await service.getRequirement(kept.id)).templateRevision === 1 && recordOf(board, kept.id).nodes.a.checks.join(',') === 'true,false')

    const named = await service.migrateRequirementsToRevision('tpl-mig', 2, { requirementIds: [kept.id, done.id, shelved.id] }, actor)
    check('a named migration needs no force and moves every named requirement',
      named.migrated.length === 3 && named.affected.length === 3, JSON.stringify(named.migrated))
    const keptView = await service.getRequirement(kept.id)
    check('a same-length checklist keeps the ticks it had', recordOf(board, kept.id).nodes.a.checks.join(',') === 'true,false',
      recordOf(board, kept.id).nodes.a.checks.join(','))
    check('and the flow now derives the target revision', keptView.flow.map(entry => entry.name).join(',') === '甲,乙二',
      keptView.flow.map(entry => entry.name).join(','))
    check('the pin moved with it', keptView.templateRevision === 2)
    check('the migration left one retemplate entry per requirement',
      recordOf(board, kept.id).history.at(-1).note === 'migrated to revision 2 from 1'
      && recordOf(board, done.id).history.at(-1).note === 'migrated to revision 2 from 1'
      && recordOf(board, shelved.id).history.at(-1).note === 'migrated to revision 2 from 1')
    check('a migrated done requirement keeps its status', (await service.getRequirement(done.id)).status === 'done')
    check('a migrated archived requirement keeps its status', (await service.getRequirement(shelved.id)).status === 'archived')
    check('the done requirement kept the node it was on', recordOf(board, done.id).nodeId === 'b')
    await board.close()
  })
}

/**
 * A pin held by a done or archived requirement still protects its revision
 * (§11.5: the judgment set is deletion's, not "in office only"), and an archived
 * template refuses the three acts that would change a requirement.
 */
async function caseArchiveBoundaries(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate({ id: 'tpl-arch', name: '归档边界', nodes: [
      { id: 'only', name: '唯一' },
      { id: 'next', name: '后续', dependsOn: ['only'] },
    ] }, actor)
    await service.createTemplate({ id: 'tpl-other', name: '另一模板', nodes: [{ id: 'solo', name: '独' }] }, actor)
    const bound = await service.createRequirement({ summary: '测试简述', title: '已绑需求', templateId: 'tpl-arch' }, actor)
    const rebind = await service.createRequirement({ summary: '测试简述', title: '待改绑', templateId: 'tpl-other' }, actor)
    const boundActor = actorFor('ses_bound')
    const rebindActor = actorFor('ses_rebind')
    await service.claim(bound.id, {}, boundActor)
    await service.claim(rebind.id, {}, rebindActor)
    await service.reviseTemplate('tpl-arch', { nodes: [
      { id: 'only', name: '唯一' },
      { id: 'mid', name: '中间', dependsOn: ['only'] },
      { id: 'next', name: '后续', dependsOn: ['mid'] },
    ] }, actor)
    check('the bound requirement stayed on revision 1', recordOf(board, bound.id).templateRevision === 1)

    await service.archiveTemplate('tpl-arch', {}, actor)
    check('an archived template leaves the default list', !service.listTemplates().items.some(item => item.id === 'tpl-arch'))
    check('but getTemplate still reads it', service.getTemplate('tpl-arch').archived === true)

    const advanced = await service.transitionRequirement(bound.id, { action: 'advance' }, boundActor)
    check('a requirement already bound to it still advances on its pinned revision',
      advanced.nodeId === 'next' && advanced.status === 'active', `${advanced.nodeId}/${advanced.status}`)
    check('and its flow stays the pinned two-node revision', advanced.flow.length === 2, String(advanced.flow.length))

    await rejects('a requirement cannot be rebound onto an archived template',
      () => service.updateRequirement(rebind.id, { templateId: 'tpl-arch' }, rebindActor), 'invalid-transition')
    await rejects('an archived template cannot be migrated',
      () => service.migrateRequirementsToRevision('tpl-arch', 2, { requirementIds: [bound.id] }, actor), 'invalid-transition')
    await rejects('and cannot be pruned',
      () => service.pruneTemplateVersion('tpl-arch', 1, actor), 'invalid-transition')
    check('the refused acts changed no template or requirement record',
      service.getTemplate('tpl-arch').revision === 2
      && service.getTemplate('tpl-arch').versions.length === 1
      && recordOf(board, rebind.id).templateId === 'tpl-other'
      && recordOf(board, bound.id).templateRevision === 1)
    await board.close()
  })
}

/**
 * A stored template carrying none of the new fields — the record an older build
 * wrote — reads as revision 1 with no history; the first append snapshots it. The
 * one-way cost is asserted too: an undeclared field, or a pin that is not a
 * positive revision, refuses the whole open.
 */
async function caseLegacyRecordOnlyForward(backend, name) {
  await onBackend(backend, `${name} (absent fields)`, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate({ id: 'tpl-old', name: '存量模板', nodes: [
      { id: 'a', name: '甲' }, { id: 'b', name: '乙', dependsOn: ['a'] },
    ] }, actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '存量需求', templateId: 'tpl-old' }, actor)
    await service.claim(created.id, {}, actor)
    await service.reviseTemplate('tpl-old', { nodes: [
      { id: 'a', name: '甲' }, { id: 'b', name: '乙', dependsOn: ['a'] }, { id: 'c', name: '丙', dependsOn: ['b'] },
    ] }, actor)
    check('the fixture template carries the new fields before they are stripped',
      service.getTemplate('tpl-old').revision === 2 && service.getTemplate('tpl-old').versions.length === 1)

    // The older build wrote neither the template's management fields nor the
    // requirement's pin, and the medium is not re-validated on write.
    const templateRecord = board.domain.table('templates').get('tpl-old')
    const stripped = { ...templateRecord }
    for (const field of ['revision', 'versions', 'archived', 'updatedBy', 'supersedes', 'changes']) delete stripped[field]
    await board.domain.table('templates').put('tpl-old', stripped)
    const requirementRecord = recordOf(board, created.id)
    delete requirementRecord.templateRevision
    await board.domain.table('requirements').put(created.id, requirementRecord)
    await board.close()

    const reopened = await openBoard({ backend, dir })
    const raw = reopened.service.getTemplate('tpl-old')
    check('a record written without the new fields still opens', raw !== undefined)
    check('and was not back-filled on open', !('revision' in raw) && !('versions' in raw) && !('archived' in raw) && !('updatedBy' in raw))
    const row = reopened.service.listTemplates().items.find(item => item.id === 'tpl-old')
    check('the list reads it as revision 1, not archived, with no history',
      row.revision === 1 && row.archived === false && row.versionCount === 0 && row.updatedBy === '',
      JSON.stringify({ revision: row.revision, archived: row.archived, versionCount: row.versionCount, updatedBy: row.updatedBy }))
    const view = await reopened.service.getRequirement(created.id)
    check('a requirement without a pin reads as revision 1', view.templateRevision === 1)
    check('and resolves the flow the record still has', view.flow.length === 3)
    await reopened.service.transitionRequirement(created.id, { action: 'advance' }, actor)
    check('that legacy requirement still advances', (await reopened.service.getRequirement(created.id)).nodeId === 'b')

    const revised = await reopened.service.reviseTemplate('tpl-old', { description: '第一次追加' }, actor)
    const stored = reopened.service.getTemplate('tpl-old')
    check('the first append after a legacy record starts the version line at 2', revised.revision === 2)
    check('and snapshots the legacy top level as revision 1',
      stored.versions.length === 1 && stored.versions[0].revision === 1 && stored.versions[0].nodes.length === 3)
    check('the legacy requirement is reported as pinned to the old revision', revised.pinnedToOld === 1)
    await reopened.close()
  })

  await onBackend(backend, `${name} (undeclared requirement field)`, async dir => {
    const board = await openBoard({ backend, dir })
    await board.service.createTemplate({ id: 'tpl-old', name: '存量模板', nodes: [{ id: 'a', name: '甲' }] }, actor)
    const created = await board.service.createRequirement({ summary: '测试简述', title: '存量需求', templateId: 'tpl-old' }, actor)
    const record = recordOf(board, created.id)
    await board.domain.table('requirements').put(created.id, { ...record, templateRevision_: 2 })
    await board.close()
    await rejects('a requirement carrying an undeclared field refuses to open',
      () => openRawBoard({ backend, dir }), 'invalid-record')
  })

  await onBackend(backend, `${name} (non-positive pin)`, async dir => {
    const board = await openBoard({ backend, dir })
    await board.service.createTemplate({ id: 'tpl-old', name: '存量模板', nodes: [{ id: 'a', name: '甲' }] }, actor)
    const created = await board.service.createRequirement({ summary: '测试简述', title: '存量需求', templateId: 'tpl-old' }, actor)
    const record = recordOf(board, created.id)
    await board.domain.table('requirements').put(created.id, { ...record, templateRevision: 0 })
    await board.close()
    await rejects('a pin that is not a positive revision refuses to open',
      () => openRawBoard({ backend, dir }), 'invalid-record')
  })
}

/**
 * A pin held by a done or archived requirement still protects its revision
 * (§11.5: the judgment set is deletion's — every requirement whose `templateId`
 * matches — not "in office only", because such a requirement must still resolve
 * its flow the next time the board opens).
 */
async function casePinHeldByDoneOrArchived(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate({ id: 'tpl-pins', name: '非在办钉子', nodes: [
      { id: 'a', name: '甲', completion: { type: 'checklist', checklist: ['一'] } },
      { id: 'b', name: '乙', dependsOn: ['a'], completion: { type: 'manual' } },
    ] }, actor)
    const finished = await service.createRequirement({ summary: '测试简述', title: '已完成但钉住', templateId: 'tpl-pins' }, actor)
    const shelved = await service.createRequirement({ summary: '测试简述', title: '已归档但钉住', templateId: 'tpl-pins' }, actor)
    const finishedActor = actorFor('ses_finished')
    const shelvedActor = actorFor('ses_shelved_pin')
    await service.claim(finished.id, {}, finishedActor)
    await tickAll(service, finished.id, finishedActor)
    await service.transitionRequirement(finished.id, { action: 'advance' }, finishedActor)
    await service.transitionRequirement(finished.id, { action: 'advance' }, finishedActor)
    await service.claim(shelved.id, {}, shelvedActor)
    await service.setArchived(shelved.id, { archived: true }, shelvedActor)
    await service.reviseTemplate('tpl-pins', { nodes: [
      { id: 'a', name: '甲', completion: { type: 'checklist', checklist: ['一'] } },
      { id: 'b', name: '乙', dependsOn: ['a'], completion: { type: 'manual' } },
      { id: 'c', name: '丙', dependsOn: ['b'], completion: { type: 'manual' } },
    ] }, actor)
    check('neither holder is in office',
      (await service.getRequirement(finished.id)).status === 'done'
      && (await service.getRequirement(shelved.id)).status === 'archived')
    const refused = await rejects('prune refuses a revision a done requirement still pins',
      () => service.pruneTemplateVersion('tpl-pins', 1, actor), 'in-use')
    check('and the refusal names every holder, the done and archived ones included',
      (refused?.details?.requirements ?? []).includes(finished.id) && (refused?.details?.requirements ?? []).includes(shelved.id),
      JSON.stringify(refused?.details?.requirements))
    check('the refused prune dropped nothing',
      service.getTemplate('tpl-pins').versions.length === 1 && service.getTemplate('tpl-pins').revision === 2)
    await service.migrateRequirementsToRevision('tpl-pins', 2, { requirementIds: [finished.id, shelved.id] }, actor)
    const pruned = await service.pruneTemplateVersion('tpl-pins', 1, actor)
    check('once both moved off it, the same revision prunes', pruned.pruned === 1)
    check('and both still resolve their flow',
      (await service.getRequirement(finished.id)).flow.length === 3
      && (await service.getRequirement(shelved.id)).flow.length === 3)
    await board.close()
  })
}

/**
 * Every ceiling §11.1 lists, one red case each, on the `create` boundary; a
 * revision is normalized by the same function, so one of them is repeated on
 * `revise` to prove the refusal cannot enter the version history.
 */
async function caseStructuralLengths(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const long = count => 'x'.repeat(count)
    await rejects('a template name over 120 characters is refused',
      () => service.createTemplate({ name: long(121), nodes: [{ id: 'a', name: '甲' }] }, actor), 'invalid-argument')
    await rejects('a template description over 600 characters is refused',
      () => service.createTemplate({ name: '长描述', description: long(601), nodes: [{ id: 'a', name: '甲' }] }, actor), 'invalid-argument')
    await rejects('a node name over 120 characters is refused',
      () => service.createTemplate({ name: '长节点名', nodes: [{ id: 'a', name: long(121) }] }, actor), 'invalid-argument')
    await rejects('an explicit node id over 64 characters is refused',
      () => service.createTemplate({ name: '长节点 id', nodes: [{ id: long(65), name: '甲' }] }, actor), 'invalid-argument')
    await rejects('an assignee over 120 characters is refused',
      () => service.createTemplate({ name: '长处理人', nodes: [{ id: 'a', name: '甲', assignee: long(121) }] }, actor), 'invalid-argument')
    await rejects('a node description over 600 characters is refused',
      () => service.createTemplate({ name: '长节点描述', nodes: [{ id: 'a', name: '甲', description: long(601) }] }, actor), 'invalid-argument')
    await rejects('a checklist entry over 160 characters is refused',
      () => service.createTemplate({ name: '长检查项', nodes: [{ id: 'a', name: '甲', completion: { type: 'checklist', checklist: [long(161)] } }] }, actor), 'invalid-argument')
    await rejects('more than 20 declared prerequisites are refused',
      () => service.createTemplate({ name: '依赖过多', nodes: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙', dependsOn: Array.from({ length: 21 }, () => 'a') }] }, actor), 'invalid-argument')
    await rejects('an unknown completion type is refused',
      () => service.createTemplate({ name: '未知完成条件', nodes: [{ id: 'a', name: '甲', completion: { type: 'automatic' } }] }, actor), 'invalid-argument')

    await service.createTemplate({ id: 'tpl-len', name: '长度边界', nodes: [{ id: 'a', name: '甲' }] }, actor)
    await rejects('revise applies the same ceilings',
      () => service.reviseTemplate('tpl-len', { nodes: [{ id: 'a', name: long(121) }] }, actor), 'invalid-argument')
    check('a refused revision wrote nothing', service.getTemplate('tpl-len').revision === undefined && service.getTemplate('tpl-len').versions === undefined)
    await board.close()
  })
}

/**
 * The panel's two reads and the observation face of mechanism 1: the list and the
 * snapshot must carry the revision facts but never the version history or audit
 * tail, template-only writes must publish a document revision, and they must not
 * appear in the requirement change feed.
 */
async function caseProjectionAndChangeFeed(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    await service.createTemplate({ id: 'tpl-feed', name: '可见性', nodes: [
      { id: 'a', name: '甲', completion: { type: 'checklist', checklist: ['一', '二'] } },
      { id: 'b', name: '乙', dependsOn: ['a'], completion: { type: 'manual' } },
    ] }, actor)
    const created = await service.createRequirement({ summary: '测试简述', title: '可见性需求', templateId: 'tpl-feed' }, actor)
    await service.claim(created.id, {}, actor)
    await service.reviseTemplate('tpl-feed', { description: '第二版' }, actor)
    await service.migrateRequirementsToRevision('tpl-feed', 2, { requirementIds: [created.id] }, actor)

    const row = service.listTemplates().items.find(item => item.id === 'tpl-feed')
    check('the list projection carries the revision facts the panel draws',
      row.revision === 2 && row.versionCount === 1 && row.archived === false && row.updatedBy === 'ses_editor',
      JSON.stringify({ revision: row.revision, versionCount: row.versionCount, archived: row.archived, updatedBy: row.updatedBy }))
    check('and withholds the version history and the audit tail', row.versions === undefined && row.changes === undefined)
    const snapshotRow = service.snapshot().templates.find(item => item.id === 'tpl-feed')
    check('the snapshot withholds them too', snapshotRow.versions === undefined && snapshotRow.changes === undefined)
    check('while getTemplate still answers the full record',
      Array.isArray(service.getTemplate('tpl-feed').versions) && service.getTemplate('tpl-feed').versions.length === 1)
    check('the snapshot names the revision each requirement is pinned to',
      service.snapshot().requirements.find(item => item.id === created.id).templateRevision === 2)

    // A template-only write moves no requirement, but an open panel still has to
    // be told: the document revision is the frame the SSE `changed` event carries.
    // The stored record is compared as a whole, because a clock that does not
    // advance inside one millisecond would hide a touch from the feed below.
    const feedBefore = JSON.stringify(recordOf(board, created.id))
    const cutoff = new Date().toISOString()
    const before = board.domain.global.get().revision
    await service.reviseTemplate('tpl-feed', { description: '第三版' }, actor)
    const afterRevise = board.domain.global.get().revision
    check('appending a version bumps the document revision', afterRevise > before, `${before} -> ${afterRevise}`)
    await service.setTemplateMetadata('tpl-feed', { name: '可见性（改名）' }, actor)
    const afterMetadata = board.domain.global.get().revision
    check('editing metadata in place bumps it as well', afterMetadata > afterRevise, `${afterRevise} -> ${afterMetadata}`)
    await service.pruneTemplateVersion('tpl-feed', 1, actor)
    check('pruning a version bumps it too', board.domain.global.get().revision > afterMetadata)

    const quiet = service.changesSince(cutoff)
    check('no template-only write changed a single field of the requirement record',
      JSON.stringify(recordOf(board, created.id)) === feedBefore)
    check('template writes alone leave the requirement change feed empty',
      quiet.requirements.length === 0 && quiet.transitions.length === 0,
      JSON.stringify({ requirements: quiet.requirements.length, transitions: quiet.transitions.length }))
    check('even though the template side left its own audit trail', service.getTemplate('tpl-feed').changes.length >= 3)

    await service.setChecklist(created.id, { index: 0, checked: true }, actor)
    const loud = service.changesSince(cutoff)
    check('a requirement write does show up, so the feed is not trivially empty',
      loud.requirements.some(item => item.id === created.id), JSON.stringify(loud.requirements.map(item => item.id)))
    check('and a checklist tick still writes no transition', loud.transitions.length === 0)
    await board.close()
  })
}

/**
 * The `flow_template` parameter surface, asserted statically.
 *
 * `DESIGN.md` §11.7 fixes two things a running board cannot show: the action enum
 * (the four new actions in, `prune`/`metadata`/`preview` out) and the flat,
 * strict parameter object (new fields are top-level names, never a nested
 * `patch`, which would change `create`'s shape). Registration needs no service,
 * so this check reads the schema the model would receive.
 */
async function caseToolSchema() {
  console.log('\n[static] flow_template parameter surface')
  const specs = []
  registerTools({ tools: { register: spec => { specs.push(spec); return () => {} } } }, undefined)
  const tool = specs.find(spec => spec.name === 'flow_template')
  const board = specs.find(spec => spec.name === 'requirement_board')
  const role = specs.find(spec => spec.name === 'requirement_role')
  check('the plugin registers exactly its three tools',
    specs.length === 3 && tool !== undefined && board !== undefined && role !== undefined,
    specs.map(spec => spec.name).join(','))
  const actions = [...tool.parameters.properties.action.enum].sort()
  check('the action enum is exactly the eight documented actions',
    actions.join(',') === 'archive,clone,create,delete,get,list,migrate,revise', actions.join(','))
  check('the parameter object declares no additional property', tool.parameters.additionalProperties === false)
  check('its only required parameter is the action', JSON.stringify(tool.parameters.required) === '["action"]', JSON.stringify(tool.parameters.required))
  check('the parameters are flat: no nested patch object', tool.parameters.properties.patch === undefined)
  const declared = Object.keys(tool.parameters.properties).sort()
  check('the declared parameter set is exactly the documented flat fields',
    declared.join(',') === 'action,archived,description,expectedRevision,force,id,includeArchived,name,nodes,requirementIds,revision',
    declared.join(','))
  const nested = Object.entries(tool.parameters.properties).filter(([, schema]) => schema.type === 'object').map(([key]) => key)
  check('no declared parameter is a nested object schema', nested.length === 0, nested.join(','))
  check('the board and role tools are strict as well',
    board.parameters.additionalProperties === false && role.parameters.additionalProperties === false)
  check('the board tool also has no nested patch parameter', board.parameters.properties.patch === undefined)
}

const CASES = [
  ['a pinned revision governs every derivation', casePinnedVersionGoverns],
  ['migration boundaries', caseMigrationBoundaries],
  ['archive boundaries', caseArchiveBoundaries],
  ['a non-office pin still protects its revision', casePinHeldByDoneOrArchived],
  ['a legacy record reads as revision 1 and refuses undeclared fields', caseLegacyRecordOnlyForward],
  ['every structural ceiling is refused', caseStructuralLengths],
  ['projection and change feed', caseProjectionAndChangeFeed],
]

for (const backend of BACKENDS) {
  for (const [label, body] of CASES) await body(backend, label)
}
await caseToolSchema()

process.exit(reporter.finish() ? 0 : 1)
