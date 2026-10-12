> **何时读**：接到「出/改本项目的测试策略书」这类任务时先读本文件；在写完策略书、进入缺陷分级之前不再重复读。
> **口径来源**：`bundles/dsh-godot-qa-expert/README.md` §2.3 · §3.1 · §4-R4 · §5.1 · §5.2；`dsh-ccgs-studio 的 /qa-plan`、`/test-evidence-review`、`/test-flakiness`；项目文档 `production/开发计划-分阶段-v1.md`、`docs/architecture/control-manifest.md`、`design/gdd/systems-index.md`、`setup-engine` 事实源（引擎名与版本逐字取自 `project.yaml` 的 `engine` 块 · `AGENTS.md`）。
> **不覆盖**：发布就绪判定（`references/03-release-readiness.md`）、回归触发与基线（`references/04-regression-plan.md`）、缺陷刻度与阶段配额（`references/02-defect-triage.md`）、探针命令与本机陷阱（`references/05-evidence-channel.md`）、配置键解析（`references/06-framework-corpus.md`）。

# 责任 1 · 测试策略（从计划的硬标准反推）

## 1. 为什么反推，而不是从用户故事反推

`dsh-ccgs-studio 的 /qa-plan` 的输入契约是**故事 / 冲刺**形态（读 `production/epics/`、`production/sprints/`、故事文件的 `## Acceptance Criteria` 与 `## Test Evidence`）。本项目 `production/` 实测没有 epics / sprints / stories / milestones / qa（README §2.3）。因此：

- **本项目未产出用户故事之前不调用 `/qa-plan`**。零故事会被它的 N=0 守卫正确拦下，报 `NOT ASSESSED — no stories in scope`（逐字），这是**正确行为**；**不得绕过**——不伪造故事文件、不伪造冲刺目录、不出空表（零故事的 QA 计划看起来和完成的 QA 计划一模一样）。
- 本项目的**可判定单元**是阶段（M0 / M0b / M1 … M7）与阶段内的**交付项 / 探针项**。策略书从「计划的硬标准」反推：先用计划已经钉死的**完成定义（DoD）**与**阶段硬标准**构造判据，再倒推需要什么测试。
- 一旦项目开始走 CCGS 故事流（`/create-epics` → `/create-stories`），本适配层让位，直接按故事跑 `/qa-plan`。

## 2. 输入清单（缺一项即按第 8 节记 `NOT ASSESSED`）

| # | 输入 | 落盘位置 | 当前可用性 | 用法 |
|---|---|---|---|---|
| I1 | **DoD 5 条** | `production/开发计划-分阶段-v1.md`（文件头的「完成定义（DoD）」） | 可用 | 每一阶段策略书的第 0 层判据，逐条转成检查项 |
| I2 | **本阶段硬标准** | 同文件各阶段 §「验收标准（硬）」；探针计划的 §「硬判据」 | 可用 | 生成该阶段的验收测试项与阻断项 |
| I3 | **分阶段交付项清单** | 同文件 §0 阶段总览 ＋ 各阶段任务表（含 M0b 的 P-6a…P-6e） | 可用 | 充当 story 的位置（第 7 节字段映射） |
| I4 | **探针判定** | `probe/out/*.log`（`--log-file` 产物） | 可用 | 引擎行为级证据；判定字面量见第 6 节 |
| I5 | 配置档位头 | `node tools/ccgs-config.mjs` 的输出块 | 规格见 `references/06-framework-corpus.md` | 决定 `qa.level` 等档位；本文件不自解析配置 |

**DoD 5 条（逐字取自 `production/开发计划-分阶段-v1.md` 的文件头）**：

| 序 | DoD 条目（逐字要点） | 转成的检查动作 |
|---|---|---|
| ① | headless 测试全绿 | 跑 `project.yaml → commands.test` 的 runner，记退出码与日志 |
| ② | `tools/validate_data.py` 全绿 | 该文件**磁盘上不存在**时记 `NOT ASSESSED`，**不得因为「计划里写了」记 PASS** |
| ③ | 有**证据**（JSON 报告或截图） | 逐项点名证据文件路径；无路径即该交付项未完成 |
| ④ | 无"待定规则分支"（未裁决的规则必须显式报黄，不允许静默取默认值） | 检查规则函数是否把未裁决分支写成静默默认；命中即缺陷 |
| ⑤ | 每条新增规则函数头部带 `# 来源：docs/<文件> §<节>` | 抽样 + 全量扫描 `source` 字段非空 |

