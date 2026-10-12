# 责任 3 · 发布就绪判定

> **何时读**：要回答「这个阶段能不能放行」、要在 `/gate-check` 之前先自评一次、要核对 ADR 状态与红线清单、要出一份《发布就绪报告》的时候。
> **口径来源**：`dsh-ccgs-studio` 的 `/gate-check` `/release-checklist` `/launch-checklist` `/team-release` `/milestone-review` `/smoke-check`；本项目 `production/开发计划-分阶段-v1.md`（DoD 与阶段硬标准）、`production/进度说明-细节.md`、`production/probe-plan-M0b-P6.md`、`production/probe-plan-M0-S1.md`、`docs/architecture/control-manifest.md`、`docs/architecture/adr-*.md`、`review/评审裁决单-Concept-S1等距网格与寻路-2026-10-08.md`、`project.yaml`；框架语料 `D:\AI\test\ccgs-essence\01-设计理念\06-导演门控.md`；本包设计稿 §3.3 §4-R3 §4-R4 §5.3。
> **不覆盖**：回归触发矩阵与性能阈值口径（看 `04-regression-plan.md`）、缺陷定级（看 `02-defect-triage.md`）、探针命令与证据分级（看 `05-evidence-channel.md`）、阶段名的写入（那是 `/gate-check` 的动作）、引擎侧与规则真相源主张的裁定。

## 一、判定流程（顺序不可换）

| 步 | 动作 | 落在本文件哪一节 |
|---|---|---|
| 1 | 贴档位头（`tools/ccgs-config.mjs` 的完整输出块） | `06-framework-corpus.md` §三 |
| 2 | 把目标阶段映射到 CCGS 七阶段坐标 | §二 |
| 3 | 判第 0 层：本项目 DoD 5 条 | §三 |
| 4 | 判本阶段硬标准逐条 | §四 |
| 5 | 核 ADR 状态 | §五 |
| 6 | 核红线清单覆盖 | §六 |
| 7 | 核评审闭环 | §七 |
| 8 | 按阶段取性能预算并对照 | §八 |
| 9 | 用逐门产物清单做「产物齐不齐」的旁证 | §九 |
| 10 | 取一个判定字面量，附评审团口径换算建议 | §十 |
| 11 | 归档证据 | §十一 |

**第 0 层不过，后面八步照做但结论不得高于 `CONDITIONAL`**：第 0 层是项目自己的完成定义，它不通过时任何「其他专项都好看」都不构成放行理由。

**目标阶段不得推定**：`project.yaml` 无 `project.stage`、也无 `production/stage.txt`（两处都无来源可下探）⇒ 先向人确认目标阶段；`/gate-check` 也要求「在跑之前先向人确认探测结果」。阶段名不由本专家写入。

## 二、阶段坐标映射（一次性写死）

| 本项目 | CCGS 七阶段（`gate-check`） | 说明 |
|---|---|---|
| M0 / M0b | Technical Setup | 环境与取证骨架 |
| M1（MS-1 规则可信） | Pre-Production | 规则内核可回归 |
| M2（MS-2 能打）/ M3 | Production | 战斗闭环与角色 |
| M4（MS-3 能演）/ M5 / M6 | Production（后期） | 对话检定、探索存档、内容补齐 |
| M7（MS-4 原型完成） | Polish | 美术与打磨 |
| — | Release | 本项目**尚未到**，`/team-release` 会直接停 |

三条纪律：

1. 本专家**只给映射与判定**，**不写** `project.stage`、也不写 `production/stage.txt`；写入是 `/gate-check` 在 `PASS` 且用户明确确认后的动作（`/gate-check` 亦允许 `CONCERNS` 且用户显式接受全部风险时写入；`FAIL` / `NOT ASSESSED` **绝不写**）。
2. `/gate-check` 的判决优先级逐字为 **`FAIL` → `CONCERNS` → `NOT ASSESSED` → `PASS`**，且 `NOT ASSESSED` **高于** `PASS`。
3. 行内映射的一处口径差异：上表末两行按本包设计稿 §4-R3 逐字照抄；而 `production/开发计划-分阶段-v1.md` §0 的里程碑表把 **MS-4 原型完成 = M5–M7 完成**。判定时以「阶段 ↔ CCGS 阶段」为坐标，里程碑名只作对外表述，不参与门控计数。

