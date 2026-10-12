# 缺陷台账模板（本项目：Godot 动作 RPG《诡秘之主》）

> **怎么用（三段，先读完再填）**
>
> 1. **写给谁**：写给本项目做缺陷登记、分诊与门禁计数的人，以及评审团验收席位（它按配额拍板）。台账一行 = 一个事实；探针判定与缺陷分开登记（见第 3 节的 `kind` 列）。规程见技能 `godot-qa-support` 的 `references/02-defect-triage.md`；本模板只给字段。
> 2. **存哪**：**单条缺陷**存 `production/qa/bugs/BUG-[NNNN].md`（**四位零填充**，无既有文件时从 **`BUG-0001`** 起，一次多份取连续编号）；**本台账**（汇总视图）存 `production/qa/bugs/defect-register.md` 或 `production/qa/bug-triage-{{YYYY-MM-DD}}.md`。**不新建**编号规则，**不改**既有文件。
> 3. **填的硬纪律**：① 每个阈值/刻度必须带来源；② 判定字面量逐字照抄（`VERIFIED FIXED`、`STILL PRESENT`、`CANNOT VERIFY`、`NOT ASSESSED`、`PASS`、`FAIL`、`suspected`）；③ **两列并写**（CCGS 的 S1–S4 写进 bug 文件，评审团的 Blocker/Critical/Major 用于门禁计数），两套口径**互不折算**；④ **探针判定不是缺陷**：标 `kind: finding`，不计入配额；⑤ **数据缺失记 `NOT ASSESSED`，不得记 0**；⑥ 填完先自查有没有「稍后补」「暂缺」这类未完成残渣或占位问号，没有才落盘（`{{…}}` 是设计好的占位符，允许保留）。

---

## 0. 台账头

| 字段 | 值 | 来源 |
|---|---|---|
| 台账日期 | {{YYYY-MM-DD}} | — |
| 覆盖阶段 / 子阶段 | {{M1 / M0b-P6 / …}} | 阶段映射见 `references/00-alignment.md` |
| 当前档位（门禁用） | {{原型 / Alpha / Beta / 最终验收}} | 配额表见第 4 节 |
| bug 文件搜索范围 | `production/qa/bugs/BUG-*.md` | `dsh-ccgs-studio 的 /bug-report` |
| 无文件时的裁决（逐字） | {{COMPLETE — no bug files in `production/qa/bugs/`; nothing to triage}} | `dsh-ccgs-studio 的 /bug-triage` |

## 1. 单据清单（一行一个事实）

| 编号 | 标题 | `kind` | `module` | 交付项 | 严重度（CCGS 列） | 优先级 | 评审团列 | 状态 | 裁决（逐字） | 证据路径 |
|---|---|---|---|---|---|---|---|---|---|---|
| `BUG-0001` | {{…}} | {{defect / finding}} | {{Foundation · F·S1…}} | {{…}} | {{S1-Critical}} | {{P1-Fix this sprint}} | {{Blocker}} | {{Description / analyze / verify / close}} | {{VERIFIED FIXED / STILL PRESENT / CANNOT VERIFY / —}} | {{…}} |

**列口径**

| 列 | 取值（逐字） | 来源 |
|---|---|---|
| `kind` | `defect`（实现缺陷，计入配额）/ `finding`（探针判定，**不计入**配额） | README §4-R4（skill: godot-qa-support 的 02-defect-triage.md） |
| 严重度 | `S1-Critical` / `S2-High` / `S3-Medium` / `S4-Low` | `dsh-ccgs-studio 的 /bug-report` |
| 优先级 | `P1-Fix this sprint` / `P2-Fix soon` / `P3-Backlog` / `P4-Won't fix` | 同上（`/bug-triage` 写作 `P4 — Won't fix / Deferred`，即已接受的风险，不是愿望单） |
| 评审团列 | `Blocker` / `Critical` / `Major` / `Minor` | `godot-review-board` 的 `references/baseline.md` §3.2 |
| 状态机 | Description / analyze / verify / close | `dsh-ccgs-studio 的 /bug-report` |
| 裁决 | `VERIFIED FIXED` / `STILL PRESENT` / `CANNOT VERIFY` | 同上 |

**归并规则（把严重度列映射到评审团列，逐行照抄 README §4-R4）**

| 事实 | CCGS 列 | 评审团列 |
|---|---|---|
| 崩溃、存档损坏、红线被违反、规则真相源冲突 | S1 | Blocker |
| 核心判定错：d20 优势/劣势矩阵、结算、寻路 P95 超 2 ms | S1 | Critical |
| 功能可用但有偏差、报黄 | S2 | Major |
| 表现、余量、文案 | S3 / S4 | Minor |

> 归并 ≠ 折算：同一事实的两个登记面；`Critical` 不折算成 `Major`，也不进意见级别统计。

## 2. 探针判定登记（`kind: finding`，不计入配额）

| 探针 | 判据（逐字） | 观察值（逐字抄日志） | 结论（逐字 `PASS` / `FAIL`） | 日志路径 | 派生的实现缺陷编号 |
|---|---|---|---|---|---|
| {{P-6a}} | {{P95 ≤ 0.12 ms}} | {{…}} | {{…}} | `probe/out/{{…}}.log` | {{BUG-000N / —}} |
| {{P-5}} | {{重规划最大}} | {{策略1·逐格剪：重规划最大 = 10}} | {{FAIL}} | `probe/out/p5_replan.log` | {{…}} |

> 一行里多个判据各自一条 finding，不得合并成一个等级。禁止把「看起来对」写成 `PASS`；探针未跑记 `NOT ASSESSED`（结论尚未存在），不得预设结论。

