/**
 * Requirement Board — real-browser panel render check.
 *
 * The board's page is a Client module bound into the shell's `main` slot. A
 * defect there (for example calling the renderer's `use<Name>` hook without its
 * required selector) throws inside React, and the slot renderer swallows it:
 * the sidebar entry still shows and the panel area is blank. No HTTP-level suite
 * can see that, so this instrument drives a real browser.
 *
 * Usage (an instance must already be listening):
 *   node tests/verification/panel-render.e2e.mjs http://127.0.0.1:3109 <boot-token>
 *
 * The token is required: without a credential the check reports a named reason
 * and makes zero requests, exactly like `live.mjs`. Playwright resolves through
 * the repository's `apps/web` manifest, so this instrument runs from the
 * development tree rather than from the deployed bundle.
 *
 * This gate writes: the live-chain check creates one probe requirement and
 * deletes it again. Point it at a temporary development instance whose board it
 * may write, never at a deployment in use.
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

const base = process.argv[2]
const token = process.argv[3] ?? process.env.DSH_BOARD_TOKEN
if (base === undefined || token === undefined || token === '') {
  console.error('panel-render: needs a base URL and a boot token (node panel-render.e2e.mjs <base-url> <token>)')
  process.exit(2)
}

const require = createRequire('C:/code/deepseek-harness/apps/web/package.json')
const playwright = await import(pathToFileURL(require.resolve('playwright')).href)
const chromium = playwright.chromium ?? playwright.default?.chromium

const results = []
const record = (ok, label) => {
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

const browser = await chromium.launch()
const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const failures = []
page.on('console', message => { if (message.type() === 'error') failures.push(`console.error: ${message.text()}`) })
page.on('pageerror', error => failures.push(`pageerror: ${error.message}`))

await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(7000)

const entry = page.locator('[aria-label*="需求"], [aria-label*="Requirement"]').first()
record(await entry.count() > 0, 'the sidebar shows the board entry')
await entry.click({ timeout: 5000 })
await page.waitForTimeout(3000)

const panel = await page.evaluate(() => {
  const region = document.querySelector('.rb-root')
  return {
    present: region !== null,
    controls: region === null ? 0 : region.querySelectorAll('button,select,input').length,
    text: region === null ? '' : (region.innerText ?? region.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }
})
record(panel.present, 'the panel mounted its own root (.rb-root)')
record(panel.controls >= 8, `the panel area rendered its controls (${panel.controls} interactive elements)`)
record(/需求看板|Requirement Board/.test(panel.text), 'the panel renders its heading')
record(/还没有需求|No requirement yet|没有需求/.test(panel.text) || /完成率|Completion/.test(panel.text), 'the panel renders its empty state or board content')
record(/队列|Queue/.test(panel.text) && /要我拍板|Decisions/.test(panel.text), 'the panel renders its own view tabs')
record(failures.length === 0, `no console error or page error (${failures.length})`)

/**
 * The board's one surviving local style override is the danger button colour.
 * It must hold by specificity rather than stylesheet order, and it must reach
 * inside the Modal's body portal, so it is asserted against the token itself.
 */
await page.locator('button:visible', { hasText: /角色管理|Roles/ }).first().click({ timeout: 8000 })
await page.waitForTimeout(1500)
const danger = await page.evaluate(() => {
  const probe = document.createElement('div')
  probe.style.color = 'var(--dsw-alias-state-error-primary)'
  document.body.appendChild(probe)
  const token = getComputedStyle(probe).color
  probe.remove()
  const button = document.querySelector('[role="dialog"] .rb-btn-danger')
  return { token, color: button === null ? null : getComputedStyle(button).color, present: button !== null }
})
record(danger.present, 'the role dialog renders its danger button (.rb-btn-danger)')
record(danger.present && danger.color === danger.token, `the danger override holds by specificity (${String(danger.color)} vs token ${danger.token})`)
await page.keyboard.press('Escape')
await page.waitForTimeout(600)
record(failures.length === 0, `no console error after the dialog round trip (${failures.length})`)

