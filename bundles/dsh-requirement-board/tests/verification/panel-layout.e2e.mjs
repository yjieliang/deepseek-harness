/**
 * Requirement Board — self-contained browser layout gate.
 *
 * The source-level suite (`client-smoke`) proves structure and interaction; it
 * cannot see geometry. This instrument boots its own throwaway Web instance
 * (through a temporary `DSH_HOME`, so the reader's 3080 and profile are never
 * touched), opens the panel in a real browser, and measures what a reader sees:
 * the sticky detail rows, the KPI band, the card status rail, the meta grid, both
 * theme arms, and the two column/breakpoint layouts.
 *
 * Usage: `node tests/verification/panel-layout.e2e.mjs`
 * It needs `playwright` (from the repository root) and a Chromium build; the
 * installed Microsoft Edge is used as the channel when present.
 *
 * Exits 0 when every reading holds, 1 when one fails, 2 when a prerequisite
 * (Playwright, a browser, or the Web instance) is unavailable.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'G:/code/deepseek-harness'
const BUNDLE = join(REPO, 'bundles/dsh-requirement-board')
const DSH_HOME = 'C:/Users/yunda/.dsh'

let failures = 0
let checks = 0
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** One temporary home that mirrors the running profile without sharing it. */
function prepareHome() {
  const home = mkdtempSync(join(tmpdir(), 'rb-layout-gate-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
    copyFileSync(join(DSH_HOME, 'profiles', 'web', file), join(profile, file))
  }
  // A junction, exactly like a linked profile install: resolution follows it.
  const link = join(profile, 'node_modules', 'dsh-requirement-board')
  const mk = spawn('cmd', ['/c', 'mklink', '/J', link, BUNDLE], { stdio: 'ignore' })
  return new Promise((resolve, reject) => {
    mk.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`could not link the bundle into the temporary profile (mklink exit ${code})`))
        return
      }
      mkdirSync(join(home, 'storages'), { recursive: true })
      // The deployment routes the board to SQLite at an absolute path. This overlay
      // points that row into the temporary home, so the isolated instance never
      // opens (or writes) the reader's production database.
      const overlay = join(home, 'gate.overlay.yml')
      writeFileSync(overlay, [
        '- id: storage-sqlite',
        '  config:',
        `    path: ${join(home, 'storages', 'requirement_board.db').replaceAll('\\', '/')}`,
        '    journalMode: wal',
        '- id: storage-domain',
        '  config:',
        '    backend: json',
        '    routes:',
        '      requirement_board: sqlite',
        '',
      ].join('\n'))
      resolve({ home, overlay })
    })
    mk.on('error', reject)
  })
}

