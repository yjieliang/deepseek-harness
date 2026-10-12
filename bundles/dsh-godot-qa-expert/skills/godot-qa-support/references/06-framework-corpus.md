# 框架语料与配置解析

> **何时读**：每次开跑前（贴档位头），以及任何一次要判「某个 CCGS 技能该按哪个档位跑」「某个键到底有没有写」的时候。
> **口径来源**：CCGS 框架语料 `01-设计理念/05-配置解析.md`（解析链、12 个本地白名单键、rigor 展开表、12 条失败模式）、`04-参考/效果映射索引.md`（`project.yaml` 的 schema 权威）。
> **不覆盖**：项目自己的规则文档（真相源是项目 `docs/`），也不覆盖引擎与平台事实。

## 一、语料解析顺序（R2）

```
$CCGS_ESSENCE_DIR  →  D:\AI\test\ccgs-essence  →  NOT ASSESSED — framework corpus unresolved
```

- 语料是**本机事实**，与 `engine.path` 同类；换机器要重新确认路径。
- 解析失败时**响亮降级**：一切依赖逐门清单或配置语义的判定记 `NOT ASSESSED` 并点名缺的是哪一份文档，**不得靠记忆补正**。
- 用 `node <bundle>/tools/ccgs-corpus.mjs` 解析，并把它输出的块贴在档位头下一行。它同时核对 4 个子目录与 7 份被引文档是否都在，缺哪份点哪份；`--strict` 给 CI 用（未解析出时以 1 退出）。**`CCGS_ESSENCE_DIR` 设了但无效时不回落到默认路径**——设错的覆盖是配置错误，静默回落会把它藏起来。
- 不要挂载 `ccgs-essence\03-技能` 作为技能目录：那 20 篇与本预设挂的 `dsh-ccgs-studio/skills` 同名同源，两个 provider 出现同名技能时的去重与遮蔽语义未验证，不去碰这个不确定性。

## 二、语料索引：哪份文档管什么

| 语料 | 管什么 |
|---|---|
| `01-设计理念/05-配置解析.md` | 解析链、白名单、rigor 展开、失败模式（本文件第三节的规格来源） |
| `01-设计理念/06-导演门控.md` | 28/28 个门控的准入标准；补 `/gate-check` 未交付的逐门清单 |
| `01-设计理念/04-rigor档位.md` | 三档 rigor 的正文与实测数据 |
| `01-设计理念/03-自动化模式.md` | 自动化模式；注意阶段门**豁免** `modes.automation`（永不自动运行） |
| `02-流程/项目目录结构.md` | 目录契约 |
| `04-参考/效果映射索引.md` | `project.yaml` 各键的权威拼写与小节位置 |
| `05-上游对照表.md` / `00-提取规范.md` | 未提取项登记、同级文件不交付的裁定依据 |

## 三、解析器（R1）与档位头

`dsh-ccgs-studio` 的每篇技能原本在正文开头动态求值配置，抽取时那一行被整行剥离，改为「先解析这些键」的说明。**本预设的 `tools/ccgs-config.mjs` 就是那个被剥离的解析器**：用确定性脚本代替模型推理。

```powershell
node <bundle>/tools/ccgs-config.mjs --root D:\Godot\projects\dndGame
node <bundle>/tools/ccgs-config.mjs --keys qa.level,modes.workflow --root D:\Godot\projects\dndGame
node <bundle>/tools/ccgs-config.mjs --review full          # 内联覆盖 modes.review_mode
node <bundle>/tools/ccgs-config.mjs --selftest             # 自测夹具
```

输出块每行形如 `key: value (source)`，`source` 取值来自词汇表 `{project.local.yaml, project.yaml, <legacy 路径>, rigor:<level>, default, unset}`。**把整块贴在报告首部当档位头**，它让「为什么这次按 standard 跑」可复核。

五步解析链（顺序即全部向后兼容保证）：

