#!/usr/bin/env node
// CCGS 配置解析器（R1）。
//
// 用途：dsh-ccgs-studio 的每篇技能原本在正文开头动态求值配置（上游是 shell 助手
// `hooks/yaml-helper.sh resolve_config --keys a,b`），抽取时那一行被整行剥离，改为
// 「先解析这些键」的说明。于是 20 篇 QA/发布技能里没有任何一篇能自己解析配置：键未写
// 不等于键为默认值，技能会去问人或降级成 NOT ASSESSED——两条路都不报错。
// 本脚本就是那个被剥离的解析器：用确定性脚本代替模型推理。
//
// 规格来源：CCGS 框架语料 `01-设计理念/05-配置解析.md`（五步解析链、12 个本地白名单键、
// rigor 展开表、默认值表、12 条失败模式、输出块形态）与 `01-设计理念/03-自动化模式.md`
// （modes.automation 的三种取值）。
//
// 契约：正常模式下**永远以 0 退出，并永远输出完整块**；每种降级都在 notes 上点名。
// 只有 --selftest 在断言失败时以 1 退出（那是测试通道，不是解析通道）。
//
// 用法：
//   node tools/ccgs-config.mjs --root <项目根>
//   node tools/ccgs-config.mjs --keys modes.workflow,qa.level --root <项目根>
//   node tools/ccgs-config.mjs --review full --root <项目根>
//   node tools/ccgs-config.mjs --selftest

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'

// ---------------------------------------------------------------- 规格表

/** rigor 展开表：六个前置旋钮**刻意没有终点默认值**，否则第 5 步会早于第 4 步给出答案、让 rigor 变成空操作。 */
const RIGOR_TABLE = {
  minimal: {
    'modes.workflow': 'minimal',
    'docs.density': 'terse',
    'qa.level': 'minimal',
    'modes.story_granularity': 'coarse',
    'modes.review_mode': 'solo',
    'team.size': 'individual',
  },
  standard: {
    'modes.workflow': 'standard',
    'docs.density': 'balanced',
    'qa.level': 'standard',
    'modes.story_granularity': 'balanced',
    'modes.review_mode': 'lean',
    'team.size': 'individual',
  },
  full: {
    'modes.workflow': 'full',
    'docs.density': 'thorough',
    'qa.level': 'full',
    'modes.story_granularity': 'fine',
    'modes.review_mode': 'full',
    'team.size': 'studio',
  },
}

/** 第 4 步展开覆盖的六个旋钮（顺序即输出顺序的一部分）。 */
const RIGOR_FRONTED = [
  'modes.workflow',
  'docs.density',
  'qa.level',
  'modes.story_granularity',
  'modes.review_mode',
  'team.size',
]

/** 第 5 步文档化默认值。六个前置旋钮刻意不在此表中。 */
const DOC_DEFAULTS = {
  'modes.automation': 'collaborative',
  'modes.rigor': 'minimal',
  'modes.automation_always_ask': ['scope_changes', 'file_deletions', 'schema_changes'],
}

/** 枚举校验表：只放能追溯到语料的取值。表外的键不做枚举校验（不发明取值）。 */
const ENUMS = {
  'modes.rigor': ['minimal', 'standard', 'full'],
  'modes.workflow': ['minimal', 'standard', 'full', 'lean', 'solo'],
  'docs.density': ['terse', 'balanced', 'thorough'],
  'qa.level': ['minimal', 'standard', 'full'],
  'modes.story_granularity': ['coarse', 'balanced', 'fine'],
  'modes.review_mode': ['solo', 'lean', 'full'],
  'team.size': ['individual', 'studio'],
  'modes.automation': ['collaborative', 'guided', 'autonomous'],
  'performance.enforce': ['warn', 'block', 'off'],
  'testing.strict.logic': ['true', 'false', 'unset'],
  'testing.strict.integration': ['true', 'false', 'unset'],
  'testing.strict.visual': ['true', 'false', 'unset'],
  'testing.strict.ui': ['true', 'false', 'unset'],
  'testing.strict.config': ['true', 'false', 'unset'],
}

/**
 * `project.local.yaml` 的 12 键白名单（读作用域 == 写白名单）。
 * 语料正文写「12 个键」而逐项列举为 11 项（`features.*` 是通配），本脚本按**逐项列举**实现，
 * 这个计数不一致记在 `--selftest` 的用例里，不靠猜补齐。
 */
