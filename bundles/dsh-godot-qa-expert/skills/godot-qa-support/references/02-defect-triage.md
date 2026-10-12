> **何时读**：接到「登记缺陷 / 分级 / 出缺陷台账 / 做趋势与偏差检查」这类任务时先读本文件；判定发布就绪前也要先读它确认配额口径。
> **口径来源**：`bundles/dsh-godot-qa-expert/README.md` §4-R4 · §3.2 · §5.2；`dsh-ccgs-studio 的 /bug-report`、`/bug-triage`、`/test-evidence-review`、`/test-flakiness`；`godot-review-board` 的 `references/baseline.md` §3.2 与 `templates/acceptance-report.md`（阶段配额与 reopen 率的原文）；`probe/out/*.log`（探针判定）。
> **不覆盖**：测试策略与金字塔（`references/01-test-strategy.md`）、发布就绪结论与换算建议（`references/03-release-readiness.md`）、回归触发矩阵（`references/04-regression-plan.md`）、探针命令与本机陷阱（`references/05-evidence-channel.md`）。

# 责任 2 · 缺陷分级（登记 → 归并 → 配额 → 偏差）

## 1. 登记侧：沿用 `/bug-report`，一个字都不改

| 项 | 口径（逐字） | 来源 |
|---|---|---|
| 文件路径 | `production/qa/bugs/BUG-[NNNN].md` | `dsh-ccgs-studio 的 /bug-report` |
| 编号 | **四位零填充**；无既有文件时从 **`BUG-0001`** 起，一次多份取连续编号 | 同上 |
| 状态机 | Description / analyze / verify / close（四种模式共用一个技能） | 同上 |
| 验证裁决 | **`VERIFIED FIXED`** / **`STILL PRESENT`** / **`CANNOT VERIFY`** | 同上（大小写与空格逐字照抄） |
| 关闭前置 | Close 前 Status 必须是 `Verified Fixed`，否则停下并提示先跑 verify | 同上 |
| 找不到编号 | `production/qa/bugs/BUG-*.md` 中无匹配（无论零填充位数或 slug）→ 停下，verdict **BLOCKED** — no such bug | 同上 |
| 落盘裁决 | **COMPLETE** — bug report filed / **BLOCKED** — user declined write | 同上 |

- **代码路径改变了本身永远不算通过**（`/bug-report` 逐字）。改完代码未重跑复现步骤 ⇒ 裁决只能是 `CANNOT VERIFY` 或 `STILL PRESENT`，不得写 `VERIFIED FIXED`。
- `CANNOT VERIFY` 时必须**指名缺什么**，并说明试玩复现步骤即可定论。
- 缺陷文件登记时补两个字段（本文件新增的登记字段，**不是新刻度**）：`kind`（见第 5 节）与 `module`（用于第 4 节的偏差规则）。
- 本文件对应 README §3.2 的映射：`/bug-report` 产出 `production/qa/bugs/BUG-[NNNN].md`；`/bug-triage` 产出 `production/qa/bug-triage-[date].md`（含 Triage Summary、P1/P2/P3-P4 表、Systemic Issues、Trend Analysis、Recommended Actions）。

## 2. 两套已有刻度的原样引用

| 来源 | 严重度阶梯（逐字） | 优先级阶梯（逐字） |
|---|---|---|
| `dsh-ccgs-studio 的 /bug-report` | `S1-Critical` / `S2-High` / `S3-Medium` / `S4-Low` | `P1-Fix this sprint` / `P2-Fix soon` / `P3-Backlog` / `P4-Won't fix` |
| `dsh-ccgs-studio 的 /bug-triage` | **S1 — Critical** / **S2 — High** / **S3 — Medium** / **S4 — Low** | **P1 — Fix this sprint** / **P2 — Fix soon** / **P3 — Backlog** / **P4 — Won't fix / Deferred** |

两条阶梯由 `/bug-triage` 从 `/bug-report` 的文件里解析 ⇒ **改其一必须同时改另一处**（`/bug-report` 逐字）。`P4-Won't fix` 是 `/bug-triage` 的 `P4 — Won't fix / Deferred`，即**已接受的风险，不是愿望单**。P4 候选先问「Are these acceptable as Won't Fix?」，用户作答前 disposition 保持 `P4 candidate`。**严重度是客观的，优先级是团队决定，只作建议呈报**；容量已满时不得自动指派，须标 `Priority overflow — consider pulling from sprint`。

## 3. 唯一的归并规则表（不新增第五套刻度）

CCGS 列写进 `/bug-report` 的缺陷文件里；评审团列用于门禁计数，**同一事实两列并写**。

