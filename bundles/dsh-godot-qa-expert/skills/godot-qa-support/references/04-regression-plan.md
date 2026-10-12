# 责任 4 · 回归规划

> **何时读**：任何一次变更要定「这次该跑什么」、任何一次要拿实测值与基线对比、任何一次要判覆盖缺口或不稳定用例、任何一次要在阶段收尾前出回归结论。
> **口径来源**：`dsh-ccgs-studio` 的 `/regression-suite`（覆盖状态与分母守卫）、`/test-flakiness`（抖动分层与隔离）、`/smoke-check`（冒烟四值判定与必需性档位）、`/perf-profile`（预算键与 `enforce` 三值）；本项目 `production/开发计划-分阶段-v1.md`、`production/probe-plan-M0-S1.md`、`production/probe-plan-M0b-P6.md`、`project.yaml`、`docs/architecture/control-manifest.md`、`review/评审裁决单-Concept-S1等距网格与寻路-2026-10-08.md`；本包设计稿 §3.4 §5.4。
> **不覆盖**：测试怎么分层与写在哪（看 `01-test-strategy.md`）、缺陷怎么定级（看 `02-defect-triage.md`）、就绪判定（看 `03-release-readiness.md`）、探针命令与证据分级（看 `05-evidence-channel.md`）。

## 一、触发矩阵（本项目真实触发源）

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

判定纪律（对全部八行生效）：**一次触发只跑它那一行要求的范围**，不默认全量；跑不了的项记 `NOT ASSESSED` 并点名缺什么（缺脚本、缺测试、缺报告），**不得**用相邻证据替代。

## 二、八条规程逐行展开

### 2.1 改 `balance.json` / 数值

| 项 | 内容 |
|---|---|
| 触发条件 | `data/balance.json` 任何数值改动，或任何途径数值、敌人数值、遭遇配比改动 |
| 必跑 | ① 重跑 `tools/monte_carlo.py`；② 复核 W1–W5 全部五条窗口；③ 更新 `production/reports/balance_baseline_M*.md` |
| 依据 | `control-manifest.md` Feature Forbidden：**Never 跳过窗口复核直接改 `balance.json`**——改数流程逐字为「改 `balance.json` → 重跑 `tools/monte_carlo.py` → 复核 W1–W5 → 更新 `production/reports/balance_baseline_M*.md`」 |
| 判据 | W1 命中 **55–70%** · W2 脆皮存活 **2.5–4 回合** · W3 遭遇 **3–5 回合** · W4 低池 **3–5 回合** · W5 前后排 **≤3×**（`production/进度说明-细节.md` §2.5，来源 ADR-0006）；逐条给 PASS/FAIL |
| 停止条件 | `tools/monte_carlo.py` 在磁盘上**不存在** ⇒ 本行无法执行，记 `NOT ASSESSED`（点名缺该工具），**不得**记为「已复核」 |
| 基线现状 | `production/reports/` 下现有 `balance_baseline_M0.md`；新基线以同一张表的列口径追加 |

### 2.2 规则真相源变更（`docs/`）

| 项 | 内容 |
|---|---|
| 触发条件 | `docs/` 下任何规则文档改动（含职业卡、总纲、规则速查），或裁决改动了规则口径 |
| 必跑 | ① 10 张职业卡的 δ→六维档位**复算全部通过**；② 优势/劣势 **9 格矩阵**全绿（无/优势/劣势 × 无/优势/劣势）；③ 受影响断言逐条重跑 |
| 依据 | M0 0.5（校验器对 10 张卡报绿，含 δ→六维复算）与 M1 硬标准第 2、3 条（`production/开发计划-分阶段-v1.md` §1 §3） |
| 判据 | 逐条 PASS/FAIL；任何一张卡不符即失败 |
| 前置纪律 | 规则真相源是 `docs/`：**任何对规则的改动先问用户**，不得擅自回退已确认的红线（`AGENTS.md` Project Notes） |
| 停止条件 | 复算脚本 `tools/validate_data.py` 不存在 ⇒ 第 ① 项 `NOT ASSESSED`；`tests/` 不存在 ⇒ 第 ③ 项 `NOT ASSESSED` |

### 2.3 引擎 / 平台 / 渲染后端变更

