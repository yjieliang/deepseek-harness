/**
 * Browser-half smoke test.
 *
 * Runs `client.js` outside a browser. The module loader, React, the Client
 * services, `fetch`, and `EventSource` are stubbed, then the registered page is
 * rendered through a small React stand-in with working state and effects, and
 * driven through the stubbed routes. This catches the failures that only appear
 * when a page actually renders and is clicked — a typo in a prop, a null
 * requirement, a missing locale key, an unguarded rejection.
 *
 * Run with `node tests/client-smoke.mjs`.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Shallow dependency comparison, matching React's default. */
function sameDeps(previous, next) {
  if (previous === undefined || next === undefined || previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

let failures = 0
let checks = 0

/** Assert a condition and record the outcome. */
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/* ------------------------------------------------------------------ React */

/**
 * A React stand-in: function components, per-instance state slots, memoized
 * values, and effects flushed after each pass with a re-render when an effect
 * or handler changed state. Keyed by component name plus render occurrence, so
 * a re-render from the root restores the same slots.
 */
function createReactHarness() {
  const stateSlots = new Map()
  const effectSlots = new Map()
  const refSlots = new Map()
  const callbackSlots = new Map()
  const cleanups = []
  let counters = new Map()
  let keys = []
  let hookIndex = 0
  let dirty = false
  let collected = []
  let effectQueue = []
  let mounted = new Set()

  /** Render one element tree, settling after state updates settle. */
  const render = (element, maxPasses = 8) => {
    let html = ''
    for (let pass = 0; pass < maxPasses; pass += 1) {
      dirty = false
      counters = new Map()
      keys = []
      collected = []
      effectQueue = []
      mounted = new Set()
      html = walk(element, 0)
      for (const slot of effectQueue) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        const cleanup = slot.effect()
        slot.cleanup = typeof cleanup === 'function' ? cleanup : null
      }
      // Unmount cleanup: a slot an effect did not re-claim belongs to a
      // component that left the tree.
      for (const slots of effectSlots.values()) {
        for (let index = 0; index < slots.length; index += 1) {
          const slot = slots[index]
          if (slot === undefined || mounted.has(slot)) continue
          if (typeof slot.cleanup === 'function') slot.cleanup()
          slots[index] = undefined
        }
      }
      if (!dirty) return { html, collected }
    }
    throw new Error('the render did not settle')
  }

  /** Walk a tree, invoking function components with the current slots. */
  const walk = (node, depth) => {
    if (depth > 60) throw new Error('render recursion is too deep')
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(child => walk(child, depth + 1)).join('')
    const { type, props } = node
    if (typeof type === 'function') {
      const name = type.displayName ?? type.name ?? 'anonymous'
      const occurrence = counters.get(name) ?? 0
      counters.set(name, occurrence + 1)
      const key = `${name}#${occurrence}`
      const outerHookIndex = hookIndex
      const outerKey = keys[keys.length - 1]
      keys.push(key)
      hookIndex = 0
      const output = type(props)
      hookIndex = outerHookIndex
      keys.pop()
      if (outerKey !== undefined) keys.push(outerKey)
      return walk(output, depth + 1)
    }
    const inner = walk(props?.children ?? [], depth + 1)
    if (typeof type === 'string' && type === 'style') return ''
    collected.push({ type, props, html: inner })
    return inner
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = []
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child)
        else flat.push(child)
      }
      return { type, props: { ...(props ?? {}), children: flat } }
    },
    useState(initial) {
      const key = keys[keys.length - 1]
      const slots = stateSlots.get(key) ?? []
      stateSlots.set(key, slots)
      const index = hookIndex
      hookIndex += 1
      if (slots[index] === undefined) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[index]
      return [slot.value, next => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (value !== slot.value) {
          slot.value = value
          dirty = true
        }
      }]
    },
    useEffect(effect, deps) {
      const key = keys[keys.length - 1]
      const slots = effectSlots.get(key) ?? []
      effectSlots.set(key, slots)
      const index = hookIndex
      hookIndex += 1
      const previous = slots[index]
      // React re-runs an effect only when its dependencies changed.
      const changed = previous === undefined || deps === undefined || !sameDeps(previous.deps, deps)
      const slot = previous ?? { cleanup: null }
      slot.effect = effect
      slot.deps = deps
      slots[index] = slot
      mounted.add(slot)
      if (changed) effectQueue.push(slot)
    },
    useMemo(factory) {
      hookIndex += 1
      return factory()
    },
    useCallback(callback, deps) {
      // React hands back the same function while its dependencies are unchanged,
      // and a component whose effects name that function then stops re-running.
      const key = keys[keys.length - 1]
      const slots = callbackSlots.get(key) ?? []
      callbackSlots.set(key, slots)
      const index = hookIndex
      hookIndex += 1
      const previous = slots[index]
      if (previous !== undefined && deps !== undefined && sameDeps(previous.deps, deps)) return previous.callback
      slots[index] = { callback, deps }
      return callback
    },
    useRef(initial) {
      // A ref keeps one object for the life of the component: code that writes
      // `ref.current` from an async callback must see it after a re-render.
      const key = keys[keys.length - 1]
      const slots = refSlots.get(key) ?? []
      refSlots.set(key, slots)
      const index = hookIndex
      hookIndex += 1
      if (slots[index] === undefined) slots[index] = { current: initial ?? null }
      return slots[index]
    },
  }

  return { React, render, cleanups }
}

const harness = createReactHarness()
const React = harness.React

/* ------------------------------------------------------------- primitives */

const PRIMITIVES_MODULE = '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Stand-in for the platform primitives, which are TypeScript source and cannot
 * be required here. Each one renders the DOM its real counterpart renders — a
 * native `type="button"` button, `Tag`'s `data-tone`, the modal's `role="dialog"`
 * surface, `Toast`'s `role="alert"` — so checks read rendered output and native
 * attributes. Variants and sizes are deliberately absent: the real components
 * only turn them into CSS-module classes, so asserting them here would test a
 * contract the DOM does not have (the browser probe covers styling).
 * @param React - the harness React, so primitives share its element factory.
 * @returns the module object the client half destructures.
 */
function createPrimitives(React) {
  const h = React.createElement
  /** Leading icon plus children, matching each primitive's render order. */
  const body = (icon, children) => [
    ...(icon === undefined || icon === null ? [] : [icon]),
    ...(Array.isArray(children) ? children : children === undefined || children === null ? [] : [children]),
  ]

  // `type` is applied before `rest` so a caller that names a submit control gets
  // one, exactly as the real Button does; a control that names none is a plain
  // button because that is the default the platform sets first.
  const Button = ({ variant, size, icon, className, children, ...rest }) =>
    h('button', { type: 'button', ...rest, className }, ...body(icon, children))

  const Pill = ({ active, className, children, onClick, ...rest }) => onClick === undefined
    ? h('span', { className }, children)
    : h('button', { ...rest, type: 'button', className, onClick }, children)

  const Tag = ({ tone = 'outline', className, children }) => h('span', { className, 'data-tone': tone }, children)

  const Input = ({ icon, className, ...rest }) => h('span', { className }, ...body(icon, h('input', rest)))

  const Checkbox = ({ checked, onChange, label, disabled = false, title, className }) =>
    h('label', { className, title },
      h('input', { type: 'checkbox', checked, disabled, onChange: event => onChange(event.target.checked) }),
      h('span', null, label))

  const StateDot = ({ state, className }) => h('span', { className, 'data-state': state })

  // The mask is the layer's own close target, as the real Modal's is: an
  // aria-hidden element whose click command is `onClose`. Escape reaches the same
  // command through the platform modal layer, which this stand-in cannot run.
  const Modal = ({ open, onClose, title, closeLabel, description, children, footer, className, headless = false }) => {
    if (!open) return null
    return h('div', { role: 'presentation', onKeyDownCapture: undefined },
      h('div', { 'aria-hidden': 'true', onClick: onClose }),
      h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1, className },
        ...(headless
          ? [children]
          : [h('h2', null, title), description === undefined ? null : h('p', null, description), children, footer, closeLabel])))
  }

  const Toast = ({ text, icon, tone, holdMs = 3000, actions, onDone }) => h('div', {
    role: 'alert',
    style: { '--dsh-toast-hold': `${holdMs}ms` },
  },
    ...body(tone === 'success' ? h('span', { 'aria-hidden': true }) : icon, [text, ...(actions ?? []).map(action => h('button', { key: action.label, type: 'button', onClick: action.onClick }, action.label))]))

  return { Button, Pill, Tag, Input, Checkbox, StateDot, Modal, Toast }
}

const primitives = createPrimitives(React)

/* ---------------------------------------------------------------- globals */

class FakeEventSource {
  static instances = []
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closed = false
    FakeEventSource.instances.push(this)
  }

  addEventListener(name, listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }

  emit(name, payload) {
    for (const listener of this.listeners.get(name) ?? []) listener(payload)
  }

  close() {
    this.closed = true
  }
}

const documentStub = {
  visibilityState: 'visible',
  listeners: new Map(),
  addEventListener(name, listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  },
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter(entry => entry !== listener))
  },
}

let snapshotPayload = null
let snapshotFailure = null
/** The trust gate's refusal, as the panel route answers it: `{ status, error }`. */
let snapshotRefusal = null
let commandFailure = null
/** The receipt a successful stubbed command answers with. */
let commandData = { done: true }
/** Per-action receipt data; an action without an entry answers `commandData`. */
let commandAnswers = {}
/** Per-action refusal errors, for the refusals a test deliberately provokes. */
let commandRefusals = {}
/** Ids the stubbed takeover read reports; `null` answers with every listed id. */
let claimableIds = null
let claimableFailure = false
/** The ids each session's reading of the takeover pool reports. */
let mePool = {}
/** The refusal the stubbed image route answers with; `null` stores the image. */
let imageUploadFailure = null
/** A pending promise an upload waits on, so a test can hold one in flight. */
let imageUploadGate = null
/** How many images the stubbed image route has stored. */
let imageCount = 0
const requests = []
/**
 * Holds on whole-snapshot reads, oldest first: each entry answers one read.
 *
 * A read that reaches the stub while a hold is queued waits on that hold, so a
 * test can let a newer read answer first and then release the older one.
 */
const snapshotHolds = []

/**
 * Hold the next whole-snapshot read until the returned release is called.
 *
 * The answer is built from the payload in force when the hold is queued, so the
 * release order decides which revision reaches the page, not the payload's
 * later value.
 * @param revision - the document revision the held answer reports.
 * @returns a function that releases the held answer.
 */
function holdSnapshotRead(revision) {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const held = snapshotPayload
  snapshotHolds.push(async () => {
    await gate
    return {
      status: 200,
      json: async () => ({ ok: true, data: { ...held, revision, requirements: held.requirements, total: held.requirements.length } }),
    }
  })
  return release
}

/** Stub the routes the controller talks to, applying the list filter for real. */
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url, init })
  const parsed = new URL(String(url), 'http://127.0.0.1:3080')
  // The image route takes the raw bytes, so its stub answers with the reference
  // a `create`/`update` command names, and only after any held gate is released.
  if (parsed.pathname === '/api/requirement-board/image') {
    if (imageUploadFailure !== null) {
      return { status: imageUploadFailure.status, json: async () => ({ ok: false, error: imageUploadFailure.error }) }
    }
    if (imageUploadGate !== null) await imageUploadGate
    imageCount += 1
    const name = parsed.searchParams.get('name') ?? 'image'
    return {
      status: 200,
      json: async () => ({
        ok: true,
        data: {
          image: {
            id: `img_${imageCount}`,
            name,
            mediaType: String(init.headers?.['content-type'] ?? 'image/png'),
            byteLength: typeof init.body?.size === 'number' ? init.body.size : 0,
            width: 800,
            height: 600,
            createdAt: new Date(now).toISOString(),
          },
        },
      }),
    }
  }
  if (parsed.pathname.endsWith('/command')) {
    if (commandFailure !== null) return { status: 409, json: async () => ({ ok: false, error: commandFailure }) }
    const body = init.body === undefined ? {} : JSON.parse(String(init.body))
    const refusal = commandRefusals[body.action]
    if (refusal !== undefined) return { status: 409, json: async () => ({ ok: false, error: refusal }) }
    const answer = Object.hasOwn(commandAnswers, body.action) ? commandAnswers[body.action] : commandData
    return { status: 200, json: async () => ({ ok: true, data: answer }) }
  }
  if (snapshotFailure !== null) return { status: 500, json: async () => ({ ok: false, error: snapshotFailure }) }
  if (snapshotRefusal !== null) {
    return { status: snapshotRefusal.status, json: async () => ({ ok: false, error: snapshotRefusal.error }) }
  }
  let items = snapshotPayload.requirements
  const kind = parsed.searchParams.get('kind')
  if (kind !== null && kind !== '') items = items.filter(item => (item.kind ?? 'task') === kind)
  // The service reads `role` as the routing role in force, and an empty value
  // means "no filter" rather than "the unrecorded role" (`host/service.js`).
  const role = parsed.searchParams.get('role')
  if (role !== null && role !== '') items = items.filter(item => (item.role ?? '') === role)
  const status = parsed.searchParams.get('status')
  // `open` is every unsettled status, not the literal string (`host/service.js`).
  if (status === 'open') items = items.filter(item => item.status !== 'done' && item.status !== 'archived')
  else if (status !== null && status !== '') items = items.filter(item => item.status === status)
  const priority = parsed.searchParams.get('priority')
  if (priority !== null && priority !== '') items = items.filter(item => item.priority === priority)
  const owner = parsed.searchParams.get('owner')
  if (owner !== null && owner !== '') items = items.filter(item => item.owner === owner)
  const query = parsed.searchParams.get('query')
  if (query !== null && query !== '') {
    items = items.filter(item => String(item.title).includes(query) || String(item.description).includes(query))
  }
  if (parsed.searchParams.get('claimable') !== 'true') {
    if (snapshotHolds.length > 0) return snapshotHolds.shift()()
    return { status: 200, json: async () => ({ ok: true, data: { ...snapshotPayload, requirements: items, total: items.length } }) }
  }
  if (claimableFailure) return { status: 500, json: async () => ({ ok: false, error: { code: 'internal', message: 'takeover read failed' } }) }
  const me = parsed.searchParams.get('me') ?? ''
  const ids = me === '' ? (claimableIds ?? items.map(item => item.id)) : (mePool[me] ?? [])
  const takeable = items.filter(item => ids.includes(item.id))
  return { status: 200, json: async () => ({ ok: true, data: { ...snapshotPayload, requirements: takeable, total: takeable.length } }) }
}
globalThis.EventSource = FakeEventSource
globalThis.document = documentStub

/* ------------------------------------------------------------ load client */

const source = await readFile(join(here, '..', 'client.js'), 'utf8')
let registration = null
/** The client half's module table: React plus the primitives stand-in. */
const clientRequire = specifier => {
  if (specifier === 'react') return React
  if (specifier === PRIMITIVES_MODULE) return primitives
  throw new Error(`unexpected module request: ${specifier}`)
}
new Function('window', 'require', source)(
  { __ModuleLoader__: { load(entry) { registration = entry } } },
  clientRequire,
)

check('the module registers itself under the package name', registration?.id === 'dsh-requirement-board', registration?.id)
const plugin = registration.factory(clientRequire)
check('the plugin declares its Client services', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), JSON.stringify(plugin.inject))

/* --------------------------------------------------------- board fixture */

const now = Date.now()
const iso = offsetMs => new Date(now - offsetMs).toISOString()

/** The retained audit trail the fixture requirement carries. */
const requirementHistory = [
  { id: 'evt_1', at: iso(86_400_000 * 3), by: 'ses_A', byName: '', action: 'create', from: null, fromName: '', to: 'review', toName: '需求评审', fromStatus: null, toStatus: 'active', note: '', force: false, durationMs: null },
  { id: 'evt_2', at: iso(86_400_000 * 2), by: 'ses_A', byName: '', action: 'advance', from: 'review', fromName: '需求评审', to: 'design', toName: '方案设计', fromStatus: 'active', toStatus: 'active', note: '评审通过', force: false, durationMs: 86_400_000 },
  { id: 'evt_3', at: iso(3_600_000), by: 'ses_B', byName: '', action: 'advance', from: 'design', fromName: '方案设计', to: 'build', toName: '开发实现', fromStatus: 'active', toStatus: 'active', note: '方案确认', force: false, durationMs: 82_800_000 },
]

const requirement = {
  id: 'req_demo000001',
  title: '跨会话需求看板',
  summary: '让多个会话看到同一份需求进度，一眼就知道每条要做什么。',
  description: '让多个会话共享同一份需求进度。',
  priority: 'high',
  owner: '张三',
  sessions: ['ses_A', 'ses_B'],
  templateId: 'tpl-standard',
  nodeId: 'build',
  status: 'active',
  kind: 'task',
  role: 'art',
  lock: null,
  reservedBy: null,
  delegatedTo: null,
  requestedBy: '',
  blockReason: '',
  blockedAt: null,
  labels: [],
  rev: 7,
  createdAt: iso(86_400_000 * 3),
  updatedAt: iso(60_000),
  template: { id: 'tpl-standard', name: '标准研发流程', version: 1, builtin: true, nodeCount: 5 },
  flow: [
    { id: 'review', name: '需求评审', order: 0, dependsOn: [], assignee: '', description: '', completion: { type: 'checklist', checklist: ['范围明确'] }, status: 'done', enteredAt: iso(86_400_000 * 3), completedAt: iso(86_400_000 * 2), checks: [true], note: '' },
    { id: 'design', name: '方案设计', order: 1, dependsOn: ['review'], assignee: '李四', description: '给出方案', completion: { type: 'manual', checklist: [], requireNote: true }, status: 'done', enteredAt: iso(86_400_000 * 2), completedAt: iso(3_600_000), checks: [], note: '' },
    { id: 'build', name: '开发实现', order: 2, dependsOn: ['design'], assignee: '王五', description: '', completion: { type: 'manual', checklist: [], requireNote: false }, status: 'active', enteredAt: iso(3_600_000), completedAt: null, checks: [], note: '' },
    { id: 'verify', name: '测试验证', order: 3, dependsOn: ['build'], assignee: '', description: '', completion: { type: 'checklist', checklist: ['用例执行完成', '缺陷关闭'] }, status: 'pending', enteredAt: null, completedAt: null, checks: [false, false], note: '' },
    { id: 'release', name: '发布上线', order: 4, dependsOn: ['verify'], assignee: '', description: '', completion: { type: 'manual', checklist: [], requireNote: true }, status: 'pending', enteredAt: null, completedAt: null, checks: [], note: '' },
  ],
  progress: { done: 2, total: 5, ratio: 0.4, activeNode: { id: 'build', name: '开发实现', enteredAt: iso(3_600_000) } },
  lastTransition: requirementHistory.at(-1),
  history: requirementHistory,
}

/**
 * A decision requirement: the person's own queue, routed to the reserved
 * `human` role, with `requestedBy` naming who asked for the call.
 */
const decision = {
  ...structuredClone(requirement),
  id: 'req_demo000002',
  title: '是否走自研渲染',
  kind: 'decision',
  role: 'human',
  requestedBy: 'ses_A',
  priority: 'urgent',
  progress: { done: 0, total: 5, ratio: 0, activeNode: { id: 'review', name: '需求评审', enteredAt: iso(7_200_000) } },
  nodeId: 'review',
}

/** A requirement another session soft-reserved, and one handed to a session. */
const reserved = { ...structuredClone(requirement), id: 'req_demo000003', title: '被预留的活', reservedBy: 'ses_Q', rev: 3 }
const handed = {
  ...structuredClone(requirement),
  id: 'req_demo000004',
  title: '已派发给子会话的活',
  role: 'tmp_req_demo000004_delegate',
  rev: 4,
  delegatedTo: { session: 'ses_sub', name: '子会话', roleId: 'tmp_req_demo000004_delegate', roleBefore: 'art', at: iso(3_600_000) },
}

/**
 * A pair joined by a gate link, as the Host derives it.
 *
 * `gateBlocked` waits on `gateBlocker` (`blocksOn`), is currently stopped by it
 * (`blockedBy`, `gated`), and is its sub-requirement (`parentId`/`children`).
 * `gateBlocker` holds up in-progress work, so it reads one level higher than it is
 * stored (`effectivePriority`, `escalated`) — a derived value nothing writes back.
 */
const gateBlocker = {
  ...structuredClone(requirement),
  id: 'req_demo000005',
  title: '被抬高的挡路活',
  priority: 'normal',
  rev: 5,
  effectivePriority: 'urgent',
  escalated: true,
  blocksOn: [],
  blockedBy: [],
  gated: false,
  parentId: null,
  children: ['req_demo000006'],
}
const gateBlocked = {
  ...structuredClone(requirement),
  id: 'req_demo000006',
  title: '等着的下游活',
  priority: 'urgent',
  rev: 6,
  effectivePriority: 'urgent',
  escalated: false,
  blocksOn: ['req_demo000005'],
  blockedBy: ['req_demo000005'],
  gated: true,
  parentId: 'req_demo000005',
  children: [],
}

/** The single-requirement board every render starts from. */
function boardSnapshot(overrides = {}) {
  return {
    revision: 12,
    generatedAt: new Date(now).toISOString(),
    requirements: [requirement],
    total: 1,
    templates: [{ id: 'tpl-standard', name: '标准研发流程', description: '', builtin: true, version: 1, nodes: requirement.flow.map(node => ({ id: node.id, name: node.name, order: node.order, dependsOn: node.dependsOn, assignee: node.assignee, description: node.description, completion: node.completion })) }],
    roles: {
      items: [
        { id: 'art', name: '美术', duties: ['资产规范'], source: 'preset', ephemeral: false, createdAt: iso(86_400_000 * 5), updatedAt: iso(86_400_000), dutiesMissing: false, holders: { online: 2, idle: 1, running: 1 }, open: 1 },
        { id: 'tmp_req_demo000001_delegate', name: '临时执行者', duties: [], source: 'delegated', ephemeral: true, boundSession: 'ses_sub', boundTask: requirement.id, createdAt: iso(3_600_000), updatedAt: iso(3_600_000), dutiesMissing: true, holders: { online: 0, idle: 0, running: 0 }, open: 0 },
      ],
      unregistered: [
        { id: 'qa', dutiesMissing: false, holders: { online: 1, idle: 1, running: 0 }, open: 1 },
      ],
    },
    stats: {
      generatedAt: new Date(now).toISOString(),
      total: 1,
      archived: 0,
      byStatus: { active: 1, blocked: 0, done: 0, archived: 0 },
      byPriority: { low: 0, normal: 0, high: 1, urgent: 0 },
      completionRate: 0.4,
      byOwner: [{ owner: '张三', total: 1, done: 0, blocked: 0, active: 1 }],
      bySession: [{ session: 'ses_A', total: 1, done: 0, blocked: 0, active: 1 }],
      nodeDurations: [{ templateId: 'tpl-standard', nodeId: 'review', name: '需求评审', samples: 1, avgMs: 86_400_000, minMs: 86_400_000, maxMs: 86_400_000 }],
      blocked: [],
      stalled: [],
    },
    ...overrides,
  }
}

/**
 * The service's queue projection for one session: rows ordered by session, each
 * row's items in the order that session will take them.
 */
function queueProjection(session, ids) {
  return [{
    session,
    sessionName: session,
    items: ids.map((id, index) => ({ id, at: iso(60_000 * (index + 1)) })),
    head: ids.length === 0 ? null : { id: ids[0], at: iso(60_000) },
    length: ids.length,
    updatedAt: ids.length === 0 ? null : iso(60_000),
  }]
}

snapshotPayload = boardSnapshot()

/* --------------------------------------------------------- apply + render */

