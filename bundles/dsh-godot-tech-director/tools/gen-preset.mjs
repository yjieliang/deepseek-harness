// 从交付包生成 presets/godot-tech-director.patch.yml：persona 用 §4 正文、角色声明用 §1 组，逐字不改。
//
// 为什么用生成器而不是手抄：这份 persona 有 180 行，交付包 §2 要求「照 standard 基线逐字段一致」、
// §4 要求「整段放进 persona.prefix」。手抄一遍就等于引入一次转写误差，而误差不会报错——
// 它只会让预设看起来正常、内容悄悄变了。生成器把「逐字」变成可再执行的动作，
// tools/gtd-check.mjs 再断言「生成器输出 == 磁盘上的文件」（有漂移即 FAIL）。
//
// 用法：node tools/gen-preset.mjs [--write] [--authority <交付包路径>]
//   默认只把生成结果写到 stdout；--write 才覆盖 preset 文件。
//   交付包路径默认取 GTD_AUTHORITY 环境变量，再回落 D:/Godot/projects/dndGame/production/presets/godot-tech-director-交付包.md。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BUNDLE_ROOT = resolve(HERE, '..')
export const PRESET_PATH = join(BUNDLE_ROOT, 'presets', 'godot-tech-director.patch.yml')
export const DEFAULT_AUTHORITY =
  process.env.GTD_AUTHORITY ??
  'D:/Godot/projects/dndGame/production/presets/godot-tech-director-交付包.md'

/** 取 js-yaml：借 dsh checkout 的依赖，本包自身零依赖。 */
function loadYaml() {
  const checkout = process.env.DSH_CHECKOUT ?? 'C:/code/deepseek-harness'
  return createRequire(`${checkout.replace(/\\/g, '/')}/package.json`)('js-yaml')
}

/** 去掉每行公共缩进，丢弃首尾空行。 */
function dedent(lines) {
  const kept = [...lines]
  while (kept.length > 0 && kept[0].trim() === '') kept.shift()
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  const indents = kept.filter((line) => line.trim() !== '').map((line) => line.match(/^ */)[0].length)
  const min = Math.min(...indents)
  return kept.map((line) => (line.trim() === '' ? '' : line.slice(min)))
}

/** 取「## <编号>.」标题之后第一条以 <fence> 开头的围栏，返回围栏内各行。 */
function fencedBlock(lines, sectionPrefix, fence) {
  const header = lines.findIndex((line) => line.startsWith(sectionPrefix))
  if (header < 0) throw new Error(`未找到小节：${sectionPrefix}`)
  const open = lines.indexOf(fence, header)
  if (open < 0) throw new Error(`${sectionPrefix} 里未找到 ${fence} 围栏`)
  const close = lines.indexOf('```', open + 1)
  if (close < 0) throw new Error(`${sectionPrefix} 的围栏没有收尾行`)
  return lines.slice(open + 1, close)
}

/**
 * 取 §4 的 persona 正文。
 * 正文内部含一段 ``` 代码块（TD 验收签注样例），所以不能取「第一个 ``` 收尾」——
 * 改从下一节标题（## 5.）往回找最近的收尾围栏。
 */