| 项 | 内容 |
|---|---|
| 触发条件 | 引擎小版本、渲染后端（本项目现为 **Compatibility**）、平台目标、`.claude/docs/technical-preferences.md` 的口径变更 |
| 必跑 | ① P-0 环境探针；② 受影响探针重跑（`p1_cell_shape` / `p2_extra_edge` / `p3_diagonal_cut` / `p4_partial_path` / `p5_replan`） |
| 依据 | 版本绑定：引擎可执行文件与版本写在 `project.yaml → engine`（`Godot` / `4.7.2` / `Compatibility` / `Godot Physics 2D`）；`docs/engine-reference/godot/VERSION.md` 标 Risk **HIGH** |
| 判据 | 报告须**声明版本与后端**并**附原始日志**；口径逐字命令见 `05-evidence-channel.md` §二，永远是 `..._win64_console.exe --headless --path probe --script res://<name>.gd --log-file ...` |
| 附带红线 | 「锁定一个 4.x 小版本并冻结升级至 Alpha 结束」是项目级红线；本项目**尚无状态声明** ⇒ 每次引擎变更必须写明是否违反该冻结 |
| 停止条件 | 引擎变更后未重跑任何探针 ⇒ 受影响断言一律 `NOT ASSESSED`；**绝不**用变更前的读数顶替 |

### 2.4 ADR `## Validation Criteria` 登记的复审触发

| 项 | 内容 |
|---|---|
| 触发条件 | ADR 的 `## Validation Criteria` 登记的复审条件命中：**格区放大**（基准场景从 20×17 放大）、**占据率上升**；另含 ADR-0005 已知风险的量化观察项 **E-Δ1**（斜向步数占总步数比例，挂 M2 战斗闭环） |
| 必跑 | 对应的探针，或 **P-6 微基准**（`production/probe-plan-M0b-P6.md`：P-6a…P-6e） |
| 依据 | M0b §5.2 **T2 档**：落在 `0.12–0.5 ms` 时 ADR 的 `## Validation Criteria` 必须登记「M4 前按实测复核」＋复审触发 |
| 判据 | **P95 ≤ 2 ms**（硬红线，逐字取自 `project.yaml → performance.pathfinding_p95_ms`）；T2 档另须登记 M4 前复核 |
| 附加判据 | E-Δ1：斜向步数占总步数比例 **> 60% ⇒ 报 `CONCERNS`** 并触发 ADR-0005 复审（裁决单 §2 #16；60% 是 `control-manifest` 的红线值，**不得在 GDD 或报告里单方改**） |
| 停止条件 | P-6 未跑（该计划状态为「清单已出 · 未执行」）⇒ 本行 `NOT ASSESSED`；**不得预设 P-6 的结论**，也不得事后改档 |

### 2.5 里程碑 M6

| 项 | 内容 |
|---|---|
| 触发条件 | M6（内容补齐与平衡）收尾 |
| 必跑 | 更新 `monte_carlo_M6.json`，并与 **M1 报告 diff**（基线须是 `production/reports/monte_carlo_M1.json`，M1 硬标准第 4 条要求它落盘） |
| 依据 | `production/开发计划-分阶段-v1.md` §8 第 6.7 行逐字：「更新 `monte_carlo_M6.json` 并与 M1 报告 diff」 |
| 判据 | **给出 diff 结论**（不是「跑过了」）；差异项逐条命名，并说明是数值漂移还是规则改动所致 |
| 停止条件 | 两份 JSON 任一不在盘 ⇒ `NOT ASSESSED`（`production/reports/` 现有文件里没有它们） |

### 2.6 存档格式变更

| 项 | 内容 |
|---|---|
| 触发条件 | 存档字段、版本号、迁移逻辑、或任何会写进存档的运行时状态发生变更 |
| 必跑 | ① 存档等价报告；② 「**读档刷骰无效**」专项 |
| 依据 | `production/开发计划-分阶段-v1.md` §7 验收标准（存档等价报告落盘；「读档刷骰无效」有专项测试）与 §7 第 5.6 行（存→读→深比较等价；RNG 回滚后重放结果一致） |
| 判据 | **等价**：存→读→深比较通过；RNG 回滚后重放结果一致 |
| 已登记的具体对象 | `diagonal_steps_used` 作为显式存档字段保留、写入时按 `uint8` 压缩（人裁 2026-10-08）；ADR-0003 的三层分层（状态 / 资源池 / 长期轨迹）与旧平铺结构的读档兼容 |
| 停止条件 | 无存档实现（`save/`、`migrations.gd` 不在盘）⇒ 本行 `NOT ASSESSED` |

### 2.7 主场景接入

