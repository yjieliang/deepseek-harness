# 测试策略书模板（本项目：Godot 动作 RPG《诡秘之主》）

> **怎么用（三段，先读完再填）**
>
> 1. **写给谁**：写给本项目下一阶段要动手写测试的人，以及评审团的验收与代码席位。填完后，读的人应当能只靠本表判断「这一阶段要测什么、测到什么程度算完、缺的证据在哪」，不需要再回头读规划文档。规程与判定纪律见技能 `godot-qa-support` 的 `references/01-test-strategy.md`；本模板只给字段，不重复规程。
> 2. **存哪**：`production/qa/test-strategy-{{阶段}}-{{YYYY-MM-DD}}.md`（一次一阶段一份，不覆盖旧文件；`production/qa/` 不存在时先建目录）。
> 3. **填的硬纪律**：① 每个数字/阈值**必须带来源**（技能名如 `dsh-ccgs-studio 的 /qa-plan`、或文档路径如 `project.yaml → performance.pathfinding_p95_ms`）；② 确实没有来源的写 `源包经验起点，须按项目调整`，**禁止自创数字**；③ 判定字面量逐字照抄，不翻译、不改大小写（`NOT ASSESSED`、`PASS`、`FAIL`、`COVERED`、`MISSING`）；④ 空格必须写原因，只能从下面四个里选：`N/A — 该模块无引擎侧行为`、`N/A — 阶段未到`、`NOT ASSESSED — 缺证据`、`MISSING — 已找过，那里没有`；⑤ **本项目未产出用户故事之前不调用 `/qa-plan`**（零故事会被 N=0 守卫拦下，报 `NOT ASSESSED — no stories in scope`，不得绕过）；⑥ 填完先自查：有没有「稍后补」「暂缺」这类未完成残渣或占位问号，没有才落盘（`{{…}}` 是设计好的占位符，允许保留）。

---

## 0. 档位头（从配置解析器输出粘贴，不手写）

| 键 | 值 | 来源 |
|---|---|---|
| `modes.rigor` | {{standard}} | `project.yaml` |
| `modes.workflow` | {{standard}} | 展开自 `rigor:standard` |
| `qa.level` | {{standard}} | 展开自 `rigor:standard` |
| `docs.density` | {{balanced}} | 展开自 `rigor:standard` |
| `modes.review_mode` | {{lean}} | 展开自 `rigor:standard` |
| `team.size` | {{individual}} | 展开自 `rigor:standard` |

> 档位头由 `node tools/ccgs-config.mjs` 输出，逐行带 `(source)`；本表照抄，**不得手改**。解析器输出见 `references/06-framework-corpus.md`。

## 1. 范围与阶段身份

| 字段 | 填写 |
|---|---|
| 本策略覆盖的阶段 / 子阶段 | {{M1 / M0b-P6 / …}} |
| 对应的 CCGS 七阶段（映射后） | {{Pre-Production / Technical Setup …}}（映射表见 `references/00-alignment.md`） |
| 本阶段是否已产出用户故事 | {{否 → 以交付项充当 story；是 → 改跑 `/qa-plan`，本表作废}} |
| 成熟度档位 | {{零基础（无 tests/、无 addons/，证据只有探针）/ …}} |
| 本阶段硬标准（逐条抄，带文档路径） | {{…}} |

## 2. 输入清单

| # | 输入 | 落盘位置 | 可用 | 不可用时记 |
|---|---|---|---|---|
| I1 | DoD 5 条 | `production/开发计划-分阶段-v1.md` 文件头 | {{是/否}} | `NOT ASSESSED` |
| I2 | 本阶段硬标准 | {{同文件 §…/ 探针计划 §…}} | {{是/否}} | `NOT ASSESSED` |
| I3 | 分阶段交付项清单 | {{同文件 §0 ＋ 任务表}} | {{是/否}} | `NOT ASSESSED` |
| I4 | 探针判定 | `probe/out/*.log` | {{是/否}} | `NOT ASSESSED`（探针未跑 ⇒ 结论尚未存在） |
| I5 | 档位头 | {{配置解析器输出}} | {{是/否}} | `NOT ASSESSED` |

## 3. 金字塔比例