## 三、第 0 层 · 本项目 DoD（5 条）

`production/开发计划-分阶段-v1.md` 文件头逐字（**每一阶段都必须同时满足下列 5 条，缺一条即该阶段未完成**）：

> ① headless 测试全绿　② `tools/validate_data.py` 全绿　③ 有**证据**（JSON 报告或截图）　④ 无"待定规则分支"（未裁决的规则必须显式报黄，不允许静默取默认值）　⑤ 每条新增规则函数头部带 `# 来源：docs/<文件> §<节>`

| # | 条款 | 判定规程（可执行） | 判定字面量规则 |
|---|---|---|---|
| ① | headless 测试全绿 | 跑 `project.yaml → commands.test`（gdUnit4 runner：`res://addons/gdUnit4/bin/GdUnitCmdTool.gd -a res://tests`）；退出码 `0` 才算绿；runner 跑不起来、或跑了零个测试，**不得记绿** | 跑不了 / 零测试 ⇒ `NOT ASSESSED`（`/smoke-check` 对这两种情形逐字判 `NOT ASSESSED`） |
| ② | `tools/validate_data.py` 全绿 | **先核该文件在磁盘上是否存在**，存在才谈「全绿」；不存在时无论计划里怎么写都记未评估 | 不存在 ⇒ `NOT ASSESSED`；**不得因为「计划里写了」记 `PASS`** |
| ③ | 有证据（JSON 报告或截图） | 逐条列出本阶段硬标准（§四）要求的证据，核 A 级证据是否在盘（`05-evidence-channel.md` §一），每条给出路径与关键片段 | 某条无 A 级证据 ⇒ 该条 `NOT ASSESSED`；全阶段无证据 ⇒ 该条 `NOT ASSESSED` |
| ④ | 无「待定规则分支」 | 扫 `[TL]`、`[假设]`、`[PLACEHOLDER`、GDD 的 `## Open Questions` 的 Q 编号与承接方；凡影响本阶段判定且无裁决字面量的，逐条点名 | 查了并发现未裁决项 ⇒ `FAIL`（这是「查了，发现阻塞」，不是「查不了」） |
| ⑤ | 每条新增规则函数头部带 `# 来源：docs/<文件> §<节>` | 对 `rules/`、`core/` 的每个规则函数检查头部 `# 来源：` 行；无代码可查时不得算通过 | 无代码 ⇒ `NOT ASSESSED`（「零文件通过」不成立） |

### 3.1 计划点名但磁盘上不存在的可执行物

| 被点名的可执行物 | 点在哪 | 磁盘实况 | 判定 |
|---|---|---|---|
| `tools/validate_data.py` | DoD ②、M0 0.2 / 0.5、计划 §10 第 5 行 | 不存在（`tools/` 下只有 `validate-registry.ps1`） | `NOT ASSESSED` |
| `tools/monte_carlo.py` | M1 1.9、Feature Forbidden「Never 跳过窗口复核直接改 `balance.json`」 | 不存在 | 依赖它的窗口复核与 M6 diff 一律 `NOT ASSESSED` |
| `art_validate.py` | M7 验收（计划 §9） | 不存在 | M7 的「全绿报告」这条 `NOT ASSESSED` |
| `tests/` 与 `addons/gdUnit4/` | `commands.test`、M1 硬标准 1 | 均不存在 | DoD ① 与依赖 headless 测试的硬标准一律 `NOT ASSESSED` |

> 磁盘实况取自 2026-10-11 的目录清点（`production/reports/` 下只有 `balance_baseline_M0.md`）。**每次出报告时重跑一次清点**，不要引用本行当作当期结论。

## 四、阶段硬标准检查表

判定规则：**逐条给一个判定字面量**；本阶段所有条目都 `PASS` 才算该阶段硬标准通过；任一条 `NOT ASSESSED` ⇒ 该阶段不得记 `PASS`（`NOT ASSESSED` 高于 `PASS`）。

