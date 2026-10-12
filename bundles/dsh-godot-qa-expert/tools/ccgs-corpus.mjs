#!/usr/bin/env node
// CCGS 框架语料解析器（R2）。
//
// 用途：本预设的 references 与 dsh-ccgs-studio 的技能都要按框架语料里的文档逐门核对
// （门控准入、rigor 正文、目录契约、project.yaml 的权威拼写）。语料是**本机事实**，
// 换机器就可能不在。散文写「找不到就记 NOT ASSESSED」挡不住静默：人不读那句话，
// 模型也可能靠记忆补正。本脚本把这件事变成一条可打印、可核对的证据行。
//
// 规格来源：本包 `references/06-framework-corpus.md` §一（解析顺序）与 §二（哪份文档管什么）。
//
// 契约：正常模式下**永远以 0 退出，并永远输出完整块**（与 R1 的 ccgs-config.mjs 同族，
// 理由相同：解析失败不该看起来像崩溃）。`--strict` 在未解析成功时以 1 退出，供 CI 调用。
// 只有 `--selftest` 在断言失败时以 1 退出（那是测试通道，不是解析通道）。
//
// 关键设计决定：`CCGS_ESSENCE_DIR` **设了但无效时不回落到默认路径**。设错的覆盖是配置
// 错误，静默回落会把它藏起来——那正是本包要消灭的那类失败。
//
// 用法：
//   node tools/ccgs-corpus.mjs
//   node tools/ccgs-corpus.mjs --strict
//   node tools/ccgs-corpus.mjs --selftest

import { statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import process from 'node:process'

// ---------------------------------------------------------------- 规格表

/** 语料根的回落路径（本机事实，2026-10-11 核实存在且非空）。 */
const FALLBACK_ROOT = 'D:\\AI\\test\\ccgs-essence'

const ENV_VAR = 'CCGS_ESSENCE_DIR'

/** 未解析出来时写进产物里的那句话，逐字固定。 */
const NOT_ASSESSED = 'NOT ASSESSED — framework corpus unresolved'

/** 被本预设引用的语料文档（`06-framework-corpus.md` §二 的清单）。缺哪份点名哪份。 */
const CITED_DOCS = [
  '01-设计理念/05-配置解析.md',
  '01-设计理念/06-导演门控.md',
  '01-设计理念/04-rigor档位.md',
  '01-设计理念/03-自动化模式.md',
  '02-流程/项目目录结构.md',
  '04-参考/效果映射索引.md',
  '05-上游对照表.md',
]

/** 根下必须存在的子目录。`03-技能` 只要求存在、**不挂载**（与 dsh-ccgs-studio/skills 同名同源）。 */
const REQUIRED_SUBDIRS = ['01-设计理念', '02-流程', '03-技能', '04-参考']

const MOUNT_POLICY =
  '不挂载 03-技能（与 dsh-ccgs-studio/skills 同名同源，遮蔽语义未验证，不去碰这个不确定性）'

// ---------------------------------------------------------------- 探针

/** 路径不存在、或存在但不是目录，都算「不是目录」。 */
function defaultIsDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    // 不存在 / 权限不足 / 路径非法：调用方只需要一个布尔，三种情况都按「不可用」处理。
    return false
  }
}

/** 路径不存在、或存在但不是普通文件，都算「不是文件」。 */
function defaultIsFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    // 同上：不可用即不可用，具体原因由调用方在 notes 里点名路径。
    return false
  }
}

// ---------------------------------------------------------------- 解析

/**
 * 解析语料根并核对被引用的文档与子目录。
 *
 * @param {object} [probes] 注入点（自测用，避免依赖真实磁盘）。
 * @param {object} [probes.env] 环境变量表；默认 `process.env`。
 * @param {(path: string) => boolean} [probes.isDir] 目录判定。
 * @param {(path: string) => boolean} [probes.isFile] 文件判定。
 * @returns {object} 解析结果：`root`（未解析出为 `null`）、`source`、`notes`、`missingDocs`、`missingSubdirs`、`presentDocs`。
 */