export function extractPersona(authority) {
  const lines = authority.split(/\r?\n/)
  const header = lines.findIndex((line) => line.startsWith('## 4. 改好的 persona 正文'))
  if (header < 0) throw new Error('未找到 §4 标题（## 4. 改好的 persona 正文）')
  const open = lines.indexOf('```markdown', header)
  if (open < 0) throw new Error('§4 里未找到 ```markdown 围栏')
  const next = lines.findIndex((line, index) => index > open && /^## 5\./.test(line))
  if (next < 0) throw new Error('§4 之后未找到 ## 5. 小节标题')
  let close = -1
  for (let index = next - 1; index > open; index -= 1) {
    if (lines[index].trim() === '```') {
      close = index
      break
    }
  }
  if (close < 0) throw new Error('§4 的 persona 围栏没有收尾行')
  const body = `${lines
    .slice(open + 1, close)
    .join('\n')
    .replace(/\s+$/, '')}\n`
  if (body.trim() === '') throw new Error('§4 的 persona 正文为空')
  return body
}

/** 取 §1 的角色声明组（文本行 ＋ 解析出的 roleId/roleName/duties）。 */
export function extractRoleGroup(authority) {
  const lines = authority.split(/\r?\n/)
  const block = dedent(fencedBlock(lines, '## 1. 要补的第 1 件', '```yaml'))
  const doc = loadYaml().load(block.join('\n'))
  const group = Array.isArray(doc) ? doc[0] : doc
  if (group?.id !== 'requirement-board-role') throw new Error(`§1 首行不是 requirement-board-role（实得 ${group?.id}）`)
  if (group.name !== 'cordis:group' || group.group !== true) throw new Error('§1 的角色声明组不是 cordis:group')
  if (group.isolate?.requirementBoardRole !== true) throw new Error('§1 的角色声明组缺 isolate.requirementBoardRole')
  const board = Array.isArray(group.config) ? group.config[0] : undefined
  if (board?.name !== 'dsh-requirement-board/role') throw new Error('§1 的 board-role 行未挂 dsh-requirement-board/role')
  const config = board.config ?? {}
  if (typeof config.roleId !== 'string' || typeof config.roleName !== 'string') throw new Error('§1 缺 roleId / roleName')
  if (!Array.isArray(config.duties) || config.duties.length === 0) throw new Error('§1 的 duties 为空')
  return { lines: block, roleId: config.roleId, roleName: config.roleName, duties: config.duties }
}

/** preset 骨架：persona 与角色声明两处由交付包填充，其余行照 standard 基线逐字段一致。 */
const TEMPLATE = `- insert:
    - id: preset-godot-tech-director
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: godot-tech-director
        name: 权衡 · 技术总监 · Godot 专家
        description: 架构与引擎版本终裁 / 性能预算裁定 / ADR 验收签注 / 技术门控与豁免
        order: 67
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
__PERSONA__
              suffix: |
                当前工作目录：{{cwd}}
                本机已装 Godot（未加入 PATH）：D:\\Godot\\ 下有 Godot_v4.7.2-stable_win64.exe 与 Godot_v4.7.2-stable_win64_console.exe（本项目 project.yaml 的 engine.path 就指向前者）。调用前先列目录确认真实文件名，不要臆造版本号；引擎行为主张必须能指到实测，不得凭记忆断言 API。
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              # 必填字段。漏掉它会让这一行激活失败，进而让整条 preset 变 broken（同族预设 2026-09-30 实测踩过）。
              sampleOverCapGlobResults: false
          - id: tool-jobs
            name: '@deepseek-ai/dsh-tool-jobs'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024
          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config:
              allowParallelInProgress: true
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 60000
          - id: present
            name: '@deepseek-ai/dsh-tool-present'
          # 角色声明（ROLE-DISPATCH §2.3）：必须包在 isolate 组里；直接 provide 会把服务发布到进程全局，
          # 注册表随即把整条 preset 判为 broken。声明随包走，单点真相，不在 profile 层再重述一遍。
__ROLE_GROUP__
`

/** 交付包正文 → preset patch 全文（以换行收尾，恰好一个）。 */
export function renderPreset(authority) {
  const persona = extractPersona(authority)
  const role = extractRoleGroup(authority)
  const personaBlock = persona
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `${' '.repeat(16)}${line}`))
    .join('\n')
  const roleBlock = role.lines.map((line) => (line.trim() === '' ? '' : `${' '.repeat(10)}${line}`)).join('\n')
  const rendered = TEMPLATE.replace('__PERSONA__', personaBlock).replace('__ROLE_GROUP__', roleBlock)
  return `${rendered.replace(/\s+$/, '')}\n`
}

/** 读交付包；读不到就抛出，交由调用方决定是 FAIL 还是跳过。 */
export function readAuthority(path = DEFAULT_AUTHORITY) {
  return readFileSync(path, 'utf8')
}

function main() {
  const args = process.argv.slice(2)
  const authorityIndex = args.indexOf('--authority')
  const authorityPath = authorityIndex >= 0 ? args[authorityIndex + 1] : DEFAULT_AUTHORITY
  const rendered = renderPreset(readAuthority(authorityPath))
  if (args.includes('--write')) {
    mkdirSync(dirname(PRESET_PATH), { recursive: true })
    writeFileSync(PRESET_PATH, rendered, 'utf8')
    process.stdout.write(`wrote ${PRESET_PATH} (${rendered.length} chars)\n`)
    return
  }
  process.stdout.write(rendered)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