### 4.1 M0 · 环境与骨架（计划 §1）

| 条目 | 逐字验收 | 判定规程 |
|---|---|---|
| 0.1 工程与版本 | 工程能被 Godot 打开且无报错；`project.yaml` 的 `engine.name/version` 与实际一致 | 跑一次 headless 打开；核 `project.yaml` 的 `Godot` / `4.7.2` 与 `docs/engine-reference/godot/VERSION.md` |
| 0.2 目录骨架 | `validate_data.py --arch` 能识别结构 | 该脚本不存在 ⇒ `NOT ASSESSED` |
| 0.3 ADR 落成 | 每条冲突有明确裁决字面量 + 理由 + 代价 | 逐份读 ADR 的 Decision / Status（见 §五） |
| 0.4 RNG 与骰子 | `d20` 优势/劣势/大成功/大失败各有断言；同 seed 重放一致 | 需要 `tests/`；无测试 ⇒ `NOT ASSESSED` |
| 0.5 数据校验器 | 对 `docs/职业/` 的 10 张卡抽取数据后报绿（含 δ→六维复算） | 脚本不存在 ⇒ `NOT ASSESSED` |
| 0.6 色板复算 | 对两张锚点图跑出 CIELAB 色板与影调统计 | 核 `production/reports/palette.json`；该文件不在盘 ⇒ `NOT ASSESSED` |
| 0.7 失效路径 | 不再出现「零文件通过」的假绿 | 核 `docs/04-职业卡校验.py` 的路径或作废声明；见 §六分母纪律 |

### 4.2 M0b · P-6 寻路实现路线微基准（`production/probe-plan-M0b-P6.md` §5）

| 项 | 逐字口径 | 判定规程 |
|---|---|---|
| 状态 | 清单**已出 · 未执行**（该文件状态行） | 未执行 ⇒ 本阶段硬标准一律 `NOT ASSESSED` |
| 硬判据 | **`P95 ≤ 2 ms`**（逐字取自 `project.yaml → performance.pathfinding_p95_ms`，**项目红线**） | 任何路线越过 2 ms ⇒ 该路线淘汰，不是「再讨论」 |
| 分档 | **T1 ≤ 0.12 ms**（① 明确胜）· **T2 0.12–0.5**（① 可用，须登记 M4 前复核）· **T3 0.5–2**（须与 ② 直接对比，**② 达不到 ① 的 1/2 就不算理由**）· **T4 > 2 ms**（淘汰 ①） | 档位**事先钉死、跑完不得事后改** |
| 口径标注 | `0.12` / `0.5` 是**助手提案的一次性档位**；项目里**只有 `2 ms` 是红线** | 报告里引用分档必须同时标这句，不得把 0.12 写成项目阈值 |
| 裁定顺序 | 先看硬判据 → 再套档位 → 再看 P-6c（② 的 A16 资格）→ 最后才是无法实测的维度 | 不得跳步、不得事后加权 |
| 前置链 | **P-6 读数 → ADR-0007 → `F·S1` 第 2 轮复评** | 链上任一环缺失，下游一律 `NOT ASSESSED` |

### 4.3 M1 · 规则内核（计划 §3「验收标准（硬）」，5 条）

1. `tests/rules_selftest.gd` 与 `tests/data_selftest.gd` headless 全绿。
2. 10 张卡的 δ→六维档位**复算全部通过**（任何一张不符即失败）。
3. 优势/劣势 **9 格矩阵**全绿（无/优势/劣势 × 无/优势/劣势）。
4. 蒙特卡洛报告落盘 `production/reports/monte_carlo_M1.json`，并对「SB +3 是否过强」给出**明确结论**（不是「看起来还行」）。
5. `rules/` 与 `core/` 中**零 Node 依赖**（架构纪律检查通过）。

判定规程：第 1 条依赖 `tests/`（不存在 ⇒ `NOT ASSESSED`）；第 2、3 条依赖可运行的测试或复算脚本（`tools/validate_data.py` 不存在 ⇒ `NOT ASSESSED`）；第 4 条核该 JSON 是否在盘（不在 ⇒ `NOT ASSESSED`）；第 5 条可静态核（对 `rules/`、`core/` 扫 Node 依赖），无目录时 `NOT ASSESSED`。