## 3. 金字塔比例（先定比例，再挑模块）

| 层 | 目标占比 | 该层写什么 | 来源 |
|---|---|---|---|
| 单元 | **50–60%** | 纯函数断言：公式、档位、矩阵、边界值 | 源包 `game-automated-testing` 的 `references/01-test-strategy-and-pyramid.md` §「第 1 步：按金字塔分配投入」（2026-10-11 核对，原文逐字：单元 **五到六成** / 集成与行为 **二到三成** / 冒烟与回放 **一到二成**）；**经验起点，须按项目调整** |
| 集成与行为 | **20–30%** | 跨模块行为：回合状态机、存档等价、数据加载 → 运行时 | 同上 |
| 冒烟与回放 | **10–20%** | 启动冒烟、固定 seed 回放快照、微基准 | 同上 |

**纪律**：不要把三档比例当成验收线。它是**配比意图**，填表时按模块×层矩阵写出各格的实际用例数，再回看比例是否偏离并写明原因。`qa.level: standard` 下 `minimal` 才砍测试；**任何档位都不砍 Visual/Feel 与 UI 的截图行**（`dsh-ccgs-studio 的 /qa-plan`）。本项目解析为 `qa.level: standard`、`docs.density: balanced`（来源：`project.yaml` `modes.rigor: standard` 的展开）。

## 4. 关键路径三条筛选（改得多 / 错了痛 / 判定清）

只把同时通过三条的模块放进「关键路径」清单：

| 筛选 | 判定问题 | 取事实的地方 |
|---|---|---|
| **改得多** | 该模块在计划里被后续阶段反复触碰吗？ | 计划的阶段任务表；`design/gdd/systems-index.md` 的被依赖计数（瓶颈系统） |
| **错了痛** | 它错了会污染下游多少交付项？ | `design/gdd/systems-index.md` §3.2 依赖契约与 §3.3 瓶颈系统；`control-manifest.md` 的 Forbidden 条目 |
| **判定清** | 它能给出布尔/数值判据，而不是「看起来对」吗？ | 验收项的判据列；无判据的一律不进（改为登记为缺口） |

**本项目的高优先模块（前四条，逐条给依据）**：

| 模块 | 为什么是高优先 | 落在哪个系统/交付项 |
|---|---|---|
| 规则内核 `rules/` ＋ `core/` | M1 硬标准第 5 条要求 `rules/` 与 `core/` 中**零 Node 依赖**，天然可单测；M1 是里程碑 MS-1「规则可信」 | M1 任务 1.1–1.8；`design/gdd/systems-index.md` 的 `F·S2 d20 判定` / `F·S3 角色属性与派生` |
| 数值结算 | 错了直接违反 DoD ④ 与 ADR-0006 的 W1–W5 窗口；`control-manifest.md` Feature 层禁止「跳过窗口复核直接改 `balance.json`」 | M1 任务 1.9；`C·S25 战斗伤害结算` |
| 存档等价 | M5 验收要求「存读档等价报告」＋「读档刷骰无效」专项；ADR-0001/0002/0003 各有一条读档夹取规则 | M5；`C·S14 场景与存档管理` |
| 网格与寻路 | 项目唯一钉死的性能红线由它承载；M0b 的判定档事先钉死、跑完不得事后改 | M0b P-6a…P-6e；`F·S1 等距网格与寻路` |

**阈值口径（逐条溯源，不得自创）**：单次寻路 **P95 ≤ 2 ms**（口径：20×17 格 · 实心点 20% · 满移动力）——逐字取自 `project.yaml → performance.pathfinding_p95_ms`，`control-manifest.md` 判为「项目红线」；`0.12` / `0.5`（T1/T2 分档）是**助手提案的一次性裁定档，非项目红线**，引用时必须照此标注。帧预算目标 **16.6 ms**＝`project.yaml → performance.frame_budget_ms`，为终局（Beta·RC）目标；**原型 ≤25 ms / Alpha ≤20 ms** 逐字来自评审团 `references/baseline.md` §3.2 第 74 行（`P95 帧时间（目标 60fps）`），不是 `baseline-engineering.md`。

