#!/usr/bin/env node
/**
 * Stage C/D through the **real composition** (`index.js`), by a member other than
 * the author.
 *
 * `packages/AGENTS.md` requires a decision to be enforced "in the operation that
 * makes it": schema omission, prompt filtering, facades, and listener order are
 * not enforcement while a direct or alternate caller can bypass them. This script
 * drives the model-facing tools (`requirement_board`, `flow_template`) and the
 * runtime context a real mount assembles, so the panel path, the agent path, the
 * result a model reads, and the prompt text `index.js` wires are exercised as
 * shipped.
 *
 * Three phases, because the raw medium is only safe to touch while the board is
 * not mounted: mount and drive the tools, remount over a record written before
 * `kind` existed, then read it back through the same tool.
 *
 * Usage (from the repository root):
 *   TSX_TSCONFIG_PATH=<repo>/tsconfig.json node --import tsx/esm \
 *     .artifacts/requirement-board/tests/verification/cd-composition.mjs
 *   RB_CD_INDEX=./_red-cd/index.js   # composition root under test
 *
 * Temporary storage roots only; no session is created, no socket is opened, and
 * nothing under `~/.dsh` is written.
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '../../../../packages/storage/storage/src/index.ts'
import * as StorageJson from '../../../../packages/storage/storage-json/src/index.ts'
import * as StorageDomain from '../../../../packages/storage/storage-domain/src/index.ts'
import Tools from '../../../../packages/core/tools/src/index.ts'
import SystemPrompt, { renderContextSections } from '../../../../packages/core/system-prompt/src/index.ts'
import { openRawBoard } from '../harness.mjs'
import * as role from '../../role.js'

const ROOT = process.env.RB_CD_INDEX ?? '../../index.js'
const board = await import(ROOT)

const DECLARATION = { roleId: 'art', roleName: '美术', duties: ['美术资产'] }

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

/** One stub live agent. */
function stubAgent(id, presetId, name) {
  return { id, name, status: 'idle', ctx: { presetId } }
}

const ROSTER = [stubAgent('sess_parent', 'art', '甲'), stubAgent('sess_child', 'art', '子')]
const TEMPLATE = 'tpl-cd'