| 层 | 目标占比 | 本阶段计划用例数 | 偏离原因（无偏离写 `—`） |
|---|---|---|---|
| 单元 | {{50–60%}} | {{…}} | {{…}} |
| 集成与行为 | {{20–30%}} | {{…}} | {{…}} |
| 冒烟与回放 | {{10–20%}} | {{…}} | {{…}} |

> 占比来源：源包 `game-automated-testing` 的 `references/01-test-strategy-and-pyramid.md`；本次**未能读取该文件** ⇒ 照 README §5.1 写为「**源包经验起点，须按项目调整**」，**不得自创别的比例**。

## 4. 关键路径（三条筛选：改得多 / 错了痛 / 判定清）

| 模块 | 改得多 | 错了痛 | 判定清 | 判定依据（文档路径 + 节/行） | 是否进关键路径 |
|---|---|---|---|---|---|
| {{rules/ ＋ core/}} | {{是}} | {{是}} | {{是}} | {{M1 硬标准第 5 条}} | {{是}} |
| {{数值结算}} | {{…}} | {{…}} | {{…}} | {{…}} | {{…}} |
| {{存档等价}} | {{…}} | {{…}} | {{…}} | {{…}} | {{…}} |
| {{网格与寻路}} | {{…}} | {{…}} | {{…}} | {{project.yaml → performance.pathfinding_p95_ms}} | {{是}} |

> 三条筛选缺一条即不进关键路径；不进的原因写在这一行，别留空。关键路径条数为 0 时，覆盖状态的分母守卫会触发 ⇒ 记 `NOT ASSESSED`，不得出空表。

## 5. 模块 × 层矩阵

| 模块（来源：`control-manifest.md` 分层 / `systems-index.md` 系统号） | 单元 | 集成与行为 | 冒烟与回放 |
|---|---|---|---|
| {{Foundation · F·S1 等距网格与寻路}} | {{…}} | {{…}} | {{…}} |
| {{Core · C·S25 战斗伤害结算}} | {{…}} | {{…}} | {{…}} |
| {{Feature · E·S32 装备与熟练}} | {{…}} | {{…}} | {{…}} |
| {{Presentation · P·S42 战斗 HUD}} | {{…}} | {{…}} | {{…}} |
| {{…}} | {{…}} | {{…}} | {{…}} |

> 空格只能填四个原因之一：`N/A — 该模块无引擎侧行为` / `N/A — 阶段未到` / `NOT ASSESSED — 缺证据` / `MISSING — 已找过，那里没有`。`MISSING` 与 `NOT ASSESSED` 不可互换（口径见 `dsh-ccgs-studio 的 /test-evidence-review`）。

## 6. 探针证据登记（判定 ≠ 缺陷）

| 探针 | 判据（逐字） | 观察值（逐字抄日志） | 结论（逐字 `PASS` / `FAIL`） | 日志路径 | 是否派生实现缺陷 |
|---|---|---|---|---|---|
| {{P-6a}} | {{P95 ≤ 0.12 ms}} | {{…}} | {{…}} | `probe/out/{{…}}.log` | {{是/否}} |
| {{…}} | {{…}} | {{…}} | {{…}} | {{…}} | {{…}} |

> 探针条目登记进缺陷台账时标 `kind: finding`，**不计入缺陷配额**；由它派生的实现缺陷才计入（见 `references/02-defect-triage.md` §5）。禁止把「看起来对」写成 `PASS`，禁止事后改档。

## 7. 三数估算

| 模块 | 乐观 | 现实 | 悲观 | 单位 | 三者差在哪（一句话） |
|---|---|---|---|---|---|
| {{…}} | {{…}} | {{…}} | {{…}} | {{用例数 / 人时}} | {{是否含引擎侧行为用例}} |
| {{…}} | {{…}} | {{…}} | {{…}} | {{…}} | {{…}} |

## 8. QA 计划骨架（六小节名逐字）

### 8.1 Test Summary

| 交付项（充当 story） | 编号 | 类型（Logic / Integration / Visual/Feel / UI / Config/Data） | 判据来源 | 自动化 | 证据路径 |
|---|---|---|---|---|---|
| {{…}} | {{…}} | {{Logic}} | {{…}} | {{是/否}} | {{…}} |

