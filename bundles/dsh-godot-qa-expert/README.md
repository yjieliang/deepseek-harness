# dsh-godot-qa-expert · 游戏测试与发布就绪专家 · 设计稿 v0.2

把 CodeBuddy 专家包 `game-automated-testing`（银橙AI，v1.0.0）改造成 dndGame 能用的 dsh 预设，职责四项：
**测试策略 / 缺陷分级 / 发布就绪 / 回归规划**。

**v0.2 的定位变化**：不再把 CCGS 的 QA 技能当作「可以顺带复用的既有资产」，而是当作**本预设的下游执行层**。
本预设的核心交付物是 CCGS QA 技能**缺失的那一层运行层**——配置解析器、框架语料解析、阶段与输入适配、口径归并、
以及本项目唯一的实证通道（探针）。理由见 §2，全部有据。

> 本文件是**设计稿**。本目录当前只有这一份 README：没有 `package.json`、没有 preset 文件、没有装进任何 profile，
> 没有改动 `D:\Godot\projects\dndGame` 的任何文件。落地步骤见 §9。

---

## 1. 结论先行

| 项 | 决定 |
|---|---|
| 形态 | **单专家预设**（对齐源包「Agent 型 · 单个 AI 专家」），四项职责是同一条链的四个阶段 |
| 复用方式 | 预设挂**两个** `skill-filesystem` 行：本包 `skills/` + `dsh-ccgs-studio` 的 `skills/`（74 篇，含 20 篇 QA/发布） |
| 本包真正要做的事 | R1 配置解析器 · R2 框架语料解析 · R3 阶段与输入适配 · R4 口径归并 · R5 探针证据通道（§4） |
| 不做什么 | 不重写 CCGS 已定义的产物路径、缺陷刻度、判定字面量；不写产品代码；不做发行与上架 |
| order | **66**（60–65 已被同族七个预设占用；62 被 `ccgs-studio` 与 `game-mechanics-designer` 重复占用） |

---

## 2. 为什么必须是「运行层」而不是「再来一套 QA 技能」

### 2.1 证据一：CCGS 技能的配置解析器**被整行剥离**

`dsh-ccgs-studio` 的每篇技能原本在正文开头动态求值配置，抽取时该行被删除。原文（`skills/gate-check/SKILL.md` 与上游的差异 §2、§5）：

> 动态求值块整行剥离：`` !`bash "${CLAUDE_SKILL_DIR}/../../hooks/yaml-helper.sh" resolve_config --keys review_mode,workflow,qa.level,testing.strict,performance.enforce,team.size,project.stage,system_overrides` `` 被删除；改为正文"先解析这些键"的说明。

后果：**20 篇 QA 技能里有 6 篇显式声明「需要的配置」**，但没有任何一篇能自己解析它们；其余 14 篇按正文读键，同样无解析器。缺解析器的直接后果是：键未写 ≠ 键为默认值——技能会走「向人提问」或降级到 `NOT ASSESSED`，而**这两条路都不报错**，一个配置缺口会伪装成一次正常的「证据不足」。

### 2.2 证据二：CCGS 技能引用的框架文档在包里**不存在**，但语料库里有

技能正文里的链接形如 `[../01-设计理念/05-配置解析.md](../01-设计理念/05-配置解析.md)`——相对于 **bundle 根**。实测 `dsh-ccgs-studio` 只有 `LICENSE / NOTICE.md / package.json / presets/ / README.md / skills/ / tools/`，**没有 `01-设计理念/`**，因此这些引用全部悬空。

同一批文档实际存在于框架语料库 `D:\AI\test\ccgs-essence\`（103 个文件、约 1.5 MB）：

| 语料 | 内容 | 对本预设的用处 |
|---|---|---|
| `01-设计理念/05-配置解析.md` | 解析链、12 个本地白名单键、rigor 展开表、12 条失败模式 | **R1 的规格来源** |
| `01-设计理念/06-导演门控.md` | 65,792 字节，**覆盖 28/28 个门控**的准入标准 | 补 `gate-check` 未交付的 `references/gate-*.md`（6 份，共 23,649 字节）与 `CONTRACT.md`（11,831 字节） |
| `01-设计理念/04-rigor档位.md`、`03-自动化模式.md` | 档位与自动化模式正文 | 档位头的人类可读说明 |
| `02-流程/项目目录结构.md`、`04-参考/效果映射索引.md` | 目录契约、`project.yaml` 的 schema 权威 | 产物落盘路径的核对基准 |
| `05-上游对照表.md`、`00-提取规范.md` | 未提取项登记、§3.0 同级文件不交付的裁定 | 判断「缺正文」是刻意还是遗漏 |

### 2.3 证据三：CCGS QA 技能的输入契约是 story / sprint 形态，本项目没有

技能读 `production/epics/`、`production/sprints/`、`production/sprint-status.yaml`、故事文件的 `## Acceptance Criteria` 与 `## Test Evidence` 节。
dndGame 的 `production/` 实测只有 `reports/`、`session-state/`、`probe-plan-M0-S1.md`、`probe-plan-M0b-P6.md`、
`开发计划-分阶段-v1.md`、`进度说明*.md`、`待裁决与缺失信息清单-v1.xlsx`——**没有 epics / sprints / stories / milestones / qa**。

这不是「缺一个目录」的问题：`/qa-plan` 的 N=0 守卫会在零故事时停并报 `NOT ASSESSED — no stories in scope`（正确行为，不该绕过）；
`/team-qa` 需要 `production/sprint-status.yaml`；`/milestone-review` 需要 `production/milestones/`。
本项目的实际作业单元是**阶段（M0–M7 + M0b）与阶段内的交付项/探针项**，不是用户故事。

### 2.4 证据四：判定字面量已有四套、缺陷刻度已有两套