### 4.4 M2 · 战斗闭环（计划 §4「验收标准（硬）」，4 条）

1. **固定 seed 跑完整一场 4v5 → 结果快照比对一致**（本阶段最重要的证据）。
2. 反应窗口的挂起/恢复有专项测试；**不允许用异步信号赌时序**。
3. 战斗结束条件（一方全灭 / 目标达成）与总结算（失控/消化钩子被调用）正确。
4. 出 1 张截图（色块阶段即可，用于确认等距网格没有接缝）。

### 4.5 M3 · 角色与组队（计划 §5 验收标准）

三档消化可运行时切换并断言（**不允许只在单测里对**）；失控 80/100 两条路径各跑一遍并出日志；角色卡截图 1 张。

### 4.6 M4 · 对话与检定（计划 §6「验收标准（硬）」，4 条）

1. **角点测试报告**：每个选项在 {属性下限, 属性上限} × {骰 1, 骰 20} 四角点下的走向符合设计（落盘 JSON）。
2. 判卷 2×2 四格全绿，且「猜错零反馈」被断言为**真的没有反馈**。
3. 一条完整链路跑通：对话检定 → 判卷 → 消化 + → **立刻感到变强**（SB 或⭐生效）。
4. 对话截图 1 张。

### 4.7 M5 · 探索 · 物品 · 存档（计划 §7 验收标准）

存档等价报告落盘；「读档刷骰无效」有专项测试；探索截图 1 张。

### 4.8 M6 · 内容补齐与平衡（计划 §0 与 §8）

| 项 | 依据 | 判据 |
|---|---|---|
| 阶段可交付证据 | 计划 §0：全途径蒙特卡洛 + 数据校验全绿 | 两项都需在盘的报告；`tools/validate_data.py` 不存在 ⇒ 后者 `NOT ASSESSED` |
| 6.6 逐卡回读审计 | 计划 §8：把 `data/abilities` 与原文逐条对照，产出对照表 | 有对照表且 10 张卡逐条落行 |
| 6.7 全途径蒙特卡洛 | 计划 §8：更新 `monte_carlo_M6.json` 并与 M1 报告 **diff** | 必须给出 diff 结论；两份 JSON 任一不在盘 ⇒ `NOT ASSESSED` |

### 4.9 M7 · 美术与打磨（计划 §9）

验收逐字：`art_validate.py` 全绿报告 + 5 张截图 + 生成台账完整（seed 与提示词可复现）；另需 7 条美术门禁全绿。

⚠️ **张数口径**：计划 §9 写「A1→A5 共 144 张」，而 `design/美术资源规划-v1.md` 的权威总量为 **A1 = 47 · A3 = 19 · 总 = 165**（`production/进度说明-细节.md` §3.4 记录该统一）。张数的唯一权威来源是 `design/美术资源规划-v1.md`（评审裁决单 §2 #29 对「素材状态口径」的裁定），判定时用它，不用计划 §9 的旧数。

## 五、ADR 状态核对

| 核对项 | 逐字事实 | 判定规程 |
|---|---|---|
| 已验收集 | 6 份 ADR 全部 `Accepted`（**2026-10-07，用户验收**）：`adr-0001` `adr-0002` `adr-0003` `adr-0004` `adr-0005` `adr-0006` | 逐份读到 `> **Status**: **Accepted**` 才算读到；少一份即点名并记 `NOT ASSESSED` |
| 验收权 | `Accepted` 的验收权**只在用户本人**（`/architecture-decision accept`）；`accept` 要求 `## ADR Dependencies` 非空且依赖项自身已 `Accepted` | 本专家不得代替用户验收；起草只产 `Proposed`，不擅自解锁故事 |
| ADR-0007 | 处于 `Proposed`（起草属规划侧，`production/probe-plan-M0b-P6.md` §7 第 2 项逐字要求 `Status = Proposed`） | 磁盘上**尚无** `adr-0007-*.md` ⇒ 该条记「未起草」；不得记为 `Accepted` |
| 依赖图 | 无环：`0001, 0003 → 0002 → 0004 → 0005 → 0006` | 新增 ADR 时重核一次依赖图 |
| 读到状态的前提 | 6/6 份 ADR **没有 `## Status` 标题**，状态写在 `> **Status**: …` 引用行；按段扫描的技能可能 0 命中并读到「未知」 | 只认引用行**实际读到**的内容；读不到记 `NOT ASSESSED`，**不得推定**状态 |
| 修订留痕 | `Accepted` ADR 改动须留修订记录（例：ADR-0005 v4 更正距离口径后 `Status` 仍为 `Accepted`） | 核修订记录段与实际取值是否同轮同步 |

