#!/usr/bin/env node
// dsh-godot-qa-expert 的静态契约检查（gqe-check）。
//
// 它只查**磁盘上能证明的事实**：文件齐全、preset 行的必填字段、!!js 只出现在允许的位置、
// 技能前言的形状、模板留了占位符、没有占位残渣与乱码、相对链接不悬空、文件尾恰好一个换行。
// 它不解析 YAML、不判断文案质量、不代替安装后的激活取证（那在 INSTALL.md §5）。
//
// 用法：node tools/gqe-check.mjs [--bundle <目录>]   退出码：全绿 0，有 FAIL 1（WARN 不影响退出码）。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const failures = []
const warnings = []
const passed = []

/** 记一条通过。 */
function ok(label) {
  passed.push(label)
}

/** 记一条失败。 */
function fail(label, detail) {
  failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

/** 记一条警告（不改变退出码）。 */
function warn(label, detail) {
  warnings.push(detail === undefined ? label : `${label} — ${detail}`)
}

/** 读文本；读不到返回 null 并记失败。 */
function readText(path, label) {
  if (!existsSync(path)) {
    fail(label, `缺少文件 ${relative(process.cwd(), path)}`)
    return null
  }
  return readFileSync(path, 'utf8')
}

/** 递归列出目录下的所有文件（相对 bundle 根）。 */
function walk(root) {
  const out = []
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else out.push(path)
    }
  }
  if (existsSync(root)) visit(root)
  return out
}

/** 检查一条正则是否命中。 */
function mustMatch(text, pattern, label) {
  if (text === null) return
  if (pattern.test(text)) ok(label)
  else fail(label, `未命中 ${pattern}`)
}

/** 检查必备文件存在。 */
function mustExist(path, label) {
  if (existsSync(path)) ok(label)
  else fail(label, `缺少 ${relative(process.cwd(), path)}`)
}

const bundleRoot = (() => {
  const args = process.argv.slice(2)
  const index = args.indexOf('--bundle')
  const requested = index >= 0 ? args[index + 1] : undefined
  return requested === undefined ? resolve(HERE, '..') : resolve(requested)
})()

// ---------------------------------------------------------------- 1. 文件齐备

const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'INSTALL.md',
  'NOTICE.md',
  'presets/godot-qa-expert.patch.yml',
  'skills/godot-qa-support/SKILL.md',
  'skills/godot-qa-support/references/00-alignment.md',
  'skills/godot-qa-support/references/01-test-strategy.md',
  'skills/godot-qa-support/references/02-defect-triage.md',
  'skills/godot-qa-support/references/03-release-readiness.md',
  'skills/godot-qa-support/references/04-regression-plan.md',
  'skills/godot-qa-support/references/05-evidence-channel.md',
  'skills/godot-qa-support/references/06-framework-corpus.md',
  'skills/godot-qa-support/templates/test-strategy.md',
  'skills/godot-qa-support/templates/defect-register.md',
  'skills/godot-qa-support/templates/regression-plan.md',
  'skills/godot-qa-support/templates/release-readiness.md',
  'tools/ccgs-config.mjs',
  'tools/gqe-check.mjs',
]
for (const file of REQUIRED_FILES) mustExist(join(bundleRoot, file), `文件齐备：${file}`)

// ---------------------------------------------------------------- 2. package.json

const manifestText = readText(join(bundleRoot, 'package.json'), 'package.json 可读')
let manifest = null
try {
  manifest = manifestText === null ? null : JSON.parse(manifestText)
  ok('package.json 是合法 JSON')
} catch (error) {
  fail('package.json 是合法 JSON', String(error))
}
if (manifest !== null) {
  if (manifest.name === 'dsh-godot-qa-expert') ok('package.json name 正确')
  else fail('package.json name 正确', `实得 ${manifest.name}`)
  if (manifest.type === 'module') ok('package.json type=module')
  else fail('package.json type=module', `实得 ${manifest.type}`)
  const patches = manifest.dsh?.bundle?.patch
  const list = Array.isArray(patches) ? patches : patches === undefined ? [] : [patches]
  if (list.length === 1) ok('package.json 声明一个 patch')
  else fail('package.json 声明一个 patch', `实得 ${JSON.stringify(patches)}`)
  for (const patch of list) {
    const target = resolve(bundleRoot, patch)
    if (existsSync(target)) ok(`patch 文件存在：${patch}`)
    else fail(`patch 文件存在：${patch}`, 'dsh.bundle.patch 指向不存在的文件')
  }
}

