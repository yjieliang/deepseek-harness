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
import { readFileSync, writeFileSync } from 'node:fs'
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
 * in the source-level smoke checks. The fold and meta-grid readings need a
 * selected requirement; on a board with none they are reported as unmeasured
 * instead of as a defect.
 *
 * The panel carries one accent per palette: `#f06423` for the dark theme and the
 * deeper `#c2410c` for the light arm the platform requires. The running shell's
 * preference is an explicit value, so `prefers-color-scheme` does not select it;
 * the palette is pinned the way the platform's own browser tests pin it, by
 * driving the body attribute the theme runtime owns, and both arms are measured.
 */
await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
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
record(visual.accent === 'rgb(240, 100, 35)', `the accent reaches the panel as the concept's orange under the dark palette (${visual.accent})`)
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
await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
const lightAccent = await page.evaluate(() => {
  const probe = document.createElement('div')
  probe.style.color = 'var(--rb-accent)'
  ;(document.querySelector('.rb-root') ?? document.body).appendChild(probe)
  const accent = getComputedStyle(probe).color
  probe.remove()
  return accent
})
record(lightAccent === 'rgb(194, 65, 12)', `the light palette keeps its own deeper orange (${lightAccent})`)

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
 * 角色管理重做后的五条最小覆盖（DESIGN.md §12.5「控件命名」）：并排两栏、第二层
 * 新建弹窗、职责逐条增删、检索与分组计数、删除确认就地。全部只用 `name`、`role`、
 * 可见文本与 getBoundingClientRect，不碰自造 `data-*`，也不认 CSS-module 类名。
 */
const roleIdOf = name => (name ?? '').replace(/^role\.(remove|edit|confirm|cancel)\./u, '').replace(/\.confirm\.cancel$/u, '')
/**
 * The probe role the duty-entry assertion registers and deletes again. It is a
 * legal id under the Host's own rule (`^[a-z][a-z0-9_-]{0,31}$`, no reserved
 * `tmp-` prefix, not `human`) and names no declared preset, so the registry ends
 * the run as it started.
 */
const probeRoleId = 'gate-role-probe'
/**
 * Submit the second-layer role form the way a reader does: `role.save` is the
 * form's `type="submit"` control. It is disabled while `role.roleId` is empty,
 * so the caller fills a legal id first. A platform build that does not forward
 * `type="submit"` to the native form sends nothing; the caller falls back to
 * `form.requestSubmit()` when no request appeared.
 */
const submitRoleForm = async () => {
  const save = page.locator('[name="role.save"]').first()
  if (await save.count() > 0) await save.click({ timeout: 8000 })
  else await page.evaluate(() => {
    const form = document.querySelector('[name="role.roleId"]')?.form
    if (form !== null && form !== undefined) form.requestSubmit()
  })
}

/**
 * 第 3 条要断言 `role.put` 的请求体，而页面里的 RoleFormDialog 不会把上一次的请求
 * 交出来，因此这里在保存之前把 `window.fetch` 包一层记录：这是真浏览器里唯一能读
 * 到命令体的通道（§12.5 明确写「数组不再按逗号拆分」，只有体里的 `duties` 能证明）。
 */
await page.evaluate(async () => {
  const native = window.fetch.bind(window)
  window.__rbRolePut = []
  window.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input?.href ?? input)
    const method = String(init.method ?? input?.method ?? 'GET').toUpperCase()
    if (/\/api\/requirement-board\/command/u.test(url) && method === 'POST' && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        if (body !== null && typeof body === 'object' && body.action === 'role.put') window.__rbRolePut.push(body)
      } catch { /* 非 JSON 体不是命令请求，忽略 */ }
    }
    return native(input, init)
  }
})

/**
 * The names of the visible role rows inside the roles dialog. Reading every
 * visible button on the page (as this once did) also picks up the sidebar and
 * the dialog's own chrome, and a keyword taken from there filters the role
 * column down to nothing. The `role.remove` anchor is the same anchor the
 * narrowing read counts below, so both readings count the same set of rows.
 * @returns the trimmed name text of each visible role row.
 */
const visibleRoleRowNames = () => {
  const dialog = document.querySelector('[name="role.search"]')?.closest('[role="dialog"]') ?? null
  if (dialog === null) return []
  const visible = node => node.checkVisibility() && node.getBoundingClientRect().height > 0
  return [...dialog.querySelectorAll('[name^="role.remove."]')]
    .map(anchor => anchor.closest('.rb-role-row'))
    .filter((row, index, all) => row !== null && all.indexOf(row) === index && visible(row))
    .map(row => (row.querySelector('.rb-role-name')?.innerText ?? '').trim())
    .filter(text => text !== '')
}

await page.locator('button:visible', { hasText: /角色管理|Roles/ }).first().click({ timeout: 8000 })
await page.waitForTimeout(1500)

/**
 * 第 1 条：并排两栏。栏容器按面板自己声明的结构定位——`.rb-roles-grid` 的直接子元素
 * `.rb-roles-col`——每栏的滚动容器是该栏内的 `.rb-roles-scroll`，这里只判**存在性**。
 * 左栏（角色）只有两行，`scrollHeight 468 == clientHeight 468`，一个存在的容器本来
 * 就不滚动；用 `scrollHeight > clientHeight` 当存在性会把 468/468 读成「没有容器」。
 * 两栏还须矩形不重叠、左在右之前，并各自持有自己的行锚点（左 `role.remove.*`，
 * 右 `preset.register.*`）。
 */
const twoColumns = await page.evaluate(() => {
  const box = node => {
    const rect = node.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
  }
  const style = node => {
    const cs = getComputedStyle(node)
    return { overflowX: cs.overflowX, overflowY: cs.overflowY, visible: node.checkVisibility() }
  }
  const dialog = document.querySelector('[name="role.search"]')?.closest('[role="dialog"]') ?? null
  if (dialog === null) return { error: 'no roles dialog carrying [name="role.search"]' }
  const grid = dialog.querySelector('.rb-roles-grid')
  const anchors = node => ({
    remove: node.querySelectorAll('[name^="role.remove."]').length,
    edit: node.querySelectorAll('[name^="role.edit."]').length,
    register: node.querySelectorAll('[name^="preset.register."]').length,
  })
  const columns = grid === null ? [] : [...grid.children].filter(node => node.classList.contains('rb-roles-col'))
  const left = columns.find(node => anchors(node).register === 0 && anchors(node).remove + anchors(node).edit > 0) ?? null
  const right = columns.find(node => anchors(node).register > 0 && anchors(node).remove === 0 && anchors(node).edit === 0) ?? null
  const leftScroll = left === null ? null : left.querySelector('.rb-roles-scroll')
  const rightScroll = right === null ? null : right.querySelector('.rb-roles-scroll')
  const error = grid === null
    ? 'no .rb-roles-grid in the roles dialog'
    : (columns.length !== 2
      ? `the roles grid holds ${columns.length} .rb-roles-col children`
      : (left === null || right === null ? 'the two columns do not divide into roles and presets by their row anchors' : ''))
  const windowRules = []
  for (const sheet of document.styleSheets) {
    let rules = null
    try { rules = sheet.cssRules } catch { continue }
    for (const rule of rules ?? []) {
      if (rule.cssText?.includes('rb-roles-scroll')) windowRules.push(rule.cssText.slice(0, 200))
    }
  }
  // 打包 CSS 下的旁证：`rb-roles-scroll` 这条源码规则真的进了运行中的样式表。
  window.__rbScrollRules = windowRules
  return {
    error,
    windowRules: windowRules.length,
    roleRows: dialog.querySelectorAll('[name^="role.remove."]').length,
    presetRows: dialog.querySelectorAll('[name^="preset.register."]').length,
    left: left === null ? null : box(left),
    right: right === null ? null : box(right),
    leftStyle: left === null ? null : style(left),
    rightStyle: right === null ? null : style(right),
    leftAnchors: left === null ? null : anchors(left),
    rightAnchors: right === null ? null : anchors(right),
    leftScroll: leftScroll === null ? null : { shared: leftScroll === rightScroll, box: box(leftScroll), style: style(leftScroll) },
    rightScroll: rightScroll === null ? null : { shared: leftScroll === rightScroll, box: box(rightScroll), style: style(rightScroll) },
  }
})
/**
 * An implementation that lacks the two-column anchors answers the reading above
 * with an early `{ error }` object, so every field that only the finished dialog
 * carries is absent. Each such reading is folded to a null (or an explicit gap)
 * first: a missing anchor has to read as one named failure, never as a deref of
 * `undefined` that ends the whole gate before the later assertions are recorded.
 */
