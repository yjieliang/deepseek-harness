# INSTALL · dsh-ux-designer

装完本包，你会得到预设 **「沈简 · 交互设计师」**（`preset-ux-designer`，`order` 70），
职责面 8 项：交互流程与信息架构 / 界面信息层级与可读性 / 键鼠输入与操作可达性 / 状态反馈与提示设计 /
界面文案与术语一致 / 新手前 5 分钟自解释 / 交互评审与可用性核对 / 无障碍基础要求。

## 1. 前置

| 项 | 要求 | 为什么 |
|---|---|---|
| profile | `web` 或 `desktop`（预设只在含 `agent-preset-registry` 的组合里可用；headless 没有预设名册） | 预设是 web-app 层插入的能力 |
| 交付包 | `D:\Godot\projects\dndGame\production\presets\ux-designer-交付包.md` | persona 与角色声明的唯一真相源；改内容改它再重新生成 |
| Node | `node` 可执行（本机已有） | `tools/gen-preset.mjs` 与 `tools/uxcheck.mjs` |
| 项目侧 | `D:\Godot\projects\dndGame`（本预设面向它） | 它只读，不写游戏仓库代码 |

## 2. 安装

```
plugin_manager action=install_bundle target=C:\code\deepseek-harness\bundles\dsh-ux-designer
```

- 用**绝对目录**；不要放在 `%TEMP%`（profile 会以 `link:` 引用该目录本身）。
- 安装会执行插件代码并改动 `~/.dsh/profiles/web/`，需要 Full access 或用户批准。
- 安装后 `~/.dsh/profiles/web/package.json` 会多出 `"dsh-ux-designer": "link:C:/code/deepseek-harness/bundles/dsh-ux-designer"`，
  并加进 `dsh.profile.bundles`。
- ⚠️ **`order` 是 70 不是交付包建议的 69**：69 已被 `art-director` 占用，68 已被 `producer`、67 已被
  `godot-tech-director`（同日施工）。同族名册顺序因此是 …65 引擎审查 · 66 QA · 67 技术总监 · 68 制作人 · 69 美术总监 · **70 交互设计师**。

## 3. 装完立刻验证（不需要重启 GUI）

```powershell
cd C:\code\deepseek-harness\bundles\dsh-ux-designer
node tools/uxcheck.mjs                         # 契约 + 与交付包逐字一致 + 生成器无漂移
node tools/gen-preset.mjs | Out-File -Encoding utf8 $env:TEMP\uxd.gen.yml
fc.exe /b presets\ux-designer.patch.yml $env:TEMP\uxd.gen.yml   # 期望：FC: no differences encountered
```

**安装前** `uxcheck` 会在「web profile 已接线」两项上 **FAIL**——那是**预期**的：静态契约先于安装也要能跑，
但接线是安装的结果，只有 `install_bundle` 之后才会绿。**本包已装入 `web` profile**，因此装好的树上重跑应为
`通过 116 项 / FAIL 0 项（exit 0）`；若这两项又红了，说明 profile 里的 `link:` 依赖被移除了，而不是包坏了。

再看预设行是否活着：

```
plugin_manager action=list_plugins            # 找 preset-ux-designer：enabled 且无 diagnostic
plugin_manager action=list_bundles            # 确认 dsh-ux-designer 已在 profile 的 bundle 列表里
```

**激活失败会留在名册上并带诊断**，不会静默消失——`list_plugins` 是本步骤的一等证据。

## 4. 激活期取证（启动期日志，A/B 对照）

本节是**启动期证据**，与 §3 的进程内行状态互补：`dsh web` 只在失败时写日志，所以正在跑的那个 GUI 没有当天的 startup 日志。
做法是**逼一次启动失败**再读日志（照 `dsh-godot-qa-expert` / `dsh-godot-tech-director` 的同一套方法）：

1. **先校准传感器（正向对照）**：把 preset 里 `tool-fs-search` 的必填 Config `sampleOverCapGlobResults` **临时删掉**，
   跑 `pnpm dsh web --port <被 GUI 占用的端口> --no-open`，日志里**应当**出现
   `agent preset ux-designer: tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config`。**验完必须还原**。
2. **正式取证**：还原后再跑一次，日志里与 `preset` 相关的行数应为 **0**。
3. 这一步顺带证明：预设的内层插件**在启动时就被逐个校验**；bundle 的 patch 是**从 bundle 目录实时读取**的，改文件即生效、**不需要重装**。

> 不先校准就读日志，等于用一个没验过的仪表：「0 命中」本身不是证据，**同一条失败路径下会点名**才是。

**`--patch` 的位置契约**（同族 2026-10-11 实测）：`dsh <profile> ...` 会被展开成 `--profile <profile> ...`，
所以 `--patch` 是**启动器**选项，必须放在 `--port` / `--no-open` 这类应用参数**之前**。

## 5. 角色声明：预期与已知边界

本包把 `requirement-board-role`（`roleId: ux-designer`）**随包**带在 preset 的 `isolate` 组里。

- **会话级生效**（同族 `godot-qa-expert` 实测同形态）：新建会话后 `requirement_role` 里出现 `ux-designer`，
  `holders.online: 1`、`dutiesMissing: false`；路由与「这个会话能不能认领」按 role id 走，这一层可用。
- **可能不落持久记录**：它可能落在 `unregistered` 段而不是 `items` 段。对照 `godot-review-board`（声明在 **profile 层**
  `cordis.patch.yml`）有持久记录——**没有会话在线时职责依然可查**，别的会话也能按职能选中它。
