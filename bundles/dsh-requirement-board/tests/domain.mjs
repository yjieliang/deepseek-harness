/**
 * Durable-layer cases for the Requirement Board, run against every backend the
 * harness can construct.
 *
 * These exercise behaviour the old self-managed JSON store could not offer:
 * schema enforcement at the durable read, compare-and-set inside the platform's
 * write chain, a version-stamped medium, and a one-time legacy import. The last
 * group covers the storage-open failure path that the plugin's activation must
 * surface instead of swallowing.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { requirementBoardDomain, exportLegacyDocument, healRevision, nextRevision } from '../host/domain.js'
import { resolveConfig } from '../host/config.js'
import { apply, forwardDomainChange } from '../index.js'
import {
  BACKENDS,
  boardService,
  createApplyContext,
  createReporter,
  imageFixture,
  makeTempDir,
  openBoard,
  openRawBoard,
  pathExists,
  removeTempDir,
} from './harness.mjs'

const reporter = createReporter()
const { check } = reporter
const actor = { session: 'ses_test', name: '测试' }

/**
 * Run one case for one backend.
 * @param backend - `json` or `sqlite`.
 * @param name - Case name, printed as a heading.
 * @param body - Case body receiving a fresh temporary directory.
 */
async function onBackend(backend, name, body) {
  const dir = await makeTempDir(`rb-${backend}-`)
  console.log(`\n[${backend}] ${name}`)
  try {
    await body(dir)
  } finally {
    await removeTempDir(dir)
  }
}

/** A facility whose backend cannot be resolved, exercising the real open failure path. */
function unroutableFacility() {
  const ctx = {
    storage: {
      backend: {
        get: requested => {
          throw Object.assign(new Error(`storage backend "${requested}" is not registered`), { code: 'backend-not-found' })
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    emit() {},
  }
  return new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
}

/** A corruption case: a record the schema cannot parse stops the open. */
async function caseInvalidRecord(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const created = await board.service.createRequirement({ summary: '测试简述', title: '合法记录' }, actor)
    // Writes are not re-validated by the platform, so a truncated record can be
    // stored; the next open is what refuses it.
    const stored = board.domain.table('requirements').get(created.id)
    await board.domain.table('requirements').put(created.id, { ...stored, title: undefined })
    await board.close()

    const error = await reporter.rejects('an unparsable record refuses to open', () => openRawBoard({ backend, dir }), 'invalid-record')
    check('the failure names the offending table and key', error?.detail?.table === 'requirements' && error?.detail?.key === created.id, JSON.stringify(error?.detail))
  })
}

/**
 * A stored `kind` outside the declared set refuses the open, and the failure says
 * which field and which value did it.
 *
 * The refusal is the design (the value can only come from a medium edited outside
 * the plugin, and reading it as a task would reinterpret stored data), so the only
 * thing a person can act on is the diagnosis: the platform's message names the
 * table and key, and the schema's issue names the field.
 */
async function caseUnknownKindDiagnostic(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const created = await board.service.createRequirement({ summary: '测试简述', title: '未知 kind' }, actor)
    const table = board.domain.table('requirements')
    await table.put(created.id, { ...table.get(created.id), kind: 'epic' })
    await board.close()

    const error = await reporter.rejects('a kind outside the declared set refuses to open', () => reopenThroughPlugin(backend, dir), 'invalid-record')
    // Read what the operator reads: the thrown error's own message and detail.
    // The zod issues live in `cause`, and an assertion that read them would pass
    // even when the boot log names nothing.
    const shown = `${String(error?.message ?? '')} ${JSON.stringify(error?.detail ?? {})}`
    check('the refusal names the field it could not read', shown.includes('kind'), shown.slice(0, 240))
    check('and the value it received', shown.includes('epic'), shown.slice(0, 240))
    check('the detail carries the field and the value for a log', error?.detail?.field === 'kind' && error?.detail?.received === 'epic', JSON.stringify(error?.detail))
    check('the location still names the table and key', error?.detail?.table === 'requirements' && error?.detail?.key === created.id, JSON.stringify(error?.detail))
  })
}

/**
 * Reopen a medium the way the plugin does: a real facility behind the plugin's own
 * open step, driven through `apply`.
 *
 * `openRawBoard` calls the facility directly and so never reaches the board's open
 * step; the diagnosis an operator sees comes from `apply`, which is what this
 * reproduces.
 * @param backend - Backend name from {@link BACKENDS}.
 * @param dir - Directory holding the medium.
 * @returns resolution after activation.
 */