const leftScroll = twoColumns.leftScroll ?? null
const rightScroll = twoColumns.rightScroll ?? null
const columnGaps = []
if (typeof twoColumns.error === 'string' && twoColumns.error !== '') columnGaps.push(twoColumns.error)
if (twoColumns.left == null || twoColumns.right == null) columnGaps.push('the two column boxes')
if (leftScroll === null) columnGaps.push('.rb-roles-scroll (no roles column scroller in the reading)')
if (rightScroll === null) columnGaps.push('.rb-roles-scroll (no presets column scroller in the reading)')
if (columnGaps.length > 0) {
  record(false,
    `the roles dialog stands two columns side by side (missing: ${columnGaps.join('; ')}; rows ${String(twoColumns.roleRows)}/${String(twoColumns.presetRows)})`)
} else {
  const noOverlap = twoColumns.left.right <= twoColumns.right.left || twoColumns.right.right <= twoColumns.left.left
    || twoColumns.left.bottom <= twoColumns.right.top || twoColumns.right.bottom <= twoColumns.left.top
  const eachOwnScroller = leftScroll.shared === false && leftScroll.style.visible && rightScroll.style.visible
  const roleAnchors = twoColumns.leftAnchors.remove + twoColumns.leftAnchors.edit > 0 && twoColumns.leftAnchors.register === 0
  const presetAnchors = twoColumns.rightAnchors.register > 0
    && twoColumns.rightAnchors.remove === 0 && twoColumns.rightAnchors.edit === 0
  record(twoColumns.left.left < twoColumns.right.left && noOverlap && eachOwnScroller && roleAnchors && presetAnchors,
    `the roles dialog stands two columns side by side, each its own scroll container (roles ${twoColumns.roleRows}, presets ${twoColumns.presetRows}, scroll ${JSON.stringify(leftScroll.box)}/${JSON.stringify(rightScroll.box)}, anchors ${JSON.stringify(twoColumns.leftAnchors)}/${JSON.stringify(twoColumns.rightAnchors)}, css rules ${String(twoColumns.windowRules)})`)
}

// A missing create action must leave the next reading on a closed-form dialog
// rather than spend the default timeout on a click that can never resolve.
const createRole = page.locator('[name="role.new"], button:visible', { hasText: /新建角色|New role/ }).first()
if (await createRole.count() > 0) await createRole.click({ timeout: 8000 })
await page.waitForTimeout(1200)
const createDialog = await page.evaluate(() => {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')]
  const form = dialogs.find(node => node.querySelector('form [name="role.roleId"]') !== null) ?? null
  const top = form ?? dialogs.at(-1) ?? null
  const title = top === null
    ? ''
    : [...top.querySelectorAll('h1, h2, h3, h4, [role="heading"]')].map(node => node.innerText.trim()).join(' ')
  return { count: dialogs.length, roleIdInputs: [...document.querySelectorAll('form [name="role.roleId"]')].length, title }
})
record(createDialog.count === 2 && createDialog.roleIdInputs === 1 && /新建角色|New role/u.test(createDialog.title),
  `the create role action stacks a second dialog whose form holds role.roleId and names itself (dialogs ${createDialog.count}, ${String(createDialog.roleIdInputs)} form field(s), title "${createDialog.title}")`)

