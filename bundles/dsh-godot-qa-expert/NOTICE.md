# NOTICE

## 本包自身（原创）

以下内容为本包原创，按原样提供，不附带任何担保：

- `package.json`、`README.md`、`INSTALL.md`、`NOTICE.md`
- `presets/godot-qa-expert.patch.yml`（agent preset 声明与专家人格）
- `skills/godot-qa-support/`（SKILL.md、7 份 references、4 份 templates）
- `tools/ccgs-config.mjs`（配置解析器）、`tools/gqe-check.mjs`（契约检查）

## 运行时引用、不随包分发

本包**不包含**任何第三方技能、文档或模板正文；它只在运行时按路径或包名引用下列内容。各自的归属与许可由各自承载：

| 被引用者 | 引用什么 | 归属与许可 |
|---|---|---|
| `dsh-ccgs-studio` | 74 篇 CCGS 工作室技能（本包挂载其 `skills/`，其中约 20 篇是 QA 与发布）；产物路径、`S1–S4` 刻度、判定字面量 | 见该包 `NOTICE.md` 与 `LICENSE`：上游 **[Donchitos/Claude-Code-Game-Studios](https://github.com/Donchitos/Claude-Code-Game-Studios)**，MIT，`Copyright (c) 2026 Donchitos` |
| `dsh-godot-review-board` | 缺陷配额与分阶段帧预算的**引用来源**（`skills/godot-review-board/references/baseline.md` §3.2）、审查结论口径 | 见该包 `NOTICE.md` |
| 框架语料 `D:\AI\test\ccgs-essence` | 配置解析规格（`01-设计理念/05-配置解析.md`）、导演门控（`06-导演门控.md`）、自动化模式、rigor 档位 | 同上（CCGS 衍生提取物）。**不在本包内**，按路径解析，见 `skills/godot-qa-support/references/06-framework-corpus.md` |
| CodeBuddy 专家包 `game-automated-testing` v1.0.0（银橙AI） | **方法与数值口径**：四项职责划分、金字塔比例（五到六成 / 二到三成 / 一到二成）、反金字塔、关键路径三条筛选、三数估算、证据分级四级制 | 位于 `%USERPROFILE%\.workbuddy\plugins\marketplaces\experts\plugins\game-automated-testing`。该目录**未声明可见许可**，因此本包只引用其口径与数值，**不复制其文件正文**；其 `scripts/check_test_matrix.py` 未采用（它检测 `addons/gut` 与 `.github/workflows`，两者对本项目均不适用） |

`LICENSE` 文件未随本包提供：本包是内部派生作品，不单独授权；再分发时请连同上表各来源的许可与说明一并处理。

## 已知未提取与已知缺口（照实登记）

- `dsh-ccgs-studio` 的技能是**功能介绍形态**：同级 `CONTRACT.md` 与 `references/` 按该包 `00-提取规范.md` §3.0 一律不交付。因此 `/gate-check` 的逐门产物清单不在技能包里——替代物是语料 `01-设计理念/06-导演门控.md`（覆盖 28/28 门控）。其余技能的逐阶段流程正文在本机任何位置都找不回（`ccgs-essence/03-技能` 与 bundle 内同名同源、同样只有 1 个文件/篇）。
- 语料自陈「`project.local.yaml` 白名单 **12 个键**」而逐项列举为 **11 项**（`features.*` 为通配）。本包按逐项列举实现，该计数不一致固定在 `tools/ccgs-config.mjs --selftest` 的用例 17 里，不靠猜补齐。
- 技能正文依赖的 `../01-设计理念/*.md` 相对链接在 `dsh-ccgs-studio` 包内**悬空**（包内没有该目录），本包按绝对路径解析语料，不复制这些文档。
- `project.yaml` 的 `performance.*` 键名与 `/perf-profile` 读取的键名**不一致**（`frame_rate` ↔ `target_framerate`、`memory_peak_mb` ↔ `memory_ceiling_mb`），权威拼写已核（`04-参考/效果映射索引.md` 第 95/96/120 行），数值亦已裁定（PC 峰值登记 **3 GB**；到 Beta·RC 按基线更严的 2.5 GB 判）；**键名尚未改** ⇒ 在那之前 `/perf-profile` 仍只能读 `NOT ASSESSED`。改法与裁定记录见 `references/06-framework-corpus.md` §四.1。
- 本项目 DoD 点名 的 `tools/validate_data.py` 在项目磁盘上**不存在**；本包一律记 `NOT ASSESSED`，不得因为「计划里写了」记 PASS。
