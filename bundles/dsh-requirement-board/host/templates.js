/**
 * Flow templates: the built-in standard template, input normalization, and the
 * structural invariants every stored template satisfies (unique node ids,
 * acyclic `dependsOn`, `order` matching array position).
 */

import { COMPLETION_TYPES, asBoolean, asEnum, asString, asStringArray, fail, nowIso } from './model.js'

/**
 * The template a fresh store starts with. Node ids are stable slugs so that a
 * requirement bound to it keeps its references across upgrades.
 */
export const STANDARD_TEMPLATE = {
  id: 'tpl-standard',
  name: '标准研发流程',
  description: '评审 → 设计 → 实现 → 验证 → 发布',
  version: 1,
  builtin: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  nodes: [
    {
      id: 'review',
      name: '需求评审',
      order: 0,
      dependsOn: [],
      assignee: '',
      description: '确认范围、验收标准与相关方。',
      completion: { type: 'checklist', checklist: ['范围与验收标准已明确', '相关方已确认'], requireNote: false },
    },
    {
      id: 'design',
      name: '方案设计',
      order: 1,
      dependsOn: ['review'],
      assignee: '',
      description: '给出可执行的技术或产品方案。',
      completion: { type: 'manual', checklist: [], requireNote: true },
    },
    {
      id: 'build',
      name: '开发实现',
      order: 2,
      dependsOn: ['design'],
      assignee: '',
      description: '完成实现并自测通过。',
      completion: { type: 'manual', checklist: [], requireNote: false },
    },
    {
      id: 'verify',
      name: '测试验证',
      order: 3,
      dependsOn: ['build'],
      assignee: '',
      description: '执行用例并关闭缺陷。',
      completion: { type: 'checklist', checklist: ['用例执行完成', '遗留缺陷已关闭'], requireNote: false },
    },
    {
      id: 'release',
      name: '发布上线',
      order: 4,
      dependsOn: ['verify'],
      assignee: '',
      description: '产出发布物并完成上线确认。',
      completion: { type: 'manual', checklist: [], requireNote: true },
    },
  ],
}

/** Characters allowed in a derived node id. */
const SLUG_STRIP = /[^a-z0-9\u4e00-\u9fa5]+/g

/**
 * Derive a stable node id from a display name.
 *
 * Separators collapse to `-`; CJK characters are kept, because they are usable
 * in an id and keep a hand-written `dependsOn` readable.
 *
 * @param name - Node display name.
 * @param taken - Ids already used by earlier nodes.
 * @returns a unique id.
 */