const dutyBefore = await page.evaluate(() => ({
  inputs: document.querySelectorAll('input[name^="role.duty."]').length,
  add: document.querySelector('[name="role.duty.add"]') !== null,
}))
const putsBefore = await page.evaluate(() => (window.__rbRolePut ?? []).length)
if (dutyBefore.add) {
  await page.locator('[name="role.duty.add"]').first().click({ timeout: 8000 })
  await page.waitForTimeout(400)
}
const dutyAfter = await page.evaluate(() => document.querySelectorAll('input[name^="role.duty."]').length)
const dutyText = 'a, b'
if (dutyBefore.add) {
  const dutyInputs = page.locator('input[name^="role.duty."]')
  if (await dutyInputs.count() > 0) {
    await dutyInputs.last().fill(dutyText)
    await page.waitForTimeout(200)
  }
  /**
   * 提交前把 id 填成合法值：`role.save` 在 `role.roleId` 为空时是禁用的，而 Host 的口径
   * 是 `^[a-z][a-z0-9_-]{0,31}$`、不以 `tmp-` 开头、不为 `human`。填不上就只会留下一
   * 次被拒的 put，断言仍按请求体判红。
   */
  const roleIdInput = page.locator('[name="role.roleId"]').first()
  if (await roleIdInput.count() > 0) {
    await roleIdInput.fill(probeRoleId)
    await page.waitForTimeout(200)
  }
  await submitRoleForm()
  const putFired = async () => (await page.evaluate(() => (window.__rbRolePut ?? []).length)) > putsBefore
  if (!await putFired()) {
    // 平台 Button 不保证把 `type="submit"` 透传成原生提交；点完仍没有请求时走表单自己
    // 的提交路径发一次，两次都发不出去时下面按「没有请求」判红。
    await page.evaluate(() => {
      const form = document.querySelector('[name="role.roleId"]')?.form
      if (form !== null && form !== undefined) form.requestSubmit()
    })
  }
  // 断言读的是真请求体，所以等这条 `role.put` 真的发出来，而不是只等一个固定的毫秒。
  await page.waitForFunction(count => (window.__rbRolePut ?? []).length > count, putsBefore, { timeout: 8000 })
    .catch(() => false)
  await page.waitForTimeout(600)
}
const dutySave = await page.evaluate(() => {
  const calls = window.__rbRolePut ?? []
  const body = calls.at(-1) ?? null
  // The panel sends `{ action, role }`; a recorded command body is whatever JSON
  // it sent, so the role payload is read either nested or flat, and spreading a
  // non-iterable `duties` would end the gate instead of failing the assertion.
  const dutiesOf = value => Array.isArray(value) ? [...value] : (typeof value === 'string' ? [...value] : [])
  const role = body === null ? null : (body.role ?? body)
  return {
    calls: calls.length,
    last: role === null
      ? null
      : { action: body.action, roleId: role.roleId ?? null, roleName: role.roleName ?? null, duties: dutiesOf(role.duties) },
    inline: [...document.querySelectorAll('[name^="role.duty."]')]
      .filter(node => node.tagName !== 'INPUT' && node.checkVisibility())
      .map(node => node.innerText.trim()),
    dialogHasText: (document.querySelector('[name="role.search"]')?.closest('[role="dialog"]')?.innerText ?? '').includes('a, b'),
  }
})
// 门自建的探测角色按普通命令删掉，并轮询注册表直到它真的不在列表里，让第 4、5 条读到
// 的是门进来时的那份名册。结果写进下面这条断言的标签，不另开一条判据（判据数保持 63）。
const probeCleaned = dutySave.last?.roleId === probeRoleId
  ? await page.evaluate(async id => {
    const post = async body => {
      const response = await fetch('/api/requirement-board/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return response.json().catch(() => null)
    }
    const removed = await post({ action: 'role.delete', id })
    if (removed?.ok !== true) return false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const listed = await post({ action: 'role.list' })
      if ((listed?.data?.items ?? []).every(record => record.id !== id)) return true
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return false
  }, probeRoleId)
  : false
record(dutyAfter === dutyBefore.inputs + 1 && (dutySave.last?.duties ?? []).includes(dutyText),
  `one duty input is added at a time and a comma stays inside its own entry (inputs ${String(dutyBefore.inputs)}→${String(dutyAfter)}, put ${JSON.stringify(dutySave.last)}, inline ${JSON.stringify(dutySave.inline)}, dialog text ${String(dutySave.dialogHasText)}, probe ${probeRoleId} deleted ${String(probeCleaned)})`)

/**
 * The keyword read needs the role dialog freshly open. A finished implementation
 * closes its own dialogs when the save lands; one that still has the modal open
 * keeps its overlay over the entry, so whatever remains is closed with the
 * Escape this gate already uses for dialogs before the entry is clicked again.
 * A missing entry or search box falls through to the assertion below rather than
 * to a click that can never resolve.
 */
for (let step = 0; step < 2; step += 1) {
  if (await page.locator('[role="dialog"]').count() === 0) break
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
}
const rolesEntry = page.locator('button:visible', { hasText: /角色管理|Roles/ }).first()
if (await page.locator('[role="dialog"]').count() === 0 && await rolesEntry.count() > 0) {
  await rolesEntry.click({ timeout: 8000 })
}
await page.waitForTimeout(1500)
const namesBefore = await page.evaluate(visibleRoleRowNames)
/**
 * The rows the keyword is derived from: one entry per visible role row, with the
 * name text a reader sees, the id its anchor carries, and the row's own text.
 * The search matches a trimmed, case-insensitive substring over a row's id, its
 * display name and its duties — all of which that text contains — so a candidate
 * appearing in exactly one row's text is a candidate that matches exactly one row.
 * A keyword taken from anywhere else (the sidebar, the dialog title) narrows the
 * list to nothing, which proves nothing about narrowing.
 */
const rowsBefore = await page.evaluate(() => {
  const dialog = document.querySelector('[name="role.search"]')?.closest('[role="dialog"]') ?? null
  if (dialog === null) return []
  const visible = node => node.checkVisibility() && node.getBoundingClientRect().height > 0
  return [...dialog.querySelectorAll('[name^="role.remove."]')]
    .map(anchor => anchor.closest('.rb-role-row'))
    .filter((row, index, all) => row !== null && all.indexOf(row) === index && visible(row))
    .map(row => ({
      name: (row.querySelector('.rb-role-name')?.innerText ?? '').trim(),
      id: (row.querySelector('[name^="role.remove."]')?.getAttribute('name') ?? '').replace(/^role\.remove\./u, ''),
      text: (row.innerText ?? '').toLowerCase(),
    }))
})
const searchTerm = rowsBefore
  .map(row => [row.name, row.id].find(value => value !== ''
    && rowsBefore.filter(other => other.text.includes(value.toLowerCase())).length === 1))
  .find(value => value !== undefined) ?? ''
const searchBox = page.locator('[name="role.search"]').first()
if (searchTerm !== '' && await searchBox.count() > 0) {
  await searchBox.fill(searchTerm)
  await searchBox.dispatchEvent('input')
  await page.waitForTimeout(900)
}
const narrowed = await page.evaluate(() => {
  const box = node => {
    const rect = node.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
  }
  const visible = node => node.checkVisibility() && node.getBoundingClientRect().height > 0
  const dialog = document.querySelector('[name="role.search"]')?.closest('[role="dialog"]') ?? null
  if (dialog === null) return { keyword: null, total: 0, sums: [], headerLike: [] }
  const keyword = document.querySelector('[name="role.search"]')?.value ?? null
  const rows = [...dialog.querySelectorAll('[name^="role.remove."]')]
  const visibleRows = rows.filter(visible)
  const total = visibleRows.length
  const groupOf = node => {
    let cursor = node
    for (let up = 0; up < 10 && cursor !== null; up += 1) {
      const parent = cursor.parentElement
      if (parent === null) break
      // `tagName` is upper-case in HTML, so the tag test has to be case-insensitive;
      // a case-sensitive one never finds the panel's real `h3` group head and leaves
      // every group unread (a heading that is there would silently count nothing).
      const heading = [...parent.children].find(child => /^h[1-6]$/iu.test(child.tagName)
        || child.matches?.('[role="heading"]') === true)
      if (heading !== undefined) {
        const text = heading.innerText.trim()
        return {
          text,
          rows: [...parent.querySelectorAll('[name^="role.remove."]')].filter(visible).length,
          // A heading that carries exactly one number run states its count there;
          // a heading with several runs cannot be cut reliably into name and count.
          digits: text.match(/\d+/gu) ?? [],
        }
      }
      cursor = parent
    }
    return null
  }
  const sums = []
  for (const row of visibleRows) {
    const group = groupOf(row)
    if (group === null) continue
    const seen = sums.find(entry => entry.header === group.text)
    if (seen === undefined) sums.push({ header: group.text, rows: group.rows, digits: group.digits })
    else seen.rows = group.rows
  }
  const headerLike = []
  for (const node of dialog.querySelectorAll('*')) {
    const text = node.innerText?.trim() ?? ''
    if (text.length > 40 || !/\d/u.test(text)) continue
    const digits = (text.match(/\d+/gu) ?? []).join('')
    const letters = text.replace(/\d+/gu, '')
    if (digits === '' || letters.length === 0 || letters.length > digits.length + 3) continue
    const rect = box(node)
    for (const row of visibleRows) {
      const rb = box(row)
      if (rb.top >= rect.bottom && rb.top - rect.bottom < 260) headerLike.push({ at: node.tagName, text })
    }
  }
  const rowRects = visibleRows.map(row => ({
    text: row.innerText.trim().slice(0, 24),
    box: box(row),
    marginLeft: Number.parseFloat(getComputedStyle(row).marginLeft),
  }))
  return { keyword, total, sums, headerLike: headerLike.slice(0, 8), rowRects, dialogs: [...document.querySelectorAll('[role="dialog"]')].length }
})
/**
 * The narrowing read holds on three facts: rows remain, the list really got
 * shorter, and every group heading under those rows counts the rows it holds.
 * Where a heading carries exactly one number run — the panel's own `h3` group
 * head does — that number is also read as the count and must equal the rows the
 * group holds, which is stronger than "some heading with a number exists".
 */
const numbersAgree = narrowed.sums.every(entry => entry.digits.length !== 1 || Number(entry.digits[0]) === entry.rows)
const counted = narrowed.total > 0 && narrowed.total < namesBefore.length && narrowed.sums.length > 0
  && narrowed.sums.every(entry => entry.rows === narrowed.total) && numbersAgree
record(counted,
  `a keyword that matches one row narrows the list and each group heading counts the rows it holds (keyword "${searchTerm}", rows ${namesBefore.length}→${String(narrowed.total)}, groups ${JSON.stringify(narrowed.sums)}, digits agree ${String(numbersAgree)})`)

/**
 * 第 5 条的执行点必须先是行本身，所以先按平台真实路径确保角色管理对话框开着：点入口
 * 「角色管理」。若已有 `[role="dialog"]` 却没有 `role.remove` 锚点（第 4 条可能把它留成
 * 关闭状态——改前实现连 Escape 都会关掉整个对话框），先用 Escape 关掉再重开，而不是去点
 * 一个被遮罩挡住的按钮。
 */
const rolesDialogWithRows = () => page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')]
  .some(dialog => dialog.querySelector('[name^="role.remove."]') !== null))