| 步 | 来源 | 适用范围 |
|---|---|---|
| 1 | `project.local.yaml` | 仅 12 个白名单键：`modes.review_mode`、`modes.automation`、`modes.automation_always_ask`、`team.size`、五个 `testing.strict.*`、`performance.enforce`、`features.*` |
| 2 | `project.yaml` | 所有键 |
| 3 | legacy 纯文本镜像 | `modes.review_mode` → `production/review-mode.txt`；`project.stage` → `production/stage.txt` |
| 4 | `modes.rigor` 展开 | 六个前置旋钮：`modes.workflow`、`docs.density`、`qa.level`、`modes.story_granularity`、`modes.review_mode`、`team.size` |
| 5 | 文档化默认值 | `modes.automation: collaborative`、`modes.rigor: minimal`、`modes.automation_always_ask: [scope_changes, file_deletions, schema_changes]` |

`rigor` 展开表（**六个旋钮刻意没有终点默认值**，否则第 5 步会早于第 4 步给出答案、让 rigor 变成空操作）：

| `modes.rigor` | `modes.workflow` | `docs.density` | `qa.level` | `modes.story_granularity` | `modes.review_mode` | `team.size` |
|---|---|---|---|---|---|---|
| `minimal`（默认） | minimal | terse | minimal | coarse | solo | individual |
| **`standard`（本项目）** | **standard** | **balanced** | **standard** | **balanced** | **lean** | **individual** |
| `full` | full | thorough | full | fine | full | studio |

## 四、本项目的配置现状与动作

本项目 `project.yaml` 已写 `modes.rigor: standard`，因此六个前置旋钮**全部已解析**（来源标记 `rigor:standard`）——**不要去补写它们**：写了只会把「跟随 rigor」钉成定值，其中四个还是锁定键（只能写在 `project.yaml`）。

| 键 | 现状 | 解析结果 | 动作 |
|---|---|---|---|
| `modes.rigor` | 写了 `standard` | standard | 不动 |
| 六个前置旋钮 | 均未写 | standard 行 | 无需写 |
| `project.stage` | 无，且无 `production/stage.txt` | 无来源可下探 → 须问人 | 由 `/gate-check` 在 `PASS` + 用户确认后双写 |
| `platform.cert_tier` | 无 | `unset`（**未设置 ≠ `none`**） | 要写 `none`（PC/Windows 单机、无商店） |
| `platform.online` / `platform.multiplayer` | 无 | 缺失须问人 | 要写（单机项目应显式写 `false`） |
| `testing.framework` | 无 | — | 要写 `gdUnit4` |
| `testing.strict.*` | 无 | `unset`，各技能自套默认（`/smoke-check` 把未设置当**阻断**） | 可暂不写 |
| `performance.enforce` | 无 | `warn` | 暂不写；首个基线建立后再议 `block` |
| `qa.coverage_minimum` | 无 | `unset` | 建议写（可由 M1 硬标准折算） |
| `commands.test` | 已写 gdUnit4 runner | 命令会失败（`addons/`、`tests/` 均不存在） | 先补 `addons/gdUnit4`，或在补上前按「没有测试跑过」处理 |
| 性能预算键名 | `frame_rate`、`frame_budget_ms`、`draw_call_limit`、`memory_steady_mb`、`memory_peak_mb`、`scene_load_s`、`pathfinding_p95_ms` | `/perf-profile` 读的是 `performance.target_framerate`、`frame_budget_ms`、`draw_call_limit`、`memory_ceiling_mb` | **两个键名对不上**（`frame_rate` ↔ `target_framerate`、`memory_peak_mb` ↔ `memory_ceiling_mb`）。**已核（2026-10-11）**：权威确认拼写是 `performance.target_framerate` 与 `performance.memory_ceiling_mb`，所以这两个键名**确实**对不上；**数值亦已裁定（PC 峰值登记 3 GB）**，精确改法见 §四.1 |

写入纪律：`project.yaml` 是项目主存储，改动**须用户批准**；本专家只出清单与依据，不擅自写，建议走项目自己的 `/settings`。

### 四.1 性能预算键名：已核实（2026-10-11）

三方对照（权威 = `04-参考/效果映射索引.md` 第 95、96、120 行）：

