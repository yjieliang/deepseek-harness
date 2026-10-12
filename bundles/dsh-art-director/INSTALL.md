# INSTALL · dsh-art-director

装完本包，你会得到预设 **「维奥拉 · 美术总监」**（`preset-art-director`，`order` 69），
五个签注面：Art Bible 制定维护 / 美术风格与视觉仲裁 / 资产规格与命名 / 界面视觉定调 / 美术放量门禁。

## 1. 前置

| 项 | 要求 | 为什么 |
|---|---|---|
| profile | `web` 或 `desktop`（预设只在含 `agent-preset-registry` 的组合里可用；headless 没有预设名册） | 预设是 web-app 层插入的能力 |
| 交付包 | `D:\Godot\projects\dndGame\production\presets\art-director-交付包.md` | persona（§3）与角色声明（§1）的唯一真相源；改内容改它再重新生成 |
| Node | `node` 可执行（本机已有） | `tools/gen-preset.mjs` 与 `tools/ard-check.mjs` |
| 项目侧 | `D:\Godot\projects\dndGame`（本预设面向它） | 它只读，不写游戏仓库 |

## 2. 安装

```
plugin_manager action=install_bundle target=C:\code\deepseek-harness\bundles\dsh-art-director
```

- 用**绝对目录**；不要放在 `%TEMP%`（profile 会以 `link:` 引用该目录本身）。
- 安装会执行插件代码并改动 `~/.dsh/profiles/web/`，需要 Full access 或用户批准。
- 安装后 `~/.dsh/profiles/web/package.json` 会多出 `"dsh-art-director": "link:C:/code/deepseek-harness/bundles/dsh-art-director"`，
  并加进 `dsh.profile.bundles`。

⚠️ **`order` 是 69，不是交付包 §2 建议的 68**：67 已由 `godot-tech-director`、68 已由 `producer` 占用（2026-10-11 同日）。
装之前可以用 `node tools/ard-check.mjs` 现场复核这一点——它会扫 `C:\code\deepseek-harness\bundles` 与
`C:\Users\Administrator\.dsh\bundles` 下所有 `presets/` 的 `order` 值（末次快照：60–70 连续，`ux-designer` 占 70）。

## 3. 装完立刻验证（不需要重启 GUI）

```powershell
cd C:\code\deepseek-harness\bundles\dsh-art-director
node tools/ard-check.mjs                       # 契约 + 与交付包逐字一致 + 生成器无漂移 + 接线
node tools/gen-preset.mjs | Out-File -Encoding utf8 $env:TEMP\ard.gen.yml
fc.exe /b presets\art-director.patch.yml $env:TEMP\ard.gen.yml   # 期望：FC: no differences encountered
```

**安装前** `ard-check` 会有且只有 **1 项 FAIL**（接线项）：

```
- web profile 未接线 dsh-art-director — 未安装 ⇒ 预期红：需主会话 install_bundle；装完这两条自动转绿
```

装完应为「**通过 128 项 / 全部契约检查通过**（exit 0）」。这条断言**不要删**：它是「装上了没有」的唯一静态证据。
它读的是**当下**状态：未安装→红、已安装→绿、**半接线（只有 link 依赖、没进 `bundles` 列表）单独报错**。

再看预设行是否活着：

```
plugin_manager action=list_plugins            # 找 preset-art-director：enabled 且无 diagnostic
plugin_manager action=list_bundles            # 确认 dsh-art-director 已在 profile 的 bundle 列表里
```

**激活失败会留在名册上并带诊断**，不会静默消失——`list_plugins` 是本步骤的一等证据。

## 4. 激活期取证（启动期日志，A/B 对照）

本节是**启动期证据**，与 §3 的进程内行状态互补：`dsh web` 只在失败时写日志，所以正在跑的那个 GUI 没有当天的 startup 日志。
做法是**逼一次启动失败**再读日志（照 `dsh-godot-tech-director` / `dsh-godot-qa-expert` 的同一套方法）：

1. **先校准传感器（正向对照）**：把 preset 里 `tool-fs-search` 的必填 Config `sampleOverCapGlobResults` **临时删掉**，
   跑 `pnpm dsh web --port <被 GUI 占用的端口> --no-open`，日志里**应当**出现
   `agent preset art-director: tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config`。**验完必须还原**（还原后 `ard-check` 的漂移断言应重新转绿）。
2. **正式取证**：还原后再跑一次，日志里与 `preset` 相关的行数应为 **0**。
3. 这一步顺带证明：预设的内层插件**在启动时就被逐个校验**；bundle 的 patch 是**从 bundle 目录实时读取**的，改文件即生效、**不需要重装**。

> 不先校准就读日志，等于用一个没验过的仪表：「0 命中」本身不是证据，**同一条失败路径下会点名**才是。

**`--patch` 的位置契约**（同族实测）：`dsh <profile> ...` 会被展开成 `--profile <profile> ...`，
所以 `--patch` 是**启动器**选项，必须放在 `--port` / `--no-open` 这类应用参数**之前**。

## 5. 角色声明：预期与已知边界

本包把 `requirement-board-role`（`roleId: art-director`，7 条 duties）**随包**带在 preset 的 `isolate` 组里。