const registrations = []
let localeDicts = null
let boundLocale = 'en'
const localeStub = {
  register(_ns, dicts) {
    localeDicts = dicts
    return () => {}
  },
  bind() {
    return key => localeDicts?.[boundLocale]?.[key]
  },
}
const disposers = []
const ctx = {
  get: name => (name === 'locale' ? localeStub : undefined),
  effect(callback) {
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  slots: {
    inject(_name, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

plugin.apply(ctx)

check('a locale dictionary was registered', localeDicts !== null)
if (localeDicts !== null) {
  const enKeys = Object.keys(localeDicts.en).sort()
  const zhKeys = Object.keys(localeDicts.zh).sort()
  const enOnly = enKeys.filter(key => !zhKeys.includes(key))
  const zhOnly = zhKeys.filter(key => !enKeys.includes(key))
  check('en and zh dictionaries cover the same keys', enOnly.length === 0 && zhOnly.length === 0, `en-only: ${enOnly.join(',')} zh-only: ${zhOnly.join(',')}`)
  check('no dictionary value is empty', enKeys.every(key => typeof localeDicts.en[key] === 'string' && localeDicts.en[key] !== ''))
  check('the dictionaries are not trivially identical', enKeys.some(key => localeDicts.en[key] !== localeDicts.zh[key]))
}
check('three slot contributions were registered', registrations.length === 3, String(registrations.length))
const sidebar = registrations.find(entry => entry.options.name === 'sidebar.panellist')
const main = registrations.find(entry => entry.options.name === 'main')
const overlay = registrations.find(entry => entry.options.name === 'shell.overlay')
check('the sidebar entry uses the panel id', sidebar?.options.id === 'requirement-board')
check('the main panel uses the same key', main?.options.key === 'requirement-board')
check('both entries declare the locale namespace', sidebar?.options.locale === 'requirement-board' && main?.options.locale === 'requirement-board')
check('the sidebar entry has a label resolver', typeof sidebar?.options.label === 'function' && sidebar.options.label() !== '')
check('the main panel is not session-scoped', main?.options.scope === undefined && main?.options.sessions === undefined)
check('the toast host is an app-level overlay entry', overlay?.options.id === 'requirement-board.toast' && overlay?.options.locale === 'requirement-board')

const face = main.options.inject()
check('the main face exposes the board hook source', typeof face.hooks?.board?.getSnapshot === 'function' && typeof face.hooks.board.subscribe === 'function')
check('the main face exposes the controller callbacks', typeof face.refresh === 'function' && typeof face.setFilter === 'function' && typeof face.controller.command === 'function')
check('the main face exposes the translator', typeof face.t === 'function' && face.t('title') !== '')
const toastFace = overlay.options.inject()
check('the toast host exposes its hook source and dismissal', typeof toastFace.hooks?.toast?.getSnapshot === 'function' && typeof toastFace.dismissToast === 'function')
check('the hook source publishes to subscribers', (() => {
  let seen = 0
  const unsubscribe = toastFace.hooks.toast.subscribe(() => { seen += 1 })
  face.controller.notify('info', 'probe')
  unsubscribe()
  face.controller.notify('info', 'probe-again')
  toastFace.dismissToast()
  return seen === 1
})())

/* ------------------------------------------------------- loading states */

boundLocale = 'en'
const loadingProps = { ...face, useBoard: () => face.hooks.board.getSnapshot() }
const loadingPage = harness.render(React.createElement(main.component, loadingProps))
check('the page shows its loading state before the first snapshot', loadingPage.html.includes('Loading the board'))
const rolesButton = loadingPage.collected.find(element => element.type === 'button' && element.html === localeDicts.en.roles)
check('the header offers role management', rolesButton !== undefined)
rolesButton?.props.onClick()
const loadingRoles = harness.render(React.createElement(main.component, loadingProps))
check('the role list renders a skeleton while it loads',
  loadingRoles.collected.some(element => String(element.props.className ?? '').includes('rb-skeleton-row')))
loadingRoles.collected.find(element => element.type === 'button' && element.html === localeDicts.en.close)?.props.onClick()
check('closing the role dialog clears it', !harness.render(React.createElement(main.component, loadingProps)).html.includes(localeDicts.en.newRole))

await new Promise(resolve => setTimeout(resolve, 0))
const snapshot = face.hooks.board.getSnapshot()
check('the controller fetched a snapshot', snapshot.status === 'ready' && snapshot.requirements.length === 1, JSON.stringify(snapshot.status))
let boardPublishes = 0
const stopBoard = face.hooks.board.subscribe(() => { boardPublishes += 1 })
void face.refresh()
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))
stopBoard()
check('the board hook source publishes to subscribers', boardPublishes >= 1, String(boardPublishes))
check('an unfiltered refresh reads the host takeover set', requests.some(isTakeoverRead))
check('the SSE stream was opened at the documented route', FakeEventSource.instances.length === 1 && FakeEventSource.instances[0].url === '/api/requirement-board/events')
FakeEventSource.instances[0].emit('ready')
FakeEventSource.instances[0].emit('changed')
await new Promise(resolve => setTimeout(resolve, 0))
check('the ready and changed events mark the page live', face.hooks.board.getSnapshot().connected === true)

const pageProps = { ...face, useBoard: () => face.hooks.board.getSnapshot() }

/** Render the page and find host elements by their visible text. */
function renderPage() {
  const { html, collected } = harness.render(React.createElement(main.component, pageProps))
  const text = element => element.html
  return {
    html,
    collected,
    buttons: collected.filter(element => element.type === 'button'),
    findButton(label) {
      const found = collected.find(element => element.type === 'button' && element.props.disabled !== true && text(element).includes(label))
      if (found === undefined) throw new Error(`no enabled button renders "${label}"`)
      return found
    },
    findInput(predicate) {
      const found = collected.find(element => ['input', 'textarea', 'select'].includes(element.type) && predicate(element.props))
      if (found === undefined) throw new Error('no matching input renders')
      return found
    },
  }
}

/**
 * One meta-grid reading, found by the label cell it sits under.
 *
 * The grid renders a dim label above its own value, so a reading is two
 * elements rather than one `label: value` line.
 */
function metaValue(page, label) {
  const index = page.collected.findIndex(element => String(element.props.className ?? '').includes('rb-meta-k') && element.html === label)
  return index < 0 ? null : page.collected[index + 1]?.html ?? null
}

/** Fill a dictionary entry's `{name}` placeholders the way the panel does. */
function tst(key, params) {
  return String(localeDicts[boundLocale][key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => params?.[name] ?? whole)
}

/** Render the app-level toast host against the current toast fact. */
function renderToastHost() {
  return harness.render(React.createElement(overlay.component, {
    ...toastFace,
    useToast: () => toastFace.hooks.toast.getSnapshot(),
    t: tst,
  }))
}

/** The toast host's rendered text. */
function renderToast() {
  return renderToastHost().html
}

/** Let every pending microtask and timer callback settle. */
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** How many whole-snapshot reads the page made, the takeover side read aside. */
function snapshotReads() {
  return requests.filter(request => String(request.url).includes('/snapshot') && !isTakeoverRead(request)).length
}

/** Let a queued committed-change read happen, trailing delay included. */
async function settleChanges() {
  await new Promise(resolve => setTimeout(resolve, 400))
  await settle()
}

/** The command bodies the page posted, in order. */
function commandBodies() {
  return requests.filter(request => String(request.url).includes('/command')).map(request => JSON.parse(request.init.body))
}

/** The image uploads the page posted, in order. */
function imageUploads() {
  return requests.filter(request => new URL(String(request.url), 'http://127.0.0.1:3080').pathname === '/api/requirement-board/image')
}

/** Whether one request is the bare takeover side read, not a filtered snapshot. */
function isTakeoverRead(request) {
  const parsed = new URL(String(request.url), 'http://127.0.0.1:3080')
  const keys = [...parsed.searchParams.keys()]
  return parsed.searchParams.get('claimable') === 'true' && keys.every(key => ['claimable', 'limit', 'me'].includes(key))
}

/** The most recent filtered snapshot read, excluding the takeover side read. */
function lastSnapshotUrl() {
  return String(requests.filter(request => String(request.url).includes('/snapshot') && !isTakeoverRead(request)).at(-1).url)
}

boundLocale = 'en'
const page = renderPage()
check('the page renders the localized panel title', page.html.includes('Requirement Board'))
check('the page renders the requirement title', page.html.includes('跨会话需求看板'))
check('the page renders every flow node', requirement.flow.every(node => page.html.includes(node.name)),
  requirement.flow.filter(node => !page.html.includes(node.name)).map(node => node.name).join(','))
check('the page renders the completion rate', page.html.includes('40%'))
check('the page renders the transition history', page.html.includes('评审通过') && page.html.includes('方案确认'))
check('the projected last transition drives the summary line', page.html.includes('Last transition'))
check('the page renders the selected node detail', page.html.includes('Node detail'))
check('an active node offers the advance action', page.buttons.some(element => element.html === 'Finish and advance'))
check('the active node offers neither rollback nor jump', !page.html.includes('Roll back here') && !page.html.includes('Jump here'))
// The filter area is folded until a reader opens it, so its labels are read
// through the switch that shows them; closing it again restores the folded
// reading the rest of this run reads from.
const openedPage = openFilters()
check('the page renders the filters with visible labels', ['Search', 'Owner', 'Session', 'Status', 'Priority', 'Role', 'Kind', 'Only claimable', 'Session (me)'].every(label => openedPage.html.includes(label)), openedPage.html.slice(0, 0) || 'a filter label is missing')
check('the role filter is an ordinary host filter, with no local narrowing tag',
  !openedPage.collected.some(element => String(element.props?.className ?? '').includes('rb-local-tag'))
  && !openedPage.collected.some(element => String(element.props?.title ?? '').includes('no role filter yet')),
  openedPage.html.slice(0, 0) || 'a local narrowing tag survived')
filterToggleOf(renderPage()).props.onClick()

/* ------------------------------------------------ dependency graph topology */

/**
 * Every edge the chart draws, recovered from the drawn geometry: an edge starts at
 * its parent's right edge and ends at its target's left edge.
 * @param page - Rendered page under test.
 * @param flow - The flow the page was rendered from.
 * @returns `{ from, to, numbers }` per edge, where `numbers` is the path's coordinate list.
 */
function drawnEdges(page, flow) {
  const boxes = page.collected.filter(element => element.type === 'button' && String(element.props.className ?? '').includes('rb-node'))
  const geometry = new Map(boxes.map(button => {
    const node = flow.find(candidate => button.html.includes(candidate.name))
    return [node.id, { left: Number.parseFloat(button.props.style.left), width: Number.parseFloat(button.props.style.width) }]
  }))
  return page.collected.filter(element => element.type === 'path').map(path => {
    const numbers = String(path.props.d).match(/-?[\d.]+/g).map(Number)
    const from = [...geometry.entries()].find(([, box]) => box.left + box.width === numbers[0])?.[0]
    const to = [...geometry.entries()].find(([, box]) => box.left === numbers[numbers.length - 2])?.[0]
    return { from, to, numbers }
  })
}

/** The edge identities a flow declares through its `dependsOn` lists. */
function declaredPairs(flow) {
  return flow.flatMap(node => node.dependsOn.map(parent => `${parent}->${node.id}`)).sort()
}

/** Every `parentId->childId` the chart drew, sorted. */
function edgePairs(page, flow) {
  return drawnEdges(page, flow).map(edge => `${edge.from}->${edge.to}`).sort()
}

/** The box the chart placed one node at. */
function boxOf(page, flow, id) {
  const name = flow.find(node => node.id === id).name
  const button = page.collected.find(element => element.type === 'button'
    && String(element.props.className ?? '').includes('rb-node') && element.html.includes(name))
  const style = button.props.style
  return {
    left: Number.parseFloat(style.left),
    top: Number.parseFloat(style.top),
    width: Number.parseFloat(style.width),
    height: Number.parseFloat(style.height),
  }
}

const linearEdges = edgePairs(page, requirement.flow)
check('the chart draws one edge per declared dependency', JSON.stringify(linearEdges) === JSON.stringify(declaredPairs(requirement.flow)), JSON.stringify(linearEdges))
check('every edge carries an arrowhead', page.collected.filter(element => element.type === 'polygon').length === declaredPairs(requirement.flow).length)
check('the drawn edges stay inside the measured canvas', page.collected.filter(element => element.type === 'svg')
  .every(element => Number.parseFloat(element.props.width) > 0 && element.props.viewBox === `0 0 ${element.props.width} ${element.props.height}`))

// `build` depends on `review` as well as the step before it, so the second column
// rejoins the first: drawing only listing-order neighbours cannot produce this.
const diamond = requirement.flow.slice(0, 4).map(node => ({
  ...node,
  dependsOn: { review: [], design: ['review'], build: ['review', 'design'], verify: ['build'] }[node.id],
}))
snapshotPayload = boardSnapshot({ requirements: [{ ...requirement, flow: diamond }] })
face.refresh()
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))
const diamondPage = renderPage()
const diamondEdges = edgePairs(diamondPage, diamond)
check('a dependency that skips a step is drawn', diamondEdges.includes('review->build'), JSON.stringify(diamondEdges))
check('the drawn edges match the declared dependencies exactly', JSON.stringify(diamondEdges) === JSON.stringify(declaredPairs(diamond)), JSON.stringify(declaredPairs(diamond)))
const diamondLefts = ['review', 'design', 'build', 'verify'].map(id => boxOf(diamondPage, diamond, id).left)
check('columns follow dependency depth, not listing order', diamondLefts.every((left, index) => index === 0 || left > diamondLefts[index - 1]), JSON.stringify(diamondLefts))
check('one column pitch separates neighbouring depths', diamondLefts[1] - diamondLefts[0] === diamondLefts[2] - diamondLefts[1], JSON.stringify(diamondLefts))

// The skipping edge must clear the step it jumps over instead of cutting through it.
const skipped = drawnEdges(diamondPage, diamond).find(edge => edge.from === 'review' && edge.to === 'build')
const designBox = boxOf(diamondPage, diamond, 'design')
// The first and last two controls sit on their endpoints, so the interior values
// are the lane the edge was routed through.
const routedYs = skipped.numbers.filter((_, index) => index % 2 === 1).slice(2, -2)
check('a step-skipping edge routes beneath the boxes it spans', routedYs.length > 0 && routedYs.every(y => y > designBox.top + designBox.height), JSON.stringify(routedYs))
const canvas = diamondPage.collected.find(element => element.type === 'div' && element.props.className === 'rb-flow-canvas')
check('the canvas is tall enough for the routed lane', Number.parseFloat(canvas.props.style.height) >= Math.max(...routedYs), canvas.props.style.height)
snapshotPayload = boardSnapshot()
face.refresh()
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))

boundLocale = 'zh'
const chinese = renderPage()
check('the Chinese dictionary drives the page', chinese.html.includes('需求看板') && chinese.html.includes('完成率') && chinese.html.includes('流转历史'))
check('the sidebar icon renders without props', harness.render(React.createElement(sidebar.component, { size: 18, active: true })).html === '')

/* ------------------------------------------------------- node interaction */

boundLocale = 'zh'
// Select the checklist-gated node: its checklist and its jump action must appear.
const flowButtons = harness.render(React.createElement(main.component, pageProps)).collected
  .filter(element => element.type === 'button' && String(element.props.className ?? '').includes('rb-node'))
check('every flow node is a button', flowButtons.length === requirement.flow.length, String(flowButtons.length))
const verifyNode = flowButtons.find(element => element.html.includes('测试验证'))
verifyNode.props.onClick()
const withVerify = renderPage()
check('selecting a node reveals its checklist', withVerify.html.includes('用例执行完成') && withVerify.html.includes('缺陷关闭'))
check('selecting a later node offers the forced jump', withVerify.buttons.some(element => element.html === '强制跳转到此节点'))
check('selecting a later node disables the advance action', withVerify.collected.some(element => element.type === 'button' && element.html === '完成并推进' && element.props.disabled === true))

// Tick a checklist entry: the page must post a checklist command.
const checkbox = withVerify.findInput(props => props.type === 'checkbox' && props.name === 'node.checklist')
checkbox.props.onChange({ target: { checked: true } })
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))
const checklistCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body))
  .find(body => body.action === 'checklist')
check('ticking a checklist entry posts the checklist command', checklistCall?.index === 0 && checklistCall?.checked === true, JSON.stringify(checklistCall))
check('the checklist command carries the expected revision', checklistCall?.expectedRev === 7)

/* ------------------------------------------------------------- dialogs */

boundLocale = 'zh'
// The board's project vocabulary travels on the snapshot rather than being read
// off the listed rows: '圣女战棋' names no requirement on this page, so the
// dialog offering it proves the suggestion list is the board's, not the page's.
snapshotPayload = boardSnapshot({ projects: ['看板', '圣女战棋'] })
await face.refresh()
await settle()
const again = renderPage()
again.findButton('新建需求').props.onClick()
const createDialog = renderPage()
check('the create dialog renders its fields', createDialog.html.includes('标题') && createDialog.html.includes('流程模板') && createDialog.html.includes('所属会话'))
check('the create dialog lists the templates', createDialog.html.includes('标准研发流程'))
check('the create dialog offers the board\'s project names as suggestions',
  // A `datalist` option carries its label as its own `value`, so the suggestion
  // list is read from the list itself rather than from any rendered text.
  datalistValues(createDialog, 'rb-project-suggestions-create').join(',') === '看板,圣女战棋'
  && createDialog.findInput(props => props.name === 'requirement.project') !== undefined)
check('an empty title disables the create action', createDialog.collected.some(element => element.html === '创建' && element.props.disabled === true))
const titleInput = createDialog.findInput(props => props.name === 'requirement.title')
titleInput.props.onChange({ target: { value: '新需求' } })
check('a title alone leaves the create action disabled: the brief is required',
  renderPage().collected.some(element => element.html === '创建' && element.props.disabled === true))
renderPage().findInput(props => props.name === 'requirement.summary')
  .props.onChange({ target: { value: '给看板加简述，让人一眼看懂要做什么。' } })
const filledDialog = renderPage()
check('a filled title enables the create action', filledDialog.collected.some(element => element.html === '创建' && element.props.disabled === false))
const prioritySelect = filledDialog.findInput(props => props.name === 'requirement.priority')
prioritySelect.props.onChange({ target: { value: 'urgent' } })
renderPage().findInput(props => props.name === 'requirement.project')
  .props.onChange({ target: { value: '看板' } })
const submit = renderPage().findButton('创建')
submit.props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))
const createCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body))
  .find(body => body.action === 'create')
check('submitting the form posts the create command', createCall?.requirement?.title === '新需求', JSON.stringify(createCall?.requirement))
check('the form carries every edited field', createCall?.requirement?.priority === 'urgent' && Array.isArray(createCall?.requirement?.sessions) && createCall?.requirement?.templateId === 'tpl-standard', JSON.stringify(createCall?.requirement))
check('the create command carries the brief', createCall?.requirement?.summary === '给看板加简述，让人一眼看懂要做什么。', JSON.stringify(createCall?.requirement?.summary))
check('the create command carries the project the form named', createCall?.requirement?.project === '看板', JSON.stringify(createCall?.requirement?.project))
check('the dialog closes after a successful create', renderPage().html.includes('模板名称') === false)

/* ----------------------------------------------------- template drawer */

boundLocale = 'zh'
commandData = { done: true }
commandAnswers = {}
commandRefusals = {}
snapshotPayload = boardSnapshot()

/** The declared nodes of the fixture template, as `template.get` answers them. */
const templateNodes = requirement.flow.map(node => ({
  id: node.id,
  name: node.name,
  order: node.order,
  dependsOn: node.dependsOn,
  assignee: node.assignee,
  description: node.description,
  completion: node.completion,
}))
/** One row of `template.list`, carrying the revision facts the drawer shows. */
const templateRow = {
  id: 'tpl-standard',
  name: '标准研发流程',
  description: '内置流程',
  builtin: true,
  version: 1,
  revision: 3,
  archived: false,
  updatedBy: 'ses_A',
  versionCount: 3,
  createdAt: iso(86_400_000 * 5),
  updatedAt: iso(3_600_000),
  nodes: templateNodes,
}
/** The full record `template.get` answers, version history included. */
const templateFull = {
  ...templateRow,
  versions: [
    { revision: 1, at: iso(86_400_000 * 4), by: 'ses_A', summary: '初始版本', nodes: [] },
    { revision: 2, at: iso(86_400_000 * 2), by: 'ses_B', summary: '加入测试验证节点', nodes: [] },
    { revision: 3, at: iso(3_600_000), by: 'ses_B', summary: '调整依赖关系', nodes: [] },
  ],
  changes: [],
}
commandAnswers = { 'template.list': { items: [templateRow] }, 'template.get': templateFull }
// The fixture requirement is pinned to revision 3, so that version cannot be dropped.
snapshotPayload = boardSnapshot({ requirements: [{ ...requirement, templateRevision: 3 }] })

/**
 * Render the drawer, let every read it issues come back, and render again.
 *
 * The drawer opens on a chain of reads (list, pins, then the selected record),
 * and each answer only reaches the screen through a render: an effect that sets
 * state does not paint by itself. Four rounds cover list → select → record →
 * versions, and a render that changes nothing is harmless.
 */
const settledDrawer = async () => {
  let page = renderPage()
  for (let round = 0; round < 4; round += 1) {
    await settle()
    page = renderPage()
  }
  return page
}
/**
 * Let one action and every read it triggers finish before the next assertion.
 *
 * A command's own promise chain runs `refresh()` after the write, and the reads
 * it starts keep the page's busy flag up until they settle; rendering between
 * rounds is what lets an answer reach the screen.
 */
const drain = async (rounds = 4) => {
  for (let round = 0; round < rounds; round += 1) {
    await settle()
    renderPage()
  }
}
/** Every checkbox the harness collected, whatever it labels. */
const checkboxes = page => page.collected.filter(element => element.type === 'input' && element.props.type === 'checkbox')
/**
 * The checkbox a reader identifies by its visible label.
 *
 * A collected string element carries the HTML of its children, so the `label`
 * the checkbox stub wraps around its input holds exactly the label text, and the
 * input is the nearest preceding checkbox in collection order.
 */
const checkboxFor = (page, label) => {
  const at = page.collected.findIndex(element => element.type === 'label' && element.html === label)
  if (at < 0) return undefined
  for (let index = at; index >= 0; index -= 1) {
    const element = page.collected[index]
    if (element.type === 'input' && element.props.type === 'checkbox') return element
  }
  return undefined
}
/**
 * Every checkbox a reader identifies by its visible label, in tree order.
 *
 * `checkboxFor` answers with the first one, which is all a single control needs;
 * a row of choices each carrying an identical "recommended" label needs them all.
 */
function checkboxesLabelled(page, label) {
  return page.collected.reduce((found, element, index) => {
    if (element.type !== 'label' || element.html !== label) return found
    for (let back = index; back >= 0; back -= 1) {
      const candidate = page.collected[back]
      if (candidate.type === 'input' && candidate.props.type === 'checkbox') return [...found, candidate]
    }
    return found
  }, [])
}
/** The switch that folds the filter area. */
function filterToggleOf(page) {
  return page.collected.find(element => element.type === 'button' && element.props.name === 'filter.toggle')
}
/** Open the filter controls the way a reader does, and answer with the render. */
function openFilters() {
  const page = renderPage()
  const toggle = filterToggleOf(page)
  if (toggle === undefined) throw new Error('the filter area renders no switch')
  if (toggle.props['aria-expanded'] !== true) {
    toggle.props.onClick()
    return renderPage()
  }
  return page
}
/**
 * The names one `datalist` offers.
 *
 * A `datalist` option's label is its own `value` rather than a child, so the
 * values are read off the options that precede the list in collection order.
 */
function datalistValues(page, id) {
  const at = page.collected.findIndex(element => element.type === 'datalist' && element.props.id === id)
  if (at < 0) return []
  const values = []
  for (let back = at - 1; back >= 0; back -= 1) {
    const element = page.collected[back]
    if (element.type !== 'option') break
    values.unshift(element.props.value)
  }
  return values
}

renderPage().findButton(localeDicts.zh.templates).props.onClick()
const drawer = await settledDrawer()
check('the template drawer lists the templates', drawer.html.includes(localeDicts.zh.templateList))
check('the drawer marks a builtin template', drawer.html.includes(localeDicts.zh.templateBuiltin))
check('the drawer shows each template revision', drawer.html.includes(tst('templateCurrentRevision', { revision: 3 })))
check('the drawer counts the requirements using the template',
  drawer.html.includes(`${localeDicts.zh.templateInUse} 1`), drawer.html.slice(0, 0) || 'in-use count missing')
const archivedToggle = checkboxFor(drawer, localeDicts.zh.includeArchived)
check('the drawer defaults to hiding archived templates', archivedToggle?.props.checked === false, String(archivedToggle?.props.checked))
archivedToggle.props.onChange({ target: { checked: true } })
const shownArchived = await settledDrawer()
const archivedList = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body)).filter(body => body.action === 'template.list').at(-1)
check('the archived toggle asks the Host for archived templates', archivedList?.includeArchived === true, JSON.stringify(archivedList))
check('the drawer keeps the archived choice on screen', checkboxFor(shownArchived, localeDicts.zh.includeArchived)?.props.checked === true)

// Opening the record loads its own history; the list projection carries no versions.
const detailRead = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body)).find(body => body.action === 'template.get')
check('selecting the first template reads its full record', detailRead?.id === 'tpl-standard', JSON.stringify(detailRead))
check('the drawer renders the read-only flow chart',
  drawer.collected.some(element => element.type === 'div' && String(element.props.className ?? '').includes('rb-flow-canvas')))
check('the drawer renders one row per version', drawer.collected.filter(element => String(element.props.className ?? '') === 'rb-version-row').length === 3,
  String(drawer.collected.filter(element => String(element.props.className ?? '') === 'rb-version-row').length))
check('a version row names its author and summary',
  drawer.html.includes('初始版本') && drawer.html.includes(`${localeDicts.zh.templateVersionAuthor}: ses_A`))
check('the drawer says a revision change touches no requirement', drawer.html.includes(localeDicts.zh.templateReviseHint))
check('the version list offers the prune action',
  drawer.collected.some(element => element.type === 'button' && String(element.props.name ?? '').startsWith('template.prune.')))

const drop3 = drawer.collected.find(element => element.props.name === 'template.prune.3')
const drop1 = drawer.collected.find(element => element.props.name === 'template.prune.1')
check('prune is disabled on the revision a requirement is pinned to', drop3?.props.disabled === true, String(drop3?.props.disabled))
check('a version nobody is pinned to stays droppable', drop1?.props.disabled === false, String(drop1?.props.disabled))
check('the disabled prune names the requirement holding it', String(drop3?.props.title ?? '').includes('req_demo000001'), String(drop3?.props.title))
check('the pinned version is tagged with its holder count', drawer.html.includes(tst('templatePinnedCount', { count: 1 })))

// Dropping an unheld version asks first, then posts the revision as a number.
drop1.props.onClick()
const pruneRow = renderPage()
check('the drop asks for confirmation first', pruneRow.html.includes(tst('templatePruneConfirm', { revision: 1 })))
pruneRow.collected.find(element => element.type === 'button' && element.html === localeDicts.zh.confirm).props.onClick()
await settle()
const pruneCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body)).find(body => body.action === 'template.prune')
check('confirming the drop posts the chosen revision', pruneCall?.revision === 1, JSON.stringify(pruneCall))

/* ------------------------------------------------ metadata and structure */

/** The drawer's own action button, by its stable name. */
const byName = (page, name) => {
  const found = page.collected.find(element => element.type === 'button' && element.props.name === name)
  if (found === undefined) throw new Error(`no button named "${name}"`)
  return found
}
/** The dialogs a page rendered. A parent is collected after its subtree, so the
 * innermost layer comes first and the drawer behind it comes last. */
const dialogs = page => page.collected.filter(element => element.props.role === 'dialog')
/** The masks the platform Modal renders: each layer's own close target, outermost first. */
const masks = page => page.collected.filter(element => element.props['aria-hidden'] === 'true'
  && typeof element.props.onClick === 'function')
