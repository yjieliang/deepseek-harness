// dsh-art-director 的静态契约检查（ard-check）。
//
// 它只查**磁盘上能证明的事实**，不启动 Host：
//   1) 文件齐备与文本卫生（BOM / 尾换行 / 乱码 / 占位残渣 / 悬空相对链接 / 机器路径泄漏 / MIT 许可在位）
//   2) preset 行集、必填 Config、!!js 位置、角色声明 isolate 组（漏了会让整条 preset 变 broken）
//   3) **与交付包逐字一致**：persona == §3 正文、roleId/roleName/duties == §1 组
//   4) **生成器无漂移**：磁盘上的 preset == `tools/gen-preset.mjs` 的渲染结果（有手改即 FAIL）
//   5) 外部事实：order 69 未被同族其它 bundle 占用 **且** 67/68 确实已被占用（现场扫描，不写死结论）；
//      web profile 是否已接线（**未安装即 FAIL**——这条在 install_bundle 之前必然是红的，属预期）
//
// 用法：node tools/ard-check.mjs [--bundle <目录>] [--authority <交付包路径>] [--no-authority]
//   退出码：全绿 0，有 FAIL 1。
//   --no-authority：在没有交付包的机器上跳过「逐字一致 / 生成器无漂移 / order 现场扫描 / 接线核对」四组
//   （既不记通过也不记失败），并在结尾打印 SKIP 原因。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLE_ROOT,
  DEFAULT_AUTHORITY,
  PRESET_PATH,
  extractPersona,
  extractRoleGroup,
  renderPreset,
} from './gen-preset.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const passed = []
const failures = []
const skips = []
const ok = (label) => passed.push(label)
const fail = (label, detail) => failures.push(detail === undefined ? label : `${label} — ${detail}`)
const skip = (label, detail) => skips.push(`${label}：${detail}`)
const check = (condition, label, detail) => (condition ? ok(label) : fail(label, detail))

const args = process.argv.slice(2)
const argValue = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const bundleRoot = resolve(argValue('--bundle') ?? BUNDLE_ROOT)
const authorityPath = resolve(argValue('--authority') ?? DEFAULT_AUTHORITY)
const withAuthority = !args.includes('--no-authority')
const presetPath = join(bundleRoot, 'presets', 'art-director.patch.yml')
const read = (path) => readFileSync(path, 'utf8')

const checkout = process.env.DSH_CHECKOUT ?? 'C:/code/deepseek-harness'
const yaml = createRequire(`${checkout.replace(/\\/g, '/')}/package.json`)('js-yaml')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

// ────────────────────────────────────────────────────────── 1. 文件齐备
const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'INSTALL.md',
  'NOTICE.md',
  'license/agency-agents.LICENSE',
  'presets/art-director.patch.yml',
  'tools/gen-preset.mjs',
  'tools/ard-check.mjs',
]
for (const file of REQUIRED_FILES) check(existsSync(join(bundleRoot, file)), `文件齐备：${file}`)

// ────────────────────────────────────────────────────────── 2. package.json
let manifest = null
try {
  manifest = JSON.parse(read(join(bundleRoot, 'package.json')))
  ok('package.json 是合法 JSON')
} catch (error) {
  fail('package.json 是合法 JSON', String(error))
}
if (manifest !== null) {
  check(manifest.name === 'dsh-art-director', 'package name = dsh-art-director', `实得 ${manifest.name}`)
  check(manifest.version === '0.1.0', 'package version = 0.1.0', `实得 ${manifest.version}`)
  check(manifest.type === 'module', 'package type = module', `实得 ${manifest.type}`)
  check(
    Object.keys(manifest.dependencies ?? {}).length === 0 &&
      Object.keys(manifest.peerDependencies ?? {}).length === 0,
    '无运行依赖（dsh 包从安装目录解析）',
  )
  const patches = manifest.dsh?.bundle?.patch
  const list = Array.isArray(patches) ? patches : patches === undefined ? [] : [patches]
  check(
    list.length === 1 && list[0] === './presets/art-director.patch.yml',
    'dsh.bundle.patch 只声明本包 preset',
    JSON.stringify(patches),
  )
  for (const file of ['README.md', 'INSTALL.md', 'NOTICE.md', 'presets', 'tools', 'license']) {
    check(manifest.files?.includes(file) === true, `package files 列出 ${file}`)
  }
  check(typeof manifest.description === 'string' && manifest.description.length > 20, 'package description 非空')
}

