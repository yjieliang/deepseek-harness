/**
 * Slice-2 acceptance probe: screenshot every reachable board surface and assert
 * what the primitive migration changed in the live DOM.
 *
 * Usage: node rb-ui-probe.mjs <token> <tag>
 * Writes tests/verification/_ui_<tag>-<surface>.png and a JSON report.
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const require = createRequire('C:/code/deepseek-harness/apps/web/package.json')
const pw = await import(pathToFileURL(require.resolve('playwright')).href)
const chromium = pw.chromium ?? pw.default?.chromium

const token = process.argv[2]
const tag = process.argv[3] ?? 'slice2'
const out = 'C:/code/deepseek-harness/.artifacts/requirement-board/tests/verification'
const base = 'http://127.0.0.1:3109'

const browser = await chromium.launch()
const page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })).newPage()
const errors = []
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

const report = { tag, shots: [], checks: {} }
const shot = async name => {
  const path = `${out}/_ui_${tag}-${name}.png`
  await page.screenshot({ path })
  report.shots.push(path.split('/').pop())
}

await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6500)
await page.locator('[aria-label*="需求"], [aria-label*="Requirement"]').first().click()
await page.waitForTimeout(2500)

/** Everything the migration should have changed, read from the live DOM. */
report.checks.dom = await page.evaluate(() => {
  const probe = document.createElement('div')
  probe.style.color = 'var(--dsw-alias-state-error-primary)'
  document.body.appendChild(probe)
  const errorToken = getComputedStyle(probe).color
  probe.remove()
  const root = document.querySelector('.rb-root')
  const buttons = [...(root?.querySelectorAll('button') ?? [])]
  const legacy = buttons.filter(b => /(^|\s)rb-btn(\s|$|-primary|-sm)/.test(b.className))
  const weights = new Set([...root.querySelectorAll('*')].map(el => getComputedStyle(el).fontWeight))
  return {
    errorToken,
    nativeButtons: buttons.filter(b => b.type === 'button').length,
    buttons: buttons.length,
    legacyButtonClasses: legacy.map(b => b.className),
    tags: root?.querySelectorAll('[data-tone]').length ?? 0,
    legacyBadgeClasses: [...(root?.querySelectorAll('[class*="rb-badge"]') ?? [])].map(el => el.className).filter(cls => !cls.includes('rb-badge-group')),
    legacyControlClasses: [...(root?.querySelectorAll('[class*="rb-view"],[class*="rb-check-inline"],[class*="rb-dot"],[class*="rb-input"],[class*="rb-toast"]') ?? [])]
      .map(el => el.className).filter(cls => !String(cls).includes('rb-views')),
    tabClass: root?.querySelector('button[name="view.queue"]')?.className ?? null,
    checkboxes: root?.querySelectorAll('input[type="checkbox"]').length ?? 0,
    checkboxClass: root?.querySelector('input[type="checkbox"]')?.parentElement?.className ?? null,
    stateDots: root?.querySelectorAll('[data-state]').length ?? 0,
    stateDotValue: root?.querySelector('[data-state]')?.getAttribute('data-state') ?? null,
    inputWraps: root === null ? 0 : [...root.querySelectorAll('input')].filter(input => /_wrap_/.test(String(input.parentElement?.className))).length,
    inputs: root?.querySelectorAll('input').length ?? 0,
    fontWeight600: [...weights].includes('600'),
  }
})

for (const [surface, view] of [['board', null], ['queue', 'queue'], ['decisions', 'decisions']]) {
  if (view !== null) {
    await page.locator(`.rb-views button[name="view.${view}"]`).click()
    await page.waitForTimeout(1200)
  }
  await shot(surface)
  report.checks[surface] = await page.evaluate(() => {
    const root = document.querySelector('.rb-root')
    return { controls: root?.querySelectorAll('button,select,input').length ?? 0, text: (root?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 120) }
  })
}

/** Each dialog: open it, read its surface, then let the primitive close it with Escape. */
for (const [name, label] of [['new-requirement', '新建需求'], ['new-template', '新建流程模板'], ['roles', '角色管理']]) {
  await page.locator('button:visible', { hasText: label }).first().click()
  await page.waitForTimeout(1200)
  await shot(`dialog-${name}`)
  report.checks[`dialog-${name}`] = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (dialog === null) return { present: false }
    const danger = dialog.querySelector('.rb-btn-danger')
    const info = element => element === null ? null : {
      color: getComputedStyle(element).color,
      borderColor: getComputedStyle(element).borderColor,
      fontWeight: getComputedStyle(element).fontWeight,
      padding: getComputedStyle(element).padding,
      radius: getComputedStyle(element).borderRadius,
    }
    return {
      present: true,
      className: dialog.className,
      tags: dialog.querySelectorAll('[data-tone]').length,
      nativeButtons: dialog.querySelectorAll('button[type="button"]').length,
      legacyClasses: [...dialog.querySelectorAll('button')].map(b => b.className).filter(c => /rb-btn(-sm|-primary)?(\s|$)/.test(c)),
      firstButton: info(dialog.querySelector('button')),
      dangerButton: info(danger),
      title: dialog.querySelector('h2')?.textContent ?? null,
    }
  })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  report.checks[`dialog-${name}`].escapeClosed = await page.evaluate(() => document.querySelector('[role="dialog"]') === null)
}

report.errors = errors
await browser.close()
writeFileSync(`${out}/_ui_${tag}.json`, JSON.stringify(report, null, 1) + '\n')
console.log(JSON.stringify(report, null, 1) + '\n')