/** Whether a named input renders inside the topmost dialog rather than the drawer behind it. */
const insideTopDialog = (page, name) => {
  const field = page.collected.findIndex(element => ['input', 'textarea'].includes(element.type)
    && element.props.name === name)
  const innermostMask = page.collected.indexOf(masks(page).at(-1))
  return field >= 0 && dialogs(page).length >= 2 && innermostMask >= 0 && field > innermostMask
}
/** The innermost dialog: the form layer while one is open, otherwise the drawer. */
const innerDialog = page => dialogs(page)[0]
/** The elements a page rendered carrying the given class, as one of its classes. */
const withClass = (page, name) => page.collected.filter(element =>
  String(element.props.className ?? '').split(/\s+/).includes(name))

byName(renderPage(), 'template.edit').props.onClick()
const editor = renderPage()
check('the editor explains that metadata saves move no revision',
  editor.html.includes(tst('templateRevisionUnchanged', { revision: 3 })))
check('the editor explains that a revise touches no requirement', editor.html.includes(localeDicts.zh.templateReviseHint))
editor.findInput(props => props.name === 'template.edit.name').props.onChange({ target: { value: '标准研发流程（改）' } })
byName(renderPage(), 'template.metadata.save').props.onClick()
await settle()
const metadataCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body)).find(body => body.action === 'template.metadata')
check('saving metadata posts the name in place', metadataCall?.patch?.name === '标准研发流程（改）', JSON.stringify(metadataCall))
check('the metadata save moves no revision', metadataCall?.patch?.expectedRevision === undefined, JSON.stringify(metadataCall?.patch))

// The metadata save leaves the editor open: the name form and the node editor
// are one pane, so the structure save follows without reopening it.
renderPage().findInput(props => props.name === 'template.node.name.0').props.onChange({ target: { value: '需求澄清' } })
byName(renderPage(), 'template.revise.save').props.onClick()
await settle()
const reviseCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body)).find(body => body.action === 'template.revise')
check('saving the structure appends a version under the current revision',
  reviseCall?.patch?.expectedRevision === 3 && reviseCall?.patch?.nodes?.length === 5, JSON.stringify(reviseCall?.patch?.expectedRevision))
check('the structure save carries the edited node name', reviseCall?.patch?.nodes?.[0]?.name === '需求澄清', JSON.stringify(reviseCall?.patch?.nodes?.[0]))

/* --------------------------------------------------------- the refusal path */

// A revision that moved underneath the editor: the Host refuses with `conflict`,
// the draft stays, and the notice names the revision that is now current.
commandRefusals = { 'template.revise': { code: 'conflict', message: 'revision moved' } }
byName(renderPage(), 'template.edit').props.onClick()
renderPage().findInput(props => props.name === 'template.node.name.0').props.onChange({ target: { value: '本地稿' } })
byName(renderPage(), 'template.revise.save').props.onClick()
await settle()
const afterConflict = renderPage()
check('a refused revision keeps the draft on screen',
  afterConflict.findInput(props => props.name === 'template.node.name.0').props.value === '本地稿',
  String(afterConflict.findInput(props => props.name === 'template.node.name.0').props.value))
check('a refused revision is reported where the work is',
  afterConflict.html.includes(localeDicts.zh.errTemplateConflict)
  && afterConflict.html.includes(tst('templateCurrentRevision', { revision: 3 })))
byName(afterConflict, 'template.edit.cancel').props.onClick()
commandRefusals = {}

/* -------------------------------------------------------- migration dialog */

/** The refusal `template.migrate` answers an unnamed call with, by design. */
const migrateRefusal = {
  code: 'in-use',
  message: 'requirements are pinned',
  details: {
    affected: [
      { id: 'req_demo000001', nodeId: 'build', revision: 2, next: 'design', clearedChecks: true },
      { id: 'req_demo000003', nodeId: 'verify', revision: 2, next: 'verify', clearedChecks: false },
    ],
  },
}
commandRefusals = { 'template.migrate': migrateRefusal }
snapshotPayload = boardSnapshot({ requirements: [requirement, reserved], total: 2 })
byName(renderPage(), 'template.migrate').props.onClick()
const migration = renderPage()
check('the migration dialog states its step', migration.html.includes(tst('templateMigrationStep', { step: 1, total: 3 })))
migration.findButton(localeDicts.zh.templateMigrationRead).props.onClick()
await drain()
const impact = renderPage()
check('the migration dialog renders every affected requirement',
  impact.collected.filter(element => String(element.props.className ?? '') === 'rb-impact-row').length === 2,
  String(impact.collected.filter(element => String(element.props.className ?? '') === 'rb-impact-row').length))
check('the impact list names the requirement and its move',
  impact.html.includes('跨会话需求看板') && impact.html.includes(`${localeDicts.zh.templateMigrationFrom}: 开发实现`)
  && impact.html.includes(`${localeDicts.zh.templateMigrationTo}: 方案设计`))
check('the impact list reports a cleared checklist as a warning',
  impact.html.includes(localeDicts.zh.templateMigrationCleared) && impact.html.includes(localeDicts.zh.templateMigrationKept))
// The refusal is the step's answer, not a failure: it reaches the impact list
// without also raising the app-level error toast or the drawer's error notice.
// The toast store is read rather than rendered, because rendering the overlay
// here would re-run this dialog's effects and reset the list under test.
check('the migration read is not announced as a failure',
  !JSON.stringify(toastFace.hooks.toast.getSnapshot()).includes(localeDicts.zh.errInUse)
  && !impact.collected.some(element => String(element.props.className ?? '').includes('rb-notice-error')),
  JSON.stringify(toastFace.hooks.toast.getSnapshot()).slice(0, 120))
check('the impact list is the only place the refusal is reported',
  impact.html.includes(tst('templateMigrationStep', { step: 2, total: 3 })))
const migrateRows = checkboxes(impact).slice(-2)
check('the migration dialog adds one checkbox per affected requirement',
  checkboxes(impact).length === checkboxes(drawer).length + 2, String(checkboxes(impact).length))
check('every affected requirement starts selected', migrateRows.length === 2 && migrateRows.every(element => element.props.checked === true),
  String(migrateRows.length))
migrateRows[0].props.onChange({ target: { checked: false } })
const narrowed = renderPage()
check('unchecking an impact row narrows the confirmed set', narrowed.html.includes(tst('templateMigrationPicked', { count: 1 })))
// The refusal above is how the impact list is read; the confirmed call that
// names the picked requirements is answered normally.
commandRefusals = {}
commandAnswers = { ...commandAnswers, 'template.migrate': { migrated: ['req_demo000003'] } }
narrowed.collected.find(element => element.type === 'button' && element.props.name !== 'template.migrate.pick'
  && element.html === tst('templateMigrationPicked', { count: 1 })).props.onClick()
await drain()
const migrateCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body)).filter(body => body.action === 'template.migrate').at(-1)
check('the confirmed migration names only the picked requirements',
  migrateCall?.requirementIds?.length === 1 && migrateCall?.requirementIds?.[0] === 'req_demo000003', JSON.stringify(migrateCall))
check('a per-row migration carries no force', migrateCall?.force === undefined, JSON.stringify(migrateCall))
check('a successful migration closes the dialog', renderPage().html.includes(localeDicts.zh.templateMigrationHint) === false)

// "Migrate all" is an extra, explicit step that ends in a forced call.
commandRefusals = { 'template.migrate': migrateRefusal }
byName(renderPage(), 'template.migrate').props.onClick()
await drain()
renderPage().findButton(localeDicts.zh.templateMigrationRead).props.onClick()
await drain()
byName(renderPage(), 'template.migrate.all').props.onClick()
const bulkStep = renderPage()
check('the bulk migration warns before it is confirmed', bulkStep.html.includes(localeDicts.zh.templateMigrationBulkWarn))
check('the bulk step counts as its own step', bulkStep.html.includes(tst('templateMigrationStep', { step: 3, total: 3 })))
// The forced bulk call is the one the reader confirmed; it must be answered.
commandRefusals = {}
bulkStep.collected.find(element => element.type === 'button' && element.props.name !== 'template.migrate.all'
  && element.html === localeDicts.zh.templateMigrationBulk).props.onClick()
await drain()
const bulkCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body)).filter(body => body.action === 'template.migrate').at(-1)
check('the bulk migration is the force form', bulkCall?.force === true && bulkCall?.requirementIds === undefined, JSON.stringify(bulkCall))
commandRefusals = {}
snapshotPayload = boardSnapshot({ requirements: [{ ...requirement, templateRevision: 3 }] })

/* ---------------------------------------- archive, clone, delete, create */

commandAnswers = { 'template.list': { items: [templateRow] }, 'template.get': templateFull }
byName(renderPage(), 'template.archive').props.onClick()
await settle()
const templateArchiveCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body)).find(body => body.action === 'template.archive')
check('the archive action posts the archived flag', templateArchiveCall?.archived === true && templateArchiveCall?.id === 'tpl-standard', JSON.stringify(templateArchiveCall))

/* ---------- the duplicate entry: the same second-layer form as a new template ---------- */

byName(renderPage(), 'template.clone').props.onClick()
const cloneForm = renderPage()
check('the duplicate entry opens a second dialog layer, not an inline panel',
  dialogs(cloneForm).length === 2 && String(innerDialog(cloneForm).props.className) === 'rb-dialog'
  && insideTopDialog(cloneForm, 'template.clone.name'),
  `dialogs ${String(dialogs(cloneForm).length)}, top ${String(innerDialog(cloneForm).props.className)}`)
check('the duplicate form names the template it copies and keeps its hint',
  cloneForm.html.includes(tst('templateCloneTitle', { name: templateFull.name }))
  && cloneForm.html.includes(localeDicts.zh.templateCloneHint))
check('the duplicate form carries the one field it owns, focused on entry by the layer',
  cloneForm.findInput(props => props.name === 'template.clone.name') !== undefined
  && cloneForm.findInput(props => props.name === 'template.clone.name').props['data-modal-autofocus'] === true)
check('the duplicate submit is the form\'s own submit, disabled while it has no name',
  cloneForm.collected.find(element => element.props.name === 'template.clone.confirm')?.props.type === 'submit'
  && cloneForm.collected.find(element => element.props.name === 'template.clone.confirm')?.props.disabled === true)
check('the duplicate form states the name it is waiting for, inside itself',
  cloneForm.html.includes(localeDicts.zh.templateNameRequired))
renderPage().findInput(props => props.name === 'template.clone.name').props.onChange({ target: { value: '标准流程副本' } })
const cloneReady = renderPage()
check('the duplicate field carries no click handler: submitting the form is what saves',
  cloneReady.collected.find(element => element.props.name === 'template.clone.confirm')?.props.onClick === undefined
  && cloneReady.collected.find(element => element.props.name === 'template.clone.confirm')?.props.disabled === false)
cloneReady.collected.find(element => element.type === 'form').props.onSubmit({ preventDefault: () => {} })
await settle()
const cloneCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body)).find(body => body.action === 'template.clone')
check('the clone action carries the new name', cloneCall?.name === '标准流程副本' && cloneCall?.id === 'tpl-standard', JSON.stringify(cloneCall))
const clonedPage = renderPage()
check('a successful duplicate closes the form and leaves the drawer in place',
  dialogs(clonedPage).length === 1 && byName(clonedPage, 'template.clone') !== undefined)

byName(renderPage(), 'template.delete').props.onClick()
const deleteArmed = renderPage()
check('deleting a bound template names the requirements it rebinds',
  deleteArmed.html.includes(tst('templateMigrationRow', { title: requirement.title, id: requirement.id })))
// The pinned revision goes through the locale template, not string concatenation:
// a raw `{revision}` in the tree means the placeholder was never substituted.
check('an impact row renders the pinned revision through the locale template',
  deleteArmed.html.includes(tst('templateRevisionLine', { revision: 3 })) && !deleteArmed.html.includes('{revision}'),
  deleteArmed.html.includes(tst('templateRevisionLine', { revision: 3 })))
// A bound template is deleted in two steps: the first click arms the rebind,
// the second sends it, so the destructive act is never one stray click away.
check('the delete confirmation is armed before it sends anything',
  byName(deleteArmed, 'template.delete.confirm').html === localeDicts.zh.templateDeleteArmed,
  byName(deleteArmed, 'template.delete.confirm').html)
byName(deleteArmed, 'template.delete.confirm').props.onClick()
const deleteReady = renderPage()
check('the armed confirmation asks once more before it posts',
  byName(deleteReady, 'template.delete.confirm').html === localeDicts.zh.confirm)
byName(deleteReady, 'template.delete.confirm').props.onClick()
await settle()
const templateDeleteCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body)).find(body => body.action === 'template.delete')
check('the armed delete forces the rebind', templateDeleteCall?.force === true && templateDeleteCall?.id === 'tpl-standard', JSON.stringify(templateDeleteCall))

/* ---------- the new-template form: layer, validation, refusal, unsaved draft ---------- */

// One filter mark and one picked row, so the reading after the form closes can say
// whether the drawer still holds them: the form is a layer beside the drawer, not a
// replacement for it.
checkboxFor(renderPage(), localeDicts.zh.includeArchived).props.onChange({ target: { checked: true } })
await drain()
const pickedBefore = renderPage().collected
  .find(element => String(element.props.className ?? '').includes('rb-template-row-picked'))
check('the drawer holds a filter mark and a picked row before the form opens',
  checkboxFor(renderPage(), localeDicts.zh.includeArchived)?.props.checked === true && pickedBefore !== undefined)

byName(renderPage(), 'template.new').props.onClick()
const addForm = renderPage()
check('the new-template entry opens a second dialog layer over the drawer',
  dialogs(addForm).length === 2 && String(innerDialog(addForm).props.className) === 'rb-dialog',
  `dialogs ${String(dialogs(addForm).length)}, top ${String(innerDialog(addForm).props.className)}`)
check('the form is the top layer: its fields sit inside it, not in the drawer list column',
  insideTopDialog(addForm, 'template.new.name') && insideTopDialog(addForm, 'template.new.nodes'))
check('the form offers the node-per-line fields the inline form had',
  addForm.html.includes(localeDicts.zh.templateNodesHint)
  && addForm.findInput(props => props.name === 'template.new.description') !== undefined
  && addForm.findInput(props => props.name === 'template.new.nodes') !== undefined)
check('the form enters on its first field and only on that one',
  addForm.findInput(props => props.name === 'template.new.name').props['data-modal-autofocus'] === true
  && addForm.findInput(props => props.name === 'template.new.nodes').props['data-modal-autofocus'] === undefined)
check('an empty form cannot be sent and says which field it is waiting for',
  byName(addForm, 'template.create').props.disabled === true
  && addForm.html.includes(localeDicts.zh.templateNameRequired)
  && addForm.html.includes(localeDicts.zh.templateNodesRequired))
addForm.findInput(props => props.name === 'template.new.nodes').props.onChange({
  target: { value: '需求评审 | 张三 | 范围明确;干系人确认\n方案设计 | 李四\n开发实现' },
})
renderPage().findInput(props => props.name === 'template.new.name').props.onChange({ target: { value: '三段流程' } })
const readyForm = renderPage()
check('the required line drops each requirement as the draft meets it',
  !readyForm.html.includes(localeDicts.zh.templateNameRequired)
  && !readyForm.html.includes(localeDicts.zh.templateNodesRequired))
check('the filled form submits through the form, with no click handler on the submit',
  readyForm.collected.find(element => element.props.name === 'template.create')?.props.type === 'submit'
  && readyForm.collected.find(element => element.props.name === 'template.create')?.props.onClick === undefined
  && readyForm.collected.find(element => element.props.name === 'template.create')?.props.disabled === false)

// A refusal stays where the draft is: the same failure the overlay toast used to
// announce is stated inside the form, and the form is not closed by it.
commandRefusals['template.create'] = { code: 'invalid-argument', message: 'template "nodes" must hold at most 50 entries' }
await drain(6)
const readsBeforeRefusal = commandBodies().filter(body => body.action === 'template.list').length
renderPage().collected.find(element => element.type === 'form').props.onSubmit({ preventDefault: () => {} })
await drain(6)
const refusedCreate = renderPage()
// The refusal posts nothing, and it leaves the panel with nothing further to
// post: no list re-read, and no read of any other kind trailing it.
check('a refused create re-reads nothing and posts nothing after it',
  commandBodies().filter(body => body.action === 'template.list').length === readsBeforeRefusal
  && commandBodies().at(-1)?.action === 'template.create',
  `${String(commandBodies().filter(body => body.action === 'template.list').length)} vs ${String(readsBeforeRefusal)}, last ${String(commandBodies().at(-1)?.action)}`)
check('a refused create is reported inside the form, in the Host\'s own words',
  refusedCreate.html.includes(localeDicts.zh.templateFormError) && refusedCreate.html.includes('must hold at most 50 entries')
  && refusedCreate.collected.some(element => element.props.name === 'template.form.error'))
check('a refused create keeps the form and the draft on screen',
  dialogs(refusedCreate).length === 2
  && refusedCreate.collected.some(element => element.type === 'input' && element.props.name === 'template.new.name'
    && element.props.value === '三段流程'))
check('a refused create raises no toast of its own and no drawer notice of its own',
  !renderToast().includes('must hold at most 50 entries')
  && withClass(refusedCreate, 'rb-notice-error').length === 0,
  `${renderToast()} / ${String(withClass(refusedCreate, 'rb-notice-error').length)}`)
delete commandRefusals['template.create']

// Cancel, Escape, and the mask are the same close path, and a changed draft makes
// that path ask first. The question takes itself back rather than the input.
byName(refusedCreate, 'template.form.cancel').props.onClick()
const askedForm = renderPage()
check('cancel on a changed draft asks before it discards anything',
  dialogs(askedForm).length === 2 && byName(askedForm, 'template.discard.drop') !== undefined
  && byName(askedForm, 'template.discard.keep') !== undefined
  && askedForm.html.includes(localeDicts.zh.templateDiscardConfirm)
  && askedForm.collected.some(element => element.type === 'input' && element.props.name === 'template.new.name'
    && element.props.value === '三段流程'))
byName(askedForm, 'template.discard.keep').props.onClick()
const keptForm = renderPage()
check('keeping the draft hides the question and keeps the input',
  keptForm.collected.some(element => element.props.name === 'template.discard.drop') === false
  && keptForm.collected.some(element => element.type === 'input' && element.props.name === 'template.new.name'
    && element.props.value === '三段流程'))
masks(keptForm).at(-1).props.onClick()
const askedByMask = renderPage()
check('the mask leaves through the same path as cancel, so it asks too',
  byName(askedByMask, 'template.discard.drop') !== undefined)
masks(askedByMask).at(-1).props.onClick()
const backToInput = renderPage()
check('the mask while the question is up takes the question back, not the input',
  backToInput.collected.some(element => element.props.name === 'template.discard.drop') === false
  && backToInput.collected.some(element => element.type === 'input' && element.props.name === 'template.new.name'
    && element.props.value === '三段流程'))
byName(backToInput, 'template.form.cancel').props.onClick()
byName(renderPage(), 'template.discard.drop').props.onClick()
const droppedForm = renderPage()
check('an untouched form closes without asking', (() => {
  byName(renderPage(), 'template.new').props.onClick()
  const blank = renderPage()
  byName(blank, 'template.form.cancel').props.onClick()
  const closed = renderPage()
  return dialogs(blank).length === 2 && dialogs(closed).length === 1
    && closed.collected.some(element => element.props.name === 'template.discard.drop') === false
})())
check('an explicit discard closes the form and the drawer keeps its filter and its pick',
  dialogs(droppedForm).length === 1 && byName(droppedForm, 'template.new') !== undefined
  && checkboxFor(droppedForm, localeDicts.zh.includeArchived)?.props.checked === true
  && droppedForm.collected.some(element => String(element.props.className ?? '').includes('rb-template-row-picked')))
check('the opener is still in the tree after the form closes: it is what the layer hands focus back to',
  droppedForm.collected.some(element => element.props.name === 'template.new'))

// Creating is still the ordinary panel command: the same line grammar reaches
// `template.create`, and a success closes the form and re-reads the list once.
byName(renderPage(), 'template.new').props.onClick()
const createForm = renderPage()
createForm.findInput(props => props.name === 'template.new.nodes').props.onChange({
  target: { value: '需求评审 | 张三 | 范围明确;干系人确认\n方案设计 | 李四\n开发实现' },
})
renderPage().findInput(props => props.name === 'template.new.name').props.onChange({ target: { value: '三段流程' } })
const readsBeforeCreate = commandBodies().filter(body => body.action === 'template.list').length
renderPage().collected.find(element => element.type === 'form').props.onSubmit({ preventDefault: () => {} })
await drain()
const templateCreateCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body)).find(body => body.action === 'template.create')
check('the form create posts parsed nodes', templateCreateCall?.template?.nodes?.length === 3, JSON.stringify(templateCreateCall?.template))
check('a checklist node keeps its checklist', templateCreateCall?.template?.nodes?.[0]?.completion?.checklist?.length === 2)
check('the create form carries the typed name', templateCreateCall?.template?.name === '三段流程')
check('a successful create closes the form and re-reads the list once',
  dialogs(renderPage()).length === 1
  && commandBodies().filter(body => body.action === 'template.list').length === readsBeforeCreate + 1,
  `dialogs ${String(dialogs(renderPage()).length)}`)

// Closing the drawer clears it.
renderPage().findButton(localeDicts.zh.close).props.onClick()
check('closing the drawer clears it', renderPage().html.includes(localeDicts.zh.templateList) === false)
commandAnswers = {}

/* -------------------------------------------------- description images */

boundLocale = 'zh'

/** A file as a clipboard item or a picker selection offers it. */
const imageFile = (name, type, size, lastModified) => ({ name, type, size, lastModified })
/** One clipboard item carrying an image file. */
const clipboardImage = file => ({ kind: 'file', type: file.type, getAsFile: () => file })

renderPage().findButton(localeDicts.zh.newRequirement).props.onClick()
const imageDialog = renderPage()
check('the create dialog offers an image affordance',
  imageDialog.collected.some(element => element.props.name === 'requirement.image.pick')
  && imageDialog.collected.some(element => element.props.name === 'requirement.image.file')
  && imageDialog.html.includes(localeDicts.zh.pasteImageHint),
  imageDialog.html.slice(0, 0) || 'the image affordance is missing')
renderPage().findInput(props => props.name === 'requirement.title').props.onChange({ target: { value: '带截图的需求' } })

// A paste with no image must reach the textarea untouched: the default insert is
// not intercepted and nothing is uploaded.
let pastePrevented = false
const uploadsBefore = imageUploads().length
renderPage().findInput(props => props.name === 'requirement.description').props.onPaste({
  clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
  preventDefault: () => { pastePrevented = true },
})
await settle()
check('a paste with no image is left to the browser', pastePrevented === false, 'the text paste was intercepted')
check('a paste with no image uploads nothing', imageUploads().length === uploadsBefore, String(imageUploads().length - uploadsBefore))

// An upload held in flight blocks submit; releasing it offers the thumbnail.
let releaseUpload = null
imageUploadGate = new Promise(resolve => { releaseUpload = resolve })
let imagePastePrevented = false
renderPage().findInput(props => props.name === 'requirement.description').props.onPaste({
  clipboardData: { items: [clipboardImage(imageFile('shot.png', 'image/png', 2048, 1))] },
  preventDefault: () => { imagePastePrevented = true },
})
const heldDialog = renderPage()
check('pasting an image takes the paste instead of the text', imagePastePrevented === true)
const heldUpload = imageUploads().at(-1)
const heldUrl = new URL(String(heldUpload?.url), 'http://127.0.0.1:3080')
check('pasting an image uploads it right away',
  imageUploads().length === uploadsBefore + 1 && heldUrl.pathname === '/api/requirement-board/image', String(imageUploads().length - uploadsBefore))
check('the upload sends the raw bytes under the media type and the filename',
  heldUpload?.init.method === 'POST' && heldUpload?.init.headers['content-type'] === 'image/png'
  && heldUpload?.init.body?.name === 'shot.png' && heldUrl.searchParams.get('name') === 'shot.png',
  JSON.stringify(heldUpload?.init.headers))
check('the dialog says the image is still uploading', heldDialog.html.includes(localeDicts.zh.imageUploading))
check('submit is blocked while an upload is in flight',
  heldDialog.collected.some(element => element.html === localeDicts.zh.create && element.props.disabled === true))
releaseUpload()
imageUploadGate = null
await settle()
const uploadedDialog = renderPage()
check('the upload adds a thumbnail of the stored image',
  uploadedDialog.collected.some(element => element.type === 'img' && element.props.src === '/api/requirement-board/image/img_1'),
  uploadedDialog.html.slice(0, 0) || 'the thumbnail is missing')
check('the thumbnail carries a remove control',
  uploadedDialog.collected.some(element => element.props.name === 'requirement.image.remove.0'))
check('submit is offered again once the upload landed',
  uploadedDialog.collected.some(element => element.html === localeDicts.zh.create && element.props.disabled === false))

// Removing the thumbnail must keep the id out of the payload.
uploadedDialog.collected.find(element => element.props.name === 'requirement.image.remove.0').props.onClick()
await settle()
check('removing a thumbnail drops its row',
  !renderPage().collected.some(element => element.type === 'img'))
renderPage().findButton(localeDicts.zh.create).props.onClick()
await settle()
const textOnlyCall = commandBodies().filter(body => body.action === 'create').at(-1)
check('a create with no image sends an empty images list',
  Array.isArray(textOnlyCall?.requirement?.images) && textOnlyCall.requirement.images.length === 0,
  JSON.stringify(textOnlyCall?.requirement))
check('a create with no image still posts its title',
  textOnlyCall?.requirement?.title === '带截图的需求', JSON.stringify(textOnlyCall?.requirement?.title))

// A selection the route would refuse is reported and never uploaded. A
// non-image, an image type the route does not accept, and an oversized one are
// all refused client-side; an accepted file in the same selection still goes up.
renderPage().findButton(localeDicts.zh.newRequirement).props.onClick()
const picker = renderPage().findInput(props => props.name === 'requirement.image.file')
const refusedBefore = imageUploads().length
picker.props.onChange({ target: { files: [imageFile('notes.txt', 'text/plain', 12, 2), imageFile('scan.tiff', 'image/tiff', 800, 3)], value: '' } })
await settle()
const refusedDialog = renderPage()
check('a non-image and an unaccepted type are refused with a notice',
  refusedDialog.html.includes(tst('imageTypeRejected', { names: 'notes.txt, scan.tiff' })),
  refusedDialog.html.slice(0, 0) || 'the type refusal is missing')
