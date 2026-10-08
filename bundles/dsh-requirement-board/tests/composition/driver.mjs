#!/usr/bin/env node
/**
 * Composition driver for the requirement-board REAL-composition channel.
 *
 * Boots one test-only `cordis.yml` through app-boot's Loader path, drives the
 * assembled host surface, and records every observation in `./report.json` so
 * `tests/loader.mjs` can assert them. It then prints the shared
 * `./cases.mjs` cases for its scenario. The driver decides nothing the runner
 * does not also see: one failing observation must never hide the others.
 *
 * Usage (the runner supplies the isolated cwd, environment, and deadline):
 *   RB_BOARD_STORAGE_ROOT=<dir> node --import tsx/esm driver.mjs <cordis.yml> <scenario>
 *
 * Standalone runs exit non-zero when a hard case fails; the runner sets
 * `RB_BOARD_COMPOSITION_CHILD=1` so its child always exits zero and the verdict
 * stays with the runner, which needs the report either way.
 *
 * Scenarios:
 *   happy                 — the healthy composition: register, create, prompt
 *                           context, browser route, durable unit, disposal.
 *   throwing-store        — the medium's write path fails after the domain
 *                           opened: proves the injected 建档 failure is real,
 *                           and carries the pending "agent creation survives it"
 *                           case.
 *   broken-storage        — the medium cannot be opened at all: the mount-time
 *                           failure that must be loud (LEAD-DECISIONS D11).
 *   uncontained-listener  — the same composition plus a throwing
 *                           `agent/created` listener: the negative control that
 *                           proves the channel detects an uncontained failure.
 *   role-resolution       — the end-to-end role chain: the real `role.js`
 *                           declaration in a preset realm, the stub session and
 *                           preset registries, `agent/created` establishment,
 *                           and the role line in a real prompt assembly.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { A1_STORE_CONTAINMENT_LANDED, evaluateCases } from './cases.mjs'

/** Loader fiber states, mirrored because Cordis's enum has no runtime object. */
const FIBER_STATE_NAMES = { 0: 'pending', 2: 'active', 3: 'failed', 4: 'disposed' }

/** How long the driver waits for the board's asynchronous mount effect. */
const MOUNT_READY_TIMEOUT_MS = 20_000

/** The board's storage-domain unit, named after the routed domain. */
const BOARD_UNIT = 'requirement_board.json'

const configPath = process.argv[2]
const scenario = process.argv[3] ?? 'happy'
if (configPath === undefined) throw new Error('composition driver requires a config path')
if (typeof process.env.RB_BOARD_STORAGE_ROOT !== 'string' || process.env.RB_BOARD_STORAGE_ROOT === '') {
  // A missing value would fall back to the Harness home, so refuse before boot.
  throw new Error('composition driver requires RB_BOARD_STORAGE_ROOT (the composition must never write the Harness home)')
}