| 量 | `/perf-profile` 读的键（技能 SKILL.md 第 26 行） | 本项目写了 | 权威拼写 | 对上没 |
|---|---|---|---|---|
| 目标帧率 | `performance.target_framerate` | `frame_rate: 60`（第 55 行） | `performance.target_framerate` | **否** |
| 单帧预算 | `performance.frame_budget_ms` | `frame_budget_ms: 16.6`（第 56 行） | `performance.frame_budget_ms` | 是 |
| draw call 上限 | `performance.draw_call_limit` | `draw_call_limit: 512`（第 60 行） | `performance.draw_call_limit` | 是 |
| 内存上限 | `performance.memory_ceiling_mb` | `memory_peak_mb: 1536`（第 58 行） | `performance.memory_ceiling_mb` | **否** |

后果要说准：四项里两项读成 `NOT ASSESSED`——**这不是失败**。按 `/perf-profile` 自己的规则 `NOT ASSESSED` 是**成功**（它拦的是「零数据却报 headroom」），所以这条缺口不会自己变红灯，只能靠人核。

**数值已裁定（2026-10-11，用户）：PC 峰值内存上限按 3 GB（3072 MB）。**

这个数与基线 PC 列的 **Alpha** 档一致；基线到 **Beta·RC 收紧到 2.5 GB**（`baseline.md` §3.2 **第 78 行**，该行是「移动端 / PC」双列）。所以 3 GB **只适用于 Alpha 及之前**：到 Beta·RC 时项目的 3 GB 比基线的 2.5 GB **宽**，按本包纪律「口径冲突按更严者判」**以基线的 2.5 GB 为准**，两个数都要写出来。

**已应用（2026-10-11，用户批准后直接编辑）**——项目侧记录显示 `/settings` 与本机宿主命令注册表撞名（`评审裁决单-Concept-S1等距网格与寻路-2026-10-08.md` 第 122 行已记此事），所以按项目既有做法**人裁决后直接编辑**：

| 行 | 改前 | 改后（已应用） |
|---|---|---|
| 55 | `frame_rate: 60` | `target_framerate: 60` |
| 58 | `memory_peak_mb: 1536` | `memory_ceiling_mb: 3072` |

第 58 行的注释一并改成「PC 峰值上限：Alpha ≤3 GB（基线 PC 列）；Beta·RC 起按基线收紧到 2.5 GB 判」，否则一个过期档位值会被固化成长期上限。`memory_steady_mb: 1024` 技能不读，保留无害，但要注明它是**稳态**、与峰值不是一个量。

**更正一条旧记录**：本项目此前写 1536 MB、注释写成「PC · RC 档」，而 1.5 GB 是基线**移动端** Beta 列的值、基线 PC 列是 2.5 GB。本包早期文档曾把 1536 说成「项目有意取更严的值」——那是**推断，不是决定**，现已撤回；裁定值为 3 GB。

判定纪律：口径冲突时按**更严**的那个值判，并把两个数都写在产物里。

## 五、解析器的失败模式（照语料 §六 实现）

解析入口**永远以 0 退出，并永远输出完整块**；下列每种情况降级到默认值并在 `notes:` 上点名：

`project.yaml` 不存在（`notes: project.yaml absent`）｜`project.yaml` **为空**（`notes: project.yaml is EMPTY`，刻意与「不存在」区分）｜YAML 格式错误（无法解析的键解析为空，继续下探）｜Tab 缩进的行（拒绝，**点名行号**）｜CRLF 行尾（正确解析）｜UTF-8 BOM（正确解析，不污染第一个键）｜3 空格缩进（容忍）｜键存在但值为空（视为**未设置**，继续下探，**绝不**落到 `""`）｜枚举非法值（**越过继续**，被拒的值写在 `notes:`）｜白名单之外的键被手写进 `project.local.yaml`（**只警告、永不调和**：不编辑文件、不改变解析结果）。

另有两条语义约束：**读作用域 == 写白名单**；`testing.strict.*` 没有中央默认值——**脚本解析来源，技能拥有策略**。