| 项 | 内容 |
|---|---|
| 触发条件 | 主场景接入（`project.godot` 的 `run/main_scene` 从留空改为有值），或首次产出可启动的构建 |
| 必跑 | ① 启动冒烟：`--headless --quit-after 5`；② 主流程冒烟 |
| 依据 | `project.yaml → commands.smoke`：`"D:/Godot/Godot_v4.7.2-stable_win64.exe" --headless --quit-after 5` |
| 判据 | **退出码 + 日志**；判定字面量取 `/smoke-check` 的四值 **`PASS` / `PASS WITH WARNINGS` / `NOT ASSESSED` / `FAIL`**，按序首个匹配；超时（exit 124）一律 `FAIL` |
| 现状 | `project.godot` 注释逐字：「run/main_scene 故意留空：引擎设置阶段还没有任何场景」⇒ 今天没有「主场景」可冒烟；探针脚本多以裸 `quit()` 结束、**退出码判据项目未规定** ⇒ 在统一入口补齐前，启动冒烟只能记 `NOT ASSESSED` 并说明原因（`05-evidence-channel.md` §四） |
| 必需性 | 冒烟是**地板**，不在 `qa.level` 放宽之列（`/gate-check`）；`qa.level: standard` 时阶段转换前必需 |

### 2.8 不稳定用例

| 项 | 内容 |
|---|---|
| 触发条件 | 同一用例在无代码改动时既出现过 PASS 也出现过 FAIL；或一次运行内出现无法复现的失败 |
| 必跑 | 重复运行取证（≥ 3 次），按 §七 分层；命中隔离档则先隔离、再决定是否入闸 |
| 依据 | `/test-flakiness` 的失败率分层与「不足 3 次运行」规则；本项目无 CI ⇒ 只能靠重复运行取证 |
| 判据 | **隔离区留痕**：`tests/regression-suite.md` 的 `## Quarantined Tests` 追加条目；隔离**不是删除**（既有隔离条目绝不删） |
| 停止条件 | 不足 3 次运行 ⇒ 一律记 `suspected`，**不隔离**；无 CI 日志时不得声称已检出抖动率 |

## 三、冒烟三级站位

| 站位 | 何时用 | 跑什么 | 对应技能模式 | 判据 |
|---|---|---|---|---|
| 一级 · 改一行 | 单文件、单函数的局部改动，快速自检 | 最小范围：目标模块的定向冒烟 + 启动冒烟 | `/smoke-check quick`（跳过覆盖扫描与 Batch 3，用于快速复检） | 四值首个匹配；`FAIL` 即停手 |
| 二级 · 单模块 | 一个模块收口、准备合并 | 该模块的关键路径清单（模板见 `templates/regression-plan.md`） | 无 CCGS 对应模式 ⇒ **本包适配**（按模块列关键路径，不伪造故事） | 同上，另记覆盖状态 |
| 三级 · 全量 | 阶段转换前、里程碑前 | `/smoke-check sprint` 的默认全量 + 关键路径批次；多平台时加 `--platform` 批次 | `/smoke-check sprint`（默认；`--platform pc|console|mobile|all` 输出逐平台判决表） | 同上 + 逐平台判决表 |

三条纪律：

1. **冒烟报告落 `production/qa/smoke-[date].md`**（需批准后写）。
2. `qa.level: minimal` 时冒烟**可选**、`FAIL` 仅提示不阻断；`standard` 阶段转换前必需；`full` 每次提交前必需。本项目 `qa.level` 由 `modes.rigor: standard` 展开为 `standard` ⇒ **阶段转换前必需**。
3. 站位只决定**范围**，不决定**是否**跑：任何站位都不得跳过启动冒烟（它在有主场景之后是地板）。

## 四、基线五要素

| # | 要素 | 具体要求 | 本项目取值 |
|---|---|---|---|
| 1 | **场景固定** | 格区尺寸、实心点占比、移动力、操作序列、seed 全部逐字相同；换了任何一项就是新场景，不是新基线 | 基准场景逐字：**20×17（340 格）· 实心点 20% · 满移动力 30 尺 = 6 格 · `seed = 20261008`**（P-5 读数口径，`production/probe-plan-M0-S1.md` §8） |
| 2 | **机器固定** | 同一台机器（CPU/GPU/内存/电源策略）上对比；跨机器只能比趋势，不能比阈值 | 换机器 ⇒ 见下「重建基线」 |
| 3 | **构建固定** | 同一构建（引擎版本 + 渲染后端 + 导出配置 + 提交号）上对比 | 引擎 `4.7.2-stable`、后端 `Compatibility` |
| 4 | **≥3 次取中位数并丢弃首次预热** | 首次运行含预热与缓存填充，丢弃；其余取中位数 | 与 `/test-flakiness` 的「分层与隔离自 **3 次运行**起生效」同源，两侧都是 3 次这个数 |
| 5 | **版本一一对应** | 引擎版本、渲染后端、基线文件三者一一对应，基线文件里写明它是在哪个版本/后端下取的 | 基线报告首部必须同时写这三项 |