async function reopenThroughPlugin(backend, dir) {
  const impl = backend === 'sqlite'
    ? new (await import('@deepseek-ai/dsh-storage-sqlite')).SqliteStorageBackend({ path: join(dir, 'board.db'), journalMode: 'wal' })
    : new JsonStorageBackend(dir)
  const facilityCtx = {
    storage: { backend: { get: requested => {
      if (requested !== backend) throw new Error(`the case context has no backend "${requested}"`)
      return impl
    } } },
    logger: { info() {}, warn() {}, error() {} },
    emit() {},
  }
  const facility = new DomainFacility(facilityCtx, { backend, routes: {} })
  const mounted = createApplyContext({ open: name => facility.open(name) })
  try {
    await apply(mounted.ctx, resolveConfig({ importLegacy: false }))
  } finally {
    try {
      await impl.close?.()
    } catch {
      // Closing a medium the open refused can fail because the adapter is already
      // half-released; the case's temporary directory is removed regardless.
    }
  }
}

/** A record carrying fields the schema does not declare is refused too. */
async function caseUndeclaredFields(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const created = await board.service.createRequirement({ summary: '测试简述', title: '派生字段' }, actor)
    const stored = board.domain.table('requirements').get(created.id)
    // `flow`/`progress` are derived views and must never reach the medium.
    await board.domain.table('requirements').put(created.id, { ...stored, flow: [], progress: {} })
    await board.close()
    await reporter.rejects('a record carrying derived fields refuses to open', () => openRawBoard({ backend, dir }), 'invalid-record')
  })
}

/** Compare-and-set must run inside the write chain, not before it queues. */
async function caseExpectedRev(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const created = await board.service.createRequirement({ summary: '测试简述', title: '并发' }, actor)
    const stale = created.rev
    await board.service.updateRequirement(created.id, { owner: '甲' }, actor)
    await reporter.rejects('a stale expectedRev is refused', () => board.service.updateRequirement(created.id, { owner: '乙', expectedRev: stale }, actor), 'conflict')
    check('the refused write left the record untouched', (await board.service.getRequirement(created.id)).owner === '甲')

    const base = (await board.service.getRequirement(created.id)).rev
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => board.service.updateRequirement(created.id, { owner: `并发${index}`, expectedRev: base }, actor)),
    )
    const won = attempts.filter(attempt => attempt.status === 'fulfilled')
    const lost = attempts.filter(attempt => attempt.status === 'rejected')
    check('exactly one racer with the same expectedRev commits', won.length === 1, `won=${won.length}`)
    check('every other racer is refused with a conflict', lost.length === 7 && lost.every(attempt => attempt.reason?.code === 'conflict'))
    check('the record advanced by exactly one revision', (await board.service.getRequirement(created.id)).rev === base + 1)
    await board.close()
  })
}

/** The legacy import runs once, guarded by a receipt on the medium. */
async function caseImportOnce(backend, name) {
  await onBackend(backend, name, async dir => {
    const sourceDir = await makeTempDir(`rb-${backend}-src-`)
    try {
      const source = await openBoard({ backend, dir: sourceDir })
      const created = await source.service.createRequirement({ summary: '测试简述', title: '迁移前需求' }, actor)
      await source.service.createTemplate({ id: 'tpl-custom', name: '自定义', nodes: [{ name: '唯一' }] }, actor)
      const document = exportLegacyDocument(source.domain)
      await source.close()

      const legacyPath = join(dir, 'requirement-board.json')
      await writeFile(legacyPath, JSON.stringify(document, null, 2))

      const first = await openBoard({ backend, dir, importLegacy: true, legacyPath })
      check('the legacy requirement was imported', first.service.getRequirement(created.id).title === '迁移前需求')
      check('the legacy template was imported', first.service.getTemplate('tpl-custom').nodes.length === 1)
      const importedCount = first.domain.global.get().imported?.count
      check('the import receipt records how many records moved', importedCount === 3, `count=${importedCount}`)
      await first.close()
      check('the consumed document was renamed aside', !pathExists(legacyPath) && pathExists(`${legacyPath}.migrated`))

      // Restore the document at its original path: the receipt, not the file's
      // absence, is what must prevent a replay.
      await writeFile(legacyPath, JSON.stringify(document, null, 2))
      const second = await openBoard({ backend, dir, importLegacy: true, legacyPath })
      check('a second start imports nothing', second.domain.global.get().imported?.count === importedCount)
      check('a second start leaves the records unchanged', second.domain.table('requirements').size === 1 && second.domain.table('templates').size === 2)
      await second.close()
    } finally {
      await removeTempDir(sourceDir)
    }
  })
}