/** Boot the throwaway Web instance and return its base URL and token. */
function bootWeb(home, overlay) {
  // `process.execPath` may point at the harness runner's own node build, which is
  // not always on disk under this user; the PATH `node` is the one the repo uses.
  const child = spawn('node', [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    '--profile', 'web', '--patch', overlay, '--no-open', '--port', '0',
  ], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the Web instance did not print its URL in 90s; output: ${output.slice(-400)}`)), 90_000)
    const onData = chunk => {
      output += String(chunk)
      const match = /dsh web: (http:\/\/[^\s?]+)\/\?token=([^\s]+)/.exec(output)
      if (match !== null) {
        clearTimeout(timer)
        resolve({ base: match[1], token: match[2] })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`the Web instance exited early (${code}): ${output.slice(-400)}`))
    })
  })
  return { child, url }
}

/** Resolve Playwright from the repository's Web app manifest. */
async function loadPlaywright() {
  const require = createRequire(join(REPO, 'apps/web/package.json'))
  const playwright = await import(pathToFileURL(require.resolve('playwright')).href)
  return playwright.chromium ?? playwright.default?.chromium
}

/** Log in once so the browser carries the session cookie every route needs. */
async function sessionCookie(base, token) {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookies = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0])
  return cookies.join('; ')
}

/** Read geometry and computed style from the live panel. */
const measure = page => page.evaluate(() => {
  const pick = selector => document.querySelector(selector)
  const style = (selector, pseudo) => {
    const element = pick(selector)
    return element === null ? null : getComputedStyle(element, pseudo ?? undefined)
  }
  const rect = selector => {
    const element = pick(selector)
    if (element === null) return null
    const box = element.getBoundingClientRect()
    return { top: box.top, left: box.left, width: box.width, height: box.height }
  }
  const stats = [...document.querySelectorAll('.rb-stats .rb-stat')]
  const detail = pick('.rb-detail')
  // Count tracks in a computed track list: `minmax(0px, 1fr)` is one track even
  // though its serialization contains a space, so depth-count the parentheses.
  const trackCount = value => {
    let depth = 0
    let count = 1
    for (const character of value) {
      if (character === '(') depth += 1
      else if (character === ')') depth -= 1
      else if (character === ' ' && depth === 0) count += 1
    }
    return count
  }
  return {
    root: pick('.rb-root') !== null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    header: rect('.rb-header'),
    stats: stats.length === 0 ? null : stats.map(element => {
      const box = element.getBoundingClientRect()
      return { top: Math.round(box.top), width: Math.round(box.width) }
    }),
    rail: style('.rb-card', '::before') === null ? null : {
      width: getComputedStyle(pick('.rb-card'), '::before').width,
      color: getComputedStyle(pick('.rb-card'), '::before').backgroundColor,
    },
    metaColumns: style('.rb-meta-grid') === null ? null : trackCount(getComputedStyle(pick('.rb-meta-grid')).gridTemplateColumns),
    metaRaw: style('.rb-meta-grid') === null ? null : getComputedStyle(pick('.rb-meta-grid')).gridTemplateColumns,
    detailScrollable: detail !== null && detail.scrollHeight > detail.clientHeight,
    detailTop: rect('.rb-detail')?.top ?? null,
    idRowTop: rect('.rb-detail-id')?.top ?? null,
    titleVisible: (() => {
      const title = pick('.rb-detail .rb-title')
      if (title === null) return null
      const box = title.getBoundingClientRect()
      return box.top >= 0 && box.bottom <= window.innerHeight
    })(),
    bodyDirection: style('.rb-body') === null ? null : getComputedStyle(pick('.rb-body')).flexDirection,
    accent: style('.rb-root') === null ? null : getComputedStyle(pick('.rb-root')).getPropertyValue('--rb-accent').trim(),
    // The board list is a scrolling flex column: a card that shrank below its
    // content clipped its own chips/date row and left the column nothing to
    // scroll. The gate seeds more rows than fit, then reads both facts.
    listFit: (() => {
      const list = pick('.rb-list')
      const cards = [...document.querySelectorAll('.rb-list .rb-card')]
      if (list === null || cards.length === 0) return null
      return {
        cards: cards.length,
        scrolls: list.scrollHeight > list.clientHeight + 1,
        clipped: cards.filter(card => card.getBoundingClientRect().height + 1 < card.scrollHeight).length,
      }
    })(),
  }
})

const { home, overlay } = await prepareHome()
const { child, url } = bootWeb(home, overlay)
let browser
try {
  const { base, token } = await url
  const chromium = await loadPlaywright()
  const launch = async () => {
    for (const options of [{ channel: 'msedge' }, {}]) {
      try {
        return await chromium.launch(options)
      } catch {
        // Try the next launch shape; a missing channel falls through.
      }
    }
    throw new Error('no Chromium build could be launched (install one with `npx playwright install chromium`)')
  }
  browser = await launch()
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const cookie = await sessionCookie(base, token)
  // The isolated home starts empty; the gate seeds more probe requirements than
  // the list column can show through the same command route the panel uses, so
  // the board lays out as a reader's does (rows, a scrolling list, a selected
  // detail, a flow chart, and somewhere for j/k to go). The instance is
  // destroyed after the run.
  const seedOne = index => fetch(`${base}/api/requirement-board/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: base },
    body: JSON.stringify({
      action: 'create',
      requirement: {
        title: `布局门探针需求 ${index}（临时）`,
        summary: '布局门自检用的临时需求，实例销毁时随之消失。',
        templateId: 'tpl-standard',
      },
    }),
  }).then(async response => ({ ok: response.ok, status: response.status }))
  const SEEDED = 12
  const seeded = cookie === '' ? { ok: false, status: 0 } : await (async () => {
    let last = { ok: false, status: 0 }
    for (let index = 1; index <= SEEDED; index += 1) {
      last = await seedOne(index)
      if (!last.ok) return last
    }
    return last
  })()
  check('the gate seeded its own probe requirements', seeded.ok === true, JSON.stringify(seeded))
  if (cookie !== '') {
    await context.addCookies(cookie.split('; ').map(entry => {
      const at = entry.indexOf('=')
      return { name: entry.slice(0, at), value: entry.slice(at + 1), url: base }
    }))
  }
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => consoleErrors.push(error.message))
  await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
  // A fresh home has not stored its first-run notice version yet, so the shell
  // opens its own dialogs before the panel exists; dismiss them the way a reader
  // would, then open the board.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForTimeout(1200)
    const dialogs = await page.locator('[role="dialog"]').count()
    if (dialogs === 0) break
    await page.keyboard.press('Escape')
  }
  const entry = page.locator('[aria-label*="需求"], [aria-label*="Requirement"]').first()
  await entry.waitFor({ timeout: 30_000 })
  // The overlay layer may still hold a transparent mask; the click target is the
  // entry itself, so dispatch it directly rather than being blocked by the mask.
  await entry.evaluate(element => element.click())
  await page.waitForSelector('.rb-root', { timeout: 30_000 })
  await page.waitForTimeout(1200)
  const leftoverDialogs = await page.locator('[role="dialog"]').count()
  if (leftoverDialogs > 0) await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  const initial = await measure(page)
  check('the panel mounted its own root', initial.root === true)
  check('the top bar is the compact v2 height', initial.header !== null && Math.abs(initial.header.height - 56) <= 1,
    JSON.stringify(initial.header))
  check('the KPI readings form one seven-cell band row',
    initial.stats !== null && initial.stats.length === 7 && new Set(initial.stats.map(cell => cell.top)).size === 1,
    JSON.stringify(initial.stats))
  check('a requirement card carries the 3px status rail',
    initial.rail !== null && initial.rail.width === '3px' && initial.rail.color !== 'rgba(0, 0, 0, 0)',
    JSON.stringify(initial.rail))
  check('the meta grid keeps four columns', initial.metaColumns === 4, String(initial.metaColumns))
  check('the list column scrolls once its cards no longer fit',
    initial.listFit !== null && initial.listFit.scrolls === true,
    JSON.stringify(initial.listFit))
  check('no requirement card clips its own content',
    initial.listFit !== null && initial.listFit.clipped === 0,
    JSON.stringify(initial.listFit))

  // The detail identity/title rows stick while the body scrolls under them.
  const scroll = await page.evaluate(() => {
    const detail = document.querySelector('.rb-detail')
    if (detail === null) return null
    detail.scrollTop = Math.min(240, detail.scrollHeight - detail.clientHeight)
    return { top: detail.scrollTop }
  })
  await page.waitForTimeout(400)
  const scrolled = await measure(page)
  check('the detail pane actually scrolls', scroll !== null && scroll.top > 0, JSON.stringify(scroll))
  check('the requirement id row sticks to the top while scrolling',
    scrolled.idRowTop !== null && scrolled.detailTop !== null && Math.abs(scrolled.idRowTop - scrolled.detailTop) <= 2,
    JSON.stringify({ idRowTop: scrolled.idRowTop, detailTop: scrolled.detailTop }))
  check('the title and actions stay visible while scrolling', scrolled.titleVisible === true)

  // Both palette arms carry their own accent (the platform theme attribute owns
  // the arm; prefers-color-scheme does not select it).
  await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
  await page.waitForTimeout(200)
  const dark = await measure(page)
  await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
  await page.waitForTimeout(200)
  const light = await measure(page)
  check('the dark arm keeps the concept accent', dark.accent === '#f06423', dark.accent)
  check('the light arm keeps its contrast-safe accent', light.accent === '#c2410c', light.accent)

  // Narrow layouts: the split stacks and the meta grid collapses, per the
  // panel's own breakpoints.
  await page.setViewportSize({ width: 860, height: 900 })
  await page.waitForTimeout(300)
  const narrow = await measure(page)
  check('the narrow arm stacks the two columns', narrow.bodyDirection === 'column', String(narrow.bodyDirection))
  check('the narrow arm collapses the meta grid to one column', narrow.metaColumns === 1, JSON.stringify({ inner: narrow.viewport, cols: narrow.metaRaw }))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(300)

  // The keyboard habits, exercised in the real page rather than the stub.
  const before = await page.evaluate(() => document.querySelector('.rb-card-selected')?.getAttribute('data-req') ?? null)
  await page.evaluate(() => document.querySelector('.rb-body')?.focus?.())
  await page.keyboard.press('j')
  await page.waitForTimeout(300)
  const after = await page.evaluate(() => document.querySelector('.rb-card-selected')?.getAttribute('data-req') ?? null)
  check('j moves the selection in the real page', before !== null && after !== null && before !== after, `${before} -> ${after}`)
  await page.keyboard.press('/')
  await page.waitForTimeout(400)
  const searchFocused = await page.evaluate(() => document.activeElement?.getAttribute('name') === 'query')
  check('slash focuses the search field in the real page', searchFocused === true)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const helpCount = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return dialog === null ? 0 : 1
  })
  check('no help dialog is open before asking for it', helpCount === 0)
  await page.keyboard.press('?')
  await page.waitForTimeout(400)
  const helpOpen = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return dialog === null ? null : (dialog.innerText ?? '')
  })
  check('question mark opens the keyboard help', helpOpen !== null && /j/.test(helpOpen), String(helpOpen).slice(0, 80))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  check('the panel logged no console or page errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
} catch (error) {
  console.error(`panel-layout: ${error?.message ?? error}`)
  failures += 1
  checks += 1
} finally {
  await browser?.close().catch(() => {})
  child.kill()
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // Windows can briefly hold the temporary profile's directory junction; the
    // throwaway home lives under %TEMP% and is safe to leave for the OS.
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
