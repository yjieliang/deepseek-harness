// dsh-producer 契约检查：证明「磁盘上的 preset == 交付包 §1/§3」且骨架合法。
//
// 断言分五组：文件与包契约 · preset 结构 · 权威逐字（含无漂移）· 文本卫生 · profile 接线。
// 未安装时「接线」两条必然 FAIL —— 那是安装前的预期状态，装完再跑应当全绿。
//
// 用法：node tools/prd-check.mjs [--bundle <目录>] [--authority <交付包>] [--no-authority]
//   有 FAIL 时 exit 1。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLE_ROOT,
  DEFAULT_AUTHORITY,
  PRESET_PATH,
  extractPersona,
  extractRoleGroup,
  renderPreset,
} from './gen-preset.mjs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const ROOT = resolve(argOf('--bundle', BUNDLE_ROOT))
const AUTHORITY = argOf('--authority', DEFAULT_AUTHORITY)
const SKIP_AUTHORITY = args.includes('--no-authority')
const PRESET = join(ROOT, 'presets', 'producer.patch.yml')

const EXPECTED_ROWS = [
  'persona',
  'agent-instructions',
  'time-context',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
  'compaction',
  'tool-ask-user',
  'tool-todo',
  'tool-web',
  'present',
  'requirement-board-role',
]
const ORDER = 68
const ROLE_ID = 'producer'
const ROLE_NAME = '磐石 · 制作人'
const DUTY_COUNT = 7
const DUTY_MAX = 40

let passed = 0
const failures = []
const skipped = []

/** 记一条断言结果。 */
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    process.stdout.write(`  PASS  ${label}\n`)
    return true
  }
  failures.push(detail === '' ? label : `${label} —— ${detail}`)
  process.stdout.write(`  FAIL  ${label}${detail === '' ? '' : ` —— ${detail}`}\n`)
  return false
}

/** 记一条不适用断言（附原因，绝不静默跳过）。 */
function skip(label, reason) {
  skipped.push(`${label} —— ${reason}`)
  process.stdout.write(`  SKIP  ${label} —— ${reason}\n`)
}

/** 读文本；不存在返回 undefined。 */
function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

process.stdout.write(`prd-check · bundle 根：${ROOT}\n`)
process.stdout.write(`交付包：${SKIP_AUTHORITY ? '（本次跳过）' : AUTHORITY}\n`)

// ── A. 文件与包契约 ─────────────────────────────────────────────────────────
process.stdout.write('\nA. 文件与包契约\n')
const REQUIRED = [
  'package.json',
  'README.md',
  'INSTALL.md',
  'NOTICE.md',
  'license/agency-agents.LICENSE',
  'presets/producer.patch.yml',
  'tools/gen-preset.mjs',
  'tools/prd-check.mjs',
]
for (const relative of REQUIRED) {
  check(`文件在位：${relative}`, existsSync(join(ROOT, relative)))
}

const manifestText = readIfPresent(join(ROOT, 'package.json'))
let manifest
try {
  manifest = JSON.parse(manifestText ?? '')
} catch (error) {
  manifest = undefined
  failures.push(`package.json 可解析 —— ${String(error?.message ?? error)}`)
  process.stdout.write(`  FAIL  package.json 可解析\n`)
}
if (manifest !== undefined) {
  check('package.json 可解析', true)
  check('包名 = dsh-producer', manifest.name === 'dsh-producer', `实得 ${manifest.name}`)
  check('版本 0.1.0', manifest.version === '0.1.0', `实得 ${manifest.version}`)
  check('ESM（type: module）', manifest.type === 'module', `实得 ${manifest.type}`)
  const files = Array.isArray(manifest.files) ? manifest.files : []
  for (const entry of ['INSTALL.md', 'NOTICE.md', 'README.md', 'license', 'presets', 'tools']) {
    check(`files 含 ${entry}`, files.includes(entry))
  }
  const patch = manifest.dsh?.bundle?.patch
  check(
    'dsh.bundle.patch 指向 ./presets/producer.patch.yml',
    Array.isArray(patch) && patch.length === 1 && patch[0] === './presets/producer.patch.yml',
    `实得 ${JSON.stringify(patch)}`,
  )
}

