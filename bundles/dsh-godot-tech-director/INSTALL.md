# INSTALL · dsh-godot-tech-director

装完本包，你会得到预设 **「权衡 · 技术总监 · Godot 专家」**（`preset-godot-tech-director`，`order` 67），
四类签注权：架构与引擎版本终裁 / 性能预算裁定 / ADR 验收签注 / 技术门控与豁免。

## 1. 前置

| 项 | 要求 | 为什么 |
|---|---|---|
| profile | `web` 或 `desktop`（预设只在含 `agent-preset-registry` 的组合里可用；headless 没有预设名册） | 预设是 web-app 层插入的能力 |
| 交付包 | `D:\Godot\projects\dndGame\production\presets\godot-tech-director-交付包.md` | persona 与角色声明的唯一真相源；改内容改它再重新生成 |
| Node | `node` 可执行（本机已有） | `tools/gen-preset.mjs` 与 `tools/gtd-check.mjs` |
| 项目侧 | `D:\Godot\projects\dndGame`（本预设面向它） | 它只读，不写游戏仓库 |

## 2. 安装

```
plugin_manager action=install_bundle target=C:\code\deepseek-harness\bundles\dsh-godot-tech-director
```

- 用**绝对目录**；不要放在 `%TEMP%`（profile 会以 `link:` 引用该目录本身）。
- 安装会执行插件代码并改动 `~/.dsh/profiles/web/`，需要 Full access 或用户批准。
- 安装后 `~/.dsh/profiles/web/package.json` 会多出 `"dsh-godot-tech-director": "link:C:/code/deepseek-harness/bundles/dsh-godot-tech-director"`，
  并加进 `dsh.profile.bundles`。

## 3. 装完立刻验证（不需要重启 GUI）

```powershell
cd C:\code\deepseek-harness\bundles\dsh-godot-tech-director
node tools/gtd-check.mjs                       # 契约 + 与交付包逐字一致 + 生成器无漂移
node tools/gen-preset.mjs | Out-File -Encoding utf8 $env:TEMP\gtd.gen.yml
fc.exe /b presets\godot-tech-director.patch.yml $env:TEMP\gtd.gen.yml   # 期望：FC: no differences encountered
```

再看预设行是否活着：

```
plugin_manager action=list_plugins            # 找 preset-godot-tech-director：enabled 且无 diagnostic
plugin_manager action=list_bundles            # 确认 dsh-godot-tech-director 已在 profile 的 bundle 列表里
```

**激活失败会留在名册上并带诊断**，不会静默消失——`list_plugins` 是本步骤的一等证据。

## 4. 激活期取证（启动期日志，A/B 对照）

本节是**启动期证据**，与 §3 的进程内行状态互补：`dsh web` 只在失败时写日志，所以正在跑的那个 GUI 没有当天的 startup 日志。
做法是**逼一次启动失败**再读日志（照 `dsh-godot-qa-expert` 的同一套方法）：

1. **先校准传感器（正向对照）**：把 preset 里 `tool-fs-search` 的必填 Config `sampleOverCapGlobResults` **临时删掉**，
   跑 `pnpm dsh web --port <被 GUI 占用的端口> --no-open`，日志里**应当**出现
   `agent preset godot-tech-director: tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config`。**验完必须还原**。
2. **正式取证**：还原后再跑一次，日志里与 `preset` 相关的行数应为 **0**。
3. 这一步顺带证明：预设的内层插件**在启动时就被逐个校验**；bundle 的 patch 是**从 bundle 目录实时读取**的，改文件即生效、**不需要重装**。

> 不先校准就读日志，等于用一个没验过的仪表：「0 命中」本身不是证据，**同一条失败路径下会点名**才是。

**`--patch` 的位置契约**（同族 2026-10-11 实测）：`dsh <profile> ...` 会被展开成 `--profile <profile> ...`，
所以 `--patch` 是**启动器**选项，必须放在 `--port` / `--no-open` 这类应用参数**之前**。

## 5. 角色声明：预期与已知边界

本包把 `requirement-board-role`（`roleId: godot-tech-director`）**随包**带在 preset 的 `isolate` 组里。

- **会话级生效**（同族 `godot-qa-expert` 实测同形态）：新建会话后 `requirement_role` 里出现 `godot-tech-director`，
  `holders.online: 1`、`dutiesMissing: false`；路由与「这个会话能不能认领」按 role id 走，这一层可用。
- **可能不落持久记录**：它可能落在 `unregistered` 段而不是 `items` 段。对照 `godot-review-board`（声明在 **profile 层**
  `cordis.patch.yml`）有持久记录——**没有会话在线时职责依然可查**，别的会话也能按职能选中它。