## 3. 阶段配额对照（本台账的门禁表）

| 档 | 配额 | 本阶段计数 | 是否超标 | 来源 |
|---|---|---|---|---|
| Blocker | {{原型/Alpha 前：0（硬）｜Alpha：0｜Beta：0｜验收：0}} | {{…}} | {{是/否/NOT ASSESSED}} | README §4-R4 ＋ `godot-review-board` 的 `references/baseline.md` §3.2 |
| Critical | {{原型/Alpha 前：逐条登记｜Alpha：≤5｜Beta：0｜验收：0}} | {{…}} | {{…}} | 同上 |
| Major | {{原型/Alpha 前：不设数｜Alpha：不限｜Beta：≤10｜验收：≤3（其余须书面豁免）}} | {{…}} | {{…}} | 同上 |
| reopen 率 | {{Beta：≤15%｜验收：≤10%}} | {{…}} | {{…}} | 同上 |

- `references/baseline.md` §3.2 的「原型」列原文是 `Blocker 不限`；本项目按 README §4-R4 取**更严的 Blocker 0（硬）**，引用时标明这是本项目的收严口径。
- **无文件 / 零运行 / 分母为 0 ⇒ 记 `NOT ASSESSED`，不得记 0。**
- 任一档超标 ⇒ 结论最高「有条件通过」（`godot-review-board` 的 `SKILL.md`）。**配额是否达标的 A（拍板）在评审团验收席位**，本台账只出计数。

## 4. 证据不足登记（必测指标无可核验证据）

| # | 指标 | 缺什么证据 | 登记面（按 `Major` 级）；覆盖 Blocker 级准则时按 `Blocker` | 未闭环？ |
|---|---|---|---|---|
| {{1}} | {{…}} | {{…}} | {{Major}} | {{是}} |

> 缺证据**不得记 `PASS`，也不得记豁免**，只能记证据不足并强制列入未闭环项（`godot-review-board` 的 `SKILL.md`）。本项目 M0 的实例：`TD-MANIFEST: NOT ASSESSED` **不是批准**（`control-manifest.md` 文件头逐字）。

## 5. 偏差检查（按阶段口径改写，须标注「已改写」）

| 序 | 触发条件（逐字） | 报告里要写的话 | 本阶段命中 |
|---|---|---|---|
| 1 | 同模块同阶段 ≥ 3 个 bug | Potential design or implementation quality issue in [module] | {{…}} |
| 2 | 同一交付项 ≥ 2 个 S1/S2 | 该交付项 may need to be reopened and re-reviewed before shipping | {{…}} |
| 3 | 缺陷出现在已判 FINISHED 的交付项上 | **回归**（Regression in completed item） | {{…}} |

> **性质声明**：刻度（S1–S4 / P1–P4）与配额表未改一个字，只把「同系统 / 同冲刺 / 同故事」三个本项目无对应物的分组键换成「同模块 / 同阶段 / 同交付项」⇒ 这是**适配，不是新增刻度**。`FINISHED` 的判定源 = 该交付项验收/判据列全部有可核验证据；判定源缺失时记 `NOT ASSESSED`。

## 6. 抖动（flaky）登记

| 测试 | 运行次数 | 失败率 | 分层（逐字） | 处置 | 数据是否足够 |
|---|---|---|---|---|---|
| {{…}} | {{…}} | {{…%}} | {{High flakiness / Moderate / Low/suspected}} | {{立即隔离 / 尽快调查并修复 / 监控}} | {{不足 3 次 ⇒ 一切发现记 `suspected`，不隔离}} |

> 分层口径逐字：**High flakiness**（**>25%**）→ 立即隔离；**Moderate**（**5–25%**）→ 尽快调查并修复；**Low/suspected**（**1–5%**）→ 监控。分层与隔离自 **3 次运行**起生效。隔离条目**追加**到 `tests/regression-suite.md` 的隔离区，**绝不删除既有条目**（`dsh-ccgs-studio 的 /test-flakiness`）。

## 7. 趋势（`trend` 模式：只读头部字段，不读正文）

| 维度 | 本阶段 | 上一阶段 | 变化 | 说明 |
|---|---|---|---|---|
| 量（按 `kind` 分列） | {{…}} | {{…}} | {{…}} | 数据缺失记 `NOT ASSESSED` |
| 严重度分布 | {{…}} | {{…}} | {{…}} | {{…}} |
| 按模块 | {{…}} | {{…}} | {{…}} | {{…}} |
| 按日期 | {{…}} | {{…}} | {{…}} | {{…}} |
| reopen 率 | {{…}} | {{…}} | {{…}} | 无分母记 `NOT ASSESSED` |

## 8. 分诊报告骨架（逐字小节名）

| 小节（逐字） | 填什么 |
|---|---|
| Triage Summary | {{…}} |
| P1/P2/P3-P4 表 | {{…}} |
| Systemic Issues | {{…}} |
| Trend Analysis | {{…}} |
| Recommended Actions | {{…}} |

## 9. 落盘记录

| 字段 | 值 |
|---|---|
| 分诊产物路径 | `production/qa/bug-triage-{{YYYY-MM-DD}}.md` |
| 本台账路径 | `production/qa/bugs/defect-register.md` |
| 模式（逐字） | {{sprint / full / trend}} |
| 落盘裁决（逐字） | {{COMPLETE — triage report written / BLOCKED — user declined write / COMPLETE — no bug files…}} |
| 容量已满时的处置 | {{Priority overflow — consider pulling from sprint}}（不得自动指派；严重度客观、优先级是团队决定） |
| 是否已标注「偏差规则已按阶段口径改写」 | {{是/否}} |