function nodeIdFrom(name, taken) {
  const base = name.trim().toLowerCase().replace(SLUG_STRIP, '-').replace(/^-+|-+$/g, '') || 'node'
  if (!taken.has(base)) return base
  let index = 2
  while (taken.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

/**
 * Normalize one node declaration from an untrusted boundary.
 * @param raw - Caller-supplied node object or a display-name string.
 * @param index - Position in the declared list; becomes `order`.
 * @param taken - Node ids already claimed by earlier entries.
 * @returns the normalized node.
 */
function normalizeNode(raw, index, taken) {
  const source = typeof raw === 'string' ? { name: raw } : raw
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    fail('invalid-argument', `"nodes[${index}]" must be an object or a node name`)
  }
  const name = asString(source.name, `nodes[${index}].name`, { required: true, max: 120 })
  const id = source.id === undefined || source.id === null
    ? nodeIdFrom(name, taken)
    : asString(source.id, `nodes[${index}].id`, { required: true, max: 64 })
  if (taken.has(id)) fail('invalid-argument', `duplicate node id "${id}"`)
  taken.add(id)
  const completion = source.completion ?? {}
  if (completion === null || typeof completion !== 'object' || Array.isArray(completion)) {
    fail('invalid-argument', `"nodes[${index}].completion" must be an object`)
  }
  const type = asEnum(completion.type, COMPLETION_TYPES, `nodes[${index}].completion.type`, 'manual')
  const checklist = asStringArray(completion.checklist, `nodes[${index}].completion.checklist`, { max: 20, itemMax: 160 })
  return {
    id,
    name,
    order: index,
    dependsOn: asStringArray(source.dependsOn, `nodes[${index}].dependsOn`, { max: 20, itemMax: 64 }),
    assignee: asString(source.assignee, `nodes[${index}].assignee`, { max: 120 }),
    description: asString(source.description, `nodes[${index}].description`, { max: 600 }),
    completion: {
      type,
      checklist: type === 'checklist' ? checklist : [],
      requireNote: asBoolean(completion.requireNote, `nodes[${index}].completion.requireNote`, false),
    },
  }
}

/**
 * Normalize a template declaration from an untrusted boundary and enforce its
 * structural invariants.
 * @param input - Caller-supplied template object.
 * @param options - `id`, `builtin`, and the `now` instant.
 * @returns the normalized template record.
 */
export function normalizeTemplate(input, { id, builtin = false, now = nowIso() } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid-argument', 'template must be an object')
  }
  const name = asString(input.name, 'name', { required: true, max: 120 })
  const rawNodes = input.nodes
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    fail('invalid-argument', 'template "nodes" must be a non-empty array')
  }
  if (rawNodes.length > 50) fail('invalid-argument', 'template "nodes" must hold at most 50 entries')
  const taken = new Set()
  const nodes = rawNodes.map((raw, index) => normalizeNode(raw, index, taken))
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!taken.has(dependency)) {
        fail('invalid-argument', `node "${node.id}" depends on unknown node "${dependency}"`, { known: [...taken] })
      }
      if (dependency === node.id) fail('invalid-argument', `node "${node.id}" must not depend on itself`)
    }
  }
  assertAcyclic(nodes)
  return {
    id,
    name,
    description: asString(input.description, 'description', { max: 600 }),
    version: 1,
    builtin,
    createdAt: asString(input.createdAt, 'createdAt', { max: 40 }) || now,
    updatedAt: now,
    nodes,
  }
}

/**
 * Reject a `dependsOn` graph containing a cycle.
 * @param nodes - Normalized nodes in declaration order.
 */
function assertAcyclic(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const state = new Map()
  const visit = (id, trail) => {
    const mark = state.get(id)
    if (mark === 'done') return
    if (mark === 'open') fail('invalid-argument', `node dependency cycle: ${[...trail, id].join(' -> ')}`)
    state.set(id, 'open')
    for (const next of byId.get(id)?.dependsOn ?? []) visit(next, [...trail, id])
    state.set(id, 'done')
  }
  for (const node of nodes) visit(node.id, [])
}

/**
 * Whether every declared prerequisite of `nodeId` is finished on `requirement`.
 * @param template - Bound template.
 * @param requirement - Requirement holding derived node states.
 * @param nodeId - Node being entered.
 * @returns `{ ok }` or `{ ok: false, missing }` naming unfinished prerequisites.
 */
export function dependenciesMet(template, requirement, nodeId) {
  const node = template.nodes.find(candidate => candidate.id === nodeId)
  if (node === undefined) return { ok: false, missing: [nodeId] }
  const missing = node.dependsOn.filter(dependency => requirement.nodes?.[dependency]?.status !== 'done')
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

/**
 * The next node after `nodeId` in declaration order.
 * @param template - Bound template.
 * @param nodeId - Current node.
 * @returns the next node, or `undefined` when the current node is the last.
 */
export function nextNodeId(template, nodeId) {
  const index = template.nodes.findIndex(node => node.id === nodeId)
  if (index < 0 || index + 1 >= template.nodes.length) return undefined
  return template.nodes[index + 1].id
}

/**
 * Index of a node in declaration order.
 * @param template - Bound template.
 * @param nodeId - Node to locate.
 * @returns the index, or `-1` when the node is not part of the template.
 */
export function nodeIndex(template, nodeId) {
  return template.nodes.findIndex(node => node.id === nodeId)
}