## 六、红线清单核对（`docs/architecture/control-manifest.md`）

| 核对项 | 逐字事实 | 判定规则 |
|---|---|---|
| 版本串 | `Manifest Version`: `2026-10-08.1`（＝ `Last Updated`） | 与报告引用的规则文本对得上才算核对过 |
| 规则总数 | Foundation **31** required / 16 forbidden / 4 guardrails；Core **16** / **10** / 2；Feature 6 / 4 / 0；Presentation 6 / 0 / 0；Global 6 命名 · 4 性能预算 · 1 已批准库 · 18 条禁用 API · 6 条跨切面约束 | 逐层点数；数目对不上即点名并记 `CONCERNS` |
| 门控状态 | **`TD-MANIFEST`: NOT ASSESSED** —— 导演门控（`technical-director`）未执行；**这不是批准** | 该行原样转抄；**不得**把它读成通过，也不得据此给 `READY` |
| 溯源缺口 | Core 新增两条 Forbidden（`allow_partial_path` 禁用 · 单位占据不得写进 `set_point_solid`）**来自 GDD 的引擎参考引用，不在任何 `Accepted` ADR 里**，其 `source` 标注指向一次尚未完成的 ADR-0005 修订 | 这两条**不计入「已溯源规则」的通过计数**；报告里单列「溯源缺口」行，直到补一次 ADR-0005 修订并经 `/create-control-manifest update` 重生成 |
| 重生成口径 | 内容改了但 `Manifest Version` **故意不递增**；下一次合规重生成应铸 `2026-10-08.2` | 递增与否本身是一次判据：手工补丁不铸版 |
| 平台口径 | **移动端阈值判 `N/A`**（本项目 PC only）——这一条是**口径，不是待办** | 按 `N/A` 处理，不登记为缺口 |
| 层内空白 | Feature / Presentation 的 Forbidden 与 Presentation 的 Guardrails 为空，且清单写明「这是如实记录，不是遗漏」；Presentation 性能护栏**不得凭记忆补写** | 空白层按「如实记录」接受，**不得**用推测填满 |

## 七、评审闭环核对

首轮（第 1 轮）评审的裁决单：`review/评审裁决单-Concept-S1等距网格与寻路-2026-10-08.md`。

| 核对项 | 逐字事实 | 判定规则 |
|---|---|---|
| 结论 | `MAJOR REVISION NEEDED`（**驳回**）；`F·S1` → **`Needs Revision`** | 该文档未转为 `Approved` 前，涉及它的放行一律不得 `READY` |
| 计数 | 裁决单 §2 共 **45 行**（Blocker 5 · Major 32 · Minor/Nit 8 聚合行）；§6 未闭环项 **17 条** | 报告里引用计数时同时给「45 行」与「17 项」两个口径，勿混算 |
| 未闭环 | 45 条中 **5 条未闭环**：**`#1` · `#13` · `#14` · `#21` · `#33`**（`#1` 与 `#33` 已从「探针未跑」推进到「待 ADR」） | 逐条给状态，不给「基本都闭环了」这类结论 |
| 决定第 2 轮的关键 | **`#1` 与 `#33` 决定第 2 轮复评能否放行**：P-2 / P-3 双双 FAIL 触发了架构级变更，**ADR 落地前 `#1` 与 `#33` 都不能判闭环**（并连带 `F·S1` 不能排期） | 未闭环 Blocker ≥ 1 ⇒ 结论不得为 `READY` |
| 复评范围与上限 | 复评**只审** §6 的 17 项 ＋ §6.1 的 2 项；上限 **3 轮**；同一席位连续 2 轮复评仍有未闭环 Blocker ⇒ 结论锁定「驳回」并**升级为项目级决策** | 超出范围的项不进复评计数 |
| 复评证据 | 第 2 轮复评产物尚不存在（须**新会话**跑） | 没有复评结论 ⇒ 该层记 `NOT ASSESSED`，不得用第 1 轮的修订记录代替 |