// ── B. preset 结构 ─────────────────────────────────────────────────────────
process.stdout.write('\nB. preset 结构\n')
const presetText = readIfPresent(PRESET)
check('preset 文件存在且非空', (presetText ?? '').length > 0)
if (presetText === undefined) {
  process.stdout.write(`\n失败 ${failures.length} 项，通过 ${passed} 项\n`)
  for (const item of failures) process.stdout.write(`  - ${item}\n`)
  process.exit(1)
}

const rows = [...presetText.matchAll(/^ {10}- id: (.+)$/gm)].map((match) => match[1].trim())
check(
  `顶层插件行集与顺序（${EXPECTED_ROWS.length} 行）`,
  rows.length === EXPECTED_ROWS.length && rows.every((row, index) => row === EXPECTED_ROWS[index]),
  `实得 ${rows.join(' / ')}`,
)
check('insert 行 id = preset-producer', /^\s{4}- id: preset-producer$/m.test(presetText))
check('装载器行挂 @deepseek-ai/dsh-agent-preset', presetText.includes("name: '@deepseek-ai/dsh-agent-preset'"))
check(`config.id = ${ROLE_ID}`, /^\s{8}id: producer$/m.test(presetText))
check(`config.name = ${ROLE_NAME}`, presetText.includes(`name: ${ROLE_NAME}`))
check(`config.order = ${ORDER}`, new RegExp(`^\\s{8}order: ${ORDER}$`, 'm').test(presetText))
check('description 非空', /^\s{8}description: \S/m.test(presetText))
check('persona 行挂 @deepseek-ai/dsh-persona 且 prefix 用块标量', /- id: persona\n\s+name: '@deepseek-ai\/dsh-persona'\n\s+config:\n\s+prefix: \|/.test(presetText))
check('persona.suffix 含 {{cwd}} 与引擎路径', presetText.includes('{{cwd}}') && presetText.includes('Godot_v4.7.2-stable_win64.exe'))
check('agent-instructions maxBytes = 65536', /maxBytes: 65536/.test(presetText))
const bashLine = presetText.match(/- id: tool-bash\n\s+name: '@deepseek-ai\/dsh-tool-bash'\n\s+disabled: (.+)$/m)
check("tool-bash disabled = !!js win32 条件", bashLine?.[1] === "!!js process.platform === 'win32'", `实得 ${bashLine?.[1]}`)
const pwshLine = presetText.match(/- id: tool-pwsh\n\s+name: '@deepseek-ai\/dsh-tool-pwsh'\n\s+disabled: (.+)$/m)
check("tool-pwsh disabled = !!js 非 win32 条件", pwshLine?.[1] === "!!js process.platform !== 'win32'", `实得 ${pwshLine?.[1]}`)
check(
  'tool-fs-search 必填字段 sampleOverCapGlobResults: false 在',
  /- id: tool-fs-search\n\s+name: '@deepseek-ai\/dsh-tool-fs-search'\n\s+config:\n(?:\s*#[^\n]*\n)?\s+sampleOverCapGlobResults: false/.test(presetText),
)
check('compaction 组 isolate 两个标志齐', /isolate:\n\s+compaction: true\n\s+toolResultPruner: true/.test(presetText))
check('tool-todo allowParallelInProgress: true', /allowParallelInProgress: true/.test(presetText))
check('tool-web fetch + searchTimeoutMs 60000', /fetch: true\n\s+searchTimeoutMs: 60000/.test(presetText))
const bangJs = [...presetText.matchAll(/!!js/g)].length
check('!!js 恰好 2 处', bangJs === 2, `实得 ${bangJs}`)
check('没有单感叹号 !js（YAML 里不合法）', !/(^|[^!])!js\b/.test(presetText))
check('角色声明包在 isolate: { requirementBoardRole: true } 组里', /- id: requirement-board-role\n\s+name: cordis:group\n\s+group: true\n\s+isolate:\n\s+requirementBoardRole: true/.test(presetText))
check('board-role 行挂 dsh-requirement-board/role', presetText.includes('name: dsh-requirement-board/role'))
check('preset 里没有把角色服务直接 provide 到全局', !/^\s{10}- id: board-role$/m.test(presetText))

// order 冲突现场扫描：同族 bundle 目录，不写死判断。
const scanRoots = [join('C:/code/deepseek-harness', 'bundles'), join(homedir(), '.dsh', 'bundles')]
const used = new Map()
for (const root of scanRoots) {
  if (!existsSync(root)) continue
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const presetsDir = join(root, entry.name, 'presets')
    if (!existsSync(presetsDir)) continue
    for (const file of readdirSync(presetsDir)) {
      if (!file.endsWith('.patch.yml')) continue
      const text = readIfPresent(join(presetsDir, file)) ?? ''
      for (const match of text.matchAll(/^ {8}order: (\d+)$/gm)) {
        const key = Number(match[1])
        const list = used.get(key) ?? []
        list.push(`${entry.name}/${file}`)
        used.set(key, list)
      }
    }
  }
}
const scanned = [...used.keys()].sort((left, right) => left - right)
process.stdout.write(`        现场扫描到的 order：${scanned.join(', ')}\n`)
check(
  `order ${ORDER} 未被同族其它预设占用`,
  (used.get(ORDER) ?? []).length === 1 && (used.get(ORDER) ?? [''])[0] === 'dsh-producer/producer.patch.yml',
  `实得 ${JSON.stringify(used.get(ORDER))}`,
)
// 「是全局最大值」不适用：同批施工把 69 / 70 留给 art-director / ux-designer（README §2），
// 所以这里只断言分配顺序（68 排在技术总监 67 之后）；唯一性由上一条断言。
check(`order ${ORDER} 排在技术总监（67）之后`, ORDER > 67)

