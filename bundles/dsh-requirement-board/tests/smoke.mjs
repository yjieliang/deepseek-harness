/**
 * Host-half smoke test: drives the service surface the tools and the browser
 * route both call, over the board's real storage path in a throwaway directory.
 *
 * The medium is the JSON backend so the durability section can read the unit
 * file it produced; `tests/domain.mjs` runs the same durable behavior against
 * both backends.
 *
 * Run with `node tests/smoke.mjs`.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveConfig } from '../host/config.js'
import { dispatchBoardCommand } from '../host/http.js'
import { IMAGE_MAX_BYTES } from '../host/images.js'
import { registerTools } from '../host/tools.js'
import { createReporter, imageFixture, makeTempDir, mediumPath, openBoard, removeTempDir, requestBoardRoute } from './harness.mjs'

const reporter = createReporter()
const { check, rejects } = reporter

const dir = await makeTempDir()
const config = resolveConfig({ stallAfterHours: 1, imageDir: join(dir, 'images') })
let board
let reopened
try {
  board = await openBoard({ backend: 'json', dir, config })
  const service = board.service
  const actor = { session: 'ses_A', name: 'A' }

  console.log('\ntemplates')
  const templates = await service.createTemplate({
    id: 'tpl-custom',
    name: '自定义流程',
    nodes: [
      { name: '起草', completion: { type: 'checklist', checklist: ['范围明确', '干系人确认'] } },
      { name: '评审', completion: { type: 'manual', requireNote: true }, dependsOn: ['起草'] },
      { name: '关闭', completion: { type: 'manual' }, dependsOn: ['评审'] },
    ],
  }, actor)
  check('custom template created with derived node ids', templates.nodes.map(n => n.id).join(',') === '起草,评审,关闭', templates.nodes.map(n => n.id).join(','))
  check('declared list length is preserved', service.listTemplates().items.length === 2)

  console.log('\ncreate + flow binding')
  const created = await service.createRequirement({ summary: '测试简述', title: '跨会话看板', priority: 'high', owner: '张三', templateId: 'tpl-custom' }, actor)
  check('requirement binds to the named template', created.templateId === 'tpl-custom')
  check('creator session is attached', created.sessions.includes('ses_A'))
  check('flow starts on the first node', created.flow[0].status === 'active' && created.flow[1].status === 'pending')
  check('progress is 0/3', created.progress.done === 0 && created.progress.total === 3)

  console.log('\nthe brief')
  // Every creation states the brief, and the refusal teaches the rule rather
  // than restating the field name: a caller that omitted it learns what the
  // field is for from the same message.
  const refusedBrief = await rejects('a creation without a brief is refused', () => service.createRequirement({ title: '没有简述' }, actor), 'invalid-argument')
  check('the refusal names the field and states what a brief is for',
    refusedBrief?.details?.field === 'summary' && refusedBrief?.message.includes('plain-language'))
  await rejects('a whitespace-only brief is refused the same way', () => service.createRequirement({ summary: '   ', title: '空简述' }, actor), 'invalid-argument')
  const briefed = await service.createRequirement({ summary: '让多个会话看到同一份进度。', title: '带简述的需求' }, actor)
  check('the brief is stored and read back', briefed.summary === '让多个会话看到同一份进度。'
    && (await service.getRequirement(briefed.id)).summary === '让多个会话看到同一份进度。')
  const searchedBrief = await service.listRequirements({ query: '同一份进度' }, actor.session)
  check('a list row carries the brief, and search matches it',
    searchedBrief.items.some(item => item.id === briefed.id && item.summary === '让多个会话看到同一份进度。'))
  const rewrittenBrief = await service.updateRequirement(briefed.id, { summary: '换一句更直白的说法。' }, actor)
  check('the brief is updatable', rewrittenBrief.summary === '换一句更直白的说法。')
  await rejects('an update cannot empty the brief', () => service.updateRequirement(briefed.id, { summary: '' }, actor), 'invalid-argument')
  // The rest of this scenario counts the requirements it creates, so the one
  // this section added leaves before then: a second session takes the lock and
  // deletes it, which also proves the brief travels with the removal.
  const cleaner = { session: 'ses_B', name: 'B' }
  await service.claim(briefed.id, {}, cleaner)
  await service.deleteRequirement(briefed.id, {}, cleaner)
  check('deleting the requirement this section added leaves the board as it was',
    (await service.listRequirements({}, actor.session)).items.every(item => item.id !== briefed.id))

  // §5.1: `create` attaches the creator but leaves the work unlocked, and every
  // structural change — checklist, transition, block, archive — needs the lock.
  // A session therefore claims before it runs, which is what this scenario does
  // for the rest of its writes.
  await service.claim(created.id, {}, actor)

  // §5.3: one session holds one lock, so the next requirement is reserved with
  // `queue` — a soft reservation that takes no lock and starts nothing.
  console.log('\nqueueing the next requirement')
  const next = await service.createRequirement({ summary: '测试简述', title: '队列里的下一条' }, actor)
  const reservedNext = await service.queue(next.id, {}, actor)
  check('queueing reserves the next requirement without locking it', reservedNext.changed === true && reservedNext.head.id === next.id)
  check('queueing writes no requirement and no execution unit', (await service.getRequirement(next.id)).lock === null && board.domain.table('requirements').get(next.id).rev === 1)
  check('the reservation is derived from the queue row', (await service.getRequirement(next.id)).reservedBy === 'ses_A')
  await rejects('another session cannot claim the reserved requirement', () => service.claim(next.id, {}, { session: 'ses_B', name: 'B' }), 'conflict')

  console.log('\ncompletion gate')
  await rejects('advance is refused while the checklist is incomplete', () => service.transitionRequirement(created.id, { action: 'advance' }, actor), 'completion-not-met')
  const ticked = await service.setChecklist(created.id, { index: 0, checked: true }, actor)
  check('one checklist entry ticks', ticked.flow[0].checks[0] === true && ticked.flow[0].checks[1] === false)
  await rejects('advance still refused with one entry left', () => service.transitionRequirement(created.id, { action: 'advance' }, actor), 'completion-not-met')
  await service.setChecklist(created.id, { index: 1, checked: true }, actor)

  console.log('\nadvance')
  const advanced = await service.transitionRequirement(created.id, { action: 'advance', note: '评审通过' }, actor)
  check('first node completes', advanced.flow[0].status === 'done' && advanced.flow[0].completedAt !== null)
  check('second node becomes active', advanced.nodeId === '评审' && advanced.flow[1].status === 'active')
  check('the write returns the receipt of the transition', advanced.lastTransition.action === 'advance' && advanced.lastTransition.from === '起草' && advanced.lastTransition.to === '评审')
  check('node duration is recorded', typeof advanced.lastTransition.durationMs === 'number')
  const revAfterAdvance = advanced.rev

  console.log('\nrollback')
  const rolled = await service.transitionRequirement(created.id, { action: 'rollback', to: '起草', note: '范围变了，重写' }, actor)
  check('rollback re-opens the earlier node', rolled.nodeId === '起草' && rolled.flow[0].status === 'active')
  check('downstream progress is cleared', rolled.flow[1].status === 'pending' && rolled.flow[1].completedAt === null)
  check('checklist is reset on the re-opened node', rolled.flow[0].checks.every(entry => entry === false))
  check('revision advanced', rolled.rev > revAfterAdvance)
  await rejects('rollback without a note is refused', () => service.transitionRequirement(created.id, { action: 'rollback', to: '评审' }, actor), 'invalid-transition')
  await rejects('rollback forward is refused', () => service.transitionRequirement(created.id, { action: 'rollback', to: '关闭', note: 'x' }, actor), 'invalid-transition')

  console.log('\noptimistic concurrency')
  const stale = await service.getRequirement(created.id)
  await service.updateRequirement(created.id, { owner: '李四' }, actor)
  await rejects('a stale expectedRev is refused', () => service.updateRequirement(created.id, { owner: '王五', expectedRev: stale.rev }, actor), 'conflict')

  console.log('\nserialized writes')
  const before = (await service.getRequirement(created.id)).rev
  await Promise.all(Array.from({ length: 12 }, (_, index) => service.updateRequirement(created.id, { labels: [`l${index}`] }, actor)))
  const after = await service.getRequirement(created.id)
  check('every concurrent update committed exactly once', after.rev === before + 12, `rev ${before} -> ${after.rev}`)
  check('no update was lost', after.labels.length === 1)

  console.log('\nblocking')
  const blocked = await service.blockRequirement(created.id, { reason: '等待上游接口' }, actor)
  check('requirement reports blocked with a reason', blocked.status === 'blocked' && blocked.blockReason === '等待上游接口')
  await rejects('advancing a blocked requirement is still gated', () => service.transitionRequirement(created.id, { action: 'advance' }, actor), 'completion-not-met')
  const unblocked = await service.unblockRequirement(created.id, {}, actor)
  check('unblock restores the active state', unblocked.status === 'active' && unblocked.blockReason === '')

  console.log('\ncompletion through the last node')
  await service.setChecklist(created.id, { index: 0, checked: true }, actor)
  await service.setChecklist(created.id, { index: 1, checked: true }, actor)
  await service.transitionRequirement(created.id, { action: 'advance', note: 'ok' }, actor)
  await service.transitionRequirement(created.id, { action: 'advance', note: '评审完成' }, actor)
  const finished = await service.transitionRequirement(created.id, { action: 'advance', note: '关闭' }, actor)
  const done = await service.getRequirement(created.id)
  check('the last advance finishes the requirement', done.status === 'done')
  check('every node reads done', done.flow.every(node => node.status === 'done'))
  check('progress is complete', done.progress.ratio === 1)
  // Finishing releases the lock (§5.1 step 5) and a done requirement cannot be
  // claimed again (§5.4 row 1), so reopening one is the human's move.
  check('completion releases the execution lock', done.lock === null)
  // §5.1 step 5: the receipt names the queue head; it takes that lock only when
  // the session asks, and completing released the reservation on the finished one.
  check('the completion receipt names the queue head without claiming it', finished.queueHead?.id === next.id && done.reservedBy === null)
  check('the queue head is still unlocked after the completion', (await service.getRequirement(next.id)).lock === null)
  check('statistics count the outstanding reservation', service.stats().queues === 1 && service.stats().queued === 1 && service.stats().reserved === 1)
  // Deleting the next requirement releases its reservation, so the sections below
  // describe one requirement again (§5.3).
  const dropped = await service.deleteRequirement(next.id, {}, { session: '', name: '面板' })
  check('deleting the reserved requirement releases the reservation', dropped.deleted === true && service.queueOf('ses_A').updatedAt === null)
  await rejects('a finished requirement cannot be claimed again', () => service.claim(created.id, {}, actor), 'invalid-state')
  // The lock gate answers first for a session, so the transition gate is
  // asserted through the panel, which needs no lock.
  await rejects('reopening is required before advancing a done requirement', () => service.transitionRequirement(created.id, { action: 'advance' }, { session: '', name: '面板' }), 'invalid-transition')

  console.log('\nstatistics')
  const stats = service.stats()
  check('completion rate counts the finished requirement', stats.completionRate === 1, String(stats.completionRate))
  check('per-node durations were aggregated', stats.nodeDurations.length >= 3, JSON.stringify(stats.nodeDurations.map(d => d.nodeId)))
  check('blocked list is empty after unblocking', stats.blocked.length === 0)
  check('statistics count the outstanding reservation', stats.queues === 0 && stats.queued === 0 && stats.reserved === 0)

  console.log('\nHTTP command dispatch')
  const dispatched = await dispatchBoardCommand(service, { action: 'list', session: 'ses_A' })
  check('the route dispatcher reaches the same service', dispatched.total === 1 && dispatched.items[0].id === created.id)
  const snapshot = await dispatchBoardCommand(service, { action: 'refresh', filter: { limit: 5 } })
  check('refresh returns a full snapshot', snapshot.requirements.length === 1 && snapshot.templates.length === 2)
  await rejects('unknown actions fail loud', () => dispatchBoardCommand(service, { action: 'nope' }), 'invalid-argument')
  // The browser sends the verb as `transition`; the dispatcher must reach the
  // same transition as the agent tool's `{ action }` input.
  const beforeReopen = await service.getRequirement(created.id)
  await dispatchBoardCommand(service, { action: 'transition', id: created.id, transition: 'reopen', expectedRev: beforeReopen.rev })
  const afterReopen = await service.getRequirement(created.id)
  check('the dispatcher accepts the browser transition verb', afterReopen.status === 'active' && afterReopen.history.at(-1).action === 'reopen', afterReopen.status)
  await rejects('the dispatcher refuses a stale browser revision', () => dispatchBoardCommand(service, { action: 'transition', id: created.id, transition: 'advance', expectedRev: 1 }), 'conflict')
  // `update` carries its fields under `patch`, so the dispatcher must lift
  // `expectedRev` out of the envelope rather than leave it behind.
  const beforeUpdate = await service.getRequirement(created.id)
  await rejects('the dispatcher honours expectedRev for update', () => dispatchBoardCommand(service, { action: 'update', id: created.id, patch: { owner: 'someone-else' }, expectedRev: 1 }), 'conflict')
  await dispatchBoardCommand(service, { action: 'update', id: created.id, patch: { owner: '张三' }, expectedRev: beforeUpdate.rev })
  const afterUpdate = await service.getRequirement(created.id)
  check('an up-to-date expectedRev is accepted for update', afterUpdate.owner === '张三' && afterUpdate.rev > beforeUpdate.rev)
  check('every presented requirement carries its last transition', afterUpdate.lastTransition?.action === 'reopen', JSON.stringify(afterUpdate.lastTransition?.action))

  console.log('\nimage upload and read route')
  const png = imageFixture('image/png', 3, 2)
  const uploaded = await requestBoardRoute(service, {
    method: 'POST',
    target: '/image?name=%E8%B4%B4%E5%9B%BE.png',
    headers: { 'content-type': 'image/png; charset=binary' },
    body: png,
  })
  const ref = uploaded.json?.data?.image
  check('an upload answers the stored ref', uploaded.status === 200 && uploaded.json?.ok === true && typeof ref?.id === 'string', JSON.stringify(uploaded.json))
  check('the ref is the whole wire contract and nothing more', Object.keys(ref ?? {}).sort().join(',') === 'byteLength,createdAt,height,id,mediaType,name,width', Object.keys(ref ?? {}).join(','))
  check('the ref names a durable id, not a location', /^img-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref?.id ?? ''), String(ref?.id))
  check('the ref keeps the request name and media type', ref?.name === '贴图.png' && ref?.mediaType === 'image/png', `${ref?.name} ${ref?.mediaType}`)
  check('the ref records the encoded size', ref?.width === 3 && ref?.height === 2 && ref?.byteLength === png.length, JSON.stringify({ width: ref?.width, height: ref?.height, byteLength: ref?.byteLength }))
  check('no base64 rides the response', !JSON.stringify(uploaded.json).includes('base64'))

  const fetched = await requestBoardRoute(service, { target: `/image/${ref.id}` })
  check('a fetch returns the identical bytes', fetched.status === 200 && fetched.bytes.equals(png), `${fetched.status} ${fetched.bytes.length}`)
  check('and the stored content type', fetched.contentType === 'image/png', fetched.contentType)

  const missing = await requestBoardRoute(service, { target: '/image/img-00000000-0000-0000-0000-000000000000' })
  check('an unknown image id is a JSON 404', missing.status === 404 && missing.json?.ok === false && missing.json?.error?.code === 'not-found', `${missing.status} ${JSON.stringify(missing.json)}`)

  const refusedType = await requestBoardRoute(service, {
    method: 'POST',
    target: '/image',
    headers: { 'content-type': 'image/bmp' },
    body: Buffer.from('BM'),
  })
  check('a refused media type fails loud', refusedType.status === 415 && refusedType.json?.error?.code === 'unsupported-media-type', `${refusedType.status} ${JSON.stringify(refusedType.json)}`)
  const oversized = await requestBoardRoute(service, {
    method: 'POST',
    target: '/image',
    headers: { 'content-type': 'image/png' },
    body: Buffer.alloc(IMAGE_MAX_BYTES + 1),
  })
  check('an oversized body fails loud', oversized.status === 413 && oversized.json?.error?.code === 'image-too-large', `${oversized.status} ${JSON.stringify(oversized.json)}`)
  await rejects('an empty upload is refused', () => service.storeImage({ bytes: Buffer.alloc(0), mediaType: 'image/png' }), 'invalid-image')

  console.log('\nimages through the tools and the command body')
  const toolSpecs = []
  registerTools({ tools: { register: spec => { toolSpecs.push(spec); return () => {} } } }, service)
  const boardTool = toolSpecs.find(spec => spec.name === 'requirement_board')
  check('the board tool declares the images input', boardTool.parameters.properties.images?.type === 'array' && boardTool.parameters.properties.images?.items?.type === 'string')
  check('and its description tells the model where the bytes are', boardTool.description.includes('`path`') && boardTool.description.includes('invalid-image'))

  const attached = await service.updateRequirement(created.id, { images: [ref.id] }, actor)
  check('update attaches the stored ref', attached.images.length === 1 && attached.images[0].id === ref.id)
  const viaTool = await boardTool.execute({ action: 'get', id: created.id }, { agent: { id: 'ses_A' } })
  check('the tool result points at the image route', viaTool.images[0]?.url === `/api/requirement-board/image/${ref.id}`, String(viaTool.images[0]?.url))
  check('and at the absolute file on disk', viaTool.images[0]?.path === service.imageFilePath(ref) && (await readFile(viaTool.images[0].path)).equals(png), String(viaTool.images[0]?.path))
  const toolList = await boardTool.execute({ action: 'list' }, { agent: { id: 'ses_A' } })
  check('a listed requirement carries the same locations', toolList.items.find(item => item.id === created.id)?.images[0]?.path === viaTool.images[0].path)

  const viaCommand = await dispatchBoardCommand(service, { action: 'update', id: created.id, patch: { images: [ref.id] } })
  check('the command body accepts image ids under patch', viaCommand.images[0]?.id === ref.id)
  const createdWithImage = await dispatchBoardCommand(service, { action: 'create', summary: '测试简述', title: '面板新建', images: [ref.id], session: 'ses_A' })
  check('the command body accepts image ids on create', createdWithImage.images.length === 1 && createdWithImage.images[0].id === ref.id)
  await rejects('the command body refuses an unknown id', () => dispatchBoardCommand(service, { action: 'create', summary: '测试简述', title: 'x', images: ['nope'], session: 'ses_A' }), 'invalid-image')

  console.log('\nprompt context')
  const mine = service.promptContext('ses_A', 12)
  check('the owning session sees its requirement', mine.includes(created.id) && mine.includes('跨会话看板'))
  check('the text is fenced', mine.startsWith('<requirement-board>') && mine.endsWith('</requirement-board>'))
  check('an empty queue adds no queue section', !mine.includes('Your queue'))
  await service.updateRequirement(created.id, { sessions: ['ses_B'] }, actor)
  const other = service.promptContext('ses_B', 12)
  check('another session sees the same requirement after a write', other.includes(created.id))
  check('an unrelated session still gets the shared board', service.promptContext('ses_C', 12).includes('Shared requirement board'))

  console.log('\nchanges feed')
  const changes = service.changesSince(new Date(Date.now() - 60_000).toISOString())
  check('changes names the touched requirement', changes.requirements.some(item => item.id === created.id))
  check('changes retains transitions', changes.transitions.length > 0)

  console.log('\ntemplate lifecycle')
  await rejects('a bound template refuses deletion by default', () => service.deleteTemplate('tpl-custom', {}), 'in-use')
  await rejects('the built-in template cannot be deleted', () => service.deleteTemplate('tpl-standard', { force: true }), 'invalid-transition')
  await service.deleteTemplate('tpl-custom', { force: true })
  check('rebound requirements fall back to the default template', service.getRequirement(created.id).templateId === 'tpl-standard')
  await rejects('a malformed template fails loud', () => service.createTemplate({ name: 'x', nodes: [{ name: 'a', dependsOn: ['missing'] }] }, actor), 'invalid-argument')
  await rejects('a dependency cycle fails loud', () => service.createTemplate({ name: 'x', nodes: [{ name: 'a', id: 'a', dependsOn: ['b'] }, { name: 'b', id: 'b', dependsOn: ['a'] }] }, actor), 'invalid-argument')

  console.log('\ndurability')
  const raw = JSON.parse(await readFile(mediumPath('json', dir), 'utf8'))
  check('the unit carries the domain version and fold version', raw.unit.version === 2 && raw.global.schemaVersion === 2, JSON.stringify({ unit: raw.unit, fold: raw.global?.schemaVersion }))
  // The command-body create above is the second requirement; the image-bearing
  // one is `created`, whose refs must sit in the unit while its bytes do not.
  check('the unit holds every requirement record', Object.keys(raw.tables.requirements).length === 2, String(Object.keys(raw.tables.requirements).length))
  const storedImages = raw.tables.requirements[created.id].images
  check('the medium stores the ref rather than the bytes', storedImages?.[0]?.id === ref.id && storedImages?.[0]?.byteLength === png.length && !JSON.stringify(raw).includes(png.toString('base64')), JSON.stringify(storedImages))
  await board.close()
  reopened = await openBoard({ backend: 'json', dir, config })
  check('a fresh open reads the same board', reopened.service.getRequirement(created.id).title === '跨会话看板')
  check('and reads the same image refs', reopened.service.getRequirement(created.id).images[0]?.id === ref.id)
} finally {
  await board?.close()
  await reopened?.close()
  await removeTempDir(dir)
}

process.exit(reporter.finish() ? 0 : 1)
