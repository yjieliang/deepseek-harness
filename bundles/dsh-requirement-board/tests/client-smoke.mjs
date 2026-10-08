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
    useCallback(callback) {
      hookIndex += 1
      return callback
    },
    useRef(initial) {
      hookIndex += 1
      return { current: initial ?? null }
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

  const Button = ({ variant, size, icon, className, children, ...rest }) =>
    h('button', { ...rest, type: 'button', className }, ...body(icon, children))

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

  const Modal = ({ open, onClose, title, closeLabel, description, children, footer, className, headless = false }) => {
    if (!open) return null
    return h('div', { role: 'presentation', onKeyDownCapture: undefined },
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
    return { status: 200, json: async () => ({ ok: true, data: commandData }) }
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
check('the page renders the filters with visible labels', ['Search', 'Owner', 'Session', 'Status', 'Priority', 'Role', 'Kind', 'Only claimable', 'Session (me)'].every(label => page.html.includes(label)), page.html.slice(0, 0) || 'a filter label is missing')
check('the role filter is an ordinary host filter, with no local narrowing tag',
  !page.collected.some(element => String(element.props?.className ?? '').includes('rb-local-tag'))
  && !page.collected.some(element => String(element.props?.title ?? '').includes('no role filter yet')),
  page.html.slice(0, 0) || 'a local narrowing tag survived')

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
const again = renderPage()
again.findButton('新建需求').props.onClick()
const createDialog = renderPage()
check('the create dialog renders its fields', createDialog.html.includes('标题') && createDialog.html.includes('流程模板') && createDialog.html.includes('所属会话'))
check('the create dialog lists the templates', createDialog.html.includes('标准研发流程'))
check('an empty title disables the create action', createDialog.collected.some(element => element.html === '创建' && element.props.disabled === true))
const titleInput = createDialog.findInput(props => props.name === 'requirement.title')
titleInput.props.onChange({ target: { value: '新需求' } })
const filledDialog = renderPage()
check('a filled title enables the create action', filledDialog.collected.some(element => element.html === '创建' && element.props.disabled === false))
const prioritySelect = filledDialog.findInput(props => props.name === 'requirement.priority')
prioritySelect.props.onChange({ target: { value: 'urgent' } })
const submit = renderPage().findButton('创建')
submit.props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))
const createCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body))
  .find(body => body.action === 'create')
check('submitting the form posts the create command', createCall?.requirement?.title === '新需求', JSON.stringify(createCall?.requirement))
check('the form carries every edited field', createCall?.requirement?.priority === 'urgent' && Array.isArray(createCall?.requirement?.sessions) && createCall?.requirement?.templateId === 'tpl-standard', JSON.stringify(createCall?.requirement))
check('the dialog closes after a successful create', renderPage().html.includes('模板名称') === false)

// The template dialog parses its node lines into a node declaration list.
renderPage().findButton('新建流程模板').props.onClick()
const templateDialog = renderPage()
check('the template dialog renders its node hint', templateDialog.html.includes('每行一个节点'))
const nodesArea = templateDialog.findInput(props => props.name === 'template.nodes')
nodesArea.props.onChange({ target: { value: '需求评审 | 张三 | 范围明确;干系人确认\n方案设计 | 李四\n开发实现' } })
const templateName = renderPage().findInput(props => props.name === 'template.name')
templateName.props.onChange({ target: { value: '三段流程' } })
const templatePreview = renderPage()
check('the template dialog previews the parsed nodes', templatePreview.html.includes('3 个节点') && templatePreview.html.includes('需求评审 → 方案设计 → 开发实现'))
templatePreview.findButton('创建').props.onClick()
await new Promise(resolve => setTimeout(resolve, 0))
await new Promise(resolve => setTimeout(resolve, 0))
const templateCall = requests.filter(request => String(request.url).includes('/command'))
  .map(request => JSON.parse(request.init.body))
  .find(body => body.action === 'template.create')
check('the template dialog posts parsed nodes', templateCall?.template?.nodes?.length === 3, JSON.stringify(templateCall?.template))
check('a checklist node keeps its checklist', templateCall?.template?.nodes?.[0]?.completion?.checklist?.length === 2)

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
  const pageWithFilter = renderPage()
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
check('the human inbox is offered by the role filter',
  renderPage().collected.some(element => element.type === 'option' && element.props.value === 'human'))
check('the role filter no longer offers the unexpressible "no role" value',
  !renderPage().collected.some(element => element.type === 'option' && String(element.props.value).includes('\u0000')))
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