// ────────────────────────────────────────────────────────── 3. preset 结构契约
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __jsExpr: String(data) }),
})
let config = null
if (existsSync(presetPath)) {
  let doc = null
  try {
    doc = yaml.load(read(presetPath), { schema: yaml.DEFAULT_SCHEMA.extend([jsTag]) })
    ok('preset patch 能被 YAML 解析')
  } catch (error) {
    fail('preset patch 能被 YAML 解析', String(error))
  }
  if (doc !== null) {
    check(Array.isArray(doc) && doc.length === 1, 'patch 文档只有一条顶层条目')
    const insert = doc[0]?.insert
    check(Array.isArray(insert) && insert.length === 1, 'patch 恰好插入一行')
    const row = insert?.[0]
    check(row?.id === 'preset-art-director', `loader 行 id = ${row?.id}`)
    check(row?.name === '@deepseek-ai/dsh-agent-preset', `行挂 dsh-agent-preset（实得 ${row?.name}）`)
    check(!doc.some((entry) => entry?.id === 'agent-preset-registry'), '不覆盖 agent-preset-registry 的默认项')
    config = row?.config
  }
}

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
const TRIMMED_ROWS = ['delegation', 'planning', 'tool-goal', 'command-goal', 'tool-schedule', 'skill-filesystem', 'tool-skill', 'tool-plugin-manager']

if (config !== null) {
  const rows = config.plugins ?? []
  const ids = rows.map((entry) => entry.id)
  const row = (id) => rows.find((entry) => entry.id === id)

  check(config.id === 'art-director', `preset id = ${config.id}`)
  check(config.name === '维奥拉 · 美术总监', `preset 显示名 = ${config.name}`)
  check(typeof config.description === 'string' && config.description.length > 0, `preset 描述 = ${config.description}`)
  check(config.order === 69, `order = 69（67 被 godot-tech-director、68 被 producer 占用，实得 ${config.order}）`)
  check(JSON.stringify(ids) === JSON.stringify(EXPECTED_ROWS), `行集与顺序 = ${ids.length} 行`, ids.join(','))
  check(new Set(ids).size === ids.length, '行 id 唯一')
  for (const trimmed of TRIMMED_ROWS) check(!ids.includes(trimmed), `已裁掉 ${trimmed} 行`)

  const persona = row('persona')?.config ?? {}
  check(row('persona')?.name === '@deepseek-ai/dsh-persona', 'persona 行挂 dsh-persona')
  check(
    typeof persona.prefix === 'string' && persona.prefix.length > 3000,
    `persona prefix 长度 = ${persona.prefix?.length}（§3 正文为 4.6 K 字符量级）`,
  )
  check(typeof persona.prefix === 'string' && !persona.prefix.includes('{{'), 'persona prefix 不含提示词模板组')
  check(typeof persona.prefix === 'string' && !/^\\?-{3}/.test(persona.prefix), 'persona prefix 不以转义围栏开头')
  check(typeof persona.suffix === 'string' && persona.suffix.includes('{{cwd}}'), 'persona suffix 保留 {{cwd}} 事实')
  check(
    typeof persona.suffix === 'string' && persona.suffix.includes('Godot_v4.7.2-stable_win64') && persona.suffix.includes('不要臆造版本号'),
    'suffix 带本机 Godot 可执行文件事实且不放弃「先列目录确认」',
  )
  check(
    typeof persona.suffix === 'string' && !persona.suffix.includes('不要臆造版本号；引擎行为主张'),
    'suffix 不重复 §3 已经写明的引擎行为取证要求（只补 {{cwd}} 与本机事实）',
  )

  check(row('agent-instructions')?.config?.maxBytes === 65536, 'agent-instructions maxBytes = 65536')
  check(row('time-context')?.name === '@deepseek-ai/dsh-time-context', 'time-context 行在册')
  check(row('tool-bash')?.disabled?.__jsExpr === "process.platform === 'win32'", 'tool-bash 在 Windows 上禁用')
  check(row('tool-pwsh')?.disabled?.__jsExpr === "process.platform !== 'win32'", 'tool-pwsh 在非 Windows 上禁用')
  check(row('tool-fs')?.name === '@deepseek-ai/dsh-tool-fs', 'tool-fs 行在册')
  check(
    row('tool-fs-search')?.config?.sampleOverCapGlobResults === false,
    'tool-fs-search 带必填 Config sampleOverCapGlobResults（漏掉即整条 preset broken）',
  )
  check(row('tool-jobs')?.name === '@deepseek-ai/dsh-tool-jobs', 'tool-jobs 行在册')
  check(
    row('compaction')?.group === true &&
      row('compaction')?.config?.length === 3 &&
      row('compaction')?.isolate?.compaction === true &&
      row('compaction')?.isolate?.toolResultPruner === true,
    'compaction 组 = 3 成员 + 两个 isolate 标志',
  )
  check(row('tool-ask-user')?.name === '@deepseek-ai/dsh-tool-ask-user', 'tool-ask-user 行在册')
  check(row('tool-todo')?.config?.allowParallelInProgress === true, 'tool-todo 保留 allowParallelInProgress')
  check(
    row('tool-web')?.config?.fetch === true && row('tool-web')?.config?.searchTimeoutMs === 60000,
    'tool-web 与 standard 基线逐字段一致',
  )
  check(row('present')?.name === '@deepseek-ai/dsh-tool-present', 'present 行在册')

  const roleSection = row('requirement-board-role')
  const board = roleSection?.config?.[0]?.config
  check(roleSection?.name === 'cordis:group' && roleSection?.group === true, '角色声明是 cordis:group')
  check(roleSection?.isolate?.requirementBoardRole === true, '角色声明包在 requirementBoardRole isolate 组内')
  check(roleSection?.config?.[0]?.name === 'dsh-requirement-board/role', 'board-role 行挂 dsh-requirement-board/role')
  check(board?.roleId === 'art-director', `角色 id = ${board?.roleId}`)
  check(board?.roleName === '维奥拉 · 美术总监', `角色显示名 = ${board?.roleName}`)
  check(Array.isArray(board?.duties) && board.duties.length === 7, `duties 恰好 7 条（实得 ${board?.duties?.length}，上限 12）`)
  check(
    Array.isArray(board?.duties) && board.duties.every((duty) => typeof duty === 'string' && duty.length <= 40),
    '每条 duty ≤ 40 字',
  )
  check(/^[a-z][a-z0-9_-]{0,31}$/.test(board?.roleId ?? ''), 'roleId 形状合法')
  check((board?.roleName ?? '').length <= 40, 'roleName ≤ 40 字')
  check(board?.roleId === config.id, 'roleId 与 preset id 一致（看板按 id 路由）')
  check(board?.roleName === config.name, 'roleName 与 preset 显示名一致')
}