**边界**：评审不归本专家跑（撰写/修订会话里跑评审被明令禁止；复评只审裁决单 §6 的具名项）。本专家只核验闭环台账，不出评审结论。

## 八、性能预算按阶段取值

**铁律**：`project.yaml` 的 `performance` 块填的是**终局（Beta·RC）目标**，各阶段放宽档以**评审团基线**为准（文件不在本仓库，属框架文件）⇒ **核验时按阶段取值，不要把本块的值直接卡到原型阶段**。

**阶段值的权威来源**：`C:\Users\Administrator\.dsh\bundles\dsh-godot-review-board\skills\godot-review-board\references\baseline.md` **§3.2 里程碑门禁指标**（P95 帧时间在第 74 行，场景切换在第 77 行，峰值内存在第 78 行）。项目文档里的 `baseline-engineering.md` §3.2 指向同一张表，但**引用权威以本节为准**。

| 指标 | 原型 | Alpha | Beta·RC（含最终验收） | 来源 |
|---|---|---|---|---|
| P95 帧时间 | **≤ 25 ms** | **≤ 20 ms** | **≤ 16.6 ms**（＝1000 ÷ 60） | 阶段值：`baseline.md` §3.2（裁定方＝**技术**）；项目写入值 `project.yaml → performance.frame_budget_ms` = 16.6 ms |
| 单次寻路 P95 | **≤ 2 ms**（各阶段同值，红线不可放宽） | **≤ 2 ms** | **≤ 2 ms** | `project.yaml → performance.pathfinding_p95_ms`；场景口径 `20×17 格 · 实心点 20% · 满移动力` |
| 场景加载 | — | **≤ 3 s** | **≤ 2 s** | 阶段值：`baseline.md` §3.2 第 77 行「场景切换耗时」；项目写入值 `performance.scene_load_s` = 2 |
| 峰值内存（PC） | — | **3 GB**（3072 MB）＝基线 PC 列 | 基线 **2.5 GB**；**项目登记 3 GB**（裁定 2026-10-11）⇒ 本档取更严的 **2.5 GB** 判 | 阶段值：`baseline.md` §3.2 第 78 行（移动端 / PC 双列）；项目键应为 `performance.memory_ceiling_mb`（现写作 `memory_peak_mb`，见 `06-framework-corpus.md` §四.1） |
| 稳态内存 | — | — | **≤ 1024 MB** | 仅 `project.yaml → performance.memory_steady_mb`（基线表无此指标；与峰值是两个量，**勿混用**） |
| Draw calls | — | — | **≤ 512** | 仅 `project.yaml → performance.draw_call_limit`；**助手提案值**，待 M1 实测复核 |
| 移动端列（峰值 1.5 GB / 1.8 GB / 包体 300 MB） | **`N/A`** | **`N/A`** | **`N/A`** | 本项目 PC(Windows) only；此栏是口径不是待办 |

**基线已登记、而项目未配置的指标**（判定时不得跳过，也不得凭印象放行）：`1% Low FPS`（Alpha ≥ 40 / Beta·RC ≥ 50）· 冷启动时间（Alpha ≤ 8 s / Beta·RC ≤ 6 s）· 8 小时连续运行孤儿节点增长（Beta·RC 无单调增长）· 崩溃率（Alpha ≥ 98% / Beta ≥ 99.5% / 验收 ≥ 99.9%）· 包体大小（PC Beta ≤ 2 GB / 验收 ≤ 1.5 GB）——`project.yaml` 里**没有**对应键 ⇒ 逐条记 `NOT ASSESSED`；任一必测指标缺证据 ⇒ 按「证据不足」处理，**不得记 `PASS` 或豁免**，结论最高「有条件通过」（`baseline.md` §3.2 采样与裁定链）。

