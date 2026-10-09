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
 * The redesign's own visual language, measured where a reader sees it: the
 * accent the concept defines, the band's seven columns, the numeral type scale,
 * the completion ring's diameter and the two-column body. A token that stops
 * reaching the panel, or a measurement that drifts, fails here rather than only
 * in the source-level smoke checks.
 *
 * The fold and meta-grid readings need a selected requirement; on a board with
 * none they are reported as unmeasured instead of as a defect.
 */
const visual = await page.evaluate(() => {
  const style = selector => {
    const element = document.querySelector(selector)
    return element === null ? null : getComputedStyle(element)
  }
  const box = selector => {
    const element = document.querySelector(selector)
    if (element === null) return null
    const rect = element.getBoundingClientRect()
    return { width: Math.round(rect.width), height: Math.round(rect.height) }
  }
  // The accent is registered on the panel's own root, so it is probed there:
  // the same variable read outside that subtree resolves to nothing.
  const probe = document.createElement('div')
  probe.style.color = 'var(--rb-accent)'
  ;(document.querySelector('.rb-root') ?? document.body).appendChild(probe)
  const accent = getComputedStyle(probe).color
  probe.remove()
  const cells = [...document.querySelectorAll('.rb-stats > .rb-stat')]
  const primary = [...document.querySelectorAll('.rb-root button')]
    .find(candidate => String(candidate.className).includes('rb-btn-primary'))
  return {
    accent,
    primaryButton: primary === undefined ? null : getComputedStyle(primary).backgroundColor,
    bandColumns: style('.rb-stats')?.gridTemplateColumns ?? '',
    bandCells: cells.length,
    bandRows: new Set(cells.map(cell => Math.round(cell.getBoundingClientRect().y))).size,
    valueFont: style('.rb-stat-value')?.fontSize ?? '',
    valueNumeric: style('.rb-stat-value')?.fontVariantNumeric ?? '',
    ring: box('.rb-ring'),
    queue: box('.rb-list'),
    metaColumns: style('.rb-meta-grid')?.gridTemplateColumns ?? null,
    summaryCursor: style('.rb-fold-summary')?.cursor ?? null,
    alertCursor: style('.rb-stat-alert')?.cursor ?? null,
  }
})
record(visual.accent === 'rgb(240, 100, 35)', `the accent reaches the panel as the concept's orange (${visual.accent})`)
record(visual.primaryButton === visual.accent, `the primary action carries that accent (${String(visual.primaryButton)})`)
record(visual.bandCells === 7 && visual.bandRows === 1,
  `the KPI band is one row of seven cells (${visual.bandCells} cells over ${visual.bandRows} row(s))`)
record(/^300px .*220px$/.test(visual.bandColumns), `the band keeps the concept columns (${visual.bandColumns})`)
record(visual.valueFont === '26px' && visual.valueNumeric === 'tabular-nums',
  `the reading keeps 26px tabular numerals (${visual.valueFont}, ${visual.valueNumeric})`)
record(visual.ring !== null && visual.ring.width === 56 && visual.ring.height === 56,
  `the completion ring keeps its 56px diameter (${JSON.stringify(visual.ring)})`)
record(visual.queue !== null && visual.queue.width === 330,
  `the queue keeps its 330px column (${JSON.stringify(visual.queue)})`)
record(visual.metaColumns === null || (visual.metaColumns.match(/px/gu) ?? []).length === 4,
  `the meta grid keeps four columns (${String(visual.metaColumns)})`)
record(visual.summaryCursor === null || visual.summaryCursor === 'pointer',
  `a section header reads as foldable (${String(visual.summaryCursor)})`)
record(visual.alertCursor === 'default', `the alert tile reads as a measurement, not a control (${String(visual.alertCursor)})`)

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
 * The preset roster: `role.list` is the read that ties a role to the preset it
 * comes from, and the dialog's preset section is where a person sees it. The
 * gate registers one unrecorded preset through the panel's own button and then
 * deletes that one record again, so the role registry ends as it started.
 */