| 来源 | 字面量 | 缺陷刻度 |
|---|---|---|
| CCGS `/gate-check` | `PASS` / `CONCERNS` / `FAIL` / `NOT ASSESSED`（序 **FAIL > CONCERNS > NOT ASSESSED > PASS**） | — |
| CCGS `/launch-checklist` | `READY` / `CONDITIONAL` / `NOT ASSESSED` / `NOT READY` | — |
| CCGS `/smoke-check` | `PASS` / `PASS WITH WARNINGS` / `NOT ASSESSED` / `FAIL` | — |
| CCGS `/team-qa` | `APPROVED` / `APPROVED WITH CONDITIONS` / `NOT APPROVED` / `NOT ASSESSED` | — |
| CCGS `/bug-report`、`/bug-triage` | — | **S1 Critical / S2 High / S3 Medium / S4 Low**（优先级 P1–P4 另轴） |
| 评审团 `godot-review-board` | `通过` / `有条件通过` / `驳回` | **Blocker / Critical / Major** + 阶段配额 |

再加一套就是第五套。本预设只做**归并**（§4-R4）。

> 结论：把 CCGS 的 20 篇 QA 技能直接挂上，只能得到一份**会反复停下来问人、或在关键处静默降级**的技能表。
> 让它按设计工作所需的适配层，正是本预设要做的东西。

---

## 3. CCGS 集成面：技能 → 职责映射

20 篇与 QA/发布相关的 CCGS 技能，按四项职责归位。**「今日可用性」指在本项目当前状态（无源码、无 tests、无 stories）下能否直接跑。**

### 3.1 责任 1 测试策略

| CCGS 技能 | 输入前置 | 产物 | 今日可用性 |
|---|---|---|---|
| `/qa-plan`（sprint / feature / story） | `production/sprints/`、故事文件、`production/epics/` | `production/qa/qa-plan-[sprint-slug]-[date].md`；可回填故事 `## QA Test Cases` | ⛔ 零故事 → `NOT ASSESSED — no stories in scope`（守卫正确，不绕过） |
| `/test-setup`（一次性） | 引擎已配置 | `tests/{unit,integration,smoke}`、`production/qa/evidence/`、`addons/gdUnit4/`、`.github/workflows/tests.yml` | ⚠️ 可跑，但会写文件、需下载 addon、会建在本项目并不存在的 CI 目录；**须人批准与逐项确认** |
| `/test-evidence-review` | 故事 + 证据文件 | 会话内输出，可选 `production/qa/evidence-review-[date].md` | ⛔ 零故事即停 |
| `/test-helpers` | `testing.framework` | `tests/helpers/{game_assertions,game_factory,[system]_factory}` | ⚠️ 缺框架键；且「无法确认时生成零助手」 |

**缺口与补位**：今日本项目的策略书必须**从计划的硬标准反推**，而不是从故事反推。本包补 `templates/test-strategy.md`，
输入为「DoD 5 条 + 本阶段硬标准 + 计划 §0 的分阶段交付项」，输出为金字塔比例、关键路径三条筛选（改得多 / 错了痛 / 判定清）、
三数估算、模块 × 层矩阵、前瞻缺口清单。**CCGS 未交付的 QA 计划骨架**（Test Summary / Automated Tests Required / Manual QA Checklist /
Smoke Test Scope / Playtest Requirements / DoD — This Sprint，`/qa-plan` 自述"属 §3.2 砍掉的模板正文"）也在这里补齐。

### 3.2 责任 2 缺陷分级

| CCGS 技能 | 输入前置 | 产物 | 今日可用性 |
|---|---|---|---|
| `/bug-report`（Description / analyze / verify / close） | `project.yaml → commands.test`；`production/qa/bugs/` | `production/qa/bugs/BUG-[NNNN].md`（四位零填充，自 BUG-0001）；裁决 `VERIFIED FIXED` / `STILL PRESENT` / `CANNOT VERIFY` | ✅ **可直接用**（当前无 CI、无测试命令产出时按"没有测试跑过"处理） |
| `/bug-triage`（sprint / full / trend） | 上者 + `production/qa/bugs.md` + qa-plan | `production/qa/bug-triage-[date].md` | ⚠️ 可用；但「同冲刺 3+ / 同故事 2+」两条偏差规则依赖 sprint 与 story，本项目无 |

**缺口与补位**：`/bug-triage` 的两条偏差规则（同系统同冲刺 ≥3、同故事 ≥2 个 S1/S2）在本项目**无对应物**，须换成阶段口径
（同模块同阶段 ≥3、同一交付项 ≥2 个 S1/S2、已判 FINISHED 的交付项出现缺陷 = 回归）。这条改写属**适配**而非新增刻度，
写入本包 `references/02-defect-triage.md` 并在报告里标注「偏差规则已按阶段口径改写」。

### 3.3 责任 3 发布就绪

| CCGS 技能 | 输入前置 | 产物 | 今日可用性 |
|---|---|---|---|
| `/gate-check`（7 阶段） | `project.stage`（回退 `production/stage.txt`）、GDD、ADR、`control-manifest.md`、`production/qa/` | `production/gate-checks/`（**需人同意**）；`PASS` 且用户确认后双写 `project.stage` + `production/stage.txt` | ✅ **最有用的一篇**：本项目 GDD、6 份 ADR、红线清单都在 |
| `/milestone-review` | `production/milestones/`、`production/sprints/sprint-*.md`、`production/sprint-status.yaml`、`production/qa/bugs/`、`production/risk-register/` | `production/milestones/[name]-review.md` | ⛔ 输入全缺 → `NOT ASSESSED — NO DATA`（且"无 bug 文件时统计是 NOT ASSESSED 不是 0"） |
| `/release-checklist` / `/launch-checklist` | Release 阶段、`platform.cert_tier`、里程碑与发布目录 | `production/releases/*.md` | ⛔ 阶段未到 Release；`/team-release` 会直接停（"阶段非 Release 即停、不派生任何代理"） |
| `/smoke-check`（sprint / quick） | 构建 + `qa.level` | `production/qa/smoke-[date].md`；`PASS` / `PASS WITH WARNINGS` / `NOT ASSESSED` / `FAIL` | ⚠️ 可用但对象是「空工程能开」——`project.godot` 的 `run/main_scene` 故意留空 |