/** With the switch off, a present legacy document is untouched. */
async function caseImportOff(backend, name) {
  await onBackend(backend, name, async dir => {
    const legacyPath = join(dir, 'requirement-board.json')
    await writeFile(legacyPath, JSON.stringify({ schemaVersion: 1, revision: 0, templates: {}, requirements: {} }))
    const board = await openBoard({ backend, dir, importLegacy: false, legacyPath })
    check('the default config keeps the import off', resolveConfig({}).importLegacy === false)
    check('nothing was imported', board.domain.table('requirements').size === 0 && board.domain.global.get().imported === undefined)
    check('the legacy document is left in place', pathExists(legacyPath))
    await board.close()
  })
}

/** A document at an unsupported fold version fails loud rather than being skipped. */
async function caseImportUnsupported(backend, name) {
  await onBackend(backend, name, async dir => {
    const legacyPath = join(dir, 'requirement-board.json')
    await writeFile(legacyPath, JSON.stringify({ schemaVersion: 7, revision: 0, templates: {}, requirements: {} }))
    const error = await reporter.rejects('an unsupported legacy version fails loud', () => openBoard({ backend, dir, importLegacy: true, legacyPath }), 'unsupported-legacy-version')
    check('the failure names the supported version', error?.details?.supported === 1 && error?.details?.found === 7, JSON.stringify(error?.details))
    check('and its message says what it received', String(error?.message ?? '').includes('7'), String(error?.message ?? ''))
  })
}

/** A board that already holds records without an import receipt is reported, not passed over. */
async function caseImportWithoutReceipt(backend, name) {
  await onBackend(backend, name, async dir => {
    const legacyPath = join(dir, 'requirement-board.json')
    const first = await openBoard({ backend, dir })
    await first.service.createRequirement({ summary: '测试简述', title: '半导入的看板' }, actor)
    await first.close()
    await writeFile(legacyPath, JSON.stringify({ schemaVersion: 1, revision: 0, templates: {}, requirements: {} }))

    const board = await openBoard({ backend, dir, importLegacy: true, legacyPath })
    const warnings = board.logger.lines.warn
    check('a non-empty board with no receipt reports the skipped import', warnings.length === 1, warnings.join(' | '))
    check('the report names the legacy path', warnings[0]?.includes(legacyPath) === true, warnings[0] ?? '')
    check('the report names the interrupted-import state', warnings[0]?.includes('interrupted one-time import') === true, warnings[0] ?? '')
    check('no import receipt was written', board.domain.global.get().imported === undefined)
    check('the legacy document was left in place', pathExists(legacyPath))
    check('the stored records were not touched', board.domain.table('requirements').size === 1)
    await board.close()
  })
}

/** The global revision self-heals to the highest stored record revision. */
async function caseRevisionHealing(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const first = await board.service.createRequirement({ summary: '测试简述', title: 'a' }, actor)
    const second = await board.service.createRequirement({ summary: '测试简述', title: 'b' }, actor)
    await board.service.updateRequirement(second.id, { owner: 'x' }, actor)
    // Fresh records carry rev 1 and one update makes 2; the document revision is
    // ahead at 3 because every committed write advanced it.
    const recordHighest = Math.max(...[...board.domain.table('requirements').entries()].map(([, record]) => record.rev))
    check('the fresh records stop at revision 2', recordHighest === 2, `recordHighest=${recordHighest}`)
    check('the document revision leads the records', nextRevision(board.domain) === 3, `next=${nextRevision(board.domain)}`)

    await board.domain.global.set({ ...board.domain.global.get(), revision: 0 })
    check('the stored global was trailed on purpose', board.domain.global.get().revision === 0)
    const healed = await healRevision(board.domain)
    check('a trailing global is raised to the highest record revision', healed === recordHighest && board.domain.global.get().revision === recordHighest)
    check('the healed revision is what the self-heal anchor reports', nextRevision(board.domain) === recordHighest)

    await board.domain.global.set({ ...board.domain.global.get(), revision: recordHighest + 50 })
    check('a global ahead of the records is never lowered', await healRevision(board.domain) === recordHighest + 50)
    check('a service built later adopts the stored revision', boardService(board.domain).snapshot().revision === recordHighest + 50)
    check('the requirements survived the revision repair', (await board.service.getRequirement(first.id)).title === 'a')
    await board.close()
  })
}