check('a refused file is never uploaded', imageUploads().length === refusedBefore, String(imageUploads().length - refusedBefore))
check('the refusal is an alert naming the files',
  refusedDialog.collected.some(element => element.props.role === 'alert' && element.html.includes('notes.txt')))

picker.props.onChange({ target: { files: [imageFile('huge.png', 'image/png', 20 * 1024 * 1024 + 1, 4)], value: '' } })
await settle()
check('an oversized image is refused with a notice and never uploaded',
  renderPage().html.includes(tst('imageTooLarge', { names: 'huge.png' })) && imageUploads().length === refusedBefore)

picker.props.onChange({ target: { files: [imageFile('ok.png', 'image/png', 999, 5), imageFile('bad.bmp', 'image/bmp', 10, 6)], value: '' } })
await settle()
check('an accepted file in the same selection still uploads',
  imageUploads().length === refusedBefore + 1 && renderPage().html.includes(tst('imageTypeRejected', { names: 'bad.bmp' })),
  String(imageUploads().length - refusedBefore))

// An upload the route rejects is named in a notice and kept visible; it stays
// out of the payload but never blocks the submit.
imageUploadFailure = { status: 500, error: { code: 'internal', message: 'the image store is not writable' } }
renderPage().findInput(props => props.name === 'requirement.image.file')
  .props.onChange({ target: { files: [imageFile('broken.png', 'image/png', 4096, 7)], value: '' } })
await settle()
const failedDialog = renderPage()
check('a failed upload surfaces a notice naming the file',
  failedDialog.html.includes(tst('imageUploadFailed', { name: 'broken.png' }))
  && failedDialog.collected.some(element => element.props.role === 'alert'),
  failedDialog.html.slice(0, 0) || 'the upload failure is not reported')
check('a failed upload keeps the file visible rather than dropping it silently',
  failedDialog.html.includes('broken.png'))
imageUploadFailure = null
renderPage().findButton(localeDicts.zh.create).props.onClick()
await settle()
const mixedCall = commandBodies().filter(body => body.action === 'create').at(-1)
check('submit sends the stored image ids and leaves the failed upload out',
  JSON.stringify(mixedCall?.requirement?.images) === JSON.stringify(['img_2']),
  JSON.stringify(mixedCall?.requirement?.images))
check('an upload failure does not block the submit',
  mixedCall?.requirement?.title === '带截图的需求', JSON.stringify(mixedCall?.requirement?.title))

// The route also caps how many images one requirement carries; a selection over
// the cap keeps the files that fit instead of spending a refusal on each.
renderPage().findButton(localeDicts.zh.newRequirement).props.onClick()
renderPage().collected.find(element => element.props.name === 'requirement.image.remove.0').props.onClick()
await settle()
renderPage().collected.find(element => element.props.name === 'requirement.image.remove.0').props.onClick()
await settle()
const countBefore = imageUploads().length
const overflow = Array.from({ length: 21 }, (_, index) => imageFile(`shot-${index}.png`, 'image/png', 1000 + index, 10 + index))
renderPage().findInput(props => props.name === 'requirement.image.file').props.onChange({ target: { files: overflow, value: '' } })
await settle()
check('a selection over the count ceiling keeps what fits and says so',
  renderPage().html.includes(tst('imageLimitReached', { max: 20 })) && imageUploads().length === countBefore + 20,
  `${imageUploads().length - countBefore} uploads`)
renderPage().findButton(localeDicts.zh.cancel).props.onClick()
await settle()
check('closing the create dialog clears it', !renderPage().html.includes(localeDicts.zh.pasteImageHint))

/* ------------------------------------------- the create dialog's options */

// The structured question is authored here rather than typed into the
// description: a question, its choices with their costs, and the one choice the
// author advises. The ids the board stores (q1, q2 …; A, B, …) belong to the
// board and follow the order the rows are sent, so the editor never shows one.
renderPage().findButton(localeDicts.zh.newRequirement).props.onClick()
const blankOptionDialog = renderPage()
check('the create dialog offers the structured-question block',
  blankOptionDialog.collected.some(element => element.props.name === 'option.question.add')
  && blankOptionDialog.html.includes(localeDicts.zh.optionsTitle)
  && blankOptionDialog.html.includes(localeDicts.zh.optionNeedOneRecommended),
  blankOptionDialog.html.slice(0, 0) || 'the option block is missing')
check('the block starts with no question at all',
  !blankOptionDialog.collected.some(element => String(element.props.name ?? '').startsWith('option.question.prompt.')))
check('a requirement that asks nothing carries no options field',
  textOnlyCall?.requirement?.options === undefined, JSON.stringify(textOnlyCall?.requirement?.options))

blankOptionDialog.collected.find(element => element.props.name === 'option.question.add').props.onClick()
const oneQuestion = renderPage()
check('adding a question adds its prompt and the two choices it must offer',
  oneQuestion.collected.some(element => element.props.name === 'option.question.prompt.0')
  && oneQuestion.collected.some(element => element.props.name === 'option.item.label.0.0')
  && oneQuestion.collected.some(element => element.props.name === 'option.item.label.0.1')
  && oneQuestion.collected.some(element => element.props.name === 'option.item.detail.0.0'))
check('a question cannot be cut down to a single choice',
  oneQuestion.collected.find(element => element.props.name === 'option.item.remove.0.0')?.props.disabled === true
  && oneQuestion.collected.find(element => element.props.name === 'option.item.remove.0.1')?.props.disabled === true)

renderPage().findInput(props => props.name === 'requirement.title').props.onChange({ target: { value: '选项式需求' } })
renderPage().findInput(props => props.name === 'requirement.summary').props.onChange({ target: { value: '让人在面板上选一个方案。' } })
check('an unfinished question blocks the submit and says what is missing',
  renderPage().collected.some(element => element.html === localeDicts.zh.create && element.props.disabled === true)
  && renderPage().html.includes(localeDicts.zh.optionNeedQuestion))
renderPage().findInput(props => props.name === 'option.question.prompt.0').props.onChange({ target: { value: '描边用几像素？' } })
check('a question with fewer than two labelled choices still blocks the submit',
  renderPage().collected.some(element => element.html === localeDicts.zh.create && element.props.disabled === true)
  && renderPage().html.includes(localeDicts.zh.optionNeedItems))
renderPage().findInput(props => props.name === 'option.item.label.0.0').props.onChange({ target: { value: '2px' } })
renderPage().findInput(props => props.name === 'option.item.detail.0.0').props.onChange({ target: { value: '更轻，但边缘偏硬' } })
renderPage().findInput(props => props.name === 'option.item.label.0.1').props.onChange({ target: { value: '3px' } })
check('a complete question lets the submit through again',
  renderPage().collected.some(element => element.html === localeDicts.zh.create && element.props.disabled === false))

// The advice is one per question: ticking a second choice moves the mark rather
// than adding another, which is the one shape the Host's own gate accepts.
checkboxesLabelled(renderPage(), localeDicts.zh.optionRecommended)[1].props.onChange({ target: { checked: true } })
check('ticking a choice marks it as the advice',
  checkboxesLabelled(renderPage(), localeDicts.zh.optionRecommended)[1].props.checked === true)
checkboxesLabelled(renderPage(), localeDicts.zh.optionRecommended)[0].props.onChange({ target: { checked: true } })
const movedAdvice = checkboxesLabelled(renderPage(), localeDicts.zh.optionRecommended)
check('ticking a second choice moves the advice instead of adding one',
  movedAdvice[0].props.checked === true && movedAdvice[1].props.checked === false,
  JSON.stringify(movedAdvice.map(box => box.props.checked)))

renderPage().collected.find(element => element.props.name === 'option.question.add').props.onClick()
renderPage().findInput(props => props.name === 'option.question.prompt.1').props.onChange({ target: { value: '要不要加投影？' } })
renderPage().findInput(props => props.name === 'option.item.label.1.0').props.onChange({ target: { value: '加' } })
renderPage().findInput(props => props.name === 'option.item.label.1.1').props.onChange({ target: { value: '不加' } })
checkboxesLabelled(renderPage(), localeDicts.zh.optionRecommended)[3].props.onChange({ target: { checked: true } })
renderPage().collected.find(element => element.props.name === 'option.item.add.1').props.onClick()
check('a choice row can be added',
  renderPage().collected.some(element => element.props.name === 'option.item.label.1.2'))
renderPage().collected.find(element => element.props.name === 'option.item.remove.1.2').props.onClick()
check('removing a choice takes its row away',
  !renderPage().collected.some(element => element.props.name === 'option.item.label.1.2'))
// The row comes back and stays blank: what a reader leaves unfinished must not
// reach the Host, whose own gate refuses an empty label.
renderPage().collected.find(element => element.props.name === 'option.item.add.1').props.onClick()
renderPage().findButton(localeDicts.zh.create).props.onClick()
await settle()
const optionCall = commandBodies().filter(body => body.action === 'create').at(-1)
check('the create payload carries both questions, their costs, the advice, and no blank row',
  JSON.stringify(optionCall?.requirement?.options) === JSON.stringify([
    { prompt: '描边用几像素？', choices: [{ label: '2px', detail: '更轻，但边缘偏硬', recommended: true }, { label: '3px' }] },
    { prompt: '要不要加投影？', choices: [{ label: '加' }, { label: '不加', recommended: true }] },
  ]),
  JSON.stringify(optionCall?.requirement?.options))
check('the dialog closes after an option-bearing create',
  renderPage().html.includes(localeDicts.zh.optionsTitle) === false)

// A stored image is visible again when the requirement is read back.
snapshotPayload = boardSnapshot({
  requirements: [{
    ...requirement,
    images: [{ id: 'img_9', name: '登录页.png', mediaType: 'image/png', byteLength: 1024, width: 640, height: 480 }],
  }],
})
await face.refresh()
await settle()
const storedPage = renderPage()
check('a stored image renders in the requirement detail',
  storedPage.collected.some(element => element.type === 'img' && element.props.src === '/api/requirement-board/image/img_9'),
  storedPage.html.slice(0, 0) || 'the stored image is missing')
check('the stored image is a link to the image route',
  storedPage.collected.some(element => element.type === 'a' && element.props.href === '/api/requirement-board/image/img_9'))

// The create command names images by id, so a Host that echoes the ids back as
// strings must render them the same way as one that answers with references.
snapshotPayload = boardSnapshot({ requirements: [{ ...requirement, images: ['img_10'] }] })
await face.refresh()
await settle()
check('a bare image id from the host renders too',
  renderPage().collected.some(element => element.type === 'img' && element.props.src === '/api/requirement-board/image/img_10'))
snapshotPayload = boardSnapshot()
await face.refresh()
await settle()

/* ------------------------------------------------------ busy and failures */

boundLocale = 'zh'
const fresh = renderPage()
fresh.findButton('归档').props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))
const archiveCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body))
  .find(body => body.action === 'archive')
check('the archive action posts its command', archiveCall?.id === requirement.id && archiveCall?.expectedRev === 7, JSON.stringify(archiveCall))

commandFailure = { code: 'conflict', message: 'requirement changed since revision 7' }
const conflictPage = renderPage()
conflictPage.findButton('归档').props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))
check('a rejected command surfaces a localized toast', renderToast().includes('其他会话'), 'the conflict toast is missing')
check('a failed command keeps the board on screen', renderPage().html.includes('跨会话需求看板'))
commandFailure = null

snapshotFailure = { code: 'internal', message: 'board document is unreadable' }
await face.refresh()
check('a failed snapshot paints a localized error banner',
  renderPage().html.includes('board document is unreadable') && renderPage().html.includes('操作失败'))
snapshotFailure = null
await face.refresh()

let thrown = null
commandFailure = { code: 'not-found', message: 'requirement was deleted in another session' }
try {
  await face.controller.command('update', { id: requirement.id })
} catch (error) {
  thrown = error
}
check('a rejected command throws with its board code', thrown?.code === 'not-found', String(thrown?.code))
commandFailure = null
check('the command refetches the snapshot afterwards', requests.filter(request => String(request.url).includes('/snapshot')).length >= 4)

/* ------------------------------------------------------ blocked rendering */

const blocked = structuredClone(requirement)
blocked.status = 'blocked'
blocked.blockReason = '等待上游接口'
blocked.rev = 8
snapshotPayload = boardSnapshot({
  requirements: [blocked],
  stats: {
    ...boardSnapshot().stats,
    blocked: [{ id: blocked.id, title: blocked.title, owner: blocked.owner, reason: blocked.blockReason, since: iso(7_200_000), blockedMs: 7_200_000, node: 'build' }],
    stalled: [{ id: blocked.id, title: blocked.title, owner: blocked.owner, node: 'build', enteredAt: iso(86_400_000 * 4), idleMs: 86_400_000 * 4 }],
  },
})
await face.refresh()
const blockedPage = renderPage()
check('a blocked requirement renders its reason', blockedPage.html.includes('等待上游接口'))
check('the blocker list renders', blockedPage.html.includes('阻塞项') && blockedPage.html.includes('2h'))
check('the stall list renders', blockedPage.html.includes('停滞项') && blockedPage.html.includes('4d'))
check('an unblock action replaces the block action', blockedPage.buttons.some(element => element.html === '解除阻塞'))

/* ------------------------------------------------------------ empty board */

snapshotPayload = boardSnapshot({ requirements: [], total: 0 })
await face.refresh()
check('an empty board renders its empty state', renderPage().html.includes('还没有需求'))

snapshotPayload = boardSnapshot()
face.setFilter({ status: 'done', owner: '张三' })
await new Promise(resolve => setTimeout(resolve, 0))
const filterUrl = lastSnapshotUrl()
check('filters travel to the route', filterUrl.includes('status=done') && filterUrl.includes('owner='), filterUrl)
check('filters render into their controls', (() => {
  // A filter in force names itself in the folded summary; the control that states
  // its value sits behind the switch, which is where a reader looks for it.
  const pageWithFilter = openFilters()
  const selects = pageWithFilter.collected.filter(element => element.type === 'select')
  return selects.some(element => element.props.value === 'done')
})())
face.setFilter({ status: 'open', owner: '' })
await settle()

/* ------------------------------------------------------------- filtering */

boundLocale = 'zh'
const basePage = renderPage()
check('a role-routed requirement carries its role badge', basePage.html.includes('美术 (art)'))
check('the takeover badge states the host answer', basePage.html.includes('可接手'))

face.setFilter({ role: 'art' })
await settle()
check('the role filter keeps a matching requirement', renderPage().html.includes('跨会话需求看板'))
check('the role filter travels to the host', lastSnapshotUrl().includes('role=art'), lastSnapshotUrl())
face.setFilter({ role: 'qa' })
await settle()
check('the role filter drops a non-matching requirement', renderPage().html.includes('没有符合当前筛选条件'))

// The service filters by the routing role in force, so a two-role board shows
// exactly what it answered rather than what the page narrowed down itself.
const qaRouted = { ...structuredClone(requirement), id: 'req_demo000010', title: 'QA 复核', role: 'qa', rev: 2 }
snapshotPayload = boardSnapshot({ requirements: [requirement, qaRouted, decision], total: 3 })
face.setFilter({ role: 'art' })
await settle()
check('the host answer decides which rows a role shows',
  renderPage().html.includes('跨会话需求看板') && !renderPage().html.includes('QA 复核'),
  lastSnapshotUrl())
face.setFilter({ role: 'qa' })
await settle()
check('another role shows only its own work',
  renderPage().html.includes('QA 复核') && !renderPage().html.includes('跨会话需求看板'), lastSnapshotUrl())
face.setFilter({ role: 'human' })
await settle()
check('the human inbox is asked for by its reserved role',
  lastSnapshotUrl().includes('role=human') && renderPage().html.includes('是否走自研渲染'), lastSnapshotUrl())
// The role filter is one compact control rather than a capsule per role: a board
// with fifteen roles reads as one line instead of several wrapped rows.
const humanInboxPage = renderPage()
const roleFilterControl = humanInboxPage.findInput(props => props.name === 'filter.role')
check('the human inbox is offered by the role filter',
  roleFilterControl.html.includes(localeDicts.zh.roleHuman)
  && humanInboxPage.collected.some(element => element.type === 'option' && element.props.value === 'human'))
check('the role control is the one control, showing the role in force',
  humanInboxPage.collected.filter(element => element.props.name === 'filter.role').length === 1
  && roleFilterControl.props.value === 'human')
check('the role filter no longer renders one row per role',
  !humanInboxPage.collected.some(element => String(element.props.className ?? '').includes('rb-chips')))
check('the role filter no longer offers the unexpressible "no role" value',
  !humanInboxPage.collected.some(element => element.type === 'option' && String(element.props.value).includes('\u0000')))
face.setFilter({ role: 'unknown-role' })
await settle()
check('a legal role the host does not know lists nothing rather than failing',
  lastSnapshotUrl().includes('role=unknown-role') && renderPage().html.includes('没有符合当前筛选条件'))
check('a refused-role filter is not dressed with an error banner',
  !renderPage().collected.some(element => String(element.props.className ?? '').includes('rb-notice-error')))
face.setFilter({ role: '', kind: 'decision' })
await settle()
check('the kind filter travels to the host', lastSnapshotUrl().includes('kind=decision'), lastSnapshotUrl())
check('the kind filter is applied by the host, not the page',
  renderPage().html.includes('是否走自研渲染') && !renderPage().html.includes('跨会话需求看板'), lastSnapshotUrl())
face.setFilter({ kind: '' })
await settle()
check('an empty role asks for no role filter at all', !lastSnapshotUrl().includes('role='), lastSnapshotUrl())
face.setFilter({ claimable: true })
await settle()
check('the takeover filter travels to the route', lastSnapshotUrl().includes('claimable=true'), lastSnapshotUrl())
check('the takeover filter marks the listed row takeable', renderPage().html.includes('可接手'))
face.setFilter({ claimable: true, me: 'ses_qa' })
await settle()
check('a session reading travels as me with claimable', lastSnapshotUrl().includes('me=ses_qa') && lastSnapshotUrl().includes('claimable=true'), lastSnapshotUrl())
check('the host answers the me reading', renderPage().html.includes('没有符合当前筛选条件'))
mePool = { ses_qa: [requirement.id] }
await face.refresh()
await settle()
check('a session that may take the work sees it', renderPage().html.includes('跨会话需求看板'))
face.setFilter({ claimable: false, me: '' })
mePool = {}
await settle()

/* ------------------------------- the filter area: folded, and one line wide */

// Nothing is filtered here, so the area is one line: the switch, the summary, and
// the row count. The controls are not rendered at all until a reader opens them.
// Start from the folded reading, whatever the run before left the switch at.
if (filterToggleOf(renderPage())?.props['aria-expanded'] === true) filterToggleOf(renderPage()).props.onClick()
const foldedFilters = renderPage()
check('the filter area is folded while nothing is filtered',
  foldedFilters.html.includes(localeDicts.zh.filterSummaryAll)
  && filterToggleOf(foldedFilters)?.props['aria-expanded'] === false
  && !foldedFilters.collected.some(element => element.props.name === 'project'),
  foldedFilters.html.slice(0, 0) || 'the filter area is not folded')
const openedFilters = openFilters()
check('the switch opens every control without asking the host again',
  openedFilters.collected.some(element => element.props.name === 'project')
  && openedFilters.collected.some(element => element.props.name === 'filter.role'))

// A filter in force opens the area by itself and names itself in the summary; the
// chip is that one filter's own clearing affordance.
face.setFilter({ status: 'done' })
await settle()
const summaryPage = renderPage()
const statusChip = summaryPage.collected.find(element => element.props.name === 'filter.chip.status')
check('a filter in force opens the area and names itself in the summary',
  statusChip !== undefined && statusChip.html.includes(localeDicts.zh.statusDone),
  summaryPage.html.slice(0, 0) || 'the status chip is missing')
statusChip.props.onClick()
await settle()
check('a summary chip clears only the filter it names',
  face.hooks.board.getSnapshot().filter.status === 'open'
  && new URL(lastSnapshotUrl(), 'http://127.0.0.1:3080').searchParams.get('status') === 'open',
  lastSnapshotUrl())
check('an area the reader opened stays open once nothing is filtered',
  renderPage().collected.some(element => element.props.name === 'project'))
filterToggleOf(renderPage()).props.onClick()
check('the switch folds the controls away again',
  !renderPage().collected.some(element => element.props.name === 'project')
  && renderPage().html.includes(localeDicts.zh.filterSummaryAll))

// Fifteen roles stay one line, because their values live in the platform's own
// scrolling dropdown. What the capsule row offered is offered here — every value
// the Host may be asked for, each role's own open count, and the unrecorded ones
// named as such.
const manyRoles = Array.from({ length: 15 }, (_, index) => ({
  id: `role-${index + 1}`, name: `角色${index + 1}`, duties: [], source: 'manual', ephemeral: false,
  createdAt: iso(1000), updatedAt: iso(1000), dutiesMissing: false,
  holders: { online: 0, idle: 0, running: 0 }, open: index,
}))
snapshotPayload = boardSnapshot({
  roles: {
    items: manyRoles,
    unregistered: [{ id: 'ghost', dutiesMissing: true, holders: { online: 0, idle: 0, running: 0 }, open: 3 }],
  },
  stats: {
    ...boardSnapshot().stats,
    byRole: [...manyRoles.map((role, index) => ({ role: role.id, total: index })), { role: 'ghost', total: 3 }],
  },
})
await face.refresh()
await settle()
const compactFilters = openFilters()
const roleControl = compactFilters.findInput(props => props.name === 'filter.role')
check('fifteen roles are still one control on one line, with no row per role',
  compactFilters.collected.filter(element => element.props.name === 'filter.role').length === 1
  && compactFilters.collected.filter(element => element.type === 'option' && String(element.props.value).startsWith('role-')).length === 15
  && !compactFilters.collected.some(element => String(element.props.className ?? '').includes('rb-chips')))
check('the role control offers each role with its own open count, and names the unrecorded one',
  roleControl.html.includes(`${localeDicts.zh.filterRoleAll} (1)`)
  && roleControl.html.includes(`${localeDicts.zh.roleHuman} (0)`)
  && roleControl.html.includes('角色15 (role-15) (14)')
  && roleControl.html.includes(`ghost · ${localeDicts.zh.roleUnregistered} (3)`),
  roleControl.html)
roleControl.props.onChange({ target: { value: 'role-15' } })
await settle()
check('the compact control filters exactly as the capsule row did',
  lastSnapshotUrl().includes('role=role-15'), lastSnapshotUrl())

snapshotPayload = boardSnapshot()
face.setFilter({ query: '', status: 'open', priority: '', owner: '', session: '', kind: '', role: '', project: undefined, claimable: false, me: '' })
await face.refresh()
await settle()
// The reader closes the area again: a manual fold stands too, and the folded
// reading is what the rest of this run starts from.
filterToggleOf(renderPage()).props.onClick()

/* ------------------------------------------------------------------ locks */

const heldLock = { session: 'ses_C', name: '会话C', at: iso(3 * 3_600_000), touchedAt: iso(60_000) }
const locked = { ...structuredClone(requirement), lock: heldLock, rev: 9 }
snapshotPayload = boardSnapshot({ requirements: [locked] })
await face.refresh()
await settle()
const lockedPage = renderPage()
check('a card shows the lock holder and how long it has been held',
  lockedPage.html.includes('🔒 会话C (ses_C)') && lockedPage.html.includes('已持有 3h'), lockedPage.html)
check('the detail reports both lock instants', lockedPage.html.includes('续约于') && lockedPage.html.includes('未续约'))
check('the panel offers no claim action', !lockedPage.html.includes('认领'))

locked.lock = { ...heldLock, orphaned: true }
snapshotPayload = boardSnapshot({ requirements: [locked] })
await face.refresh()
await settle()
const orphanPage = renderPage()
check('an orphaned lock is marked', orphanPage.html.includes('孤儿锁'))
orphanPage.findButton('释放锁').props.onClick()
await settle()
const releaseCall = commandBodies().find(body => body.action === 'release')
check('releasing posts the release command with its revision',
  releaseCall?.id === requirement.id && releaseCall?.expectedRev === 9, JSON.stringify(releaseCall))

claimableIds = []
await face.refresh()
await settle()
check('a requirement the host refuses reads as not takeable', renderPage().html.includes('不可接手'))
claimableIds = null
claimableFailure = true
await face.refresh()
await settle()
check('an unanswered takeover read omits the badge instead of guessing', (() => {
  // The detail still names the two questions, but no badge claims an answer the
  // Host did not give.
  const page = renderPage()
  const badges = tags(page)
  return !badges.some(element => element.html === localeDicts.zh.claimableYes || element.html === localeDicts.zh.claimableNo)
})(), renderPage().html.slice(0, 0) || 'an eligibility badge was guessed')
claimableFailure = false
await face.refresh()
await settle()

/* ------------------------------------------------------- failure messages */

boundLocale = 'zh'
const failureCases = [
  [{ code: 'conflict', message: 'held by ses_C', details: { reason: 'locked' } }, '其他会话持有执行锁'],
  [{ code: 'conflict', message: 'reserved by ses_C', details: { reason: 'reserved' } }, '排进队列'],
  [{ code: 'conflict', message: 'session busy', details: { reason: 'session-busy' } }, '已在执行另一项需求'],
  [{ code: 'forbidden', message: 'wrong role', details: { reason: 'role-mismatch' } }, '路由给了别的角色'],
  [{ code: 'forbidden', message: 'lock first', details: { reason: 'lock-required' } }, '要先拿执行锁'],
  [{ code: 'forbidden', message: 'not the holder', details: { reason: 'not-lock-holder' } }, '只有持锁的会话'],
  [{ code: 'forbidden', message: 'human only', details: { reason: 'decision-task' } }, '决策类需求只能由人推进'],
  [{ code: 'invalid-role', message: 'bad role id' }, '角色 ID 不合法'],
  [{ code: 'forbidden', message: 'origin rejected' }, '请求被拒绝'],
]
for (const [failure, expected] of failureCases) {
  commandFailure = failure
  renderPage().findButton('归档').props.onClick()
  await settle()
  const label = `${failure.code}${failure.details === undefined ? '' : `/${failure.details.reason}`}`
  check(`a ${label} failure is explained in the app-level toast`, renderToast().includes(expected), renderToast())
}
check('the toast banner is an alert region that owns no dismissal control',
  (() => {
    const collected = harness.render(React.createElement(overlay.component, {
      ...toastFace,
      useToast: () => toastFace.hooks.toast.getSnapshot(),
      t: key => localeDicts[boundLocale][key],
    })).collected
    return collected.some(element => element.props.role === 'alert')
      && !collected.some(element => element.type === 'button')
  })())