// ---------------------------------------------------------------- 3. preset 契约

const presetPath = join(bundleRoot, 'presets/godot-qa-expert.patch.yml')
const preset = readText(presetPath, 'preset patch 可读')
if (preset !== null) {
  mustMatch(preset, /^\s*- id: preset-godot-qa-expert$/m, 'preset 行 id 为 preset-godot-qa-expert')
  mustMatch(preset, /^\s*name: '@deepseek-ai\/dsh-agent-preset'$/m, 'preset 行挂 dsh-agent-preset')
  mustMatch(preset, /^\s*id: godot-qa-expert$/m, 'preset config.id 为 godot-qa-expert')
  mustMatch(preset, /^\s*order: 66$/m, 'preset order 为 66（同族 65 之后）')
  mustMatch(preset, /^\s*sampleOverCapGlobResults: false$/m, 'tool-fs-search 带必填 Config（漏掉会让整条 preset 变 broken）')
  mustMatch(preset, /isolate:\n\s*requirementBoardRole: true/, '角色声明包在 requirementBoardRole isolate 组内')
  mustMatch(preset, /dsh-godot-qa-expert\/package\.json/, '本包 skills 目录从已安装包解析')
  mustMatch(preset, /dsh-ccgs-studio\/package\.json/, 'CCGS skills 目录从已安装包解析（硬前置）')

  const REQUIRED_ROWS = [
    'persona',
    'agent-instructions',
    'tool-fs',
    'tool-fs-search',
    'tool-jobs',
    'skill-filesystem',
    'skill-filesystem-ccgs',
    'tool-skill',
    'compaction',
    'tool-ask-user',
    'tool-todo',
    'tool-web',
    'present',
    'requirement-board-role',
  ]
  for (const row of REQUIRED_ROWS) {
    if (new RegExp(`^\\s*- id: ${row}$`, 'm').test(preset)) ok(`preset 含行 ${row}`)
    else fail(`preset 含行 ${row}`, '行缺失')
  }

  const insertCount = (preset.match(/^\s*- insert:$/gm) ?? []).length
  if (insertCount === 1) ok('preset 只有一个 insert 块')
  else fail('preset 只有一个 insert 块', `实得 ${insertCount}`)

  // !!js 只允许出现在列表项（customSkillDirs）与 disabled 上。
  const lines = preset.split('\n')
  let jsViolations = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.includes('!!js')) continue
    const trimmed = line.trim()
    const allowed = trimmed.startsWith('- !!js') || /^disabled: !!js/.test(trimmed)
    if (!allowed) {
      jsViolations += 1
      fail('!!js 只在 config/disabled 上', `第 ${index + 1} 行：${trimmed.slice(0, 60)}`)
    }
  }
  if (jsViolations === 0) ok('!!js 只在 config/disabled 上')

  if (/!!js/.test(preset) && /!js/.test(preset.replace(/!!js/g, ''))) {
    fail('!!js 写法正确', '出现单感叹号 !js')
  } else ok('!!js 写法正确（无 !js）')

  // persona 必须真的写了四职责与边界，不是空壳。
  for (const token of ['测试策略', '缺陷分级', '发布就绪', '回归规划', 'NOT ASSESSED']) {
    if (preset.includes(token)) ok(`persona 含「${token}」`)
    else fail(`persona 含「${token}」`, '字样缺失')
  }
}

// ---------------------------------------------------------------- 4. 技能前言与清单

