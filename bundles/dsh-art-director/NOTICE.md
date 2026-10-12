# 溯源与使用声明

## 上游

| 项 | 值 |
|---|---|
| 上游形态 | 上游「专家插件」的**角色卡**（persona 正文），由用户以附件提供 |
| 附件 | `art-director.md` · 4,721 B · 55 行 · sha256 `8c109e4b8c88daf66c3debb7b5b00253da62474a9088272f7d995952056a8f38` |
| 本机副本 | `%USERPROFILE%\.dsh\attachments\v1\files\8c\8c109e4b…\art-director.md` |
| 交付包 | `D:\Godot\projects\dndGame\production\presets\art-director-交付包.md`（规划席位产出 · 2026-10-11 · 20,933 B） |
| 转换日期 | 2026-10-11 |

附件里**没有** `README`、`license`、`skills` 包、脚本或模板：只有一份带 frontmatter 的角色卡（55 行）。

**`\---` 的实读更正**：交付包 §0 / §6 写「第 1 / 11 行显示 `\---`，需确认真实文件是 `---`」，
实读只读副本的结果是：**第 1 行与第 19 行**是 `\---`（转义形态，第 1 行尾随两个空格），**第 11 行是空行**。
所以「第 11 行」是交付包的一处笔误。本包**不读 frontmatter**（本机 preset 只用 `persona.prefix`），该转义形态不影响落地；
但把更正记在这里，免得下次有人照「第 11 行」去找。

## 第三方来源与授权（保守随附）

同族自建包（`dsh-godot-tech-director`、`dsh-godot-game-script-engineer`、`dsh-godot-shader-developer`）都来自同一批
CodeBuddy「专家插件」，它们的上游 README 明确致谢开源项目
[agency-agents](https://github.com/msitarzewski/agency-agents)（MIT）。
本次 `art-director.md` 与它们**同批提交**（同一 attachments 目录），交付包 §0 也把它列为「第三份卡，套路同前」。

本卡自身**未随附任何可见许可声明**，因此本包按族内许可**保守随附**其 MIT 原文：

- `license/agency-agents.LICENSE`——逐字复制自同族 `dsh-godot-tech-director` 的随包副本，未修改
  （sha256 `21a6f7a7f49b17ea88a27ba2310892fbabface43919cf14706b27ce4db47f537` · 1,074 B）。
- MIT 要求版权与许可声明随所有副本或实质部分同行，故 `package.json` 的 `files` 已列出 `license`，本文件与 README 均指向它。
- **对外分发本包时须连同 `license/` 一起带**。若上游另有更严条件，以上游为准。

## 本包做了什么

把交付包 §3 的 persona 正文与 §1 的角色声明搬进 DeepSeek Harness 的 agent preset 形态，供本机 `web` profile 私用：

- **逐字保留**：交付包 §3 的 persona 正文（60 行 / 4,637 字）→ `persona.prefix`；§1 的 `roleId` / `roleName` / **7 条** `duties` → 角色声明组。
  这两处由 `tools/gen-preset.mjs` 直接从交付包生成，`tools/ard-check.mjs` 反向断言「磁盘文件 == 生成器输出」。
- **本包新增**：preset 骨架（行集、`order` 69、`description`、`suffix` 的本机 Godot 事实）、生成器、契约检查、三份文档。
- **未收录**：上游 frontmatter（`displayName` / `profession` / `maxTurns: 50`——本机 preset 不读）。
- **未改动**：游戏仓库（`D:\Godot\projects\dndGame`）任何文件；本包只读它 `production/presets/` 下的交付包。
  （施工完成后按任务要求向该交付包 **§6 追加一节施工回执**，是唯一一次写入。）

## 使用范围

本包是本机个人使用的转换副本，**不随任何仓库分发**；上游角色卡的著作权归属见上「第三方来源与授权」。
本包自身新增的文件（`package.json`、`presets/`、`tools/`、`README.md`、`INSTALL.md`、本文件）随本机 profile 使用，
按 `license` 字段标注（`SEE LICENSE IN NOTICE.md`）——即本文件。