| 事实（落到哪一格） | CCGS 列（写进 bug 文件） | 评审团列（门禁计数用） |
|---|---|---|
| 崩溃、存档损坏、红线被违反、规则真相源冲突 | **S1** | **Blocker** |
| 核心判定错：d20 优势/劣势矩阵、结算、寻路 P95 超 2 ms | **S1** | **Critical** |
| 功能可用但有偏差、报黄 | **S2** | **Major** |
| 表现、余量、文案 | **S3 / S4** | **Minor** |

来源：README §4-R4（两列同源的一张表）。用法纪律：

- **归并 ≠ 折算**。同一行里两列是**同一事实的两个登记面**；`Critical` 不折算成 `Major`，也不进意见级别统计（`godot-review-board` 的 `SKILL.md` 逐字）。两列各自独立判定配额。
- **缺证据的处置**（`godot-review-board` 的 `SKILL.md` 逐字口径）：任一必测指标没有可核验的证据时，**不得记 PASS、也不得记豁免**，只能记证据不足并强制列入未闭环项；证据不足本身**按 `Major` 级登记**；若缺口覆盖 Blocker 级准则（崩溃、数据丢失、核心指标无数据），**按 `Blocker` 登记并直接阻断**。
- **分母为 0 一律 `NOT ASSESSED`**（README §4-R4）：零文件、零运行记录、零交付项都不得读成 `PASS`。这是本项目 M0 0.7 修掉的「零文件通过」假绿，与 CCGS 的分母守卫同源。
- **`NOT ASSESSED` 高于 `PASS`**（README §4-R4）。

## 4. 阶段配额（数据缺失记 `NOT ASSESSED`，不得记 0）

| 阶段 | Blocker | Critical | Major | reopen 率 | 来源 |
|---|---|---|---|---|---|
| 原型 | **不限** | — | — | — | `godot-review-board` 的 `references/baseline.md` §3.2（评审团原文） |
| Alpha | **0** | **≤ 5** | 不限 | — | `godot-review-board` 的 `references/baseline.md` §3.2；`templates/acceptance-report.md` |
| Beta | **0** | **0** | **≤ 10** | **≤ 15%** | 同上 |
| 最终验收 | **0** | **0** | **≤ 3**（其余须**书面豁免**） | **≤ 10%** | 同上 |

- 配额「在阶段升级时启用」：**原型**阶段的缺陷配额里 `Blocker` 原文是**不限**、`Critical` 与 `Major` 是 `—`（无门槛）——真正卡 0 的是 **Alpha** 起。
- 设计稿 README §4-R4 曾把原型写成「Blocker 0（硬）」，**那是设计稿的错**：评审团权威 `baseline.md` §3.2 第 70 行原文是 `不限`。以 baseline 为准。若要自行收严，只能写成「**本预设的建议**：原型期自定 `Blocker` 0」，并明确标注这是建议、不是评审团配额。
- **数据缺失记 `NOT ASSESSED`，不得记 0**（README §4-R4 逐字）。无 bug 文件时统计是 `NOT ASSESSED` 不是 0（README §3.3 对 `/milestone-review` 的同源纪律）。分母为 0 的 reopen 率同样记 `NOT ASSESSED`。
- `reopen 率` 的定义与抽样口径沿用评审团 `baseline.md` §3.2 的「缺陷 reopen 率」行；本项目**不新增**定义，分子分母算法有疑义时先问用户，不得自创。

## 5. 缺陷 ≠ 裁定结论（本项目最易混淆处）

| 事实 | 登记为 | 计入缺陷配额吗 | 依据 |
|---|---|---|---|
| `probe/out/*.log` 的 `PASS` / `FAIL` | 探针判定；登记进台账时标 **`kind: finding`** | **不计入** | README §4-R4 |
| 由探针判定**派生的实现缺陷**（例：某条纪律没落进实现） | 缺陷；按第 3 节两列归并 | **计入** | 同上 |
| 评审意见级别 `Blocker` / `Major` / `Minor` / `Nit` | 评审意见（另一套口径） | **不计入** | `godot-review-board` 的 `templates/verdict-sheet.md` |
| 证据不足（必测指标无证据） | 按第 3 节末条登记（一般 `Major`，覆盖 Blocker 级准则时按 `Blocker`） | 按登记面计入 | `godot-review-board` 的 `SKILL.md` |

**写法**：探针条目在台账里同时写「探针编号 + 判据 + 观察值 + 结论」，结论列写 `PASS` / `FAIL` 原字面量，**不要**把它翻译成 S1/S2 或 Blocker/Critical。项目现状举例（逐字取自 `probe/out/p5_replan.log`）：`策略1·逐格剪：重规划最大 = 10 ⇒ FAIL ； P95 = 0.0260 ms ⇒ PASS`——同一行里两个判据各自 PASS/FAIL，登记时**每个判据一条 finding**，不得合并成一个等级。

## 6. 偏差规则（按阶段口径改写；这是适配，不是新增刻度）