const skillPath = join(bundleRoot, 'skills/godot-qa-support/SKILL.md')
const skill = readText(skillPath, 'SKILL.md 可读')
if (skill !== null) {
  if (!skill.startsWith('---\n')) fail('SKILL.md 以 YAML 前言开头', '首行不是 ---')
  else ok('SKILL.md 以 YAML 前言开头')
  mustMatch(skill, /^name: godot-qa-support$/m, 'SKILL.md name 与目录一致')
  mustMatch(skill, /^description: ".+"$/m, 'SKILL.md 有 description')
  mustMatch(skill, /^metadata:$/m, 'SKILL.md 有 metadata')

  // SKILL.md 的清单与磁盘双向一致。
  const onDisk = walk(join(bundleRoot, 'skills/godot-qa-support/references')).map(path =>
    relative(join(bundleRoot, 'skills/godot-qa-support'), path).split(sep).join('/'),
  )
  const missingFromList = onDisk.filter(file => !skill.includes(file))
  if (missingFromList.length === 0) ok('SKILL.md 清单覆盖全部 references')
  else fail('SKILL.md 清单覆盖全部 references', `未点名：${missingFromList.join('、')}`)
}

// ---------------------------------------------------------------- 5. 文本卫生与链接

const TEXT_EXTENSIONS = ['.md', '.yml', '.yaml', '.mjs', '.json', '.svg']
const targets = [
  ...walk(join(bundleRoot, 'skills')),
  ...walk(join(bundleRoot, 'presets')),
  join(bundleRoot, 'tools/gqe-check.mjs'),
  join(bundleRoot, 'tools/ccgs-config.mjs'),
  join(bundleRoot, 'package.json'),
  join(bundleRoot, 'README.md'),
  join(bundleRoot, 'INSTALL.md'),
  join(bundleRoot, 'NOTICE.md'),
].filter(path => existsSync(path) && TEXT_EXTENSIONS.includes(path.slice(path.lastIndexOf('.'))))

let bomCount = 0
let newlineCount = 0
let mojibakeCount = 0
let residueCount = 0
const dangling = []