const ensureRolesDialog = async () => {
  if (await rolesDialogWithRows()) return true
  for (let step = 0; step < 3; step += 1) {
    if (await page.locator('[role="dialog"]').count() === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    if (await rolesDialogWithRows()) return true
  }
  const entry = page.locator('button:visible', { hasText: /角色管理|Roles/ }).first()
  if (await entry.count() === 0) return false
  await entry.click({ timeout: 8000 })
  await page.waitForTimeout(1500)
  return rolesDialogWithRows()
}
const rolesDialogReady = await ensureRolesDialog()
const removeNames = rolesDialogReady
  ? await page.evaluate(() => {
    const dialog = document.querySelector('[name="role.search"]')?.closest('[role="dialog"]')
      ?? [...document.querySelectorAll('[role="dialog"]')].find(node => node.querySelector('[name^="role.remove."]') !== null)
      ?? null
    return dialog === null ? [] : [...dialog.querySelectorAll('[name^="role.remove."]')].map(node => node.getAttribute('name'))
  })
  : []
const removeName = removeNames.find(name => /^role\.remove\.[^.]+$/u.test(name ?? '')) ?? ''
// With no removable row there is nothing to click and nothing to read, so that
// gap is what the assertion below records rather than a click timeout.
const removeId = roleIdOf(removeName)
let inPlace = { found: false, missing: '[name^="role.remove."]' }
if (removeName !== '') {
  await page.locator(`[name="${removeName}"]`).first().click({ timeout: 8000 })
  await page.waitForTimeout(700)
  inPlace = await page.evaluate(id => {
    const dialog = document.querySelector('[name="role.search"]')?.closest('[role="dialog"]')
      ?? [...document.querySelectorAll('[role="dialog"]')].find(node => node.querySelector('[name^="role.remove."]') !== null)
      ?? null
    const button = document.querySelector(`[name="role.remove.${id}"]`)
    if (dialog === null || button === null) return { found: false, dialog: dialog !== null, button: button !== null }
    const confirm = dialog.querySelector(`[name="role.confirm.${id}"]`)
    const cancel = dialog.querySelector(`[name="role.confirm.cancel.${id}"]`)
    if (confirm === null) return { found: false, dialog: true, button: true, confirm: false, cancel: cancel !== null }
    // The dialog body is the direct child of the dialog that holds this row; the
    // row is the deepest ancestor of the confirmation that also holds this one
    // `role.remove` anchor and no other row's. A confirmation parked at the body's
    // tail has no such ancestor, so `atBodyTail` reads true there.
    const body = [...dialog.children].find(node => node.contains(button)) ?? null
    let row = null
    for (let node = confirm.parentElement; node !== null && node !== dialog; node = node.parentElement) {
      if (!node.contains(button)) continue
      if (node.querySelectorAll('[name^="role.remove."]').length !== 1) break
      row = node
      break
    }
    const rowBox = row?.getBoundingClientRect() ?? null
    const confirmBox = confirm.getBoundingClientRect()
    return {
      found: true,
      removeName: button.getAttribute('name'),
      rowTag: row?.tagName ?? null,
      rowToBodyDepth: row === null || body === null
        ? -1
        : (() => {
          let depth = 0
          for (let node = row; node !== null && node !== body; node = node.parentElement) depth += 1
          return depth
        })(),
      rowSiblings: row?.parentElement == null ? -1 : row.parentElement.children.length,
      rowText: row === null ? '' : row.innerText.trim().slice(0, 60),
      confirmName: confirm.getAttribute('name'),
      inRow: row !== null && row.contains(confirm),
      inBody: body !== null && body.contains(confirm),
      atBodyTail: row === null || row === body,
      near: rowBox !== null && Math.abs(confirmBox.top - rowBox.top) < rowBox.height + 16,
      bodyTailTag: body?.lastElementChild?.tagName ?? null,
    }
  }, removeId)
}
record(inPlace.found === true && typeof inPlace.confirmName === 'string'
  && inPlace.confirmName.startsWith(`role.confirm.${removeId}`)
  && inPlace.inRow === true && inPlace.atBodyTail === false,
  `the delete confirmation is drawn inside the row it belongs to, not at the dialog body's tail (${JSON.stringify(inPlace)})`)

// Leave no dialog standing: a mask left over the entry would turn the next click
// into an 8s timeout (a crash) instead of the assertion below into an honest fail.
for (let step = 0; step < 3; step += 1) {
  if (await page.locator('[role="dialog"]').count() === 0) break
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
}
await page.waitForTimeout(400)
record(failures.length === 0, `no console error after the role management round trips (${failures.length})`)

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

/**
 * 新建 / 复制表单弹窗（DESIGN.md §14）：真实浏览器里的三条判据。
 *
 * 三条都读实测值，不读源码：①第二层 `[role=dialog]` 的个数与它的宽度档（与角色
 * 表单弹窗同档），以及 `data-modal-autofocus` 是否真的把焦点放进了名称字段；②Esc
 * 属于**表单**而不属于抽屉——按 Esc 后抽屉仍在、草稿还在、确认条出现，丢弃后焦点
 * 回到点开的那个按钮（`document.activeElement`），抽屉的勾选与选中行都还在；③一次
 * 真实拒绝（51 行节点，Host 以 `invalid-argument` 拒绝）落在弹窗内，抽屉里没有同一
 * 句话、也没有应用级 toast。
 */
const openDrawer = async () => {
  const opener = page.locator('.rb-root button:visible', { hasText: /流程模板管理|Templates/ }).first()
  if (await page.locator('.rb-dialog-drawer').count() === 0) {
    await opener.click({ timeout: 8000 })
    await page.waitForTimeout(1400)
  }
}
await openDrawer()
// One filter mark and one picked row, so the last reading can say whether the form
// left the drawer's own state alone.
const archiveBox = page.locator('.rb-dialog-drawer input[type="checkbox"]').first()
if (await archiveBox.count() > 0 && !(await archiveBox.isChecked())) {
  await archiveBox.click({ timeout: 8000 })
  await page.waitForTimeout(1000)
}
const pickedTitle = await page.evaluate(() => (document.querySelector('.rb-template-row-picked')?.innerText ?? '')
  .replace(/\s+/g, ' ').trim())

await page.locator('[name="template.new"]').first().click({ timeout: 8000 })
await page.waitForTimeout(900)
const newForm = await page.evaluate(() => {
  const layers = [...document.querySelectorAll('[role="dialog"]')]
  const top = layers[layers.length - 1] ?? null
  const focus = document.activeElement
  const box = top?.getBoundingClientRect() ?? null
  return {
    layers: layers.length,
    topIsForm: top !== null && top.querySelector('[name="template.new.name"]') !== null,
    topClass: top?.className ?? '',
    width: box === null ? 0 : Math.round(box.width),
    autofocusName: top?.querySelector('[data-modal-autofocus]')?.getAttribute('name') ?? '',
    focusName: focus?.getAttribute('name') ?? '',
    focusInTop: top !== null && focus !== null && top.contains(focus),
    hasCancel: top?.querySelector('[name="template.form.cancel"]') !== null,
    submitType: top?.querySelector('[name="template.create"]')?.getAttribute('type') ?? '',
    requiredHint: (top?.innerText ?? '').includes('名称必填') || (top?.innerText ?? '').includes('A name is required'),
  }
})
record(newForm.layers === 2 && newForm.topIsForm,
  `新建模板开出第二层弹窗：${String(newForm.layers)} 层 [role=dialog]`)
record(newForm.topClass.split(/\s+/u).includes('rb-dialog') && !/rb-dialog-(drawer|wide)/u.test(newForm.topClass)
  && newForm.width === 560 && newForm.submitType === 'submit' && newForm.hasCancel,
  `表单是与角色表单同档的默认宽度（${newForm.topClass} → ${String(newForm.width)}px），提交是真 submit，取消可寻址（${newForm.submitType} / ${String(newForm.hasCancel)}）`)
record(newForm.autofocusName === 'template.new.name' && newForm.focusName === 'template.new.name' && newForm.focusInTop,
  `焦点由层栈放进名称字段（autofocus=${newForm.autofocusName}, activeElement=${newForm.focusName}）`)
record(newForm.requiredHint, '弹窗内说明必填项，而不只是把提交禁掉')

// Esc belongs to the form: it asks first, and the drawer keeps everything.
await page.locator('[name="template.new.name"]').first().fill('面板门草稿')
await page.waitForTimeout(200)
await page.keyboard.press('Escape')
await page.waitForTimeout(700)
const asked = await page.evaluate(() => ({
  layers: document.querySelectorAll('[role="dialog"]').length,
  drawer: document.querySelector('.rb-dialog-drawer') !== null,
  drop: document.querySelector('[name="template.discard.drop"]') !== null,
  keep: document.querySelector('[name="template.discard.keep"]') !== null,
  draft: document.querySelector('[name="template.new.name"]')?.value ?? '',
  text: (document.querySelector('[name="template.new.name"]')?.closest('[role="dialog"]')?.innerText ?? '')
    .replace(/\s+/g, ' '),
}))
record(asked.drawer && asked.layers === 2 && asked.drop && asked.keep,
  `Esc 关的是表单：抽屉仍在（${String(asked.drawer)}），未保存先问（${String(asked.drop)}/${String(asked.keep)}）`)
record(asked.draft === '面板门草稿' && asked.text.includes('未保存'),
  `问的时候草稿一字不动（${JSON.stringify(asked.draft)}）`)
await page.locator('[name="template.discard.keep"]').first().click({ timeout: 8000 })
await page.waitForTimeout(500)
const kept = await page.evaluate(() => ({
  drop: document.querySelector('[name="template.discard.drop"]') !== null,
  draft: document.querySelector('[name="template.new.name"]')?.value ?? '',
}))
record(!kept.drop && kept.draft === '面板门草稿', `继续编辑收回问题、留下草稿（${JSON.stringify(kept.draft)}）`)
await page.locator('[name="template.form.cancel"]').first().click({ timeout: 8000 })
await page.waitForTimeout(500)
await page.locator('[name="template.discard.drop"]').first().click({ timeout: 8000 })
await page.waitForTimeout(900)
const afterDrop = await page.evaluate(() => ({
  layers: document.querySelectorAll('[role="dialog"]').length,
  drawer: document.querySelector('.rb-dialog-drawer') !== null,
  focusName: document.activeElement?.getAttribute('name') ?? '',
  focusText: (document.activeElement?.innerText ?? '').replace(/\s+/g, ' ').trim(),
  archived: document.querySelector('.rb-dialog-drawer input[type="checkbox"]')?.checked ?? null,
  picked: (document.querySelector('.rb-template-row-picked')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
}))
record(afterDrop.layers === 1 && afterDrop.drawer,
  `丢弃后只剩抽屉一层，抽屉没有被表单带走（${String(afterDrop.layers)}）`)
record(afterDrop.focusName === 'template.new' || /新建流程模板|New template/.test(afterDrop.focusText),
  `焦点回到点开表单的那个按钮（activeElement=${afterDrop.focusName || afterDrop.focusText.slice(0, 20)}）`)
record(afterDrop.archived === true && afterDrop.picked === pickedTitle,
  `抽屉的勾选与选中行都还在（archived=${String(afterDrop.archived)}, picked=${JSON.stringify(afterDrop.picked.slice(0, 24))}）`)

// A real refusal lands inside the dialog: 51 node lines are over the Host's limit.
await page.locator('[name="template.new"]').first().click({ timeout: 8000 })
await page.waitForTimeout(800)
await page.locator('[name="template.new.name"]').first().fill('面板门拒绝')
await page.locator('[name="template.new.nodes"]').first().fill(Array.from({ length: 51 }, (_, index) => `节点 ${index + 1}`).join('\n'))
await page.waitForTimeout(300)
const errorsBeforeRefusal = failures.length
await page.locator('[name="template.create"]').first().click({ timeout: 8000 })
await page.waitForTimeout(1600)
const refused = await page.evaluate(() => {
  const top = [...document.querySelectorAll('[role="dialog"]')].at(-1) ?? null
  const drawer = document.querySelector('.rb-dialog-drawer')
  const error = top?.querySelector('[name="template.form.error"]') ?? null
  const message = error?.innerText ?? ''
  return {
    layers: document.querySelectorAll('[role="dialog"]').length,
    error: error !== null,
    message: message.replace(/\s+/g, ' ').trim(),
    inDrawer: (drawer?.innerText ?? '').includes('must hold at most 50 entries'),
    toast: [...document.querySelectorAll('[role="alert"]')].filter(node => top === null || !top.contains(node)).length,
    draft: top?.querySelector('[name="template.new.name"]')?.value ?? '',
    nodes: (top?.querySelector('[name="template.new.nodes"]')?.value ?? '').split('\n').length,
  }
})
const refusalShot = fileURLToPath(new URL('./_template_form_refusal.png', import.meta.url))
await page.screenshot({ path: refusalShot })
record(refused.layers === 2 && refused.error && refused.message.includes('50 entries'),
  `拒绝落在弹窗内（${String(refused.layers)} 层，error=${refused.error}：${refused.message.slice(0, 60)}）`)
record(!refused.inDrawer && refused.toast === 0,
  `抽屉里没有同一句错话、也没有应用级 toast（drawer=${String(refused.inDrawer)}, alert=${String(refused.toast)}）`)
record(refused.draft === '面板门拒绝' && refused.nodes === 51,
  `被拒后草稿仍在（${JSON.stringify(refused.draft)}，${String(refused.nodes)} 行）`)
await page.locator('[name="template.form.cancel"]').first().click({ timeout: 8000 })
await page.waitForTimeout(400)
await page.locator('[name="template.discard.drop"]').first().click({ timeout: 8000 })
await page.waitForTimeout(800)
const provokedRefusal = failures.slice(errorsBeforeRefusal)
record(provokedRefusal.length === 1 && /409/.test(provokedRefusal[0]),
  `被拒的 create 是这一段唯一的控制台错误（${String(provokedRefusal[0]?.slice(0, 60))}）`)
record(failures.length === 2, `两次被门故意触发的拒绝之外没有别的控制台错误（${String(failures.length)}）`)
// Leave the panel as the stroke readings photograph it: drawer closed, no dialog.
await page.keyboard.press('Escape')
await page.waitForTimeout(900)
record(await page.locator('.rb-dialog-drawer').count() === 0,
  'the drawer is closed again before the stroke readings')

/**
 * 按钮描边（DESIGN.md §13）：真实浏览器里的三条判据。
 *
 * 一条描边要「看得见」必须同时满足宽度、样式与非透明颜色，所以三条都由实测读数
 * 判定，而不是读一遍样式表。几何判据同样必要：1px 真 border 加在自动宽度控件上会
 * 让外框长 2px，padding 回补是否算对只有逐控件比对改前读数才能证明。基线读数存在
 * screenshots/stroke-before-readings.json（改动前的同一支探针产出），按 0.1px 精度
 * 比对——那也是基线自己记录的精度。
 */
const errorsBeforeStroke = failures.length
const strokeBaseline = JSON.parse(readFileSync(new URL('../../screenshots/stroke-before-readings.json', import.meta.url), 'utf8'))

const readStrokeButtons = () => {
  const root = document.querySelector('.rb-root')
  const dialogs = [...document.querySelectorAll('[role="dialog"]')]
  const nodes = [...(root ?? document.body).querySelectorAll('button')]
  for (const dialog of dialogs) for (const node of dialog.querySelectorAll('button')) if (!nodes.includes(node)) nodes.push(node)
  return nodes.map((node) => {
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    return {
      key: `${node.getAttribute('name') ?? ''}|${(node.textContent ?? '').trim().slice(0, 24)}|${node.closest('[role="dialog"]') !== null ? 'dialog' : 'panel'}`,
      cls: [...node.classList],
      borderWidth: style.borderTopWidth,
      borderStyle: style.borderTopStyle,
      borderColor: style.borderTopColor,
      width: +rect.width.toFixed(1),
      height: +rect.height.toFixed(1),
    }
  })
}

const closeEveryDialog = async () => {
  for (let step = 0; step < 3; step += 1) {
    if (await page.locator('[role="dialog"]').count() === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
  }
  await page.waitForTimeout(300)
}

const setStrokePalette = (dark) => page.evaluate((on) => {
  if (on) document.body.setAttribute('data-ds-dark-theme', '')
  else document.body.removeAttribute('data-ds-dark-theme')
}, dark)

await closeEveryDialog()
await setStrokePalette(false)
await page.waitForTimeout(400)
const strokeRest = await page.evaluate(readStrokeButtons)

await page.locator('button:visible', { hasText: /角色管理|Roles/ }).first().click({ timeout: 8000 })
await page.waitForTimeout(1500)
const strokeLight = await page.evaluate(readStrokeButtons)
await setStrokePalette(true)
await page.waitForTimeout(400)
const strokeDark = await page.evaluate(readStrokeButtons)
await setStrokePalette(false)
await page.waitForTimeout(300)

const visible = (button) => button !== undefined && button.borderWidth === '1px' && button.borderStyle === 'solid'
  && button.borderColor !== 'rgba(0, 0, 0, 0)' && button.borderColor !== 'transparent'
const byClass = (buttons, token) => buttons.filter((button) => button.cls.includes(token))
const panelButton = strokeLight.find((button) => button.key.startsWith('refresh|'))
const dialogButton = strokeLight.find((button) => button.key.startsWith('role.new|'))
const darkPanelButton = strokeDark.find((button) => button.key.startsWith('refresh|'))
const darkDialogButton = strokeDark.find((button) => button.key.startsWith('role.new|'))
record(visible(panelButton) && visible(darkPanelButton),
  `a panel Button carries a visible 1px stroke in both themes (${String(panelButton?.borderWidth)} ${String(panelButton?.borderColor)} / ${String(darkPanelButton?.borderColor)})`)
record(visible(dialogButton) && visible(darkDialogButton),
  `a portaled dialog Button carries a visible 1px stroke in both themes (${String(dialogButton?.borderWidth)} ${String(dialogButton?.borderColor)} / ${String(darkDialogButton?.borderColor)})`)
const primaryButtons = [...byClass(strokeLight, 'rb-btn-primary-stroke'), ...byClass(strokeDark, 'rb-btn-primary-stroke')]
const dangerButtons = [...byClass(strokeLight, 'rb-btn-danger'), ...byClass(strokeDark, 'rb-btn-danger')]
record(primaryButtons.length >= 8 && primaryButtons.every(visible),
  `every primary Button that keeps the platform fill is stroked in both themes (${primaryButtons.length} read, ${primaryButtons.filter((button) => !visible(button)).length} not visible)`)
record(dangerButtons.length >= 2 && dangerButtons.every(visible),
  `every danger Button is stroked (${dangerButtons.length} read, ${dangerButtons.filter((button) => !visible(button)).length} not visible)`)

// Four states, in both themes, measured without firing the control: the mouse is
// pressed on the button and released on an inert area (the dialog header, or the
// top bar's own brand block), so a control that opens another modal never does.
const releasePoint = async (kind) => {
  const box = kind === 'dialog'
    ? await page.locator('[role="dialog"]').first().boundingBox()
    : await page.locator('.rb-header').first().boundingBox()
  return kind === 'dialog'
    ? { x: box.x + box.width / 2, y: box.y + 8 }
    : { x: box.x + 4, y: box.y + box.height - 4 }
}
const probeStrokeStates = async (targets, kind) => {
  const out = {}
  for (const [name, selector] of targets) {
    const locator = page.locator(selector).first()
    if (await locator.count() === 0) { out[name] = null; continue }
    const read = () => locator.evaluate((node) => {
      const style = getComputedStyle(node)
      return {
        borderWidth: style.borderTopWidth,
        borderStyle: style.borderTopStyle,
        borderColor: style.borderTopColor,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineTopColor,
        focusVisible: node.matches(':focus-visible'),
      }
    })
    const entry = { default: await read() }
    await locator.hover()
    await page.waitForTimeout(120)
    entry.hover = await read()
    const box = await locator.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(120)
    entry.active = await read()
    const release = await releasePoint(kind)
    await page.mouse.move(release.x, release.y)
    await page.mouse.up()
    await page.waitForTimeout(120)
    await page.keyboard.press('Tab')
    await page.evaluate((sel) => document.querySelector(sel).focus(), selector)
    await page.waitForTimeout(120)
    entry.focus = await read()
    if (entry.focus.focusVisible !== true) {
      for (let step = 0; step < 80; step += 1) {
        await page.keyboard.press('Tab')
        if (await page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector)) break
      }
      await page.waitForTimeout(120)
      entry.focus = await read()
    }
    out[name] = entry
  }
  return out
}

const panelStates = {}
const dialogStates = {}
await closeEveryDialog()
for (const palette of [false, true]) {
  await setStrokePalette(palette)
  await page.waitForTimeout(300)
  Object.assign(panelStates, palette ? { dark: await probeStrokeStates([['panel.ghost.sm', '[name="refresh"]']], 'panel') } : { light: await probeStrokeStates([['panel.ghost.sm', '[name="refresh"]']], 'panel') })
}
await closeEveryDialog()
await setStrokePalette(false)
await page.locator('button:visible', { hasText: /角色管理|Roles/ }).first().click({ timeout: 8000 })
await page.waitForTimeout(1500)
for (const palette of [false, true]) {
  await setStrokePalette(palette)
  await page.waitForTimeout(300)
  const targets = [
    ['dialog.ghost.md', 'button[name="role.new"]'],
    ['dialog.danger.sm', 'button[name^="role.remove."]'],
  ]
  Object.assign(dialogStates, palette ? { dark: await probeStrokeStates(targets, 'dialog') } : { light: await probeStrokeStates(targets, 'dialog') })
}
const everyState = [...Object.values(panelStates), ...Object.values(dialogStates)]
  .flatMap((palette) => Object.values(palette))
const stateCount = everyState.length + everyState.reduce((sum, entry) => sum + (entry === null ? 0 : 0), 0)
const statesHeld = everyState.every((entry) => entry !== null
  && ['default', 'hover', 'active', 'focus'].every((state) => entry[state].borderWidth === '1px'
    && entry[state].borderStyle === 'solid' && entry[state].borderColor !== 'rgba(0, 0, 0, 0)'))
record(statesHeld && stateCount === 6, `the stroke survives hover, active, and focus-visible on ${stateCount} representative controls in both themes (${JSON.stringify(Object.fromEntries(everyState.filter((entry) => entry !== null).map((entry) => [`${entry.default.borderColor}`, `${entry.hover.borderColor}/${entry.active.borderColor}/${entry.focus.borderColor}`])))} )`)
const ringKept = everyState.every((entry) => entry === null
  || (entry.focus.focusVisible === true && entry.focus.outlineWidth === '2px' && entry.focus.outlineColor !== 'rgba(0, 0, 0, 0)'))
record(ringKept, 'the keyboard focus ring stays the platform\'s own, next to the stroke rather than instead of it')

// Geometry: the delivered tree against the recorded pre-change readings, control
// by control and view by view. A single control whose padding compensation is
// wrong fails this, which is what makes the padding bookkeeping checkable.
const geometryDifferences = []
const geometryCounts = {}
for (const [view, buttons] of [['rest', strokeRest], ['light', strokeLight], ['dark', strokeDark]]) {
  const before = new Map()
  for (const button of strokeBaseline[view].buttons) {
    const key = `${button.name}|${button.text}|${button.inDialog ? 'dialog' : 'panel'}`
    before.set(key, [...(before.get(key) ?? []), button])
  }
  const after = new Map()
  for (const button of buttons) after.set(button.key, [...(after.get(button.key) ?? []), button])
  let compared = 0
  let identical = 0
  for (const [key, entries] of before) {
    const live = after.get(key) ?? []
    if (live.length !== entries.length) {
      geometryDifferences.push(`${view} ${key}: ${entries.length} controls before, ${live.length} now`)
      continue
    }
    for (let index = 0; index < entries.length; index += 1) {
      compared += 1
      const width = +(live[index].width - entries[index].width).toFixed(1)
      const height = +(live[index].height - entries[index].height).toFixed(1)
      if (width === 0 && height === 0) identical += 1
      else geometryDifferences.push(`${view} ${key}: ${entries[index].width}×${entries[index].height} -> ${live[index].width}×${live[index].height}`)
    }
  }
  geometryCounts[view] = `${identical}/${compared}`
}
const geometryCompared = Object.values(geometryCounts).reduce((sum, entry) => sum + Number(entry.split('/')[1]), 0)
record(geometryDifferences.length === 0 && geometryCompared >= 100,
  `every control keeps its pre-change outer box (${JSON.stringify(geometryCounts)} at 0.1px; ${geometryDifferences.slice(0, 4).join(' | ')})`)

await closeEveryDialog()
await setStrokePalette(false)
await page.waitForTimeout(300)
record(failures.length === errorsBeforeStroke, `the stroke round trips add no console error (${failures.length - errorsBeforeStroke})`)

/**
 * §15：portal 出来的弹层是否真的拿到面板的语义色。
 *
 * §13.6 第 3 条只把 `--rb-accent-strong` 补到主题载体，本条要修的其余四个变量
 * 同样只声明在 `.rb-root`，而平台把 Dialog portal 到 `.rb-root` 之外：`var()` 取
 * 不到值，border 落回 currentColor、background 变成 transparent。三条判据都读计算
 * 值，并且先确认目标元素确实在 `.rb-root` 之外——否则测到的不是 portal 表面；两主
 * 题各读一遍，强调线色取同一空间里 `var(--rb-accent-line)` 自己的解析值来比，不按主
 * 题名猜色值。这里唯一触发的真实拒绝（51 行节点超过 Host 的 50 节点上限）不写盘。
 */
const errorsBeforePortal = failures.length
const PORTAL_PALETTES = [['light', false], ['dark', true]]
// 主题载体上的强调线色，逐主题写死：元素必须解析到这个字面值，而不是解析到自己的
// currentColor（改前的表现）或某个被改坏的值。同一份字面值也由源码门钉住。
const PORTAL_LINE = { light: 'rgba(194, 65, 12, 0.35)', dark: 'rgba(240, 100, 35, 0.35)' }

/** 一次读三样：颜色目标的计算值、它们是否在 `.rb-root` 之外，以及同空间的变量值与字族。 */
const readPortalColours = () => {
  const space = () => document.querySelector('[role="dialog"]') ?? document.body
  const resolve = (expression) => {
    const probe = document.createElement('div')
    probe.style.color = expression
    space().appendChild(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }
  /** 同空间里某个字族声明的计算值，作为消费方的比对基准而不是按主题猜字体名。 */
  const family = (declaration) => {
    const probe = document.createElement('div')
    if (declaration !== '') probe.style.fontFamily = declaration
    space().appendChild(probe)
    const value = getComputedStyle(probe).fontFamily
    probe.remove()
    return value
  }
  const read = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const style = getComputedStyle(node)
    return {
      inRoot: node.closest('.rb-root') !== null,
      inDialog: node.closest('[role="dialog"]') !== null,
      borderColor: style.borderTopColor,
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
    }
  }
  const readFont = (selector) => {
    // 同一个类可能面板里有一份、弹层里也有一份（`.rb-en` 就是：面板的版本标签和抽屉
    // 各一份），所以先在弹层里按顺序找，找不到才退回整篇文档读——面板内的
    // `.rb-stat-value` 就是这样读到的。否则会把面板那份当成弹层那份来判。
    const portaled = [...document.querySelectorAll('[role="dialog"]')]
      .map(dialog => dialog.querySelector(selector)).find(node => node !== null) ?? null
    const node = portaled ?? document.querySelector(selector)
    if (node === null) return null
    const style = getComputedStyle(node)
    return {
      inRoot: node.closest('.rb-root') !== null,
      inDialog: node.closest('[role="dialog"]') !== null,
      fontFamily: style.fontFamily,
      fontVariantNumeric: style.fontVariantNumeric,
    }
  }
  return {
    accentLine: resolve('var(--rb-accent-line)'),
    formError: read('.rb-form-error'),
    roleRowEditing: read('.rb-role-row-editing'),
    templateRowPicked: read('.rb-template-row-picked'),
    brandFamily: family('var(--dsw-font-family-brand)'),
    uiFamily: family('var(--dsw-font-family)'),
    numeric: {
      dutyCount: readFont('.rb-duty-count'),
      groupN: readFont('.rb-group-n'),
      enTag: readFont('.rb-en'),
      statValue: readFont('.rb-stat-value'),
    },
  }
}

/** 关掉弹层：先丢掉草稿再关，否则草稿确认条会把层留在屏上。 */
const closePortalLayers = async () => {
  for (let step = 0; step < 4; step += 1) {
    if (await page.locator('[role="dialog"]').count() === 0) break
    const drop = page.locator('[name="template.discard.drop"], [name="role.discard.drop"]')
    if (await drop.count() > 0) await drop.first().click({ timeout: 5000 }).catch(() => {})
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(800)
  }
  await page.waitForTimeout(300)
}

const portalReadings = { role: {}, template: {} }
for (const [palette, dark] of PORTAL_PALETTES) {
  await closePortalLayers()
  await setStrokePalette(dark)
  await page.waitForTimeout(300)
  await page.locator('button:visible', { hasText: /角色管理|Roles/ }).first().click({ timeout: 8000 })
  await page.waitForTimeout(1500)
  const edit = page.locator('[role="dialog"] button[name^="role.edit."]').first()
  if (await edit.count() > 0) {
    await edit.click({ timeout: 8000 })
    await page.waitForTimeout(1300)
  }
  portalReadings.role[palette] = await page.evaluate(readPortalColours)
  await closePortalLayers()
  await page.locator('button:visible', { hasText: /流程模板管理|Templates/ }).first().click({ timeout: 8000 })
  await page.waitForTimeout(1500)
  const row = page.locator('.rb-template-row').first()
  if (await row.count() > 0) {
    await row.click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1000)
  }
  const entry = page.locator('[name="template.new"]').first()
  if (await entry.count() > 0) {
    await entry.click({ timeout: 8000 })
    await page.waitForTimeout(1100)
    await page.locator('[name="template.new.name"]').first().fill('面板门 portal 读数').catch(() => {})
    await page.locator('[name="template.new.nodes"]').first()
      .fill(Array.from({ length: 51 }, (_, index) => `节点 ${index + 1}`).join('\n')).catch(() => {})
    await page.locator('[name="template.create"]').first().click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1800)
  }
  portalReadings.template[palette] = await page.evaluate(readPortalColours)
}
await closePortalLayers()
await setStrokePalette(false)
await page.waitForTimeout(300)