**缺口与补位**：Gate-check 的**逐门产物清单**未交付；`01-设计理念/06-导演门控.md` 覆盖 28/28 门控，是本预设要指过去的替代物。
另外 `gate-check` 的七阶段名（Concept → Systems Design → Technical Setup → Pre-Production → Production → Polish → Release）
与本项目的 M0–M7 + MS-1..MS-4 **不是同一套坐标**，必须先给映射再判定（§4-R3）。
本包补 `references/03-release-readiness.md` + `templates/release-readiness.md`：以 DoD 5 条与阶段硬标准为第 0 层，
叠加 ADR 状态、红线清单覆盖、评审闭环、性能预算，输出 `READY / CONDITIONAL / NOT ASSESSED / NOT READY`，
并换算成评审团的 `通过 / 有条件通过 / 驳回` 建议。

### 3.4 责任 4 回归规划

| CCGS 技能 | 输入前置 | 产物 | 今日可用性 |
|---|---|---|---|
| `/regression-suite`（update / audit / report） | 故事与关键路径 | `tests/regression-suite.md`（追加、**绝不删**；`report` 模式不写文件） | ⚠️ `qa.level: minimal` 时**不生成**；本项目解析为 `standard`，可跑；但覆盖状态（`COVERED` / `PARTIAL` / `MISSING` / `EXEMPT`）的分母守卫要求关键路径 > 0 |
| `/test-flakiness`（ci-log / scan / registry） | CI 日志**或** ≥3 次运行记录 | 追加 `tests/regression-suite.md` 隔离区；可选 `production/qa/flakiness-report-[date].md` | ⚠️ 无 CI；不足 3 次运行一律只能记 `suspected`，**不隔离** |
| `/soak-test` | 人执行 | `production/qa/soak-test-[date]-[duration].md` | ⛔ 无运行中的构建 |
| `/perf-profile` | 提交过的性能预算键 | `production/polish/[scope]-report-[date].md` | ⚠️ **键名对不上**，见 §6.2 |
| `/playtest-report` | 试玩者 | `production/qa/playtests/playtest-[date]-[tester].md` | ⛔ 无试玩 |

**缺口与补位**：本项目的回归触发源不是「冲刺结束」，而是具体变更（§5.4 的触发矩阵）。CCGS 没有覆盖这些触发的技能，
本包补 `references/04-regression-plan.md`：触发矩阵 + 冒烟三级站位 + 基线五要素 + 阈值口径（帧时间 >5% 失败、长帧 +1pp 失败、
内存峰值 +10% 警告、加载 >15% 警告、崩溃零容忍；寻路 **P95 ≤ 2 ms** 是项目钉死红线，不可放宽）。

---

## 4. 运行层五件套（本预设的实际工作量）

### R1 配置解析器 · `tools/ccgs-config.mjs`

用确定性脚本替代被剥离的 `yaml-helper.sh resolve_config`。规格逐条取自 `01-设计理念/05-配置解析.md`：

- **解析链**：`project.local.yaml`（仅 12 个白名单键）→ `project.yaml` → legacy 镜像（`modes.review_mode` → `production/review-mode.txt`；`project.stage` → `production/stage.txt`）→ **`modes.rigor` 展开** → 文档化默认值。
- **12 个本地白名单键**：`modes.review_mode`、`modes.automation`、`modes.automation_always_ask`、`team.size`、五个 `testing.strict.*`、`performance.enforce`、`features.*`。**读作用域 == 写白名单**。
- **默认值**：`modes.automation: collaborative`、`modes.rigor: minimal`、`modes.automation_always_ask: [scope_changes, file_deletions, schema_changes]`。
- **rigor 展开表（六个前置旋钮无终点默认值）**：

| `modes.rigor` | `modes.workflow` | `docs.density` | `qa.level` | `modes.story_granularity` | `modes.review_mode` | `team.size` |
|---|---|---|---|---|---|---|
| `minimal`（默认） | minimal | terse | minimal | coarse | solo | individual |
| **`standard`（本项目）** | **standard** | **balanced** | **standard** | **balanced** | **lean** | **individual** |
| `full` | full | thorough | full | fine | full | studio |

- **输出块**：每行 `key: value (source)`，来源词汇表 `{project.local.yaml, project.yaml, <legacy 路径>, rigor:<level>, default, unset}`；末尾 `notes:` 行 + `Values above are fully resolved (local -> yaml -> legacy -> default). Use as-is.`；内联 `--review full|lean|solo` 覆盖 `modes.review_mode`。
- **失败模式**（照 §六 实现，**永远 0 退出、永远输出完整块**）：`project.yaml` 不存在 / 为空（两者刻意区分）/ YAML 格式错误 / Tab 缩进（点名行号）/ CRLF （正确解析）/ BOM（正确解析）/ 3 空格缩进（容忍）/ 键存在值为空（视为未设置，绝不落到 `""`）/ 枚举非法值（越过继续，写在 `notes:`）/ 白名单外键被手写进 `project.local.yaml`（**只警告、永不调和**）。
- **`testing.strict.*` 没有中央默认值**：解析器只报 `unset`，**脚本解析来源、技能拥有策略**。
- 附 `--selftest`：为上述每条失败模式与三行展开表各造一个夹具，全部断言。

调用形态：`node tools/ccgs-config.mjs [--keys a,b] [--root <项目根>] [--review full|lean|solo] [--selftest]`。
**每次 QA 报告首部附这个块**——它就是本项目一切档位判定的「档位头」。

### R2 框架语料解析