/** The registry the role chain reads, with the platform ownership predicate. */
function platformRegistry(agents) {
  const store = new Map(agents.map(agent => [agent.id, agent]))
  return {
    get: id => store.get(id),
    list: () => [...store.values()],
    isOwnedBy: (id, owner) => store.get(id)?.owner === owner,
  }
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

/** The preset stub: the declared preset resolves for the declared role id. */
function presetsPlugin() {
  return {
    name: 'cd-verify-presets-stub',
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

/** Mount the real board on the real storage stack with a stub registry. */
async function mountBoard(root) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json', routes: { requirement_board: 'json' } })
  await ctx.plugin(Tools)
  await ctx.plugin(SystemPrompt)
  const registry = platformRegistry(ROSTER)
  await ctx.plugin(providerPlugin('cd-verify-agents-stub', 'agents', () => registry))
  const realm = ctx.isolate('requirementBoardRole')
  const declared = realm.plugin(role, DECLARATION)
  await declared.await()
  await realm.plugin(presetsPlugin())
  const mounted = ctx.plugin(board, {
    defaultTemplateId: 'tpl-standard',
    stallAfterHours: 72,
    promptContext: true,
    promptMaxItems: 12,
    http: false,
    importLegacy: false,
  })
  await mounted.await()
  return ctx
}

/** Drive one tool call; `agent` is the model's session, absent for the panel. */
async function callNamed(ctx, name, args, agent, callId) {
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

/** Drive one board call. */
const callTool = (ctx, args, agent, callId) => callNamed(ctx, 'requirement_board', args, agent, callId)

/** Create one requirement through the tool and hand back its id. */
async function createViaTool(ctx, agent, callId, args) {
  const result = await callTool(ctx, { action: 'create', summary: '测试简述', templateId: TEMPLATE, ...args }, agent, callId)
  return result.isError ? { error: result.text, id: null } : { error: null, id: JSON.parse(result.text).id }
}

/** The `get` result as an object, or `null` when the tool refused. */
async function getRecord(ctx, id, agent, callId) {
  const result = await callTool(ctx, { action: 'get', id }, agent, callId)
  return result.isError ? null : JSON.parse(result.text)
}

/** The board's runtime-context text for one session, as the model receives it. */
async function contextText(ctx, agent) {
  const assembly = await ctx.get('systemPrompt').assemble({ scope: agent })
  return (renderContextSections(assembly).find(section => section.name === 'requirement-board')?.text) ?? ''
}

/* ------------------------------------------------------------------ */

console.log(`C/D through the real composition (root: ${ROOT})`)
const root = await mkdtemp(join(tmpdir(), 'cd-compose-'))
const PARENT = ROSTER[0]
const CHILD = ROSTER[1]
let ctx = await mountBoard(root)
let taskId
let decisionId
let decisionRaisedId
try {
  /* [0] one checklist-free template, so an advance is judged by the rules under
   *     test rather than by the default template's review checklist. */
  console.log('\n[0] a checklist-free template through the flow-template tool')
  const made = await callNamed(ctx, 'flow_template', {
    action: 'create',
    id: TEMPLATE,
    name: '验证流程',
    nodes: [{ id: 'n1', name: '一' }, { id: 'n2', name: '二' }, { id: 'n3', name: '三' }],
  }, PARENT, 'cd-template')
  check('the template tool creates the flow template', !made.isError && made.text.includes(TEMPLATE), made.text.slice(0, 160))

  /* [1] kind immutability through the tool. */
  console.log('\n[1] kind immutability through the model-facing tool')
  const createdTask = await createViaTool(ctx, PARENT, 'cd-create-1', { title: '一个任务' })
  check('the create succeeds through the composition', createdTask.id !== null, String(createdTask.error).slice(0, 160))
  taskId = createdTask.id
  const before = await getRecord(ctx, taskId, PARENT, 'cd-get-1')
  check('the tool reads the record it created', before !== null && before.kind === 'task', JSON.stringify(before?.kind))
  const refused = await callTool(ctx, { action: 'update', id: taskId, kind: 'decision' }, PARENT, 'cd-update-kind')
  check('the tool refuses a session update of kind', refused.isError && refused.text.includes('kind'), refused.text.slice(0, 200))
  const after = await getRecord(ctx, taskId, PARENT, 'cd-get-2')
  check('the refused update wrote nothing', after?.kind === 'task' && after?.rev === before?.rev, JSON.stringify({ kind: after?.kind, rev: after?.rev, was: before?.rev }))
  const panelKind = await callTool(ctx, { action: 'update', id: taskId, kind: 'epic' }, undefined, 'cd-update-kind-panel')
  check('the panel path refuses an invalid kind too', panelKind.isError, panelKind.text.slice(0, 200))
  const ghost = await callTool(ctx, { action: 'update', id: taskId, patch: { kind: 'decision' } }, PARENT, 'cd-update-ghost')
  note(`an undeclared "patch" argument is ${ghost.isError ? 'refused' : 'ignored'} by the tool executor, and the kind stays ${(await getRecord(ctx, taskId, PARENT, 'cd-get-3'))?.kind}`)
  check('the stored kind is still the task kind', (await getRecord(ctx, taskId, PARENT, 'cd-get-3'))?.kind === 'task', 'the kind moved')

  /* [2] a decision is human-only in the operation, through the tool. */
  console.log('\n[2] a decision stays human-only through the tool')
  const madeDecision = await createViaTool(ctx, PARENT, 'cd-create-decision', { title: '该人拍板的问题', kind: 'decision' })
  check('the model can raise a decision', madeDecision.id !== null, String(madeDecision.error).slice(0, 160))
  decisionId = madeDecision.id
  check('the decision reads back as one', (await getRecord(ctx, decisionId, PARENT, 'cd-get-decision'))?.kind === 'decision', 'the kind is not decision')
  for (const [label, args] of [
    ['claim', { action: 'claim', id: decisionId }],
    ['queue', { action: 'queue', id: decisionId }],
    ['transition', { action: 'transition', id: decisionId, transition: 'advance' }],
    ['archive', { action: 'archive', id: decisionId }],
    ['delete', { action: 'delete', id: decisionId }],
    ['delegate', { action: 'delegate', id: decisionId, session: 'sess_child' }],
  ]) {
    const result = await callTool(ctx, args, PARENT, `cd-decision-${label}`)
    check(`the tool refuses ${label} on a decision by a session`, result.isError && /decision/.test(result.text), result.text.slice(0, 160))
  }
  const checklistDecision = await callTool(ctx, { action: 'checklist', id: decisionId, index: 0 }, PARENT, 'cd-decision-checklist')
  check('the tool refuses a checklist tick on a decision by a session', checklistDecision.isError, checklistDecision.text.slice(0, 160))
  note(`its refusal reads: ${JSON.stringify(checklistDecision.text.slice(0, 160))}`)
  const panelAdvance = await callTool(ctx, { action: 'transition', id: decisionId, transition: 'advance' }, undefined, 'cd-decision-panel')
  check('the panel path advances the decision', !panelAdvance.isError, panelAdvance.text.slice(0, 160))
  check('the decision survived every refusal', (await getRecord(ctx, decisionId, PARENT, 'cd-get-decision2')) !== null, 'the decision is gone')

  /* [3] the pool a model reads holds no decision. */
  console.log('\n[3] the claimable pool through the tool')
  const pool = await callTool(ctx, { action: 'list', claimable: true }, PARENT, 'cd-pool')
  check('the tool pool for a session has no decision', !pool.isError && !pool.text.includes(decisionId), pool.text.slice(0, 200))
  const panelPool = await callTool(ctx, { action: 'list', claimable: true }, undefined, 'cd-pool-panel')
  check('the tool pool for the panel has no decision', !panelPool.isError && !panelPool.text.includes(decisionId), panelPool.text.slice(0, 200))
  const decisionList = await callTool(ctx, { action: 'list', kind: 'decision' }, PARENT, 'cd-list-decisions')
  check('the kind filter still finds it', !decisionList.isError && decisionList.text.includes(decisionId), decisionList.text.slice(0, 200))

  /* [4] the runtime context the composition assembles. */
  console.log('\n[4] the assembled runtime context')
  const blocker = await createViaTool(ctx, PARENT, 'cd-create-blocker', { title: '紧急的在做的活', priority: 'urgent' })
  const blockerId = blocker.id
  const raised = await createViaTool(ctx, PARENT, 'cd-create-raised', { title: '被抬高的挡路者', priority: 'low' })
  const raisedId = raised.id
  const raisedDecision = await createViaTool(ctx, PARENT, 'cd-create-raised-decision', { title: '挡住紧急活的决策', kind: 'decision', priority: 'low' })
  decisionRaisedId = raisedDecision.id
  // `blocksOn` is structural through the tool: the lock comes first.
  const claimedBlocker = await callTool(ctx, { action: 'claim', id: blockerId }, PARENT, 'cd-claim-blocker')
  check('the session takes the lock it needs for the structural change', !claimedBlocker.isError, claimedBlocker.text.slice(0, 160))
  const linked = await callTool(ctx, { action: 'update', id: blockerId, blocksOn: [raisedId, decisionRaisedId] }, PARENT, 'cd-link')
  check('the tool writes the two gate links', !linked.isError, linked.text.slice(0, 200))
  const blockerRead = await getRecord(ctx, blockerId, PARENT, 'cd-get-blocker')
  check('the links read back and gate the record', blockerRead?.gated === true && blockerRead.blocksOn.length === 2, JSON.stringify({ gated: blockerRead?.gated, blocksOn: blockerRead?.blocksOn }))
  const raisedRead = await getRecord(ctx, raisedId, PARENT, 'cd-get-raised')
  check('the blocker the urgent work waits on is raised to urgent', raisedRead?.escalated === true && raisedRead.effectivePriority === 'urgent', JSON.stringify({ escalated: raisedRead?.escalated, effectivePriority: raisedRead?.effectivePriority }))
  const text = await contextText(ctx, PARENT)
  const line = id => text.split('\n').find(row => row.includes(id)) ?? ''
  check('the raised task carries [urgent↑] in the assembled text', line(raisedId).includes('[urgent↑]'), line(raisedId))
  check('the work that raises carries no arrow', line(blockerId).includes('[urgent]') && !line(blockerId).includes('↑'), line(blockerId))
  check('the raised decision carries the same tag in the assembled text', line(decisionRaisedId).includes('[urgent↑]'), line(decisionRaisedId))
  check('the decision is in the human section of the assembled text', line(decisionId).includes('·') && text.indexOf('Waiting on the human') < text.indexOf(decisionId), line(decisionId))
  check('the assembled text names the requester of the decision', line(decisionId).includes('requested by 甲'), line(decisionId))
  // One lock is enough for the tool path: give the blocker's back before the
  // eligibility legs, which need the session free.
  const released = await callTool(ctx, { action: 'release', id: blockerId, note: '链接已写好' }, PARENT, 'cd-release-blocker')
  check('the session gives the structural lock back', !released.isError, released.text.slice(0, 160))

  /* [5] eligibility as the model reads it, against the verdict it gets. */
  console.log('\n[5] eligibility in the tool result against the actual verdict')
  const idle = await createViaTool(ctx, PARENT, 'cd-create-idle', { title: '空闲任务' })
  const idleId = idle.id
  const idleGet = await getRecord(ctx, idleId, PARENT, 'cd-idle-get')
  check('an idle task reads claimable but not advanceable', idleGet?.claimable === true && idleGet?.advanceable === false, JSON.stringify({ claimable: idleGet?.claimable, advanceable: idleGet?.advanceable }))
  const attempt = await callTool(ctx, { action: 'transition', id: idleId, transition: 'advance' }, PARENT, 'cd-idle-advance')
  check('and the actual advance is refused for the lock it does not hold', attempt.isError && attempt.text.includes('lock'), attempt.text.slice(0, 200))
  const claimed = await callTool(ctx, { action: 'claim', id: idleId }, PARENT, 'cd-idle-claim')
  check('the session then claims it', !claimed.isError, claimed.text.slice(0, 160))
  const heldGet = await getRecord(ctx, idleId, PARENT, 'cd-held-get')
  check('holding the lock flips advanceable to true', heldGet?.advanceable === true && heldGet?.claimable === true, JSON.stringify({ advanceable: heldGet?.advanceable }))
  const advanced = await callTool(ctx, { action: 'transition', id: idleId, transition: 'advance' }, PARENT, 'cd-held-advance')
  check('and the advance succeeds', !advanced.isError, advanced.text.slice(0, 160))

  /* [6] a delegated decision in the assembled text. */
  console.log('\n[6] a delegated decision in the assembled text')
  const delegated = await callTool(ctx, { action: 'delegate', id: decisionId, session: CHILD.id }, undefined, 'cd-delegate-decision')
  check('the panel can delegate a decision', !delegated.isError, delegated.text.slice(0, 160))
  const childText = await contextText(ctx, CHILD)
  const occurrences = childText.split('\n').filter(row => row.includes(decisionId)).length
  const delegatedSection = childText.slice(childText.indexOf('Delegated to you'), childText.indexOf('Claimable for you'))
  check('a delegated decision is not offered as delegated work', !delegatedSection.includes(decisionId), delegatedSection.replace(/\n/g, ' | ').slice(0, 200))
  check('it is still named as waiting on the human', childText.slice(childText.indexOf('Waiting on the human')).includes(decisionId), childText.slice(childText.indexOf('Waiting on the human')).replace(/\n/g, ' | ').slice(0, 200))
  const childDelegatedGet = await getRecord(ctx, decisionId, CHILD, 'cd-child-decision')
  check('and the named session still cannot claim it', childDelegatedGet?.claimable === false, JSON.stringify({ claimable: childDelegatedGet?.claimable }))
  note(`a delegated decision appears ${occurrences} time(s) in the assembled text for its named session`)
} finally {
  await ctx.fiber.dispose()
}

/* Phase 2: write a record that predates `kind`, with the board unmounted. */
console.log('\n[7] a record written before `kind` existed, read back through the tool')
let raw
try {
  raw = await openRawBoard({ backend: 'json', dir: root })
  const live = raw.domain.table('requirements').get(taskId)
  const legacy = { ...live, id: 'req_legacycd1', title: '旧记录' }
  delete legacy.kind
  delete legacy.requestedBy
  delete legacy.parentId
  delete legacy.blocksOn
  delete legacy.lock
  delete legacy.delegatedTo
  delete legacy.role
  await raw.domain.table('requirements').put('req_legacycd1', legacy)
  note(`the unmounted store holds the legacy record with keys: ${Object.keys(legacy).join(',')}`)
  await raw.close()
  raw = undefined
} finally {
  if (raw !== undefined) await raw.close()
}

/* Phase 3: remount and read both the legacy record and the phase-1 records. */
ctx = await mountBoard(root)
try {
  const legacyGet = await getRecord(ctx, 'req_legacycd1', PARENT, 'cd-legacy-get')
  check('the tool reads a legacy record as a task', legacyGet !== null && legacyGet.kind === 'task', JSON.stringify(legacyGet?.kind))
  check('its absent requester reads as the empty string', legacyGet?.requestedBy === '', JSON.stringify(legacyGet?.requestedBy))
  check('its absent links read as the normalized values', legacyGet?.parentId === null && Array.isArray(legacyGet?.blocksOn) && legacyGet.blocksOn.length === 0 && legacyGet?.gated === false, JSON.stringify({ parentId: legacyGet?.parentId, blocksOn: legacyGet?.blocksOn, gated: legacyGet?.gated }))
  const legacyList = await callTool(ctx, { action: 'list' }, PARENT, 'cd-legacy-list')
  check('the tool list reads it the same way', legacyList.text.includes('req_legacycd1'), legacyList.text.slice(0, 160))
  const survived = await getRecord(ctx, taskId, PARENT, 'cd-survived-get')
  check('the task written before the remount survived with its kind', survived?.kind === 'task', JSON.stringify({ kind: survived?.kind, rev: survived?.rev }))
  const decisionBack = await getRecord(ctx, decisionId, PARENT, 'cd-decision-back')
  check('the decision survived the remount as a decision', decisionBack?.kind === 'decision', JSON.stringify(decisionBack?.kind))
  const refusedBack = await callTool(ctx, { action: 'transition', id: decisionId, transition: 'advance' }, PARENT, 'cd-decision-back-transition')
  check('and it is still human-only after the remount', refusedBack.isError && /decision/.test(refusedBack.text), refusedBack.text.slice(0, 160))
  const escalatedBack = await getRecord(ctx, decisionRaisedId, PARENT, 'cd-escalated-back')
  check('the derived escalation is recomputed after the remount', escalatedBack?.escalated === true && escalatedBack?.effectivePriority === 'urgent', JSON.stringify({ escalated: escalatedBack?.escalated, effectivePriority: escalatedBack?.effectivePriority }))
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed through the composition`)
process.exit(failures === 0 ? 0 : 1)