/** Only this board's own domain changes reach the subscribers. */
async function caseChangeForwarding(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const frames = []
    const unsubscribe = board.service.subscribe(frame => frames.push(frame))
    const created = await board.service.createRequirement({ summary: '测试简述', title: '事件' }, actor)
    check('a committed write emitted a domain change', board.changes.length > 0)
    check('the change names this domain', board.changes.every(change => change.domain === requirementBoardDomain.name))

    const forwarded = board.changes.filter(change => change.operation !== undefined || change.table !== undefined)
    for (const change of forwarded) forwardDomainChange(change, board.service)
    forwardDomainChange({ domain: 'workspace', table: 'workspaces', key: 'w1', operation: 'put' }, board.service)
    check('the board change reached the subscribers', frames.some(frame => frame.table === 'requirements' && frame.key === created.id))
    check('a foreign domain change was not forwarded', frames.length === forwarded.length)
    check('the frame carries the table, key, and operation', frames.every(frame => typeof frame.table === 'string' && typeof frame.key === 'string' && typeof frame.operation === 'string'))
    unsubscribe()
    const before = frames.length
    await board.service.updateRequirement(created.id, { owner: 'zz' }, actor)
    for (const change of board.changes) forwardDomainChange(change, board.service)
    check('an unsubscribed listener stops receiving frames', frames.length === before)
    await board.close()
  })
}

/** A failed storage open must fail activation, not vanish. */
async function caseLoudMountFailure() {
  console.log('\n[both] loud mount failure')
  const { ctx, effects, listeners } = createApplyContext(unroutableFacility())
  const error = await reporter.rejects('an unroutable backend fails the entry', () => apply(ctx, resolveConfig({})), 'backend-not-found')
  check('the failure is the storage failure itself', String(error?.message).includes('not registered'))
  check('a failed mount registers no effect', effects.length === 0, effects.join(','))
  check('a failed mount registers no domain listener', listeners.length === 0)

  const rejecting = createApplyContext({ open: async () => { throw Object.assign(new Error('disk on fire'), { code: 'storage-unavailable' }) } })
  await reporter.rejects('a rejected storage open fails the entry', () => apply(rejecting.ctx, resolveConfig({})), 'storage-unavailable')
  check('a rejected open also registers nothing', rejecting.effects.length === 0 && rejecting.listeners.length === 0)
}

/** A legacy-only config key is refused by name. */
async function caseRemovedConfig() {
  console.log('\n[both] removed config keys')
  await reporter.rejects('a legacy dataDir is refused', () => resolveConfig({ dataDir: '/tmp/board' }), 'invalid-config')
  await reporter.rejects('a legacy documentPath is refused', () => resolveConfig({ documentPath: '/tmp/board.json' }), 'invalid-config')
  await reporter.rejects('a non-object config is refused', () => resolveConfig([]), 'invalid-config')
  const resolved = resolveConfig({ importLegacy: true, stallAfterHours: 24 })
  check('the surviving keys still resolve', resolved.importLegacy === true && resolved.stallAfterHours === 24 && resolved.defaultTemplateId === 'tpl-standard')
}

/**
 * Pasted-image refs at the durable read.
 *
 * `images` was added to the record without raising the version, so this case
 * proves both halves of that decision: a record written before the field existed
 * — no `images` key at all — still opens and reads as one carrying no images, and
 * a record that carries refs reads the identical refs back after a reopen. The
 * stamp is asserted at 2 because raising it would make the platform refuse the
 * user's stored board outright (exact-equality comparison, no `compatibleVersions`).
 */