- 若需要补持久记录：按 ROLE-DISPATCH §2.3 在 `~/.dsh/profiles/web/cordis.patch.yml` 里**整条重述**本 preset 的
  `config.plugins`（id 定向补丁整体替换 `config`，只给增量会丢掉其余行）。代价是重复即漂移，所以本包默认不做。

## 6. GUI 冒烟（需要新建会话）

预设的插件修订在会话启动时固定，**已有会话看不到新预设**：

1. 新建会话 → 选「代码工作工具」→ Hero 处选 **沈简 · 交互设计师**。
2. 确认工具面：`read` / `glob` / `grep` / 写文件 / 终端 / 后台作业 / `web` / `ask_user_question` / `todo_write` / `present`；
   **没有** `subagent`、没有 `skill`（本包不挂，刻意）。
3. 让它自报身份：确认**角色 id `ux-designer` 与显示名「沈简 · 交互设计师」**正确，
   然后再 `requirement_role list` 复核该会话正以此角色运行（应列出 8 条职责）。
4. 顺带确认它引项目已钉值与既有事实源**而不是凭记忆**：`project.yaml` 的 `frame_budget_ms` 16.6 /
   `pathfinding_p95_ms` 2 / `memory_ceiling_mb` 3072 · `## Game Feel` 的 120 ms/格 ·
   `design/registry/entities.yaml` · `美术资源规划-v1.md` §3.8 的中文字体硬前置。
5. 🔴 顺带确认**冲突口径没被它自行改判**：问到对比度时，它应**照常提出 4.5:1 并写明不修的后果**，
   但**不推翻「极暗夜戏」**，而是**登记为待裁项**（Art Bible ⑧章）。

## 7. 升级与回退

| 动作 | 做法 |
|---|---|
| 改 persona / 角色声明 | 改**交付包** → `node tools/gen-preset.mjs --write` → `node tools/uxcheck.mjs` → **新建会话**验证（已有会话保持启动时的修订） |
| 改行集（加减插件行） | 改 `tools/gen-preset.mjs` 的 `TEMPLATE` → 重新生成 → `uxcheck` 会按新行集断言（`EXPECTED_ROWS` 需同批更新） |
| 临时停用 | `plugin_manager action=set_plugin target=preset-ux-designer enabled=false` |
| 卸载 | `plugin_manager action=remove_bundle target=dsh-ux-designer` |
| 装不回去 | 本包只新增一个 preset 行，不动任何既有 preset；`list_bundles` 确认列表里没有残留即可 |

## 8. 已知限制

- 预设只在 **web / desktop** 可用；headless 没有预设名册，也不能用来做 §6 的会话冒烟。
- **路径级写权限不是机制约束**：`toolFilter` 只能整工具开关。「只做 DSH 侧配置、不碰游戏仓库代码」是提示词纪律，不是沙箱边界。
- **`order` 70 的合法性由 `uxcheck` 现场扫描**同族 bundle 得出，不是写死的判断：同族再新增预设时它会重新判定。
- **安装前** `uxcheck` 必然在接线两项上 FAIL（见 §3 与 §2 的执行顺序），不要把它当成包坏了；**本包当前已装入**，故树上应为 `FAIL 0 项`。

## 9. 安装记录

| 日期 | 操作 | 版本 | 结果 |
|---|---|---|---|
| 2026-10-11 | 建包（工作区 `bundles/dsh-ux-designer`） | 0.1.0 | `gen-preset --write` 生成 10,564 字符 / 198 行 / 18,478 B preset |
| 2026-10-11 | 静态契约（安装前） | 0.1.0 | `uxcheck` **114 通过 / 2 FAIL**——两项均为「web profile 已接线」，预期红；另做 3 组负向验证（抽掉必填 Config / 改 persona 一字 / duties 条数常数改错），**三次都按预期变红 exit 1** |
| 2026-10-11 | `install_bundle` 装入 `web` profile | 0.1.0 | ✅ `~/.dsh/profiles/web/package.json` 出现 `"dsh-ux-designer": "link:C:/code/deepseek-harness/bundles/dsh-ux-designer"`，且 `dsh.profile.bundles` 末项为本包 |
| 2026-10-11 | 静态契约（安装后） | 0.1.0 | `uxcheck` **116 通过 / 0 FAIL（exit 0）**——接线两项转绿 |
| 2026-10-11 | 进程内名册 | 0.1.0 | ✅ `list_plugins`：`include:preset-ux-designer` `enabled: true` · `fiberPhase: active` · 无诊断（清单共 209 条） |
| 2026-10-11 | 激活期 A/B（§4） | 0.1.0 | ✅ 干净启动日志 9,259 B / preset 命中 **0**；抽掉 `tool-fs-search.sampleOverCapGlobResults` 后 10,523 B / 点名 `agent preset ux-designer: tool-fs-search … invalid config`；已还原且字节一致（18,478 B） |
| 2026-10-11 | 既有门禁回归 | 0.1.0 | ✅ `gtd-check` / `prd-check` / `gsd-check` / `gse-check` / `gqe-check` 均 exit 0 |
| 2026-10-11 | 会话冒烟（§6） | 0.1.0 | ⏳ 待新建会话：验收 2/3（`requirement_role` 读出角色 8 条职责 ＋ 会话自报身份）**尚未取证** |
