# 银橙AI · Godot 引擎审查专家

`dsh-godot-engine-reviewer` — 一个**对抗式引擎事实核验者**：把「引擎侧发现 / 结论 / 实现 / 方案」逐条裁成
**成立 / 不成立 / 证据不足**，附证据链、严重度分级与可落地优化。只审不实现。

- preset id：`godot-engine-reviewer`（order 65）
- 角色 id：`godot-engine-reviewer`，职能：引擎侧结论裁定 / 反模式识别 / 版本与平台兼容核对 / 证据链核验
- 技能：`godot-engine-review`（随包的 `skills/` 目录提供）

## 为什么单独做一个角色

同族已有一个实施型开发专家（`godot-game-suite`）、一个脚本工程师（`godot-game-script-engineer`）、
一个着色器开发者（`godot-shader-developer`）和一个六席位评审团（`godot-review-board`）。
它们的共同缺口在于：**没有人对"引擎侧结论本身"负责**——采纳一个错误的引擎假设，往后所有实现都是错的，
而且错得看不出来。本角色补的就是这一环：

| 对比 | 别的角色 | 本角色 |
|---|---|---|
| 产出 | 实现、方案、意见列表 | **逐条三态判定 + 证据链** |
| 对"我试过"的态度 | 采信 | 要五元组；给不出就自己在探针沙箱造 |
| 版本 | 大致声明 | 精确小版本 + 平台 + 渲染后端，越界即降级 |
| 性能预算 | 评审团技术席位裁定 | 只提供证据与交界风险，不替代其裁定 |

## 组合（preset 里的插件行）

persona / `tool-fs`（被审工程只读、探针沙箱可写）/ `tool-fs-search` / `tool-jobs` / `tool-skill` +
`skill-filesystem`（从已安装包解析本包 `skills/`）/ `tool-web`（查官方文档）/ `tool-pwsh`／`tool-bash`
（按平台二选一）/ `tool-ask-user` / `tool-todo` / `present` / compaction 组 / `requirement-board-role` 隔离组。

三处刻意取舍（理由写在 `presets/godot-engine-reviewer.patch.yml` 的注释里）：
**不挂 `agent-instructions`**（项目 AGENTS.md 通常教人改代码，与只审不实现冲突）、
**不挂 `tool-subagent`**（保持单专家身份，长探针走 `tool-jobs`）、
**保留文件写入能力**（探针要落盘，见下）。

## 取证链路（已在本机实测）

探针脚手架在 `skills/godot-engine-review/probes/template/`，本机实测结论（2026-10-09，Windows + Godot 4.7.2-stable）：

- `cmd /c run-probe.cmd` → 裸调用引擎 → `PROBE/` 行 + 引擎自写 `probe-output.txt`，**退出码 0**。
- **不要**用 PowerShell 重定向捕获引擎输出：本机沙箱下 `2>&1` 无输出、`*>` 得 0 字节。
- **不要**用默认 `Get-Content` 读回证据：会按 GBK 解码 UTF-8 变乱码；用 `-Encoding utf8`。
- 运行器把 `APPDATA`／`XDG_DATA_HOME` 重定向进探针目录：既不污染开发者真实的 Godot 数据目录，也消掉 `user://logs` 报错噪音。`run-probe.cmd` 与 `run-probe.ps1` 刻意保持**纯 ASCII**（cmd 按 OEM 代码页、`powershell.exe` 按 ANSI 解析，中文注释会让它们崩）。
- 已知不可回避的 stderr 噪音：`Failed to read the root certificate store`——判定时不得当成发现。

详细陷阱表见 `probes/template/README.md`。

## 判定的诚实性

- 三态之外没有第四态：「证据不足」不等于「基本成立」。
- 来源分四级：A 本机实跑 > B 官方文档 > C 上游知识库条目 > D 推测；D 级不得单独支撑判定。
- `references/engine-lifecycle.md`、`references/engine-runtime.md` 与 `version-matrix.md` 是**要验的清单**，不是已验结论；每行都带状态标记。
- 版本覆盖：上游知识库到 **4.6**（本机是 **4.7.2**）——**4.7 区在本包里是空的，必须实测**。

## 已知边界

| 边界 | 说明 |
|---|---|
| 不实施 | 不改被审工程、不提 MR；只给「错 → 对」最小对照与验证方法 |
| 不越界 | 体验 / 美术 / 数值 / 商务转对应角色；性能预算裁定归评审团技术席位 |
| 不猜版本 | 版本不明先问；4 与 3 的写法不混用 |
| 探针沙箱 | 探针只落 `GODOT_PROBE_DIR` 或平台临时区；工作区就是被审工程时，探针不得落在工程内 |
| 上游局限 | 上游库有四处已知缺陷（GDExtension 示例钉 4.2、联网 4.6 未确认、C# 章无不确定性标注、音频结论属作者判断），见 `NOTICE.md` |

## 许可与归属

本包文本由银橙AI 撰写；版本条目与反模式线索提取自 `fetasty/godot-skills`（MIT，tree `d52b934`）。
完整归属与上游缺陷清单见 [NOTICE.md](./NOTICE.md)。安装与验证见 [INSTALL.md](./INSTALL.md)。