五条判定纪律：

1. **不得直接用 16.6 ms 卡原型阶段**：原型/Alpha 档按上表取值；报告里引用 16.6 ms 必须写明它是 Beta·RC 目标。
2. **寻路红线不可放宽**：`2 ms` 是项目红线；A19 的「分阶段折算（原型 ≤3.0 ms / Alpha ≤2.4 ms）」是**助手推导**、不是框架基线，引用时必须标这句，**不得**当作阶段放宽档。
3. **项目值与基线值不一致时按更严者判，并同时写出两个数**：峰值内存即属此列，且方向是**项目比基线宽**——项目登记 3 GB（2026-10-11 裁定），基线 PC 档 Beta·RC 是 ≤2.5 GB ⇒ **本档以 2.5 GB 判**，报告里两个数都写。**不得**因为项目写了 3 GB 就在 Beta·RC 放行；也**不得**把 3 GB 说成「基线 Beta·RC 的值」（它是基线 **Alpha** 档 PC 列的值）。
4. **强制性由 `performance.enforce` 决定**：该键未写 ⇒ 解析为 `warn`（只报 findings）；`block` 时违规即 **blocker** 并让 `/gate-check` 的 Polish 门 `FAIL`；`off` 仅作信息。
5. **键名不匹配会静默降级**：`/perf-profile` 读的是 `performance.target_framerate` / `frame_budget_ms` / `draw_call_limit` / `memory_ceiling_mb`，而本项目写的是 `frame_rate` / `memory_peak_mb` ⇒ 两处对不上时 `/perf-profile` 会读 `NOT ASSESSED`（`06-framework-corpus.md` §四）。权威拼写**已核**（`04-参考/效果映射索引.md` 第 95/96/120 行）且数值已裁定，**但键名尚未改**，改法与顺序见 §四.1。

## 九、逐门产物清单与框架语料替代

| 项 | 事实 | 用法 |
|---|---|---|
| `/gate-check` 的 `references/gate-*.md` | **未交付**（6 份，共 23,649 字节）：逐门控的必需产物清单、质量检查与逐档位削减正文 | 替代物见下一行 |
| `/gate-check` 的 `CONTRACT.md` | **未交付**（11,831 字节） | 其输入/输出保证与硬约束已由 `/gate-check` 正文与语料承载 |
| 替代物 | `D:\AI\test\ccgs-essence\01-设计理念\06-导演门控.md`（**65,792 字节，覆盖 28/28 个门控**的准入标准） | 用它做「本门要求的产物是否齐」的旁证；判定本身仍按 §三–§八 |
| 语料解析顺序 | `$CCGS_ESSENCE_DIR` → `D:\AI\test\ccgs-essence` → `NOT ASSESSED — framework corpus unresolved` | 解析失败时**响亮降级**：一切依赖逐门清单或配置语义的判定记 `NOT ASSESSED — framework corpus unresolved` 并点名缺的文档 |
| 禁止 | **不得靠记忆补正**缺失的逐门清单；也不得用 `ccgs-essence\03-技能` 顶替（同名同源、去重语义未验证） | 语料不可用时如实降级，不编内容 |

## 十、判定与换算建议

输出字面量**逐字**取 `/launch-checklist` 的四值，**取第一条命中**：先 `NOT READY`（阻塞项非空）；否则 `NOT ASSESSED`（任一条目仍未确认——既没凭证据打勾、也没定案、也没标 `N/A`）；否则 `CONDITIONAL`（有条件项非空）；否则 `READY`。

| 判定 | 何时取 | 换算成评审团口径（**建议，不是裁决**） |
|---|---|---|
| `READY` | 无阻塞项、无条件项、无未确认条目 | 建议对应 **通过** |
| `CONDITIONAL` | 有缺口但有绕行或已被显式接受的风险 | 建议对应 **有条件通过** |
| `NOT ASSESSED` | 一项或多项**根本无法运行**（须点名是哪一项、为什么） | 无对应口径；按「证据不足」处理，**不得**折成通过 |
| `NOT READY` | 阻塞项非空（含未闭环 Blocker、红线被违反、崩溃） | 建议对应 **驳回**（阶段门口径里的 `FAIL` 亦建议对应驳回） |