check('a refusal is the long-hold weight, not the short one',
  String(harness.render(React.createElement(overlay.component, {
    ...toastFace,
    useToast: () => toastFace.hooks.toast.getSnapshot(),
    t: key => localeDicts[boundLocale][key],
  })).collected.find(element => element.props.role === 'alert')?.props.style?.['--dsh-toast-hold']) === '8000ms')
commandFailure = null
toastFace.dismissToast()
check('dismissing retires the toast', renderToast() === '')

/* -------------------------------------------------------- role management */

// Role management answers an association question, so it reads as two columns:
// the roles on the left, the presets that resolve to them on the right. Each
// column owns its own search box and its own scroll body, each group heading
// states its filtered count, every write reports where it was asked for rather
// than through the app toast, and an unsaved draft is never dropped silently.

boundLocale = 'zh'
snapshotPayload = boardSnapshot()
await face.refresh()
await settle()

/** The two role columns, left first. */
const columns = page => withClass(page, 'rb-roles-col')
/** Whether a page rendered an input under the given name. */
const hasInput = (page, name) => page.collected.some(element => element.type === 'input' && element.props.name === name)
/** The form layer among the dialogs, found by the role-id field only it has. */
const formLayer = page => dialogs(page).find(element => element.html.includes(localeDicts.zh.roleId))
/** The group headings and their counts, in render order. */
const groupHeads = page => page.collected
  .filter(element => element.type === 'h3' && String(element.props.className).includes('rb-group-head'))
  .map(element => element.html)
/** Click the role dialog's own close control: the footer button labelled exactly. */
const closeRolesDialog = () => renderPage().collected.find(element => element.type === 'button'
  && element.props.disabled !== true && element.html === localeDicts.zh.close).props.onClick()

renderPage().findButton('角色管理').props.onClick()
const rolesDialog = renderPage()
check('the role dialog lists a role with its duties', rolesDialog.html.includes('美术') && rolesDialog.html.includes('资产规范'))
check('a role row states where the role came from', rolesDialog.html.includes('来自预设声明'))
check('the role dialog states that it is reading the preset roster first',
  rolesDialog.html.includes('正在读取预设名册'))
check('a temporary role shows what delegation bound it to',
  rolesDialog.html.includes('临时') && rolesDialog.html.includes('绑定会话') && rolesDialog.html.includes('ses_sub') && rolesDialog.html.includes('绑定任务'))
check('a role without duties is highlighted', rolesDialog.html.includes('没有登记职能'))
check('an id in use but unrecorded is listed', rolesDialog.html.includes('在用但未登记') && rolesDialog.html.includes('未登记'))
check('the role dialog states presence in two forms and drops the derived idle count', (() => {
  const html = rolesDialog.html
  return html.includes('2 人在线 · 1 执行中') && html.includes('暂无人在线') && html.includes('个未完成') && !html.includes('空闲 0')
})())
check('a temporary role offers no edit or delete', (() => {
  const rows = withClass(rolesDialog, 'rb-role-row')
  const temporary = rows.find(row => row.html.includes('临时'))
  return temporary !== undefined && !temporary.html.includes('编辑') && !temporary.html.includes('删除角色')
})())

/* ---- D1: one wider dialog, two columns, each with its own search and scroll ---- */

check('the role dialog takes its own width tier instead of one of the three defaults',
  String(dialogs(rolesDialog)[0]?.props.className) === 'rb-dialog-roles',
  String(dialogs(rolesDialog)[0]?.props.className))
check('the body is one grid of two columns', withClass(rolesDialog, 'rb-roles-grid').length === 1
  && withClass(rolesDialog, 'rb-roles-col').length === 2)
check('each column owns its own search box and its own scroll body',
  withClass(rolesDialog, 'rb-roles-scroll').length === 2
  && hasInput(rolesDialog, 'role.search') && hasInput(rolesDialog, 'preset.search'))
check('each column is titled apart from the groups under it',
  withClass(rolesDialog, 'rb-roles-col-head').length === 2
  && rolesDialog.html.includes(localeDicts.zh.rolesColumn) && rolesDialog.html.includes(localeDicts.zh.presetsColumn))
check('the left column groups its rows under real headings, each with its filtered count',
  JSON.stringify(groupHeads(rolesDialog)) === JSON.stringify(['已登记 1', '临时 1', '在用但未登记 1']),
  groupHeads(rolesDialog).join(' | '))

/* ------------------------------------- role management: the preset column */

// The catalogue is the read that ties a role to the preset it comes from: the
// dialog asks for it on open, because the registry audits each preset as it
// lists them and the board's own snapshot read must not wait on that. The same
// answer is served again after a write, so `registered` stands for the roster
// the Host holds once the preset's role has a record.
const presetCatalogue = registered => ({
  items: snapshotPayload.roles.items,
  unregistered: snapshotPayload.roles.unregistered,
  presets: {
    items: [
      { id: 'art', name: '美术预设', broken: '', roleId: 'art', roleName: '美术', recorded: true, dutiesMissing: false, confirmed: true, online: 1, open: 1 },
      { id: 'qa', name: '', broken: '', roleId: 'qa', roleName: '', recorded: registered, dutiesMissing: true, confirmed: false, online: 0, open: 1 },
      { id: 'Art Team', name: '非法 id 预设', broken: 'row failed to activate', roleId: '', roleName: '', recorded: false, dutiesMissing: true, confirmed: false, online: 0, open: 0 },
    ],
    unavailable: null,
  },
})
commandAnswers['role.list'] = presetCatalogue(false)
closeRolesDialog()
renderPage().findButton('角色管理').props.onClick()
// The mount starts the read; the render after it lands shows the roster.
renderPage()
await settle()
const presetDialog = renderPage()
check('the role dialog reads the preset catalogue when it opens', commandBodies().some(body => body.action === 'role.list'))
check('the preset section lists a preset with the role it resolves to',
  presetDialog.html.includes('预设模式') && presetDialog.html.includes('美术预设') && presetDialog.html.includes('角色: 美术 (art)'))
check('an unrecorded preset offers to register its role',
  presetDialog.buttons.some(element => element.props.name === 'preset.register.qa'))
check('a recorded preset offers no duplicate register action',
  !presetDialog.buttons.some(element => element.props.name === 'preset.register.art'))
check('a preset id that cannot be a role id offers nothing to register',
  !presetDialog.buttons.some(element => element.props.name === 'preset.register.Art Team')
  && presetDialog.html.includes('预设 id 不是合法角色 id'))
check('a preset with no observed session states that its role is inferred', presetDialog.html.includes('按预设 id 推定'))
check('the preset row keeps the activation diagnostic as its title',
  presetDialog.collected.some(element => element.props.title === 'row failed to activate'))
check('the preset section states its filtered count on its heading',
  groupHeads(presetDialog).includes('预设模式 3'), groupHeads(presetDialog).join(' | '))

/* ---- D5: each column filters on its own, and a search never re-decides a state ---- */

presetDialog.findInput(props => props.name === 'role.search').props.onChange({ target: { value: '资' } })
const searchedRoles = renderPage()
check('searching the left column keeps the matching role and drops the others', (() => {
  const [left] = columns(searchedRoles)
  return left !== undefined && left.html.includes('美术') && !left.html.includes('临时执行者') && !left.html.includes('qa')
})())
check('a left-column search leaves the other column alone',
  columns(searchedRoles)[1].html.includes('美术预设') && columns(searchedRoles)[1].html.includes('非法 id 预设'))
check('a left-column search recounts only that column',
  JSON.stringify(groupHeads(searchedRoles)) === JSON.stringify(['已登记 1', '预设模式 3']),
  groupHeads(searchedRoles).join(' | '))
renderPage().findInput(props => props.name === 'role.search').props.onChange({ target: { value: '' } })
renderPage().findInput(props => props.name === 'preset.search').props.onChange({ target: { value: '非法' } })
const searchedPresets = renderPage()
check('searching the preset column narrows its section and its heading count',
  searchedPresets.html.includes('非法 id 预设') && !searchedPresets.html.includes('美术预设')
  && groupHeads(searchedPresets).includes('预设模式 1'), groupHeads(searchedPresets).join(' | '))
renderPage().findInput(props => props.name === 'preset.search').props.onChange({ target: { value: '无此预设' } })
const noPresetMatch = renderPage()
check('a preset search with no match says so instead of showing an empty section',
  noPresetMatch.html.includes('没有预设匹配这个检索词') && groupHeads(noPresetMatch).includes('预设模式 0')
  && !noPresetMatch.html.includes('预设名册里没有任何预设'))
renderPage().findInput(props => props.name === 'preset.search').props.onChange({ target: { value: '' } })
renderPage().findInput(props => props.name === 'role.search').props.onChange({ target: { value: '无此角色' } })
const noRoleMatch = renderPage()
check('a role search with no match says so apart from "no role is recorded"',
  noRoleMatch.html.includes('没有角色匹配这个检索词') && !noRoleMatch.html.includes('还没有登记任何角色')
  && !groupHeads(noRoleMatch).some(head => head.startsWith('已登记') || head.startsWith('临时') || head.startsWith('在用')),
  groupHeads(noRoleMatch).join(' | '))
renderPage().findInput(props => props.name === 'role.search').props.onChange({ target: { value: '' } })

/* ---- D2/D3/D8: the form is a second dialog layer, duties one row each ---- */

renderPage().buttons.find(element => element.props.name === 'role.edit.art').props.onClick()
const editForm = renderPage()
check('the form opens as a second dialog, titled with the role it edits',
  dialogs(editForm).length === 2
  && String(formLayer(editForm)?.props['aria-label']).includes('美术')
  && String(formLayer(editForm)?.props['aria-label']).includes('art'),
  dialogs(editForm).map(element => String(element.props['aria-label'])).join(' | '))
check('the row the form addresses stays marked while it is open', (() => {
  const row = withClass(editForm, 'rb-role-row').find(element => element.html.includes('美术'))
  return row !== undefined && row.props['aria-current'] === 'true'
    && String(row.props.className).includes('rb-role-row-editing')
})())
check('the form pins the id of the role it edits and loads its duties one row each',
  editForm.collected.some(element => element.type === 'input' && element.props.name === 'role.roleId'
    && element.props.value === 'art' && element.props.disabled === true)
  && editForm.collected.some(element => element.type === 'input' && element.props.name === 'role.duty.0' && element.props.value === '资产规范')
  && !hasInput(editForm, 'role.duties'))
check('every duty marker is the control it claims to be', (() => {
  const markers = editForm.collected.filter(element => String(element.props.name ?? '').startsWith('role.duty.'))
  const entries = editForm.collected.filter(element => element.type === 'input' && String(element.props.name ?? '').startsWith('role.duty.'))
  return markers.some(element => element.type === 'button' && element.props.name === 'role.duty.remove.0')
    && markers.some(element => element.type === 'button' && element.props.name === 'role.duty.add')
    && entries.length === 1 && entries[0].props.name === 'role.duty.0'
})())
const roleForm = editForm.collected.find(element => element.type === 'form')
check('the form body is a form element, and the action row is inside it',
  roleForm !== undefined && roleForm.html.includes(localeDicts.zh.save) && roleForm.html.includes(localeDicts.zh.cancel))
check('saving is the form\'s own submit and cancelling an ordinary button',
  editForm.collected.find(element => element.props.name === 'role.save')?.props.type === 'submit'
  && editForm.collected.find(element => element.props.name === 'role.cancel')?.props.type === 'button')
check('the duty editor states the count against its ceiling', editForm.html.includes('1/12'))

renderPage().findInput(props => props.name === 'role.duty.0').props.onChange({ target: { value: '资产规范, 合规清单' } })
renderPage().findInput(props => props.name === 'role.roleName').props.onChange({ target: { value: '美术组' } })
const withDuty = renderPage()
check('a duty keeps the comma it contains, and the title follows the draft',
  withDuty.collected.some(element => element.type === 'input' && element.props.name === 'role.duty.0'
    && element.props.value === '资产规范, 合规清单')
  && String(formLayer(withDuty)?.props['aria-label']).includes('美术组'))
withDuty.buttons.find(element => element.props.name === 'role.duty.add').props.onClick()
const twoDuties = renderPage()
check('adding a duty appends one empty row and the count follows',
  twoDuties.collected.some(element => element.type === 'input' && element.props.name === 'role.duty.1' && element.props.value === '')
  && twoDuties.html.includes('2/12'))
renderPage().findInput(props => props.name === 'role.duty.1').props.onChange({ target: { value: '资产规范, 合规清单' } })
check('a repeated duty is stated as merged, not as a failure', renderPage().html.includes('已合并 1 条重复职能'))
renderPage().buttons.find(element => element.props.name === 'role.duty.remove.1').props.onClick()
const oneDuty = renderPage()
check('removing a duty drops exactly its own row',
  !hasInput(oneDuty, 'role.duty.1') && oneDuty.html.includes('1/12') && !oneDuty.html.includes('已合并'))

// The twelve-row ceiling is the Host's own entry limit, and the editor states it.
for (let index = 0; index < 11; index += 1) {
  renderPage().buttons.find(element => element.props.name === 'role.duty.add').props.onClick()
}
const fullDuties = renderPage()
check('the duty editor stops offering rows at the twelve-row ceiling',
  fullDuties.html.includes('12/12')
  && fullDuties.buttons.find(element => element.props.name === 'role.duty.add').props.disabled === true)
renderPage().buttons.find(element => element.props.name === 'role.cancel').props.onClick()
renderPage().buttons.find(element => element.props.name === 'role.discard.drop').props.onClick()

/* ---- D7: an unsaved draft is never dropped silently ---- */

renderPage().buttons.find(element => element.props.name === 'role.edit.art').props.onClick()
renderPage().findInput(props => props.name === 'role.roleName').props.onChange({ target: { value: '美术组' } })
renderPage().buttons.find(element => element.props.name === 'role.cancel').props.onClick()
const discardAsk = renderPage()
check('closing a changed form asks before the draft is lost',
  dialogs(discardAsk).length === 2
  && discardAsk.html.includes(localeDicts.zh.roleDiscardConfirm)
  && discardAsk.buttons.some(element => element.props.name === 'role.discard.drop')
  && discardAsk.buttons.some(element => element.props.name === 'role.discard.keep'))
check('the confirmation keeps the input on screen',
  discardAsk.collected.some(element => element.type === 'input' && element.props.name === 'role.roleName' && element.props.value === '美术组'))
// The layer's own close path (the mask; Escape is the platform's, over the same
// command) joins cancel: while the confirmation is up it takes the confirmation
// back rather than the input, so discarding stays an explicit act.
masks(discardAsk).at(-1).props.onClick()
const keptAsking = renderPage()
check('the close path while the confirmation is up takes the confirmation back, not the input',
  !keptAsking.html.includes(localeDicts.zh.roleDiscardConfirm)
  && keptAsking.collected.some(element => element.type === 'input' && element.props.name === 'role.roleName' && element.props.value === '美术组'))
renderPage().buttons.find(element => element.props.name === 'role.cancel').props.onClick()
renderPage().buttons.find(element => element.props.name === 'role.discard.keep').props.onClick()
check('keeping the edit hides the confirmation and keeps the draft',
  !renderPage().html.includes(localeDicts.zh.roleDiscardConfirm)
  && renderPage().collected.some(element => element.type === 'input' && element.props.name === 'role.roleName' && element.props.value === '美术组'))
renderPage().buttons.find(element => element.props.name === 'role.cancel').props.onClick()
renderPage().buttons.find(element => element.props.name === 'role.discard.drop').props.onClick()
check('discarding closes the form and leaves the role dialog in place', dialogs(renderPage()).length === 1)
check('an untouched form closes without asking', (() => {
  renderPage().buttons.find(element => element.props.name === 'role.edit.art').props.onClick()
  renderPage().buttons.find(element => element.props.name === 'role.cancel').props.onClick()
  return dialogs(renderPage()).length === 1
})())

/* ---- D6/D8: a refusal lands in the form, and never in the app toast ---- */

renderPage().buttons.find(element => element.props.name === 'role.edit.art').props.onClick()
renderPage().findInput(props => props.name === 'role.roleName').props.onChange({ target: { value: '美术组' } })
renderPage().findInput(props => props.name === 'role.duty.0').props.onChange({ target: { value: '资产规范, 合规清单' } })
commandRefusals['role.put'] = { code: 'invalid-role', message: 'roleId "art" must match a lowercase id' }
renderPage().collected.find(element => element.type === 'form').props.onSubmit({ preventDefault: () => {} })
await settle()
const refusedSave = renderPage()
check('the submit control carries no click handler: submitting the form is what saves',
  refusedSave.collected.find(element => element.props.name === 'role.save')?.props.onClick === undefined)
check('a refused save is reported inside the form, in the Host\'s own words',
  refusedSave.html.includes(localeDicts.zh.roleFormError) && refusedSave.html.includes('must match a lowercase id')
  && refusedSave.collected.some(element => element.props.name === 'role.form.error'))
check('a refused save keeps the form and the draft on screen',
  dialogs(refusedSave).length === 2
  && refusedSave.collected.some(element => element.type === 'input' && element.props.name === 'role.roleName' && element.props.value === '美术组'))
check('a refused save raises no app toast', renderToast() === '', renderToast())

// Saving is the ordinary panel put: the Host's own reader trims each duty, drops
// the empty rows, and keeps the first occurrence of a repeat, so the panel states
// the merge it is about to send and the form closes on success.
delete commandRefusals['role.put']
renderPage().buttons.find(element => element.props.name === 'role.duty.add').props.onClick()
renderPage().findInput(props => props.name === 'role.duty.1').props.onChange({ target: { value: '资产规范, 合规清单' } })
renderPage().buttons.find(element => element.props.name === 'role.duty.add').props.onClick()
const readsBeforeSave = commandBodies().filter(body => body.action === 'role.list').length
commandAnswers['role.list'] = presetCatalogue(true)
renderPage().collected.find(element => element.type === 'form').props.onSubmit({ preventDefault: () => {} })
await settle()
const saved = renderPage()
check('saving posts role.put with the drafted name and the merged duties', (() => {
  const call = commandBodies().filter(body => body.action === 'role.put').at(-1)
  return call?.role?.roleId === 'art' && call?.role?.roleName === '美术组'
    && JSON.stringify(call?.role?.duties) === JSON.stringify(['资产规范, 合规清单'])
})(), JSON.stringify(commandBodies().filter(body => body.action === 'role.put').at(-1)?.role))
check('a successful save closes the form and re-reads the roster once',
  dialogs(saved).length === 1
  && commandBodies().filter(body => body.action === 'role.list').length === readsBeforeSave + 1)
check('the row marker is gone once the form closes',
  !withClass(saved, 'rb-role-row').some(element => element.props['aria-current'] === 'true'))

/* ---- D2: registering from a preset opens the same form layer ---- */

commandAnswers['role.list'] = presetCatalogue(false)
closeRolesDialog()
renderPage().findButton('角色管理').props.onClick()
renderPage()
await settle()
renderPage().buttons.find(element => element.props.name === 'preset.register.qa').props.onClick()
const prefilled = renderPage()
check('a preset registers through the same form layer, titled with that preset',
  dialogs(prefilled).length === 2
  && String(formLayer(prefilled)?.props['aria-label']).includes(localeDicts.zh.presetRegister)
  && String(formLayer(prefilled)?.props['aria-label']).includes('qa'))
check('registering a preset prefills its role id and display name',
  prefilled.collected.some(element => element.type === 'input' && element.props.name === 'role.roleId' && element.props.value === 'qa')
  && prefilled.collected.some(element => element.type === 'input' && element.props.name === 'role.roleName' && element.props.value === 'qa'))
check('the preset row it came from is marked while the form is open', (() => {
  const row = withClass(prefilled, 'rb-preset-row').find(element => element.html.includes('qa'))
  return row !== undefined && row.props['aria-current'] === 'true'
})())

const readsBeforeRegister = commandBodies().filter(body => body.action === 'role.list').length
commandAnswers['role.list'] = presetCatalogue(true)
prefilled.collected.find(element => element.type === 'form').props.onSubmit({ preventDefault: () => {} })
await settle()
check('the register form posts the ordinary role put with the prefilled id',
  commandBodies().some(body => body.action === 'role.put' && body.role?.roleId === 'qa'))
check('a successful put re-reads the preset roster, once',
  commandBodies().filter(body => body.action === 'role.list').length === readsBeforeRegister + 1)
check('the registered preset stops offering the register action',
  !renderPage().buttons.some(element => element.props.name === 'preset.register.qa'))

/* ---- D4: the delete confirmation opens inside the row that asked for it ---- */

// A second recorded role is what shows that one row confirms at a time.
snapshotPayload = boardSnapshot({
  roles: {
    items: [
      { id: 'ops', name: '运维', duties: ['值班'], source: 'manual', ephemeral: false, createdAt: iso(86_400_000), updatedAt: iso(86_400_000), dutiesMissing: false, holders: { online: 0, idle: 0, running: 0 }, open: 0 },
      ...boardSnapshot().roles.items,
    ],
    unregistered: [],
  },
})
await face.refresh()
await settle()
renderPage().buttons.find(element => element.props.name === 'role.remove.art').props.onClick()
const confirmArt = renderPage()
check('deleting a role asks for confirmation inside that row', (() => {
  const row = withClass(confirmArt, 'rb-role-row').find(element => element.html.includes('美术'))
  return row !== undefined && row.html.includes(localeDicts.zh.removeRoleConfirm)
    && row.html.includes(localeDicts.zh.confirm)
})())
check('the confirmation is one block, and it carries controls named for that row',
  withClass(confirmArt, 'rb-role-confirm').length === 1
  && confirmArt.buttons.some(element => element.props.name === 'role.confirm.art')
  && confirmArt.buttons.some(element => element.props.name === 'role.confirm.cancel.art'))
renderPage().buttons.find(element => element.props.name === 'role.remove.ops').props.onClick()
const confirmOps = renderPage()
check('asking about another row moves the confirmation instead of adding one', (() => {
  const ops = withClass(confirmOps, 'rb-role-row').find(element => element.html.includes('运维'))
  const art = withClass(confirmOps, 'rb-role-row').find(element => element.html.includes('美术'))
  return withClass(confirmOps, 'rb-role-confirm').length === 1
    && ops !== undefined && ops.html.includes(localeDicts.zh.removeRoleConfirm)
    && art !== undefined && !art.html.includes(localeDicts.zh.removeRoleConfirm)
})())
renderPage().buttons.find(element => element.props.name === 'role.confirm.cancel.ops').props.onClick()
const cancelledConfirm = renderPage()
check('cancelling restores the row',
  withClass(cancelledConfirm, 'rb-role-confirm').length === 0
  && !cancelledConfirm.buttons.some(element => element.props.name === 'role.confirm.ops'))

// A refused delete reports on its own row, and reaches no toast.
renderPage().buttons.find(element => element.props.name === 'role.remove.ops').props.onClick()
commandRefusals['role.delete'] = { code: 'forbidden', message: 'only the panel may delete this role' }
renderPage().buttons.find(element => element.props.name === 'role.confirm.ops').props.onClick()
await settle()
const refusedDelete = renderPage()
check('a refused delete is reported on the row that asked for it, in the Host\'s words', (() => {
  const row = withClass(refusedDelete, 'rb-role-row').find(element => element.html.includes('运维'))
  return row !== undefined && row.html.includes(localeDicts.zh.roleRowError)
    && row.html.includes('only the panel may delete this role')
})())
check('the row error block is named for its row',
  refusedDelete.collected.some(element => element.props.name === 'role.row.error.ops'))
check('a refused delete raises no app toast', renderToast() === '', renderToast())
delete commandRefusals['role.delete']
renderPage().buttons.find(element => element.props.name === 'role.confirm.cancel.ops').props.onClick()
renderPage().buttons.find(element => element.props.name === 'role.remove.art').props.onClick()
renderPage().buttons.find(element => element.props.name === 'role.confirm.art').props.onClick()
await settle()
const deleteCalls = commandBodies().filter(body => body.action === 'role.delete')
check('confirming a role deletion posts role.delete', deleteCalls.at(-1)?.id === 'art'
  && deleteCalls.map(call => call.id).join(',') === 'ops,art', JSON.stringify(deleteCalls))
closeRolesDialog()
check('the role dialog closes again', !renderPage().html.includes(localeDicts.zh.newRole))

/* --------------------------------- role management: degraded roster states */

commandAnswers['role.list'] = { items: [], unregistered: [], presets: { items: [], unavailable: { code: 'service-absent' } } }
renderPage().findButton('角色管理').props.onClick()
renderPage()
await settle()
check('an absent preset registry is stated with its cause, not as an empty roster',
  renderPage().html.includes('没有挂载预设注册表') && !renderPage().html.includes('预设名册里没有任何预设'))

commandAnswers['role.list'] = { items: [], unregistered: [], presets: { items: [], unavailable: { code: 'read-failed', detail: 'roster exploded' } } }
closeRolesDialog()
renderPage().findButton('角色管理').props.onClick()
renderPage()
await settle()
check('a failed roster read is stated apart from an empty roster',
  renderPage().html.includes('读取预设名册失败') && renderPage().html.includes('roster exploded'))

closeRolesDialog()
delete commandAnswers['role.list']

snapshotPayload = boardSnapshot({ roles: { items: [], unregistered: [] } })
await face.refresh()
await settle()
renderPage().findButton('角色管理').props.onClick()
check('an empty role table renders its empty state', renderPage().html.includes('还没有登记任何角色'))
closeRolesDialog()
snapshotPayload = boardSnapshot()
await face.refresh()
await settle()