## 5. 模块 × 层矩阵（空格必须写原因）

矩阵行 = 第 4 节的高优先模块 ＋ 第 3 节的三层；每格填**用例数或计划数**，空格一律填**原因**，常见原因只有这几类：

| 空格原因（逐字使用） | 含义 |
|---|---|
| `N/A — 该模块无引擎侧行为` | 纯逻辑模块，冒烟层无对象 |
| `N/A — 阶段未到` | 该层对象的交付项还没开工（点名哪个阶段） |
| `NOT ASSESSED — 缺证据` | 无从判定，缺的是哪份证据要点名 |
| `MISSING — 已找过，那里没有` | 搜索范围明确且为空（`MISSING` 与 `NOT ASSESSED` 不可互换） |

判定纪律取自 `dsh-ccgs-studio 的 /test-evidence-review`：**`NOT ASSESSED` 不是更软的 `MISSING`**——类型无法判定、证据路径不可读或越界、对象文件无法解析才用 `NOT ASSESSED`，且逐项说明是哪一种。

## 6. 探针判定 ≠ 缺陷等级（最易混淆处）

`probe/out/*.log` 里的 `PASS` / `FAIL` 是**探针判定**（引擎行为级结论），不是缺陷严重度。策略书里引用探针结论时：

- 写清探针编号、判据、观察值、结论四段（记录格式见 `production/probe-plan-M0b-P6.md` §3）。
- 与缺陷的分工见 `references/02-defect-triage.md`：登记进台账时标 `kind: finding`，**不计入缺陷配额**；由它派生的实现缺陷才计入。
- **禁止把「看起来对」写成 `PASS`**；**禁止事后改档**——判定档事先钉死，跑完只许往里套。
- 探针未跑 ⇒ 结论尚未存在，记 `NOT ASSESSED`，不得预设结论。

## 7. 以「阶段交付项」充当 story 的字段映射

本项目未产出故事时，用阶段交付项填第 8 节的 QA 计划骨架。字段映射如下（左列概念逐字取自 `dsh-ccgs-studio 的 /qa-plan`）：

| CCGS 概念 | 本项目对应物 | 填写纪律 |
|---|---|---|
| sprint | 一个 M 阶段（或 `M0-S1` / `M0b-P6` 这样的子阶段） | `/qa-plan` 的 `sprint` 参数与 `/bug-triage` 的 sprint 模式据此解释 |
| story | 阶段硬标准里的一条交付项，或一个探针项（P-0 … P-6） | 只有它带独立判据与证据 |
| milestone | MS-1…MS-4 | 与 M 阶段是多对一 |
| `Type:`（故事类型） | 逐字五选一：**Logic / Integration / Visual/Feel / UI / Config/Data** | 交付项没有 `Type:` 时**从它的验收判据推断并记为缺口**；混合交付项按实现风险最高的一组定主类型；Logic 与 Integration 模糊时归 **Integration** |
| `## Acceptance Criteria` | 该交付项的验收/判据列 | 交付项无判据时**整条读完并说明**，不得当成「没有这个交付项」 |
| bug 文件 | `production/qa/bugs/BUG-[NNNN].md` | 沿用 CCGS 路径与编号规则，**不新建** |

**断言密度口径**（取自 `dsh-ccgs-studio 的 /test-evidence-review`，用于评审测试质量，不是新增门禁）：每函数 **3+** 为正常、**1–2** 偏薄、**0 断言**按该交付项类型的门控级别判阻断。

## 8. QA 计划骨架（补齐 `/qa-plan` 未交付的模板正文）

`dsh-ccgs-studio 的 /qa-plan` 自述完整计划骨架属「§3.2 砍掉的模板正文」⇒ 本节补齐。六个小节名逐字如下，落盘时按此顺序：