const LOCAL_WHITELIST = [
  /^modes\.review_mode$/,
  /^modes\.automation$/,
  /^modes\.automation_always_ask$/,
  /^team\.size$/,
  /^testing\.strict\.(logic|integration|visual|ui|config)$/,
  /^performance\.enforce$/,
  /^features\./,
]

/** 文件元数据不是偏好设置，写在本地文件里是正确的。 */
const LOCAL_EXEMPT = [/^schema_version$/, /^framework\./]

/** 第 3 步的 legacy 纯文本镜像。 */
const LEGACY_READERS = {
  'modes.review_mode': 'production/review-mode.txt',
  'project.stage': 'production/stage.txt',
}

const TESTING_STRICT_KEYS = ['logic', 'integration', 'visual', 'ui', 'config']

/** 输出块的显示名与顺序（照语料 §三 的样例）。 */
const PRINT_ROWS = [
  ['modes.review_mode', 'review_mode'],
  ['modes.automation', 'automation'],
  ['modes.workflow', 'workflow'],
  ['docs.density', 'docs.density'],
  ['modes.story_granularity', 'story_granularity'],
  ['qa.level', 'qa.level'],
  ['team.size', 'team.size'],
  ['project.stage', 'project.stage'],
  ['modes.automation_always_ask', 'automation_always_ask'],
  ['engine', 'engine'],
  ['testing.strict', 'testing.strict'],
  ['workflow_overrides.system_overrides', 'system_overrides'],
]

// ---------------------------------------------------------------- 极简 YAML 读取

/**
 * 读取这个项目会用到的 YAML 子集，展平成点号路径 → 标量。
 * 支持：嵌套映射、块序列、行内序列、引号标量、注释、CRLF、UTF-8 BOM、3 空格缩进。
 * 已知缺口（语料自陈，照实保留）：结构错误与重复键**静默**（最后一个赢）。
 * @param {string} text 文件正文
 * @param {{tabLines:number[], notes:string[]}} diagnostic 收集 Tab 缩进行号等诊断
 * @returns {{scalars:Map<string,string>, lists:Map<string,string[]>}}
 */
function parseYamlSubset(text, diagnostic) {
  const scalars = new Map()
  const lists = new Map()
  const body = text.replace(/^\uFEFF/, '')
  const lines = body.split(/\r?\n/)
  const stack = [{ indent: -1, path: '' }]

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (/^[ ]*\t/.test(raw)) {
      diagnostic.tabLines.push(index + 1)
      continue
    }
    const indent = raw.length - raw.trimStart().length
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parentPath = stack[stack.length - 1].path

    if (trimmed.startsWith('- ')) {
      const key = parentPath
      const item = unquote(trimmed.slice(2).trim())
      if (!lists.has(key)) lists.set(key, [])
      lists.get(key).push(item)
      continue
    }

    const match = /^([^:]+):(.*)$/.exec(trimmed)
    if (match === null) continue
    const key = match[1].trim()
    const rest = match[2].trim()
    const path = parentPath === '' ? key : `${parentPath}.${key}`

    if (rest === '') {
      stack.push({ indent, path })
      continue
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const items = rest
        .slice(1, -1)
        .split(',')
        .map(part => unquote(part.trim()))
        .filter(part => part !== '')
      lists.set(path, items)
      continue
    }
    // 行内映射写法（`testing.strict: logic=true integration=false`）展开成点号路径。
    if (/^[A-Za-z_][A-Za-z0-9_]*=[^ ]*([ ]+[A-Za-z_][A-Za-z0-9_]*=[^ ]*)*$/.test(rest)) {
      for (const pair of rest.split(/\s+/)) {
        const [k, v] = pair.split('=')
        scalars.set(`${path}.${k}`, unquote(v))
      }
      continue
    }
    scalars.set(path, unquote(rest))
  }
  return { scalars, lists }
}