/* ---------------------------------------------------------- stream state */

boundLocale = 'zh'
check('a live stream hides the stale notice', !renderPage().html.includes('同步中断'))
FakeEventSource.instances[0].emit('error')
check('a dropped stream warns that the data may be out of date', renderPage().html.includes('同步中断，数据可能过期'))
const readsBeforeReconnect = requests.filter(request => String(request.url).includes('/snapshot') && !isTakeoverRead(request)).length
FakeEventSource.instances[0].emit('ready')
await settle()
check('reconnecting refetches the whole snapshot', requests.filter(request => String(request.url).includes('/snapshot')
  && !isTakeoverRead(request)).length > readsBeforeReconnect)
check('the stale notice clears when the stream is back', !renderPage().html.includes('同步中断'))
const readsBeforeChange = snapshotReads()
FakeEventSource.instances[0].emit('changed')
await settleChanges()
check('a committed change refetches the snapshot', snapshotReads() > readsBeforeChange, `${snapshotReads()} vs ${readsBeforeChange}`)
const readsBeforeBurst = snapshotReads()
for (let index = 0; index < 5; index += 1) FakeEventSource.instances[0].emit('changed')
await settleChanges()
check('a burst of committed changes costs one whole-snapshot read',
  snapshotReads() === readsBeforeBurst + 1, `${snapshotReads() - readsBeforeBurst} reads for 5 events`)

/* --------------------------------------------------- read ordering (O9) */

/**
 * The defect this section guards: a read already in flight answers after a newer
 * one, and its older document covers the newer reading on screen. The page must
 * publish only its newest read.
 */
snapshotPayload = boardSnapshot({ revision: 41 })
await face.refresh()
await settle()
const releaseSlow = holdSnapshotRead(17)
const slowRead = face.refresh()
const slowRequest = requests.filter(request => String(request.url).includes('/snapshot') && !isTakeoverRead(request)).at(-1)
snapshotPayload = boardSnapshot({ revision: 42 })
await face.refresh()
await settle()
check('a superseded read is aborted rather than left to run', slowRequest?.init?.signal?.aborted === true)
releaseSlow()
await slowRead
await settle()
const ordered = face.hooks.board.getSnapshot()
check('a superseded read does not put the panel back on an older revision', ordered.revision === 42, String(ordered.revision))
check('a superseded read is not reported as a failure', ordered.error === null, String(ordered.error))
check('the newest read is the one on screen', ordered.status === 'ready' && ordered.requirements.length === 1, JSON.stringify(ordered.status))

// A filter switch is a read like any other and must take effect even when its
// answer carries the revision the page already shows: the guard is the newest
// read, never the newest revision.
snapshotPayload = boardSnapshot({ revision: 42, requirements: [requirement, handed], total: 2 })
await face.refresh()
await settle()
check('both requirements are on the board before the switch', face.hooks.board.getSnapshot().requirements.length === 2)
face.setFilter({ query: '跨会话' })
await settle()
const switched = face.hooks.board.getSnapshot()
check('a filter switch lands even when the revision did not move',
  switched.filter.query === '跨会话' && switched.requirements.length === 1,
  `${switched.filter.query} / ${switched.requirements.length} rows at revision ${switched.revision}`)
face.setFilter({ query: '' })
snapshotPayload = boardSnapshot()
await face.refresh()
await settle()

/* ------------------------------------------------------------ view switcher */

boundLocale = 'zh'
snapshotPayload = boardSnapshot({
  requirements: [requirement, reserved, decision],
  total: 3,
  // The service's own projection: rows ordered by session, each row's items in
  // the order that session will take them. `ses_H` queues an id the fetched page
  // does not list, and `ses_Empty` holds nothing at all.
  queues: [
    { session: 'ses_Q', sessionName: '会话Q', items: [{ id: reserved.id, at: iso(120_000) }, { id: requirement.id, at: iso(60_000) }], head: { id: reserved.id, at: iso(120_000) }, length: 2, updatedAt: iso(120_000) },
    { session: 'ses_Empty', sessionName: '空队列', items: [], head: null, length: 0, updatedAt: null },
    { session: 'ses_H', sessionName: '人的队', items: [{ id: 'req_gone000009', at: iso(30_000) }], head: { id: 'req_gone000009', at: iso(30_000) }, length: 1, updatedAt: iso(30_000) },
  ],
})
await face.refresh()
await settle()
const viewPage = renderPage()
check('the page offers a board, a queue and a decisions view',
  ['board', 'queue', 'decisions'].every(name => viewPage.collected.some(element => element.type === 'button' && element.props.name === `view.${name}`)))
check('the board is the view in force on load',
  viewPage.collected.some(element => element.props.name === 'view.board' && element.props['aria-pressed'] === true))
check('a reserved requirement is marked on its card', viewPage.html.includes(`${localeDicts.zh.reservedBadge}: ses_Q`), viewPage.html.slice(0, 0) || 'the reserved badge is missing')

/* -------------------------------------------------------------- queue view */

viewPage.collected.find(element => element.props.name === 'view.queue').props.onClick()
await settle()
const queueUrl = lastSnapshotUrl()
check('the queue view reads the whole board', !queueUrl.includes('kind=') && !queueUrl.includes('claimable=true'), queueUrl)
const queuePage = renderPage()
const queuedNames = queuePage.collected.filter(element => String(element.props.name ?? '').startsWith('unqueue.')).map(element => element.props.name)
/** The id each "next" mark names: the first queue button after it in the tree. */
const markedHeads = queuePage.collected.reduce((heads, element, index) => {
  if (element.props['data-tone'] !== 'info' || element.html !== localeDicts.zh.queueNext) return heads
  const next = queuePage.collected.slice(index).find(candidate => String(candidate.props.name ?? '').startsWith('unqueue.'))
  return [...heads, next === undefined ? null : String(next.props.name).slice('unqueue.'.length)]
}, [])
check('the queue groups per session', queuePage.html.includes(`${localeDicts.zh.queueTitle}: ses_Q`)
  && queuePage.html.includes(`${localeDicts.zh.queueTitle}: ses_H`))
check('a queue group states how many it holds', queuePage.html.includes(tst('queueCount', { count: 2 })), queuePage.html.slice(0, 0) || 'the group count is missing')
check('the queue explains that a reservation is a soft hold', queuePage.html.includes(localeDicts.zh.queueSoftHint))
check('the queue says the order comes from the service', queuePage.html.includes(localeDicts.zh.queueHint))
check('the queue renders the service order, not its own',
  JSON.stringify(queuedNames) === JSON.stringify([`unqueue.${reserved.id}`, `unqueue.${requirement.id}`, 'unqueue.req_gone000009']),
  JSON.stringify(queuedNames))
check('the queue marks the head the service named',
  JSON.stringify(markedHeads) === JSON.stringify([reserved.id, 'req_gone000009']), JSON.stringify(markedHeads))
check('a queue row the page does not list shows its own id', queuePage.html.includes('req_gone000009'))
check('a session that queues nothing is not rendered', !queuePage.html.includes('ses_Empty'))
check('a listed requirement the service did not queue is not in the queue',
  !queuedNames.includes(`unqueue.${decision.id}`), JSON.stringify(queuedNames))

// The mark follows the service, not an order the panel keeps: move `head` to the
// other item of the same row and the mark moves with it.
snapshotPayload = boardSnapshot({
  requirements: [requirement, reserved],
  total: 2,
  queues: [{ session: 'ses_Q', sessionName: '会话Q', items: [{ id: requirement.id, at: iso(60_000) }, { id: reserved.id, at: iso(120_000) }], head: { id: requirement.id, at: iso(60_000) }, length: 2, updatedAt: iso(120_000) }],
})
await face.refresh()
await settle()
const movedPage = renderPage()
const movedHeads = movedPage.collected.reduce((heads, element, index) => {
  if (element.props['data-tone'] !== 'info' || element.html !== localeDicts.zh.queueNext) return heads
  const next = movedPage.collected.slice(index).find(candidate => String(candidate.props.name ?? '').startsWith('unqueue.'))
  return [...heads, next === undefined ? null : String(next.props.name).slice('unqueue.'.length)]
}, [])
check('the mark follows the head the receipt names',
  JSON.stringify(movedHeads) === JSON.stringify([requirement.id]), JSON.stringify(movedHeads))

commandData = { changed: true, session: 'ses_Q', items: [requirement.id], head: requirement.id, length: 1 }
renderPage().collected.find(element => element.props.name === `unqueue.${reserved.id}`).props.onClick()
await settle()
const unqueueCall = commandBodies().filter(body => body.action === 'unqueue').at(-1)
check('clearing a reservation names the session whose hold it clears',
  unqueueCall?.id === reserved.id && unqueueCall?.targetSession === 'ses_Q', JSON.stringify(unqueueCall))
const clearedToast = renderToastHost()
check('clearing a reservation is confirmed', clearedToast.html.includes(localeDicts.zh.reservationCleared), clearedToast.html)
check('a landed change is the informational weight, not a failure',
  toastSuccess(clearedToast) && toastHold(clearedToast) === '3500ms')

commandData = { changed: false, session: 'ses_Q', items: [], head: null, length: 0 }
renderPage().collected.find(element => element.props.name === `unqueue.${reserved.id}`).props.onClick()
await settle()
const emptyQueueToast = renderToastHost()
check('clearing nothing is reported as a light note, not a success',
  emptyQueueToast.html.includes(localeDicts.zh.reservationAbsent) && !emptyQueueToast.html.includes(localeDicts.zh.reservationCleared), emptyQueueToast.html)
check('a light note is neither the error nor the success weight',
  toastHold(emptyQueueToast) === '3500ms' && !toastSuccess(emptyQueueToast))
commandData = { done: true }

/* ------------------------------------------------------------ hand-off view */

const handedRoles = {
  items: [
    ...boardSnapshot().roles.items,
    { id: 'tmp_req_demo000004_delegate', name: '渲染执行者', duties: [], source: 'delegated', ephemeral: true, boundSession: 'ses_sub', boundTask: handed.id, createdAt: iso(3_600_000), updatedAt: iso(3_600_000), dutiesMissing: true, holders: { online: 0, idle: 0, running: 0 }, open: 0 },
  ],
  unregistered: [],
}
snapshotPayload = boardSnapshot({ requirements: [requirement, handed], roles: handedRoles })
renderPage().collected.find(element => element.props.name === 'view.board').props.onClick()
await face.refresh()
await settle()
const handedPage = renderPage()
check('a handed requirement is marked on its card', handedPage.html.includes(`${localeDicts.zh.delegatedBadge}: 子会话 (ses_sub)`), handedPage.html.slice(0, 0) || 'the hand-off badge is missing')
handedPage.collected.find(element => element.type === 'button' && element.props.role === 'listitem' && element.html.includes('已派发给子会话的活')).props.onClick()
const handDetail = renderPage()
check('the detail reports the session holding the hand-off',
  handDetail.html.includes(localeDicts.zh.delegatedTo) && handDetail.html.includes('子会话 (ses_sub)'))
check('the detail reports the routing the hand-off replaced',
  handDetail.html.includes(localeDicts.zh.delegatedRoleBefore) && handDetail.html.includes('美术 (art)')
  && handDetail.html.includes(localeDicts.zh.delegatedAt))
check('the temporary role and what bound it are visible',
  handDetail.html.includes(localeDicts.zh.roleEphemeral) && handDetail.html.includes(`${localeDicts.zh.roleBoundSession}: ses_sub`)
  && handDetail.html.includes(`${localeDicts.zh.roleBoundTask}: ${handed.id}`), handDetail.html.slice(0, 0) || 'the temporary role is missing')
check('a handed requirement offers revoke', handDetail.collected.some(element => element.props.name === 'revoke.delegation'))

commandData = { changed: false }
renderPage().buttons.find(element => element.props.name === 'revoke.delegation' && element.props.disabled !== true).props.onClick()
await settle()
const revokeCall = commandBodies().filter(body => body.action === 'delegate').at(-1)
check('revoking posts the revoke flag with the expected revision',
  revokeCall?.id === handed.id && revokeCall?.revoke === true && revokeCall?.expectedRev === handed.rev, JSON.stringify(revokeCall))
const absentToast = renderToastHost()
check('a revoke with nothing to undo is a light note',
  absentToast.html.includes(localeDicts.zh.delegationAbsent) && !absentToast.html.includes(localeDicts.zh.delegationRevoked), absentToast.html)
check('the no-op revoke is not dressed as a success',
  toastHold(absentToast) === '3500ms' && !toastSuccess(absentToast))

commandData = { changed: true }
renderPage().buttons.find(element => element.props.name === 'revoke.delegation' && element.props.disabled !== true).props.onClick()
await settle()
check('an effective revoke is confirmed', renderToast().includes(localeDicts.zh.delegationRevoked), renderToast())
commandData = { done: true }

/* ---------------------------------------------------------- delegate form */

snapshotPayload = boardSnapshot()
await face.refresh()
await settle()
const formList = renderPage()
formList.collected.find(element => element.type === 'button' && element.props.role === 'listitem' && element.html.includes('跨会话需求看板')).props.onClick()
const formPage = renderPage()
check('an unhanded requirement says so', formPage.html.includes(localeDicts.zh.notDelegated))
check('a hand-off needs a target session first',
  formPage.collected.some(element => element.props.name === 'delegate.submit' && element.props.disabled === true)
  && formPage.html.includes(localeDicts.zh.delegateNeedsSession))
formPage.findInput(props => props.name === 'delegate.session').props.onChange({ target: { value: 'ses_sub' } })
renderPage().findInput(props => props.name === 'delegate.duties').props.onChange({ target: { value: '渲染, 回归' } })
renderPage().findInput(props => props.name === 'delegate.roleName').props.onChange({ target: { value: '渲染执行者' } })
renderPage().buttons.find(element => element.props.name === 'delegate.submit' && element.props.disabled !== true).props.onClick()
await settle()
const delegateCall = commandBodies().filter(body => body.action === 'delegate').at(-1)
check('delegating posts the session, duties and expected revision',
  delegateCall?.id === requirement.id && delegateCall?.session === 'ses_sub' && delegateCall?.duties?.length === 2
  && delegateCall?.roleName === '渲染执行者' && delegateCall?.expectedRev === requirement.rev, JSON.stringify(delegateCall))
check('a completed hand-off is confirmed', renderToast().includes(tst('delegateDone', { session: 'ses_sub' })), renderToast())

/* ---------------------------------------------------------- decision view */

snapshotPayload = boardSnapshot({ requirements: [requirement, decision] })
await face.refresh()
await settle()
renderPage().collected.find(element => element.props.name === 'view.decisions').props.onClick()
await settle()
const decisionUrl = lastSnapshotUrl()
check('the decisions view asks the host for decisions only',
  decisionUrl.includes('kind=decision') && !decisionUrl.includes('claimable=true') && !decisionUrl.includes('me='), decisionUrl)
const decisionsPage = renderPage()
check('the decisions view states that only a person advances it', decisionsPage.html.includes(localeDicts.zh.viewDecisionsHint))
check('a decision card carries its badge and its requester',
  decisionsPage.html.includes(localeDicts.zh.decisionBadge) && decisionsPage.html.includes(localeDicts.zh.requestedBy))
const decisionCard = decisionsPage.collected.find(element => element.type === 'button' && element.props.role === 'listitem' && element.html.includes('是否走自研渲染'))
check('the decisions view lists only decisions', decisionCard !== undefined && !decisionsPage.collected.some(element => element.type === 'button' && element.props.role === 'listitem' && element.html.includes('跨会话需求看板')))
decisionCard?.props.onClick()
const decisionDetail = renderPage()
check('a decision shows who asked for the call',
  metaValue(decisionDetail, localeDicts.zh.requestedBy) === 'ses_A')
check('the panel may archive or remove a decision',
  decisionDetail.buttons.some(element => element.html === localeDicts.zh.archive)
  && decisionDetail.buttons.some(element => element.html === localeDicts.zh.remove))

renderPage().findButton(localeDicts.zh.editRequirement).props.onClick()
const editPage = renderPage()
check('the edit form offers the priority and the routing role',
  editPage.collected.some(element => element.props.name === 'edit.priority') && editPage.collected.some(element => element.props.name === 'edit.role'))
check('the edit form never offers to change the kind',
  !editPage.collected.some(element => String(element.props.name ?? '').includes('edit.kind')))
editPage.collected.find(element => element.props.name === 'edit.priority').props.onChange({ target: { value: 'high' } })
renderPage().collected.find(element => element.props.name === 'edit.role').props.onChange({ target: { value: 'art' } })
renderPage().buttons.find(element => element.props.name === 'edit.save').props.onClick()
await settle()
const updateCall = commandBodies().filter(body => body.action === 'update').at(-1)
check('saving posts the priority and role patch with the expected revision',
  updateCall?.id === decision.id && updateCall?.patch?.priority === 'high' && updateCall?.patch?.role === 'art'
  && updateCall?.expectedRev === decision.rev, JSON.stringify(updateCall))
check('a saved edit is confirmed', renderToast().includes(localeDicts.zh.updateApplied), renderToast())
check('the edit form closes after a successful save', !renderPage().collected.some(element => element.props.name === 'edit.save'))

/* -------------------------------------------------------- option section */

// A decision that asks two questions: the panel is where a person answers it, one
// question at a time, and what the section shows as answered is always the
// record's own answer rather than what the reader just typed.
const asked = {
  ...structuredClone(decision),
  rev: 5,
  options: [
    { id: 'q1', prompt: '描边用几像素？', choices: [
      { id: 'A', label: '2px', detail: '更轻，但边缘偏硬' },
      { id: 'B', label: '3px', detail: '更稳，略重', recommended: true },
    ] },
    { id: 'q2', prompt: '要不要加投影？', choices: [
      { id: 'A', label: '加' },
      { id: 'B', label: '不加' },
    ] },
  ],
}
snapshotPayload = boardSnapshot({ requirements: [asked], total: 1 })
await face.refresh()
await settle()
const askedDetail = renderPage()
check('a decision that asks questions says it is waiting for a choice',
  askedDetail.html.includes(localeDicts.zh.optionAwaitingHuman))
check('the option section reads after the description and before the history', (() => {
  const promptAt = askedDetail.html.indexOf('描边用几像素？')
  return promptAt > askedDetail.html.indexOf(asked.description) && promptAt < askedDetail.html.indexOf(localeDicts.zh.history)
})(), askedDetail.html.slice(0, 0) || 'the option section is not in its place')
check('every choice is offered with its cost and the recommended mark',
  askedDetail.html.includes('更轻，但边缘偏硬') && askedDetail.html.includes(localeDicts.zh.optionRecommended))

/** One choice of one question, as the radio the harness collected. */
const choiceOf = (page, question, choice) => page.collected.find(element => element.type === 'input'
  && element.props.name === `options.pick.${question}` && element.props.value === choice)
check('an unanswered question offers its choices enabled',
  choiceOf(askedDetail, 'q1', 'A')?.props.disabled === false && choiceOf(askedDetail, 'q1', 'B')?.props.disabled === false)
check('the submit waits for a choice',
  askedDetail.collected.find(element => element.props.name === 'options.submit')?.props.disabled === true)
choiceOf(askedDetail, 'q1', 'B').props.onChange({ target: {} })
await settle()
check('the picked choice is the one marked in force',
  renderPage().collected.filter(element => element.props.name === 'options.pick.q1' && element.props.checked === true).length === 1)
check('the submit arms once a choice is picked',
  renderPage().collected.find(element => element.props.name === 'options.submit')?.props.disabled === false)
renderPage().findInput(props => props.name === 'options.note').props.onChange({ target: { value: '按评审结论走' } })
renderPage().collected.find(element => element.props.name === 'options.submit').props.onClick()
await settle()
const decideCall = commandBodies().filter(body => body.action === 'decide').at(-1)
check('submitting sends only the questions still open, with the reason and the revision',
  decideCall?.id === asked.id && decideCall?.expectedRev === asked.rev
  && JSON.stringify(decideCall?.answer) === JSON.stringify({ q1: 'B' }) && decideCall?.note === '按评审结论走',
  JSON.stringify(decideCall))
check('a recorded answer is confirmed', renderToast().includes(localeDicts.zh.optionAnswerSaved), renderToast())

// The Host answers with the record it wrote: one question settled and the other
// still open, which is what the panel then reads.
snapshotPayload = boardSnapshot({
  requirements: [{ ...asked, rev: 6, answer: { q1: 'B' }, answerNote: '按评审结论走', answeredAt: iso(60_000) }],
  total: 1,
})
await face.refresh()
await settle()
const halfAnswered = renderPage()
check('an answered question keeps its choices, with the stored pick marked and closed to changes',
  halfAnswered.collected.filter(element => element.props.name === 'options.pick.q1' && element.props.checked === true).length === 1
  && halfAnswered.collected.filter(element => element.props.name === 'options.pick.q1').every(element => element.props.disabled === true))
check('the answered question states its pick, its reason and when it was answered',
  halfAnswered.html.includes(localeDicts.zh.optionAnsweredTag)
  && halfAnswered.html.includes(localeDicts.zh.optionAnsweredAt)
  && halfAnswered.html.includes('按评审结论走'))
check('the question still open keeps its own choices and submit',
  choiceOf(halfAnswered, 'q2', 'A')?.props.disabled === false
  && halfAnswered.collected.some(element => element.props.name === 'options.submit'))

// Answering the last question is the service's own completion, so the section
// stops asking the moment the record reports every question settled.
snapshotPayload = boardSnapshot({
  requirements: [{ ...asked, status: 'done', rev: 7, answer: { q1: 'B', q2: 'A' }, answerNote: '按评审结论走', answeredAt: iso(60_000) }],
  total: 1,
})
await face.refresh()
await settle()
const settledDetail = renderPage()
check('a settled decision offers no submit and no open choice',
  !settledDetail.collected.some(element => element.props.name === 'options.submit')
  && settledDetail.collected.filter(element => String(element.props.name ?? '').startsWith('options.pick.')).every(element => element.props.disabled === true))
check('a settled decision no longer says it waits for a choice',
  !settledDetail.html.includes(localeDicts.zh.optionAwaitingHuman))

/* --------------------------------------------------------- failure reasons */

/** Click an always-present detail action against a stub failure and read the toast. */
async function failureToast(code, reason) {
  commandFailure = { code, message: 'stubbed failure', details: { reason } }
  renderPage().findButton(localeDicts.zh.archive).props.onClick()
  await settle()
  const toast = renderToastHost()
  commandFailure = null
  return toast
}

snapshotPayload = boardSnapshot()
renderPage().collected.find(element => element.props.name === 'view.board').props.onClick()
await face.refresh()
await settle()
for (const [code, reason, key] of [
  ['conflict', 'delegated', 'errDelegated'],
  ['forbidden', 'panel-only', 'errPanelOnly'],
  ['forbidden', 'not-owned', 'errNotOwned'],
  ['forbidden', 'not-related', 'errNotRelated'],
  ['invalid-argument', 'session-required', 'errSessionRequired'],
  ['invalid-argument', 'delegate-to-self', 'errDelegateToSelf'],
]) {
  const toast = await failureToast(code, reason)
  check(`${code}/${reason} is explained in the toast`, toast.html.includes(localeDicts.zh[key]), toast.html)
}
check('an unexplained reason still falls back to the code', (await failureToast('invalid-argument', 'mystery')).html.includes(localeDicts.zh.errInvalidArgument))

// The new actions carry their own failure feedback where the action was taken.
snapshotPayload = boardSnapshot({ requirements: [requirement, reserved], queues: queueProjection('ses_Q', [reserved.id]) })
await face.refresh()
await settle()
renderPage().collected.find(element => element.props.name === 'view.queue').props.onClick()
await settle()
commandFailure = { code: 'forbidden', message: 'panel only', details: { reason: 'panel-only' } }
renderPage().collected.find(element => element.props.name === `unqueue.${reserved.id}`).props.onClick()
await settle()
check('a refused reservation clear is explained and keeps the queue',
  renderToast().includes(localeDicts.zh.errPanelOnly) && renderPage().html.includes(localeDicts.zh.queueSoftHint), renderToast())
commandFailure = null
renderPage().collected.find(element => element.props.name === 'view.board').props.onClick()
await face.refresh()
await settle()
renderPage().collected.find(element => element.type === 'button' && element.props.role === 'listitem' && element.html.includes('跨会话需求看板')).props.onClick()
commandFailure = { code: 'conflict', message: 'already delegated', details: { reason: 'delegated' } }
renderPage().findInput(props => props.name === 'delegate.session').props.onChange({ target: { value: 'ses_sub' } })
renderPage().buttons.find(element => element.props.name === 'delegate.submit' && element.props.disabled !== true).props.onClick()
await settle()
check('a refused hand-off is explained without losing what was typed',
  renderToast().includes(localeDicts.zh.errDelegated)
  && renderPage().findInput(props => props.name === 'delegate.session').props.value === 'ses_sub', renderToast())
commandFailure = null

/* --------------------------------------------------------- counters + gaps */

snapshotPayload = boardSnapshot({
  requirements: [requirement, decision],
  stats: {
    ...boardSnapshot().stats,
    byKind: { task: 1, decision: 1 },
    decisions: 1,
    queues: [],
    queued: 0,
    reserved: 1,
    orphanedLocks: 2,
    pendingDelegations: 1,
    byRole: [{ role: 'art', total: 2, done: 0, blocked: 0, active: 2 }],
  },
})
await face.refresh()
await settle()
const statsPage = renderPage()
check('the counters bar reports the coordination counters',
  statsPage.html.includes(localeDicts.zh.statsReserved) && statsPage.html.includes(localeDicts.zh.statsOrphanedLocks)
  && statsPage.html.includes(localeDicts.zh.statsPendingDelegations) && statsPage.html.includes(localeDicts.zh.statsUnfinished), statsPage.html.slice(0, 0) || 'the counters are missing')
check('the counters bar reports the unfinished split by kind',
  statsPage.html.includes(localeDicts.zh.kindTask) && statsPage.html.includes(localeDicts.zh.kindDecision))