boundLocale = 'zh'
snapshotPayload = boardSnapshot()
await face.refresh()
await settle()
renderPage().findButton('角色管理').props.onClick()
const rolesDialog = renderPage()
check('the role dialog lists a role with its duties', rolesDialog.html.includes('美术') && rolesDialog.html.includes('资产规范'))
check('a temporary role shows what delegation bound it to',
  rolesDialog.html.includes('临时') && rolesDialog.html.includes('绑定会话') && rolesDialog.html.includes('ses_sub') && rolesDialog.html.includes('绑定任务'))
check('a role without duties is highlighted', rolesDialog.html.includes('没有登记职能'))
check('an id in use but unrecorded is listed', rolesDialog.html.includes('在用但未登记') && rolesDialog.html.includes('未登记'))
check('the role dialog states presence in two forms and drops the derived idle count', (() => {
  const html = rolesDialog.html
  return html.includes('2 人在线 · 1 执行中') && html.includes('暂无人在线') && html.includes('个未完成') && !html.includes('空闲 0')
})())
check('a temporary role offers no edit or delete', (() => {
  const rows = rolesDialog.collected.filter(element => String(element.props.className ?? '').includes('rb-role-row'))
  const temporary = rows.find(row => row.html.includes('临时'))
  return temporary !== undefined && !temporary.html.includes('编辑') && !temporary.html.includes('删除角色')
})())

rolesDialog.buttons.find(element => String(element.props.name ?? '').startsWith('role.edit.')).props.onClick()
const editForm = renderPage()
check('the role editor pins the id and loads its duties', editForm.collected.some(element => element.type === 'input'
  && element.props.name === 'role.roleId' && element.props.value === 'art' && element.props.disabled === true))
editForm.findInput(props => props.name === 'role.roleName').props.onChange({ target: { value: '美术组' } })
renderPage().findInput(props => props.name === 'role.duties').props.onChange({ target: { value: '资产规范, 合规清单' } })
renderPage().buttons.find(element => element.props.name === 'role.save').props.onClick()
await settle()
const putCall = commandBodies().find(body => body.action === 'role.put')
check('saving posts role.put with the parsed duties',
  putCall?.role?.roleId === 'art' && putCall?.role?.roleName === '美术组' && putCall?.role?.duties?.length === 2, JSON.stringify(putCall?.role))

renderPage().buttons.find(element => String(element.props.name ?? '').startsWith('role.remove.')).props.onClick()
const confirmRole = renderPage()
check('deleting a role asks for confirmation first', confirmRole.html.includes('删除该角色？'))
confirmRole.buttons.find(element => element.html === localeDicts.zh.confirm).props.onClick()
await settle()
const deleteCall = commandBodies().find(body => body.action === 'role.delete')
check('confirming a role deletion posts role.delete', deleteCall?.id === 'art', JSON.stringify(deleteCall))
renderPage().findButton('关闭').props.onClick()
check('the role dialog closes again', !renderPage().html.includes('新建角色'))

snapshotPayload = boardSnapshot({ roles: { items: [], unregistered: [] } })
await face.refresh()
await settle()
renderPage().findButton('角色管理').props.onClick()
check('an empty role table renders its empty state', renderPage().html.includes('还没有登记任何角色'))
renderPage().findButton('关闭').props.onClick()
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
check('a decision shows who asked for the call', decisionDetail.html.includes(`${localeDicts.zh.requestedBy}: ses_A`))
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
  raisedDetail.html.includes(`${localeDicts.zh.ownPriority}: ${localeDicts.zh.priorityNormal}`)
  && raisedDetail.html.includes(`${localeDicts.zh.effectivePriority}: urgent↑`),
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
  !blockedDetail.html.includes(localeDicts.zh.effectivePriority)
  && blockedDetail.html.includes(`${localeDicts.zh.ownPriority}: ${localeDicts.zh.priorityUrgent}`),
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

/* --------------------------------------------------------------- teardown */

for (const dispose of disposers.reverse()) dispose()
check('every disposer ran', disposers.length >= 2)
check('disposal closes the SSE stream', FakeEventSource.instances[0].closed === true)
check('the visibility listener was removed', documentStub.listeners.get('visibilitychange')?.length === 0)
check('no page-level key listener is left behind: the Modal primitive owns Escape', documentStub.listeners.get('keydown') === undefined, String(documentStub.listeners.get('keydown')?.length))

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