await page.locator('button:visible', { hasText: /角色管理|Roles/ }).first().click({ timeout: 8000 })
await page.waitForTimeout(1500)
const roster = await page.evaluate(async () => {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1)
  const rows = dialog === null ? [] : [...dialog.querySelectorAll('.rb-preset-row')]
  const listed = await (await fetch('/api/requirement-board/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'role.list' }),
  })).json()
  const items = listed?.ok === true ? listed.data.presets.items : []
  return {
    sectionTitle: (dialog?.innerText ?? '').includes('预设模式'),
    unavailable: listed?.ok === true ? listed.data.presets.unavailable : 'command-refused',
    items: items.map(item => ({
      id: item.id,
      name: item.name,
      roleId: item.roleId,
      recorded: item.recorded,
      confirmed: item.confirmed,
      broken: item.broken,
    })),
    rowCount: rows.length,
    registerNames: rows.flatMap(row => [...row.querySelectorAll('[name^="preset.register."]')]
      .map(button => button.getAttribute('name'))),
    inferredRows: rows.filter(row => (row.innerText ?? '').includes('按预设 id 推定')).length,
    invalidRows: rows.filter(row => (row.innerText ?? '').includes('不能作角色 id')).length,
  }
})
const unrecorded = roster.items.filter(item => item.roleId !== '' && item.recorded === false)
record(roster.sectionTitle, 'the role dialog renders the preset section')
record(roster.unavailable === null,
  `the running Host answers role.list with a readable roster (${JSON.stringify(roster.unavailable)})`)
record(roster.items.length > 0 && roster.rowCount === roster.items.length,
  `the panel draws one row per declared preset (${roster.rowCount} of ${roster.items.length})`)
record(roster.registerNames.length === unrecorded.length,
  `exactly the unrecorded presets offer a register button (${roster.registerNames.length} of ${unrecorded.length})`)
record(roster.registerNames.every(name => unrecorded.some(item => `preset.register.${item.id}` === name)),
  'every register button names its own preset')
record(roster.inferredRows === roster.items.filter(item => item.confirmed === false && item.roleId !== '').length,
  `rows with no observed session say the role is inferred (${roster.inferredRows})`)
record(roster.invalidRows === roster.items.filter(item => item.roleId === '').length,
  `preset ids that cannot be a role id are tagged apart (${roster.invalidRows})`)
const rosterShot = fileURLToPath(new URL('./_role_roster.png', import.meta.url))
await page.screenshot({ path: rosterShot })

if (unrecorded.length > 0) {
  const target = unrecorded[0]
  await page.locator(`[name="preset.register.${target.id}"]`).click({ timeout: 8000 })
  await page.waitForTimeout(600)
  const prefilled = await page.evaluate(() => ({
    roleId: document.querySelector('[name="role.roleId"]')?.value ?? null,
    roleName: document.querySelector('[name="role.roleName"]')?.value ?? null,
  }))
  const expectedName = target.name === '' ? target.id : target.name
  record(prefilled.roleId === target.roleId && prefilled.roleName === expectedName,
    `one click prefills the role id and display name from the preset (${String(prefilled.roleId)} / ${String(prefilled.roleName)})`)
  await page.locator('[name="role.save"]').click({ timeout: 8000 })
  await page.waitForTimeout(1200)
  const registered = await page.evaluate(async id => {
    const listed = await (await fetch('/api/requirement-board/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'role.list' }),
    })).json()
    const preset = listed?.data?.presets?.items?.find(entry => entry.id === id)
    const record = listed?.data?.items?.find(entry => entry.id === preset?.roleId)
    return { recorded: preset?.recorded ?? null, source: record?.source ?? null, buttonLeft: document.querySelector(`[name="preset.register.${id}"]`) !== null }
  }, target.id)
  record(registered.recorded === true && registered.source === 'manual',
    `the register button recorded the role through the ordinary put (${JSON.stringify(registered)})`)
  record(registered.buttonLeft === false, 'the registered preset stops offering the register action')
  const restored = await page.evaluate(async id => {
    const response = await fetch('/api/requirement-board/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'role.delete', id }),
    })
    const body = await response.json().catch(() => null)
    return body?.ok === true
  }, target.roleId)
  record(restored, `the gate deleted the record it registered (${target.roleId})`)
}
await page.keyboard.press('Escape')
await page.waitForTimeout(600)
record(failures.length === 0, `no console error after the preset roster round trip (${failures.length})`)

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
    body: JSON.stringify({ action: 'create', requirement: { summary: '面板渲染探针', title } }),
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