export function resolveCorpus(probes = {}) {
  const env = probes.env ?? process.env
  const isDir = probes.isDir ?? defaultIsDir
  const isFile = probes.isFile ?? defaultIsFile

  const raw = env[ENV_VAR]
  const override = typeof raw === 'string' ? raw.trim() : ''

  let root = null
  let source = 'unresolved'
  const notes = []

  if (override) {
    // 去掉尾部分隔符，让打印出来的根路径是规范形态（`D:/x/` 与 `D:\x` 应打印成同一个）。
    // `normalize` 会保留尾部分隔符，所以这一步必须在 normalize 之前做。
    const candidate = override.replace(/[\\/]+$/, '') || override
    if (!isDir(candidate)) {
      notes.push(
        `${ENV_VAR} 指向的目录不存在：${candidate}；**不回落**到 ${FALLBACK_ROOT}（设错的覆盖是配置错误，静默回落会把它藏起来）`,
      )
    } else {
      root = normalize(candidate)
      source = 'env'
    }
  } else if (isDir(FALLBACK_ROOT)) {
    root = FALLBACK_ROOT
    source = 'fallback'
  } else {
    notes.push(`${ENV_VAR} 未设置，回落实测路径也不存在：${FALLBACK_ROOT}`)
  }

  if (!root) {
    return {
      root: null,
      source,
      notes,
      missingDocs: [],
      missingSubdirs: [],
      presentDocs: 0,
      totalDocs: CITED_DOCS.length,
    }
  }

  const missingSubdirs = REQUIRED_SUBDIRS.filter((name) => !isDir(join(root, name)))
  const missingDocs = CITED_DOCS.filter((name) => !isFile(join(root, name)))

  if (missingSubdirs.length > 0) notes.push(`缺子目录：${missingSubdirs.join('、')}`)
  if (missingDocs.length > 0) notes.push(`缺被引文档：${missingDocs.join('、')}`)

  return {
    root,
    source,
    notes,
    missingDocs,
    missingSubdirs,
    presentDocs: CITED_DOCS.length - missingDocs.length,
    totalDocs: CITED_DOCS.length,
  }
}

// ---------------------------------------------------------------- 输出块

/**
 * 把解析结果格式化成可逐字贴进报告的块。
 *
 * @param {object} result `resolveCorpus` 的返回值。
 * @returns {string} 多行块，末尾无换行。
 */
export function formatBlock(result) {
  const lines = ['=== CCGS Framework Corpus ===']

  if (result.root) {
    const label = result.source === 'env' ? ENV_VAR : 'fallback'
    lines.push(`corpus_root: ${result.root} (${label})`)
    lines.push(
      `source: ${result.source} (${result.source === 'env' ? `${ENV_VAR} 显式指定` : `${ENV_VAR} 未设置`})`,
    )
    lines.push(
      `required_subdirs: ${REQUIRED_SUBDIRS.length - result.missingSubdirs.length}/${REQUIRED_SUBDIRS.length} present`,
    )
    lines.push(`cited_docs: ${result.presentDocs}/${result.totalDocs} present`)
    const missing = [...result.missingSubdirs, ...result.missingDocs]
    lines.push(`missing: ${missing.length === 0 ? 'none' : missing.join('、')}`)
  } else {
    lines.push('corpus_root: unresolved')
    lines.push(`source: unresolved (${result.notes[0] ?? '既无覆盖、回落路径也不存在'})`)
    lines.push('required_subdirs: not checked')
    lines.push('cited_docs: not checked')
    lines.push('missing: —')
    lines.push(`verdict: ${NOT_ASSESSED}`)
  }

  lines.push(`mount_policy: ${MOUNT_POLICY}`)
  lines.push(`notes: ${result.notes.length === 0 ? 'none' : result.notes.join('；')}`)
  lines.push(
    'On failure record "NOT ASSESSED — framework corpus unresolved" and name the missing document. Do not correct from memory.',
  )
  lines.push('=== end CCGS corpus ===')
  return lines.join('\n')
}

// ---------------------------------------------------------------- 自测

/** 造一个假的探针集合：`dirs`/`files` 里的路径当作存在。 */
function fakeProbes({ env = {}, dirs = [], files = [] } = {}) {
  const dirSet = new Set(dirs.map((p) => normalize(p)))
  const fileSet = new Set(files.map((p) => normalize(p)))
  return {
    env,
    isDir: (path) => dirSet.has(normalize(path)),
    isFile: (path) => fileSet.has(normalize(path)),
  }
}

/** 造一个「完整」的语料根。 */
function completeCorpus(root) {
  return {
    dirs: [root, ...REQUIRED_SUBDIRS.map((name) => join(root, name))],
    files: CITED_DOCS.map((name) => join(root, name)),
  }
}

