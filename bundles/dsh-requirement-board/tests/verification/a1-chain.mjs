#!/usr/bin/env node
/**
 * Independent verification of `ROLE-DISPATCH.md` §9-A1 ("A1 role and resolution
 * chain"), written by a member other than the implementation's author.
 *
 * What this script is: a real Cordis `Context` with the real storage stack
 * (`dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`), the real `tools`
 * and `systemPrompt` services, the real board plugin (`index.js`), and the real
 * `role.js` declaration row — with only the process-owned inputs substituted
 * (the session registry and the preset registry, exactly like the shipped
 * `packages/preset/agent-preset-registry` reads them). Everything asserted below
 * is read from a public surface: the board tool table, the
 * `requirement_role{list}` result, `ctx.systemPrompt.assemble()`, the HTTP
 * command envelope, the domain's own records, and the `domain/changed` frames.
 * No author test constant and no author check result is consulted.
 *
 * Usage (from the repository root):
 *   TSX_TSCONFIG_PATH=<repo>/tsconfig.json node --import tsx/esm \
 *     .artifacts/requirement-board/tests/verification/a1-chain.mjs
 *
 * Exits non-zero when a check fails. Every boot uses a temporary storage root
 * that this script creates and removes; nothing outside those directories is
 * written and no session is created.
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '../../../../packages/storage/storage/src/index.ts'
import * as StorageJson from '../../../../packages/storage/storage-json/src/index.ts'
import * as StorageDomain from '../../../../packages/storage/storage-domain/src/index.ts'
import Tools from '../../../../packages/core/tools/src/index.ts'
import SystemPrompt from '../../../../packages/core/system-prompt/src/index.ts'
import * as board from '../../index.js'
import * as role from '../../role.js'
import { RequirementService } from '../../host/service.js'
import { resolveConfig } from '../../host/config.js'
import { createBoardHandler } from '../../host/http.js'

/** The board's storage-domain unit, named after the domain. */
const BOARD_UNIT = 'requirement_board.json'

/** The declaration the real `role.js` row publishes inside the preset realm. */
const DECLARATION = {
  roleId: 'art',
  roleName: 'Art Director',
  duties: ['美术与音频资产规范', '资产合规清单'],
}

let checks = 0
let failures = 0
const notes = []

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

/** Record a fact the report must state rather than assert. */
function note(text) {
  notes.push(text)
  console.log(`  note ${text}`)
}