const outOfRoot = (target) => target !== null && target.inRoot === false
/** A非透明、且红通道占优——`rgba(...)` 与 `color(srgb ...)` 两种序列化都读得出。 */
const errorHued = (colour) => {
  if (colour === 'rgba(0, 0, 0, 0)' || colour === 'transparent') return false
  const channels = (String(colour).match(/[\d.]+/gu) ?? []).map(Number)
  if (channels.length < 3) return false
  return channels[0] > channels[1] && channels[0] > channels[2]
}
const portalReport = (palette) => {
  const reading = portalReadings.template[palette]
  return `${palette}: error=${String(reading.formError?.backgroundColor)} (inRoot=${String(reading.formError?.inRoot)}) role=${String(portalReadings.role[palette].roleRowEditing?.borderColor)} picked=${String(reading.templateRowPicked?.borderColor)} line=${reading.accentLine}`
}
record(PORTAL_PALETTES.every(([palette]) => {
  const target = portalReadings.template[palette].formError
  return outOfRoot(target) && target.inDialog === true && errorHued(target.backgroundColor)
}), `portal 出来的错误块在弹层里取到非透明的错误色 tint（${PORTAL_PALETTES.map(([palette]) => portalReport(palette)).join(' | ')}）`)
record(PORTAL_PALETTES.every(([palette]) => {
  const reading = portalReadings.role[palette]
  const target = reading.roleRowEditing
  return outOfRoot(target) && target.inDialog === true
    && target.borderColor === reading.accentLine && target.borderColor === PORTAL_LINE[palette]
    && target.boxShadow !== 'none'
}), `被表单寻址的角色行在弹层里取到该主题的强调线（${PORTAL_PALETTES.map(([palette]) => portalReport(palette)).join(' | ')}）`)
record(PORTAL_PALETTES.every(([palette]) => {
  const reading = portalReadings.template[palette]
  const target = reading.templateRowPicked
  return outOfRoot(target) && target.inDialog === true
    && target.borderColor === reading.accentLine && target.borderColor === PORTAL_LINE[palette]
    && target.boxShadow !== 'none'
}), `抽屉的选中行在弹层里取到该主题的强调线（${PORTAL_PALETTES.map(([palette]) => portalReport(palette)).join(' | ')}）`)
record(failures.length - errorsBeforePortal <= 2,
  `portal 读数这一段只留下自己故意触发的拒绝（${failures.length - errorsBeforePortal} 条：${failures.slice(errorsBeforePortal, errorsBeforePortal + 2).map(line => line.slice(0, 60)).join(' | ')}）`)