// !!js 只允许出现在列表项与 disabled 上。
if (existsSync(presetPath)) {
  const lines = read(presetPath).split('\n')
  const bad = []
  lines.forEach((line, index) => {
    if (!line.includes('!!js')) return
    const trimmed = line.trim()
    if (!(trimmed.startsWith('- !!js') || /^disabled: !!js/.test(trimmed))) bad.push(`第 ${index + 1} 行`)
  })
  check(bad.length === 0, '!!js 只出现在允许的位置', bad.join('、'))
  check(!/(?<!!)!js/.test(read(presetPath).replace(/!!js/g, '')), '!!js 写法正确（无单感叹号 !js）')
}

// ────────────────────────────────────────────────────────── 4. 与交付包逐字一致 + 生成器无漂移
if (withAuthority) {
  if (!existsSync(authorityPath)) {
    fail('交付包可读', `${authorityPath} 不存在（用 --authority 指定，或 --no-authority 跳过本组）`)
  } else {
    const authority = read(authorityPath)
    ok('交付包可读')
    let authoritativePersona = null
    let authoritativeRole = null
    try {
      authoritativePersona = extractPersona(authority)
      authoritativeRole = extractRoleGroup(authority)
      ok('交付包 §1 与 §3 可解析')
    } catch (error) {
      fail('交付包 §1 与 §3 可解析', String(error))
    }
    // 生成器的默认交付包绝对路径必须指向本包的权威文档（环境变量 ARD_AUTHORITY 可覆盖）。
    const expectedDefault = resolve(
      process.env.ARD_AUTHORITY ??
        'D:/Godot/projects/dndGame/production/presets/art-director-交付包.md',
    )
    if (authorityPath === expectedDefault) {
      check(
        resolve(DEFAULT_AUTHORITY) === expectedDefault,
        `生成器默认交付包路径 = ${DEFAULT_AUTHORITY}`,
      )
    } else {
      skip('生成器默认交付包路径断言', `本次用 --authority 指定了别的文档（${authorityPath}），不适用`)
    }
    check(!authority.includes('%USERPROFILE%'), '交付包不含 %USERPROFILE% 机器路径', '%USERPROFILE%')
    if (authoritativePersona !== null && config !== null) {
      const prefix = config.plugins.find((entry) => entry.id === 'persona')?.config?.prefix
      check(prefix === authoritativePersona, `persona 与交付包 §3 正文逐字一致（${authoritativePersona.length} 字）`)
    }
    if (authoritativeRole !== null && config !== null) {
      const board = config.plugins.find((entry) => entry.id === 'requirement-board-role')?.config?.[0]?.config
      check(board?.roleId === authoritativeRole.roleId, 'roleId 与 §1 逐字一致')
      check(board?.roleName === authoritativeRole.roleName, 'roleName 与 §1 逐字一致')
      check(
        Array.isArray(board?.duties) && board.duties.length === authoritativeRole.duties.length,
        `duties 条数与 §1 一致 = ${authoritativeRole.duties.length}`,
      )
      authoritativeRole.duties.forEach((duty, index) => {
        check(board?.duties?.[index] === duty, `duty[${index}] 与 §1 逐字一致：${duty}`)
      })
    }
    if (authoritativePersona !== null) {
      const regenerated = renderPreset(authority)
      check(regenerated === read(presetPath), 'preset 与生成器输出逐字节一致（无手改漂移）')
    }
    // 载重小节必须真的在 persona 里（防止「对上了但内容被掏空」）。
    if (authoritativePersona !== null && config !== null) {
      const prefix = config.plugins.find((entry) => entry.id === 'persona')?.config?.prefix ?? ''
      for (const marker of [
        '# 美术总监 - 维奥拉',
        '风格不是感觉，是可以被写成规则、被执行、被验收的东西',
        '## 项目锚定',
        '美术资源规划-v1.md',
        '核芯判断',
        'A1 = 47 张 · 总 165 张',
        '## 核心能力',
        '## 工作流程',
        '## 输出规范',
        '**⑨ AI 生成素材规范与来源合规**',
        '`NOT ASSESSED`（证据不足 —— 不得静默通过，也不得记 PASS）',
        '说不出锚 ⇒ 不许裁定',
        '## 注意事项',
        '视觉归你，可用性归她',
        '不可判定的形容词一律不许进规范',
      ]) {
        check(prefix.includes(marker), `persona 含载重段落标记：${marker}`)
      }
      // §4 变更 #3 要求清掉 3D 语境残留；这两处只能以「本项目是 2D、不写这些指标」的形式出现。
      check(
        !prefix.includes('PBR 参数范围') && !/规格（[^）]*面数/.test(prefix),
        'persona 不带 3D 指标残留（面数 / PBR 参数范围）',
      )
      // §4 变更 #2 的项目事实必须在 persona 里，而不是只写在交付包的说明文字里。
      for (const fact of [
        '0.0188／0.0223',
        '0.254／0.219',
        'A1 = 47 张 · 总 165 张',
        'iso-grid-and-pathfinding.md',
        'Linear ＋ 开启 mipmaps',
        'entities.yaml',
        '127.0.0.1:8188',
      ]) {
        check(prefix.includes(fact), `persona 含交付包 §4 点名的项目事实：${fact}`)
      }
    }
  }

  // order 现场扫描（不写死结论）：69 必须空着，67/68 必须真的已被占用。
  const siblingRoots = [join(checkout, 'bundles'), join(process.env.USERPROFILE ?? '', '.dsh', 'bundles')]
  const orders = new Map()
  const selfEntry = 'dsh-art-director/art-director.patch.yml'
  for (const root of siblingRoots) {
    if (!existsSync(root)) continue
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const presetDir = join(root, dir.name, 'presets')
      if (!existsSync(presetDir)) continue
      for (const file of readdirSync(presetDir)) {
        if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
        const text = read(join(presetDir, file))
        for (const match of text.matchAll(/^\s+order: (\d+)$/gm)) {
          const key = Number(match[1])
          orders.set(key, [...(orders.get(key) ?? []), `${dir.name}/${file}`])
        }
      }
    }
  }
  const listAt = (value) => orders.get(value) ?? []
  const clash = listAt(69).filter((entry) => entry !== selfEntry)
  check(clash.length === 0, 'order 69 未被同族其它 bundle 占用', clash.join('、'))
  check(listAt(69).includes(selfEntry), '现场扫描到本包自己的 order 69')
  check(listAt(67).length > 0, 'order 67 现场确有占用（godot-tech-director）', listAt(67).join('、'))
  check(listAt(68).length > 0, 'order 68 现场确有占用（producer）', listAt(68).join('、'))
  ok(`同族 order 现场快照：${[...orders.keys()].sort((a, b) => a - b).join(', ')}`)

  // web profile 接线：读**当下**的接线状态并断言其自洽（既报事实、也拦半接线）。
  //   未安装 → 两条都红（这是**预期**的红：安装归主会话，本施工会话被禁止安装）；
  //   已安装 → 两条都绿。**不要为了让脚本变绿而删掉这两条断言**——它们是「装上了没有」的唯一静态证据。
  const profileManifest = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'package.json')
  if (existsSync(profileManifest)) {
    const text = read(profileManifest)
    let profile = null
    try {
      profile = JSON.parse(text)
      ok('web profile package.json 可解析')
    } catch (error) {
      fail('web profile package.json 可解析', String(error))
    }
    const linked = Object.keys(profile?.dependencies ?? {}).includes('dsh-art-director')
    const listed = profile?.dsh?.profile?.bundles?.includes('dsh-art-director') === true
    if (linked && listed) {
      ok('web profile 已接线 dsh-art-director：link 依赖 ＋ dsh.profile.bundles 都在（检测到已安装）')
      ok('web profile 接线自洽（依赖与 bundles 列表成对出现）')
    } else if (!linked && !listed) {
      fail('web profile 未接线 dsh-art-director', '未安装 ⇒ 预期红：需主会话 install_bundle；装完这两条自动转绿')
    } else {
      fail(
        'web profile 接线自洽（依赖与 bundles 列表成对出现）',
        `半接线：link 依赖=${linked} · dsh.profile.bundles=${listed}`,
      )
    }
  } else {
    fail('查得到 web profile', `未找到 ${profileManifest}（接线无从核对）`)
  }
} else {
  skip('交付包逐字组 / 生成器无漂移 / order 现场扫描 / 接线核对', '--no-authority：整组跳过（不计通过、不计失败）')
}