/** 去掉成对引号。 */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/** 读取一个文件；不存在或读不动都返回 null（降级由调用方记进 notes）。 */
function readTextIfPresent(path) {
  try {
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 空值与「键存在但值为空」一律视为未设置：继续下探，绝不落到 ""。 */
function isSet(value) {
  return value !== undefined && value !== null && value !== ''
}

// ---------------------------------------------------------------- 解析链

/**
 * 按五步解析链解析本项目会用到的键。
 * @param {{root:string, keys:string[]|null, review:string|null}} options 调用参数
 * @returns {{rows:Array<{key:string, display:string, value:string, source:string}>, notes:string[]}}
 */
function resolveConfig(options) {
  const notes = []
  const root = options.root
  const diagnostic = { tabLines: [], notes }

  const localPath = join(root, 'project.local.yaml')
  const projectPath = join(root, 'project.yaml')
  const localText = readTextIfPresent(localPath)
  const projectText = readTextIfPresent(projectPath)

  if (projectText === null) notes.push('project.yaml absent')
  else if (projectText.trim() === '') notes.push('project.yaml is EMPTY')

  const local = localText === null ? { scalars: new Map(), lists: new Map() } : parseYamlSubset(localText, diagnostic)
  const project = projectText === null ? { scalars: new Map(), lists: new Map() } : parseYamlSubset(projectText, diagnostic)

  for (const line of diagnostic.tabLines) {
    notes.push(`Tab indentation on line ${line} — rejected, chain continued`)
  }

  // 白名单之外的键被手写进 project.local.yaml：只警告、永不调和。
  for (const key of local.scalars.keys()) {
    const whitelisted = LOCAL_WHITELIST.some(pattern => pattern.test(key))
    const exempt = LOCAL_EXEMPT.some(pattern => pattern.test(key))
    if (!whitelisted && !exempt) {
      notes.push(`local: not locally overridable, ignored — ${key} (move to project.yaml or delete)`)
    }
  }
  for (const key of local.lists.keys()) {
    if (!LOCAL_WHITELIST.some(pattern => pattern.test(key))) {
      notes.push(`local: not locally overridable, ignored — ${key} (move to project.yaml or delete)`)
    }
  }

  /** 取标量：本地（仅白名单）→ project.yaml → legacy 镜像。空值下探。 */
  const readChain = key => {
    if (LOCAL_WHITELIST.some(pattern => pattern.test(key)) && isSet(local.scalars.get(key))) {
      return { value: local.scalars.get(key), source: 'project.local.yaml' }
    }
    if (isSet(project.scalars.get(key))) return { value: project.scalars.get(key), source: 'project.yaml' }
    const legacyRelative = LEGACY_READERS[key]
    if (legacyRelative !== undefined) {
      const legacyText = readTextIfPresent(join(root, legacyRelative))
      if (legacyText !== null && legacyText.trim() !== '') {
        return { value: legacyText.trim().split(/\r?\n/)[0].trim(), source: legacyRelative }
      }
    }
    return null
  }

  /** 枚举校验：非法值不算赢——越过它继续，并把被拒的值写在 notes 上。 */
  const withEnumCheck = (key, found) => {
    if (found === null) return null
    const allowed = ENUMS[key]
    if (allowed === undefined || allowed.includes(found.value)) return found
    notes.push(`${key}: '${found.value}' is not a valid value (expected: ${allowed.join('|')}) — ignored, chain continued`)
    return null
  }

  // 第 4 步需要先知道 rigor；rigor 自身走链（project.yaml → default minimal）。
  const foundRigor = withEnumCheck('modes.rigor', readChain('modes.rigor'))
  const rigor = foundRigor === null ? { value: DOC_DEFAULTS['modes.rigor'], source: 'default' } : foundRigor

  /** 完整解析一个键：链 → rigor 展开 → 文档化默认值。 */
  const resolveKey = key => {
    const chained = withEnumCheck(key, readChain(key))
    if (chained !== null) return chained
    if (RIGOR_FRONTED.includes(key)) {
      const table = RIGOR_TABLE[rigor.value]
      if (table !== undefined && isSet(table[key])) return { value: table[key], source: `rigor:${rigor.value}` }
      return { value: 'unset', source: 'unset' }
    }
    if (Object.hasOwn(DOC_DEFAULTS, key)) return { value: DOC_DEFAULTS[key], source: 'default' }
    return { value: 'unset', source: 'unset' }
  }

  const values = new Map()
  for (const [key] of PRINT_ROWS) values.set(key, resolveKey(key))
  // modes.rigor 自身也要能按需打印
  values.set('modes.rigor', rigor)

  // 列表型：automation_always_ask 支持块序列与行内序列。
  const askList = local.lists.get('modes.automation_always_ask') ?? project.lists.get('modes.automation_always_ask')
  if (Array.isArray(askList) && askList.length > 0) {
    values.set('modes.automation_always_ask', { value: askList, source: 'project.yaml' })
  } else if (!Array.isArray(values.get('modes.automation_always_ask').value)) {
    values.set('modes.automation_always_ask', { value: DOC_DEFAULTS['modes.automation_always_ask'], source: 'default' })
  }

  // testing.strict：脚本只报配置状态（缺失处报 unset），各技能自己套用自己的默认值。
  const strictValues = new Map()
  let strictSource = 'unset'
  for (const name of TESTING_STRICT_KEYS) {
    const key = `testing.strict.${name}`
    const found = withEnumCheck(key, readChain(key))
    if (found === null) strictValues.set(name, 'unset')
    else {
      strictValues.set(name, found.value)
      strictSource = found.source
    }
  }
  values.set('testing.strict', { value: strictValues, source: strictSource })

  // engine 只从 project.yaml 报告（上游没有为它建 markdown 读取器）。
  const engineName = project.scalars.get('engine.name')
  const engineVersion = project.scalars.get('engine.version')
  if (isSet(engineName) || isSet(engineVersion)) {
    values.set('engine', { value: [engineName, engineVersion].filter(isSet).join(' '), source: 'project.yaml' })
  } else {
    const flat = project.scalars.get('engine')
    values.set('engine', isSet(flat) ? { value: flat, source: 'project.yaml' } : { value: 'unset', source: 'unset' })
  }

  // workflow_overrides.system_overrides：把子键折成 `k=v` 一行。
  const overrides = []
  for (const [path, value] of project.scalars.entries()) {
    const prefix = 'workflow_overrides.system_overrides.'
    if (path.startsWith(prefix)) overrides.push(`${path.slice(prefix.length)}=${value}`)
  }
  values.set('workflow_overrides.system_overrides', {
    value: overrides.length > 0 ? overrides.join(' ') : 'none',
    source: overrides.length > 0 ? 'project.yaml' : 'unset',
  })

  // 内联 --review 覆盖 modes.review_mode。
  if (options.review !== null) {
    if (['solo', 'lean', 'full'].includes(options.review)) {
      values.set('modes.review_mode', { value: options.review, source: '--review' })
    } else {
      notes.push(`--review: '${options.review}' is not a valid value (expected: solo|lean|full) — ignored`)
    }
  }

  const requested = options.keys
  const rows = []
  const printed = new Set()
  for (const [key, display] of PRINT_ROWS) {
    if (requested !== null && !requested.includes(key) && !requested.includes(display)) continue
    printed.add(key)
    const found = values.get(key)
    rows.push({ key, display, value: formatValue(key, found.value), source: found.source })
  }
  // --keys 点名了非默认行时补印（例如 modes.rigor、performance.enforce）。
  if (requested !== null) {
    for (const key of requested) {
      if (printed.has(key)) continue
      const found = resolveKey(key)
      rows.push({ key, display: key, value: formatValue(key, found.value), source: found.source })
    }
  }
  return { rows, notes }
}

/** 把一个解析值格式化成块里的字符串。 */
function formatValue(key, value) {
  if (Array.isArray(value)) return value.join(', ')
  if (key === 'testing.strict' && value instanceof Map) return testingStrictLine(value)
  if (value === undefined || value === null || value === '') return 'unset'
  return String(value)
}

/** `testing.strict` 行：逐类型值 + 语料逐字保留的尾注。 */
function testingStrictLine(strings) {
  const parts = TESTING_STRICT_KEYS.map(name => `${name}=${strings.get(name) ?? 'unset'}`)
  return `${parts.join(' ')} (unset = each skill applies its own default)`
}

/** 把输出块拼成文本（照语料 §三 的形态）。 */
function formatBlock(rows, notes) {
  const lines = ['=== CCGS Resolved Config ===']
  for (const row of rows) {
    if (row.key === 'testing.strict') {
      lines.push(`${row.display}: ${row.value}`)
      continue
    }
    lines.push(`${row.display}: ${row.value} (${row.source})`)
  }
  lines.push(`notes: ${notes.length === 0 ? 'none' : notes.join('; ')}`)
  lines.push('Values above are fully resolved (local -> yaml -> legacy -> default). Use as-is.')
  lines.push('An inline --review flag, if passed, overrides review_mode.')
  lines.push('=== end CCGS config ===')
  return lines.join('\n')
}

// ---------------------------------------------------------------- 入口

/** 解析命令行：只认本脚本声明的四个开关。 */
function parseArgs(argv) {
  const options = { root: process.cwd(), keys: null, review: null, selftest: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--selftest') options.selftest = true
    else if (arg === '--root') options.root = argv[++index] ?? options.root
    else if (arg === '--keys') {
      options.keys = (argv[++index] ?? '')
        .split(',')
        .map(part => part.trim())
        .filter(part => part !== '')
    } else if (arg === '--review') options.review = argv[++index] ?? null
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  if (options.root !== null && !isAbsolute(options.root)) options.root = join(process.cwd(), options.root)
  return options
}

const HELP = `CCGS 配置解析器（R1）

用法：
  node tools/ccgs-config.mjs [--root <项目根>] [--keys a,b] [--review solo|lean|full]
  node tools/ccgs-config.mjs --selftest

正常模式永远以 0 退出并输出完整块；降级在 notes 上点名。`

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return
  }
  if (options.selftest) {
    process.exitCode = runSelftest() ? 0 : 1
    return
  }
  const { rows, notes } = resolveConfig(options)
  process.stdout.write(`${formatBlock(rows, notes)}\n`)
}

// ---------------------------------------------------------------- 自测

/** 在临时目录里造一个项目，跑解析器，断言块里的行。 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ccgs-config-selftest-'))
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

/** 断言一条解析结果。 */
function expectRow(results, display, expectedValue, expectedSource, label, failures) {
  const row = results.rows.find(candidate => candidate.display === display)
  if (row === undefined) {
    failures.push(`${label}: 缺少行 ${display}`)
    return
  }
  if (row.value !== expectedValue || (expectedSource !== null && row.source !== expectedSource)) {
    failures.push(`${label}: ${display} 期望 ${expectedValue} (${expectedSource ?? '任意'})，实得 ${row.value} (${row.source})`)
  }
}

/** 断言一条 note 出现（子串匹配）。 */
function expectNote(results, substring, label, failures) {
  if (!results.notes.some(note => note.includes(substring))) {
    failures.push(`${label}: notes 里没有「${substring}」，实得 ${JSON.stringify(results.notes)}`)
  }
}

/**
 * 覆盖语料 §六 的失败模式与 §五 的展开表。返回是否全部通过。
 * @returns {boolean} 全部断言是否通过
 */
function runSelftest() {
  const failures = []
  const cases = []

  const run = (label, files, options = {}) => {
    const dir = fixture(files)
    const results = resolveConfig({ root: dir, keys: null, review: null, ...options })
    rmSync(dir, { recursive: true, force: true })
    cases.push(label)
    return results
  }

  // 1) project.yaml 不存在 → 默认值 + notes 点名。
  const absent = run('1 project.yaml absent', {})
  expectRow(absent, 'qa.level', 'minimal', 'rigor:minimal', '1 project.yaml absent', failures)
  expectNote(absent, 'project.yaml absent', '1 project.yaml absent', failures)

  // 2) project.yaml 为空 → 刻意与「不存在」区分。
  const empty = run('2 project.yaml empty', { 'project.yaml': '' })
  expectNote(empty, 'project.yaml is EMPTY', '2 project.yaml empty', failures)

  // 3) YAML 格式错误 → 继续下探到默认值。
  const malformed = run('3 malformed yaml', { 'project.yaml': 'modes:\n  rigor standard\n' })
  expectRow(malformed, 'qa.level', 'minimal', 'rigor:minimal', '3 malformed yaml', failures)

  // 4) Tab 缩进 → 拒绝并点名行号。
  const tabbed = run('4 tab indent', { 'project.yaml': 'modes:\n\trigor: full\n' })
  expectNote(tabbed, 'Tab indentation on line 2', '4 tab indent', failures)

  // 5) CRLF 行尾 → 正确解析。
  const crlf = run('5 crlf', { 'project.yaml': 'modes:\r\n  rigor: full\r\n' })
  expectRow(crlf, 'qa.level', 'full', 'rigor:full', '5 crlf', failures)

  // 6) UTF-8 BOM → 正确解析，不污染第一个键。
  const bom = run('6 bom', { 'project.yaml': '\uFEFFmodes:\n  rigor: full\n' })
  expectRow(bom, 'qa.level', 'full', 'rigor:full', '6 bom', failures)

  // 7) 3 空格缩进 → 容忍。
  const threeSpace = run('7 three-space indent', { 'project.yaml': 'modes:\n   rigor: full\n' })
  expectRow(threeSpace, 'qa.level', 'full', 'rigor:full', '7 three-space indent', failures)

  // 8) 键存在但值为空 → 视为未设置，绝不落到 ""。
  const blank = run('8 empty value', { 'project.yaml': 'modes:\n  rigor:\nqa:\n  level:\n' })
  expectRow(blank, 'qa.level', 'minimal', 'rigor:minimal', '8 empty value', failures)
  if (blank.rows.some(row => row.value === '')) failures.push('8 empty value: 出现了空字符串值')

  // 9) 枚举非法值 → 越过并点名，展开表继续生效。
  const illegal = run('9 illegal enum', { 'project.yaml': 'modes:\n  rigor: standard\n  workflow: medium\n' })
  expectRow(illegal, 'workflow', 'standard', 'rigor:standard', '9 illegal enum', failures)
  expectNote(illegal, "'medium' is not a valid value", '9 illegal enum', failures)

  // 10) 白名单之外的键手写进 project.local.yaml → 只警告、不生效。
  const orphanLocal = run('10 orphan local key', {
    'project.yaml': 'modes:\n  rigor: standard\n',
    'project.local.yaml': 'modes:\n  rigor: full\n',
  })
  expectRow(orphanLocal, 'workflow', 'standard', 'rigor:standard', '10 orphan local key', failures)
  expectNote(orphanLocal, 'not locally overridable', '10 orphan local key', failures)

  // 11) 白名单内的键写进 project.local.yaml → 生效。
  const allowedLocal = run('11 whitelisted local key', {
    'project.yaml': 'modes:\n  rigor: standard\n',
    'project.local.yaml': 'modes:\n  review_mode: solo\n',
  })
  expectRow(allowedLocal, 'review_mode', 'solo', 'project.local.yaml', '11 whitelisted local key', failures)

  // 12) legacy 镜像：review_mode 与 project.stage 从纯文本文件读。
  const legacy = run('12 legacy mirrors', {
    'project.yaml': 'modes:\n  rigor: standard\n',
    'production/review-mode.txt': 'full\n',
    'production/stage.txt': 'Production\n',
  })
  expectRow(legacy, 'review_mode', 'full', 'production/review-mode.txt', '12 legacy mirrors', failures)
  expectRow(legacy, 'project.stage', 'Production', 'production/stage.txt', '12 legacy mirrors', failures)

  // 13) rigor 三行展开表逐值核对。
  for (const [level, table] of Object.entries(RIGOR_TABLE)) {
    const expanded = run(`13 rigor expansion ${level}`, { 'project.yaml': `modes:\n  rigor: ${level}\n` })
    for (const [key, expected] of Object.entries(table)) {
      const display = PRINT_ROWS.find(row => row[0] === key)[1]
      expectRow(expanded, display, expected, `rigor:${level}`, `13 rigor expansion ${level}`, failures)
    }
  }

  // 14) 显式值只覆盖那一个旋钮，其余仍跟随 rigor。
  const oneKnob = run('14 single knob override', {
    'project.yaml': 'modes:\n  rigor: full\nqa:\n  level: minimal\n',
  })
  expectRow(oneKnob, 'qa.level', 'minimal', 'project.yaml', '14 single knob override', failures)
  expectRow(oneKnob, 'docs.density', 'thorough', 'rigor:full', '14 single knob override', failures)

  // 15) 内联 --review 覆盖 review_mode。
  const inlineReview = run('15 inline --review', { 'project.yaml': 'modes:\n  rigor: standard\n' }, { review: 'solo' })
  expectRow(inlineReview, 'review_mode', 'solo', '--review', '15 inline --review', failures)

  // 16) testing.strict 未设置时逐项报 unset（脚本解析来源，技能拥有策略）。
  const strict = run('16 testing.strict unset', { 'project.yaml': 'modes:\n  rigor: standard\n' })
  expectRow(
    strict,
    'testing.strict',
    'logic=unset integration=unset visual=unset ui=unset config=unset (unset = each skill applies its own default)',
    null,
    '16 testing.strict unset',
    failures,
  )

  // 17) 白名单计数：语料写 12 个键，逐项列举为 11 项。这条用例把这个不一致固定下来。
  if (LOCAL_WHITELIST.length !== 7) {
    failures.push(`17 whitelist shape: 期望 7 条模式（11 个具名键 + features.*），实得 ${LOCAL_WHITELIST.length}`)
  }

  process.stdout.write(`CCGS 配置解析器自测：${cases.length} 个夹具\n`)
  for (const label of cases) process.stdout.write(`  夹具 ${label}\n`)
  if (failures.length === 0) {
    process.stdout.write('全部断言通过。\n')
    return true
  }
  process.stdout.write(`失败 ${failures.length} 条：\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  return false
}

main()

export { formatBlock, parseYamlSubset, resolveConfig, RIGOR_TABLE }