/**
 * The template drawer, over a real board.
 *
 * The drawer's hard rules are all about state that only exists once a template
 * has history: a requirement left on an older revision makes that revision
 * un-prunable and makes the Host answer a migration read with `in-use` instead
 * of a change. That state is built here through the same command API the panel
 * uses — nothing below recomputes what the Host already reports.
 */
const probeTemplate = `面板门模板 ${Date.now()}`
const prepared = await page.evaluate(async name => {
  const post = async body => {
    const response = await fetch('/api/requirement-board/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return response.json().catch(() => null)
  }
  const snapshot = await (await fetch('/api/requirement-board/snapshot?limit=200')).json()
  const source = (snapshot?.data?.templates ?? [])[0]
  if (source === undefined) return { error: 'the board lists no template to clone' }
  const cloned = await post({ action: 'template.clone', id: source.id, name })
  const id = cloned?.data?.id
  if (id === undefined) return { error: `clone refused: ${String(cloned?.error?.message ?? '')}` }
  const created = await post({ action: 'create', requirement: { summary: '测试简述', title: name, templateId: id } })
  const requirementId = created?.data?.id
  if (requirementId === undefined) return { id, error: `create refused: ${String(created?.error?.message ?? '')}` }
  const nodes = (cloned.data.nodes ?? []).map(node => ({ ...node, name: `${node.name} · v2` }))
  const revised = await post({ action: 'template.revise', id, patch: { nodes, expectedRevision: cloned.data.revision ?? 1 } })
  return {
    id,
    requirementId,
    revision: revised?.data?.revision ?? null,
    error: revised?.ok === true ? '' : `revise refused: ${String(revised?.error?.message ?? '')}`,
  }
}, probeTemplate)
record(prepared.error === '' && prepared.revision === 2,
  `the gate could prepare a template with one requirement left on revision 1 (${String(prepared.error)})`)

await page.locator('.rb-root button:visible', { hasText: /流程模板管理|Templates/ }).first().click({ timeout: 8000 })
await page.waitForTimeout(1500)
const drawerOpen = await page.locator('.rb-dialog-drawer .rb-drawer-list').count()
record(drawerOpen === 1, 'the header opens the template drawer with its own list column')
await page.locator('.rb-template-row', { hasText: probeTemplate }).first().click({ timeout: 8000 })
await page.waitForTimeout(1200)

const drawerState = await page.evaluate(name => {
  const drawer = document.querySelector('.rb-dialog-drawer')
  const text = (drawer?.innerText ?? '').replace(/\s+/g, ' ')
  const versionRows = drawer === null ? [] : [...drawer.querySelectorAll('.rb-version-row')]
  const prune = revision => {
    const button = drawer?.querySelector(`[name="template.prune.${revision}"]`)
    return button === null || button === undefined
      ? null
      : { disabled: button.disabled === true, title: button.getAttribute('title') ?? '' }
  }
  return {
    text,
    rows: drawer === null ? 0 : drawer.querySelectorAll('.rb-template-row').length,
    versions: versionRows.length,
    versionText: versionRows.map(row => (row.innerText ?? '').replace(/\s+/g, ' ').trim()),
    pinned: prune(1),
    probeRowPicked: [...(drawer?.querySelectorAll('.rb-template-row') ?? [])]
      .some(row => (row.innerText ?? '').includes(name) && row.className.includes('rb-template-row-picked')),
  }
}, probeTemplate)
record(drawerState.probeRowPicked, 'the row the gate prepared is the selected one')
record(drawerState.text.includes('当前第 2 版'), `the detail reads the template revision the revise produced (${drawerState.text.slice(0, 40)})`)
record(drawerState.versions >= 1 && drawerState.versionText.some(line => line.includes('第 1 版')),
  `the version history renders one row per older revision (${drawerState.versions})`)
record(drawerState.text.includes('被 1 条需求钉住'), 'the history marks the revision the probe requirement pins')
record(drawerState.pinned !== null && drawerState.pinned.disabled === true && drawerState.pinned.title.includes(prepared.requirementId),
  `prune is disabled on the pinned revision and names the holder (${String(drawerState.pinned?.title)})`)
const drawerShot = fileURLToPath(new URL('./_template_drawer.png', import.meta.url))
await page.screenshot({ path: drawerShot })

// The migration read is a deliberate refusal: the client asks without naming
// requirements, the Host answers `in-use` with its own impact list, and that list
// is what the dialog renders. One console error is the price of asking.
const beforeRead = failures.length
await page.locator('[name="template.migrate"]').click({ timeout: 8000 })
await page.waitForTimeout(900)
const stepOne = await page.locator('[role="dialog"]', { hasText: '第 1/3 步' }).count()
record(stepOne >= 1, 'the migration dialog opens on its read step')
await page.locator('button:visible', { hasText: /读取受影响的需求|Read the affected/ }).last().click({ timeout: 8000 })
await page.waitForTimeout(1500)
const migrated = await page.evaluate(name => {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1)
  const rows = dialog === null ? [] : [...dialog.querySelectorAll('.rb-impact-row')]
  return {
    step: (dialog?.innerText ?? '').includes('第 2/3 步'),
    rows: rows.map(row => (row.innerText ?? '').replace(/\s+/g, ' ').trim()),
    checked: rows.filter(row => row.querySelector('input[type="checkbox"]')?.checked === true).length,
    text: (dialog?.innerText ?? '').replace(/\s+/g, ' '),
    hasName: rows.some(row => (row.innerText ?? '').includes(name)),
  }
}, probeTemplate)
record(migrated.step, 'the refusal moves the dialog to its impact step')
record(migrated.rows.length === 1 && migrated.hasName,
  `the impact list is the Host's own affected rows (${migrated.rows.length}: ${migrated.rows[0]?.slice(0, 80)})`)