// ────────────────────────────────────────────────────────── 5. 文本卫生
const TEXT_EXTENSIONS = ['.md', '.yml', '.yaml', '.mjs', '.json', '.LICENSE']
const targets = walk(bundleRoot).filter(
  (path) => TEXT_EXTENSIONS.includes(path.slice(path.lastIndexOf('.'))) || path.endsWith('agency-agents.LICENSE'),
)
let bom = 0
let newline = 0
let mojibake = 0
let crlf = 0
const residues = []
const dangling = []
const leaks = []
// 残渣词表拆开拼，免得本文件自己的字面量命中自己；tools/ 不参与残渣扫描——
// 生成器必须逐字持有 `__PERSONA__` / `__ROLE_GROUP__` 这两个占位符（它就是干这个的）。
const residuePattern = new RegExp([`${'TO'}${'DO'}`, `${'FIX'}${'ME'}`, 'X'.repeat(3), `${'（'}待补${'）'}`, '\\?\\?\\?', '__PERSONA__', '__ROLE_GROUP__'].join('|'))
// 机器路径泄漏：禁止**带文件名**的仓库外绝对路径与用户目录记号（裸盘符根如 persona 里的 `D:\image` 不算）。
// 末段用 `+` 吃掉全部路径段、字符类排除空白与标点，免得命中被后续正文（或中文目录名）带偏。
const MACHINE_PATH_PATTERN = /(?:[A-Za-z]:\\|%USERPROFILE%\\)[^\\\s`（），。:;"'<>|]*\\[^\\\s`（），。:;"'<>|]+\.[A-Za-z0-9]{1,8}/g
// 本包允许出现的绝对路径前缀：bundle 自身、checkout、交付包、本机 Godot 可执行文件、profile 目录。
// `%USERPROFILE%\…` 形式不经此白名单（它是可移植占位符，不写死用户目录名）。
const ALLOWED_PATH_PREFIXES = [
  'C:\\code\\deepseek-harness',
  'D:\\Godot\\projects\\dndGame',
  'D:\\Godot\\Godot_v4.7.2-stable_win64',
  'C:\\Users\\Administrator\\.dsh\\',
]
const PROFILE_PLACEHOLDER = '%USERPROFILE%\\'
/** 命中串可能被后续正文吸附（如「…\package.json`」），按空白/点号切出候选，取最长的白名单前缀判定。 */
function isAllowedMachinePath(hit) {
  if (hit.startsWith(PROFILE_PLACEHOLDER)) return true
  const candidates = [hit]
  for (let index = 1; index < hit.length - 1; index += 1) {
    if (hit[index] === ' ' || hit[index] === '.') candidates.push(hit.slice(0, index))
  }
  return candidates.some((candidate) => ALLOWED_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix)))
}
for (const path of targets) {
  const text = read(path)
  const label = relative(bundleRoot, path).split(sep).join('/')
  const inTools = path.startsWith(join(bundleRoot, 'tools'))
  if (text.charCodeAt(0) === 0xfeff) {
    bom += 1
    fail(`无 BOM：${label}`)
  }
  if (!text.endsWith('\n') || text.endsWith('\n\n')) {
    newline += 1
    fail(`文件尾恰好一个换行：${label}`)
  }
  if (text.includes('\uFFFD')) {
    mojibake += 1
    fail(`无乱码替换字符：${label}`)
  }
  if (text.includes('\r')) {
    crlf += 1
    fail(`行尾只有 LF（无 CR）：${label}`)
  }
  if (!inTools && residuePattern.test(text)) residues.push(`${label}（${residuePattern.exec(text)[0]}）`)
  for (const match of text.matchAll(MACHINE_PATH_PATTERN)) {
    const hit = match[0]
    if (!isAllowedMachinePath(hit)) leaks.push(`${label}（${hit}）`)
  }
  const linkSource = text.replace(/`[^`\n]*`/g, '')
  for (const match of linkSource.matchAll(/\]\(([^)#\s]+)\)/g)) {
    const href = match[1]
    if (/^[a-z]+:/i.test(href) || href.startsWith('#')) continue
    if (!existsSync(resolve(dirname(path), decodeURIComponent(href)))) dangling.push(`${label} → ${href}`)
  }
}
if (bom === 0) ok('全部文本文件无 BOM')
if (newline === 0) ok('全部文本文件尾恰好一个换行')
if (mojibake === 0) ok('全部文本文件无乱码替换字符')
if (crlf === 0) ok('全部文本文件行尾只有 LF')
check(residues.length === 0, '无占位残渣（占位记号 / 待办字样）', residues.join('；'))
check(dangling.length === 0, '无悬空相对链接', dangling.join('；'))
check(leaks.length === 0, '无机器路径泄漏（仓库外绝对路径 / 用户目录）', leaks.join('；'))

// 第三方许可必须随包（MIT 的版权与许可声明要跟着副本走）。
const licensePath = join(bundleRoot, 'license', 'agency-agents.LICENSE')
if (existsSync(licensePath)) {
  const license = read(licensePath)
  check(license.includes('MIT License') && license.includes('msitarzewski'), '随包许可原文含 MIT 与版权行')
}

// ────────────────────────────────────────────────────────── 输出
process.stdout.write(`ard-check · bundle 根：${bundleRoot}\n`)
process.stdout.write(`交付包：${withAuthority ? authorityPath : '（--no-authority，跳过）'}\n`)
if (existsSync(presetPath)) {
  const presetText = read(presetPath)
  const presetBytes = Buffer.byteLength(presetText, 'utf8')
  process.stdout.write(`preset：${presetText.length} 字符 / ${presetText.split('\n').length - 1} 行 / ${presetBytes} 字节\n`)
}
process.stdout.write(`通过 ${passed.length} 项\n`)
for (const item of skips) process.stdout.write(`  SKIP ${item}\n`)
if (failures.length === 0) process.stdout.write('全部契约检查通过。\n')
else {
  process.stdout.write(`FAIL ${failures.length} 项：\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
}
process.exitCode = failures.length === 0 ? 0 : 1
