---
name: godot-qa-support
description: "Godot 测试与发布就绪技能包：为项目的测试策略（金字塔 / 关键路径 / 三数估算 / 模块×层矩阵）、缺陷分级（S1–S4 ↔ Blocker/Critical/Major 单一归并规则 + 阶段配额）、发布就绪（DoD / 阶段硬标准 / ADR / 红线 / 评审闭环 / 性能预算 → READY·CONDITIONAL·NOT ASSESSED·NOT READY）、回归规划（变更触发矩阵 / 冒烟三级 / 基线五要素 / 阈值口径）四件事提供可执行规程；并复用工作室既有的 CCGS QA 技能，为它们补上被剥离的配置解析器、框架语料解析与阶段/输入适配。当用户要测试策略、测试计划、覆盖方案、缺陷定级与台账、缺陷趋势、放行判定、发布就绪检查、里程碑门禁、回归范围与基线、冒烟与性能回归、不稳定用例处置时使用。"
metadata:
  version: 0.1.0
  author: 银橙AI
  upstream: "CodeBuddy 专家包 game-automated-testing v1.0.0（银橙AI，Agent 型单专家）——四项职责的基线来源；QA 技能与产物路径来自 dsh-ccgs-studio（CCGS 工作室模式），见 NOTICE.md"
---

# Godot 测试与发布就绪技能包

> 本包只做四件事：**测试策略、缺陷分级、发布就绪、回归规划**。
> 结构一致：**先贴档位头 → 定位到四项职责之一 → 加载对应 reference → 按那里的规程执行 → 过第五节的清单**。不要跳过清单。

## 一、定位与边界

**做什么**：把项目计划里的 DoD、阶段硬标准与红线，变成可执行的测试范围、可核对的缺陷台账、可复核的就绪判定与可复现的回归范围。产物是四份：测试策略书、缺陷分级清单、发布就绪报告、回归计划。

**不做什么**：

| 边界 | 说明 |
|---|---|
| 不写产品代码 | 可写 `tests/`、`tools/`、`production/**`；产品代码归实施角色 |
| 不改项目规则 | 规则真相源是项目 `docs/`，**规则改动一律先问用户**；本包只核验 |
| 不做引擎裁定 | 引擎侧主张归引擎审查专家；本包只给「这条断言有没有证据」 |
| 不管发行上架 | 发行、上架、年龄分级、SDK 合规不在辖区，直接退回项目组 |
| 不抢终裁 | 放行终裁归评审团验收席位；本包出证据与建议 |

## 二、开跑前必做（每次，任何一份产物之前）

1. **贴档位头**：`node <bundle>/tools/ccgs-config.mjs --root <项目根>`，把输出块逐字贴在报告首部。脚本位置用 glob 找 `**/dsh-godot-qa-expert/tools/ccgs-config.mjs`。**没贴档位头的档位判定不算数。**
2. **解析框架语料**：`node <bundle>/tools/ccgs-corpus.mjs`，把它的输出块贴在档位头下一行。解析顺序 `CCGS_ESSENCE_DIR` → `D:\AI\test\ccgs-essence`；未解析出时块里会给一行 `verdict: NOT ASSESSED — framework corpus unresolved`，**照它记**并点名缺哪一份，不得靠记忆补正。
3. **对齐真相源**：项目规则看 `docs/`，进度看 `production/进度说明-细节.md`（用 § 锚点，不要用行号）。

三者的规格与失败模式见 `references/06-framework-corpus.md`。

## 三、四项职责路由

| 责任 | 什么时候接 | 加载 | 产物 | 直接复用的 CCGS 技能 |
|---|---|---|---|---|
| 1 测试策略 | 阶段开始前；要覆盖方案；要估算测试工作量 | `references/01-test-strategy.md` | 测试策略书（`production/qa/`） | `/qa-plan`（项目有故事之后）、`/test-setup`、`/test-evidence-review`、`/test-helpers` |
| 2 缺陷分级 | 登记缺陷；要台账或趋势；要判缺陷是否达标 | `references/02-defect-triage.md` | 缺陷分级清单（`production/qa/bugs/`）、`production/qa/bug-triage-[date].md` | `/bug-report`、`/bug-triage` |
| 3 发布就绪 | 阶段升级；里程碑门禁；用户问「能不能放行」 | `references/03-release-readiness.md` | 发布就绪报告（`production/gate-checks/`、`production/releases/`） | `/gate-check`、`/milestone-review`、`/release-checklist`、`/launch-checklist`、`/team-qa` |
| 4 回归规划 | 有变更要定回归范围；里程碑复核；基线维护 | `references/04-regression-plan.md` | 回归计划与覆盖状态（`tests/regression-suite.md`） | `/regression-suite`、`/test-flakiness`、`/smoke-check`、`/soak-test`、`/perf-profile` |