check('the counters bar reports the unfinished total per role',
  statsPage.html.includes(localeDicts.zh.statsByRole) && statsPage.html.includes('美术 (art) 2'))
check('an unhealthy counter is highlighted, not silently shown',
  statsPage.collected.some(element => String(element.props.className ?? '').includes('rb-warn')))
snapshotPayload = boardSnapshot({ requirements: [requirement], stats: boardSnapshot().stats })
await face.refresh()
await settle()
const bareStats = renderPage()
check('a host that reports no coordination counters renders none',
  !bareStats.html.includes(localeDicts.zh.statsOrphanedLocks) && !bareStats.html.includes(localeDicts.zh.statsByRole))

renderPage().collected.find(element => element.props.name === 'view.board').props.onClick()
await settle()
const orphaned = { ...structuredClone(requirement), lock: { session: 'ses_Z', name: '会话Z', at: iso(7_200_000), touchedAt: iso(7_200_000), orphaned: true }, rev: 11 }
snapshotPayload = boardSnapshot({ requirements: [orphaned, reserved] })
await face.refresh()
await settle()
const gapPage = renderPage()
gapPage.collected.find(element => element.type === 'button' && element.props.role === 'listitem' && element.html.includes('跨会话需求看板')).props.onClick()
const gapDetail = renderPage()
check('an orphaned lock is called out with its release action',
  gapDetail.html.includes(localeDicts.zh.lockOrphaned) && gapDetail.buttons.some(element => element.html === localeDicts.zh.releaseLock))
check('the reserved badge names the holding session', gapPage.html.includes(`${localeDicts.zh.reservedBadge}: ses_Q`))

/* ------------------------ gates, escalated priority, eligibility, forcing */

boundLocale = 'zh'
// A board with a gate: `gateBlocked` waits on `gateBlocker`, and `gateBlocker`
// reads one level above the level it is stored at because in-progress work waits
// on it. Both rows carry the Host's own per-row eligibility answers.
face.setFilter({ kind: '', role: '', me: '', claimable: false })
snapshotPayload = boardSnapshot({
  requirements: [{ ...gateBlocker, claimable: false, advanceable: true }, { ...gateBlocked, claimable: true, advanceable: false }],
  total: 2,
  stats: { ...boardSnapshot().stats, criticalPath: 1 },
})
// The separately read takeover set answers "nothing here is takeable"; the rows
// answer for themselves, so the per-row answer has to win.
claimableIds = []
await face.refresh()
await settle()

/** Every Tag primitive the tree rendered, found by the tone attribute it carries. */
function tags(page) {
  return page.collected.filter(element => element.props['data-tone'] !== undefined)
}
/** The first Tag whose own text is exactly `text`, if any. */
function badgeWithText(page, text) {
  return tags(page).find(element => element.html === text)
}
/** The hold the banner carries: only the refusal weight is the long one. */
function toastHold(page) {
  return String(page.collected.find(element => element.props.role === 'alert')?.props.style?.['--dsh-toast-hold'] ?? '')
}
/** Whether the banner shows the primitive's success glyph, which only a landed change earns. */
function toastSuccess(page) {
  return page.collected.some(element => element.type === 'span' && element.props['aria-hidden'] === true)
}
/**
 * The wrapper carrying a titled badge's tooltip. `Tag` accepts only
 * tone/className/children, so a render site that needs `title` wraps it.
 */
function titledBadgeWithText(page, text) {
  return page.collected.find(element => element.type === 'span' && typeof element.props.title === 'string' && element.html === text)
}
/** One card button, found by the title it shows. */
function cardOf(page, title) {
  return page.collected.find(element => element.type === 'button' && element.props.role === 'listitem' && element.html.includes(title))
}

const gatePage = renderPage()
const criticalLabel = gatePage.collected.findIndex(element => String(element.props.className ?? '').includes('rb-stat-label') && element.html === localeDicts.zh.criticalPath)
check('the counters bar counts the critical path',
  criticalLabel >= 0 && gatePage.collected[criticalLabel + 1].html === '1'
  && String(gatePage.collected[criticalLabel + 1].props.className).includes('rb-warn'),
  gatePage.html.slice(0, 0) || 'the critical-path counter is missing')
const blockerCard = cardOf(gatePage, gateBlocker.title)
const blockedCard = cardOf(gatePage, gateBlocked.title)
check('a raised requirement is marked on its card',
  blockerCard.html.includes(`${localeDicts.zh.criticalTag}: urgent↑`), blockerCard.html.slice(0, 0) || 'no critical-path marker')
check('a card that is not raised carries no critical marker',
  !blockedCard.html.includes(`${localeDicts.zh.criticalTag}:`), blockedCard.html.slice(0, 0) || 'an unraised card was marked')
check('a card that waits on unfinished work is marked as gated',
  blockedCard.html.includes(tst('gatedBadge', { count: 1 })), blockedCard.html.slice(0, 0) || 'no gate marker')
check('a card shows how much it waits on',
  blockedCard.html.includes(tst('blocksBadge', { count: 1 })), blockedCard.html.slice(0, 0) || 'no declared-link marker')

blockerCard.props.onClick()
await settle()
const raisedDetail = renderPage()
check('the detail names the stored priority and the effective level apart',
  metaValue(raisedDetail, localeDicts.zh.ownPriority) === localeDicts.zh.priorityNormal
  && metaValue(raisedDetail, localeDicts.zh.effectivePriority) === 'urgent↑',
  raisedDetail.html.slice(0, 0) || 'the two levels are not told apart')
check('the detail says the raised level was not written back',
  raisedDetail.html.includes(localeDicts.zh.priorityLiftedHint))

blockedCard.props.onClick()
await settle()
const blockedDetail = renderPage()
check('the detail says who blocks it, resolved to the requirement',
  blockedDetail.html.includes(localeDicts.zh.blockedByTitle) && blockedDetail.html.includes(`${gateBlocker.title} (${gateBlocker.id})`),
  blockedDetail.html.slice(0, 0) || 'the blocker is not named')
check('the detail lists the declared link it waits on',
  blockedDetail.html.includes(localeDicts.zh.blocksOnTitle))
check('the detail names the parent and the sub-requirements',
  blockedDetail.html.includes(localeDicts.zh.parentRequirement) && blockedDetail.html.includes(localeDicts.zh.childrenTitle)
  && blockedDetail.html.includes(`${gateBlocker.title} (${gateBlocker.id})`), blockedDetail.html.slice(0, 0) || 'the parent link is missing')
check('the gate hint explains that archiving a blocker is not finishing it',
  blockedDetail.html.includes(localeDicts.zh.gatesHint))
check('a detail without escalation omits the effective level even when the row carries one',
  metaValue(blockedDetail, localeDicts.zh.effectivePriority) === null
  && metaValue(blockedDetail, localeDicts.zh.ownPriority) === localeDicts.zh.priorityUrgent,
  blockedDetail.html.slice(0, 0) || 'a derived field was shown as escalation')

check('the two eligibility answers are separate badges, not one verdict',
  badgeWithText(blockedDetail, localeDicts.zh.claimableYes) !== undefined
  && badgeWithText(blockedDetail, localeDicts.zh.advanceableNo) !== undefined,
  blockedDetail.html.slice(0, 0) || 'the two answers are not both shown')
check('a per-row answer wins over the separately read id set',
  claimableIds.length === 0 && badgeWithText(blockedDetail, localeDicts.zh.claimableYes) !== undefined)
check('each eligibility badge names the reading it answers',
  String(titledBadgeWithText(blockedDetail, localeDicts.zh.claimableYes)?.props.title)
    .includes(tst('eligibilityFor', { me: localeDicts.zh.eligibilityPanel })),
  String(titledBadgeWithText(blockedDetail, localeDicts.zh.claimableYes)?.props.title))
check('the detail says can-claim and can-advance are different questions',
  blockedDetail.html.includes(localeDicts.zh.advanceableHint))

face.setFilter({ me: 'ses_qa' })
await settle()
check('a named reading travels even without the takeover filter',
  lastSnapshotUrl().includes('me=ses_qa') && !lastSnapshotUrl().includes('claimable=true'), lastSnapshotUrl())
check('the takeover side read names the same session',
  requests.some(request => isTakeoverRead(request) && String(request.url).includes('me=ses_qa')))
check('the eligibility rows name the session the read was for',
  renderPage().html.includes(tst('eligibilityFor', { me: 'ses_qa' })))
face.setFilter({ me: '' })
await settle()

// A gate refusal is the one failure with a way forward: the panel names the
// blockers where the action is, and the force stays a second, confirmed act.
commandFailure = {
  code: 'invalid-transition',
  message: `"${gateBlocked.id}" is blocked by unfinished requirement(s): ${gateBlocker.id}`,
  details: { reason: 'blocked-by', id: gateBlocked.id, action: 'advance', blockedBy: [gateBlocker.id] },
}
renderPage().findButton(localeDicts.zh.advance).props.onClick()
await settle()
const refusedPage = renderPage()
check('a gate refusal names the blockers next to the action',
  refusedPage.html.includes(localeDicts.zh.errBlockedBy) && refusedPage.html.includes(`${gateBlocker.title} (${gateBlocker.id})`),
  refusedPage.html.slice(0, 0) || 'the refusal does not name its blockers')
check('the refusal toast explains the gate', renderToast().includes(localeDicts.zh.errBlockedBy), renderToast())
check('nothing was forced by the refusal alone',
  !commandBodies().some(body => body.action === 'transition' && body.force === true))
check('forcing is offered as a separate act, not the default path',
  refusedPage.collected.some(element => element.props.name === 'force.request'))

refusedPage.collected.find(element => element.props.name === 'force.request').props.onClick()
await settle()
const confirmPage = renderPage()
check('forcing asks for explicit confirmation first', confirmPage.html.includes(localeDicts.zh.forceWarning))
check('the confirmation lists what it would override',
  confirmPage.html.includes(`${localeDicts.zh.blockedByTitle}: ${gateBlocker.title} (${gateBlocker.id})`),
  confirmPage.html.slice(0, 0) || 'the confirmation does not list the blockers')
commandFailure = null
confirmPage.collected.find(element => element.props.name === 'force.confirm').props.onClick()
await settle()
const forceCall = commandBodies().filter(body => body.action === 'transition').at(-1)
check('confirming posts the same transition with force',
  forceCall?.force === true && forceCall?.transition === 'advance'
  && forceCall?.id === gateBlocked.id && forceCall?.expectedRev === gateBlocked.rev, JSON.stringify(forceCall))
check('a forced move is reported as forced', renderToast().includes(localeDicts.zh.forceApplied), renderToast())
check('the force notice clears once the move landed',
  !renderPage().collected.some(element => element.props.name === 'force.request'))

// The gate links are writable from the panel, and the Host's three structural
// refusals have to come back where the link was typed.
snapshotPayload = boardSnapshot({ requirements: [{ ...requirement, parentId: null, blocksOn: [], children: [] }] })
await face.refresh()
await settle()
renderPage().findButton(localeDicts.zh.editRequirement).props.onClick()
await settle()
const linkForm = renderPage()
check('the edit form offers both gate fields when the row carries them',
  linkForm.collected.some(element => element.props.name === 'edit.parentId')
  && linkForm.collected.some(element => element.props.name === 'edit.blocksOn'))
commandFailure = {
  code: 'invalid-argument',
  message: `"${requirement.id}" cannot be its own parent`,
  details: { reason: 'self-reference', id: requirement.id, field: 'parentId' },
}
renderPage().findInput(props => props.name === 'edit.parentId').props.onChange({ target: { value: requirement.id } })
renderPage().collected.find(element => element.props.name === 'edit.save').props.onClick()
await settle()
check('a self-referencing parent is explained', renderToast().includes(localeDicts.zh.errSelfReference), renderToast())
check('the raw host detail travels with it', renderToast().includes('cannot be its own parent'), renderToast())
check('the edit form stays open so the link can be corrected',
  renderPage().collected.some(element => element.props.name === 'edit.save'))
commandFailure = null
check('a cycle-forming link is explained',
  (await failureToast('invalid-argument', 'cycle')).html.includes(localeDicts.zh.errCycle))
check('a link to a requirement that does not exist is explained',
  (await failureToast('invalid-argument', 'missing-target')).html.includes(localeDicts.zh.errMissingTarget))
check('a transition refusal without a known reason falls back to the code',
  (await failureToast('invalid-transition', 'mystery')).html.includes(localeDicts.zh.errInvalidTransition))

/* ----------------------------------------------------------- execution units */

// §5.5: execution units are observed facts with their own revision. Sync off,
// sync with a gap, and sync on with nothing running are three different
// sentences, and only the last one may say the list is empty.
const runningUnit = {
  ref: 'job_build_1',
  kind: 'job',
  label: '构建产物',
  status: 'running',
  progress: '2/5',
  detail: '正在编译',
  startedAt: iso(600_000),
  finishedAt: null,
  updatedAt: iso(60_000),
  stale: false,
}
const execRow = {
  ...structuredClone(requirement),
  executions: [runningUnit],
  executionsTruncated: false,
  execRev: 4,
  running: 1,
  sync: { enabled: true, gap: false, syncedAt: iso(60_000), reason: '' },
}
/** One stats cell's value node, found by the label it renders beside. */
const statCell = (page, label) => {
  const index = page.collected.findIndex(element => String(element.props.className ?? '').includes('rb-stat-label') && element.html === label)
  return index < 0 ? null : page.collected[index + 1]
}
snapshotPayload = boardSnapshot({ requirements: [execRow] })
await face.refresh()
await settle()
cardOf(renderPage(), execRow.title).props.onClick()
await settle()
const execPage = renderPage()
check('the detail lists the observed execution units',
  execPage.html.includes(localeDicts.zh.executions) && execPage.html.includes('构建产物'), execPage.html.slice(0, 0) || 'no unit was listed')
check('a unit names its kind, its status and when it started',
  execPage.html.includes(localeDicts.zh.unitJob) && execPage.html.includes('running')
  && execPage.html.includes(`${localeDicts.zh.unitStarted}:`), execPage.html.slice(0, 0) || 'the unit row is bare')
check('a running unit is counted where it is listed',
  execPage.html.includes(tst('runningBadge', { count: 1 })), execPage.html.slice(0, 0) || 'no running count')
check('the observation revision is printed apart from the business revision',
  execPage.html.includes(tst('execRevLine', { exec: 4, rev: execRow.rev })), execPage.html.slice(0, 0) || 'the two revisions are not told apart')
check('a settled list says nothing about being out of sync',
  !execPage.html.includes(localeDicts.zh.executionSyncOff) && !execPage.html.includes(localeDicts.zh.executionSyncGap))

snapshotPayload = boardSnapshot({ requirements: [{ ...execRow, executions: [{ ...runningUnit, stale: true }], executionsTruncated: true }] })
await face.refresh()
await settle()
const truncatedPage = renderPage()
check('a truncated unit list says it is only the most recent slice', truncatedPage.html.includes(localeDicts.zh.executionsTruncated))
check('a unit with no update since its last observation is marked stale', truncatedPage.html.includes(localeDicts.zh.unitStale))

snapshotPayload = boardSnapshot({
  requirements: [{ ...requirement, executions: [], executionsTruncated: false, execRev: 2, running: 0, sync: { enabled: false, gap: false, syncedAt: null, reason: 'execution-sync-disabled' } }],
})
await face.refresh()
await settle()
const syncOffPage = renderPage()
check('sync off says only the lock is known',
  syncOffPage.html.includes(localeDicts.zh.executionSyncOff), syncOffPage.html.slice(0, 0) || 'sync off is silent')
check('sync off never reads as "nothing is executing"', !syncOffPage.html.includes(localeDicts.zh.executionsEmpty))

snapshotPayload = boardSnapshot({
  requirements: [{ ...requirement, executions: [], execRev: 2, running: 0, sync: { enabled: true, gap: true, syncedAt: iso(120_000), reason: 'missing-registry-jobs' } }],
})
await face.refresh()
await settle()
const syncGapPage = renderPage()
check('a gap states itself, its reason and the last observation',
  syncGapPage.html.includes(localeDicts.zh.executionSyncGap)
  && syncGapPage.html.includes(`${localeDicts.zh.executionSyncReason}: missing-registry-jobs`)
  && syncGapPage.html.includes(`${localeDicts.zh.executionSyncAt}:`), syncGapPage.html.slice(0, 0) || 'the gap is not explained')
check('a gap never claims nothing is executing', !syncGapPage.html.includes(localeDicts.zh.executionsEmpty))

snapshotPayload = boardSnapshot({
  requirements: [{ ...requirement, executions: [], execRev: 3, running: 0, sync: { enabled: true, gap: false, syncedAt: iso(120_000), reason: '' } }],
})
await face.refresh()
await settle()
const settledPage = renderPage()
check('a synced, gap-free, empty list is the one that says nothing is executing',
  settledPage.html.includes(localeDicts.zh.executionsEmpty)
  && !settledPage.html.includes(localeDicts.zh.executionSyncOff)
  && !settledPage.html.includes(localeDicts.zh.executionSyncGap), settledPage.html.slice(0, 0) || 'the empty case is not stated')

snapshotPayload = boardSnapshot({ requirements: [requirement], stats: { ...boardSnapshot().stats, running: 3, execSync: { ignored: 5, gaps: 2 } } })
await face.refresh()
await settle()
const countedPage = renderPage()
check('the counters bar reports how many requirements are executing',
  statCell(countedPage, localeDicts.zh.statsRunning)?.html === '3', JSON.stringify(statCell(countedPage, localeDicts.zh.statsRunning)?.html))
check('an observation gap is counted as a warning',
  statCell(countedPage, localeDicts.zh.statsExecGaps)?.html === '2'
  && String(statCell(countedPage, localeDicts.zh.statsExecGaps)?.props.className ?? '').includes('rb-warn'),
  JSON.stringify(statCell(countedPage, localeDicts.zh.statsExecGaps)?.props.className))
check('unattributed events are counted when there are any',
  statCell(countedPage, localeDicts.zh.statsExecIgnored)?.html === '5', JSON.stringify(statCell(countedPage, localeDicts.zh.statsExecIgnored)?.html))

snapshotPayload = boardSnapshot({ requirements: [requirement], stats: { ...boardSnapshot().stats, running: 0, execSync: { ignored: 0, gaps: 0 } } })
await face.refresh()
await settle()
const quietPage = renderPage()
check('a gap-free observation is counted without a warning',
  statCell(quietPage, localeDicts.zh.statsExecGaps)?.html === '0'
  && !String(statCell(quietPage, localeDicts.zh.statsExecGaps)?.props.className ?? '').includes('rb-warn'))
check('nothing unattributed is not shown as a counter', statCell(quietPage, localeDicts.zh.statsExecIgnored) === null)

// An execution-only change moves the observation revision. The business
// revision stays where it was, so the next write still targets it.
snapshotPayload = boardSnapshot({ requirements: [{ ...requirement, executions: [runningUnit], execRev: 9, running: 1, sync: { enabled: true, gap: false, syncedAt: iso(30_000), reason: '' } }] })
await face.refresh()
await settle()
cardOf(renderPage(), requirement.title).props.onClick()
await settle()
check('an execution-only change leaves the business revision where it was',
  renderPage().html.includes(tst('execRevLine', { exec: 9, rev: requirement.rev })))
renderPage().findButton(localeDicts.zh.advance).props.onClick()
await settle()
const revisionCall = commandBodies().filter(body => body.action === 'transition').at(-1)
check('a write after an execution-only change still targets the business revision',
  revisionCall?.expectedRev === requirement.rev && revisionCall?.id === requirement.id, JSON.stringify(revisionCall))

// The brief is the panel's first reading: the card carries it under the title,
// the detail leads with it, and the full description stays behind its fold
// below. A record written before the field existed shows the placeholder in the
// same frame rather than an empty gap.
snapshotPayload = boardSnapshot({ requirements: [requirement] })
await face.refresh()
await settle()
check('the card carries the brief under its title',
  cardOf(renderPage(), requirement.title).html.includes(requirement.summary))
cardOf(renderPage(), requirement.title).props.onClick()
await settle()
const briefDetail = renderPage()
check('the detail leads with the brief, above the folded description',
  briefDetail.collected.some(element => String(element.props.className ?? '').includes('rb-summary-text') && element.html.includes(requirement.summary))
  && briefDetail.html.indexOf(requirement.summary) < briefDetail.html.indexOf(requirement.description))
snapshotPayload = boardSnapshot({ requirements: [{ ...requirement, summary: '' }] })
await face.refresh()
await settle()
cardOf(renderPage(), requirement.title).props.onClick()
await settle()
const legacyDetail = renderPage()
check('a requirement written before the field existed shows the placeholder',
  legacyDetail.html.includes(localeDicts.zh.summaryEmpty)
  && legacyDetail.collected.some(element => String(element.props.className ?? '').includes('rb-summary-empty')))

// The project is the label a crowded board is sorted by: the card carries it,
// the detail names it, the filter reads it and can ask for the requirements that
// belong to none, and the grouped reading splits the list into one section per
// project with the unassigned ones last.
boundLocale = 'zh'
const filedA = { ...requirement, id: 'req_filed_a', title: '看板里的第一条', project: '看板' }
const filedB = { ...requirement, id: 'req_filed_b', title: '看板里的第二条', project: '看板' }
const loose = { ...requirement, id: 'req_loose', title: '还没归属的一条', project: '' }
snapshotPayload = boardSnapshot({ requirements: [filedA, filedB, loose], total: 3, projects: ['看板', '圣女战棋'] })
await face.refresh()
await settle()
const projectBoard = renderPage()
check('the card carries the project as a tag',
  projectBoard.collected.some(element => String(element.props.className ?? '').includes('rb-card-project') && element.html === '看板'))
check('a requirement belonging to no project renders no tag',
  !cardOf(projectBoard, loose.title).html.includes(localeDicts.zh.projectUnassigned))
// Nothing is filtered here, so the area is still folded and its controls are not
// rendered at all: the checks below open it the way a reader does.
check('the folded filter area offers no control to read',
  filterToggleOf(projectBoard)?.props['aria-expanded'] === false
  && !projectBoard.collected.some(element => element.props.name === 'project'))
const openedProjects = openFilters()
check('the filter offers every project, including one no listed row carries',
  openedProjects.html.includes('圣女战棋') && openedProjects.html.includes(localeDicts.zh.projectUnassigned))
const projectSelect = openedProjects.findInput(props => props.name === 'project')
check('the project filter renders as its own control', projectSelect !== undefined)
cardOf(projectBoard, filedA.title).props.onClick()
await settle()
check('the detail names the project the requirement belongs to',
  renderPage().collected.some(element => String(element.props.className ?? '').includes('rb-meta-v') && element.html === '看板'))
cardOf(renderPage(), loose.title).props.onClick()
await settle()
check('a requirement with no project reads as unassigned in the detail',
  renderPage().collected.some(element => String(element.props.className ?? '').includes('rb-meta-v') && element.html === localeDicts.zh.projectUnassigned))

// The two filter spellings stay distinct on the wire: the sentinel asks the Host
// for the unassigned requirements, while "every project" sends no key at all —
// a host given the empty string would otherwise read it as no filter.
projectSelect.props.onChange({ target: { value: '__unassigned__' } })
await settle()
const unassignedURL = new URL(lastSnapshotUrl(), 'http://127.0.0.1:3080')
check('asking for the unassigned requirements puts an empty project on the wire',
  unassignedURL.searchParams.has('project') && unassignedURL.searchParams.get('project') === '')
openFilters().findInput(props => props.name === 'project').props.onChange({ target: { value: '' } })
await settle()
check('every project drops the key instead of sending an empty one',
  new URL(lastSnapshotUrl(), 'http://127.0.0.1:3080').searchParams.has('project') === false)

const groupToggle = checkboxFor(openFilters(), localeDicts.zh.groupProject)
check('the board offers the grouped reading', groupToggle !== undefined)
groupToggle.props.onChange({ target: { checked: true } })
await settle()
const grouped = renderPage()
const groupNames = grouped.collected.filter(element => String(element.props.className ?? '') === 'rb-group-name').map(element => element.html)
const groupCounts = grouped.collected.filter(element => String(element.props.className ?? '') === 'rb-group-n').map(element => element.html)
check('grouping splits the board into one section per project, the unassigned last',
  groupNames.join(',') === `看板,${localeDicts.zh.projectUnassigned}`, groupNames.join(','))
check('each group states how many requirements it holds', groupCounts.join(',') === '2,1', groupCounts.join(','))
checkboxFor(openFilters(), localeDicts.zh.groupProject).props.onChange({ target: { checked: false } })
await settle()
check('leaving the grouped reading restores the flat list',
  renderPage().collected.filter(element => String(element.props.className ?? '') === 'rb-group-name').length === 0)

// A Host that reports none of these facts must not be dressed with them.
snapshotPayload = boardSnapshot()
await face.refresh()
await settle()
const barePage = renderPage()
check('a host that reports no gate or escalation facts renders no such badge',
  !barePage.collected.some(element => typeof element.props.title === 'string' && element.props.title.startsWith(localeDicts.zh.blockedByTitle))
  && !tags(barePage).some(element => element.html.includes(localeDicts.zh.criticalTag)))
check('a host that counts no critical path renders no counter',
  !barePage.html.includes(localeDicts.zh.criticalPath))
check('a host that reports no executions renders no execution section',
  !barePage.html.includes(localeDicts.zh.executions) && !barePage.collected.some(element => String(element.props.className ?? '').includes('rb-exec')))
check('a host that counts no executions renders no running counter',
  statCell(barePage, localeDicts.zh.statsRunning) === null && statCell(barePage, localeDicts.zh.statsExecGaps) === null)
renderPage().collected.find(element => element.props.name === 'view.queue').props.onClick()
await settle()
check('a host that queues nothing renders an empty queue view, not an invented one',
  !renderPage().collected.some(element => String(element.props.name ?? '').startsWith('unqueue.'))
  && renderPage().html.includes(localeDicts.zh.queueEmpty))
