import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineAcpSnapshotSuite,
  type Scenario,
  type SnapshotSuiteOptions,
} from '@deepseek-ai/dsh-acp-snapshot'

/**
 * The kb-agent example's snapshot suite: a recorded read-only knowledge-base
 * turn through the assembled ACP tree with the kb engine and kb_* tools
 * mounted. The header pin owns the assembled system prompt (the
 * knowledge-base section with the `@kb:` adjudication) and the complete
 * tool-schema list, so prompt-section ownership and tool wiring stay pinned
 * keylessly. The harness points `DSH_HOME` at the generated cwd's `.dsh`, so
 * `prepareWorkspace` seeds each run a fresh one-document library with fixed
 * frontmatter dates instead of touching any real library.
 */

const AGENT = {
  binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}

/** Seed the scenario's fresh library with one fixed-content, fixed-date document. */
async function prepareKbLibrary(cwd: string): Promise<void> {
  const doc = join(cwd, '.dsh', 'kb', '00-inbox', '2026-08-12-模型路由方案.md')
  await mkdir(dirname(doc), { recursive: true })
  await writeFile(doc, [
    '---',
    'title: DSH 模型路由方案',
    'tags: [routing, 会话, 设计]',
    'summary: 记录 DSH 会话级模型路由的候选方案与最终取舍',
    "created: '2026-08-12T00:00:00.000Z'",
    "updated: '2026-08-12T00:00:00.000Z'",
    '---',
    '',
    '会话级模型路由在「下一请求换模型」与「整会话绑定模型」之间取舍。',
    '路由表按 provider 分组,每个 provider 列出可用模型与其上下文容量。',
    'selection 只描述下一次组装的意图;routable 才决定会话能否立即开始回合。',
    '',
  ].join('\n'), 'utf8')
}

function snapshotMode(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const SCENARIOS: Scenario[] = [
  { name: 'kb-search-turn', hasModelTurn: true, recorded: true, pinsHeader: true, prepareWorkspace: prepareKbLibrary },
]

defineAcpSnapshotSuite({
  agent: AGENT,
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS,
  mode: snapshotMode(process.env.DSH_SNAPSHOT),
})