record(migrated.text.includes('当前节点') && migrated.text.includes('迁移后节点'),
  'each impact row names the node it moves from and the node it lands on')
record(migrated.checked === migrated.rows.length && migrated.rows.length > 0, 'the affected requirements start selected')
const provoked = failures.slice(beforeRead)
record(provoked.length === 1 && /409/.test(provoked[0]),
  `the only refused command is the migration read the gate provoked (${String(provoked[0]?.slice(0, 90))})`)
const migrationShot = fileURLToPath(new URL('./_template_migration.png', import.meta.url))
await page.screenshot({ path: migrationShot })

// Leave the panel as the earlier instruments photograph it, and stop its reads
// before the cleanup: a drawer left open on a template the gate then deletes
// would keep asking for it and answer its own question with a refusal.
await page.keyboard.press('Escape')
await page.waitForTimeout(600)
await page.keyboard.press('Escape')
await page.waitForTimeout(600)

// Undo what the gate built: move the requirement off the old revision, then drop
// it and the clone, so a rerun starts from the same board it found.
const undone = await page.evaluate(async probe => {
  const post = async body => {
    const response = await fetch('/api/requirement-board/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return response.json().catch(() => null)
  }
  const moved = await post({ action: 'template.migrate', id: probe.id, force: true })
  const dropped = await post({ action: 'delete', id: probe.requirementId })
  const removed = await post({ action: 'template.delete', id: probe.id })
  return [moved?.ok === true, dropped?.ok === true, removed?.ok === true]
}, { id: prepared.id, requirementId: prepared.requirementId })
record(undone.every(Boolean), `the gate undid its own template and requirement (${undone.join('/')})`)
await page.waitForTimeout(600)
record(failures.length === 1 && /409/.test(failures[0]),
  `the provoked migration read is the only refused command in the run (${failures.length})`)

const shotPath = fileURLToPath(new URL('./_panel_render.png', import.meta.url))
await page.screenshot({ path: shotPath })
await browser.close()

if (failures.length > 0) for (const line of failures.slice(0, 8)) console.log(`  - ${line.slice(0, 300)}`)
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed  (screenshot: ${shotPath})`)
writeFileSync(new URL('./_panel_render.txt', import.meta.url), `${passed}/${results.length} checks passed\n${failures.join('\n')}\npanel controls: ${panel.controls}\ndanger colour: ${String(danger.color)} vs token ${danger.token}\nrole roster: ${rosterShot} (${roster.items.length} presets, ${unrecorded.length} unrecorded)\ntemplate drawer: ${drawerShot}\ntemplate migration: ${migrationShot}\npanel text: ${panel.text.slice(0, 600)}\n`)
process.exit(passed === results.length ? 0 : 1)