/**
 * §16：同族剩下八个变量在弹层里的解析，以及数字字族的字体回退。
 *
 * §15 只补了被点名的四个颜色变量。本条的修法沿用同一条先例——只写主题载体两臂——但
 * 覆盖面按「弹层里真的有消费方」决定：实测六个弹层表面里只有 `--rb-num` 有实例（角色
 * 表单弹窗的职责计数 `.rb-duty-count`、角色管理对话框左栏的分组计数 `.rb-group-n`、
 * 模板抽屉的版本标签 `.rb-en`）；其余七个（`--rb-mono`、三个 tint、两个 violet、
 * `--rb-accent-fill`、`--rb-on-accent`）在弹层里没有任何元素消费它，按需求第 3 条不补，
 * 逐条理由见 DESIGN.md §16.5。
 *
 * 字体解析不能拿同一个变量跟自己比：`--rb-num` 缺值时这条声明在计算值阶段失效，
 * `font-family` 回落成继承值，而弹层继承的正好是平台 UI 族。所以判据同时读三样——弹层
 * 空间里一个显式写 `var(--dsw-font-family-brand)` 的参照、同一空间的
 * `var(--dsw-font-family)`、以及消费方自己——并要求消费方等于品牌族且不等于 UI 族；
 * 「两个参照本来就可区分」单独记一条，否则这条判据没有意义。这一段不触发任何新的拒绝。
 */
