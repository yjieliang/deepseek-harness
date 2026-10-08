#!/usr/bin/env node
/**
 * Ownership through the **real composition** (`index.js`), by a member other than
 * the author.
 *
 * `host/service.js` asks its ownership port in session ids (`owns(target, caller)`);
 * `index.js:createOwnershipPort` is the one place that knows the platform answers
 * with live Agent objects (`packages/core/agent/src/index.ts:578-580`). This
 * script mounts the real `index.js` plugin on the real storage stack with a stub
 * `agents` service that mirrors the platform predicate exactly and records the
 * arguments it receives, then drives the model-facing tool
 * (`requirement_board`) and the adapter directly.
 *
 * The stub is a faithful fake for the parts the board reads — `get`, `list`, and
 * `isOwnedBy(id, owner) { return store.get(id)?.owner === owner }` with owners
 * compared by object identity. It is not a real `AgentRegistry`: it has no
 * scoped-context creation, no lifecycle events, and no `withInitiator`; nothing
 * here asserts any of those.
 *
 * Usage (from the repository root):
 *   TSX_TSCONFIG_PATH=<repo>/tsconfig.json node --import tsx/esm \
 *     .artifacts/requirement-board/tests/verification/b-composition.mjs
 *   RB_B_MUTANT=1     # the composition root has the adapter reverted to the
 *                     # pre-fix wiring; the owner must then be refused (red)
 *   RB_B_INDEX=./_red-adapter/index.js   # composition root under test
 *
 * Temporary storage roots only; no session is created and nothing under `~/.dsh`
 * is written.
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '../../../../packages/storage/storage/src/index.ts'
import * as StorageJson from '../../../../packages/storage/storage-json/src/index.ts'
import * as StorageDomain from '../../../../packages/storage/storage-domain/src/index.ts'
import Tools from '../../../../packages/core/tools/src/index.ts'
import SystemPrompt from '../../../../packages/core/system-prompt/src/index.ts'
import * as role from '../../role.js'

const ROOT = process.env.RB_B_INDEX ?? '../../index.js'
const board = await import(ROOT)
const MUTANT = process.env.RB_B_MUTANT === '1'

const DECLARATION = { roleId: 'art', roleName: 'Art Director', duties: ['美术与音频资产规范'] }

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

/** Record a fact rather than assert it. */
function note(text) {
  console.log(`  note ${text}`)
}

/** One stub live agent, with the scope shape the preset stub reads. */
function stubAgent(id, presetId, status = 'idle', name = '') {
  return { id, name: name === '' ? id : name, status, ctx: { presetId } }
}

/**
 * A registry that mirrors `AgentRegistry`'s ownership answer:
 * `isOwnedBy(id, owner) { return store.get(id)?.owner === owner }`, owners being
 * Agent objects compared by identity.
 */