/**
 * The create dialog's image affordance: the picker and the helper line that
 * says how a screenshot gets in. The helper is the panel's only copy at the
 * helper tier, so it also proves the rule that carries the image tiles parsed:
 * a stylesheet truncated mid-string would leave it unstyled rather than 11px.
 */
await page.locator('button:visible', { hasText: /新建需求|New requirement/ }).first().click({ timeout: 8000 })
await page.waitForTimeout(1200)
const imageTier = await page.evaluate(() => {
  const probe = document.createElement('div')
  probe.style.color = 'var(--dsw-alias-label-secondary)'
  document.body.appendChild(probe)
  const token = getComputedStyle(probe).color
  probe.remove()
  const dialog = document.querySelector('[role="dialog"]')
  const hint = dialog === null ? null : dialog.querySelector('.rb-image-hint')
  const pick = dialog === null ? null : dialog.querySelector('[name="requirement.image.pick"]')
  return {
    token,
    dialog: dialog !== null,
    picker: pick !== null,
    hint: hint === null ? null : { size: getComputedStyle(hint).fontSize, color: getComputedStyle(hint).color, lines: Math.round(hint.getBoundingClientRect().height) },
  }
})
record(imageTier.dialog && imageTier.picker, 'the create dialog offers its image picker')
record(imageTier.hint !== null && imageTier.hint.size === '11px', `the image helper sits at the helper tier (${String(imageTier.hint?.size)})`)
record(imageTier.hint !== null && imageTier.hint.color === imageTier.token, `the image helper uses the secondary label token (${String(imageTier.hint?.color)} vs token ${imageTier.token})`)
record(imageTier.hint !== null && imageTier.hint.lines <= 20, `the image helper stays on one line (${String(imageTier.hint?.lines)}px)`)
await page.keyboard.press('Escape')
await page.waitForTimeout(600)
record(failures.length === 0, `no console error after the create dialog round trip (${failures.length})`)

/**
 * The live chain, end to end: a committed write must reach the open panel with
 * no reload. The client schedules `changed`-driven reads behind a short trailing
 * delay and publishes only its newest read, so a read that never runs, or one
 * that is dropped as superseded, would leave the panel on stale content — which
 * only a real browser over a real stream can show.
 */
const probeTitle = `Panel render probe ${Date.now()}`
const wrote = await page.evaluate(async title => {
  const response = await fetch('/api/requirement-board/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create', requirement: { title } }),
  })
  const body = await response.json().catch(() => null)
  return { ok: body?.ok === true, id: body?.data?.id ?? null, message: body?.error?.message ?? '' }
}, probeTitle)
record(wrote.ok && wrote.id !== null, `the gate could write one probe requirement (${wrote.message})`)
const reached = await page.waitForFunction(
  title => (document.querySelector('.rb-root')?.innerText ?? '').includes(title),
  probeTitle,
  { timeout: 10_000 },
).then(() => true).catch(() => false)
record(reached, 'a committed change reaches the open panel through the live stream')
const cleaned = wrote.id === null ? false : await page.evaluate(async id => {
  const response = await fetch('/api/requirement-board/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'delete', id }),
  })
  const body = await response.json().catch(() => null)
  return body?.ok === true
}, wrote.id)
record(cleaned, 'the probe requirement was deleted again')
record(failures.length === 0, `no console error after the live round trip (${failures.length})`)

const shotPath = fileURLToPath(new URL('./_panel_render.png', import.meta.url))
await page.screenshot({ path: shotPath })
await browser.close()

if (failures.length > 0) for (const line of failures.slice(0, 8)) console.log(`  - ${line.slice(0, 300)}`)
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed  (screenshot: ${shotPath})`)
writeFileSync(new URL('./_panel_render.txt', import.meta.url), `${passed}/${results.length} checks passed\n${failures.join('\n')}\npanel controls: ${panel.controls}\ndanger colour: ${String(danger.color)} vs token ${danger.token}\npanel text: ${panel.text.slice(0, 600)}\n`)
process.exit(passed === results.length ? 0 : 1)
