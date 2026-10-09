#!/usr/bin/env node
/**
 * Task-26 §A instrument: every `file:line` reference in the stage-G documents,
 * checked mechanically (the file exists, the line is inside it, the line is not
 * blank), plus a curated table of load-bearing anchors whose referenced text
 * must still say what the document claims.
 *
 * Modes (argv[2]):
 *   extract   full mechanical inventory (default)
 *   semantic  only the curated load-bearing table
 *   all       both
 *
 * Overrides (for the red controls, so a mutated copy can be checked without
 * touching the tree):
 *   G_DOC_DIR  directory holding the documents (default: the artifact root)
 *   G_ROOT     tree root the anchors resolve against (default: the artifact root)
 *
 * The instrument never writes anything: it prints a table and exits non-zero
 * when a mechanical check or a curated expectation fails.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')
const DOC_DIR = resolve(process.env.G_DOC_DIR ?? DEFAULT_ROOT)
const ROOT = resolve(process.env.G_ROOT ?? DEFAULT_ROOT)
const REPO = resolve(process.env.G_REPO ?? resolve(ROOT, '..', '..'))
const SKILL = join(REPO, '.agents', 'skills', 'requirement-board-tasks')
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const MODE = process.argv[2] ?? 'extract'

/** Documents under review (task-26 §A names the first four; the checklist is included too). */
const DOCS = ['ROLE-DISPATCH.md', 'DESIGN.md', 'README.md', 'OPTIMIZATION.md', 'G-CHECKLIST.md']

let failures = 0
let checks = 0
let warnings = 0

/** Record one mechanical verdict. */
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  return false
}

/** Record a soft verdict (line-number drift with correct content nearby). */
function warn(label, detail) {
  warnings += 1
  console.log(`  warn ${label} — ${detail}`)
}

/** Repository source files, searched for a partial path such as `subagent/src/types.ts`. */
function repoIndex() {
  if (repoIndex.cache !== undefined) return repoIndex.cache
  const found = []
  const walk = (dir, depth) => {
    if (depth > 7) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (/\.(ts|tsx|js|mjs|json|ya?ml)$/.test(entry.name)) found.push(full)
    }
  }
  for (const sub of ['packages', '.agents', 'apps', 'docs', 'scripts', 'vendor']) walk(join(REPO, sub), 0)
  repoIndex.cache = found
  return found
}

/**
 * A bare filename such as `registry.spec.ts` resolves to the full path the same
 * document spells out elsewhere (the prose cites the package path once and then
 * the bare basename).
 */
function contextTargets(path, docText) {
  const base = path.split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tokens = new Set()
  for (const match of docText.matchAll(new RegExp(`([A-Za-z0-9_./@-]+/${base})`, 'g'))) tokens.add(match[1])
  return [...tokens].map(token => join(REPO, token)).filter(file => existsSync(file) && statSync(file).isFile())
}

/**
 * Resolve an anchor target: inside the plugin tree first, then the repository,
 * then the skill directory, then the deployment (`~/.dsh/**`). A partial
 * reference such as `subagent/src/types.ts` resolves by unique suffix, and a
 * bare filename first tries the path the same document spells out.
 */
function resolveTarget(path, docText = '') {
  const trimmed = path.replace(/^~/, '')
  const direct = [
    [join(ROOT, trimmed), 'plugin'],
    [join(ROOT, 'host', trimmed), 'plugin'],
    [join(ROOT, 'tests', trimmed), 'plugin'],
    [join(REPO, trimmed), 'repo'],
    [join(SKILL, trimmed), 'skill'],
    [join(SKILL, 'references', trimmed), 'skill'],
    [join(HOME, trimmed), 'deployment'],
  ]
  for (const [candidate, kind] of direct) if (existsSync(candidate) && statSync(candidate).isFile()) return { file: candidate, kind }
  if (!trimmed.includes('/')) {
    const contextual = contextTargets(trimmed, docText)
    if (contextual.length > 0) {
      contextual.sort((a, b) => a.length - b.length)
      return { file: contextual[0], kind: contextual.length === 1 ? 'doc-context' : `doc-context-ambiguous(${contextual.length})` }
    }
  }
  const suffix = trimmed.split('/').filter(Boolean).join('/')
  const matches = repoIndex().filter(entry => entry.replace(/\\/g, '/').endsWith(`/${suffix}`))
  if (matches.length > 0) {
    matches.sort((a, b) => a.length - b.length)
    return { file: matches[0], kind: matches.length === 1 ? 'repo-suffix' : `repo-suffix-ambiguous(${matches.length})` }
  }
  return null
}