/** 跑自测夹具；返回失败条数。 */
export function runSelftest() {
  const assertions = []
  const check = (fixture, name, condition, detail = '') => {
    assertions.push({ fixture, name, condition: Boolean(condition), detail })
  }

  const complete = completeCorpus(FALLBACK_ROOT)

  const cases = [
    {
      desc: 'env 未设 + 回落路径存在',
      probes: fakeProbes(complete),
      expect: { source: 'fallback', root: FALLBACK_ROOT, presentDocs: 7, notes: 0 },
    },
    {
      desc: 'env 显式指定有效目录（覆盖优先）',
      probes: fakeProbes({ env: { [ENV_VAR]: 'D:\\corpus-b' }, ...completeCorpus('D:\\corpus-b') }),
      expect: { source: 'env', root: 'D:\\corpus-b', presentDocs: 7, notes: 0 },
    },
    {
      desc: 'env 设了但目录不存在 → 不回落、响亮降级',
      probes: fakeProbes({ env: { [ENV_VAR]: 'D:\\nope' }, ...complete }),
      expect: { source: 'unresolved', root: null, presentDocs: 0, notes: 1, notesInclude: '不回落' },
    },
    {
      desc: 'env 是空串 → 视为未设置',
      probes: fakeProbes({ env: { [ENV_VAR]: '   ' }, ...complete }),
      expect: { source: 'fallback', root: FALLBACK_ROOT, notes: 0 },
    },
    {
      desc: 'env 未设 + 回落路径也不存在 → 未解析',
      probes: fakeProbes(),
      expect: { source: 'unresolved', root: null, notes: 1, notesInclude: '回落实测路径也不存在' },
    },
    {
      desc: '根完整但缺一份被引文档 → 点名',
      probes: fakeProbes({
        dirs: complete.dirs,
        files: complete.files.filter((p) => !p.endsWith('效果映射索引.md')),
      }),
      expect: { presentDocs: 6, missingIncludes: '04-参考/效果映射索引.md', notes: 1 },
    },
    {
      desc: '根完整但缺一个子目录 → 点名',
      probes: fakeProbes({
        dirs: complete.dirs.filter((p) => !p.endsWith('04-参考')),
        files: complete.files,
      }),
      expect: { missingSubdirIncludes: '04-参考', notes: 1 },
    },
    {
      desc: '路径尾部斜杠与正斜杠混写 → 归一',
      probes: fakeProbes({ env: { [ENV_VAR]: 'D:/corpus-c/' }, ...completeCorpus('D:\\corpus-c') }),
      expect: { source: 'env', root: normalize('D:/corpus-c'), presentDocs: 7 },
    },
  ]

  let index = 0
  for (const testCase of cases) {
    index += 1
    console.log(`  夹具 ${index} ${testCase.desc}`)
    const result = resolveCorpus(testCase.probes)
    const block = formatBlock(result)
    const expect = testCase.expect

    if ('source' in expect) {
      check(index, 'source', result.source === expect.source, `${result.source} != ${expect.source}`)
    }
    if ('root' in expect) check(index, 'root', result.root === expect.root, `${result.root} != ${expect.root}`)
    if ('presentDocs' in expect) {
      check(index, 'presentDocs', result.presentDocs === expect.presentDocs, `${result.presentDocs} != ${expect.presentDocs}`)
    }
    if ('notes' in expect) {
      check(index, 'notes 条数', result.notes.length === expect.notes, `${result.notes.length} != ${expect.notes}`)
    }
    if ('notesInclude' in expect) {
      check(index, 'notes 内容', result.notes.join('').includes(expect.notesInclude), expect.notesInclude)
    }
    if ('missingIncludes' in expect) {
      check(index, 'missing 点名', result.missingDocs.includes(expect.missingIncludes), expect.missingIncludes)
    }
    if ('missingSubdirIncludes' in expect) {
      check(index, '缺子目录点名', result.missingSubdirs.includes(expect.missingSubdirIncludes), expect.missingSubdirIncludes)
    }

    // 块形态是契约的一部分：`verdict:` 行才是降级信号（末行的 On failure 说明里那句是固定文案，不算）。
    if (result.root === null) {
      check(index, '块含逐字降级语', block.includes(`verdict: ${NOT_ASSESSED}`), NOT_ASSESSED)
      check(index, '块不谎报根路径', !block.includes('corpus_root: D:'), 'corpus_root 应为 unresolved')
    } else {
      check(index, '块含 corpus_root', block.includes(`corpus_root: ${result.root}`), result.root)
      check(index, '块不含 verdict 降级行', !block.includes(`verdict: ${NOT_ASSESSED}`), '解析成功时不该出现 verdict 行')
    }
    check(index, '块首尾正确', block.startsWith('=== CCGS Framework Corpus ===') && block.endsWith('=== end CCGS corpus ==='))
  }

  const failed = assertions.filter((entry) => !entry.condition)
  if (failed.length === 0) {
    console.log('全部断言通过。')
    return 0
  }
  for (const entry of failed) {
    console.log(`  ✗ 夹具 ${entry.fixture} ${entry.name}${entry.detail ? `：${entry.detail}` : ''}`)
  }
  console.log(`${failed.length} 条断言失败。`)
  return failed.length
}

// ---------------------------------------------------------------- 入口

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node tools/ccgs-corpus.mjs [--strict] [--selftest]')
    return 0
  }
  if (argv.includes('--selftest')) {
    console.log('CCGS 框架语料解析器自测：8 个夹具')
    return runSelftest() === 0 ? 0 : 1
  }

  const result = resolveCorpus()
  console.log(formatBlock(result))
  if (argv.includes('--strict') && !result.root) {
    console.error(`strict：语料未解析 → ${NOT_ASSESSED}`)
    return 1
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