for (const path of targets) {
  const text = readFileSync(path, 'utf8')
  const label = relative(bundleRoot, path).split(sep).join('/')
  if (text.charCodeAt(0) === 0xfeff) {
    bomCount += 1
    fail(`无 BOM：${label}`, '文件以 BOM 开头')
  }
  if (!text.endsWith('\n') || text.endsWith('\n\n')) {
    newlineCount += 1
    fail(`文件尾恰好一个换行：${label}`, '结尾换行数不是 1')
  }
  if (text.includes('\uFFFD')) {
    mojibakeCount += 1
    fail(`无乱码替换字符：${label}`, '含 U+FFFD')
  }
  // 残渣词表拆开拼，免得本文件自己的正则字面量命中自己。
  const residueWords = [`${'TO'}${'DO'}`, `${'FIX'}${'ME'}`, 'X'.repeat(3), `${'（'}待补${'）'}`, '\\?\\?\\?']
  const residuePattern = new RegExp(residueWords.join('|'))
  if (residuePattern.test(text)) {
    residueCount += 1
    const hit = residuePattern.exec(text)[0]
    fail(`无占位残渣：${label}`, `命中「${hit}」`)
  }
  // 相对 Markdown 链接必须落在磁盘上。行内代码里的方括号不是链接（Markdown 也不渲染它），先摘掉。
  const linkSource = text.replace(/`[^`\n]*`/g, '')
  for (const match of linkSource.matchAll(/\]\(([^)#\s]+)\)/g)) {
    const href = match[1]
    if (/^[a-z]+:/i.test(href) || href.startsWith('#')) continue
    const target = resolve(dirname(path), decodeURIComponent(href))
    if (!existsSync(target)) dangling.push(`${label} → ${href}`)
  }
}
if (bomCount === 0) ok('全部文本文件无 BOM')
if (newlineCount === 0) ok('全部文本文件尾恰好一个换行')
if (mojibakeCount === 0) ok('全部文本文件无乱码替换字符')
if (residueCount === 0) ok('无占位残渣（占位记号 / 待办字样）')
if (dangling.length === 0) ok('无悬空相对链接')
else fail('无悬空相对链接', dangling.join('；'))

// ---------------------------------------------------------------- 6. 模板与依赖

for (const template of [
  'skills/godot-qa-support/templates/test-strategy.md',
  'skills/godot-qa-support/templates/defect-register.md',
  'skills/godot-qa-support/templates/regression-plan.md',
  'skills/godot-qa-support/templates/release-readiness.md',
]) {
  const path = join(bundleRoot, template)
  if (!existsSync(path)) continue
  const text = readFileSync(path, 'utf8')
  if (/\{\{[^}]+\}\}/.test(text)) ok(`模板留了占位符：${template}`)
  else fail(`模板留了占位符：${template}`, '没有 {{...}}')
}

// dsh-ccgs-studio 是运行时硬前置：能查到 profile 就核对，查不到只警告。
const profileManifest = join(process.env.USERPROFILE ?? '', '.dsh/profiles/web/package.json')
if (existsSync(profileManifest)) {
  const text = readFileSync(profileManifest, 'utf8')
  if (text.includes('dsh-ccgs-studio')) ok('web profile 已装 dsh-ccgs-studio（运行时硬前置）')
  else warn('web profile 未装 dsh-ccgs-studio', '本 preset 的第二个技能来源会解析失败，整条 preset 会 broken')
} else {
  warn('查不到 web profile', '跳过 dsh-ccgs-studio 前置核对')
}

// ---------------------------------------------------------------- 7. 跨 bundle 依赖（external）

// 本包把 CCGS 的 16 个技能与两处外部权威文件当作「直接复用」点名依赖。上游改名或卸载时它们会
// 静默悬空——而本包的原则是响亮失败优于静默降级，所以这一组默认必查，缺哪个报哪个。
// 16 个名字的权威是 skills/godot-qa-support/SKILL.md 第三节的职责路由表；这里刻意**写死名字**，
// 不去解析那张表：解析表格太脆，而改表恰恰是最该被这一组挡住的动作（断言 B 就是为它准备的）。
const CCGS_REUSED_SKILLS = [
  'qa-plan',
  'test-setup',
  'test-evidence-review',
  'test-helpers',
  'bug-report',
  'bug-triage',
  'gate-check',
  'milestone-review',
  'release-checklist',
  'launch-checklist',
  'team-qa',
  'regression-suite',
  'test-flakiness',
  'smoke-check',
  'soak-test',
  'perf-profile',
]

const externalRootNotes = []
// --no-external：在没有装同族的机器上跑静态检查时跳过整组（既不记通过也不记失败）。
const externalSkipped = process.argv.includes('--no-external')
const passedBeforeExternal = passed.length
const failuresBeforeExternal = failures.length

if (externalSkipped) {
  externalRootNotes.push('--no-external：整组跳过（不计通过、不计失败，退出码不受影响）')
} else {
  // 依赖根三级回落：显式环境变量 → profile 里已安装的包 → 同级 bundle 目录。
  const ccgsRoot = (() => {
    const fromEnv = process.env.CCGS_STUDIO_DIR
    if (fromEnv !== undefined && fromEnv !== '') {
      return { root: resolve(fromEnv), source: 'CCGS_STUDIO_DIR' }
    }
    if (existsSync(profileManifest)) {
      try {
        // 从 profile 的 package.json 出发解析，比拼 node_modules 路径稳（link: 依赖会跟着解析）。
        const manifest = createRequire(pathToFileURL(profileManifest)).resolve('dsh-ccgs-studio/package.json')
        return { root: dirname(manifest), source: 'web profile 的 node_modules' }
      } catch {
        // 解析不到就落到下一级；这一级为什么没用，由下面的根存在性断言说清楚。
      }
    }
    return {
      root: join(process.env.USERPROFILE ?? '', '.dsh/bundles/dsh-ccgs-studio'),
      source: '~/.dsh/bundles',
    }
  })()
  const ccgsSkills = join(ccgsRoot.root, 'skills')
  externalRootNotes.push(`ccgs-studio 根：${ccgsRoot.root}（来源：${ccgsRoot.source}）`)
  externalRootNotes.push(`ccgs-studio 技能目录：${ccgsSkills}`)

  if (existsSync(ccgsRoot.root)) ok('外部依赖根存在：ccgs-studio')
  else fail('外部依赖根存在：ccgs-studio', `${ccgsRoot.root}（来源：${ccgsRoot.source}）不存在`)

  // 断言 A：16 个被点名的技能逐个要有 SKILL.md，且必须是**文件**（同名目录不算）。
  for (const name of CCGS_REUSED_SKILLS) {
    const path = join(ccgsSkills, name, 'SKILL.md')
    if (existsSync(path) && statSync(path).isFile()) ok(`外部技能在册：${name}`)
    else fail(`外部技能在册：${name}`, `缺少文件 ${path}`)
  }

  // 断言 B：反向防漂移——路由表掉了一个技能也要报，否则「检查器仍要求、文档已不提」会长期潜伏。
  if (skill !== null) {
    for (const name of CCGS_REUSED_SKILLS) {
      // 路由表把它们写成 `/name`（斜杠可调用），所以斜杠可有可无，但名字必须整段被反引号包住，
      // 这样 `qa-plan-v2` 之类的改名不会被前缀蒙混过去。
      if (new RegExp('[`]/?' + name + '[`]').test(skill)) ok(`路由表仍点名：${name}`)
      else fail(`路由表仍点名：${name}`, '路由表掉了一个检查器仍要求的技能，请同步')
    }
  }

  // 断言 C：被引用的外部权威文件。语料根按与 ccgs-config.mjs 相同的规则解析。
  const reviewBaseline = join(
    process.env.USERPROFILE ?? '',
    '.dsh/bundles/dsh-godot-review-board/skills/godot-review-board/references/baseline.md',
  )
  externalRootNotes.push(`评审团基线：${reviewBaseline}`)
  if (existsSync(reviewBaseline) && statSync(reviewBaseline).isFile()) ok('外部权威文件在册：评审团 baseline.md')
  else fail('外部权威文件在册：评审团 baseline.md', `缺少文件 ${reviewBaseline}`)

  const corpus = (() => {
    const fromEnv = process.env.CCGS_ESSENCE_DIR
    if (fromEnv !== undefined && fromEnv !== '') return { root: resolve(fromEnv), source: 'CCGS_ESSENCE_DIR' }
    return { root: 'D:\\AI\\test\\ccgs-essence', source: '默认路径' }
  })()
  const effectIndex = join(corpus.root, '04-参考', '效果映射索引.md')
  externalRootNotes.push(`框架语料根：${corpus.root}（来源：${corpus.source}）`)
  if (existsSync(effectIndex) && statSync(effectIndex).isFile()) ok('外部权威文件在册：语料 效果映射索引.md')
  else fail('外部权威文件在册：语料 效果映射索引.md', `缺少文件 ${effectIndex}`)
}

const externalPassed = passed.length - passedBeforeExternal
const externalFailed = failures.length - failuresBeforeExternal

// ---------------------------------------------------------------- 输出

process.stdout.write(`gqe-check · bundle 根：${bundleRoot}\n`)
process.stdout.write(`通过 ${passed.length} 项\n`)
// external 组的分组小计，以及回落实际用到的根路径（便于人核对到底走了哪一级）。
process.stdout.write(
  externalSkipped
    ? 'external 组：skipped（--no-external）\n'
    : `external 组：通过 ${externalPassed} 项，FAIL ${externalFailed} 项（共 ${externalPassed + externalFailed} 项）\n`,
)
for (const note of externalRootNotes) process.stdout.write(`  ${note}\n`)
for (const warning of warnings) process.stdout.write(`  WARN ${warning}\n`)
if (failures.length === 0) {
  process.stdout.write('全部契约检查通过。\n')
} else {
  process.stdout.write(`FAIL ${failures.length} 项：\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
}
process.exitCode = failures.length === 0 ? 0 : 1