/** Create a temporary directory for one board medium. */
async function makeRoot(prefix = 'a1-verify-') {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** A function plugin that publishes one service. */
function providerPlugin(pluginName, serviceName, build) {
  return {
    name: pluginName,
    inject: [],
    apply(ctx) {
      return ctx.provide(serviceName, build())
    },
  }
}

/**
 * The stub preset registry, mounted in the same realm as the real declaration so
 * `serviceFor` can read it — the arrangement
 * `packages/preset/agent-preset-registry/README.md` requires of a real preset.
 * @param config - `{ declaredPreset, failurePreset }`.
 */
function presetsPlugin(config) {
  return {
    name: 'a1-verify-presets-stub',
    inject: [],
    apply(ctx) {
      ctx.provide('agentPresets', {
        serviceFor(agent, key) {
          if (config.failurePreset !== undefined && agent?.ctx?.presetId === config.failurePreset) {
            throw new Error(`a1-verify: preset registry lookup for "${config.failurePreset}" failed`)
          }
          if (key !== 'requirementBoardRole') return undefined
          const declared = ctx.get('requirementBoardRole')
          if (declared === undefined) return undefined
          return agent?.ctx?.presetId === config.declaredPreset ? declared : undefined
        },
        composedPreset(target) {
          return typeof target?.presetId === 'string' ? target.presetId : undefined
        },
      })
    },
  }
}

/** Build one stub agent with the scope shape `composedPreset` reads. */
function stubAgent(id, presetId, status = 'idle') {
  return { id, status, ctx: { presetId } }
}

/**
 * Mount the real board on real services.
 *
 * @param options - `{ root, agents, declaration, presets, failurePreset, logs, humanProbe }`.
 * @returns the settled root context plus the recorded log lines.
 */
async function mountBoard(options) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: options.root })
  await ctx.plugin(StorageDomain, { backend: 'json', routes: { requirement_board: 'json' } })
  await ctx.plugin(Tools)
  await ctx.plugin(SystemPrompt)

  if (options.presets !== false) {
    const agents = options.agents ?? []
    await ctx.plugin(providerPlugin('a1-verify-agents-stub', 'agents', () => ({
      get: id => agents.find(agent => agent.id === id),
      list: () => [...agents],
    })))
    const realm = ctx.isolate('requirementBoardRole')
    const declared = realm.plugin(role, options.declaration ?? DECLARATION)
    await declared.await()
    await realm.plugin(presetsPlugin({
      declaredPreset: options.declaredPreset ?? 'art',
      failurePreset: options.failurePreset,
    }))
  }

  const logs = []
  const sink = new Context()
  sink.logger = ctx.logger
  sink.logger.exporter({
    levels: { default: 3 },
    export: ({ type, name, args }) => {
      logs.push({ type, name, text: args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ') })
    },
  })

  const mounted = ctx.plugin(board, {
    defaultTemplateId: 'tpl-standard',
    stallAfterHours: 72,
    promptContext: true,
    promptMaxItems: 12,
    http: true,
    importLegacy: false,
    // This fixture injects no jobs registry, so the execution synchronizer has
    // nothing to follow. §5.12 makes that an explicit off switch instead of the
    // mount-time warn a composition that leaves it on reports; the shipped
    // `tests/composition/cordis.yml` and `tests/roles.mjs` set the same switch.
    executionSync: false,
  })
  await mounted.await()
  return { ctx, logs }
}

/**
 * Dispatch the creation event the way session creation does.
 *
 * `ctx.serial` resolves with the last listener's return value, so containment is
 * judged by "did this reject", not by the value.
 * @returns `{ threw, value }`.
 */
async function dispatchCreation(ctx, agent) {
  try {
    return { threw: null, value: await ctx.serial('agent/created', { agent }) }
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error), value: undefined }
  }
}

/** Drive one tool call and return its text result. */
async function callTool(ctx, name, args, callId = `a1-verify-${name}`) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId,
    name,
    arguments: args,
  })
  return {
    isError: Boolean(result.isError),
    text: (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join(''),
  }
}

/** Read the role list through the model-facing tool. */
async function listRoles(ctx) {
  const called = await callTool(ctx, 'requirement_role', { action: 'list' }, 'a1-verify-role-list')
  return JSON.parse(called.text)
}

/** Find one role row in a `requirement_role{list}` result. */
function roleRow(list, id) {
  return list.items.find(item => item.id === id)
}

/** The `requirement-board` context text of one assembly. */
async function boardContext(ctx, scope) {
  const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
  return assembly.contexts.find(context => context.name === 'requirement-board')?.text ?? null
}

/** A minimal `POST /command` request over the board route. */
function fakePost(body) {
  const text = JSON.stringify(body)
  return {
    method: 'POST',
    url: '/api/requirement-board/command',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf8')
    },
  }
}

/** A minimal response object capturing the status and body. */
function fakeResponse() {
  const state = { status: 0, body: '' }
  return {
    state,
    res: {
      writeHead(status) {
        state.status = status
      },
      end(chunk) {
        state.body = chunk === undefined ? '' : String(chunk)
      },
    },
  }
}

/** Count the board's own `domain/changed` frames while one operation runs. */
function frameCounter(ctx) {
  const frames = []
  ctx.on('domain/changed', change => {
    if (change.domain === 'requirement_board') frames.push(change)
  })
  return frames
}

/* ------------------------------------------------------------------ */

console.log('A1 independent verification — role and resolution chain')

