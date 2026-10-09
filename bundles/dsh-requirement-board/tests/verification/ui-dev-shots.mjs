#!/usr/bin/env node
/**
 * Photograph the requirement detail view, the force-advance dialog and the
 * delete-confirmation dialog on a board that has data in it, and assert the
 * three surfaces exist as the platform's own dialogs.
 *
 * Usage:
 *   node tests/verification/ui-dev-shots.mjs <base-url> <boot-token>
 *
 * Prerequisite: an instance whose board domain is routed to a **development**
 * database, so this instrument never writes the production board. The recorded
 * launch form (from the repository root; `process.cwd()` is part of the path):
 *
 *   node --import tsx/esm apps/cli/src/bin.ts --profile web \
 *     --patch .artifacts/requirement-board/rollout/ui-dev.overlay.yml \
 *     --no-open --port 3110
 *
 * `--patch` must precede the app arguments, otherwise the argument parser hands
 * it to the app and it is rejected as an unknown option.
 *
 * Evidence lands in this directory as `_ui_dev-<surface>.png` plus
 * `_ui_dev-shots.json`. The instrument writes into the dev database only.
 *
 * What each surface needs: the force dialog is the one path that requires the
 * board to refuse a transition it can offer a way past, so the requirement is
 * given a declared blocker (`blocksOn`) and its completion condition is ticked
 * as the panel's own session — the panel shows a checklist read-only, and its
 * advance button stays disabled until the node's condition is met.
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(fileURLToPath(new URL('../../../../apps/web/package.json', import.meta.url)))
const playwright = await import(pathToFileURL(require.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default?.chromium

const base = (process.argv[2] ?? 'http://127.0.0.1:3110').replace(/\/$/u, '')
const token = process.argv[3] ?? process.env.RB_LIVE_TOKEN ?? ''
if (token === '') {
  console.error('ui-dev-shots: pass the boot token as argv[3] or RB_LIVE_TOKEN')
  process.exit(2)
}

const TITLE_BLOCKER = '前置：接口契约'
const TITLE_BLOCKED = '被前置挡住的推进'
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined || ok ? '' : ` — ${JSON.stringify(detail).slice(0, 160)}`}`)
}

const bootstrap = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (bootstrap.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
if (cookie === '') {
  console.error(`ui-dev-shots: the bootstrap page set no cookie (status ${bootstrap.status})`)
  process.exit(2)
}
const post = async body => {
  const response = await fetch(`${base}/api/requirement-board/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  const parsed = await response.json().catch(() => null)
  return { status: response.status, ok: parsed?.ok === true, data: parsed?.data, error: parsed?.error }
}

const blocker = await post({ action: 'create', requirement: { summary: '测试简述', title: TITLE_BLOCKER, priority: 'high' }, name: 'UI shots' })
const blocked = await post({ action: 'create', requirement: { summary: '测试简述', title: TITLE_BLOCKED }, name: 'UI shots' })
check('the dev board accepted two seeded requirements', blocker.ok && blocked.ok, { blocker: blocker.error, blocked: blocked.error })
const blockerId = blocker.data?.id ?? blocker.data?.requirement?.id
const blockedId = blocked.data?.id ?? blocked.data?.requirement?.id

const browser = await chromium.launch()
const page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })).newPage()
const errors = []
const refusals = []
page.on('pageerror', error => errors.push(String(error.message)))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('response', async response => {
  if (!response.url().includes('/api/requirement-board/command') || response.status() < 400) return
  const body = await response.json().catch(() => null)
  refusals.push({
    status: response.status(),
    request: (response.request().postData() ?? '').slice(0, 180),
    code: body?.error?.code,
    reason: body?.error?.details?.reason,
  })
})
let panelSession = ''
page.on('request', request => {
  if (!request.url().includes('/api/requirement-board/command')) return
  try {
    const body = JSON.parse(request.postData() ?? '{}')
    if (typeof body.session === 'string' && body.session !== '') panelSession = body.session
  } catch { /* a body this instrument does not need */ }
})
await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6500)
await page.locator('[aria-label*="需求"], [aria-label*="Requirement"]').first().click()
await page.waitForTimeout(2500)
check('the panel mounted its own root', (await page.locator('.rb-root').count()) > 0)

