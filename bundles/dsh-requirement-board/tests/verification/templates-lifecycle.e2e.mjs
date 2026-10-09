#!/usr/bin/env node
/**
 * Requirement Board — real-browser template lifecycle gate (`DESIGN.md` §11.9).
 *
 * §11.9 asks the browser gate for the migration dialog, the disabled prune on a
 * pinned revision, and the version history list; `panel-render.e2e.mjs` already
 * covers those three. This instrument walks the whole lifecycle a person performs
 * on one template, in one browser session, and asserts the Host's own records at
 * each step:
 *
 *   clone a built-in template (UI) → create two requirements on it (UI) →
 *   tick one checklist entry → append a version (UI: rename the first node, drop
 *   the last one) → the running requirements' node/ticks/history/rev/flow are
 *   field-for-field unchanged while the template moves to revision 2 →
 *   migrate ONE requirement (migration dialog: read the impact, unpick the
 *   other, confirm) and assert it now derives revision 2 →
 *   pruning revision 1 is refused (the panel disables it and names the holder;
 *   the gate also provokes the same refusal on the wire) →
 *   migrate the remaining requirement, then prune revision 1 (UI) and assert
 *   `versions` lost exactly one entry → archive (UI): out of the default list,
 *   still readable, and no longer offered by the create dialog's selector →
 *   delete is refused for a template still in use (the panel lists the holders
 *   and arms a second confirmation without sending anything) and for the built-in
 *   template (the Host refuses, the panel shows the reason).
 *
 * Usage (an instance must already be listening):
 *   node tests/verification/templates-lifecycle.e2e.mjs http://127.0.0.1:3110 <boot-token>
 *   RB_SESSION_COOKIE='dsh-auth-…=v1.…' node … http://127.0.0.1:3080 cookie
 * The cookie form suits a deployment whose start-up token is gone: a valid
 * session cookie authorizes the index request whatever the query token says,
 * so the third argument then only has to be non-empty.
 *
 * **This gate writes.** Prefer a temporary development instance whose board it
 * may write; against a deployment in use, run it only with that board's owner
 * consent. It touches nothing but the template it clones and the requirements it
 * seeds, and it deletes them again.
 *
 * Console refusals: a 4xx is logged by the browser as a console error, so "zero
 * errors" is not an honest target. The claim made here is narrower and checkable:
 * every refused command is one this instrument deliberately provoked — the two
 * migration reads (whose refusal *is* how the impact list arrives), the prune of
 * a still-pinned revision, and the built-in delete.
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const base = (process.argv[2] ?? '').replace(/\/$/u, '')
const token = process.argv[3] ?? process.env.DSH_BOARD_TOKEN ?? ''
if (base === '' || token === '') {
  console.error('templates-lifecycle: needs a base URL and a non-empty token (a boot token, or any placeholder with RB_SESSION_COOKIE)')
  process.exit(2)
}

const require = createRequire(fileURLToPath(new URL('../../../../apps/web/package.json', import.meta.url)))
const playwright = await import(pathToFileURL(require.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default?.chromium

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${String(detail).slice(0, 200)}`}`)
}

const browser = await chromium.launch()
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const consoleErrors = []
/** Every refused board command: `{ action, code, status }`. */
const refusals = []
/** The board command bodies this page sent, for the panel's own session id. */
let panelSession = ''
page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`))
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('request', request => {
  if (!request.url().includes('/api/requirement-board/command')) return
  try {
    const body = JSON.parse(request.postData() ?? '{}')
    if (typeof body.session === 'string' && body.session !== '') panelSession = body.session
  } catch { /* a body this gate does not need */ }
})
page.on('response', async response => {
  if (!response.url().includes('/api/requirement-board/command') || response.status() < 400) return
  const body = await response.json().catch(() => null)
  let action = ''
  try {
    action = JSON.parse(response.request().postData() ?? '{}').action ?? ''
  } catch { /* a body this gate does not need */ }
  refusals.push({ status: response.status(), action, code: body?.error?.code ?? '' })
})

/**
 * Click a control inside the drawer or a dialog.
 *
 * The drawer's edit form is taller than its scroll container, so Playwright's own
 * "scroll into view" refuses to act on the controls at its bottom. Scrolling the
 * element itself and falling back to a DOM click keeps the gate driving the real
 * component; every click is verified by the assertions that follow it.
 */
const clickLocator = async (locator, options = {}) => {
  const target = locator.first()
  await target.evaluate(element => element.scrollIntoView({ block: 'center' })).catch(() => {})
  await page.waitForTimeout(150)
  try {
    await target.click({ timeout: 6000, ...options })
  } catch {
    await target.evaluate(element => element.click())
  }
  return target
}

/** Type into a real input, with a React-compatible fallback for an off-screen one. */
const fillLocator = async (locator, value) => {
  const target = locator.first()
  await target.evaluate(element => element.scrollIntoView({ block: 'center' })).catch(() => {})
  try {
    await target.fill(value, { timeout: 6000 })
  } catch {
    await target.evaluate((element, next) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(element, next)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }, value)
  }
}

/** One board command, answered as `{ status, ok, data, code, message }`. */
const wire = async payload => page.evaluate(async body => {
  const response = await fetch('/api/requirement-board/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = await response.json().catch(() => null)
  return {
    status: response.status,
    ok: parsed?.ok === true,
    data: parsed?.data ?? null,
    code: parsed?.error?.code ?? '',
    message: parsed?.error?.message ?? '',
  }
}, payload)

/** The panel's own snapshot, which is what its renders read. */
const snapshot = async () => page.evaluate(async () => {
  const response = await fetch('/api/requirement-board/snapshot?limit=200')
  const parsed = await response.json().catch(() => null)
  return parsed?.data ?? null
})

const reloadAndMount = async () => {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(7000)
  await clickLocator(page.locator('[aria-label*="需求"], [aria-label*="Requirement"]').first())
  await page.waitForTimeout(2500)
}
const openDrawer = async () => {
  await clickLocator(page.locator('.rb-root button:visible', { hasText: /流程模板管理|Templates/ }).first())
  await page.waitForTimeout(1800)
}
const closeDrawer = async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ((await page.locator('.rb-dialog-drawer').count()) === 0) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
  }
}
/** The drawer's list column, where an archived template must disappear. */
const listColumn = () => page.locator('.rb-dialog-drawer .rb-drawer-list')
/** Turn the drawer's own "include archived" filter on, so a shelved row can be picked. */
const showArchived = async () => {
  const box = page.locator('.rb-dialog-drawer .rb-drawer-filter input[type="checkbox"]').first()
  if (!(await box.isChecked().catch(() => false))) await clickLocator(box, { force: true })
  await page.waitForTimeout(1800)
}
const pickRow = async name => {
  await clickLocator(listColumn().locator('.rb-template-row', { hasText: name }).first())
  await page.waitForTimeout(1600)
}
const dialog = () => page.locator('[role="dialog"]').last()
/** The fields a running requirement owns; a template edit must leave them byte-identical. */
const owned = view => JSON.stringify({
  nodeId: view.nodeId,
  nodes: view.nodes,
  history: view.history,
  rev: view.rev,
  flow: view.flow,
  progress: view.progress,
  templateRevision: view.templateRevision,
  status: view.status,
})

const probe = `生命周期门 ${Date.now()}`
const migrateTitle = `${probe} · 迁移`
const keepTitle = `${probe} · 保留`
const renamedFirstNode = '需求评审·v2'

/* ------------------------------------------------------------------ boot */

// A deployment's browser credential is a session cookie, not the start-up
// token: a valid cookie authorizes the index request whatever the query token
// says, so `token` is then only a placeholder.
const sessionCookie = process.env.RB_SESSION_COOKIE ?? ''
if (sessionCookie !== '') {
  const at = sessionCookie.indexOf('=')
  if (at <= 0) {
    console.error('templates-lifecycle: RB_SESSION_COOKIE must be a name=value pair')
    process.exit(2)
  }
  await context.addCookies([{
    name: sessionCookie.slice(0, at),
    value: sessionCookie.slice(at + 1),
    url: base,
    httpOnly: true,
    sameSite: 'Strict',
  }])
}

await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)
await clickLocator(page.locator('[aria-label*="需求"], [aria-label*="Requirement"]').first())
await page.waitForTimeout(2500)
check('the panel mounted its own root', (await page.locator('.rb-root').count()) > 0)

/* ---------------------------------------- clone a built-in template (UI) */

await openDrawer()
check('the header opens the template drawer', (await page.locator('.rb-dialog-drawer .rb-drawer-list').count()) === 1)
const sourceRow = listColumn().locator('.rb-template-row').first()
check('the first row is the built-in standard template',
  (await sourceRow.innerText()).includes('标准研发流程') && (await sourceRow.innerText()).includes('内置'),
  await sourceRow.innerText().catch(() => ''))
await clickLocator(sourceRow)
await page.waitForTimeout(1600)
await clickLocator(page.locator('button[name="template.clone"]'))
await page.waitForTimeout(600)
await fillLocator(page.locator('input[name="template.clone.name"]'), probe)
await clickLocator(page.locator('button[name="template.clone.confirm"]'))
await page.waitForTimeout(2200)
const cloned = (await wire({ action: 'template.list', includeArchived: true })).data?.items?.find(item => item.name === probe)
check('the clone affordance created one editable template', cloned !== undefined && cloned.builtin === false, JSON.stringify(cloned?.id))
check('the clone starts a fresh version line', cloned?.revision === 1 && cloned?.versionCount === 0)
const templateId = cloned?.id ?? ''

/* ------------------------------ two requirements on the clone, via the UI */

await closeDrawer()
await reloadAndMount()
const createRequirement = async title => {
  await clickLocator(page.locator('.rb-root button:visible', { hasText: /新建需求|New requirement/ }).first())
  await page.waitForTimeout(900)
  await fillLocator(page.locator('input[name="requirement.title"]'), title)
  await page.locator('select[name="requirement.templateId"]').selectOption(templateId)
  await clickLocator(page.locator('[role="dialog"] button:visible', { hasText: /^(创建|Create)$/ }).last())
  await page.waitForTimeout(2200)
}
await createRequirement(migrateTitle)
await createRequirement(keepTitle)
const seeded = await snapshot()
const seededRows = (seeded?.requirements ?? []).filter(row => row.templateId === templateId)
check('the create dialog offered the clone and created two requirements on it', seededRows.length === 2,
  JSON.stringify(seededRows.map(row => row.title)))
check('both start pinned to revision 1 on the clone first node',
  seededRows.every(row => row.templateRevision === 1 && row.nodeId === 'review'),
  JSON.stringify(seededRows.map(row => `${row.nodeId}/${row.templateRevision}`)))
const migrateId = seededRows.find(row => row.title === migrateTitle)?.id
const keepId = seededRows.find(row => row.title === keepTitle)?.id

// One ticked checklist entry, so "the ticks are unchanged" compares a real value.
const ticked = await wire({ action: 'checklist', id: migrateId, index: 0, checked: true, session: panelSession, name: 'lifecycle gate' })
check(`the gate could tick one checklist entry of the migrating requirement (session "${panelSession}")`, ticked.ok, ticked.message)
const beforeEdit = (await snapshot())?.requirements?.find(row => row.id === migrateId)
check('the migrating requirement holds a real tick before the template edit',
  beforeEdit?.nodes?.review?.checks?.[0] === true, JSON.stringify(beforeEdit?.nodes?.review?.checks))

/* ------------------------------------- append a version through the drawer */

await openDrawer()
await pickRow(probe)
check('the drawer reads the clone as its current first version', (await page.locator('.rb-dialog-drawer').innerText()).includes('当前第 1 版'))
await clickLocator(page.locator('button[name="template.edit"]'))
await page.waitForTimeout(1400)
await fillLocator(page.locator('input[name="template.node.name.0"]'), renamedFirstNode)
await clickLocator(page.locator('button[name="template.node.remove.4"]'))
await page.waitForTimeout(500)
await clickLocator(page.locator('button[name="template.revise.save"]'))
await page.waitForTimeout(2500)

const revised = await wire({ action: 'template.get', id: templateId })
check('saving the edit appended version 2', revised.data?.revision === 2, JSON.stringify(revised.data?.revision))
check('and moved the old top level into the version history',
  revised.data?.versions?.length === 1 && revised.data.versions[0].revision === 1, JSON.stringify(revised.data?.versions?.length))
check('revision 2 carries the renamed first node and one node fewer',
  revised.data?.nodes?.[0]?.name === renamedFirstNode && revised.data?.nodes?.length === 4,
  JSON.stringify(revised.data?.nodes?.map(node => node.name)))
const afterEdit = (await snapshot())?.requirements?.find(row => row.id === migrateId)
check('the running requirement is field-for-field unchanged by the appended version',
  owned(afterEdit) === owned(beforeEdit))
check('its pin is still revision 1', afterEdit?.templateRevision === 1)
check('its flow still projects the five nodes of revision 1 with the old first name',
  afterEdit?.flow?.length === 5 && afterEdit?.flow?.[0]?.name === '需求评审',
  JSON.stringify(afterEdit?.flow?.map(node => node.name)))
const drawerText = (await page.locator('.rb-dialog-drawer').innerText()).replace(/\s+/gu, ' ')
check('the drawer shows the version history and the pin count',
  drawerText.includes('当前第 2 版') && drawerText.includes('第 1 版') && drawerText.includes('被 2 条需求钉住'),
  drawerText.slice(0, 220))
await page.screenshot({ path: fileURLToPath(new URL('./_lifecycle-drawer.png', import.meta.url)) })

/* --------------------------- migrate one requirement through the dialog */

await clickLocator(page.locator('button[name="template.migrate.1"]'))
await page.waitForTimeout(1000)
check('the migration dialog opens on its read step', (await dialog().innerText()).includes('第 1/3 步'))
await clickLocator(page.locator('button:visible', { hasText: /读取受影响的需求|Read the affected/ }).last())
await page.waitForTimeout(1800)
const step2 = await dialog().innerText()
check('the refusal moved the dialog to its impact step', step2.includes('第 2/3 步'))
check('the impact list is the Host\'s own affected rows', (await dialog().locator('.rb-impact-row').count()) === 2,
  String(await dialog().locator('.rb-impact-row').count()))
const keepRow = dialog().locator('.rb-impact-row', { hasText: keepTitle })
await clickLocator(keepRow.locator('input[type="checkbox"]'), { force: true })
await page.waitForTimeout(500)
if (await keepRow.locator('input[type="checkbox"]').isChecked().catch(() => true)) await clickLocator(keepRow, { force: true })
await page.waitForTimeout(400)
const stillChecked = await dialog().locator('.rb-impact-row input[type="checkbox"]:checked').count()
check('unpicking one row leaves exactly one requirement selected', stillChecked === 1, String(stillChecked))
await clickLocator(page.locator('[role="dialog"] button:visible', { hasText: /迁移选中的 1 条|Migrate the selected 1/ }).last())
await page.waitForTimeout(2500)
const afterMigrate = await snapshot()
const migratedRow = afterMigrate?.requirements?.find(row => row.id === migrateId)
const keptRow = afterMigrate?.requirements?.find(row => row.id === keepId)
check('the confirmed migration moved only the picked requirement',
  migratedRow?.templateRevision === 2 && keptRow?.templateRevision === 1,
  JSON.stringify({ migrated: migratedRow?.templateRevision, kept: keptRow?.templateRevision }))
check('the migrated requirement now derives revision 2',
  migratedRow?.flow?.length === 4 && migratedRow?.flow?.[0]?.name === renamedFirstNode,
  JSON.stringify(migratedRow?.flow?.map(node => node.name)))
check('and kept the node it was on', migratedRow?.nodeId === 'review')
check('while the unpicked one still derives revision 1', keptRow?.flow?.length === 5 && keptRow?.flow?.[0]?.name === '需求评审')
await page.screenshot({ path: fileURLToPath(new URL('./_lifecycle-migration.png', import.meta.url)) })

/* ------------------------------------------------- prune refused (pinned) */

await page.waitForTimeout(800)
const pruneButton = page.locator('button[name="template.prune.1"]')
check('the drawer disables pruning a revision a requirement is still pinned to',
  (await pruneButton.isDisabled()) === true)
check('and names the requirement holding it',
  ((await pruneButton.getAttribute('title')) ?? '').includes(keepId), String(await pruneButton.getAttribute('title')))
const provoked = await wire({ action: 'template.prune', id: templateId, revision: 1 })
check('the Host refuses the same prune on the wire with in-use',
  provoked.status === 409 && provoked.code === 'in-use', `${provoked.status}/${provoked.code}`)

/* --------------------------- migrate the last pin, then prune for real */

await pickRow(probe)
await clickLocator(page.locator('button[name="template.migrate.1"]'))
await page.waitForTimeout(1000)
await clickLocator(page.locator('button:visible', { hasText: /读取受影响的需求|Read the affected/ }).last())
await page.waitForTimeout(1800)
check('the second migration read lists the one remaining pinned requirement',
  (await dialog().locator('.rb-impact-row').count()) === 1)
await clickLocator(page.locator('[role="dialog"] button:visible', { hasText: /迁移选中的 1 条|Migrate the selected 1/ }).last())
await page.waitForTimeout(2500)
check('both requirements are now on revision 2',
  (await snapshot())?.requirements?.filter(row => row.templateId === templateId).every(row => row.templateRevision === 2))
const beforePrune = await wire({ action: 'template.get', id: templateId })
const pruneRow = page.locator('button[name="template.prune.1"]')
check('prune is live once nothing pins the revision', (await pruneRow.isDisabled()) === false)
await clickLocator(pruneRow)
await page.waitForTimeout(700)
const notice = page.locator('.rb-notice-force')
check('the prune asks for confirmation first', (await notice.count()) === 1 && (await notice.innerText()).includes('第 1 版'))
await clickLocator(notice.locator('button.rb-btn-danger'))
await page.waitForTimeout(2500)
const afterPrune = await wire({ action: 'template.get', id: templateId })
check('the confirmed prune dropped exactly one version',
  afterPrune.data?.versions?.length === (beforePrune.data?.versions?.length ?? 0) - 1 && afterPrune.data?.versions?.length === 0,
  JSON.stringify({ before: beforePrune.data?.versions?.length, after: afterPrune.data?.versions?.length }))
check('and left the current revision where it was', afterPrune.data?.revision === 2)

/* ------------------------------------------------------------- archive */

await clickLocator(page.locator('button[name="template.archive"]'))
await page.waitForTimeout(2500)
const archived = await wire({ action: 'template.get', id: templateId })
check('archiving shelves the template', archived.data?.archived === true)
check('and it leaves the drawer\'s default list',
  (await listColumn().locator('.rb-template-row', { hasText: probe }).count()) === 0)
check('while the Host still answers its full record', archived.data?.revision === 2)
const defaultList = await wire({ action: 'template.list' })
check('and the un-archived list no longer offers it', !defaultList.data?.items?.some(item => item.id === templateId))

await closeDrawer()
await reloadAndMount()
await clickLocator(page.locator('.rb-root button:visible', { hasText: /新建需求|New requirement/ }).first())
await page.waitForTimeout(1200)
const options = await page.locator('select[name="requirement.templateId"] option').evaluateAll(nodes => nodes.map(node => node.value))
check('the new-requirement selector no longer offers an archived template', !options.includes(templateId), options.join(','))
await page.keyboard.press('Escape')
await page.waitForTimeout(800)

/* --------------------------------------------- delete refused, in use */

await openDrawer()
await showArchived()
check('the drawer shows the shelved template only with its archived filter on',
  (await listColumn().locator('.rb-template-row', { hasText: probe }).count()) === 1)
await pickRow(probe)
await clickLocator(page.locator('button[name="template.delete"]'))
await page.waitForTimeout(1000)
const deletePanel = page.locator('.rb-dialog-drawer .rb-panel', { hasText: '删除该模板及其全部版本历史' })
check('the delete confirmation lists the requirements still bound',
  (await deletePanel.innerText()).includes(migrateTitle) && (await deletePanel.innerText()).includes(keepTitle),
  (await deletePanel.innerText().catch(() => '')).replace(/\s+/gu, ' ').slice(0, 220))
const refusalsBeforeArm = refusals.length
const deleteConfirm = page.locator('button[name="template.delete.confirm"]')
let armedText = (await deleteConfirm.innerText()).trim()
for (let attempt = 0; attempt < 3 && !armedText.includes('确认删除并改绑'); attempt += 1) {
  await clickLocator(deleteConfirm)
  await page.waitForTimeout(1000)
  armedText = (await deleteConfirm.innerText()).trim()
}
check('deleting a template in use arms a second confirmation instead of sending',
  armedText.includes('确认删除并改绑') && refusals.length === refusalsBeforeArm,
  `"${armedText}" / ${refusals.length - refusalsBeforeArm} request(s) sent`)

/* ------------------------------------------ delete refused, built-in */

await pickRow('标准研发流程')
await clickLocator(page.locator('button[name="template.delete"]'))
await page.waitForTimeout(900)
const refusalsBeforeBuiltin = refusals.length
for (let attempt = 0; attempt < 2; attempt += 1) {
  if ((await page.locator('button[name="template.delete.confirm"]').count()) === 0) break
  await clickLocator(page.locator('button[name="template.delete.confirm"]'))
  await page.waitForTimeout(1400)
  if (refusals.length > refusalsBeforeBuiltin) break
}
check('the Host refused deleting the built-in template',
  refusals.slice(refusalsBeforeBuiltin).some(entry => entry.action === 'template.delete' && entry.code === 'invalid-transition'),
  JSON.stringify(refusals.slice(refusalsBeforeBuiltin)))
const builtinAlerts = page.locator('.rb-dialog-drawer [role="alert"]')
const alertText = (await builtinAlerts.first().innerText().catch(() => '')).replace(/\s+/gu, ' ')
check('and the drawer reports that refusal in the panel',
  (await builtinAlerts.count()) >= 1 && /cannot be deleted|内置模板不可/u.test(alertText),
  alertText.slice(0, 200))
await page.screenshot({ path: fileURLToPath(new URL('./_lifecycle-refusals.png', import.meta.url)) })
await closeDrawer()

/* ------------------------------------------------ only provoked refusals */

const expected = [
  'template.migrate:in-use',
  'template.migrate:in-use',
  'template.prune:in-use',
  'template.delete:invalid-transition',
]
const observed = refusals.map(entry => `${entry.action}:${entry.code}`).sort()
check('every refused command is one this gate deliberately provoked',
  observed.join(',') === [...expected].sort().join(','), observed.join(','))
check('and every console error is one of those refusals, with no page error',
  consoleErrors.length === expected.length && consoleErrors.every(line => /409/u.test(line)),
  consoleErrors.slice(0, 4).join(' | '))

/* ---------------------------------------------------------------- undo */

const undone = []
for (const id of [migrateId, keepId]) undone.push((await wire({ action: 'delete', id, session: '' })).ok)
undone.push((await wire({ action: 'template.delete', id: templateId, force: true, session: '' })).ok)
check('the gate deleted the two requirements and the template it created', undone.every(Boolean), undone.join('/'))
const left = await wire({ action: 'template.list', includeArchived: true })
check('and nothing it named is left on the board', !left.data?.items?.some(item => item.id === templateId || item.name === probe))
check('the cleanup itself was not refused', refusals.length === expected.length, String(refusals.length))

const shot = fileURLToPath(new URL('./_lifecycle-final.png', import.meta.url))
await page.screenshot({ path: shot })
await browser.close()

const failed = results.filter(entry => !entry.ok)
writeFileSync(new URL('./_lifecycle.txt', import.meta.url), `${results.length - failed.length}/${results.length} checks passed\n`
  + `refusals: ${observed.join(', ')}\nconsole errors: ${consoleErrors.length}\nbase: ${base}\n`)
console.log(`\n${results.length - failed.length}/${results.length} checks passed  (screenshots: _lifecycle-drawer.png, _lifecycle-migration.png, _lifecycle-refusals.png)`)
process.exit(failed.length === 0 ? 0 : 1)