/* 1. The resolution chain's three states. */
console.log('\n[1] resolution chain (declared / fallback / no role)')
{
  const root = await makeRoot()
  const agents = [stubAgent('sess-art', 'art'), stubAgent('sess-standard', 'standard', 'running'), stubAgent('sess-ghost', 'ghost-preset')]
  const { ctx, logs } = await mountBoard({ root, agents })
  try {
    const declared = await dispatchCreation(ctx, ctx.get('agents').get('sess-art'))
    check('a serial agent/created dispatch resolves', declared.threw === null, String(declared.threw))
    await dispatchCreation(ctx, ctx.get('agents').get('sess-standard'))

    const list = await listRoles(ctx)
    const art = roleRow(list, 'art')
    const standard = roleRow(list, 'standard')
    check('a declared preset records the declared role', art?.source === 'preset' && art?.name === 'Art Director', JSON.stringify(art))
    check('the declared role carries its declared duties', JSON.stringify(art?.duties) === JSON.stringify(DECLARATION.duties), JSON.stringify(art?.duties))
    check('an undeclared preset falls back to the preset id', standard?.source === 'observed' && standard?.name === 'standard', JSON.stringify(standard))
    check('the fallback role reports dutiesMissing', standard?.dutiesMissing === true && JSON.stringify(standard?.duties) === '[]', JSON.stringify(standard))

    const artPrompt = await boardContext(ctx, ctx.get('agents').get('sess-art'))
    check(
      'the prompt line names the declared role and its duties',
      typeof artPrompt === 'string'
        && artPrompt.includes('You are role "art" (Art Director)')
        && artPrompt.includes('美术与音频资产规范'),
      JSON.stringify(artPrompt),
    )
    const fallbackPrompt = await boardContext(ctx, ctx.get('agents').get('sess-standard'))
    check(
      'the fallback role says it has no duties instead of omitting them',
      typeof fallbackPrompt === 'string'
        && fallbackPrompt.includes('You are role "standard" (standard)')
        && fallbackPrompt.includes('no duties recorded'),
      JSON.stringify(fallbackPrompt),
    )
    const globalPrompt = await boardContext(ctx, undefined)
    check('the global assembly carries no role line', globalPrompt === null || globalPrompt.includes('You are role') === false, JSON.stringify(globalPrompt))

    const ghost = list.unregistered.find(entry => entry.id === 'ghost-preset')
    check(
      'an id in use by a live session but unrecorded is reported as unregistered',
      ghost !== undefined && ghost.holders?.online === 1 && ghost.dutiesMissing === true && roleRow(list, 'ghost-preset') === undefined,
      JSON.stringify(list.unregistered),
    )
    check('established ids are not reported as unregistered', list.unregistered.every(entry => entry.id !== 'art' && entry.id !== 'standard'), JSON.stringify(list.unregistered))
    check('the healthy chain logged no warn or error', logs.every(entry => entry.type === 'info'), JSON.stringify(logs.filter(entry => entry.type !== 'info')))
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/* 1b. The third state: no agent and no preset registry at all. */
console.log('\n[1b] resolution chain (no registry: no role at all)')
{
  const root = await makeRoot()
  const { ctx } = await mountBoard({ root, presets: false })
  try {
    const bare = { id: 'sess-bare', status: 'idle', ctx: {} }
    const dispatched = await dispatchCreation(ctx, bare)
    check('agent/created still resolves without any registry', dispatched.threw === null, String(dispatched.threw))
    const list = await listRoles(ctx)
    check('no role record is invented for a session with no resolvable role', list.items.length === 0 && list.unregistered.length === 0, JSON.stringify(list))
    const prompt = await boardContext(ctx, bare)
    check('a session with no role gets no role line', prompt === null || prompt.includes('You are role') === false, JSON.stringify(prompt))
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/* 1c. The four establishment sources: stored human and delegated records win. */
console.log('\n[1c] establishment sources (human and delegated records are not overwritten)')
{
  const root = await makeRoot()
  const agents = [stubAgent('sess-art', 'art'), stubAgent('sess-standard', 'standard')]
  const { ctx } = await mountBoard({ root, agents })
  try {
    const domain = ctx.get('storageDomain').get('requirement_board')
    const at = new Date().toISOString()
    await domain.table('roles').put('art', {
      id: 'art', name: 'Hand-made name', duties: ['hand-made duty'], source: 'manual', ephemeral: false, createdAt: at, updatedAt: at,
    })
    await domain.table('roles').put('standard', {
      id: 'standard', name: 'Delegated name', duties: ['delegated duty'], source: 'delegated', ephemeral: false, createdAt: at, updatedAt: at,
    })
    const frames = frameCounter(ctx)
    await dispatchCreation(ctx, ctx.get('agents').get('sess-art'))
    await dispatchCreation(ctx, ctx.get('agents').get('sess-standard'))
    const list = await listRoles(ctx)
    const art = roleRow(list, 'art')
    const standard = roleRow(list, 'standard')
    check(
      'a preset declaration never overwrites a human-made role',
      art?.source === 'manual' && art?.name === 'Hand-made name' && JSON.stringify(art?.duties) === JSON.stringify(['hand-made duty']),
      JSON.stringify(art),
    )
    check(
      'a fallback resolution never overwrites a delegated role',
      standard?.source === 'delegated' && standard?.name === 'Delegated name',
      JSON.stringify(standard),
    )
    check('neither protected establishment wrote (zero frames)', frames.length === 0, String(frames.length))
    const prompt = await boardContext(ctx, ctx.get('agents').get('sess-art'))
    // D15 ruling: the roles record is the single authority for the role segment's
    // `name`/`duties`; the preset declaration is only the seed when no record
    // exists (`ROLE-DISPATCH.md`:491, `host/roles.js`:99-116). Here the record was
    // hand-made, so the model must read the record's values and never the
    // declaration's — the declaration-fed path is section [1]'s seed assertions
    // and the `no duties recorded` fallback above.
    check(
      'the prompt line reflects the stored record (D15), not the preset declaration',
      typeof prompt === 'string' && prompt.includes('You are role "art" (Hand-made name)') && prompt.includes('hand-made duty') && prompt.includes('Art Director') === false,
      JSON.stringify(prompt),
    )
    note('D15: a panel-made row (`source: manual`, same id) is what the model reads in the role segment; the declaration only seeds a missing record.')
    note('the "delegated" source has a producer since stage B: `tests/delegate.mjs`:175 and `tests/verification/b-delegate.mjs`:290 pin the minted row as delegated/ephemeral; this section verifies its protection rule, not its minting.')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/* 2. Establishment dedupe, counted from the domain's own frames. */
console.log('\n[2] establishment dedupe (counted from domain/changed frames)')
{
  const root = await makeRoot()
  const agents = [stubAgent('sess-art', 'art')]
  const { ctx } = await mountBoard({ root, agents })
  try {
    const frames = frameCounter(ctx)
    await ctx.serial('agent/created', { agent: ctx.get('agents').get('sess-art') })
    const first = frames.length
    const before = roleRow(await listRoles(ctx), 'art')
    await ctx.serial('agent/created', { agent: ctx.get('agents').get('sess-art') })
    const repeat = frames.length - first
    const after = roleRow(await listRoles(ctx), 'art')
    check('the first establishment writes (frames observed)', first > 0, String(first))
    check('an identical second establishment writes nothing (zero frames)', repeat === 0, String(repeat))
    check('the record is unchanged by the second establishment', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }))
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/* 3. A failing store write during establishment must not break creation. */
console.log('\n[3] 建档 store failure does not break the creation dispatch')
{
  const root = await makeRoot()
  const agents = [stubAgent('sess-art', 'art')]
  const { ctx, logs } = await mountBoard({ root, agents })
  try {
    // A genuine medium failure after activation: the unit path becomes a
    // directory, so the backend's atomic rename cannot land.
    await rm(join(root, BOARD_UNIT), { force: true })
    await mkdir(join(root, BOARD_UNIT), { recursive: true })

    const dispatched = await dispatchCreation(ctx, ctx.get('agents').get('sess-art'))
    check('the creation dispatch resolves despite the failing role write', dispatched.threw === null, String(dispatched.threw))
    const warns = logs.filter(entry => entry.type === 'warn' && entry.text.includes('failed and was ignored'))
    check(
      'exactly one structured warn names the session it ignored',
      warns.length === 1 && warns[0].text.includes('registering the role of session "sess-art" failed and was ignored so the session is still created'),
      JSON.stringify(logs.filter(entry => entry.type === 'warn')),
    )
    const broken = await callTool(ctx, 'requirement_board', { action: 'create', summary: '测试简述', title: 'sweep seed' }, 'a1-verify-broken-create')
    check('the medium really is broken (the board tool reports the failed write)', broken.isError === true && broken.text.includes(BOARD_UNIT), JSON.stringify(broken))
    const listed = await listRoles(ctx)
    check('the board is still usable after the contained failure', Array.isArray(listed.items), JSON.stringify(listed))
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/* 3b. Concurrent creations, each failing registration contained separately. */
console.log('\n[3b] concurrent failing registrations are each contained')
{
  const root = await makeRoot()
  const agents = [stubAgent('sess-boom-a', 'boom'), stubAgent('sess-boom-b', 'boom')]
  const { ctx, logs } = await mountBoard({ root, agents, failurePreset: 'boom' })
  try {
    let rejected = null
    try {
      // Raw `ctx.serial` inside `Promise.all`: containment is exactly "neither
      // dispatch rejects", which is what session creation awaits.
      await Promise.all([
        ctx.serial('agent/created', { agent: ctx.get('agents').get('sess-boom-a') }),
        ctx.serial('agent/created', { agent: ctx.get('agents').get('sess-boom-b') }),
      ])
    } catch (error) {
      rejected = error instanceof Error ? error.message : String(error)
    }
    check('Promise.all of two failing creations does not reject', rejected === null, String(rejected))
    const warns = logs.filter(entry => entry.type === 'warn' && entry.text.includes('failed and was ignored'))
    check('each failed registration produced exactly one warn', warns.length === 2, JSON.stringify(logs.filter(entry => entry.type === 'warn')))
    check(
      'both warns name their own session',
      warns.some(entry => entry.text.includes('"sess-boom-a"')) && warns.some(entry => entry.text.includes('"sess-boom-b"')),
      JSON.stringify(warns.map(entry => entry.text)),
    )
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/* 4. `human` is refused where it is written, and the panel reports 409. */
console.log('\n[4] human is reserved: the declaration row and the panel')
{
  const root = await makeRoot()
  const { ctx } = await mountBoard({ root, agents: [] })
  try {
    // The declaration row fails at mount, so no preset can publish `human`.
    const realm = ctx.isolate('requirementBoardRole', Symbol('a1-verify-human'))
    let mountError = null
    try {
      await realm.plugin(role, { roleId: 'human', roleName: 'Human', duties: [] }).await()
    } catch (error) {
      mountError = error
    }
    check(
      'mounting role.js with roleId "human" throws invalid-role',
      mountError !== null && mountError.code === 'invalid-role' && mountError.message.includes('reserved for the human decision-maker'),
      mountError === null ? 'the row activated' : `${String(mountError.code)}: ${mountError.message}`,
    )

    // The panel is the only write path for roles; it must answer 409.
    const domain = ctx.get('storageDomain').get('requirement_board')
    const service = new RequirementService({ domain, config: resolveConfig({}), ports: {} })
    const handler = createBoardHandler(service)

    const refused = fakeResponse()
    await handler(fakePost({ action: 'role.put', role: { roleId: 'human', duties: ['decide'] } }), refused.res)
    const refusedBody = JSON.parse(refused.state.body)
    check(
      'the panel refuses roleId "human" with 409 and the machine code',
      refused.state.status === 409 && refusedBody?.error?.code === 'invalid-role',
      JSON.stringify({ status: refused.state.status, body: refused.state.body }),
    )
    const alsoRefused = fakeResponse()
    await handler(fakePost({ action: 'role.put', role: { roleId: 'tmp-forged', duties: [] } }), alsoRefused.res)
    check(
      'the panel refuses the reserved tmp- prefix with 409',
      alsoRefused.state.status === 409 && JSON.parse(alsoRefused.state.body)?.error?.code === 'invalid-role',
      JSON.stringify({ status: alsoRefused.state.status, body: alsoRefused.state.body }),
    )

    const accepted = fakeResponse()
    await handler(fakePost({ action: 'role.put', role: { roleId: 'art', roleName: 'Panel art', duties: ['panel edit'] } }), accepted.res)
    const acceptedBody = JSON.parse(accepted.state.body)
    check(
      'the same panel path accepts a valid role',
      accepted.state.status === 200 && acceptedBody?.ok === true && acceptedBody?.data?.source === 'manual',
      JSON.stringify({ status: accepted.state.status, body: accepted.state.body }),
    )

    const viaModel = await callTool(ctx, 'requirement_role', { action: 'put', roleId: 'art' }, 'a1-verify-model-put')
    check(
      'the model-facing tool exposes no write action',
      viaModel.isError === true || viaModel.text.includes('unknown action'),
      JSON.stringify(viaModel),
    )
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/* 5. The startup sweep and what it reports.
 *
 * Current scope (rulings D/D27): besides orphan temporary roles and queue ghosts,
 * the sweep settles dangling gate links (`blocksOn`/`parentId`) and dangling
 * delegations, and its one report line names all four classes. The only class it
 * leaves alone is a delegation whose target session may still exist, and that
 * case needs an absent agent registry (`host/roles.js`:347-372); with the
 * registry present nothing is deferred. */
console.log('\n[5] startup sweep of dangling references')
{
  const root = await makeRoot()
  const agents = [stubAgent('sess-art', 'art')]
  let seeded = null
  {
    const { ctx } = await mountBoard({ root, agents })
    const keeper = await callTool(ctx, 'requirement_board', { action: 'create', summary: '测试简述', title: 'Sweep keeper requirement' }, 'a1-verify-sweep-keeper')
    const keeperParsed = JSON.parse(keeper.text)
    const keeperId = keeperParsed?.id ?? keeperParsed?.requirement?.id
    const gated = await callTool(ctx, 'requirement_board', { action: 'create', summary: '测试简述', title: 'Sweep gate owner' }, 'a1-verify-sweep-gated')
    const gatedParsed = JSON.parse(gated.text)
    const gatedId = gatedParsed?.id ?? gatedParsed?.requirement?.id
    check(
      'the two seed requirements were created',
      typeof keeperId === 'string' && keeperId !== '' && typeof gatedId === 'string' && gatedId !== '',
      `${keeper.text.slice(0, 120)} / ${gated.text.slice(0, 120)}`,
    )

    const domain = ctx.get('storageDomain').get('requirement_board')
    const at = new Date().toISOString()
    // A temporary role survives while its task exists AND routes to it (§3.3):
    // `tmp-keep` is that complete write chain, `tmp-misrouted` stopped between
    // declaring the role and binding it, `tmp-ghost` lost its task entirely.
    await domain.table('roles').put('tmp-ghost', {
      id: 'tmp-ghost', name: 'ghost', duties: ['x'], source: 'delegated', ephemeral: true,
      boundTask: 'req-missing', createdAt: at, updatedAt: at,
    })
    await domain.table('roles').put('tmp-misrouted', {
      id: 'tmp-misrouted', name: 'misrouted', duties: ['x'], source: 'delegated', ephemeral: true,
      boundTask: keeperId, createdAt: at, updatedAt: at,
    })
    await domain.table('roles').put('tmp-keep', {
      id: 'tmp-keep', name: 'keep', duties: ['y'], source: 'delegated', ephemeral: true,
      boundTask: keeperId, createdAt: at, updatedAt: at,
    })
    const keeperRecord = domain.table('requirements').get(keeperId)
    await domain.table('requirements').put(keeperId, { ...keeperRecord, role: 'tmp-keep', rev: (keeperRecord.rev ?? 0) + 1, updatedAt: at })
    // `gated` carries the two references D/D27 added to the sweep: a gate link to
    // a requirement that does not exist, and a delegation whose temporary role
    // this same sweep removes before it walks the delegations.
    const gatedRecord = domain.table('requirements').get(gatedId)
    await domain.table('requirements').put(gatedId, {
      ...gatedRecord,
      blocksOn: ['req-missing'],
      delegatedTo: { session: 'sess-gone', name: 'gone', roleId: 'tmp-ghost', roleBefore: '', at },
      rev: (gatedRecord.rev ?? 0) + 1,
      updatedAt: at,
    })
    await domain.table('queues').put('sess-dead', {
      sessionId: 'sess-dead', sessionName: 'dead', items: [{ id: 'req-missing', at }], updatedAt: at,
    })
    await domain.table('queues').put('sess-mixed', {
      sessionId: 'sess-mixed', sessionName: 'mixed', items: [{ id: 'req-missing', at }, { id: gatedId, at }], updatedAt: at,
    })
    seeded = { keeperId, gatedId }
    await ctx.fiber.dispose()
  }

  // Second boot on the same medium: the sweep is mount-time work.
  const { ctx, logs } = await mountBoard({ root, agents })
  try {
    const list = await listRoles(ctx)
    const domain = ctx.get('storageDomain').get('requirement_board')
    check('the temporary role whose task is gone was removed', roleRow(list, 'tmp-ghost') === undefined, JSON.stringify(list.items.map(item => item.id)))
    check('the temporary role whose live task routes elsewhere was removed', roleRow(list, 'tmp-misrouted') === undefined, JSON.stringify(list.items.map(item => item.id)))
    check('a temporary role bound to a live task that names it was kept', roleRow(list, 'tmp-keep') !== undefined, JSON.stringify(list.items.map(item => item.id)))
    check('a queue holding only dangling items was removed', domain.table('queues').get('sess-dead') === undefined, JSON.stringify([...domain.table('queues').keys()]))
    const mixed = domain.table('queues').get('sess-mixed')
    check(
      'a mixed queue kept the live item and dropped the dangling one',
      JSON.stringify(mixed?.items?.map(item => item.id)) === JSON.stringify([seeded.gatedId]),
      JSON.stringify(mixed),
    )
    const sweepLog = logs.find(entry => entry.text.includes('startup sweep removed'))
    check(
      'the sweep report names all four classes with their counts',
      sweepLog !== undefined
        && sweepLog.text.includes('removed 2 orphan temporary role(s) and 2 dangling queue item(s)')
        && sweepLog.text.includes('unbound 1 dangling gate link(s)')
        && sweepLog.text.includes('settled 1 dangling delegation(s)'),
      JSON.stringify(sweepLog ?? logs.map(entry => entry.text)),
    )
    const gatedAfter = domain.table('requirements').get(seeded.gatedId)
    check('the dangling gate link really left the record', JSON.stringify(gatedAfter?.blocksOn ?? null) === '[]', JSON.stringify(gatedAfter?.blocksOn))
    check('the dangling delegation was settled, not just counted', (gatedAfter?.delegatedTo ?? null) === null, JSON.stringify(gatedAfter?.delegatedTo))
    check('settling returned the task to the role it held before the delegation', (gatedAfter?.role ?? '') === '', JSON.stringify(gatedAfter?.role))
    check(
      'with the agent registry present no class is left deferred',
      sweepLog !== undefined && sweepLog.text.includes('not checked yet') === false && sweepLog.text.includes('deferred') === false,
      JSON.stringify(sweepLog ?? null),
    )
    note('sweep report contract: all four classes are work the sweep did; the only deferred class is a delegation whose target session may still exist, which needs an absent agent registry (`host/roles.js`:347-372, pinned by `tests/roles.mjs`:365).')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
for (const line of notes) console.log(`note: ${line}`)
process.exit(failures === 0 ? 0 : 1)