四条纪律：

1. **`NOT ASSESSED` 高于 `CONDITIONAL` 与 `READY`、低于 `NOT READY`**（没人能查的条目不是通过的条目，已知阻塞更可执行）。
2. **缺证据不得记 `PASS`、也不得记豁免**：按 `Major` 登记；当它覆盖的是 Blocker 级准则时按 `Blocker` 登记。**逐条缺证据 ⇒ 最高只能 `CONDITIONAL`**；整层无法评估（连检查都跑不起来）⇒ 记 `NOT ASSESSED`，不是 `CONDITIONAL`。
3. **换算只是建议**：`READY` ↔ 通过、`CONDITIONAL` ↔ 有条件通过、`NOT READY` / `FAIL` ↔ 驳回。**终裁权**：指标整体能不能放行由评审团验收席位汇总 → 主理人终裁；本专家只出证据与建议。
4. **`/gate-check` 形态的判定不要与本判定混用**：需要门控形态时另跑 `/gate-check`（引用 28 门控语料），它给 `PASS` / `CONCERNS` / `NOT ASSESSED` / `FAIL`；**阶段名写入仍由 `/gate-check` 在用户确认后执行**。

### 10.1 发布阶段的三个前置事实（本项目尚未到）

| 技能 | 行为 | 逐字口径 |
|---|---|---|
| `/team-release` | **会直接停**：阶段不是 `Release` 时在第一个阶段前停下、**不派生任何代理** | `The release readiness gate has not passed (project.stage: [stage]) — run /gate-check release first.`；随后在任何 automation 模式下向人问 `[A] Stop — I'll run /gate-check release (recommended)` / `[B] Proceed anyway — override the stage check`。选 [A] → `BLOCKED — release gate not passed`；**覆盖从不改变阶段本身** |
| `/release-checklist` | 读 `platform.cert_tier`；**`unset` 不等于 `none`** | `none` 完全不出认证节并就地留一行说明原因；未设置要问清在范围里的平台，无法确定就标 `### Certification: NOT ASSESSED — cert tier unknown` |
| `/launch-checklist` | 同一组 `cert_tier` 推导，四值逐字为 `none \| itch \| steam \| console` | `none` 整节省略并说明（`Platform Certification: omitted — cert_tier is 'none' (internal/jam release).`）；`itch` 只发 itch.io 上传要求；`steam` 只发 Steamworks；`console` 最重。**未设置 ≠ `none`**：`none` 是一个决定，未设置是一个缺失的决定；未设置时标 `NOT ASSESSED — cert tier unknown` |

现状：`project.yaml` **没有 `platform` 块** ⇒ `platform.cert_tier` 解析为 `unset`。本包的配置动作建议是写 `none`（PC/Windows 单机、无商店），但 `project.yaml` 是项目主存储、**改动须用户批准**，本专家只出清单与依据（`06-framework-corpus.md` §四）。

## 十一、证据归档

| 内容 | 落点 | 依据 |
|---|---|---|
| 发布就绪报告 | `production/qa/release-readiness-[date].md`（本包约定）；项目另有约定时可用 `production/releases/` | `templates/release-readiness.md` 的填法说明 |
| 逐项证据 | `production/qa/evidence/[项-slug]-evidence.md` | `05-evidence-channel.md` §五 |
| 原始日志 | `probe/out/<name>.log`（只增不改） | 同上 |
| 量化报告 | `production/reports/*.json` | 同上 |
| CCGS 形态的门报告 | `production/gate-checks/`（**需人同意**后写入） | `/gate-check` 产出表 |

归档纪律：报告里引用证据一律给**路径 ＋ 关键片段**，不给「我跑过了」这类无法复核的结论；证据分级取 A / B / C / D 四级（`05-evidence-channel.md` §一），C 级外部资料须标访问日期与小节，D 级推测须附证伪方法并单列。