/** Every anchor with a colon or `#L` line reference, and every `file N 行` form. */
function anchorsIn(text) {
  const found = []
  const colon = /(?<![A-Za-z0-9_./-])([A-Za-z0-9_./@-]+\.(?:js|mjs|json|md|yml|yaml|ts|tsx|css|svg))[:#]L?(\d+)(?:\s*[-–~]\s*L?(\d+))?/g
  for (const match of text.matchAll(colon)) found.push({ path: match[1], from: Number(match[2]), to: Number(match[3] ?? match[2]), form: 'colon' })
  const trailing = /(?<![A-Za-z0-9_./-])([A-Za-z0-9_./@-]+\.(?:js|mjs|json|md|yml|yaml|ts|tsx|css|svg))[`\s(]{1,4}(\d+)(?:\s*[-–~]\s*(\d+))?\s*行/g
  for (const match of text.matchAll(trailing)) found.push({ path: match[1], from: Number(match[2]), to: Number(match[3] ?? match[2]), form: 'lines' })
  return found
}

const docs = DOCS.filter(name => existsSync(join(DOC_DIR, name)))

if (MODE === 'extract' || MODE === 'all') {
  console.log(`\n[A1] every anchor in ${docs.length} documents (doc dir ${relative(process.cwd(), DOC_DIR) || '.'})`)
  const seen = new Map()
  const docTexts = new Map()
  let total = 0
  for (const name of docs) {
    const text = readFileSync(join(DOC_DIR, name), 'utf8')
    const lines = text.split('\n')
    docTexts.set(name, text)
    const headings = []
    lines.forEach((line, index) => {
      const heading = /^#{1,4}\s+(.*)$/.exec(line)
      if (heading !== null) headings.push({ line: index + 1, title: heading[1].trim() })
    })
    const sectionOf = line => {
      let title = ''
      for (const heading of headings) {
        if (heading.line <= line) title = heading.title
        else break
      }
      return title.split('：')[0].split('—')[0].trim()
    }
    for (const anchor of anchorsIn(text)) {
      total += 1
      const key = `${name}|${anchor.path}|${anchor.from}|${anchor.to}`
      if (!seen.has(key)) seen.set(key, { ...anchor, doc: name, sections: new Set([sectionOf(anchor.from)]) })
      else seen.get(key).sections.add(sectionOf(anchor.from))
    }
    console.log(`  ${name}: ${lines.length} lines, ${anchorsIn(text).length} anchor occurrences`)
  }
  console.log(`  ${total} occurrences, ${seen.size} distinct anchors`)
  let unresolved = 0
  let outOfBounds = 0
  let blank = 0
  let ok = 0
  let ambiguous = 0
  const kinds = new Map()
  for (const anchor of [...seen.values()].sort((a, b) => a.doc.localeCompare(b.doc) || a.path.localeCompare(b.path) || a.from - b.from)) {
    const label = `${anchor.path}:${anchor.from}${anchor.to === anchor.from ? '' : `-${anchor.to}`}`
    const section = [...anchor.sections].filter(Boolean).join('/')
    const target = resolveTarget(anchor.path, docTexts.get(anchor.doc) ?? '')
    if (target === null) {
      unresolved += 1
      console.log(`  FAIL ${anchor.doc} ${section} -> ${label} — file not found in the plugin tree, the repository, the skill or the deployment`)
      continue
    }
    kinds.set(target.kind, (kinds.get(target.kind) ?? 0) + 1)
    const unsure = target.kind.includes('ambiguous')
    if (unsure) ambiguous += 1
    const lines = readFileSync(target.file, 'utf8').split('\n')
    if (anchor.from < 1 || anchor.to > lines.length || anchor.to < anchor.from) {
      outOfBounds += 1
      console.log(`  FAIL ${anchor.doc} ${section} -> ${label} [${target.kind}] — outside 1..${lines.length} (${relative(REPO, target.file)})`)
      continue
    }
    const excerpt = lines.slice(anchor.from - 1, anchor.to).join(' ').trim()
    if (excerpt === '') {
      blank += 1
      console.log(`  FAIL ${anchor.doc} ${section} -> ${label} [${target.kind}] — blank line`)
      continue
    }
    ok += 1
    const prefix = unsure ? 'warn' : 'ok  '
    console.log(`  ${prefix} ${anchor.doc} ${section} -> ${label} [${target.kind}] — ${excerpt.slice(0, 92)}`)
  }
  console.log(`  resolved=${ok} unresolved-file=${unresolved} out-of-bounds=${outOfBounds} blank=${blank} ambiguous=${ambiguous}`)
  console.log(`  target classes: ${[...kinds.entries()].map(([kind, count]) => `${kind}=${count}`).join(' ')}`)
  check('every referenced file exists', unresolved === 0, `${unresolved} unresolved`)
  check('every referenced line range is in bounds', outOfBounds === 0, `${outOfBounds} out of bounds`)
  check('no anchor points at a blank line', blank === 0, `${blank} blank`)
}

/**
 * Load-bearing anchors: the document sentence is the claim, `expect` is the text
 * the referenced range (or file) must still contain. Each row is one semantic
 * check. A row with `from`/`to` is checked inside that range only; a row with
 * `files` is checked across each listed file.
 */
const LOAD_BEARING = [
  // §4.4 / §4.5 the two canonical formulas
  { doc: 'ROLE-DISPATCH.md', path: 'host/dispatch.js', from: 208, to: 245, expect: /advanceable/, why: '§4.4 正典公式落点' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/dispatch.js', from: 86, to: 116, expect: /claimable/, why: '§4.5 claimable 单一公式' },
  // §5.3 release path, queue view and lockState
  { doc: 'ROLE-DISPATCH.md', path: 'host/dispatch.js', from: 322, to: 340, expect: /lockState/, why: '§5.3 释放路径判定' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 3669, to: 3676, expect: /#queueView/, why: '§5.3 队列视图（#queueView）' },
  // §5.5 attribution ports, dispatch and truncation
  { doc: 'ROLE-DISPATCH.md', path: 'index.js', from: 112, to: 118, expect: /createOwnershipPort/, why: '§5.5 归属端口' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 1924, to: 1930, expect: /async delegate/, why: '§5.5 派发入口' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 1869, to: 2871, expect: /#settleDelegation/, why: '§13.3 委托结算' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/runs.js', from: 230, to: 243, expect: /truncated/, why: '§5.5 条数截断' },
  { doc: 'ROLE-DISPATCH.md', path: 'packages/subagent/subagent/src/lifecycle.ts', from: 134, to: 163, expect: /observeRun/, why: '§3.1 生命周期（歧义裁定为 subagent）' },
  // §5.6 tool surface
  { doc: 'ROLE-DISPATCH.md', path: 'host/tools.js', from: 201, to: 206, expect: /case 'get'/, why: '§5.6 工具动作面' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/tools.js', expect: /requirement_board/, why: '§5.6 requirement_board 工具' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/tools.js', expect: /flow_template/, why: '§5.6 flow_template 工具' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/tools.js', expect: /requirement_role/, why: '§5.6 requirement_role 工具' },
  // §5.7 refusal decomposition
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 2165, to: 2195, expect: /decision|human/i, why: '§5.7 决策人类专属拒绝' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 2335, to: 2341, expect: /#assertOwnedTarget/, why: '§5.7 归属分解' },
  { doc: 'ROLE-DISPATCH.md', path: 'tests/decision.mjs', from: 201, to: 254, expect: /six actions|decision/i, why: '§5.7 决策六动作用例' },
  { doc: 'ROLE-DISPATCH.md', path: 'tests/delegate.mjs', from: 704, to: 708, expect: /ownership/, why: '§8 归属拒绝用例' },
  // §5.9 statistics and the critical path
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 3530, to: 3546, expect: /stats\(/, why: '§5.9 stats' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 3557, to: 3573, expect: /criticalPath/, why: '§5.9 criticalPath' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 3704, to: 3712, expect: /high/, why: '§5.9 [high↑] 升级标记' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', expect: /changesSince/, why: '§5.9 changesSince' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', expect: /snapshot\(/, why: '§8.1 snapshot' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 772, to: 780, expect: /executions/, why: '§8.1 presented.executions' },
  // §6 prompt sections in the documented order
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 3598, to: 3775, expect: /promptContext/, why: '§6 prompt 组装' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 3672, to: 3775, expect: /Delegated to you/, why: '§6 段 1 Delegated to you' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 3691, to: 3865, expect: /Claimable for you/, why: '§6 段 2 Claimable for you' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 3691, to: 3865, expect: /Your queue/, why: '§6 段 3 Your queue' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 3691, to: 3865, expect: /Executing now/, why: '§6 段 4 Executing now' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 3691, to: 3865, expect: /Waiting on the human/, why: '§6 段 5 Waiting on the human' },
  // §8.1 endpoints, handler and the panel command surface
  { doc: 'ROLE-DISPATCH.md', path: 'host/http.js', expect: /ENDPOINTS/, why: '§8.1 端点表' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/http.js', expect: /ROUTE_PREFIX/, why: '§8.1 路由前缀' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/http.js', from: 355, to: 442, expect: /createBoardHandler/, why: '§8.1 处理器' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/http.js', from: 271, to: 337, expect: /case 'delete'/, why: '§8.1 command 分发面' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/http.js', from: 225, to: 337, expect: /case 'stats'/, why: '§8.1 面板动作穷举' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/http.js', from: 239, to: 245, expect: /force/, why: '§8.1 transition 参数' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/http.js', from: 79, to: 79, expect: /MAX_BODY_BYTES/, why: '§8.2 256 KiB 上界' },
  // §8.1 / §8.2 the panel has no claim/queue, and that is reported as unknown action
  { doc: 'ROLE-DISPATCH.md', path: 'host/http.js', expect: /unknown action/, why: '§8.2 面板未知动作措辞' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/http.js', expect: /case 'unqueue'/, why: '§8.1 面板可清预留' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/http.js', from: 1, expect: /case 'claim'/, absent: true, why: '§8.1 面板无 claim（否定式）' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/http.js', from: 1, expect: /case 'queue'/, absent: true, why: '§8.1 面板无 queue（否定式）' },
  // §5.12 / §4.2 config volume and the immutable kind
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 2557, to: 2563, expect: /kind/, why: '§4.2 kind 不可变' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/config.js', expect: /sseCoalesceMs|executionSync/, why: '§5.12 配置边界' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/model.js', from: 46, to: 46, expect: /EXEC_STATUSES/, why: '§5.5 执行状态闭集' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/domain.js', from: 47, to: 48, expect: /UNIT_NAME_RE/, why: '§1.1 域名闭集' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/domain.js', from: 119, to: 129, expect: /delegatedTo/, why: '§2.4 委托归属' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/flow.js', from: 253, to: 265, expect: /setChecklistEntry/, why: '§4.3 检查项写入' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/roles.js', from: 99, to: 116, expect: /resolveOwn/, why: '§2.1 两级解析' },
  { doc: 'ROLE-DISPATCH.md', path: 'cordis.patch.yml', from: 7, to: 31, expect: /requirement_board|config/, why: '装载清单行' },
  { doc: 'ROLE-DISPATCH.md', path: 'dev.overlay.yml', from: 20, to: 31, expect: /requirement_board/, why: '§1.1 路由键' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/model.js', expect: /REQ_KINDS/, why: '§4 记录字段' },
  { doc: 'ROLE-DISPATCH.md', path: 'role.js', expect: /requirementBoardRole/, why: '§5.6 预设侧角色声明' },
  // drift points that were exposed during the stage
  { doc: 'ROLE-DISPATCH.md', path: 'host/domain.js', from: 619, to: 625, expect: /unsupported-legacy-version/, why: '漂移点：unsupported-legacy-version 实际位置' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/domain.js', from: 360, to: 395, expect: /openBoardDomain/, why: '漂移点：invalid-record 诊断包装' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/domain.js', from: 60, to: 78, expect: /stored .* is not one of/, why: '漂移点：storedEnum 字段点名' },
  { doc: 'ROLE-DISPATCH.md', path: 'host/service.js', from: 3506, to: 3520, expect: /byKind/, why: '漂移点：byKind 闭集派生' },
  { doc: 'ROLE-DISPATCH.md', path: 'packages/bundle/base/cordis.patch.yml', from: 370, to: 380, expect: /backgroundMode: continuable/, why: '漂移点：continuable 实际来源（bundle）' },
  { doc: 'ROLE-DISPATCH.md', path: 'packages/bundle/web-app/cordis.patch.yml', from: 178, to: 186, expect: /webStartup\.port/, why: '漂移点：端口默认实际来源（bundle）' },
  // DESIGN module table: each row names its file and its responsibility
  { doc: 'DESIGN.md', path: 'index.js', expect: /inject/, why: 'DESIGN：Host 插件入口' },
  { doc: 'DESIGN.md', path: 'host/model.js', expect: /BoardError|fail\(/, why: 'DESIGN：领域常量与校验' },
  { doc: 'DESIGN.md', path: 'host/config.js', expect: /resolveConfig/, why: 'DESIGN：配置边界' },
  { doc: 'DESIGN.md', path: 'host/domain.js', expect: /requirementBoardDomain/, why: 'DESIGN：持久化表单' },
  { doc: 'DESIGN.md', path: 'host/templates.js', expect: /template/i, why: 'DESIGN：流程模板' },
  { doc: 'DESIGN.md', path: 'host/flow.js', expect: /computeStats/, why: 'DESIGN：流程引擎' },
  { doc: 'DESIGN.md', path: 'host/dispatch.js', expect: /advanceable/, why: 'DESIGN：判定与派生' },
  { doc: 'DESIGN.md', path: 'host/runs.js', expect: /executionGateDecision|attributeExecution/, why: 'DESIGN：执行同步' },
  { doc: 'DESIGN.md', path: 'host/roles.js', expect: /resolveOwn|promptLine/, why: 'DESIGN：角色注册表' },
  { doc: 'DESIGN.md', path: 'host/service.js', expect: /class RequirementService/, why: 'DESIGN：业务服务' },
  { doc: 'DESIGN.md', path: 'host/http.js', expect: /createBoardHandler/, why: 'DESIGN：浏览器传输层' },
  { doc: 'DESIGN.md', path: 'host/tools.js', expect: /requirement_board/, why: 'DESIGN：Agent 工具' },
  { doc: 'DESIGN.md', path: 'client.js', expect: /FlowChart|NodeDetail|StatsStrip/, why: 'DESIGN：浏览器半边' },
  { doc: 'DESIGN.md', path: 'role.js', expect: /requirementBoardRole/, why: 'DESIGN：预设侧入口' },
  { doc: 'DESIGN.md', path: 'cordis.patch.yml', expect: /requirement-board/, why: 'DESIGN：装载清单' },
  // README: the command surface, the endpoint table and the config keys
  { doc: 'README.md', path: 'host/http.js', expect: /ENDPOINTS/, why: 'README：HTTP 端点表' },
  { doc: 'README.md', path: 'host/domain.js', expect: /requirement_board|bootstrap/, why: 'README：存储与导入' },
  { doc: 'README.md', path: 'host/service.js', expect: /class RequirementService/, why: 'README：业务服务' },
  { doc: 'README.md', path: 'host/tools.js', expect: /requirement_board/, why: 'README：面板与工具' },
  { doc: 'README.md', path: 'client.js', expect: /render|panel/i, why: 'README：浏览器半边' },
  { doc: 'README.md', path: 'host/config.js', expect: /resolveConfig/, why: 'README：配置解析' },
  { doc: 'README.md', path: 'cordis.patch.yml', expect: /requirement-board/, why: 'README：composition 行' },
  // OPTIMIZATION: the E-stage surface it argues about
  { doc: 'OPTIMIZATION.md', path: 'host/service.js', expect: /execution|coalesc|sync/i, why: 'OPTIMIZATION：执行同步' },
  { doc: 'OPTIMIZATION.md', path: 'host/runs.js', expect: /export/, why: 'OPTIMIZATION：纯函数模块' },
  { doc: 'OPTIMIZATION.md', path: 'host/config.js', expect: /sseCoalesceMs|executionSync|maxExecutions/, why: 'OPTIMIZATION：配置' },
  { doc: 'OPTIMIZATION.md', path: 'host/http.js', expect: /requestRejection|originAllowed/, why: 'OPTIMIZATION：信任门' },
  { doc: 'OPTIMIZATION.md', path: 'client.js', expect: /render|panel/i, why: 'OPTIMIZATION：面板' },
  { doc: 'OPTIMIZATION.md', path: 'tests/harness.mjs', expect: /export/, why: 'OPTIMIZATION：测试夹具' },
]

/* Families: one row per documented vocabulary item, so a renamed action, config
 * key or failure code fails loud instead of silently disappearing from the docs. */
const ACTIONS_18 = ['list', 'get', 'create', 'update', 'claim', 'release', 'queue', 'unqueue', 'delegate', 'transition', 'checklist', 'block', 'unblock', 'archive', 'restore', 'delete', 'stats', 'changes']
const CONFIG_KEYS_12 = ['defaultTemplateId', 'stallAfterHours', 'staleClaimHours', 'maxQueueItems', 'promptContext', 'promptMaxItems', 'http', 'executionSync', 'requireLockForExecution', 'maxExecutions', 'sseCoalesceMs', 'importLegacy']
const FAILURE_CODES_15 = ['invalid-argument', 'invalid-input', 'invalid-state', 'invalid-transition', 'dependency-not-met', 'completion-not-met', 'conflict', 'forbidden', 'invalid-role', 'not-found', 'in-use', 'invalid-config', 'invalid-record', 'malformed-legacy', 'unsupported-legacy-version']
const HOST_SOURCES = ['host/model.js', 'host/config.js', 'host/service.js', 'host/dispatch.js', 'host/flow.js', 'host/tools.js', 'host/domain.js', 'host/roles.js', 'host/http.js', 'host/runs.js']

for (const action of ACTIONS_18) {
  LOAD_BEARING.push({ doc: 'README.md', files: ['host/tools.js', 'host/service.js', 'host/http.js'], expect: new RegExp(`['"\`]${action}['"\`]|\\b${action}\\b`), why: `README 18 动作：${action}` })
}
for (const key of CONFIG_KEYS_12) {
  LOAD_BEARING.push({ doc: 'README.md', files: ['host/config.js'], expect: new RegExp(`\\b${key}\\b`), why: `§5.12 配置键：${key}` })
}
for (const code of FAILURE_CODES_15) {
  LOAD_BEARING.push({ doc: 'ROLE-DISPATCH.md', files: HOST_SOURCES, expect: new RegExp(`['"\`]${code}['"\`]|\\b${code}\\b`), why: `§8.2 失败码：${code}` })
}
LOAD_BEARING.push({ doc: 'ROLE-DISPATCH.md', files: ['host/domain.js'], expect: /openBoardDomain/, why: '§8.2 invalid-record 由开库包装抛出' })

/** Collect the matching locations for one curated row. */
function curatedMatches(row) {
  const files = row.files ?? [row.path]
  const matches = []
  for (const file of files) {
    const target = resolveTarget(file)
    if (target === null) return { error: `${file} not found` }
    const lines = readFileSync(target.file, 'utf8').split('\n')
    const from = row.from ?? 1
    const to = Math.min(row.to ?? lines.length, lines.length)
    for (let index = from - 1; index < to; index += 1) if (row.expect.test(lines[index])) matches.push(`${file}:${index + 1}`)
    if (row.from !== undefined && row.to === undefined && to < 1) matches.push(`${file}:out-of-range`)
  }
  return { matches }
}

if (MODE === 'semantic' || MODE === 'all') {
  console.log(`\n[A2] ${LOAD_BEARING.length} curated load-bearing checks`)
  for (const row of LOAD_BEARING) {
    const { error, matches } = curatedMatches(row)
    const where = row.path === undefined ? `${row.files.join('+')}` : `${row.path}${row.from === undefined ? '' : `:${row.from}-${row.to ?? 'EOF'}`}`
    if (error !== undefined) {
      check(`${row.doc} ${where} — ${row.why}`, false, error)
      continue
    }
    const passed = row.absent === true ? matches.length === 0 : matches.length > 0
    const detail = row.absent === true ? `unexpected match at ${matches.slice(0, 4).join(', ') || '?'}` : 'no line matches'
    check(`${row.doc} ${where} ${row.absent === true ? `does not match ${String(row.expect)}` : `matches ${String(row.expect)}`} — ${row.why}`, passed, detail)
    if (matches.length > 0 && process.env.G_VERBOSE === '1') console.log(`       at ${matches.slice(0, 6).join(', ')}${matches.length > 6 ? ` … (${matches.length})` : ''}`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed${warnings === 0 ? '' : `, ${warnings} warnings`}`)
process.exit(failures === 0 ? 0 : 1)