| 小节（逐字） | 本项目怎么填 | 空表原因只能写 |
|---|---|---|
| **Test Summary** | 逐交付项一行：编号 / 类型 / 判据来源 / 自动化与否 / 证据路径 | `NOT ASSESSED — 缺证据` / `MISSING — 已找过，那里没有` |
| **Automated Tests Required** | 逐交付项列单元与集成用例；`qa.level: minimal` 时整节省略（`standard` 下必须出全） | 只在 `minimal` 下写「已按 `qa.level: minimal` 省略」 |
| **Manual QA Checklist** | 只能人工的眼与手：手感参数、截图、试玩观感 | `N/A — 阶段未到` |
| **Smoke Test Scope** | 启动冒烟（`project.yaml → commands.smoke`）＋ 主流程冒烟；三级站位见 `references/04-regression-plan.md` | `N/A — 阶段未到` |
| **Playtest Requirements** | 需要几个人、盲测还是自测、看哪几个指标 | `NOT ASSESSED — 缺证据`（无试玩记录时） |
| **Definition of Done — This Sprint** | 第 2 节 DoD 5 条 ＋ 本阶段硬标准，逐条给可核验证据 | 不得留空；无证据写 `NOT ASSESSED` |

**Visual/Feel 与 UI 的截图行在任何档位下都不砍**（`dsh-ccgs-studio 的 /qa-plan`）。

## 9. 三数估算与执行顺序

**三数估算**：每个高优先模块给三个数——乐观 / 现实 / 悲观（用例数或人时，全表用同一单位），并写一句话说明三者差在哪（通常是「是否含引擎侧行为用例」）。计划里的阶段估算是量级判断且置信度中低（`production/开发计划-分阶段-v1.md` §0：估算需在 M0 后由 `/estimate` 重做）⇒ 三数估算**不得**当成排期承诺。

**顺序不可换**（README §5.1）：
① 出配置缺口清单 → ② 定金字塔比例（第 3 节）→ ③ 关键路径三条筛选（第 4 节）→ ④ 三数估算 → ⑤ 模块 × 层矩阵（第 5 节）→ ⑥ 前瞻缺口清单。

**前瞻缺口清单的模块来源**：`docs/architecture/control-manifest.md` 的分层（Foundation / Core / Feature / Presentation / Global）＋ `design/gdd/systems-index.md` 的 **49 系统 / MVP 36**（逐字取自该文件：`System Count: 49`（Foundation 13 ＋ Core 17 ＋ Feature 8 ＋ Presentation 8 ＋ Polish 3）· 优先级 `MVP 36 · Vertical Slice 10 · Alpha 2 · Full Vision 1 ＝ 49`）。缺口清单逐系统标注「本阶段是否纳入测试范围 / 为什么没纳入」。

**证据分级**（引用探针与报告时标注级别）：A = `probe/out/*.log` 原始日志 / `production/reports/*.json` / 截图 / headless 退出码；B = `project.yaml`、`control-manifest.md`、`docs/architecture/adr-*.md`、计划与探针计划文档；C = 外部资料（Godot 官方文档须标访问日期与小节）；D = 推测，必须附证伪方法。

## 10. 未确认事项（写策略书时必须原样带出，不得含糊）

| # | 未确认的事 | 处置 |
|---|---|---|
| U1 | 源包三档比例的文件位置 | **已核实**：`C:\Users\Administrator\.workbuddy\plugins\marketplaces\experts\plugins\game-automated-testing\skills\game-testing-support\references\01-test-strategy-and-pyramid.md` §「第 1 步」（2026-10-11 核对，五到六成 / 二到三成 / 一到二成与第 3 节一致）。注意它只在 `%USERPROFILE%\.workbuddy` 下，不在 `.dsh\bundles` 里 |
| U2 | `tools/validate_data.py` 磁盘上不存在 | DoD ② 记 `NOT ASSESSED` |
| U3 | 项目无 `tests/`、无 `addons/`、无 `production/qa/` | 成熟度档位写「零基础」；`commands.test` 垂类命令会失败，按「没有测试跑过」处理（`dsh-ccgs-studio 的 /bug-report`：`commands.test` 未设即"没有测试跑过"；未产出测试命令时同义） |
| U4 | `production/开发计划-分阶段-v1.md` 未写 M0b 章节（M0b 只在 `production/probe-plan-M0b-P6.md`） | 阶段清单以两份文档并集为准，冲突时点名两处路径 |
