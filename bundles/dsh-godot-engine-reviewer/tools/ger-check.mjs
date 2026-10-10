/**
 * dsh-godot-engine-reviewer 的结构与内容静态检查（无网络、无 GUI）。
 *
 *   node tools/ger-check.mjs [bundle 根目录]        # 默认 = 本脚本的上一级
 *   DSH_CHECKOUT=<dsh 源码目录> node tools/ger-check.mjs
 *
 * 借一份 dsh 源码 checkout 的 js-yaml 解析 Loader YAML 方言（含 `!!js` 标量）。
 * 退出码非 0 = 有断言不成立。
 *
 * 其中若干断言来自 2026-10-09 的实测踩坑，不要在没有新证据时放宽：
 *   - `.cmd` 必须是纯 ASCII（cmd.exe 按 OEM 代码页解析，中文注释会变成要执行的命令）；
 *   - `.ps1` 必须是纯 ASCII（powershell.exe 按 ANSI 解析无 BOM 的 UTF-8）；
 *   - 探针的打印行必须是纯 ASCII（pwsh 默认按 GBK 解码 UTF-8，中文经管道会变乱码）。
 */

import { createRequire } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const checkout = resolve(process.env.DSH_CHECKOUT ?? 'C:/code/deepseek-harness')
const root = resolve(process.argv[2] ?? join(here, '..'))
const failures = []
const assert = (ok, message) => { if (!ok) failures.push(message); return ok }

let yaml
try {
  yaml = createRequire(join(checkout, 'package.json'))('js-yaml')
} catch {
  console.error(`[ger-check] 找不到 js-yaml：需要一份 dsh 源码 checkout（当前 DSH_CHECKOUT=${checkout}）`)
  process.exit(2)
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

const files = walk(root)
const read = (path) => readFileSync(path, 'utf8')
const rel = (path) => relative(root, path).replace(/\\/g, '/')
const exists = (path) => { try { statSync(path); return true } catch { return false } }
const isAscii = (text) => !/[^\x00-\x7F]/.test(text)
const approxRead = (text) => text.split('\n').reduce((sum, line, index) => sum + line.length + String(index + 1).length + 2, 0)

const totalBytes = files.reduce((sum, path) => sum + statSync(path).size, 0)
console.log(`files: ${files.length} | total bytes: ${totalBytes}`)

// ── package.json ────────────────────────────────────────────────────────────
const pkg = JSON.parse(read(join(root, 'package.json')))
console.log(`pkg: ${pkg.name} ${pkg.version} | license: ${pkg.license}`)
assert(pkg.name === 'dsh-godot-engine-reviewer', `package.json 的 name 应为 dsh-godot-engine-reviewer，实际 ${pkg.name}`)
assert(Object.keys(pkg.dependencies ?? {}).length === 0, 'package.json 不应有 dependencies（零依赖是本包约束）')
assert(pkg.peerDependencies === undefined, 'package.json 不应有 peerDependencies')
assert(Array.isArray(pkg.dsh?.bundle?.patch) && pkg.dsh.bundle.patch.length === 1, 'dsh.bundle.patch 应恰好指向一个 patch 文件')
for (const entry of ['icon.svg', 'INSTALL.md', 'NOTICE.md', 'README.md', 'presets', 'skills', 'tools']) {
  assert((pkg.files ?? []).includes(entry), `package.json 的 files 缺少 ${entry}`)
}

// ── preset patch ────────────────────────────────────────────────────────────
const jsTag = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (d) => ({ __jsExpr: String(d) }) })
const schema = yaml.DEFAULT_SCHEMA.extend([jsTag])
const presetPath = join(root, 'presets', 'godot-engine-reviewer.patch.yml')
const rawPreset = read(presetPath)
let doc
try {
  doc = yaml.load(rawPreset, { schema })
} catch (error) {
  assert(false, `preset patch 无法在 Loader 方言下解析：${error.message}`)
  doc = []
}
const declaration = Array.isArray(doc) ? doc.find((row) => row && row.insert) : undefined
assert(declaration !== undefined, 'patch 顶层应有 insert 行')
const preset = declaration?.insert?.[0]
const presetConfig = preset?.config ?? {}
const rows = presetConfig.plugins ?? []
console.log(`patch 顶层行: ${Array.isArray(doc) ? doc.length : 0} | preset 子行: ${rows.length} | preset id: ${presetConfig.id}`)
assert(presetConfig.id === 'godot-engine-reviewer', `preset id 应为 godot-engine-reviewer，实际 ${presetConfig.id}`)
assert(presetConfig.order === 65, `preset order 应为 65，实际 ${presetConfig.order}`)
assert(typeof presetConfig.name === 'string' && presetConfig.name.length > 0, 'preset 缺少显示名')
assert(typeof presetConfig.description === 'string' && presetConfig.description.length > 0, 'preset 缺少 description')
assert(!Array.isArray(doc) || doc.find((row) => row?.id === 'agent-preset-registry') === undefined, '不应有 agent-preset-registry 覆盖行（bundle 层覆盖会被 profile 用户层压掉）')