/** Run one observation, recording a failure instead of aborting the report. */
async function safely(run) {
  try {
    return await run()
  } catch (error) {
    return { failed: true, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Whether an {@link safely} result failed. */
function failed(result) {
  return typeof result === 'object' && result !== null && result.failed === true
}

/** Wait for one polling interval. */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The uncontained-listener control needs one extra row; every other scenario
 * mounts the checked-in composition unchanged. Relative insert names anchor
 * beside the config file, so the specifier stays local to this directory.
 */
const patches = scenario === 'uncontained-listener'
  ? [{ insert: [{ id: 'throwing-listener', name: './throwing-agent-listener.mjs' }] }]
  : []

/** Capture app-boot's optional-entry warnings, which it writes to stderr. */
const stderrChunks = []
const stderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk, ...rest) => {
  stderrChunks.push(String(chunk))
  return stderrWrite(chunk, ...rest)
}

/** Structured warn/error records, captured through the Cordis logger. */
const loggerRecords = []
/**
 * The probe message proving the capture path works. Without it, an empty
 * `loggerRecords` cannot be told apart from a broken exporter, and every
 * "silent failure" claim in the report would be unfalsifiable.
 */
const LOGGER_CAPTURE_TEXT = 'composition logger capture probe'
let loggerCaptureWorked = false
let bootError = null
let ctx
try {
  ctx = await boot('requirement-board-composition', resolveConfigPath(configPath, process.cwd()), patches, (prepCtx) => {
    // Attached before any config-tree entry mounts, so a plugin's own mount-time
    // warnings are captured too. Level 2 selects warn and error, exactly as
    // app-boot's own diagnostics exporter does.
    const capture = ({ type, name, args }) => {
      const text = args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')
      if (text.includes(LOGGER_CAPTURE_TEXT)) {
        loggerCaptureWorked = true
        return
      }
      if (type !== 'warn' && type !== 'error') return
      loggerRecords.push({ type, name, text })
    }
    prepCtx.logger.exporter({ levels: { default: 2 }, export: capture })
  })
} catch (error) {
  bootError = error instanceof Error ? error.message : String(error)
} finally {
  process.stderr.write = stderrWrite
}

// Emitted after boot settles: app-boot's own startup-diagnostics exporter is
// disposed by then, so the probe reaches this channel's exporter alone instead
// of also landing in the captured startup stderr.
ctx?.logger.warn(LOGGER_CAPTURE_TEXT)

/** Find the board entry in a settled Loader tree. */
function boardEntry(loader) {
  for (const entry of loader.entries()) {
    if (entry.options.id === 'requirement-board') return entry
  }
  return undefined
}

/** Every Loader entry with its activation state and, for a failed one, its reason. */
async function entryReports(loader) {
  const reports = []
  for (const entry of [...loader.entries()]) {
    const state = entry.fiber?.state
    let error = null
    if (state === 3 && entry.fiber !== undefined) {
      const awaited = await safely(() => entry.fiber.await())
      // `fiber.await()` resolves for an active fiber; a rejection carries the reason.
      error = failed(awaited) ? awaited.error : null
    }
    reports.push({
      id: entry.options.id,
      name: entry.options.name,
      state: FIBER_STATE_NAMES[state] ?? String(state),
      error,
    })
  }
  return reports
}

/** Read the registered tool names, or the failure to read them. */
async function readToolNames(tools) {
  const names = await safely(() => tools?.schemas().map(schema => schema.name) ?? null)
  return failed(names) ? { error: names.error } : names
}

/**
 * Wait until the board's asynchronous mount effect settles either way.
 *
 * The plugin's `apply` returns as soon as it registers the effect, and that
 * effect opens the store before it registers anything; boot therefore settles
 * before the board exists. Waiting is recorded rather than hidden: the mount is
 * a lifecycle fact, and a channel that observed too early would report an empty
 * tool table for a healthy plugin.
 * @param loader - settled Loader service.
 * @param tools - the tool registry instance.
 * @returns mount outcome, elapsed wait, and the entry state after the wait.
 */
async function waitForBoardMount(loader, tools) {
  const startedAt = Date.now()
  const entry = boardEntry(loader)
  for (;;) {
    const names = await readToolNames(tools)
    if (Array.isArray(names) && names.includes('requirement_board')) {
      return { mounted: true, waitedMs: Date.now() - startedAt, timedOut: false, entryState: FIBER_STATE_NAMES[entry?.fiber?.state] ?? String(entry?.fiber?.state) }
    }
    if (entry?.fiber?.state === 3) {
      return { mounted: false, entryFailed: true, waitedMs: Date.now() - startedAt, timedOut: false, entryState: 'failed' }
    }
    if (Date.now() - startedAt > MOUNT_READY_TIMEOUT_MS) {
      return { mounted: false, waitedMs: Date.now() - startedAt, timedOut: true, entryState: FIBER_STATE_NAMES[entry?.fiber?.state] ?? String(entry?.fiber?.state) }
    }
    await delay(25)
  }
}

const report = {
  scenario,
  configPath,
  bootError,
  storageRoot: process.env.RB_BOARD_STORAGE_ROOT,
  entries: [],
  mount: null,
  storageBackends: null,
  domainOpen: null,
  faultInjection: null,
  toolNames: null,
  toolCreate: null,
  promptContext: null,
  document: null,
  webServerRegistrations: null,
  warnBeforeRoleDispatch: null,
  roleDispatch: null,
  roleFrames: null,
  rolePrompt: null,
  roleRealmVisibleAtRoot: null,
  roleToolSchema: null,
  roleList: null,
  roleBadAction: null,
  serialThrew: null,
  toolNamesAfterSerial: null,
  afterDispose: { toolNames: null, webServerRegistrations: null, error: null },
  loggerRecords,
  loggerCapture: loggerCaptureWorked,
  stderrChunks,
}

if (ctx !== undefined) {
  const loader = ctx.get('loader')
  const tools = ctx.get('tools')
  const webServer = ctx.get('webServer')

  /** Copy the stub's live route registrations, which disposal empties in place. */
  const readRegistrations = () => webServer?.registrations?.map(record => ({ ...record })) ?? null

  if (loader !== undefined) {
    report.mount = await waitForBoardMount(loader, tools)
    report.entries = await entryReports(loader)
  }
  report.toolNames = await readToolNames(tools)
  // The routing key's evidence: the unit is named after the domain that opened,
  // and the backend that serves it must be registered on the hub.
  report.storageBackends = await safely(() => ctx.get('storage')?.backend?.names?.() ?? null)
  report.domainOpen = await safely(() => ctx.get('storageDomain')?.get('requirement_board') !== undefined)

  // The stub's registration list is live: disposal empties it in place, so every
  // read copies it. A stored reference would serialize the post-disposal state
  // as if the route had never registered.
  report.webServerRegistrations = readRegistrations()

  if (scenario === 'throwing-store') {
    // The 建档 write fault, injected after the domain opened and at the medium
    // itself: a directory occupies the unit path, so the JSON backend's atomic
    // rename over it fails while `open` and the seeded template already
    // succeeded. In-memory state is unaffected, so the board stays mounted and
    // only writes fail.
    const unitPath = join(process.env.RB_BOARD_STORAGE_ROOT, BOARD_UNIT)
    report.faultInjection = await safely(async () => {
      await rm(unitPath, { force: true })
      await mkdir(unitPath, { recursive: true })
      return 'applied'
    })
  }

  if (scenario === 'happy' || scenario === 'throwing-store') {
    const created = await safely(() => tools.execute({
      signal: new AbortController().signal,
      callId: 'composition-create',
      name: 'requirement_board',
      arguments: { action: 'create', title: '组合测试需求', priority: 'high' },
    }))
    report.toolCreate = failed(created)
      ? { error: created.error }
      : {
          isError: Boolean(created.isError),
          text: (created.content ?? []).filter(block => block.type === 'text').map(block => block.text).join(''),
        }
  }

  if (scenario === 'happy') {
    const assembled = await safely(async () => {
      const assembly = await ctx.systemPrompt.assemble()
      return assembly.contexts.find(context => context.name === 'requirement-board') ?? null
    })
    report.promptContext = failed(assembled) ? { error: assembled.error } : assembled

    // Durable evidence on the real medium: the single-layout unit file the JSON
    // backend publishes for the board's domain.
    const document = await safely(async () => {
      const path = join(process.env.RB_BOARD_STORAGE_ROOT, BOARD_UNIT)
      return { path, text: await readFile(path, 'utf8') }
    })
    report.document = failed(document) ? { error: document.error } : document
  }

  if (scenario === 'role-resolution') {
    const agents = ctx.get('agents')
    const dispatch = id => safely(() => ctx.serial('agent/created', { agent: agents.get(id) }))

    // The board's own subscription counts the frames its domain publishes, so the
    // dedupe evidence is the write chain rather than a private return value.
    const frames = []
    ctx.on('domain/changed', change => {
      if (change.domain === 'requirement_board') frames.push(change)
    })

    report.roleDispatch = {
      art: await dispatch('sess-art'),
      standard: await dispatch('sess-standard'),
    }
    const afterFirst = frames.length
    // Identical re-dispatch: the recorded role already matches the resolution, so
    // establishment must write nothing at all.
    report.roleDispatch.repeat = await dispatch('sess-art')
    report.roleFrames = { first: afterFirst, repeat: frames.length - afterFirst }

    const assemble = scope => safely(async () => {
      const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
      return assembly.contexts.find(context => context.name === 'requirement-board')?.text ?? null
    })
    report.rolePrompt = {
      art: await assemble(agents.get('sess-art')),
      standard: await assemble(agents.get('sess-standard')),
      global: await assemble(undefined),
    }

    // The declaration lives in the preset group's realm: the root realm must not
    // see it, which is what makes an unisolated declaration a broken preset.
    report.roleRealmVisibleAtRoot = ctx.get('requirementBoardRole') !== undefined

    report.roleToolSchema = await safely(() => {
      const role = tools.schemas().find(schema => schema.name === 'requirement_role')
      if (role === undefined) return null
      return {
        name: role.name,
        description: role.description,
        parameters: JSON.parse(JSON.stringify(role.parameters ?? null)),
      }
    })
    report.roleList = await safely(async () => {
      const listed = await tools.execute({
        signal: new AbortController().signal,
        callId: 'composition-role-list',
        name: 'requirement_role',
        arguments: { action: 'list' },
      })
      const text = (listed.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
      return { isError: Boolean(listed.isError), value: JSON.parse(text) }
    })
    report.roleBadAction = await safely(async () => {
      const attempted = await tools.execute({
        signal: new AbortController().signal,
        callId: 'composition-role-put',
        name: 'requirement_role',
        arguments: { action: 'put', roleId: 'art' },
      })
      return {
        isError: Boolean(attempted.isError),
        text: (attempted.content ?? []).filter(block => block.type === 'text').map(block => block.text).join(''),
      }
    })
  }

  if (scenario === 'throwing-store') {
    // Snapshot the warn state before this scenario's role dispatch, so the
    // "nothing warned yet" case reads the state it actually observed.
    report.warnBeforeRoleDispatch = { logger: [...loggerRecords], stderr: [...stderrChunks] }
    // A resolvable agent, so `establishRole` really attempts the roles write and
    // fails on the injected medium fault — the failure the listener must contain.
    const agents = ctx.get('agents')
    const established = await safely(() => ctx.serial('agent/created', { agent: agents.get('sess-art') }))
    report.roleDispatch = { art: established }
  }

  if (scenario === 'throwing-store' || scenario === 'uncontained-listener') {
    // The same dispatch agent creation uses: a serial `agent/created` event, so
    // a listener that lets an error escape rejects this call.
    const serial = await safely(() => ctx.serial('agent/created', {
      agent: { id: 'ses_composition_probe' },
      source: 'startup',
    }))
    report.serialThrew = failed(serial) ? serial.error : null
    report.toolNamesAfterSerial = await readToolNames(tools)
  }

  const disposed = await safely(() => ctx.fiber.dispose())
  report.afterDispose.error = failed(disposed) ? disposed.error : null
  report.afterDispose.toolNames = await readToolNames(tools)
  report.afterDispose.webServerRegistrations = readRegistrations()
}

await writeFile(join(process.cwd(), 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

// Standalone use prints the same cases the runner asserts, with its own verdict.
// As the runner's child it only prints: the runner owns the scenario worlds, the
// stage-A1 gate, and the aggregate exit code, and it needs the report even when
// a case fails.
const cases = evaluateCases(report)
let failedCases = 0
console.log(`\ncomposition driver: ${scenario}`)
for (const item of cases) {
  if (item.pending && !A1_STORE_CONTAINMENT_LANDED) {
    console.log(`  PENDING ${item.label}${item.detail === '' ? '' : ` — ${item.detail}`}`)
    continue
  }
  if (item.ok) {
    console.log(`  ok      ${item.label}`)
    continue
  }
  failedCases += 1
  console.log(`  FAIL    ${item.label}${item.detail === '' ? '' : ` — ${item.detail}`}`)
}

// The Loader tree is disposed; exiting explicitly keeps a lingering framework
// handle from turning a recorded failure into a smoke timeout.
if (process.env.RB_BOARD_COMPOSITION_CHILD === '1') process.exit(0)
process.exit(failedCases === 0 ? 0 : 1)