renderPage().collected.find(element => element.props.name === 'view.board').props.onClick()
await settle()
const gateKey = barePage.collected.findIndex(element => String(element.props.className ?? '').includes('rb-kv-key') && element.html === localeDicts.zh.parentRequirement)
check('a requirement with no links says so instead of leaving blanks',
  gateKey >= 0 && barePage.collected[gateKey + 1]?.html === localeDicts.zh.noneLinked,
  barePage.html.slice(0, 0) || 'the empty gate row is missing')

// Every literal the panel asks the dictionary for must exist in both languages:
// a missing key would render its own name into the panel.
const askedKeys = [...source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'/g)].map(match => match[1])
check('every dictionary key the panel asks for by name exists in both languages',
  askedKeys.every(key => localeDicts.en[key] !== undefined && localeDicts.zh[key] !== undefined),
  askedKeys.filter(key => localeDicts.en[key] === undefined || localeDicts.zh[key] === undefined).join(','))
check('both languages carry exactly the same keys',
  JSON.stringify(Object.keys(localeDicts.en).sort()) === JSON.stringify(Object.keys(localeDicts.zh).sort()),
  Object.keys(localeDicts.en).filter(key => localeDicts.zh[key] === undefined).join(','))

check('every new string exists in both dictionaries',
  ['criticalPath', 'criticalTag', 'effectivePriority', 'ownPriority', 'priorityLiftedHint', 'gates', 'gatesHint',
    'blocksOnTitle', 'blockedByTitle', 'gatedBadge', 'blocksBadge', 'parentRequirement', 'childrenTitle', 'noneLinked',
    'blocksOnHint', 'eligibility', 'eligibilityFor', 'eligibilityPanel', 'advanceableYes', 'advanceableNo',
    'advanceableHint', 'forceAdvance', 'forceConfirm', 'forceWarning', 'forceApplied', 'errBlockedBy', 'errCycle',
    'errSelfReference', 'errMissingTarget'].every(key => typeof localeDicts.en[key] === 'string' && localeDicts.en[key] !== ''
      && typeof localeDicts.zh[key] === 'string' && localeDicts.zh[key] !== ''))
check('every execution, queue and refusal string exists in both dictionaries',
  ['roleHuman', 'executions', 'executionsHint', 'executionsEmpty', 'executionsTruncated', 'executionSyncOff',
    'executionSyncGap', 'executionSyncReason', 'executionSyncAt', 'execRevLine', 'runningBadge', 'statsRunning',
    'statsExecIgnored', 'statsExecGaps', 'unitJob', 'unitSubagent', 'unitStarted', 'unitFinished', 'unitStale',
    'queueNext', 'queueHint', 'authExpired', 'authExpiredHint', 'authCrossOrigin', 'authCrossOriginHint', 'recheck']
    .every(key => typeof localeDicts.en[key] === 'string' && localeDicts.en[key] !== ''
      && typeof localeDicts.zh[key] === 'string' && localeDicts.zh[key] !== ''))
check('the local role control is gone from both dictionaries',
  localeDicts.en.roleLocal === undefined && localeDicts.zh.roleLocal === undefined
  && localeDicts.en.roleLocalHint === undefined && localeDicts.zh.roleLocalHint === undefined)
check('every description-image string exists in both dictionaries',
  ['images', 'addImage', 'pasteImageHint', 'imageUploading', 'imageUploadFailed', 'imageTypeRejected',
    'imageTooLarge', 'imageLimitReached', 'removeImage', 'pastedImageName']
    .every(key => typeof localeDicts.en[key] === 'string' && localeDicts.en[key] !== ''
      && typeof localeDicts.zh[key] === 'string' && localeDicts.zh[key] !== ''))

/* ---------------------------------------------------- trust gate refusals */

// The platform's trust gate answers the panel route before the board does: a
// missing or expired credential is 401, a foreign origin is 403. Neither is a
// board failure, and neither may start a retry loop.
snapshotRefusal = { status: 401, error: { code: 'unauthenticated', message: 'this request carries no valid session credential for the board API' } }
await face.refresh()
await settle()
const expiredPage = renderPage()
check('an expired credential is named as an expired session, not a board error',
  expiredPage.html.includes(localeDicts.zh.authExpired) && expiredPage.html.includes(localeDicts.zh.authExpiredHint),
  expiredPage.html.slice(0, 0) || 'the refusal is not explained')
check('the expired notice tells the reader to reopen the panel',
  expiredPage.html.includes(localeDicts.zh.authExpiredHint) && expiredPage.html.includes(localeDicts.zh.recheck))
check('the last good board stays on screen behind the notice',
  expiredPage.html.includes(requirement.title))
check('the refresh control is disabled while the page cannot read anywhere',
  expiredPage.collected.find(element => element.props.name === 'refresh')?.props.disabled === true)
const quietReads = requests.length
FakeEventSource.instances.at(-1).emit('changed')
for (const listener of documentStub.listeners.get('visibilitychange') ?? []) listener()
await settle()
check('a refused page does not retry on an event or a visibility change',
  requests.length === quietReads, `${requests.length} vs ${quietReads}`)
check('a refused page closes its stream', FakeEventSource.instances.at(-1).closed === true)
const quietToast = renderToastHost()
check('a refusal is not repeated as a toast on every event',
  !quietToast.html.includes(localeDicts.zh.authExpired), quietToast.html)

snapshotRefusal = null
expiredPage.collected.find(element => element.props.name === 'auth.recheck').props.onClick()
await settle()
check('re-checking once, on request, reads again',
  requests.length > quietReads, `${requests.length} vs ${quietReads}`)
check('a re-check that succeeds clears the refusal notice',
  !renderPage().html.includes(localeDicts.zh.authExpired))

// A command refused the same way stops the page and says the same thing.
commandFailure = { code: 'unauthenticated', message: 'this request carries no valid session credential for the board API' }
renderPage().findButton(localeDicts.zh.advance).props.onClick()
await settle()
check('a refused command is reported as an expired session, not as a board error',
  renderToast().includes(localeDicts.zh.authExpired), renderToast())
check('a refused command also stops the page from reading',
  renderPage().html.includes(localeDicts.zh.authExpired))
commandFailure = null
const stoppedReads = requests.length
FakeEventSource.instances.at(-1).emit('ready')
await settle()
check('the refusal after a command does not start a retry loop',
  requests.length === stoppedReads, `${requests.length} vs ${stoppedReads}`)
renderPage().collected.find(element => element.props.name === 'auth.recheck').props.onClick()
await settle()

snapshotRefusal = { status: 403, error: { code: 'forbidden-origin', message: 'the request origin is not allowed to reach this API' } }
await face.refresh()
await settle()
const crossOriginPage = renderPage()
check('a cross-origin refusal says so instead of blaming the session',
  crossOriginPage.html.includes(localeDicts.zh.authCrossOrigin)
  && crossOriginPage.html.includes(localeDicts.zh.authCrossOriginHint)
  && !crossOriginPage.html.includes(localeDicts.zh.authExpired),
  crossOriginPage.html.slice(0, 0) || 'the origin refusal is not explained')
check('a cross-origin refusal is not dressed as a board failure',
  !crossOriginPage.collected.some(element => String(element.props.className ?? '').includes('rb-notice-error')))
snapshotRefusal = null
crossOriginPage.collected.find(element => element.props.name === 'auth.recheck').props.onClick()
await settle()
check('the page recovers when the origin is accepted again',
  !renderPage().html.includes(localeDicts.zh.authCrossOrigin))

/* -------------------------------------------------------- visual language */

// The redesign's own layer, read from the shipped source: one accent per theme
// arm, every other colour a registered variable, and the concept's type scale
// and geometry. A colour that drifts out of the registry, a rule that loses its
// measurement, or a step of the type scale that is edited away fails here.
const cssStart = source.indexOf(`const CSS = `)
const cssRaw = source.slice(cssStart, source.indexOf(`\n${'`'}`, cssStart))
// The slice carries the literal's own opening line (`const CSS = ` + a backtick),
// which is not CSS; the stylesheet starts after that backtick.
const stylesheet = cssRaw.slice(cssRaw.indexOf('`') + 1).replace(/\/\*[\s\S]*?\*\//g, '')
const registryLines = stylesheet.split('\n').filter(line => line.includes('--rb-'))
const strayColours = stylesheet.split('\n')
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(entry => !entry.line.includes('--rb-'))
  .flatMap(entry => [...entry.line.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)]
    .map(match => `${entry.number}:${match[0]}`))

/* Every top-level rule of the panel stylesheet, as { selector, body }. The rules
 * this block reads are flat, and an at-rule's nested text stays inside its body,
 * so the parse is depth-counted rather than regex-guessed. */
const cssRules = (() => {
  const found = []
  let index = 0
  while (index < stylesheet.length) {
    const open = stylesheet.indexOf('{', index)
    if (open < 0) break
    let depth = 1
    let cursor = open + 1
    while (cursor < stylesheet.length && depth > 0) {
      if (stylesheet[cursor] === '{') depth += 1
      else if (stylesheet[cursor] === '}') depth -= 1
      cursor += 1
    }
    found.push({ selector: stylesheet.slice(index, open).trim(), body: stylesheet.slice(open + 1, cursor - 1) })
    index = cursor
  }
  return found
})()
/**
 * The values one selector declares for one variable: an array, so a duplicate is
 * visible instead of silently collapsed, and empty when the rule or the variable
 * is absent.
 * @param selector the rule's selector text, exactly as written.
 * @param variable the custom property name, including the leading dashes.
 * @returns the declared values, in source order.
 */
const declarationsOf = (selector, variable) => cssRules
  .filter(rule => rule.selector === selector)
  .flatMap(rule => rule.body.split(';'))
  .map(part => part.trim())
  .filter(part => part.startsWith(`${variable}:`))
  .map(part => part.slice(variable.length + 1).trim())
const declaredOnce = (selector, variable) => {
  const values = declarationsOf(selector, variable)
  return values.length === 1 ? values[0] : null
}

// The two arms of the registry, and the two arms of the theme carrier that every
// portaled surface inherits from. `.rb-root` owns the values for its own subtree;
// the carrier repeats them so a Dialog the platform portals outside that subtree
// reads the same colour instead of falling back to currentColor or transparent.
// Both arms of both rules are pinned to their own literals, so a drifted value, a
// dropped declaration, or a variable moved to `:root` fails here.
const ERROR_TINT = 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)'
const ACCENT_ARMS = [
  { registry: '.rb-root', carrier: 'body', accent: '#f06423', soft: 'rgba(240,100,35,.12)', line: 'rgba(240,100,35,.35)', strong: '#ff7733' },
  { registry: 'body:not([data-ds-dark-theme]) .rb-root', carrier: 'body:not([data-ds-dark-theme])', accent: '#c2410c', soft: 'rgba(194,65,12,.10)', line: 'rgba(194,65,12,.35)', strong: '#9a3412' },
]
const ARM_VARIABLES = ['--rb-accent', '--rb-accent-soft', '--rb-accent-line', '--rb-accent-strong']
const readArm = (selector, arm) => ARM_VARIABLES.map(name => `${name}=${String(declaredOnce(selector, name))}`).join(' ')

/* The portal-reachable family, as a name set rather than a hand-written list of
 * per-variable checks: whatever a Dialog portaled outside `.rb-root` consumes
 * must be declared on the carrier, and every variable the registry declares is
 * either in that set or in `NOT_CARRIED`, so adding a registry variable without
 * deciding where it belongs fails here instead of shipping a second portal
 * defect. `NOT_CARRIED` is not a list of oversights: each name has no consumer
 * outside `.rb-root` at all, and the evidence per name is in DESIGN.md 16.5 --
 * the portaled surfaces render none of them (measured, every `rb-*` element of
 * the role dialog, both role form dialogs, the drawer, the template form and the
 * migration dialog), and most have no consumer anywhere in the bundle. */
const PORTAL_REACHABLE = ['--rb-accent', '--rb-accent-soft', '--rb-accent-line', '--rb-accent-strong',
  '--rb-tint-error', '--rb-num']
const NOT_CARRIED = ['--rb-accent-fill', '--rb-on-accent', '--rb-violet', '--rb-violet-soft',
  '--rb-tint-success', '--rb-tint-warn', '--rb-tint-info', '--rb-mono']
/** The variable names one selector declares, in source order and without repeats. */
const declaredNames = (selector) => [...new Set(cssRules.filter(rule => rule.selector === selector)
  .flatMap(rule => [...rule.body.matchAll(/--rb-[a-z0-9-]+(?=\s*:)/g)].map(match => match[0])))]
const sameNameSet = (one, other) => one.length === other.length && one.every(name => other.includes(name))

check('the registry declares the accent family once per theme arm, with that arm\'s own values',
  ACCENT_ARMS.every(arm => declaredOnce(arm.registry, '--rb-accent') === arm.accent
    && declaredOnce(arm.registry, '--rb-accent-soft') === arm.soft
    && declaredOnce(arm.registry, '--rb-accent-line') === arm.line
    && declaredOnce(arm.registry, '--rb-accent-strong') === arm.strong),
  ACCENT_ARMS.map(arm => `${arm.registry}: ${readArm(arm.registry, arm)}`).join(' | '))
check('the registry declares the error tint with the platform\'s own error token, in both arms',
  declaredOnce('.rb-root', '--rb-tint-error') === ERROR_TINT
  && [null, ERROR_TINT].includes(declaredOnce('body:not([data-ds-dark-theme]) .rb-root', '--rb-tint-error')),
  `base=${String(declaredOnce('.rb-root', '--rb-tint-error'))} light=${String(declaredOnce('body:not([data-ds-dark-theme]) .rb-root', '--rb-tint-error'))}`)
check('the theme carrier declares exactly the portal-reachable family, once per arm',
  ACCENT_ARMS.every(arm => sameNameSet(declaredNames(arm.carrier), PORTAL_REACHABLE)
    && PORTAL_REACHABLE.every(name => declarationsOf(arm.carrier, name).length === 1)),
  ACCENT_ARMS.map(arm => `${arm.carrier}: ${declaredNames(arm.carrier).join(' ') || '(none)'}`).join(' | '))
check('every variable the registry declares is either carried or deliberately left out',
  sameNameSet(declaredNames('.rb-root'), [...PORTAL_REACHABLE, ...NOT_CARRIED])
  && ACCENT_ARMS.every(arm => declaredNames(arm.registry).every(name => PORTAL_REACHABLE.includes(name) || NOT_CARRIED.includes(name)))
  && PORTAL_REACHABLE.every(name => !NOT_CARRIED.includes(name)),
  `registry: ${declaredNames('.rb-root').join(' ')}; unclassified: ${declaredNames('.rb-root')
    .filter(name => !PORTAL_REACHABLE.includes(name) && !NOT_CARRIED.includes(name)).join(' ')}`)
const registryValueFor = (arm, name) => (arm.registry === '.rb-root'
  ? declaredOnce('.rb-root', name)
  : (declaredOnce('body:not([data-ds-dark-theme]) .rb-root', name) ?? declaredOnce('.rb-root', name)))
check('each carried variable repeats the value its own arm resolves to in the registry',
  ACCENT_ARMS.every(arm => PORTAL_REACHABLE.every(name => declaredOnce(arm.carrier, name) === registryValueFor(arm, name))),
  ACCENT_ARMS.map(arm => `${arm.carrier}: ${PORTAL_REACHABLE
    .map(name => `${name}=${String(declaredOnce(arm.carrier, name))}`).join(' ')}`).join(' | '))
check('the portaled duty counter reads the carried numeric family',
  /\.rb-duty-count \{[^}]*font-family:var\(--rb-num\)/.test(stylesheet)
  && /\.rb-duty-count \{[^}]*font-variant-numeric:tabular-nums/.test(stylesheet),
  (stylesheet.match(/\.rb-duty-count \{[^}]*\}/) ?? ['(no .rb-duty-count rule)'])[0])
check('no panel variable is declared on :root, which would leak it into every other panel',
  !stylesheet.includes(':root') && cssRules.every(rule => rule.selector !== ':root'),
  cssRules.filter(rule => rule.selector === ':root').map(rule => rule.body.slice(0, 120)).join(' | '))
check('no colour outside the registered variables is written into the stylesheet',
  strayColours.length === 0, strayColours.join(', '))
check('the reading faces keep the concept type scale',
  /\.rb-stat-value \{[^}]*font-size:26px/.test(stylesheet)
  && /\.rb-ring-pct \{[^}]*font-size:14px/.test(stylesheet)
  && stylesheet.includes('--rb-num:var(--dsw-font-family-brand)'))
check('every numeral face is set to tabular figures',
  (stylesheet.match(/font-variant-numeric:tabular-nums/g) ?? []).length >= 3,
  String((stylesheet.match(/font-variant-numeric:tabular-nums/g) ?? []).length))
check('the band keeps the concept proportions',
  /\.rb-stats \{[^}]*grid-template-columns:300px repeat\(5, minmax\(0,1fr\)\) 220px/.test(stylesheet)
  && stylesheet.includes('.rb-stats { display:flex; flex-wrap:wrap; align-items:stretch; }'),
  'the band declares neither the concept columns nor its narrow arm')
check('the completion ring keeps its measured diameter',
  /\.rb-ring \{[^}]*width:56px; height:56px/.test(stylesheet))
check('the two-column body keeps the queue at its measured width',
  /\.rb-list \{[^}]*width:330px/.test(stylesheet))
const propertyOf = (selector, property) => cssRules
  .filter(rule => rule.selector === selector)
  .flatMap(rule => rule.body.split(';'))
  .map(part => part.trim())
  .filter(part => part.startsWith(`${property}:`))
  .map(part => part.slice(property.length + 1).trim())
/* A queue row carries a title, a status badge, a role badge and two buttons. None
 * of those siblings shrinks below its content, so at a narrow panel width a row
 * that cannot wrap overflows its card, its nowrap title collapses to a sliver, and
 * the trailing button squeezes its label onto two lines. */
check('a queue row wraps instead of overflowing, and its title keeps a readable basis',
  propertyOf('.rb-queue-row', 'flex-wrap').includes('wrap')
  && propertyOf('.rb-queue-row', 'row-gap').length === 1
  && propertyOf('.rb-queue-title', 'flex').join(' ') === '1 1 160px',
  `flex-wrap=[${propertyOf('.rb-queue-row', 'flex-wrap').join(' ')}] row-gap=[${propertyOf('.rb-queue-row', 'row-gap').join(' ')}] title flex=[${propertyOf('.rb-queue-title', 'flex').join(' ')}]`)
check('a queue row keeps its badges and buttons at their own width, and never wraps a button label',
  propertyOf('.rb-queue-row > *:not(.rb-queue-title)', 'flex-shrink').join(' ') === '0'
  && propertyOf('.rb-queue-row .rb-btn', 'white-space').join(' ') === 'nowrap',
  `sibling flex-shrink=[${propertyOf('.rb-queue-row > *:not(.rb-queue-title)', 'flex-shrink').join(' ')}] button white-space=[${propertyOf('.rb-queue-row .rb-btn', 'white-space').join(' ')}]`)
check('the meta grid keeps its measured four columns',
  /\.rb-meta-grid \{[^}]*grid-template-columns:repeat\(4, minmax\(0,1fr\)\)/.test(stylesheet))

/* ------------------------------------------------- button stroke coverage */

// Every `h(Button, …)` call must carry the rb-btn marker on the element itself.
// The platform primitive's class names are hashed, and a Dialog portals outside
// .rb-root, so neither a platform class nor a panel subtree scope can reach a
// panel button: the marker is the only thing that can. This scans the shipped
// source, so a button added without it fails here instead of rendering
// unstroked.
const propsOfButtonAt = (start) => {
  const brace = source.indexOf('{', start)
  if (brace < 0) return null
  let depth = 0
  for (let index = brace; index < source.length; index += 1) {
    const character = source[index]
    if (character === `'` || character === `"` || character === '`') {
      const quote = character
      index += 1
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(brace, index + 1)
    }
  }
  return null
}
const buttonClasses = [...source.matchAll(/h\(Button,/g)].map((match) => {
  const props = propsOfButtonAt(match.index)
  const className = props === null ? null : /className\s*:\s*'([^']*)'/.exec(props)
  return {
    line: source.slice(0, match.index).split('\n').length,
    tokens: className === null ? [] : className[1].split(/\s+/).filter(Boolean),
    hasClassName: className !== null,
  }
})
const unmarkedButtons = buttonClasses.filter((site) => !site.tokens.includes('rb-btn'))
check('every Button usage point carries the rb-btn marker class',
  buttonClasses.length >= 79 && unmarkedButtons.length === 0,
  `${buttonClasses.length} sites, unmarked: ${unmarkedButtons.map((site) => site.line).join(', ')}`)
check('no Button declares the marker twice',
  buttonClasses.every((site) => site.tokens.filter((token) => token === 'rb-btn').length === 1))
const padSites = buttonClasses.filter((site) => site.tokens.includes('rb-btn-pad'))
const smSites = buttonClasses.filter((site) => site.tokens.includes('rb-btn-sm'))
const primaryStrokeSites = buttonClasses.filter((site) => site.tokens.includes('rb-btn-primary-stroke'))
// The accent-skinned primary states its own padding, so a pad marker on it would
// leave two equally specific paddings resolving by source order. A danger site
// may legitimately need the marker: the danger arm restates the stroke only, and
// a danger button that was not the outline variant had no stroke before.
check('the geometry bookkeeping never compensates a control that states its own padding',
  padSites.length > 0 && padSites.every((site) => !site.tokens.includes('rb-btn-primary')),
  `${padSites.length} pad-marked; offenders: ${padSites.filter((site) => site.tokens.includes('rb-btn-primary')).map((site) => site.line).join(', ')}`)
check('the stroke-only primary marker excludes the accent-skinned primary',
  primaryStrokeSites.length > 0 && primaryStrokeSites.every((site) => !site.tokens.includes('rb-btn-primary'))
  && smSites.length > 0,
  `${primaryStrokeSites.length} stroke-only primary sites, ${smSites.length} sm sites`)

const ruleOf = (selector) => {
  const index = stylesheet.indexOf(`\n${selector}`)
  return index < 0 ? '' : stylesheet.slice(index + 1, stylesheet.indexOf('}', index) + 1)
}
const buttonRule = ruleOf('.rb-btn.rb-btn {')
check('every panel Button takes a 1px stroke from a registered token',
  /border:1px solid var\(--dsw-alias-border-l3\)/.test(buttonRule)
  && /\.rb-btn\.rb-btn:hover \{[^}]*border-color:var\(--dsw-alias-border-l3\)/.test(stylesheet)
  && /\.rb-btn\.rb-btn:active \{[^}]*border-color:var\(--dsw-alias-border-l3\)/.test(stylesheet)
  && /\.rb-btn\.rb-btn:focus-visible \{[^}]*border-color:var\(--dsw-alias-border-l3\)/.test(stylesheet),
  buttonRule)
check('a disabled Button keeps an opaque neutral stroke through the platform opacity',
  /\.rb-btn\.rb-btn:disabled \{[^}]*border-color:var\(--dsw-alias-label-tertiary\)/.test(stylesheet))
check('the focus-visible arm never takes the focus ring from the platform',
  !/\.rb-btn[^{]*:focus-visible \{[^}]*outline/.test(stylesheet)
  && !/\.rb-btn-primary-stroke[^{]*:focus-visible \{[^}]*outline/.test(stylesheet))
check('the variant arms restate the stroke at a specificity that cannot tie',
  /\.rb-btn-primary\.rb-btn-primary\.rb-btn-primary \{[^}]*border:1px solid var\(--rb-accent-strong\)/.test(stylesheet)
  && /\.rb-btn-danger\.rb-btn-danger\.rb-btn-danger \{[^}]*border:1px solid var\(--dsw-alias-state-error-primary\)/.test(stylesheet)
  && /\.rb-btn-danger\.rb-btn-danger\.rb-btn-danger:disabled \{[^}]*border-color:var\(--dsw-alias-label-tertiary\)/.test(stylesheet))
check('a primary Button that keeps the platform fill takes the stroke but not the accent skin',
  /\.rb-btn-primary-stroke\.rb-btn-primary-stroke \{[^}]*border-color:var\(--rb-accent-strong\)/.test(stylesheet))
check('the detail row keeps the stroke it already had',
  /\.rb-detail-actions \.rb-btn\.rb-btn \{[^}]*border:1px solid var\(--dsw-alias-border-l2\)/.test(stylesheet))
check('the pad arms take the border back out of the horizontal padding',
  /\.rb-btn-pad\.rb-btn-pad \{[^}]*padding:0 13px/.test(stylesheet)
  && /\.rb-btn-pad\.rb-btn-pad\.rb-btn-sm\.rb-btn-sm \{[^}]*padding:0 9px/.test(stylesheet)
  && /\.rb-header \.rb-btn-primary\.rb-btn-primary\.rb-btn-primary \{[^}]*padding:0 12px/.test(stylesheet))
// The theme carrier's carried family is pinned structurally, by selector and
// value, in the visual-language block above (`the theme carrier repeats the
// portal-reachable family once per arm, matching its own arm`). That block
// replaced the literal one-line spelling this check used to require, and it is
// strictly stronger: it reads both arms by their real selectors and pins five
// variables with exactly one declaration each, not one variable by its spacing.
check('non-button controls do not pick up the button stroke',
  ['.rb-chip', '.rb-card', '.rb-node', '.rb-seg'].every((selector) => {
    const escaped = selector.replace('.', '\\.')
    return !new RegExp(`${escaped}[^{]*\\{[^}]*border:1px solid var\\(--dsw-alias-border-l3\\)`).test(stylesheet)
  })
  && stylesheet.includes('.rb-card-selected {') && stylesheet.includes('.rb-node-active {'))

/* --------------------------------------------------------------- teardown */

for (const dispose of disposers.reverse()) dispose()
check('every disposer ran', disposers.length >= 2)
check('disposal closes the SSE stream', FakeEventSource.instances[0].closed === true)
check('the visibility listener was removed', documentStub.listeners.get('visibilitychange')?.length === 0)
check('no page-level key listener is left behind: the Modal primitive owns Escape', documentStub.listeners.get('keydown') === undefined, String(documentStub.listeners.get('keydown')?.length))

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