**换机器 / 换引擎 / 换后端 ⇒ 重建基线**（不是与旧基线对比）。重建后在报告里保留旧基线并标注它的失效原因，**不要删**。

判据：五要素任一不满足（例如机器变了却拿旧基线比、或只跑 1 次）⇒ 该次对比记 `NOT ASSESSED`，不得出「劣化 X%」的数。

## 五、阈值口径

| 指标 | 阈值 | 动作 | 来源 |
|---|---|---|---|
| 帧时间劣化 | **> 5%** | **失败** | 本包设计稿 §3.4（**源包经验起点，须按项目调整**——这一组四条阈值没有本项目文档出处，引用时必须带这句标注） |
| 长帧占比 | **+1pp** | **失败** | 同上 |
| 内存峰值 | **+10%** | 警告 | 同上 |
| 加载时长 | **> 15%** | 警告 | 同上 |
| 崩溃 | **零容忍**（出现一次即失败） | **失败** | 同上 |
| 单次寻路 P95 | **> 2 ms** | **失败**（该路线淘汰） | `project.yaml → performance.pathfinding_p95_ms`，**项目红线**；场景口径 `20×17 格 · 实心点 20% · 满移动力` |

两条不可混用的口径：

1. **寻路红线是本项目唯一钉死的性能红线，不可放宽**。`0.12` / `0.5`（P-6 的 T1 / T2 分档）只是**提案档**，会随实测重定；报告里不得把它们写成项目阈值（`production/probe-plan-M0b-P6.md` §5.2）。
2. 上表前四条是**相对基线的劣化阈值**；性能预算的**绝对**档位（原型 ≤25 ms / Alpha ≤20 ms / Beta·RC ≤16.6 ms，逐字来自评审团 `references/baseline.md` §3.2 第 74 行）归 `03-release-readiness.md` §八，不要在本表里混算。

## 六、覆盖状态与缺口表

覆盖状态**逐字**取 `/regression-suite` 的四值：

| 状态 | 含义 |
|---|---|
| `COVERED` | 关键路径已被某个已存在的测试覆盖 |
| `PARTIAL` | 只覆盖了部分分支或部分输入 |
| `MISSING` | 无覆盖；其中对应公式或状态机的升级为 **HIGH PRIORITY** 缺口 |
| `EXEMPT` | Visual/Feel 或 UI，按设计不可自动化 |

bug 侧逐字为 **`HAS REGRESSION TEST` / `MISSING REGRESSION TEST`**，缺口建议路径 `tests/unit/[system]/[bug-slug]_regression_test.[ext]`。

| 项 | 规则 |
|---|---|
| 缺口表落点 | `tests/regression-suite.md`；`update` **追加、绝不删除既有条目**；`audit` 全量重写；`report` **不写任何文件** |
| 分母守卫 | 关键路径为 0 或测试文件为 0 时**不得输出百分比**，报 `Coverage: NOT ASSESSED — [no GDDs found \| no test files found]`，点名哪一侧为空及其产出技能 |
| 与假绿同源 | 本项目 M0 0.7 修掉的「零文件通过」假绿与本分母守卫同源：**分母为 0 一律 `NOT ASSESSED`** |
| `qa.level` 闸门 | **最先判、任何模式下都先判**：`minimal` 时**不生成**并在任何扫描之前 STOP（verdict 为 `NOT ASSESSED`）；`standard` 在 **Polish 阶段入口**生成；`full` 在 Production 阶段入口生成。本项目 `qa.level: standard` ⇒ 对应映射表里的 **M7（Polish）** 入口；在此之前要建套件，按追加式登记，不要等 |
| verdict | 首个匹配胜出：**`NOT ASSESSED`**（上述三处）· **`BLOCKED`**（`update` / `audit` 且用户拒绝写入）· **`COMPLETE`**（`update`/`audit` 已更新；`report` 已展示） |
| 陈旧判定 | 漂移超 2 个冲刺未更新即标为可能陈旧；本项目无冲刺 ⇒ 换算为阶段口径：同一模块跨 ≥2 个阶段未更新即标注可能陈旧 |
| 隔离 | 隔离不是删除——间歇失败的测试进 `## Quarantined Tests` 但保留，交给 `/test-flakiness` 修 |
| minimal 分支对照 | `workflow: minimal` 时不扫 GDD 关键路径、改从 `production/qa/smoke-*.md` 取；无冒烟报告时 `NOT ASSESSED — no smoke report to take critical paths from`。本项目 `modes.workflow: standard`，**不适用**，记此仅作对照 |

