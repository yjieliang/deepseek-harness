# 溯源与使用声明

## 上游

| 项 | 值 |
|---|---|
| 上游形态 | 上游「专家插件」的**角色卡**（persona 正文），由用户以附件提供 |
| 附件 | `ux-designer.md` · 8,451 B · sha256 `64539681…`（交付包 §0 记录的前缀） |
| 交付包 | `D:\Godot\projects\dndGame\production\presets\ux-designer-交付包.md`（规划席位产出 · 2026-10-11） |
| 转换日期 | 2026-10-11 |

附件里**没有** `README`、`license`、`skills` 包、脚本或模板：只有一份带 frontmatter 的角色卡
（`displayName.{en,zh}` / `profession` / `maxTurns: 50`）。交付包 §0 记第 1 / 11 行显示 `\---`（转义形态），
交付包 §6 把它列为**待用户确认**项——本包**不读 frontmatter**，因此该转义形态不影响落地。

本机副本的**完整路径与完整 sha256 未由交付包给出**（只给了 8,451 B 与 `64539681…` 前缀），
故本文件不编造它们；需要逐字核对时以用户的附件原件为准。

## 第三方来源与授权（保守随附）

同期的同族自建包（`dsh-godot-game-script-engineer`、`dsh-godot-shader-developer`、`dsh-godot-tech-director`）
都来自同一批 CodeBuddy「专家插件」，它们的上游 README 明确致谢开源项目
[agency-agents](https://github.com/msitarzewski/agency-agents)（MIT）。交付包 §0 判读本卡为**第五份同族卡**
（「套路同前」）。

本卡自身**未随附任何可见许可声明**，因此本包按族内许可**保守随附**其 MIT 原文：

- `license/agency-agents.LICENSE`——逐字复制自同族 `dsh-godot-tech-director` 随包副本，未修改。
- MIT 要求版权与许可声明随所有副本或实质部分同行，故 `package.json` 的 `files` 已列出 `license`，本文件与 README 均指向它。
- **对外分发本包时须连同 `license/` 一起带**。若上游另有更严条件，以上游为准。

## 本包做了什么

把交付包 §3 的 persona 正文与 §1 的角色声明搬进 DeepSeek Harness 的 agent preset 形态，供本机 `web` profile 私用：

- **逐字保留**：交付包 §3 的 persona 正文（5,934 字符 / 109 行）→ `persona.prefix`；
  §1 的 `roleId` / `roleName` / 8 条 `duties` → 角色声明组。
  这两处由 `tools/gen-preset.mjs` 直接从交付包生成，`tools/uxcheck.mjs` 反向断言「磁盘文件 == 生成器输出」。
- **本包新增**：preset 骨架（行集、`order: 70`、`description`、`suffix` 的本机 Godot 事实）、生成器、契约检查、三份文档。
- **未收录**：上游 frontmatter（`displayName` / `profession` / `maxTurns`——本机 preset 不读）；
  上游卡里没有 skills 包或脚本（交付包 §6 已记录）。
- **未自行改判**：交付包 §5 的「对比度 4.5:1 vs 极暗夜戏」冲突口径已逐字写在 §3 正文的 F 组里，本包照抄。

## 使用范围

本包是本机个人使用的转换副本，**不随任何仓库分发**；上游角色卡的著作权归属见上「第三方来源与授权」。
本包自身新增的文件（`package.json`、`presets/`、`tools/`、`README.md`、`INSTALL.md`、本文件）随本机 profile 使用，
按 `license` 字段标注（`SEE LICENSE IN NOTICE.md`）——即本文件。
