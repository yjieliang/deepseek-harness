#!/usr/bin/env node
/**
 * Independent live check of the `dev.overlay.yml` preset role declarations.
 *
 * What this proves that no in-process test can: the real `dsh web` profile reads
 * the overlay's preset rows, mounts each preset's declaration inside its
 * `isolate: { requirementBoardRole: true }` group, and the *shipped*
 * agent-preset registry reports the whole roster as healthy — and, through two
 * verification-only inserted presets, that the check is live: a declaration whose
 * value is `human` and one published without its realm must both be reported as
 * broken.
 *
 * The roster comes over the product's own wire (`POST /rpc/agentPresets/list`
 * with a browser cookie minted from the launch URL that `dsh web` prints), not
 * from an author-side helper.
 *
 * Usage (from the repository root; ports 3101 and 3102 are used in turn and both
 * servers are stopped before the script exits):
 *   node .artifacts/requirement-board/tests/verification/live-presets.mjs
 *
 * Writes the raw roster of both phases to `live-presets.raw.json` next to this
 * file. Port 3080 is never contacted.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const overlay = resolve(here, '../../dev.overlay.yml')
const isolation = resolve(here, 'live-storage-isolation.overlay.yml')
const negativeHuman = resolve(here, 'negative-human-declaration.overlay.yml')
const negativeUnisolated = resolve(here, 'negative-unisolated-declaration.overlay.yml')

/** The eight presets the web profile ships with the overlay applied. */
const EXPECTED_PRESETS = [
  'standard', 'ptc', 'minimal', 'cordis',
  'godot-review-board', 'godot-game-suite', 'game-mechanics-designer', 'godot-shader-developer',
]

let checks = 0
let failures = 0

/** Assert one condition and record the outcome. */
function check(label, ok, detail = '') {
  checks += 1
  if (ok) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Wait without a busy loop. */
function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

/** Whether something already answers on a loopback port. */
async function portBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

/**
 * Boot one `dsh web` on the given port and wait for its authenticated URL.
 * @returns `{ child, lines, authenticatedUrl }`.
 */
async function startServer(port, patchFiles) {
  // Launcher flags come first: `passThroughOptions` hands every token after the
  // first operand to the booted app, so an app argument placed before `--patch`
  // would stop the launcher from parsing it at all.
  const args = ['dsh', '--profile', 'web']
  for (const file of patchFiles) args.push('--patch', file)
  args.push('--no-open', '--port', String(port))
  const child = spawn('pnpm', args, { cwd: repoRoot, shell: true, windowsHide: true })
  const lines = []
  let authenticatedUrl = null
  const consume = chunk => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() === '') continue
      lines.push(line)
      const match = line.match(/https?:\/\/127\.0\.0\.1:(\d+)\/[^\s]*token=[^\s]*/)
      if (authenticatedUrl === null && match !== null && Number(match[1]) === port) authenticatedUrl = match[0].trim()
    }
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)

  const deadline = Date.now() + 150_000
  while (authenticatedUrl === null && Date.now() < deadline) {
    if (child.exitCode !== null) break
    await sleep(500)
  }
  if (authenticatedUrl === null) {
    const tail = lines.slice(-25).join('\n')
    throw new Error(`dsh web on ${port} printed no authenticated URL within 150s. Output:\n${tail}`)
  }
  return { child, lines, authenticatedUrl }
}

/** Stop one server and every child it spawned. */
async function stopServer(server, port) {
  const pid = server.child.pid
  if (pid !== undefined) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await portBusy(port) === false) return true
    await sleep(500)
  }
  return await portBusy(port) === false
}

/** Exchange the launch token for a browser cookie. */
async function mintCookie(authenticatedUrl) {
  const response = await fetch(authenticatedUrl, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null) throw new Error(`no set-cookie from the launch URL (status ${response.status})`)
  const cookie = setCookie.split(';')[0]
  return { status: response.status, cookie }
}