const rowIds = rows.map((row) => row.id)
for (const id of ['persona', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill', 'compaction', 'tool-ask-user', 'tool-todo', 'tool-web', 'present', 'requirement-board-role']) {
  assert(rowIds.includes(id), `preset 缺少插件行 ${id}`)
}
// 两处刻意的缺席：项目 AGENTS.md 与只审不实现的边界冲突；子代理会绕开只读纪律。
assert(!rowIds.includes('agent-instructions'), '不应挂 agent-instructions（与"只审不实现"冲突）')
assert(!rowIds.includes('tool-subagent'), '不应挂 tool-subagent（保持单专家身份，长探针走 tool-jobs）')
assert(/sampleOverCapGlobResults:\s*\S+/.test(rawPreset), 'tool-fs-search 缺少必填字段 sampleOverCapGlobResults（漏掉会让整条 preset 变 broken）')
assert(/customSkillDirs:/.test(rawPreset) && /!!js/.test(rawPreset), 'skill-filesystem 应以 !!js 从已安装包解析 skills 目录')

// ── persona ────────────────────────────────────────────────────────────────
const persona = rows.find((row) => row.id === 'persona')
const prefix = persona?.config?.prefix ?? ''
const suffix = persona?.config?.suffix ?? ''
console.log(`persona 字符数: prefix ${[...prefix].length} | suffix ${[...suffix].length}`)
assert(prefix.length > 0, 'persona 缺少 prefix')
assert(approxRead(prefix) < 8192, `persona prefix 读取结果约 ${approxRead(prefix)} 字节，超出单次读取预算 8192`)
for (const marker of ['成立', '不成立', '证据不足', '证据五元组', '严重', '建议', '可选', '未验证']) {
  assert(prefix.includes(marker), `persona prefix 缺少判定口径标记：${marker}`)
}
assert(suffix.includes('{{cwd}}'), 'persona suffix 应包含 {{cwd}}')

// ── 角色声明（ROLE-DISPATCH §2.3）────────────────────────────────────────────
const roleRow = rows.find((row) => row.id === 'requirement-board-role')
assert(roleRow?.group === true, '角色声明行应为 cordis:group')
assert(roleRow?.isolate?.requirementBoardRole === true, '角色声明必须包在 isolate: { requirementBoardRole: true } 组内（否则注册表判该 preset 为 broken）')
const declarationRow = roleRow?.config?.[0]
const role = declarationRow?.config ?? {}
console.log(`role: ${role.roleId} / ${role.roleName} / duties=${(role.duties ?? []).length}`)
assert(/^[a-z][a-z0-9_-]{0,31}$/.test(role.roleId ?? ''), `roleId 形状不合法：${role.roleId}`)
assert(role.roleId !== 'human', 'roleId 不得为保留角色 human')
assert(!(role.roleId ?? '').startsWith('tmp-'), 'roleId 不得使用派发保留前缀 tmp-')
assert([...(role.roleName ?? '')].length <= 40, 'roleName 超过 40 字上限')
assert(Array.isArray(role.duties) && role.duties.length > 0 && role.duties.length <= 12, 'duties 应为 1–12 项')
for (const duty of role.duties ?? []) {
  assert([...duty].length <= 40, `duty 超过 40 字上限：${duty}`)
}

// ── 技能包 ──────────────────────────────────────────────────────────────────
const skillDir = join(root, 'skills', 'godot-engine-review')
const skillPath = join(skillDir, 'SKILL.md')
assert(exists(skillPath), '缺少 skills/godot-engine-review/SKILL.md')
const skillText = read(skillPath)
assert(/^---\r?\n/.test(skillText), 'SKILL.md 应以 YAML frontmatter 开头')
assert(/^name:\s*godot-engine-review$/m.test(skillText), 'SKILL.md frontmatter 的 name 应为 godot-engine-review')
assert(/^description:\s*\S/m.test(skillText), 'SKILL.md frontmatter 缺少 description')

// SKILL.md 里以反引号点名的相对路径必须真实存在（引用不许断）。
const referenced = new Set()
for (const match of skillText.matchAll(/`((?:references|templates|probes)\/[A-Za-z0-9._/-]*)`/g)) {
  referenced.add(match[1].replace(/\/$/, ''))
}
for (const target of referenced) {
  assert(exists(join(skillDir, target)), `SKILL.md 引用了不存在的路径：${target}`)
}
console.log(`SKILL.md 点名路径: ${referenced.size} 个，全部存在`)

const skillsMd = files.filter((path) => rel(path).startsWith('skills/') && path.endsWith('.md'))
for (const path of skillsMd) {
  const approx = approxRead(read(path))
  assert(approx < 8192, `${rel(path)} 读取结果约 ${approx} 字节，超出单次读取预算 8192`)
  console.log(`volume ${rel(path).padEnd(62)} ${approx} ${approx < 8192 ? 'OK' : 'OVER'}`)
}

// ── 探针脚手架 ──────────────────────────────────────────────────────────────
const probeDir = join(skillDir, 'probes', 'template')
for (const name of ['project.godot', 'probe.gd', 'run-probe.ps1', 'run-probe.cmd', 'run-probe.sh', 'README.md']) {
  assert(exists(join(probeDir, name)), `探针模板缺少 ${name}`)
}
// Windows 两个运行器必须纯 ASCII：cmd 按 OEM 代码页、powershell.exe 按 ANSI 解析（2026-10-09 实测）。
for (const name of ['run-probe.cmd', 'run-probe.ps1']) {
  const text = read(join(probeDir, name))
  assert(isAscii(text), `${name} 必须纯 ASCII（非 ASCII 会让 cmd/powershell.exe 解析失败）`)
}
// 探针的打印行必须纯 ASCII：pwsh 默认按 GBK 解码 UTF-8，中文经管道会变乱码。
const probeScript = read(join(probeDir, 'probe.gd'))
for (const [index, line] of probeScript.split('\n').entries()) {
  if (/_emit\(|print\(/.test(line)) {
    assert(isAscii(line), `probe.gd:${index + 1} 的打印行必须纯 ASCII：${line.trim()}`)
  }
}
assert(/file_logging\/enable_file_logging=false/.test(read(join(probeDir, 'project.godot'))), '探针工程应关闭引擎自身文件日志（否则 user://logs 报错会插进证据）')
assert(!/^\s*param\(\s*\[string\]\$ProbeDir\s*=\s*\$PSScriptRoot/m.test(read(join(probeDir, 'run-probe.ps1'))), 'run-probe.ps1 不得在 param() 默认值里用 $PSScriptRoot（Windows PowerShell 5.1 下为空）')

// ── 文本卫生 ────────────────────────────────────────────────────────────────
const proseFiles = files.filter((path) => /\.(md|yml|godot|gd|ps1|cmd)$/.test(path))
for (const path of proseFiles) {
  const text = read(path)
  assert(!/\?{3,}/.test(text), `${rel(path)} 出现连续问号（疑似编码损坏）`)
  assert(!text.includes('__BUNDLE_DIR__'), `${rel(path)} 仍有未求值的占位符 __BUNDLE_DIR__`)
}

if (failures.length > 0) {
  console.error(`\n[ger-check] 失败 ${failures.length} 项：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\n[ger-check] 全部通过。')