// ── C. 权威逐字（交付包 §1/§3）───────────────────────────────────────────────
process.stdout.write('\nC. 权威逐字（交付包 §1/§3）\n')
let authorityText
if (SKIP_AUTHORITY) {
  skip('交付包逐字断言', '--no-authority')
} else if (!existsSync(AUTHORITY)) {
  check('交付包可读', false, AUTHORITY)
} else {
  authorityText = readFileSync(AUTHORITY, 'utf8')
  check('交付包可读', true)
  const persona = extractPersona(authorityText)
  const role = extractRoleGroup(authorityText)
  check(`roleId = ${ROLE_ID}（交付包 §1）`, role.roleId === ROLE_ID, `实得 ${role.roleId}`)
  check(`roleName 与交付包 §1 逐字一致`, role.roleName === ROLE_NAME, `实得 ${role.roleName}`)
  check('roleId 与 config.id 相等（预设 id = 角色 id）', role.roleId === ROLE_ID && /^\s{8}id: producer$/m.test(presetText))
  check(`duties 恰好 ${DUTY_COUNT} 条`, role.duties.length === DUTY_COUNT, `实得 ${role.duties.length}`)
  const tooLong = role.duties.filter((duty) => [...duty].length > DUTY_MAX)
  check(`每条 duty ≤ ${DUTY_MAX} 字`, tooLong.length === 0, tooLong.join(' / '))
  check('roleId 合法（小写字母数字与连字符）', /^[a-z0-9][a-z0-9-]*$/.test(role.roleId))
  const missingDuties = role.duties.filter((duty) => !presetText.includes(`- ${duty}`))
  check(`${DUTY_COUNT} 条 duties 逐条出现在 preset 里`, missingDuties.length === 0, missingDuties.join(' / '))
  const personaRegion = (() => {
    const open = presetText.indexOf('prefix: |\n')
    const close = presetText.indexOf('\n              suffix: |')
    if (open < 0 || close < 0 || close <= open) return ''
    return presetText
      .slice(presetText.indexOf('\n', open) + 1, close)
      .split('\n')
      .map((line) => (line.startsWith(' '.repeat(16)) ? line.slice(16) : line))
      .join('\n')
      .replace(/\s+$/, '')
  })()
  const personaWanted = persona.replace(/\n$/, '')
  check(
    'persona 正文逐字出现在 preset 里（§3 整段）',
    personaRegion === personaWanted,
    `取出 ${personaRegion.length} 字符 / 权威 ${personaWanted.length} 字符`,
  )
  const rendered = renderPreset(authorityText)
  check('无漂移：磁盘文件 == 生成器输出', presetText === rendered, `磁盘 ${presetText.length} 字符 / 生成 ${rendered.length} 字符`)
  const markers = ['# 制作人（技术项目管理）', '## 项目锚定', '## 核心能力', '## 注意事项', '风险登记表', 'systems-index.md']
  const absent = markers.filter((marker) => !presetText.includes(marker))
  check('persona 承重标记齐（标题/锚定/登记表/范围分层）', absent.length === 0, absent.join(' / '))
  check('persona 未把 M0–M7 当现行路线（只作历史）', presetText.includes('冻结为历史文档'))
}