function platformRegistry(agents, owners = {}, recorded = []) {
  const store = new Map(agents.map(agent => [agent.id, { agent, owner: owners[agent.id] }]))
  const registry = {
    get: id => store.get(id)?.agent,
    list: () => [...store.values()].map(entry => entry.agent),
    isOwnedBy(id, owner) {
      recorded.push([id, owner])
      return store.get(id)?.owner === owner
    },
  }
  // The recording is the evidence, so it is readable from the outside too.
  registry.recordedArgs = recorded
  return registry
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

/** The preset registry stub: the declared preset resolves to the declaration. */
function presetsPlugin() {
  return {
    name: 'b-verify-presets-stub',
    inject: [],
    apply(ctx) {
      ctx.provide('agentPresets', {
        serviceFor(agent, key) {
          if (key !== 'requirementBoardRole') return undefined
          const declared = ctx.get('requirementBoardRole')
          if (declared === undefined) return undefined
          return agent?.ctx?.presetId === DECLARATION.roleId ? declared : undefined
        },
        composedPreset(target) {
          return typeof target?.presetId === 'string' ? target.presetId : undefined
        },
      })
    },
  }
}

/** Mount the real board plugin on the real storage stack with one stub registry. */
async function mountBoard({ root, agents, owners, withOwnership = true }) {
  const ctx = new Context()
  const recorded = []
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json', routes: { requirement_board: 'json' } })
  await ctx.plugin(Tools)
  await ctx.plugin(SystemPrompt)
  const registry = platformRegistry(agents, owners, recorded)
  await ctx.plugin(providerPlugin('b-verify-agents-stub', 'agents', () => (withOwnership ? registry : { get: registry.get, list: registry.list })))
  const realm = ctx.isolate('requirementBoardRole')
  const declared = realm.plugin(role, DECLARATION)
  await declared.await()
  await realm.plugin(presetsPlugin())
  const logs = []
  const sink = new Context()
  sink.logger = ctx.logger
  sink.logger.exporter({
    levels: { default: 3 },
    export: ({ type, name, args }) => {
      logs.push({ type, name, text: args.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ') })
    },
  })
  const mounted = ctx.plugin(board, {
    defaultTemplateId: 'tpl-standard',
    stallAfterHours: 72,
    promptContext: true,
    promptMaxItems: 12,
    http: false,
    importLegacy: false,
  })
  await mounted.await()
  return { ctx, logs, recorded, registry }
}

/** Drive one tool call; `agent` is the model's session, absent for the panel. */
async function callTool(ctx, name, args, agent, callId) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId,
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
  const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
  return { isError: Boolean(result.isError), text }
}

/** Create one requirement through the tool as `session`. */
async function createViaTool(ctx, session, title) {
  const called = await callTool(ctx, 'requirement_board', { action: 'create', title }, session, `b-verify-create-${title}`)
  return { called, id: JSON.parse(called.text).id }
}

const ROSTER = {
  parent: stubAgent('sess_parent', 'art', 'idle', '甲'),
  child: stubAgent('sess_child', 'art', 'idle', '子'),
  alien: stubAgent('sess_alien', 'art', 'idle', '他人子'),
  uncle: stubAgent('sess_other_parent', 'art', 'idle', '他人父'),
}
const OWNERS = { sess_child: ROSTER.parent, sess_alien: ROSTER.uncle }
const AGENTS = Object.values(ROSTER)

/* ------------------------------------------------------------------ */

console.log(`B independent verification — ownership through the real composition (root: ${ROOT})`)

/* 1. The four ownership cases through the mounted plugin and its tool. */
console.log('\n[1] the model-facing tool, mounted through index.js')
{
  const root = await mkdtemp(join(tmpdir(), 'b-compose-'))
  const { ctx, logs, recorded } = await mountBoard({ root, agents: AGENTS, owners: OWNERS })
  try {
    const own = await createViaTool(ctx, ROSTER.parent, '自己的孩子')
    check('the model-facing create succeeds through the composition', typeof own.id === 'string' && own.id.startsWith('req_'), own.called.text.slice(0, 120))
    const delegated = await callTool(ctx, 'requirement_board', { action: 'delegate', id: own.id, session: 'sess_child', duties: ['画贴图'] }, ROSTER.parent, 'b-verify-delegate-own')
    check('the AI path delegates to the caller\'s own sub-session', !delegated.isError && JSON.parse(delegated.text).delegatedTo?.session === 'sess_child', delegated.text.slice(0, 200))
    const boundary = recorded.at(-1) ?? []
    check('the boundary adapter handed the platform a live Agent, not an id', typeof boundary[1] === 'object' && boundary[1]?.id === 'sess_parent', `${typeof boundary[1]} ${JSON.stringify(boundary[1])}`)
    check('the platform was asked about the named target', boundary[0] === 'sess_child', String(boundary[0]))

    const alien = await createViaTool(ctx, ROSTER.parent, '别人的孩子')
    const refused = await callTool(ctx, 'requirement_board', { action: 'delegate', id: alien.id, session: 'ses_alien' }, ROSTER.parent, 'b-verify-delegate-alien')
    check('another session\'s child is refused by the ownership check', refused.isError && refused.text.includes('does not own'), refused.text.slice(0, 200))
    note(`the model-facing refusal text: ${JSON.stringify(refused.text.slice(0, 160))}`)
    const beforePanel = recorded.length

    const panel = await callTool(ctx, 'requirement_board', { action: 'delegate', id: alien.id, session: 'ses_alien' }, undefined, 'b-verify-delegate-panel')
    check('the panel path delegates to any session', !panel.isError && JSON.parse(panel.text).delegatedTo?.session === 'ses_alien', panel.text.slice(0, 200))
    check('the panel path asks the ownership predicate for nothing', recorded.length === beforePanel, `${recorded.length} vs ${beforePanel}`)
    check('no ownership warning was logged in a deciding composition', !logs.some(entry => entry.text.includes('delegation cannot check')), logs.map(entry => entry.text).join(' | ').slice(0, 200))
    if (MUTANT) {
      check('MUTANT CONTROL: the reverted adapter refuses the caller\'s own child', delegated.isError, delegated.text.slice(0, 200))
      check('MUTANT CONTROL: the refusal names the two sessions', delegated.text.includes('does not own'), delegated.text.slice(0, 200))
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

/* 2. The adapter itself: ids in, Agent identity out. */
console.log('\n[2] `createOwnershipPort` over the platform predicate')
{
  const root = await mkdtemp(join(tmpdir(), 'b-compose-'))
  const recorded = []
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json', routes: { requirement_board: 'json' } })
    const registry = platformRegistry(AGENTS, OWNERS, recorded)
    await ctx.plugin(providerPlugin('b-verify-agents-stub-2', 'agents', () => registry))
    const port = board.createOwnershipPort(ctx)
    check('the adapter resolves the caller id and confirms the owner', port('sess_child', 'sess_parent') === true, JSON.stringify(recorded.map(([id, owner]) => [id, typeof owner, owner?.id])))
    check('the platform received an Agent object with the caller\'s id', typeof recorded.at(-1)?.[1] === 'object' && recorded.at(-1)?.[1]?.id === 'sess_parent', JSON.stringify(recorded.at(-1)))
    check('another session\'s child is a decided false', port('sess_alien', 'sess_parent') === false, String(port('sess_alien', 'sess_parent')))
    check('an unknown caller cannot be decided', port('sess_child', 'sess_ghost') === undefined, String(port('sess_child', 'sess_ghost')))
    check('the panel caller cannot be decided by the adapter', port('sess_child', '') === undefined, String(port('sess_child', '')))
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
  // The pre-fix wiring, evaluated against the same registry, is the anchor.
  const miswired = platformRegistry(AGENTS, OWNERS, [])
  const wrong = (target, caller) => miswired.isOwnedBy(target, caller)
  check('ANCHOR: the pre-fix wiring returns false for the caller\'s own child', wrong('sess_child', 'sess_parent') === false, String(wrong('sess_child', 'sess_parent')))
  check('ANCHOR: it handed the platform a session id in the Agent slot', miswired.recordedArgs.at(-1)?.[1] === 'sess_parent' && typeof miswired.recordedArgs.at(-1)[1] === 'string', JSON.stringify(miswired.recordedArgs.at(-1)))
}

/* 3. A registry without an ownership predicate: allow, and say so once. */
console.log('\n[3] a composition whose registry cannot decide')
{
  const root = await mkdtemp(join(tmpdir(), 'b-compose-'))
  const { ctx, logs } = await mountBoard({ root, agents: AGENTS, owners: OWNERS, withOwnership: false })
  try {
    const created = await createViaTool(ctx, ROSTER.parent, '没有归属信息')
    const delegated = await callTool(ctx, 'requirement_board', { action: 'delegate', id: created.id, session: 'sess_anyone' }, ROSTER.parent, 'b-verify-delegate-degraded')
    check('the delegation is allowed instead of guessed at', !delegated.isError && JSON.parse(delegated.text).delegatedTo?.session === 'sess_anyone', delegated.text.slice(0, 200))
    const warnings = logs.filter(entry => entry.text.includes('delegation cannot check'))
    check('the degradation is reported exactly once', warnings.length === 1, `${warnings.length}: ${logs.map(entry => entry.text).join(' | ').slice(0, 300)}`)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\n${checks - failures}/${checks} checks passed through the composition${MUTANT ? ' (MUTANT run)' : ''}`)
process.exit(failures === 0 ? 0 : 1)
