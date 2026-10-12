# 口径对齐：阶段坐标、输入适配、判定字面量与缺陷刻度

> **何时读**：每次出任何一份产物之前。这份文件是四项职责共同的坐标系——阶段怎么对、没有故事时拿什么当故事、判定用哪套字面量、缺陷怎么定级。
> **口径来源**：CCGS 框架语料 `01-设计理念/05-配置解析.md`、`dsh-ccgs-studio` 的 `/gate-check` `/bug-report` `/bug-triage` `/qa-plan`、评审团 `dsh-godot-review-board` 的 `references/seats/qa-acceptance.md`、本项目 `production/开发计划-分阶段-v1.md` 与 `production/进度说明-细节.md`。
> **不覆盖**：具体检查项与阈值（看 `01-test-strategy.md` / `03-release-readiness.md` / `04-regression-plan.md`），也不覆盖引擎侧主张的裁定。

## 一、阶段坐标映射

本项目与 CCGS 七阶段不是同一套坐标。**先映射再判定**，否则每份报告的阶段结论都不可比。

| 本项目阶段 | CCGS 七阶段 | 说明 |
|---|---|---|
| M0 / M0b | Technical Setup | 环境与取证骨架；M0b 的硬红线是寻路 P95 ≤ 2 ms |
| M1（MS-1 规则可信） | Pre-Production | 规则内核可回归 |
| M2（MS-2 能打）/ M3 | Production | 战斗闭环与角色 |
| M4（MS-3 能演）/ M5 / M6 | Production（后期） | 对话检定、探索存档、内容补齐 |
| M7（MS-4 原型完成） | Polish | 美术与打磨 |
| — | Release | 本项目**尚未到**；`/team-release` 会直接停（阶段非 Release 即停，不派生任何代理） |

三条纪律：

1. 本专家**只给映射建议**，`project.stage` 由 `/gate-check` 在 `PASS` 且用户明确确认后双写 `project.yaml` + `production/stage.txt`；本专家不写。
2. `/gate-check` 的判决优先级逐字为 **`FAIL` → `CONCERNS` → `NOT ASSESSED` → `PASS`**，且 `NOT ASSESSED` 高于 `PASS`。
3. 逐门产物清单不在 `dsh-ccgs-studio` 里（`references/gate-*.md` 与 `CONTRACT.md` 按 `00-提取规范.md` §3.0 未交付），替代物是框架语料 `01-设计理念/06-导演门控.md`（65,792 字节，覆盖 28/28 门控）。语料不存在时记 `NOT ASSESSED — framework corpus unresolved`。

## 二、输入适配：本项目没有故事与冲刺

CCGS 的 QA 技能读 `production/epics/`、`production/sprints/`、`production/sprint-status.yaml` 与故事文件的 `## Acceptance Criteria` / `## Test Evidence` 节。本项目 `production/` 下没有这些目录。对应关系如下，**只在适配层解释，不改 CCGS 技能正文**。

| CCGS 概念 | 本项目对应物 |
|---|---|
| sprint | 一个 M 阶段，或 M0-S1 / M0b-P6 这样的子阶段 |
| story | 阶段硬标准里的一条交付项，或一个探针项（P-0 … P-6） |
| milestone | MS-1 … MS-4（与 M 阶段多对一） |
| bug 文件 | `production/qa/bugs/BUG-[NNNN].md`（沿用 CCGS 路径与编号，**不新建**） |

三条不得越线的纪律：

1. **不伪造目录**：技能因输入缺失报 `NOT ASSESSED` 时照实记录。`/qa-plan` 在零故事时停并报 `NOT ASSESSED — no stories in scope` 是它的 N=0 守卫在正常工作——「零故事的 QA 计划看起来和完成的 QA 计划一模一样」，所以它拒绝出空表。
2. **故事类型逐字沿用**：`Logic` / `Integration` / `Visual/Feel` / `UI` / `Config/Data`；Logic 与 Integration 模糊时归 `Integration`。故事头部已有 `Type:` 就照单接受，不重新分类也不复核。
3. **项目一旦走故事流**（`/create-epics` → `/create-stories`），适配层让位，直接按故事跑 `/qa-plan`。