/** Read the preset roster over the product's RPC channel. */
async function readRoster(port, cookie) {
  const attempts = []
  for (const channel of ['/api/agentPresets/list', '/rpc/agentPresets/list']) {
    // The envelope's `method` must repeat the endpoint the channel was opened
    // for, without the mount prefix; the transport rejects both a bare method
    // name and the prefixed form.
    const endpoint = channel.slice('/api/'.length)
    const response = await fetch(`http://127.0.0.1:${port}${channel}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        cookie,
        host: `127.0.0.1:${port}`,
      },
      // `payload` carries exactly one plain-object `args` field
      // (`packages/api/gateway/src/index.ts:1138-1145`).
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args: {} } }),
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    attempts.push({ channel, status: response.status, body: text.slice(0, 400) })
    if (response.status === 200 && parsed?.result?.ok === true) {
      return { channel, status: response.status, roster: parsed.result.value, attempts }
    }
  }
  return { channel: null, status: attempts.at(-1)?.status ?? 0, roster: null, attempts }
}

/** Summarize one roster for the report. */
function summarize(roster) {
  const presets = Array.isArray(roster?.presets) ? roster.presets : []
  return {
    total: presets.length,
    broken: presets.filter(preset => typeof preset.broken === 'string').length,
    rows: presets.map(preset => ({
      id: preset.id,
      name: preset.name,
      isDefault: preset.isDefault === true,
      broken: typeof preset.broken === 'string' ? preset.broken : null,
    })),
  }
}

const evidence = { positive: null, human: null, unisolated: null }

/** Post one panel command over the live board route. */
async function postCommand(port, cookie, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/requirement-board/command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      cookie,
      host: `127.0.0.1:${port}`,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { status: response.status, parsed, text: text.slice(0, 300) }
}

/**
 * Exercise role management on the live HTTP surface, where the panel is the only
 * writer (§9-A1: `live: 角色 CRUD 只走面板`).
 */
async function checkPanelCrud(port, cookie) {
  const put = await postCommand(port, cookie, {
    action: 'role.put',
    role: { roleId: 'verify-panel-role', roleName: 'Verification panel role', duties: ['panel only'] },
  })
  check('the live panel creates a role', put.status === 200 && put.parsed?.ok === true, JSON.stringify(put))
  const listed = await postCommand(port, cookie, { action: 'role.list' })
  const rows = listed.parsed?.data?.items
  check(
    'the live panel lists the role it created with its manual source',
    listed.status === 200 && Array.isArray(rows) && rows.some(row => row.id === 'verify-panel-role' && row.source === 'manual'),
    JSON.stringify({ status: listed.status, body: listed.text }),
  )
  const human = await postCommand(port, cookie, { action: 'role.put', role: { roleId: 'human', duties: [] } })
  check('the live panel refuses roleId "human" with 409', human.status === 409 && human.parsed?.error?.code === 'invalid-role', JSON.stringify(human))
  const removed = await postCommand(port, cookie, { action: 'role.delete', id: 'verify-panel-role' })
  check('the live panel deletes the role it created', removed.status === 200 && removed.parsed?.ok === true, JSON.stringify(removed))
}

/**
 * Boot one server, read its roster, stop it, and record the raw evidence.
 * @returns `{ summary, read, launchStatus }`, or undefined when the port was busy.
 */
async function runPhase(port, patchFiles, after) {
  if (await portBusy(port)) {
    check(`port ${port} is free before this phase`, false, 'something already answers on it')
    return undefined
  }
  const server = await startServer(port, patchFiles)
  console.log(`  note dsh web printed: ${server.authenticatedUrl.replace(/token=[^\s&]+/, 'token=<redacted>')}`)
  const launch = await mintCookie(server.authenticatedUrl)
  check('the launch URL exchanges its token for a browser cookie', launch.status === 303 && launch.cookie !== '', JSON.stringify(launch))
  const read = await readRoster(port, launch.cookie)
  const summary = summarize(read.roster)
  console.log(`  note roster channel: ${read.channel ?? '(none)'}; attempts: ${JSON.stringify(read.attempts)}`)
  if (after !== undefined) await after(launch.cookie)
  const stopped = await stopServer(server, port)
  check(`the server is stopped and ${port} is free again`, stopped, 'still answering')
  return { summary, read, launchStatus: launch.status, outputTail: server.lines.slice(-15) }
}

/* Phase 1: the author's overlay alone must produce a fully healthy roster. */
console.log('phase 1 — positive control (dev.overlay.yml), port 3101')
{
  const phase = await runPhase(3101, [overlay, isolation], cookie => checkPanelCrud(3101, cookie))
  if (phase !== undefined) {
    const { summary, read, launchStatus, outputTail } = phase
    evidence.positive = { launchStatus, channel: read.channel, ...summary, outputTail }
    check('the live roster answers over the product RPC channel', read.roster !== null && read.channel !== null, JSON.stringify(read.attempts))
    check(
      'the live roster carries all eight shipped presets',
      summary.total === 8 && EXPECTED_PRESETS.every(id => summary.rows.some(row => row.id === id)),
      JSON.stringify(summary.rows.map(row => row.id)),
    )
    check(
      'every preset activates: no preset is broken',
      summary.total === 8 && summary.broken === 0,
      JSON.stringify(summary.rows.filter(row => row.broken !== null)),
    )
    console.log(`  note positive roster: ${JSON.stringify(summary.rows)}`)
  }
}

/* Phase 2: a declaration whose value is refused must make its own preset broken. */
console.log('\nphase 2 — negative control (roleId "human"), port 3102')
if (!existsSync(negativeHuman)) {
  console.log(`  skip: ${negativeHuman} is absent; write it from A1-verification.md §1 to run this phase`)
} else {
  const phase = await runPhase(3102, [overlay, isolation, negativeHuman])
  if (phase !== undefined) {
    const { summary, read } = phase
    evidence.human = { channel: read.channel, ...summary }
    check('the live roster answers over the product RPC channel', read.roster !== null && read.channel !== null, JSON.stringify(read.attempts))
    check('this phase still carries the eight shipped presets', EXPECTED_PRESETS.every(id => summary.rows.some(row => row.id === id)), JSON.stringify(summary.rows.map(row => row.id)))
    const human = summary.rows.find(row => row.id === 'verification-human')
    check(
      'a declaration whose roleId is "human" makes its preset broken for that reason',
      typeof human?.broken === 'string'
        && human.broken.includes('board-role-human')
        && human.broken.includes('"human" is reserved for the human decision-maker'),
      JSON.stringify(human ?? null),
    )
    check(
      'the eight author presets stay healthy, so the failure is attributable to the inserted row',
      EXPECTED_PRESETS.every(id => summary.rows.find(row => row.id === id)?.broken == null),
      JSON.stringify(summary.rows.filter(row => EXPECTED_PRESETS.includes(row.id) && row.broken !== null)),
    )
    console.log(`  note negative roster: ${JSON.stringify(summary.rows)}`)
  }
}

/* Phase 3: a declaration published without its realm must not be accepted. */
console.log('\nphase 3 — negative control (declaration outside its isolate group), port 3102')
if (!existsSync(negativeUnisolated)) {
  console.log(`  skip: ${negativeUnisolated} is absent; write it from A1-verification.md §1 to run this phase`)
} else {
  const phase = await runPhase(3102, [overlay, isolation, negativeUnisolated])
  if (phase !== undefined) {
    const { summary, read } = phase
    evidence.unisolated = { channel: read.channel, ...summary }
    check('the live roster answers over the product RPC channel', read.roster !== null && read.channel !== null, JSON.stringify(read.attempts))
    const unisolated = summary.rows.find(row => row.id === 'verification-unisolated')
    check(
      'a declaration without its isolate group makes its preset broken',
      typeof unisolated?.broken === 'string' && unisolated.broken !== '',
      JSON.stringify(unisolated ?? null),
    )
    // Reported, not asserted: the realm violation can also show up on the presets
    // that declare the same service, and which rows it names is the finding.
    console.log(`  note broken rows in this phase: ${JSON.stringify(summary.rows.filter(row => row.broken !== null))}`)
    console.log(`  note full roster: ${JSON.stringify(summary.rows)}`)
  }
}

writeFileSync(join(here, 'live-presets.raw.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(`raw evidence: ${join(here, 'live-presets.raw.json')}`)
process.exit(failures === 0 ? 0 : 1)