### 8.2 Automated Tests Required

| 交付项 | 单元用例 | 集成用例 | 备注 |
|---|---|---|---|
| {{…}} | {{…}} | {{…}} | {{qa.level: minimal 时整节省略，并写「已按 qa.level: minimal 省略」}} |

### 8.3 Manual QA Checklist

| # | 只能人工看的项 | 判据 | 观察方式（截图 / 目测 / 试玩） | 结果 |
|---|---|---|---|---|
| {{1}} | {{…}} | {{…}} | {{…}} | {{PASS / FAIL / NOT ASSESSED}} |

> `NOT ASSESSED` 高于 `PASS`（README §4-R4）。

### 8.4 Smoke Test Scope

| 站位 | 命令（逐字取自 `project.yaml → commands`） | 判据 | 证据 |
|---|---|---|---|
| 启动冒烟 | `"D:/Godot/Godot_v4.7.2-stable_win64.exe" --headless --quit-after 5` | 退出码 + 日志 | {{…}} |
| 主流程冒烟 | {{…}} | {{…}} | {{…}} |
| 探针冒烟 | {{references/05-evidence-channel.md 的统一入口}} | {{0 = 通过 / 非 0 = 失败}} | {{…}} |

### 8.5 Playtest Requirements

| # | 需要几个人 | 盲测还是自测 | 看哪些指标 | 采样要求 | 状态 |
|---|---|---|---|---|---|
| {{1}} | {{…}} | {{…}} | {{…}} | {{无试玩记录 ⇒ NOT ASSESSED}} | {{…}} |

### 8.6 Definition of Done — This Sprint

| DoD 序 | 条目（逐字要点） | 本阶段证据（文件路径） | 判定 |
|---|---|---|---|
| ① | headless 测试全绿 | {{…}} | {{PASS / NOT ASSESSED}} |
| ② | `tools/validate_data.py` 全绿 | {{该文件不存在 ⇒ 记 NOT ASSESSED，不得记 PASS}} | {{NOT ASSESSED}} |
| ③ | 有**证据**（JSON 报告或截图） | {{…}} | {{…}} |
| ④ | 无"待定规则分支"（未裁决的规则必须显式报黄，不允许静默取默认值） | {{…}} | {{…}} |
| ⑤ | 每条新增规则函数头部带 `# 来源：docs/<文件> §<节>` | {{…}} | {{…}} |

> Visual/Feel 与 UI 的截图行**在任何档位下都不砍**（`dsh-ccgs-studio 的 /qa-plan`）。

## 9. 前瞻缺口清单

| 系统（`systems-index.md` 编号 + 名） | 优先级层（MVP 36 / Vertical Slice 10 / Alpha 2 / Full Vision 1） | 本阶段纳入？ | 未纳入的原因 |
|---|---|---|---|
| {{F·S1 等距网格与寻路}} | {{MVP}} | {{是}} | {{—}} |
| {{…}} | {{…}} | {{否}} | {{N/A — 阶段未到}} |

> 系统总数与 MVP 数逐字取自 `design/gdd/systems-index.md`：`System Count: 49`（Foundation 13 ＋ Core 17 ＋ Feature 8 ＋ Presentation 8 ＋ Polish 3）；`MVP 36 · Vertical Slice 10 · Alpha 2 · Full Vision 1 ＝ 49`。

## 10. 未确认事项（原样带出，不得含糊）

| # | 未确认的事 | 处置 |
|---|---|---|
| {{U1}} | {{…}} | {{记 NOT ASSESSED / 挂探针 / 问用户}} |
| {{U2}} | {{…}} | {{…}} |
| {{U3}} | {{…}} | {{…}} |

## 11. 落盘记录

| 字段 | 值 |
|---|---|
| 产物路径 | `production/qa/test-strategy-{{阶段}}-{{YYYY-MM-DD}}.md` |
| 落盘裁决（逐字） | {{COMPLETE / COMPLETE — shown, not written / BLOCKED — user declined write}} |
| 是否调用过 `/qa-plan` | {{否 —— 零故事，守卫拦下并报 `NOT ASSESSED — no stories in scope` / 是 —— 已进入故事流}} |