技能里的 `../01-设计理念/*.md` 在本包不存在，在 `D:\AI\test\ccgs-essence\` 存在。本预设固定一条解析顺序：

```
$CCGS_ESSENCE_DIR  →  D:\AI\test\ccgs-essence  →  NOT ASSESSED — framework corpus unresolved
```

- 解析失败时**响亮降级**：一切依赖逐门清单/配置语义的判定记 `NOT ASSESSED` 并点名语料路径缺失，**不得靠记忆补正**。
- 语料路径是**本机事实**（与 `engine.path` 同类），写入本包 `references/06-framework-corpus.md`，并在预设 persona 的 `suffix` 之外单列一行声明。
- **不挂载 `ccgs-essence\03-技能`**：那 20 篇与本包挂的 `dsh-ccgs-studio/skills` 同名同源（实测同名文件字节数几乎一致），
  两个 provider 出现同名技能时的去重/遮蔽语义未验证，本次不去碰这个不确定性。

### R3 阶段与输入适配

**阶段坐标映射**（一次性写死，避免每次重新解释）：

| 本项目 | CCGS 七阶段（`gate-check`） | 说明 |
|---|---|---|
| M0 / M0b | Technical Setup | 环境与取证骨架 |
| M1（MS-1 规则可信） | Pre-Production | 规则内核可回归 |
| M2（MS-2 能打）/ M3 | Production | 战斗闭环与角色 |
| M4（MS-3 能演）/ M5 / M6 | Production（后期） | 对话检定、探索存档、内容补齐 |
| M7（MS-4 原型完成） | Polish | 美术与打磨 |
| — | Release | 本项目**尚未到**，`/team-release` 会直接停 |

映射表进 `references/00-alignment.md`，与 `project.stage` 的写入互不替代：**本专家的阶段名不写进 `project.yaml`**（那是 `/gate-check` 在 `PASS` + 用户确认后的动作）。

**输入适配**：本项目无故事时，以「阶段内的交付项」充当 story 的位置：

| CCGS 概念 | 本项目对应物 | 说明 |
|---|---|---|
| sprint | 一个 M 阶段（或 M0-S1 / M0b-P6 这样的子阶段） | `/qa-plan` 的 `sprint` 参数与 `/bug-triage` 的 sprint 模式据此解释 |
| story | 阶段硬标准里的一条交付项，或一个探针项（P-0 … P-6） | 只有它带独立的判据与证据 |
| milestone | MS-1..MS-4 里程碑 | 与 M 阶段是多对一 |
| bug 文件 | `production/qa/bugs/BUG-[NNNN].md` | 沿用 CCGS 路径与编号规则，**不新建** |

三条不得越线的纪律：① 适配只在**本包 references 里**说明，不去改 CCGS 技能的正文；② 任何技能因输入缺失而报
`NOT ASSESSED` 时，照实记录，**不伪造故事或冲刺目录**让守卫通过；③ 项目一旦开始走 CCGS 故事流（`/create-epics` → `/create-stories`），
适配层让位，直接按故事跑。

### R4 口径归并（不新增第五套）

**判定字面量**：按场景引用上表四套原文，不改写。本专家在《发布就绪报告》里给**换算建议**（`READY` ↔ 评审团`通过`、
`CONDITIONAL` ↔ `有条件通过`、`NOT READY`/`FAIL` ↔ `驳回`），并标注这是建议不是裁决。
沿用三条既有纪律：`NOT ASSESSED` **高于** `PASS`；缺证据不得记 PASS 也不得记豁免（按 `Major` 登记，覆盖 Blocker 级准则时按 `Blocker`）；
分母为 0 一律 `NOT ASSESSED`（本项目 M0 0.7 修掉的「零文件通过」假绿，与 CCGS 的分母守卫同源）。

**缺陷刻度（唯一归并规则，两列同源）**：

| 事实 | CCGS 列（`/bug-report` 文件里写这列） | 评审团列（门禁计数用这列） |
|---|---|---|
| 崩溃、存档损坏、红线被违反、规则真相源冲突 | S1 | **Blocker** |
| 核心判定错：d20 优势/劣势矩阵、结算、寻路 P95 超 2 ms | S1 | **Critical** |
| 功能可用但有偏差、报黄 | S2 | **Major** |
| 表现、余量、文案 | S3 / S4 | **Minor** |

阶段配额**逐字沿用评审团** `references/baseline.md` §3.2（第 65–73 行）：`Blocker` 原型 **不限** / Alpha `0` / Beta `0` / 验收 `0`；
`Critical` 原型 `—` / Alpha `≤5` / Beta `0` / 验收 `0`；`Major` 原型 `—` / Alpha 不限 / Beta `≤10` / 验收 `≤3`（其余须书面豁免）；
`reopen 率` Beta ≤15%、验收 ≤10%；分阶段帧预算 `≤25 / ≤20 / ≤16.6 / ≤16.6 ms`（第 74 行）。
**数据缺失记 `NOT ASSESSED`，不得记 0**。若要原型期就卡 `Blocker 0`，只能写成「本预设的建议」，**不得写成评审团配额**。

**缺陷 ≠ 裁定结论**（本项目最易混淆处）：`probe/out/*.log` 的 PASS/FAIL 是**探针判定**，不是缺陷等级。
P-2、P-3 的 🔴 FAIL 是架构级结论，登记进台账时标 `kind: finding`，**不计入缺陷配额**；由它派生的实现缺陷才计入。

### R5 探针证据通道

证据分级沿 `dsh-godot-engine-reviewer` 的四级制，本项目落到：A = `probe/out/*.log` 原始日志 / `production/reports/*.json` / 截图 / headless 退出码；
B = `project.yaml`、`control-manifest.md`、`docs/architecture/adr-*.md`、计划与探针计划文档；C = 外部资料（Godot 官方文档须标访问日期与小节）；
D = 推测，必须附证伪方法。

**命令（逐字，取自 M0-S1 §8 与 M0b §2）**：

```
D:/Godot/Godot_v4.7.2-stable_win64_console.exe --headless --path probe \
  --script res://<name>.gd --log-file D:/Godot/projects/dndGame/probe/out/<name>.log
```

**本机实测陷阱**（进 `references/05-evidence-channel.md`）：必须用 `_console.exe` 与 `--log-file`（GUI 版 exe 的 stdout 在 Windows 不落调用方）；
**绝不**把 Godot 进程接进 PowerShell 管道（无输出或 0 字节）；读日志用 `Get-Content -Raw -Encoding utf8`（默认按 GBK 解码会变乱码）；
`ERROR: Failed to read the root certificate store.` 是环境噪音，不得当成发现；观察值以 `read` 为准，PowerShell 数行数不可信。

**第一项待补**：探针脚本多为裸 `quit()`，**退出码判据文档未规定**。本专家补一个统一入口（新增，不改既有 `p0`–`p5` 与既有日志）：
约定 `0 = 通过 / 非 0 = 失败`、短路失败、总超时保护、失败留证，并把「一条命令 + 明确退出码」作为启动冒烟的门槛。

---

## 5. 四项职责的运行协议（按 CCGS 技能落地）

### 5.1 责任 1 · 测试策略

**先跑 R1** 拿档位头 → 本项目解析结果：`modes.workflow: standard`、`qa.level: standard`、`docs.density: balanced`、
`modes.review_mode: lean`、`team.size: individual`（全部来源 `rigor:standard`）。

成熟度档位：**零基础**（无 `tests/`、无 `addons/`，证据只有探针）→ 本轮重点：先把「能启动」守住，再把探针判定升级为可回归骨架。

顺序不可换：① 出配置缺口清单（§6）→ ② 定金字塔比例（单元 50–60% / 集成与行为 20–30% / 冒烟与回放 10–20%，源包经验起点，须按项目调整并写明依据）→
③ 关键路径三条筛选（本项目高优先：规则内核 `rules/`+`core/`（M1 硬标准已要求零 Node 依赖，天然可单测）、数值结算、存档等价、网格与寻路）→
④ 三数估算 → ⑤ 模块 × 层矩阵（空格必须写原因）→ ⑥ 前瞻缺口清单（模块取自 `control-manifest.md` 分层与 `systems-index.md` 的 49 系统 / MVP 36）。

**今日不调用 `/qa-plan`**（零故事会被守卫正确拦下）；项目进入故事流后再切回 CCGS 路径。

### 5.2 责任 2 · 缺陷分级

`/bug-report` 登记（沿用 CCGS 编号与状态机）→ 按 R4 的归并规则补评审团列 → `/bug-triage` 做趋势与偏差，
偏差规则按阶段口径改写 → 汇总《缺陷分级清单》（同条两列 + 阶段配额对照）。

### 5.3 责任 3 · 发布就绪

先给阶段映射（R3）→ 第 0 层检查表：DoD 5 条（② 的 `tools/validate_data.py` **磁盘上不存在**，记 `NOT ASSESSED`，不得因为「计划里写了」记 PASS）→
本阶段硬标准（M1 的 5 条、M0b 的 P95 ≤2 ms 等）→ ADR 状态（`Accepted` 须用户本人验收；ADR-0007 只产 `Proposed`）→
红线清单覆盖（`TD-MANIFEST: NOT ASSESSED` **不是批准**；两条 Core Forbidden 溯源缺口未补前不得记通过）→
评审闭环（M0-S1 裁决单 §6 表第 1 行 ＋ §6.2 复评规则里的 #1/#33 决定第 2 轮复评能否放行——该文件没有 §6.4 子节；首轮 45 条中 5 条未闭环：#1 #13 #14 #21 #33）→
性能预算（按阶段取值：原型 ≤25 ms / Alpha ≤20 ms；移动端列判 N/A）→ 证据归档。

输出 `READY / CONDITIONAL / NOT ASSESSED / NOT READY`；缺证据最高 `CONDITIONAL`。
需要 CCGS 形态时再跑 `/gate-check`（引用 `06-导演门控.md` 的 28 门控），**阶段写入仍由 `/gate-check` 在用户确认后执行**。

### 5.4 责任 4 · 回归规划

触发矩阵（本项目真实触发源）：

| 触发 | 必跑 | 依据 | 判据 |
|---|---|---|---|
| 改 `balance.json` / 数值 | 重跑 `tools/monte_carlo.py` → 复核 W1–W5 → 更新 `balance_baseline_M*.md` | 红线清单 Feature Forbidden #4 | 不得跳过窗口复核 |
| 规则真相源变更（`docs/`） | 10 张职业卡 δ→六维复算 + 优势/劣势 **9 格矩阵** + 受影响断言 | M0 / M1 硬标准 | 逐条 PASS/FAIL |
| 引擎 / 平台 / 渲染后端变更 | P-0 环境探针 + 受影响探针重跑 | 版本绑定 | 声明版本与后端 + 附原始日志 |
| ADR `## Validation Criteria` 登记的复审触发（格区放大 / 占据率上升） | 对应探针 / P-6 微基准 | M0b §5.2 T2 档 | P95 ≤ **2 ms** |
| 里程碑 M6 | `monte_carlo_M6.json` 与 M1 报告 **diff** | 计划 §8 6.7 | 给出 diff 结论 |
| 存档格式变更 | 存档等价报告 + 「读档刷骰无效」专项 | M5 §7 | 等价 |
| 主场景接入 | 启动冒烟（`--headless --quit-after 5`）+ 主流程冒烟 | `project.yaml → commands.smoke` | 退出码 + 日志 |
| 不稳定用例 | 先隔离再决定入闸；不足 3 次运行只记 `suspected` | 源包铁律 2 / `/test-flakiness` | 隔离区留痕 |

冒烟三级站位、基线五要素（场景固定 / 机器固定 / 构建固定 / ≥3 次取中位数去首次预热 / 版本一一对应）、
阈值口径与「换机器换引擎换后端 ⇒ 重建基线」见 `references/04-regression-plan.md`。
覆盖状态沿用 `/regression-suite` 的 `COVERED / PARTIAL / MISSING / EXEMPT`，缺口表落 `tests/regression-suite.md`（追加、绝不删）。

---

## 6. 配置缺口与建议值（修正版）

### 6.1 v0.1 的一处错误，先纠正

v0.1 写「`project.yaml` 缺 `qa.level` 等键，需要补写」——**这是错的**。按 `05-配置解析.md` §四/§五：
六个旋钮由 `modes.rigor` **展开**得到（第 4 步，位于显式来源之下、终点默认值之上）。本项目已写 `modes.rigor: standard`，
这六个旋钮因此**全部已解析**，无需补写；此时补写反而会把它们从「跟随 rigor」钉成定值
（「显式设置六个中的任意一个，只覆盖那一个」是文档允许的表达方式，只是本项目没有偏离派生值的理由）。
所以缺的不是这些键，缺的是**解析器**（R1）。

### 6.2 真正需要动作的键

| 键 | 磁盘现状 | 解析结果 | 动作 | 依据 |
|---|---|---|---|---|
| `modes.rigor` | `project.yaml` 写了 `standard` | standard | 已就位，不动 | — |
| 六个 rigor 前置旋钮 | 均未写 | 展开为 standard 行 | **无需写**（已由 `modes.rigor: standard` 解析出相同值；只有想故意偏离 rigor 派生值时才写，且四个锁定键只能写进 `project.yaml`） | `05-配置解析.md` §四/§五 |
| `project.stage` | 无，且无 `production/stage.txt` | 无来源可下探 → **须问人** | 由 `/gate-check` 在 `PASS` + 用户确认后双写 | `gate-check` |
| `platform.cert_tier` | 无 | `unset`（**未设置 ≠ `none`**） | **要写 `none`**（PC/Windows 单机、无商店） | `release-checklist` |
| `platform.online` / `platform.multiplayer` | 无 | 缺失须问人 | 要写（单机项目应显式写 `false`） | `team-release` |
| `testing.framework` | 无 | — | 要写 `gdUnit4`（红线清单已批准该框架） | `test-setup` / `test-helpers` |
| `testing.strict.*` | 无 | `unset`，各技能自套默认（`/smoke-check` 把未设置当**阻断**） | 可暂不写；要显式化时逐项写 | `05-配置解析.md` §五 末 |
| `performance.enforce` | 无 | `warn` | 暂不写；首个基线建立后再议 `block` | `perf-profile` / `gate-check` |
| `qa.coverage_minimum` | 无 | `unset` | 建议写（可由 M1 硬标准折算） | `gate-check` |
| `commands.test` | 已写 gdUnit4 runner | 命令会失败（`addons/`、`tests/` 都不存在） | 先补 `addons/gdUnit4`（**需人批准与可核验来源**），或在补上之前按「没有测试跑过」处理 | `bug-report` / `hotfix` |
| **性能预算键名不匹配** | `project.yaml` 写的是 `frame_rate`、`frame_budget_ms`、`draw_call_limit`、`memory_steady_mb`、`memory_peak_mb`、`scene_load_s`、`pathfinding_p95_ms` | `/perf-profile` 读的是 `performance.target_framerate`、`frame_budget_ms`、`draw_call_limit`、`memory_ceiling_mb` | **两个键名对不上**（`frame_rate` ↔ `target_framerate`、`memory_peak_mb` ↔ `memory_ceiling_mb`）：要么按 CCGS 拼写补别名键，要么接受 `/perf-profile` 永远读 `NOT ASSESSED`；**已核（2026-10-11）**：权威拼写为 `performance.target_framerate` / `performance.memory_ceiling_mb`；数值亦已裁定（PC 峰值登记 **3 GB**，到 Beta·RC 按基线的 2.5 GB 判）。改法见 `06-framework-corpus.md` §四.1 | `perf-profile` |
| `production/stage.txt`、`production/review-mode.txt` | 无 | legacy 回退源，缺失不报错 | 不需要 | §四 |

> `system_overrides`、`modes.automation` 无需动作：前者本包用不上，后者解析到默认 `collaborative`。

**写入纪律**：`project.yaml` 是项目主存储，改动须**用户批准**；本专家只出清单与依据，不擅自写。
建议走项目自己的 `/settings` 技能，而不是手工编辑。

---

## 7. 组合（preset 行表）

| 行 | 插件 | 关键配置 |
|---|---|---|
| `persona` | `@deepseek-ai/dsh-persona` | 四职责 + 五条硬约束 + 边界 + 输出规范；`suffix: 当前工作目录：{{cwd}}` |
| `agent-instructions` | `@deepseek-ai/dsh-agent-instructions` | `maxBytes: 65536`（与 CCGS 一致）：QA 必须服从项目 DoD、红线与规则真相源 |
| `tool-bash` / `tool-pwsh` | — | 平台二选一 |
| `tool-fs` / `tool-fs-search` | — | `sampleOverCapGlobResults: false`（漏掉即整条 preset 变 broken，同族实测踩过） |
| `tool-jobs` | — | 长跑门禁/探针走后台作业 |
| `skill-filesystem` ① | `@deepseek-ai/dsh-skill-filesystem` | `providerName: godot-qa-expert`，`customSkillDirs` → 本包 `skills/` |
| `skill-filesystem` ② | 同上 | `providerName: ccgs-studio`，`customSkillDirs` → `dsh-ccgs-studio/skills`（**硬前置**，解析失败即整条 preset 激活失败，响亮） |
| `tool-skill` / `compaction` / `tool-ask-user` / `tool-todo` / `tool-web` / `present` | — | 照同族预设逐字段复制 |
| `requirement-board-role` | `cordis:group` + `dsh-requirement-board/role` | **必须包在 `isolate: { requirementBoardRole: true }` 组内**；`roleId: godot-qa-expert`；duties：测试策略与覆盖 / 缺陷分级与台账 / 发布就绪判定 / 回归规划与触发 |

与同族预设的三处刻意差异：**挂 `agent-instructions`**（评审团刻意不挂——QA 必须服从项目判据）；
**不挂 `tool-subagent`**（保持单专家身份，长跑走 `tool-jobs`；需要独立复评时另开会话跑评审团）；**保留 `tool-fs` 写能力**（要落测试与报告）。

**复用机制已在 DSH 源码级验证**（不是假设）：

- `skill-filesystem` 支持 `user-invocable` 与 `disable-model-invocation`，并**拒绝**legacy 驼峰键（`packages/skill/skill-filesystem/src/index.ts:1001-1008`，测试见同包 `tests/skill-filesystem.spec.ts:258-368`）。
- 用户以 `/名字` 开头的 token 会被注入到 user-invocable 技能，且这是 `disable-model-invocation` 技能的唯一入口（`packages/skill/tool-skill/src/index.ts:164-175`）。
- `Config` 为 `providerName?: string`（默认 `filesystem`）+ `customSkillDirs?: string[]`（`packages/skill/skill-filesystem/src/index.ts:49-81`），因此**一个 preset 里两行、两个 provider 是受支持的形态**。
- CCGS 的 `/hotfix`、`/day-one-patch`、`/dev-story`、`/story-done` 带 `disable-model-invocation: true` → 在本预设里**只有用户能用 `/` 触发**，符合其原意。

---

## 8. 边界与 R/A

| 事项 | R（出证据/意见） | A（拍板） |
|---|---|---|
| 指标整体达标、能否放行 | 本专家（就绪报告） | 评审团验收席位汇总 → 主理人终裁 |
| 缺陷是否达标（配额） | 本专家（缺陷分级清单） | 评审团验收席位（门禁口径） |
| 引擎侧主张是否成立 | `godot-engine-reviewer` | 该专家的三态判定 |
| 可测试性是否达标 | 本专家 + 评审团代码席位 | 评审团验收席位 |
| 性能预算裁定 | 本专家出实测数据 | 评审团技术席位 |
| 阶段推进与 `project.stage` 写入 | 本专家只建议 | `/gate-check` 在 `PASS` + **用户确认**后执行 |
| 规则真相源与红线 | 本专家只核验 | **用户本人**（规则改动先问用户） |
| 发行、上架、年龄分级、SDK 合规 | — | 出界，直接退回项目组 |

**不管发行**，与源包、评审团一致。**不写产品代码**：可写 `tests/`、`tools/`、`production/qa|releases|gate-checks/`，产品代码归 `godot-game-suite` 等实施角色。

---

## 9. 交付物清单与落地

```
bundles/dsh-godot-qa-expert/
├─ package.json                            # dsh.bundle.patch → presets/godot-qa-expert.patch.yml
├─ presets/godot-qa-expert.patch.yml       # order 66；单 persona；两个 skill mount；role 隔离组
├─ skills/godot-qa-support/
│  ├─ SKILL.md                             # 四职责路由 + 五条铁律（流程的唯一 home）
│  ├─ references/00-alignment.md           # R3 阶段映射 + 输入适配 + R4 口径归并（字面量与缺陷刻度）
│  ├─ references/01-test-strategy.md       # 责任 1（含 CCGS 未交付的 QA 计划骨架）
│  ├─ references/02-defect-triage.md       # 责任 2（偏差规则的阶段口径改写）
│  ├─ references/03-release-readiness.md   # 责任 3（DoD 5 + 阶段硬标准 + ADR/红线/评审闭环）
│  ├─ references/04-regression-plan.md     # 责任 4（触发矩阵 + 基线五要素 + 阈值口径）
│  ├─ references/05-evidence-channel.md    # R5 探针协议 + 本机陷阱表 + 待补的退出码约定
│  ├─ references/06-framework-corpus.md    # R2 语料解析 + R1 配置键清单（§6 的正式版）
│  └─ templates/{test-strategy,defect-register,regression-plan,release-readiness}.md
├─ tools/ccgs-config.mjs                   # R1 解析器（零依赖 + --selftest 覆盖 12 条失败模式）
├─ tools/gqe-check.mjs                     # 静态契约检查（结构/行集/必填 Config/persona 全文/占位符与乱码/悬空链接）
├─ README.md / INSTALL.md / NOTICE.md      # NOTICE 登记上游 game-automated-testing v1.0.0 与语料来源
```

落地步骤：① 放稳定目录（工作区内 `bundles/dsh-godot-qa-expert`，与 `dsh-godot-engine-reviewer` 同址；不要放 `%TEMP%`，pnpm 以 `link:` 引用目录本身）→
② `plugin_manager install_bundle`（`target` = 绝对目录；会执行插件代码，需 Full access 或你批准）→ ③ `node tools/gqe-check.mjs` 与 `node tools/ccgs-config.mjs --selftest` →
④ 激活期取证：**已做（2026-10-11，含正向对照）**——临时删掉 `tool-fs-search` 的必填 Config 后重跑，日志点名 `agent preset godot-qa-expert: tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config`（10,527 B，第 250 行）；还原后再跑 **0 命中**（9,259 B）。同一版本、同一失败路径下会点名，则没点名即干净 →
⑤ GUI 冒烟（须你新建会话）：开「代码工作工具」→ Hero 选中本预设 → 确认工具面与 `skill` 能列出 `godot-qa-support` **且** `/qa-plan`、`/bug-report` 等 CCGS 技能可见 →
⑥ 真实冒烟：跑一次 `node tools/ccgs-config.mjs`（对照 §6 表格逐行核对）、一次启动冒烟、一次探针，检查日志与 `production/qa/` 落盘。

**落地结果（2026-10-11 实测）**：①②③ 已完成——`install_bundle` 返回 `stage: enable` / `application: applied` / `exitCode: 0`、**无 warnings**；
`list_plugins` 出现 `include:preset-godot-qa-expert`（`enabled: true` / `fiberPhase: active` / `patchId: preset-godot-qa-expert`），总行数 **204 → 205**；
`Config.listConfigs` 中该行 `status: schema`（与 `preset-standard`、`preset-ccgs-studio` 同级）；`gqe-check` **69 项全绿**、`ccgs-config --selftest` **18 夹具全过**、真实运行输出与本表逐行一致。
④⑤ 均已完成（2026-10-11）。**loader 说某行 `active` 只证明「声明装上了」，不证明预设内部那串插件能实例化**——所以 ⑤ 是唯一能证明工具面与两套技能表的实验：新建会话实测工具面 19 个齐备、无 `subagent`，技能表 75 项 = 本包 1 ＋ CCGS 68（§3 路由表里的 16 个★全部在册）＋ 主机层其他来源 6。⑥ 全程未向 `D:\Godot` 写字节。

**v0.3 优化轮（2026-10-11，用户说「继续优化」）**：

- **F1 关闭最后一个未验证项**：已核权威 `04-参考/效果映射索引.md`（第 95 / 96 / 120 行）确认 `/perf-profile` 读的键名是 `performance.target_framerate` 与 `performance.memory_ceiling_mb`，而本项目 `project.yaml` 写的是 `frame_rate`（第 55 行）与 `memory_peak_mb`（第 58 行）——**四项预算里两项会静默读成 `NOT ASSESSED`**（不是失败）。**数值已裁定（2026-10-11，用户）：PC 峰值上限登记 3 GB（3072 MB）**——与基线 PC 列的 **Alpha** 档一致；到 Beta·RC 按基线更严的 2.5 GB 判。键名改法（`frame_rate` → `target_framerate`、`memory_peak_mb` → `memory_ceiling_mb`）与顺序写在 `06-framework-corpus.md` §四.1。
- **F2 契约检查新增跨 bundle 依赖断言**：16 个★技能必须在 `dsh-ccgs-studio` 里逐个存在、且必须以 `` `名字` `` 的形式留在路由表里（防漂移），被引用的外部权威文件也必须存在；默认必查，`--no-external` 可跳过（跳过记 `skipped`，不记通过）。
- **F3 R2 从散文变成可执行**：新增 `tools/ccgs-corpus.mjs`（覆盖 → 回落 → 响亮降级、8 个夹具、`--strict`），与 R1 同族契约（正常模式永远 exit 0 并输出完整块）。**`CCGS_ESSENCE_DIR` 设了但无效时不回落**——设错的覆盖是配置错误。
- **F4**：`06-framework-corpus.md`、本文件与 `SKILL.md` 的清单同步。

**实施结论与剩余未验证项（2026-10-11 实测）**：

- **bundle 层内嵌 `requirement-board-role`——会话级生效，但不落持久记录**。新建会话后 `requirement_role list` 里出现 `godot-qa-expert`：`holders.online: 1`（该会话正以此角色运行）、`dutiesMissing: false`（四项职责可解析）；然而它落在 `unregistered` 段而非 `items` 段。对照 `godot-review-board`（`source: preset`）有持久记录、无会话在线时职责仍可查——因为那 4 个角色的声明**不在各自 bundle 里**，而在 profile 的 `cordis.patch.yml`（`dsh-requirement-board/dev.overlay.yml` 与 `tests/verification/_r_patch_prod_backup.yml` 是它的副本，带一行注记「append the isolated requirement-board-role group to `plugins`」）。差别只在「**没有会话在线时，别的会话能否按职能选中这个角色**」；本次**未**补 profile 声明（它会改动影响所有会话的配置）。需要时按 ROLE-DISPATCH §2.3 整条重述该 preset 的 `config.plugins`。
- **一个 preset 内两个 `skill-filesystem` 行——确认可以同时列全两份技能表**（CCGS 68 ＋ 本包 1）。此外主机层还并入了 6 个其他来源的技能，说明预设层技能表是与主机层**取并集**，不是替换。
- ~~`perf-profile` 的权威键名~~ **已核（v0.3 · F1）**：权威拼写是 `performance.target_framerate` / `performance.memory_ceiling_mb`，本项目两个键名对不上；改法与保留意见见 `06-framework-corpus.md` §四.1。**本项关闭**。仍开放的只有两件、都不影响本包可用：profile 级要不要补角色持久记录（见上一条），以及探针退出码约定（项目侧，见 `05-evidence-channel.md` §四）。

## 10. 待裁决

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| Q2 | 现在落地还是先只要设计稿 | (A) 只留设计稿 (B) 建 bundle 并装进 web profile | 你说 |
| Q3 | 写权限边界 | (A) 可写 `tests/`、`tools/`、`production/**`，不可写产品代码 (B) 只出规划与判定 (C) 全量 | **A**（并注明这是提示词纪律，不是沙箱边界） |
| Q4 | R1 解析器的实现范围 | (A) 完整照 §六 实现 12 条失败模式 + `--selftest`（工作量大、最稳） (B) 只覆盖本项目实际用到的键与 5 条常见失败模式 | **A**：它是所有 CCGS 技能的共同前置，半成品会让降级变成静默 |
| Q5 | `D:\AI\test\ccgs-essence` 是否长期稳定 | (A) 是，按固定路径写死并允许 `CCGS_ESSENCE_DIR` 覆盖 (B) 位置会变，须先确认 | 若会变，建议先把语料复制到稳定目录再落地 |

## 11. 限制与风险

- 路径级写权限**不是机制约束**：`toolFilter` 只能整工具开关，无法只允许写某几个目录。「不写产品代码」是提示词纪律 + 评审复核，不是沙箱边界。
- 预设只在 **web / desktop** 组合可用（`agent-preset-registry` 由 web-app 层插入；headless 不含 preset roster 并拒绝接管带 preset 的会话）。
- **CCGS 技能是「功能介绍」形态**：同级 `CONTRACT.md` 与 `references/` 按 `00-提取规范.md` §3.0 一律不交付。`gate-check` 的逐门清单由 `06-导演门控.md` 覆盖 28/28 是**已知的例外**；
  其余技能的流程正文缺失**不可从本机任何位置找回**（`ccgs-essence/03-技能` 与 bundle 内同名同源、同样只有 1 个文件）。本包只补本项目真正会用的那几处，不假装补全。
- R1 是**替代品不是本体**：被剥离的是 shell 助手，本包用 Node 复刻其语义；`05-配置解析.md` §256 明说实现符号不保留、只保留语义约束，
  因此两者在边界情形上的行为可能不同——`--selftest` 的夹具就是这条风险的护栏。
- **loader 的 `fiberPhase: active` 不等于预设可用**：`@deepseek-ai/dsh-agent-preset` 行只承载**声明**，内部那串插件（`persona`、两个 `skill-filesystem`、工具面、角色组）在**会话启动时**才实例化。所以「装上了」与「能用」之间有一道只能靠新建会话关闭的缺口——`tool-fs-search` 漏写一个必填 Config 就会让整条 preset 在会话里变 broken，而 loader 侧照样显示 `active`。
- 本设计依赖 2026-10-11 的磁盘现状（同族 bundle、CCGS 技能、语料库、dndGame 文档）。任一处改名/改路径后需同步，`tools/gqe-check.mjs` 负责把这类漂移变成契约检查。
- 缺陷与就绪的**终裁权不在本专家**（§8）；本专家的产物是证据与建议，不是放行决定。