四者是同一条链：策略定范围 → 回归按变更选范围 → 缺陷定级给结论 → 就绪汇总判门禁。**跨责任的结论要互相引用，不要各说一套。**

## 四、五条铁律

1. **不新造判定字面量**：沿用既有四套（阶段门 / 发布就绪 / 冒烟 / 团队级 QA）与评审团的评审结论，需要换口径时给**换算建议**并标注是建议不是裁决。
2. **`NOT ASSESSED` 高于 `PASS`**：缺证据不得记 PASS 也不得记豁免（按 `Major` 登记，覆盖 Blocker 级准则时按 `Blocker`）；**分母为 0 一律 `NOT ASSESSED`**。
3. **探针判定不是缺陷等级**：`probe/out/*.log` 的 PASS/FAIL 标 `kind: finding`，不计入缺陷配额；探针判据必须在跑之前写死，跑完不得修改。
4. **一切阈值必须能追溯到来源**（本机实测 / 项目文档 / 官方文档标访问日期与小节 / 明确标注为估算）。没写下来的就报「未规定」，不要替项目补一个看起来合理的值。
5. **不伪造输入**：CCGS 技能因缺少故事或冲刺而报 `NOT ASSESSED` 时照实记录；`/qa-plan` 的 N=0 守卫是正常行为，不得建空目录绕过。

完整口径（阶段映射、输入适配、四套字面量、缺陷归并规则与阶段配额、偏差规则改写）见 `references/00-alignment.md`。

## 五、自检清单（出任何产物前逐条过）

- [ ] 档位头已贴，且六旋钮的来源标记与 `modes.rigor` 一致？
- [ ] 结论用到的每个数字都有来源？没有来源的已明确写成「未规定」或「估算」？
- [ ] `NOT ASSESSED` 没有被写成 0、PASS 或豁免？
- [ ] 探针判定与缺陷等级分开登记（`kind: finding`）？
- [ ] 阶段结论先过了阶段坐标映射，而不是直接套 CCGS 阶段名？
- [ ] 写盘范围只在 `tests/`、`tools/`、`production/**`？产品代码与项目规则文档未动？
- [ ] 报告结尾给了「本轮产出 / 未完成 / 建议下一步」，未验证项单独列出并说明卡在哪一步？

## 六、本包文件清单

| 文件 | 内容 |
|---|---|
| `references/00-alignment.md` | 阶段坐标映射、输入适配、四套判定字面量、缺陷刻度归并规则与配额 |
| `references/01-test-strategy.md` | 责任 1：策略书怎么从硬标准反推（含 CCGS 未交付的 QA 计划骨架） |
| `references/02-defect-triage.md` | 责任 2：登记、定级、趋势、偏差规则与配额核对 |
| `references/03-release-readiness.md` | 责任 3：逐层就绪检查与判定 |
| `references/04-regression-plan.md` | 责任 4：触发矩阵、冒烟三级、基线五要素、阈值口径 |
| `references/05-evidence-channel.md` | 探针证据通道、本机陷阱、退出码约定（本项目未规定） |
| `references/06-framework-corpus.md` | 框架语料解析、配置解析器与档位头、项目配置现状与动作 |
| `templates/` | 四份产物的可填写空表 |
| `tools/ccgs-config.mjs` | R1 配置解析器（替代被剥离的 `resolve_config`，含 `--selftest`） |
| `tools/ccgs-corpus.mjs` | R2 框架语料解析器（覆盖 → 回落 → 响亮降级，含 `--strict` 与 `--selftest`） |