// ── D. 文本卫生 ────────────────────────────────────────────────────────────
process.stdout.write('\nD. 文本卫生\n')
const textFiles = REQUIRED.filter((relative) => !relative.endsWith('LICENSE'))
for (const relative of textFiles) {
  const path = join(ROOT, relative)
  const text = readIfPresent(path)
  if (text === undefined) continue
  check(`${relative} 无 BOM`, !text.startsWith('\uFEFF'))
  check(`${relative} 无 CR（LF 收尾）`, !text.includes('\r'))
  check(`${relative} 文件尾恰好一个换行`, /[^\n]\n$/.test(text))
  check(`${relative} 无 U+FFFD`, !text.includes('\uFFFD'))
}
check('无生成器占位符残留', !/__PERSONA__|__ROLE_GROUP__/.test(presetText))
check('无 TODO / FIXME 残留', !/\b(TODO|FIXME)\b/.test(presetText))
const licenseText = readIfPresent(join(ROOT, 'license', 'agency-agents.LICENSE')) ?? ''
check('MIT 许可证原文在位', licenseText.includes('MIT License') && licenseText.includes('Permission is hereby granted'))
const readme = readIfPresent(join(ROOT, 'README.md')) ?? ''
check('README 写明 order 偏离（68）', readme.includes('68'))
const install = readIfPresent(join(ROOT, 'INSTALL.md')) ?? ''
check('INSTALL 有安装记录表', install.includes('| 日期 | 操作 |'))
const notice = readIfPresent(join(ROOT, 'NOTICE.md')) ?? ''
check('NOTICE 记上游 sha256', /c878d799/.test(notice))

// ── E. profile 接线（安装前必然 FAIL）─────────────────────────────────────
process.stdout.write('\nE. profile 接线（安装前 FAIL 属预期）\n')
const profilePath = join(homedir(), '.dsh', 'profiles', 'web', 'package.json')
const profileText = readIfPresent(profilePath)
check('web profile 的 package.json 可读', profileText !== undefined, profilePath)
if (profileText !== undefined) {
  let profile
  try {
    profile = JSON.parse(profileText)
  } catch (error) {
    check('web profile 的 package.json 可解析', false, String(error?.message ?? error))
  }
  if (profile !== undefined) {
    const sections = [profile.dependencies ?? {}, profile.devDependencies ?? {}]
    const pinned = sections.map((section) => section['dsh-producer']).find((value) => value !== undefined)
    check('profile 依赖含 dsh-producer 且为 link:', typeof pinned === 'string' && pinned.startsWith('link:'), `实得 ${pinned}`)
    const bundles = profile.dsh?.profile?.bundles ?? []
    check('profile 的 dsh.profile.bundles 含 dsh-producer', Array.isArray(bundles) && bundles.includes('dsh-producer'), `实得 ${JSON.stringify(bundles)}`)
  }
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
process.stdout.write(`\n通过 ${passed} 项\n`)
if (skipped.length > 0) {
  process.stdout.write(`跳过 ${skipped.length} 项：\n`)
  for (const item of skipped) process.stdout.write(`  - ${item}\n`)
}
if (failures.length > 0) {
  process.stdout.write(`失败 ${failures.length} 项：\n`)
  for (const item of failures) process.stdout.write(`  - ${item}\n`)
  process.exit(1)
}
process.stdout.write('全部契约检查通过。\n')