## 三、判定字面量：四套原文，不新造第五套

| 场景 | 逐字字面量 | 来源 |
|---|---|---|
| 阶段门 | `PASS` / `CONCERNS` / `FAIL` / `NOT ASSESSED` | `dsh-ccgs-studio` 的 `/gate-check` |
| 发布就绪 | `READY` / `CONDITIONAL` / `NOT ASSESSED` / `NOT READY` | `/launch-checklist`；本专家就绪报告用它 |
| 冒烟 | `PASS` / `PASS WITH WARNINGS` / `NOT ASSESSED` / `FAIL` | `/smoke-check` |
| 团队级 QA 裁决 | `APPROVED` / `APPROVED WITH CONDITIONS` / `NOT APPROVED` / `NOT ASSESSED` | `/team-qa` |
| 评审团评审结论 | `通过` / `有条件通过` / `驳回` | `dsh-godot-review-board` |

需要跨口径沟通时给**换算建议**并标注是建议不是裁决：`READY` ↔ 通过、`CONDITIONAL` ↔ 有条件通过、`NOT READY` / `FAIL` ↔ 驳回。

三条共用纪律：

- **`NOT ASSESSED` 高于 `PASS`**：没能检查部分范围，就没有确立「已就绪」。
- **缺证据不得记 PASS，也不得记豁免**：按 `Major` 登记；当它覆盖的是 Blocker 级准则时按 `Blocker` 登记。
- **分母为 0 一律 `NOT ASSESSED`**：本项目 M0 0.7 修掉的「零文件通过」假绿与 CCGS 的分母守卫同源。

## 四、缺陷刻度的唯一归并规则

登记沿用 `/bug-report`（`production/qa/bugs/BUG-[NNNN].md`，四位零填充、自 BUG-0001），文件里写 CCGS 列，门禁计数用评审团列。**两列同源，一条事实只落一行。**

| 事实 | CCGS 列 | 评审团列 |
|---|---|---|
| 崩溃、存档损坏、红线被违反、规则真相源冲突 | S1 | `Blocker` |
| 核心判定错：d20 优势/劣势矩阵、结算、寻路 P95 超 2 ms | S1 | `Critical` |
| 功能可用但有偏差、报黄 | S2 | `Major` |
| 表现、余量、文案 | S3 / S4 | `Minor` |

阶段配额**逐字沿用评审团** `dsh-godot-review-board/skills/godot-review-board/references/baseline.md` §3.2（第 65–73 行）：

| 阶段 | `Blocker` | `Critical` | `Major` |
|---|---|---|---|
| 原型 | **不限** | — | — |
| Alpha | **0** | **≤5** | 不限 |
| Beta | **0** | **0** | **≤10** |
| 验收 | **0** | **0** | **≤3**（豁免制） |

`reopen 率`：Beta ≤15%、验收 ≤10%。**数据缺失记 `NOT ASSESSED`，不得记 0。**

设计稿曾把原型写成「`Blocker` 0（硬）」，**那是设计稿的错**（baseline 原文是 `不限`），以 baseline 为准。若要原型期就自行收严，只能写成「**本预设的建议**」，并明确标注它不是评审团配额。

## 五、缺陷 ≠ 裁定结论

`probe/out/*.log` 里探针的 PASS/FAIL 是**判定结论**，不是缺陷严重度：

- 登记进台账时标 `kind: finding`，**不计入缺陷配额**。
- P-2、P-3 的 🔴 FAIL 是架构级结论；由它派生的实现缺陷才按 §四 定级并计入配额。
- 探针判定必须在跑之前就写死，**跑完不得修改判据**。

## 六、偏差规则的阶段口径改写

`/bug-triage` 原本按冲刺与故事做偏差检测，本项目无这两者，改写为（并标注这是适配不是新增刻度）：

| 原规则 | 本项目口径 |
|---|---|
| 同系统同冲刺 ≥3 个缺陷 | 同模块同阶段 ≥3 个缺陷 |
| 同故事 ≥2 个 S1/S2 | 同一交付项 ≥2 个 S1/S2 |
| 缺陷落在已 Complete 的故事上 = 回归 | 缺陷落在已判 FINISHED 的交付项上 = 回归 |