const errorsBeforeNumeric = failures.length
const numericReport = (state, palette, key) => {
  const reading = portalReadings[state][palette]
  const target = reading.numeric[key]
  if (target === null) return `${palette}: absent`
  return `${palette}: ${target.inDialog ? 'dialog' : 'no-dialog'}${target.inRoot ? '/in-root' : '/portal'} ${target.fontFamily.slice(0, 42)}${target.fontFamily === reading.brandFamily ? ' = brand' : ' != brand'}`
}
const NUMERIC_CONSUMERS = [
  { state: 'role', key: 'dutyCount', what: '角色表单弹窗的职责计数', tabular: true },
  { state: 'role', key: 'groupN', what: '角色管理对话框的分组计数', tabular: false },
  { state: 'template', key: 'enTag', what: '模板抽屉的版本标签', tabular: false },
]
record(PORTAL_PALETTES.every(([palette]) => {
  const reading = portalReadings.role[palette]
  return (reading.brandFamily ?? '') !== '' && (reading.uiFamily ?? '') !== '' && reading.brandFamily !== reading.uiFamily
}), `同一弹层空间里的品牌族与平台 UI 族本来就可区分（${PORTAL_PALETTES.map(([palette]) => `${palette}: ${String(portalReadings.role[palette].brandFamily).slice(0, 30)} vs ${String(portalReadings.role[palette].uiFamily).slice(0, 24)}`).join(' | ')}）`)
for (const entry of NUMERIC_CONSUMERS) {
  record(PORTAL_PALETTES.every(([palette]) => {
    const reading = portalReadings[entry.state][palette]
    const target = reading.numeric[entry.key]
    return target !== null && outOfRoot(target) && target.inDialog === true
      && target.fontFamily === reading.brandFamily && target.fontFamily !== reading.uiFamily
      && (!entry.tabular || target.fontVariantNumeric === 'tabular-nums')
  }), `${entry.what}在弹层里取到载体上的数字字族（${PORTAL_PALETTES.map(([palette]) => numericReport(entry.state, palette, entry.key)).join(' | ')}）`)
}
record(PORTAL_PALETTES.every(([palette]) => {
  const reading = portalReadings.template[palette]
  const target = reading.numeric.statValue ?? portalReadings.role[palette].numeric.statValue
  return target !== null && target.inRoot === true && target.fontFamily === reading.brandFamily
}), `面板内的读数字面零回归，仍取品牌族（${PORTAL_PALETTES.map(([palette]) => `${palette}: ${String((portalReadings.template[palette].numeric.statValue ?? portalReadings.role[palette].numeric.statValue)?.fontFamily).slice(0, 42)}`).join(' | ')}）`)
record(failures.length === errorsBeforeNumeric,
  `数字字族的读数这一段不产生新的控制台错误（${failures.length - errorsBeforeNumeric} 条：${failures.slice(errorsBeforeNumeric).map(line => line.slice(0, 60)).join(' | ')}）`)

const shotPath = fileURLToPath(new URL('./_panel_render.png', import.meta.url))
await page.screenshot({ path: shotPath })
await browser.close()

if (failures.length > 0) for (const line of failures.slice(0, 8)) console.log(`  - ${line.slice(0, 300)}`)
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed  (screenshot: ${shotPath})`)
writeFileSync(new URL('./_panel_render.txt', import.meta.url), `${passed}/${results.length} checks passed\n${failures.join('\n')}\npanel controls: ${panel.controls}\ndanger colour: ${String(danger.color)} vs token ${danger.token}\nrole roster: ${rosterShot} (${roster.items.length} presets, ${unrecorded.length} unrecorded)\ntemplate drawer: ${drawerShot}\ntemplate migration: ${migrationShot}\npanel text: ${panel.text.slice(0, 600)}\n`)
process.exit(passed === results.length ? 0 : 1)
