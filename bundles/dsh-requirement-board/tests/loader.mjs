#!/usr/bin/env node
/**
 * REAL-composition runner for `dsh-requirement-board`.
 *
 * `packages/AGENTS.md` requires a product-visible plugin to have a non-unit test
 * that boots a test-only `cordis.yml` through the Loader and app/process, mocks
 * only external or nondeterministic inputs, and asserts model-visible, durable,
 * or user-visible output. This runner is that channel for the requirement board:
 * it launches `tests/composition/driver.mjs` as a child process through
 * `@deepseek-ai/dsh-loader-smoke` (the same harness
 * `packages/shell/tool-pwsh/tests/loader.spec.ts` uses), then asserts the
 * driver's recorded observations.
 *
 * Run from the checkout root:
 *
 *   node --import tsx/esm .artifacts/requirement-board/tests/loader.mjs
 *
 * `--import tsx/esm` is the repository's source-launch hook: it resolves the
 * driver's workspace imports through tsconfig `paths`, because this artifact
 * directory is not a pnpm workspace member.
 *
 * The assertion cases live in `./composition/cases.mjs`, shared with the driver
 * so a standalone run reports the same cases this runner does.
 *
 * No network, no HTTP listener, no Harness-home writes: the board document lives
 * in a temporary directory per scenario, and the `webServer` service is a stub.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '../../../packages/test-support/loader-smoke/src/index.ts'
import { A1_STORE_CONTAINMENT_LANDED, evaluateCases } from './composition/cases.mjs'

const driver = fileURLToPath(new URL('./composition/driver.mjs', import.meta.url))
const configPath = fileURLToPath(new URL('./composition/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

/**
 * The stub session roster every scenario boots with. The board resolves a
 * session's own role from the stub registries, so the roles table is exercised
 * on the real `agent/created` path without creating a session.
 * - `art` carries the declaration mounted by the composition's preset realm;
 * - `standard` has no declaration, so its preset id is the fallback role and its
 *   duties stay empty (`dutiesMissing`);
 * - `ghost-preset` is deliberately never established, so the id is in use but
 *   unrecorded (`unregistered`).
 */
const STUB_AGENTS = [
  { id: 'sess-art', presetId: 'art', status: 'idle' },
  { id: 'sess-standard', presetId: 'standard', status: 'running' },
  { id: 'sess-ghost', presetId: 'ghost-preset', status: 'idle' },
]

/** Environment the stub registries read; identical for every scenario. */
const STUB_ENV = { RB_BOARD_STUB_AGENTS: JSON.stringify(STUB_AGENTS) }

/**
 * Per-scenario world state. Only the storage root and the injected medium fault
 * differ between scenarios; the composition itself is the checked-in
 * `composition/cordis.yml` for all of them.
 */
const WORLDS = {
  happy: { storageRoot: cwd => join(cwd, 'storage') },
  'throwing-store': {
    // The write fault is injected by the driver after the domain opens: the JSON
    // backend's temp name is random, so a pre-boot poison cannot reach the write
    // path without also breaking the open.
    storageRoot: cwd => join(cwd, 'storage'),
  },
  'broken-storage': {
    storageRoot: cwd => join(cwd, 'blocker'),
    // A file where the JSON backend's root must be: `open` cannot create it, so
    // the board's awaited activation fails instead of half-mounting.
    prepare: async (storageRoot) => {
      await writeFile(storageRoot, 'not a directory\n', 'utf8')
    },
  },
  'uncontained-listener': { storageRoot: cwd => join(cwd, 'storage') },
  'role-resolution': { storageRoot: cwd => join(cwd, 'storage') },
}

let checks = 0
let failures = 0

/** Assert one condition and record the outcome. */
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok      ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL    ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * Report a case that only becomes assertable once stage A1 lands. Before that
 * the observed value is printed as evidence, so the expectation is recorded
 * rather than silently dropped; after that it is an ordinary {@link check}.
 */
function pending(label, condition, detail = '') {
  if (A1_STORE_CONTAINMENT_LANDED) {
    check(label, condition, detail)
    return
  }
  console.log(`  PENDING ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Print and count every case the shared evaluator derives from one report. */
function reportCases(report) {
  for (const item of evaluateCases(report)) {
    if (item.pending) {
      pending(item.label, item.ok, item.detail)
      continue
    }
    check(item.label, item.ok, item.detail)
  }
}

/**
 * Boot one scenario through the real Loader in a child process and return the
 * driver's report.
 * @param scenario - scenario name the driver dispatches on.
 * @param cwd - isolated process cwd the runner owns and removes.
 * @returns the recorded observations plus the child's stderr.
 */
async function collect(scenario, cwd) {
  const world = WORLDS[scenario]
  const storageRoot = world.storageRoot(cwd)
  let report
  const { stderr } = await runLoaderSmoke({
    label: `requirement-board ${scenario} composition`,
    cwd,
    binScript: driver,
    // The artifact tier has no build, so `src` is the only supported mode; the
    // explicit lib bin keeps a stray DSH_EXAMPLE_MODE from selecting `lib`.
    libBinScript: driver,
    configPath,
    binArgs: [configPath, scenario],
    tsconfigPath: repoTsconfig,
    mode: 'src',
    sourceImport: 'tsx/esm',
    processTimeoutMs: 120_000,
    env: {
      RB_BOARD_STORAGE_ROOT: storageRoot,
      ...STUB_ENV,
      // The driver prints its own cases but leaves the verdict to this runner,
      // which also owns the per-scenario worlds and the stage-A1 gate.
      RB_BOARD_COMPOSITION_CHILD: '1',
    },
    prepare: world.prepare === undefined
      ? undefined
      : async () => { await world.prepare(storageRoot) },
    inspect: async (dir) => {
      report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'))
    },
  })
  if (report === undefined) throw new Error(`requirement-board ${scenario}: the driver wrote no report.json`)
  return { report, stderr, storageRoot }
}

/** Run one scenario in its own temporary world. */
async function withScenario(scenario, run) {
  const cwd = await mkdtemp(join(tmpdir(), `requirement-board-${scenario}-`))
  try {
    return await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

console.log('\nhappy composition')

await withScenario('happy', async (cwd) => {
  const { report, stderr } = await collect('happy', cwd)
  reportCases(report)
  check('the child process wrote no unexpected stderr', stderr.includes('UNHANDLED') === false, stderr)
})

console.log('\nthrowing store (建档 failure)')

await withScenario('throwing-store', async (cwd) => {
  const { report } = await collect('throwing-store', cwd)
  reportCases(report)
})

console.log('\nbroken storage (mount-time failure visibility, D11)')

await withScenario('broken-storage', async (cwd) => {
  const { report, stderr } = await collect('broken-storage', cwd)
  reportCases(report)
  check('the child process wrote no unexpected stderr', stderr.includes('UNHANDLED') === false, stderr)
})

console.log('\nrole resolution (end-to-end, real Loader)')

await withScenario('role-resolution', async (cwd) => {
  const { report, stderr } = await collect('role-resolution', cwd)
  reportCases(report)
  check('the child process wrote no unexpected stderr', stderr.includes('UNHANDLED') === false, stderr)
})

console.log('\nuncontained listener (negative control)')

await withScenario('uncontained-listener', async (cwd) => {
  const { report } = await collect('uncontained-listener', cwd)
  reportCases(report)
})

console.log(`\n${checks - failures}/${checks} checks passed` + (A1_STORE_CONTAINMENT_LANDED ? '' : ' (stage A1 containment checks are pending)'))
process.exit(failures === 0 ? 0 : 1)