// The panel reads a checklist but never ticks one, and its advance button is
// disabled until the node's own completion condition is met, so the ticks and
// the blocker declaration come from the wire as the panel's own session.
const listed = await post({ action: 'list', session: panelSession, me: panelSession })
const rows = Array.isArray(listed.data) ? listed.data : (listed.data?.items ?? [])
const row = rows.find(entry => entry.id === blockedId)
const declared = await post({ action: 'update', id: blockedId, patch: { blocksOn: [blockerId] }, expectedRev: row?.rev, session: panelSession, name: 'UI shots' })
check('the blocked requirement declares its blocker', declared.ok, declared.error)
let rev = declared.data?.rev ?? row?.rev
for (const index of [0, 1]) {
  const tick = await post({ action: 'checklist', id: blockedId, index, checked: true, expectedRev: rev, session: panelSession, name: 'UI shots' })
  rev = tick.data?.rev ?? rev
  check(`completion condition ${index} is satisfied`, tick.ok, tick.error)
}
// The writes above moved the document revision while the page was open, so the
// panel's snapshot is stale by construction. Reload before driving: a stale
// `expectedRev` would be refused as a conflict, and that conflict would be this
// instrument's own doing rather than the board's behaviour.
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6500)
await page.locator('[aria-label*="需求"], [aria-label*="Requirement"]').first().click()
await page.waitForTimeout(2500)

const card = page.locator('.rb-card', { hasText: TITLE_BLOCKED }).first()
if (await card.count() > 0) { await card.click(); await page.waitForTimeout(1500) }
check('the detail view names the seeded requirement', (await page.locator('.rb-root').innerText()).includes(TITLE_BLOCKED))
await page.screenshot({ path: join(here, '_ui_dev-detail.png') })

const advance = page.getByRole('button', { name: /完成并推进|Finish and advance/ }).first()
check('the advance button is live once the node condition is met', await advance.isEnabled().catch(() => false))
await advance.click({ timeout: 10_000 }).catch(() => {})
await page.waitForTimeout(2500)
check('a blocked advance offers the force in place', (await page.locator('.rb-root').innerText()).includes('强制推进'))
await page.screenshot({ path: join(here, '_ui_dev-blocked.png') })

const force = page.getByRole('button', { name: /强制推进|Force advance/ }).first()
if (await force.count() > 0) await force.click({ timeout: 10_000 }).catch(() => {})
await page.waitForTimeout(1500)
const dialog = page.locator('[role="dialog"]')
check('the force offer opens a dialog', (await dialog.count()) === 1)
check('the force dialog states what it overrides', (await dialog.first().innerText().catch(() => '')).includes(TITLE_BLOCKER))
await page.screenshot({ path: join(here, '_ui_dev-force.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(1200)
check('Escape closes the force dialog', (await dialog.count()) === 0)

const remove = page.locator('.rb-root button', { hasText: /^删除$/ }).first()
if (await remove.count() > 0) await remove.click({ timeout: 10_000 }).catch(() => {})
await page.waitForTimeout(1500)
check('the delete action opens a confirmation dialog', (await dialog.count()) === 1)
check('the deletion is named as irreversible', (await dialog.first().innerText().catch(() => '')).includes('不可撤销'))
await page.screenshot({ path: join(here, '_ui_dev-delete.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(1200)
check('Escape closes the delete dialog', (await dialog.count()) === 0)

// The blocked advance is refused on purpose, and a refusal reaches the browser as
// a 4xx, which the console reports as a resource error. Assert the only refusal —
// and the only console line — is that one, rather than asserting an error-free
// page that this instrument cannot honestly produce.
const provoked = refusals.filter(entry => entry.code === 'invalid-transition' && entry.reason === 'blocked-by')
check('the only refused command is the blocked advance it provoked', refusals.length === 1 && provoked.length === 1, refusals.slice(0, 2))
const unexpectedErrors = errors.filter(text => !/409/u.test(text))
check('the only console error is that provoked refusal', unexpectedErrors.length === 0, unexpectedErrors.slice(0, 3))
await browser.close()

const failed = results.filter(entry => !entry.ok).length
const report = { base, seeded: { blockerId, blockedId }, panelSession, errors, refusals, results }
writeFileSync(join(here, '_ui_dev-shots.json'), JSON.stringify(report, null, 1) + '\n')
console.log(`${results.length - failed}/${results.length} checks passed  (screenshots: _ui_dev-detail.png, _ui_dev-blocked.png, _ui_dev-force.png, _ui_dev-delete.png)`)
process.exit(failed === 0 ? 0 : 1)