- 若需要补持久记录：按 ROLE-DISPATCH §2.3 在 `~/.dsh/profiles/web/cordis.patch.yml` 里**整条重述**本 preset 的
  `config.plugins`（id 定向补丁整体替换 `config`，只给增量会丢掉其余行）。代价是重复即漂移，所以本包默认不做。

## 6. GUI 冒烟（需要新建会话）

预设的插件修订在会话启动时固定，**已有会话看不到新预设**：

1. 新建会话 → 选「代码工作工具」→ Hero 处选 **权衡 · 技术总监 · Godot 专家**。
2. 确认工具面：`read` / `glob` / `grep` / 写文件 / 终端 / 后台作业 / `web` / `ask_user_question` / `todo_write` / `present`；
   **没有** `subagent`、没有 `skill`（本包不挂，刻意）。
3. 让它自报身份：确认**角色 id `godot-tech-director` 与显示名「权衡 · 技术总监 · Godot 专家」**正确，
   然后再 `requirement_role list` 复核该会话正以此角色运行。
4. 顺带确认它引 `project.yaml` 的已钉值（`frame_budget_ms` 16.6 / `pathfinding_p95_ms` 2 / `memory_ceiling_mb` 3072）而不是凭记忆。

## 7. 升级与回退

| 动作 | 做法 |
|---|---|
| 改 persona / 角色声明 | 改**交付包** → `node tools/gen-preset.mjs --write` → `node tools/gtd-check.mjs` → **新建会话**验证（已有会话保持启动时的修订） |
| 改行集（加减插件行） | 改 `tools/gen-preset.mjs` 的 `TEMPLATE` → 重新生成 → `gtd-check` 会按新行集断言（`EXPECTED_ROWS` 需同批更新） |
| 临时停用 | `plugin_manager action=set_plugin target=preset-godot-tech-director enabled=false` |
| 卸载 | `plugin_manager action=remove_bundle target=dsh-godot-tech-director` |
| 装不回去 | 本包只新增一个 preset 行，不动任何既有 preset；`list_bundles` 确认列表里没有残留即可 |

## 8. 已知限制

- 预设只在 **web / desktop** 可用；headless 没有预设名册，也不能用来做 §6 的会话冒烟。
- **路径级写权限不是机制约束**：`toolFilter` 只能整工具开关。「只做 DSH 侧配置、不碰游戏仓库代码」是提示词纪律，不是沙箱边界。
- 与 `producer` 角色的**条件性耦合——已闭合（2026-10-11）**：persona 里四处「工期／范围 → 交用户本人」已改成「转 `producer`，决定权仍在用户」（见 README §5 与交付包 §6 的 ⚠️ 注）。**改 persona 必须重新生成 preset 并跑 `gtd-check`**，否则逐字断言会打回。
- `order` 67 的合法性由 `gtd-check` **现场扫描**同族 bundle 得出，不是写死的判断：同族再新增预设时它会重新判定。

## 9. 安装记录

| 日期 | 操作 | 版本 | 结果 |
|---|---|---|---|
| 2026-10-11 | 建包（工作区 `bundles/dsh-godot-tech-director`） | 0.1.0 | `gen-preset --write` 生成 13,129 字符 / 269 行 / 21,166 B preset |
| 2026-10-11 | `install_bundle` 装入 `web` profile | 0.1.0 | `application: applied`、`pnpm exitCode 0`、`warnings: []`；profile 新增 `link:` 依赖并进入 `dsh.profile.bundles` |
| 2026-10-11 | 静态契约 | 0.1.0 | `gtd-check` **通过 100 项 / 全部契约检查通过**（exit 0） |
| 2026-10-11 | 进程内名册 | 0.1.0 | `list_plugins`：`include:preset-godot-tech-director` `enabled: true` · `fiberPhase: active` · 无诊断（清单共 206 条，本行为第 203 条） |
| 2026-10-11 | 激活期 A/B（§4） | 0.1.0 | 干净 9,259 B / preset 命中 **0**；抽掉必填 Config 后 10,531 B / **2 行**，第 250 行点名 `agent preset godot-tech-director: tool-fs-search … invalid config`；已还原且字节一致 |
| 2026-10-11 | 既有门禁回归 | 0.1.0 | 同族 `gsd-check` / `gse-check` / `gqe-check` 均 exit 0 |
| 2026-10-11 | 会话冒烟（§6） | 0.1.0 | 待新建会话：验收 2/3（`requirement_role` 读出角色 8 条职责 ＋ 会话自报身份）**尚未取证** |
| 2026-10-11 | 条件性耦合闭合（`producer` 上线） | 0.1.0 | 交付包 §4 四处「交用户本人」→「转 `producer`，决定权仍在用户」；preset 重新生成 13,151 字符；`gtd-check` 100 项全绿 |
