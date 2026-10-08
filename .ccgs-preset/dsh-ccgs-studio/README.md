# dsh-ccgs-studio

**CCGS 工作室模式** —— 一个 DSH agent preset：把 `D:\AI\test\ccgs-essence\` 里的 74 个
游戏工作室技能挂进一个会话，并配上一个「带第一次做游戏的人走流程」的人格。

- 默认：**Godot 4 / 2D / `minimal` 严格度档位**
- 路线：`/setup-engine` → `/brainstorm` → `/create-stories` → `/dev-story` ↔ `/story-done`
- 不知道下一步做什么时：`/help`

## 怎么用

1. 把**游戏项目目录**作为会话工作区打开（例如 `D:\games\my-first-game`），不要用 DSH 源码仓库。
2. 新建任务时在预设选择器里选 **CCGS 工作室模式**；或 `设置 → Agent presets` 里选它并设为默认。
3. 第一句话打 `/start`（或直接说「我想做一个 XX 游戏，从哪开始」）。
4. 之后每轮只推进一步：你拍板 + 试玩，文档与代码由 agent 写。

装完 bundle 即时生效，但**已存在的会话仍用它启动时的组合**——请开新会话。

## 这个 preset 装了什么

| 行 | 作用 |
|---|---|
| `persona` | 流程人格：一次一步、先问再定、跑一遍才算完、不许编造、工作目录必须是游戏项目 |
| `skill-filesystem` | 挂载 `D:\AI\test\ccgs-essence\03-技能`（74 个技能，`providerName: ccgs-studio`，**仅本模式可见**） |
| `tool-skill` | 模型按名加载技能（`skill` 工具） |
| `agent-instructions` | 让游戏项目自己的 `AGENTS.md` 生效 |
| pwsh / fs / fs-search / jobs | 命令与文件读写 |
| compaction 组 | 上下文压缩 + 工具结果修剪 |
| ask-user / todo / web / present | 提问、清单、查文档、交付物卡片 |
| `tool-subagent` | 通用委派（CCGS 完整版技能常写「派给某代理」） |

**没装**：12 个 Claude 钩子的自动校验（要 Host 级桥接）、49 个上游代理的人格（语料未提取）、
requirement-board 角色、按名委派的专家席位（可另加）。

## 已知限制

- 语料是**语义提取物**：`setup-engine` 等少数技能是「简介形态」，没有逐阶段细则；
  `/story-done` 点名的上游 `story-status` 脚本未随语料提取。persona 已要求 agent 遇到这类缺口
  **明说并给替代**，而不是假装跑过。
- `/help`、`/settings` 与宿主内建命令是否同名冲突**未证实**；不确定就用 `/start`。
- `03-技能` 的 7 个完整版技能里有 192 条相对链接是坏的（链接基准写成了 `03-技能/`）；
  agent 读那些文件时可能跟不到目标，按名字直接加载技能即可绕开。
- 技能目录是**绝对路径**：换机、或把 `ccgs-essence` 移走，本 preset 会激活失败（响亮失败，不会静默空表）。

## 回滚

```text
plugin_manager { action: remove_bundle, target: dsh-ccgs-studio }
```

或在 `设置 → Plugins` 里停用本 bundle。删除工作区的 `.ccgs-preset/` 目录前请先卸载。

## 固化（可选，之后再决定）

当前是「最快试跑」变体：直接指向 `D:\AI\test\ccgs-essence\03-技能`。要变成可移动、可分享的包：

1. 把 `03-技能/` 下的 74 个技能目录整份复制进本 bundle 的 `skills/`；
2. 把 `customSkillDirs` 改成从已安装包解析（照 `dsh-godot-game-suite` 的写法）：

```yaml
customSkillDirs:
  - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('dsh-ccgs-studio/package.json')), 'skills')
```

3. 重新 `install_bundle`。

同时建议把 `<包名>` 与 `presets/` 目录一起搬到 `~/.dsh/bundles/dsh-ccgs-studio/`，与现有 4 个 bundle 同处。
