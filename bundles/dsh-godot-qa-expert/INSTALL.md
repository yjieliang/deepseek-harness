# INSTALL · dsh-godot-qa-expert

装完本包，你会得到预设 **「银橙AI · Godot 测试与发布就绪专家」**（`preset-godot-qa-expert`，order 66），
四职责：测试策略 / 缺陷分级 / 发布就绪 / 回归规划。

## 1. 前置

| 项 | 要求 | 为什么 |
|---|---|---|
| profile | `web` 或 `desktop`（预设只在含 `agent-preset-registry` 的组合里可用；headless 没有预设名册） | 预设是 web-app 层插入的能力 |
| **`dsh-ccgs-studio`** | **必须已装**（本机已装，`~/.dsh/profiles/web/package.json` 里有 `link:`） | 本预设挂它的 `skills/` 作为第二个技能来源。**它是硬前置**：解析失败会让本预设的 `skill-filesystem-ccgs` 行激活失败，从而整条 preset 变 broken——这是刻意的响亮失败，优于静默得到一张空技能表 |
| 框架语料 | `D:\AI\test\ccgs-essence\` 存在（或用 `CCGS_ESSENCE_DIR` 指向它） | 逐门清单与配置解析规格的替代物；缺失时本预设的一切依赖它们的判定记 `NOT ASSESSED — framework corpus unresolved` |
| Node | `node` 可执行（本机已有） | `tools/ccgs-config.mjs` 与 `tools/gqe-check.mjs` |
| 项目侧 | `D:\Godot\projects\dndGame`（本预设面向它；其他 Godot 项目也能用，但阶段映射表是按它写的） | — |

## 2. 安装

```
plugin_manager action=install_bundle target=C:\code\deepseek-harness\bundles\dsh-godot-qa-expert
```

- 用**绝对目录**；不要放在 `%TEMP%`（profile 会以 `link:` 引用该目录本身）。
- 安装会执行插件代码并改动 `~/.dsh/profiles/web/`，需要 Full access 或用户批准。
- 安装后 `~/.dsh/profiles/web/package.json` 会多出 `"dsh-godot-qa-expert": "link:C:/code/deepseek-harness/bundles/dsh-godot-qa-expert"`，并加进 `dsh.profile.bundles`。

## 3. 装完立刻验证（三条，不需要重启 GUI）

```powershell
cd C:\code\deepseek-harness\bundles\dsh-godot-qa-expert
node tools/gqe-check.mjs                                              # 静态契约：全绿才算结构没问题
node tools/ccgs-config.mjs --selftest                                 # 解析器自测：18 个夹具
node tools/ccgs-config.mjs --root D:\Godot\projects\dndGame           # 真实运行
```

真实运行的期望输出（2026-10-11 实测，与 `project.yaml` 自己的注释一致）：

```
review_mode: lean (rigor:standard)          docs.density: balanced (rigor:standard)
automation: collaborative (default)         story_granularity: balanced (rigor:standard)
workflow: standard (rigor:standard)         qa.level: standard (rigor:standard)
team.size: individual (rigor:standard)      project.stage: unset (unset)
engine: Godot 4.7.2 (project.yaml)          testing.strict: logic=unset … config=unset
```

`project.stage: unset` 是**预期**的：`project.yaml` 与 `production/stage.txt` 都没写，得先有人确认阶段（`/gate-check` 在 `PASS` 且用户确认后才双写）。

然后看预设行是否活着：

```
plugin_manager action=list_plugins          # 找 preset-godot-qa-expert：enabled 且无 diagnostic
plugin_manager action=list_bundles          # 确认 dsh-godot-qa-expert 已在 profile 的 bundle 列表里
```

**激活失败会留在名册上并带诊断**，不会静默消失——`list_plugins` 是本步骤的一等证据。

## 4. 激活期取证（2026-10-11 已做，含正向对照）

第 3 步只是在进程内看行状态。这一节是**启动期日志证据**。做法是**逼一次启动失败**再读日志——`dsh web` 只在失败时写日志，成功启动什么都不写（所以正在跑的那个 GUI 没有当天的 startup 日志）。

1. **先校准传感器（正向对照）**：把本 preset 里 `tool-fs-search` 的必填 Config `sampleOverCapGlobResults` **临时删掉**（就是同族四个预设 2026-09-30 / 10-01 / 10-09 都踩过的那个坑），跑
   `pnpm dsh web --port <被 GUI 占用的端口> --no-open`，日志里**应当**出现：
   ```
   agent preset godot-qa-expert: tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config
   ```
   实测：2026-10-10T17:38:52Z 那次运行（日志 10,527 B）第 250 行确实出现，记在 `name: 'agent-preset-registry'` 条目下。**验完必须把那一行还原**。
2. **正式取证**：还原后再跑一次，日志里与 `preset` 相关的行数应为 **0**（实测 9,259 B、0 命中，比对照那次少 1,268 B）。
3. 这一步顺带证明两件事：预设的内层插件**在启动时就被逐个校验**（不是只在会话里才校验）；bundle 的 patch 是**从 bundle 目录实时读取**的，改文件即生效、**不需要重装**。

**「0 命中」不是空洞的**：同一台机器、同一版本、同一个失败路径下，配置坏掉时它确实点名；所以没被点名就是干净。不先校准就读日志，等于用一个没验过的仪表。

> **`--patch` 的位置契约**（2026-10-11 二轮实测 ＋ `apps/cli/src/args.ts` 第 159–166、202–204 行）：`dsh <profile> ...` 在解析前会被**展开成** `--profile <profile> ...`，所以 `--patch` 仍是**启动器**选项——`pnpm dsh web --patch <overlay.yml> --port 3111 --no-open` **是对的**。
> 真正的约束是：启动器只吃**第一个它不认识的 token 之前**的选项；一旦出现 `--port` / `--no-open` 这类应用参数，**其后所有 token（包括 `--patch`）都归应用**，应用会回 `unknown option '--patch'`。反例：`pnpm dsh web --port 3111 --no-open --patch <overlay.yml>`。
> **撤回一条旧记录**：先前写的「`dsh web --patch x.yml` 一律报 `unknown option '--patch'`」**不成立**——那是把 `--patch` 放在应用参数之后的特例，被我当成了通例。
> 另两条已实测：`pnpm dsh --patch <f> web` → `error: --profile <name> is required`（裸词只有当它**紧跟** `dsh` 时才被当作 profile 名）；`--dump-config` 与任何应用参数互斥 → `error: config dumps take no app arguments, got "--no-open"`。
> 本次正向对照实际用的是「临时改 bundle 里的 patch 文件」，因为那样顺带证明了 patch 是**从 bundle 目录实时读取**的；用 overlay 做对照会绕开这一点。

## 5. GUI 冒烟（需要新建会话）

预设的插件修订在会话启动时固定，**已有会话看不到新预设**：

1. 新建会话 → 选「代码工作工具」→ Hero 处选 **银橙AI · Godot 测试与发布就绪专家**。
2. 确认工具面：`read` / `glob` / `grep` / 写文件 / 终端 / 后台作业 / `skill` / `ask_user_question` / `todo_write` / `web` / `present`；**没有** `subagent`（这是刻意的）。
3. 让模型 `skill` 一次，确认能列到 **两套**技能：本包的 `godot-qa-support`，以及 CCGS 的 `/qa-plan`、`/bug-report`、`/gate-check`、`/regression-suite` 等（`/hotfix`、`/day-one-patch` 是用户专用，模型列不到但你能用 `/` 触发）。
4. 让它跑一次 `node <bundle>/tools/ccgs-config.mjs --root D:\Godot\projects\dndGame`，核对输出块与第 3 步一致。

## 6. 角色声明：实施结论（2026-10-11 实测）

本包把 `requirement-board-role` 声明（`roleId: godot-qa-expert`）**随包**带在 preset 的 `isolate` 组里。实测结果分两半，别把它当成「生效 / 不生效」的二值：

- **会话级生效**：新建会话后 `requirement_role` 里出现 `godot-qa-expert`，`holders.online: 1`（该会话正以此角色运行）、`dutiesMissing: false`（四项职责可解析）。路由与「这个会话能不能认领」都按 role id 走，这一层**已经可用**。
- **不落持久记录**：它出现在 `unregistered` 段而不是 `items` 段。对照 `godot-review-board`（`source: preset`，由 **profile 级** `cordis.patch.yml` 声明）有持久记录——**没有会话在线时职责依然可查**，别的会话也能按职能选中它。

所以唯一缺的是「没有会话在线时，别的会话能否按职能挑中这个角色」。要补这一层，按 ROLE-DISPATCH §2.3 在 `~/.dsh/profiles/web/cordis.patch.yml` 里**整条重述**本 preset 的 `config.plugins`（id 定向补丁会整体替换 `config`，所以必须整条给，不能只给增量——重复即漂移）。**本次未做**：它会改动影响所有会话的 profile 配置，而当前功能已可用。

## 7. 升级与回退

| 动作 | 做法 |
|---|---|
| 改 preset 或技能 | 改**工作区**里的文件 → 重新 `install_bundle` → **新建会话**验证（已有会话保持它启动时的修订） |
| 临时停用 | `plugin_manager action=set_plugin target=preset-godot-qa-expert enabled=false` |
| 卸载 | `plugin_manager action=remove_bundle target=dsh-godot-qa-expert` |
| 装不回去 | 本包只新增一个 preset 行，不动任何既有 preset；`list_bundles` 确认列表里没有残留即可 |

## 8. 已知限制

- 预设只在 **web / desktop** 可用；headless 没有预设名册。
- **路径级写权限不是机制约束**：`toolFilter` 只能整工具开关，无法「只允许写某几个目录」。「可写 `tests/`、`tools/`、`production/**`，不写产品代码」是提示词纪律 + 评审复核，不是沙箱边界。
- `references/05-evidence-channel.md` §四记录的**退出码约定尚未在项目侧落地**：探针脚本多为裸 `quit()`，所以启动冒烟目前只能记 `NOT ASSESSED`。
- `performance.*` 键名与 `/perf-profile` 的读取键名不一致，未核权威拼写前该技能读不到预算（见 NOTICE.md）。

## 9. 安装记录

| 日期 | 操作 | 版本 | 结果 |
|---|---|---|---|
| 2026-10-11 | 建包（工作区） | 0.1.0 | `gqe-check` 69 项全绿；`ccgs-config --selftest` 18 夹具全过 |
| 2026-10-11 | 装入 web profile | 0.1.0 | `install_bundle` 返回 `stage: enable` / `application: applied` / `packageResult.exitCode: 0`，**无 warnings**；`list_plugins` 出现 `include:preset-godot-qa-expert`（`@deepseek-ai/dsh-agent-preset`，`enabled: true`、`fiberPhase: active`、`patchId: preset-godot-qa-expert`），总行数 **204 → 205**；`Config.listConfigs` 里该行 `status: schema`（与 `preset-standard`、`preset-ccgs-studio` 同级）；解析器真实运行输出与 `project.yaml` 自己的注释逐行一致 |
| 2026-10-11 | 激活期取证（正向对照 A/B/A） | 0.1.0 | 干净运行日志 9,259 B、`agent preset` **0 命中**；临时删掉 `tool-fs-search` 必填 Config 后 10,527 B、**1 命中**：`agent preset godot-qa-expert: tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config`（第 250 行，记在 `agent-preset-registry` 下）；还原后 9,259 B、**0 命中**。顺带证明：内层插件在**启动时**就被逐个校验；bundle 的 patch 是**实时读取**的（改文件即生效，无需重装） |
| 2026-10-11 | GUI 会话冒烟 + 角色注册（用户新建会话） | 0.1.0 | 工具面 **19 个**齐备、**无 `subagent`**（刻意）；技能表 **75 项** = `godot-qa-support` 1 ＋ CCGS 68（`godot-qa-support` 职责路由表声明的 16 个★全部在册）＋ 主机层其他来源 6，即预设层技能表与主机层**取并集**；解析器实跑输出与本地逐行一致、`exit 0`；profile 内副本与工作区副本同 SHA256。角色 `godot-qa-expert` 出现且 `holders.online: 1`、`dutiesMissing: false`，但落在 `unregistered` 段（会话级生效、不落持久记录，见 §6） |
| 2026-10-11 | v0.3 优化轮（用户「继续优化」） | 0.1.0 | F1 核实并**关闭最后一个未验证项**：`perf-profile` 读的四项预算里两项键名对不上，权威拼写已核（`06-framework-corpus.md` §四.1）；F2 `gqe-check` **69 → 104 项**（新增跨 bundle 依赖组 35 项 = 16 个★技能在册 ＋ 16 项路由表防漂移 ＋ 2 项外部权威文件 ＋ 1 项依赖根），`--no-external` 退回 69 项，均已反向验证（故意改名/加名 → FAIL + exit 1）；F3 新增 `tools/ccgs-corpus.mjs`（8 夹具全过），R2 从散文变成可执行；F4 文档与清单同步 |
| 2026-10-11 | 应用项目侧修正（用户「改吧」） | — | 按 §四.1 的方案改了 `D:\Godot\projects\dndGame\project.yaml` 第 55/58 行（`frame_rate` → `target_framerate`；`memory_peak_mb: 1536` → `memory_ceiling_mb: 3072`），并同批同步其技术镜像 `docs/architecture/control-manifest.md`（性能表 2 行 ＋ 规则总数行）。改后 `ccgs-config.mjs --root` 实跑 **exit 0**，旧键名在 `project.yaml` **0 命中**（两文件均 LF、无 BOM）。**同批补齐 4 处现用引用**（`design/美术资源规划-v1.md` 3 处 ＋ `production/进度说明-细节.md` 状态行，均按**追加日期注、不改原文**）；**未改** 3 处带日期的历史记录（评审裁决单 / 进度说明-细节 的 2026-10-08 条目 / adoption-plan，改写会篡改记录） |