`/bug-triage` 的三条偏差检查逐字是：

1. 同系统同冲刺 3+ bug → "Potential design or implementation quality issue in [system]"；
2. 同一故事 2+ S1/S2 → "Story may need to be reopened and re-reviewed before shipping"；
3. bug 针对已标 Complete 的故事 → "Regression in completed story — story should be re-opened in sprint tracking"。

本项目无 sprint、无 story ⇒ 三条按**阶段口径改写**如下（README §3.2 / §4-R4）：

| 序 | 改写后的触发条件 | 报告里要写的话（保留原文，替换主语） |
|---|---|---|
| 1 | **同模块同阶段 ≥ 3 个** bug | Potential design or implementation quality issue in [module] |
| 2 | **同一交付项 ≥ 2 个 S1/S2** | 该交付项 may need to be reopened and re-reviewed before shipping |
| 3 | 缺陷出现在**已判 FINISHED 的交付项**上 | **回归**（Regression in completed item —— 该交付项应在阶段跟踪中重开） |

**性质声明（必须写进报告）**：这条改写是**适配，不是新增刻度**——刻度（S1–S4 / P1–P4）与配额表一个字都没改，改的只是「同系统 / 同冲刺 / 同故事」这三个在本项目无对应物的**分组键**。报告中须标注「偏差规则已按阶段口径改写」。

**改写里两个新词的定义**（都在 `dsh-ccgs-studio 的 /bug-report` 与计划文本里有对应物，不是自创）：`module` = 第 1 节登记字段里的模块名（取 `control-manifest.md` 的层名或 `systems-index.md` 的系统号，二选一并全表统一）；**FINISHED** 的判定源 = 计划里该交付项的验收/判据列全部有可核验证据（DoD ③）。**判定源缺失时记 `NOT ASSESSED`，不得当作 FINISHED 也不得当作未完成。**

## 7. 报告骨架与模式

| 模式（逐字） | 用途 | 产物 |
|---|---|---|
| `sprint` | 对当前阶段（＝本项目的一个 M 阶段或子阶段）分诊，可修的进阶段积压，其余延后 | `production/qa/bug-triage-[date].md` |
| `full` | 不管阶段范围的全面分诊 | 同上 |
| `trend` | 只做趋势，不指派；**不读 bug 正文**，只用头部字段算量、严重度分布、按系统与按日期的指标 | 同上 |

无参数时——有当前阶段走 `sprint`，否则 `full`。找不到任何 bug 文件 → 停下，verdict **COMPLETE** — no bug files in `production/qa/bugs/`; nothing to triage。用户拒绝写入 → **BLOCKED** — user declined write。报告含（逐字）：Triage Summary、P1/P2/P3-P4 表、Systemic Issues、Trend Analysis、Recommended Actions。

## 8. `NOT ASSESSED` 纪律（沿用 CCGS，不改）

| 场景 | 记什么 | 不得记 |
|---|---|---|
| 无 bug 文件、无运行记录、无交付项（任一为 0） | `NOT ASSESSED` | `PASS`、豁免、`0` |
| 必测指标无可核验证据 | 证据不足（按第 3 节登记） | `PASS`、豁免 |
| 探针未跑 | `NOT ASSESSED`（结论尚未存在） | `PASS`、`FAIL`、预设结论 |
| 抖动测试运行次数不足 3 次 | **`suspected`**（不隔离；标注 suspected 并询问更多运行数据） | High/Moderate/Low 分层、隔离条目 |

抖动分层口径逐字（`dsh-ccgs-studio 的 /test-flakiness`）：**High flakiness**（**>25%**）→ 立即隔离；**Moderate**（**5–25%**）→ 尽快调查并修复；**Low/suspected**（**1–5%**）→ 监控，可能是真的偶发失败。分层与隔离自 **3 次运行**起生效。引擎跳过机制**只点名对应那一个**；gdUnit4 的 C# 属性与 Unreal 的跳过方式标 **NOT SOURCEABLE**——记入隔离区并问用户，**不要发明属性/开关**。抖动条目追加到 `tests/regression-suite.md` 的隔离区，**绝不删除既有隔离条目**。

## 9. 与其它职责的接口

- 上游：`godot-qa-support` 的「责任 1 · 测试策略」给出关键路径与高优先模块 ⇒ 缺陷登记字段 `module` 取那里的模块名。
- 下游：`godot-qa-support` 的「责任 3 · 发布就绪」拿本文件的**两列计数 + 配额对照**做门禁计数；`godot-qa-support` 的「责任 4 · 回归规划」拿「已判 FINISHED 的交付项出现缺陷＝回归」做回归触发。
- 边界：**缺陷是否达标（配额）的 A（拍板）在评审团验收席位**，本专家只出《缺陷分级清单》（README §8）。配额超标 ⇒ 结论最高「有条件通过」。