- **会话级生效**（同族实测同形态）：新建会话后 `requirement_role` 里出现 `art-director`，
  `holders.online: 1`、`dutiesMissing: false`；路由与「这个会话能不能认领」按 role id 走，这一层可用。
- **可能不落持久记录**：它可能落在 `unregistered` 段而不是 `items` 段。对照 `godot-review-board`（声明在 **profile 层**
  `cordis.patch.yml`）有持久记录——**没有会话在线时职责依然可查**，别的会话也能按职能选中它。
- 若需要补持久记录：按 ROLE-DISPATCH §2.3 在 `~/.dsh/profiles/web/cordis.patch.yml` 里**整条重述**本 preset 的
  `config.plugins`（id 定向补丁整体替换 `config`，只给增量会丢掉其余行）。代价是重复即漂移，所以本包默认不做。

## 6. GUI 冒烟（需要新建会话）

预设的插件修订在会话启动时固定，**已有会话看不到新预设**：

1. 新建会话 → Hero 处选 **维奥拉 · 美术总监**。
2. 确认工具面：`read` / `glob` / `grep` / 写文件 / 终端 / 后台作业 / `web` / `ask_user_question` / `todo_write` / `present`；
   **没有** `subagent`、没有 `skill`（本包不挂，刻意）。
3. 让它自报身份：确认**角色 id `art-director` 与显示名「维奥拉 · 美术总监」**正确，
   然后再 `requirement_role list` 复核该会话正以此角色运行。
4. 顺带确认它引的是**既有美术事实**而不是现场发明风格：让它说出 `美术资源规划-v1.md` 的 §0.2 风格一句话、
   核芯判断、47/165 张定案；答不出或答成「我来定一套风格」即为 persona 未生效。

## 7. 升级与回退

| 动作 | 做法 |
|---|---|
| 改 persona / 角色声明 | 改**交付包** → `node tools/gen-preset.mjs --write` → `node tools/ard-check.mjs` → **新建会话**验证 |
| 改行集（加减插件行） | 改 `tools/gen-preset.mjs` 的 `TEMPLATE` → 重新生成 → `ard-check` 会按新行集断言（`EXPECTED_ROWS` 需同批更新） |
| 临时停用 | `plugin_manager action=set_plugin target=preset-art-director enabled=false` |
| 卸载 | `plugin_manager action=remove_bundle target=dsh-art-director` |
| 装不回去 | 本包只新增一个 preset 行，不动任何既有 preset；`list_bundles` 确认列表里没有残留即可 |

## 8. 已知限制

- 预设只在 **web / desktop** 可用；headless 没有预设名册，也不能用来做 §6 的会话冒烟。
- **路径级写权限不是机制约束**：`toolFilter` 只能整工具开关。「只做 DSH 侧配置、不碰游戏仓库代码」是提示词纪律，不是沙箱边界。
- `order` 69 的合法性由 `ard-check` **现场扫描**同族 bundle 得出，不是写死的判断：同族再新增预设时它会重新判定
  （2026-10-11 施工末次快照：60–70 连续无冲突，`ux-designer` 已用 70）。

## 9. 安装记录

| 日期 | 操作 | 版本 | 结果 |
|---|---|---|---|
| 2026-10-11 | 建包（工作区 `bundles/dsh-art-director`） | 0.1.0 | `gen-preset --write` 生成 8,715 字符 / 149 行 / 14,500 B preset；`ard-check` 通过 118 项 + 1 项预期接线 FAIL |
| 2026-10-11 | 断言自证（变异测试 ＋ 接线 A/B） | 0.1.0 | 14 个变异体 **14/14 exit 1**（无静默通过）；接线三态（未装／半接线／已装）= 红／红／绿 |
| 2026-10-11 | `install_bundle` 装入 `web` profile | 0.1.0 | **已观察**：`~/.dsh/profiles/web/package.json` 含 `"dsh-art-director": "link:C:/code/deepseek-harness/bundles/dsh-art-director"` ＋ `dsh.profile.bundles` 列出本包（mtime `04:42:27`）。**由主会话执行**；本施工会话未调用 `plugin_manager` |
| 2026-10-11 | 静态契约（装后复跑） | 0.1.0 | **通过 128 项 / 全部契约检查通过**（exit 0）——含接线两条转绿 |
| 2026-10-11 | 进程内名册 | 0.1.0 | ✅ `list_plugins`：`include:preset-art-director` `enabled: true` · `fiberPhase: active` · 无 diagnostic（清单共 209 条） |
| 2026-10-11 | 激活期 A/B（§4） | 0.1.0 | ✅ 干净启动日志 9,259 B / preset 命中 **0**；抽掉 `tool-fs-search.sampleOverCapGlobResults` 后 10,524 B / 点名 `agent preset art-director: tool-fs-search … invalid config`；已还原且字节一致（14,500 B） |
| 2026-10-11 | 既有门禁回归 | 0.1.0 | ✅ `gtd-check` / `prd-check` / `gsd-check` / `gse-check` / `gqe-check` 均 exit 0；本包只新增一个 preset 行，未改任何既有 bundle |
| 2026-10-11 | 会话冒烟（§6） | 0.1.0 | ⏳ 待新建会话：验收 2/3（`requirement_role` 读出角色 7 条职责 ＋ 会话自报身份）**尚未取证** |