async function caseImagesAreAdditive(backend, name) {
  await onBackend(backend, name, async dir => {
    const config = resolveConfig({ imageDir: join(dir, 'images') })
    const board = await openBoard({ backend, dir, config })
    const service = board.service
    const first = await service.storeImage({ bytes: imageFixture('image/png', 2, 3), mediaType: 'image/png', name: 'a.png' })
    const second = await service.storeImage({ bytes: imageFixture('image/gif', 4, 5), mediaType: 'image/gif' })
    const created = await service.createRequirement({ summary: '测试简述', title: '带图需求', images: [first.id, second.id] }, actor)
    const plain = await service.createRequirement({ summary: '测试简述', title: '无图需求' }, actor)

    check('an upload records the encoded size and the original name', first.width === 2 && first.height === 3 && first.name === 'a.png' && first.byteLength > 0, JSON.stringify(first))
    check('an unnamed upload stores an empty name and its media type', second.name === '' && second.mediaType === 'image/gif')
    check('create persists the refs in the order given', created.images.map(ref => ref.id).join(',') === `${first.id},${second.id}`)
    check('a requirement created without images reads an empty list', plain.images.length === 0)

    // A record written by the build before images existed has no such key; the
    // durable read must accept it and every reader default it to `[]`.
    const table = board.domain.table('requirements')
    const { images, ...older } = table.get(plain.id)
    void images
    await table.put(plain.id, older)
    check('the stored record was seeded without the images key', table.get(plain.id).images === undefined)
    check('the version stamp stays 2 for this additive field', board.domain.global.get().schemaVersion === 2)
    await board.close()

    const reopened = await openBoard({ backend, dir, config })
    const olderRead = await reopened.service.getRequirement(plain.id)
    const withImages = await reopened.service.getRequirement(created.id)
    check('a record written before images existed still opens', olderRead.title === '无图需求')
    check('and reads back with an empty image list', Array.isArray(olderRead.images) && olderRead.images.length === 0)
    check('the refs round-trip through the medium unchanged', JSON.stringify(withImages.images) === JSON.stringify([first, second]), JSON.stringify(withImages.images))
    check('the listed requirement carries the same refs', reopened.service.listRequirements({}, '').items.find(item => item.id === created.id)?.images.length === 2)

    // Deleting the record leaves the immutable files in place: another record may
    // name the same image id, so files are never removed with a record.
    await reopened.service.deleteRequirement(created.id, {}, { session: '', name: '面板' })
    check('deleting a requirement leaves its image files on disk', pathExists(reopened.service.imageFilePath(first)) && pathExists(reopened.service.imageFilePath(second)))
    check('the deleted requirement is gone from the board', (await reopened.service.listRequirements({}, '')).items.every(item => item.id !== created.id))
    await reopened.close()
  })
}

/**
 * The brief joined the record the way `images` did: an optional read, because
 * every board written before it carries no such key, while the write path
 * requires a value. This case deletes the key from a stored record and reopens
 * the board, which is exactly what an earlier build left on disk.
 */
async function caseSummaryIsAdditive(backend, name) {
  await onBackend(backend, name, async dir => {
    const board = await openBoard({ backend, dir })
    const service = board.service
    const plain = await service.createRequirement({ summary: '先写一条带简述的需求。', title: '无简述需求' }, actor)
    const table = board.domain.table('requirements')
    const { summary, ...older } = table.get(plain.id)
    void summary
    await table.put(plain.id, older)
    check('the stored record was seeded without the summary key', table.get(plain.id).summary === undefined)
    check('the version stamp stays 2 for this additive field', board.domain.global.get().schemaVersion === 2)
    await board.close()

    const reopened = await openBoard({ backend, dir })
    const olderRead = await reopened.service.getRequirement(plain.id)
    check('a record written before the brief existed still opens', olderRead.title === '无简述需求' && olderRead.summary === '')
    check('the listed requirement reads the same empty brief',
      reopened.service.listRequirements({}, '').items.find(item => item.id === plain.id)?.summary === '')
    // A write that carries the field still states one, so an older record can be
    // filled in but never cleared back to the empty reading.
    await reporter.rejects('an update cannot empty the brief', () => reopened.service.updateRequirement(plain.id, { summary: '' }, actor), 'invalid-argument')
    const filled = await reopened.service.updateRequirement(plain.id, { summary: '补一句大白话。' }, actor)
    check('an older record accepts a brief it never had', filled.summary === '补一句大白话。')
    await reopened.close()
  })
}

for (const backend of BACKENDS) {
  await caseInvalidRecord(backend, 'schema enforcement at open')
  await caseUnknownKindDiagnostic(backend, 'an unreadable kind names the field it broke on')
  await caseUndeclaredFields(backend, 'derived fields are not persisted')
  await caseExpectedRev(backend, 'compare-and-set in the write chain')
  await caseImportOnce(backend, 'legacy import runs once')
  await caseImportOff(backend, 'legacy import is off by default')
  await caseImportUnsupported(backend, 'unsupported legacy version')
  await caseImportWithoutReceipt(backend, 'a non-empty board with no import receipt')
  await caseRevisionHealing(backend, 'document revision self-heals')
  await caseChangeForwarding(backend, 'domain change forwarding')
  await caseImagesAreAdditive(backend, 'pasted images are additive at the durable read')
  await caseSummaryIsAdditive(backend, 'the brief is additive at the durable read')
}

await caseLoudMountFailure()
await caseRemovedConfig()

process.exit(reporter.finish() ? 0 : 1)