## 七、不稳定用例规程

**flaky 的定义**：在结果历史中同时出现 PASS 与 FAIL，且两次之间**无代码改动**。

| 失败率 | 分层 | 动作 |
|---|---|---|
| **> 25%** | **High flakiness** | **立即隔离** |
| **5–25%** | **Moderate** | 尽快调查并修复 |
| **1–5%** | **Low / suspected** | 监控，可能是真的偶发失败 |
| **不足 3 次运行** | — | 无论失败率多少，一切发现都是 **`suspected`**：**不隔离**、标注 `suspected`、询问是否有更多运行数据。分层与隔离**自 3 次运行起生效** |

本项目专属规程（**无 CI**）：

1. `/test-flakiness` 的 `ci-log` 模式**无输入**（本项目无 CI、无 CI 日志）⇒ 只能走 `scan` / `registry`，或按人工重复运行取证；**不得**声称有抖动率统计却给不出运行记录。
2. 重复运行的最小取证：同一命令、同一构建、同一 seed，**跑 ≥ 3 次**，逐次记录命令、退出码、日志路径与结果；不足 3 次只能记 `suspected`。
3. 引擎跳过机制按项目引擎**只点名 gdUnit4 那一个**；其中 gdUnit4 的 C# 跳过属性标 **NOT SOURCEABLE** ⇒ 记入隔离区并问用户，**不要发明属性或开关**。
4. 落点：追加 `tests/regression-suite.md` 的 `## Quarantined Tests`（**需人同意**后追加、绝不删既有隔离条目）；可选报告 `production/qa/flakiness-report-[date].md`（**需人同意**）。
5. 收尾 verdict 逐字：`COMPLETE` — flakiness report written；用户拒绝写入时 `BLOCKED` — user declined write。

## 八、判定纪律（本节是防假绿的唯一依据）

| 情形 | 判定 | 说明 |
|---|---|---|
| 分母为 0（关键路径 0 或测试文件 0） | `NOT ASSESSED` | 不得输出百分比；与 CCGS 的分母守卫同源 |
| 走查脚本 / 校验器 / 工具不在盘 | `NOT ASSESSED` | 点名缺哪个（例：`tools/monte_carlo.py`、`tools/validate_data.py`、`tests/`） |
| 基线五要素不齐 | `NOT ASSESSED` | 不出「劣化 X%」的数 |
| 缺证据 | 不得记 `PASS`、不得记豁免 | 按 `Major` 登记；覆盖 Blocker 级准则时按 `Blocker`（`00-alignment.md` §三） |
| 探针的 PASS/FAIL | **不是缺陷等级** | `probe/out/*.log` 的 PASS/FAIL 是探针判定；登记台账时标 `kind: finding`，**不计入缺陷配额**（`00-alignment.md` §五） |
| 换了机器 / 引擎 / 后端 | **重建基线**，不比旧基线 | 旧基线保留并标注失效原因 |
| 探针判据 | **跑之前写死，跑完不得修改** | 分档事先钉死，只许往里套 |

## 九、执行记录格式（每次回归的最小可复核集）

每次触发都按这张表登记一行，落 `production/qa/` 下的回归记录或 `tests/regression-suite.md` 的对应小节：

| 列 | 填什么 |
|---|---|
| 触发 | 对应 §一 的哪一行 |
| 站位 | 一级 / 二级 / 三级（§三） |
| 命令 | 逐字命令（含 `--log-file` 路径） |
| 构建 | 引擎版本 + 渲染后端 + 提交号 |
| 场景 | 格区 / 实心点占比 / 移动力 / seed |
| 运行次数与取值 | ≥3 次、丢弃首次预热后的中位数；单次运行的项注明 |
| 结论 | 覆盖状态四值之一，或本节的判定字面量 |
| 证据路径 | A 级证据的路径 ＋ 关键片段 |

模板见 `templates/regression-plan.md`。
