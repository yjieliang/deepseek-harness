# 阶段 R 落地记录（Rollout record）

范围：ROLE-DISPATCH §13.2 的七步。批准：用户 2026-10-04 06:32「开始阶段 R」。
执行：Lead（编排/记录）+ `rollout-installer`（R-1/R-2）+ `storage-migration`（R-3/R-4）+ `composition-verifier`（R-6 独立验收，**已完成**）。
本记录是**回滚与运维的唯一入口**；原始读数在 `rollout/**`，独立报告在 `tests/verification/R-verification.md`。

> **已被取代（superseded，2026-10-08）**：本记录是阶段 R 的时点读数，两处变化让下列行不再是最新状态——
> ① 看板 skill 升到 **15 条**（`SKILL.md` 现 18555 B / sha256 前缀 `90BDC0B97D57…`，§1 的 R-2 行哈希作废）；
> ② 部署副本按仓库包**重新同步**，新增 `skills/` 与 bundle 层 `skill-filesystem-requirement-board` 行，
> 于是 §1 的文件数与 `client.js` 哈希、§3 的 `rows [requirement-board]`、§5.4 的"同名两份"读数均已过时。
> **当前部署事实以 §9 为准**；§4 的回滚步骤与其余维护陷阱仍然有效。

## 1. 已完成步骤与绝对路径

| 步 | 结果 | 目标路径 | 关键哈希 / 读数 |
|---|---|---|---|
| R-1 bundle 归位 | ✅ | `C:\Users\Administrator\.dsh\bundles\dsh-requirement-board\`（193 文件） | 逐文件 sha256 与开发树一致（`rollout\bundle-copy-manifest.txt`：193 OK / 0 DIFF）；`host\domain.js=E0A5C8C7…`、`host\service.js=9351989E…`、`client.js=`**`6687242B…`**（post-R 修复后，见 §7；初版 `694BBA17…` 已作废） |
| R-1 依赖解析 | ✅ | `…\dsh-requirement-board\node_modules\`（5 个 junction） | `zod`→repo pnpm store；`@deepseek-ai\dsh-storage{,-domain,-json,-sqlite}`→`<repo>\packages\storage\*`（S1 结论：jar 目标指向仓库 checkout，因此部署依赖该 checkout 存在） |
| R-1 profile 指向 | ✅ | `~\profiles\web\package.json`、`pnpm-lock.yaml`、`node_modules\dsh-requirement-board` | `package.json=AB621ABF…`、`pnpm-lock.yaml=197EA623…`；link 为相对 dir symlink `..\..\..\bundles\dsh-requirement-board`（与另 4 个 bundle 同款） |
| R-2 skill 提升 | ✅ | `C:\Users\Administrator\.dsh\skills\requirement-board-tasks\`（3 文件） | `SKILL.md=625BB869…`、`references\dispatch.md=64D7CA11…`、`references\roles.md=33925C55…`（与仓库侧相等；**仓库侧那份保留未动**） |
| R-3 配置并入 | ✅ | `~\profiles\web\cordis.patch.yml`（2070 B → 59539 B / 718 行） | `sha256=21A66A761A3A079C061CCCC7BA45B68AF9763352BA75291D72CF11B7B7432A4C`；原有 5 行保留；新增 `storage-sqlite` / `storage-domain` / 四个预设角色声明；**不含 `importLegacy`** |
| R-4 一次性导入 | ✅ | `~\profiles\web\requirement-board\requirement-board.json` → `.migrated`；库 `~\storages\requirement_board.db` | global `{"schemaVersion":2,"revision":0,"imported":{"at":"2026-10-03T22:43:18.865Z","count":1}}`（**导入了 1 条模板记录**）；二次启动无重复导入 |
| R-5 重启 | ✅（**用户执行**） | 3080 宿主 | 09:29:39 起 `node --import tsx/esm apps/cli/src/bin.ts web`（pid 25996）；旧的 0:42 启动的 pid 4636 已退出 |
| R-6 独立验收 | ✅ 完成 | `tests/verification/R-verification.md` | 7 条断言：5 成立、1 条我的预期被推翻、1 条我的命令写法错；另有 1 项未解决发现。详见 §6 |
| R-7 本记录 | ✅ | 本文件 | — |

## 2. 部署事实（运维必须知道）

- **存储**：域 `requirement_board` 路由到 **sqlite**，库 `C:\Users\Administrator\.dsh\storages\requirement_board.db`（WAL；`-shm`/`-wal` 同目录）。`storage-domain.backend` 仍是 `json`（其它域继续用 json）。
- **旧的 json 域文件** `~\storages\requirement_board.json`：正常启动与 live 运行**确实不碰它**（R-6 第 1 条读数），但这是**有条件的**——一旦它被写成带 `global` 块的 v2 形态，宿主里某个常驻作用域就会持续改写它（见 §6 待跟进项）。当前实测 mtime 已不稳定。
- **回退路径的旧文档** `~\.dsh\requirement-board\requirement-board.json`（2530 B）仍在——那是 `$DSH_PROFILE_DIR` 缺席时的兜底路径，本次导入走的是带 profile 的那份（已 `.migrated`）。两份内容同源，**未动**。
- **`~\.dsh` 文件数**：写入前 7717 → 安装后 7913（+196 = 193 bundle + 3 skill）→ 导入后 **7916**（+3 = sqlite 三件套）。
- **`cordis.yml` 的 mtime 会被重写**：每次启动（含 `--dump-config`）启动器都按原样重写 `~\profiles\web\cordis.yml`（内容始终是空根 `[]`，223 B）。这是平台行为，不是有人改配置。

## 3. 验收读数（截至本记录）

- 作者侧组合断言 **32/32**：`rollout\dump-config-assertions.txt`（含"这些行确实来自 profile 补丁层"的来源对照）。
- DSH 视角：`plugin_manager list_bundles` → `dsh-requirement-board` `installed: true` / `source: link:C:\Users\Administrator\.dsh\bundles\dsh-requirement-board` / rows `[requirement-board]`。
- 重启后的真实宿主：`/api/requirement-board/health` 与 `/snapshot` 均返回 **401**（不是 404）→ 路由已由新宿主提供、鉴权门按设计生效。
- 真实会话内：本会话 prompt 里已注入 `<requirement-board>` 段（0 条需求），角色段显示 `cordis` / `no duties recorded` → **兜底角色路径的真实样本**（§3.4 的 `dutiesMissing` 降级）。
- 部署副本自证：`cd ~\.dsh\bundles\dsh-requirement-board; node tests\smoke.mjs` → **66/66**；按包名从 profile 侧 `createRequire` 解析到新 bundle。
- R-6 独立验收（`tests/verification/R-verification.md`）：真 profile 临时实例 + 部署副本/开发树两条 `live.mjs` **各 35/35 exit 0**；生产补丁与 `dev.overlay.yml` 组合**语义等价、差异清单为空**；回滚演练后补丁 sha256 逐字节复原；两条红控（连字符 `routes` 键 → **静默回退 json**；拆 `zod` junction → **响亮失败**：warning + 认证后 404）均复原；同名 skill 两侧逐字节相同、**项目级副本生效**。
- 数据面终态：`u_requirement_board_{requirements 0, roles 1, queues 0, templates 1}`、`units 1`、`unit_globals 1`；`revision=31`、`execSync.ignored=73`。

## 4. 回滚点（三档，全部可执行）

前置：任何回滚后都要**重启 `dsh web`**（Host 插件不能热重载）。

> ⚠️ **先读这条**：插件行来自 **bundle 层**（`dsh-requirement-board` 自己的 `cordis.patch.yml`），所以**只把 profile 补丁换回备份并不会让路由消失**——R-6 实测：路由照旧工作（返回看板自己的结构化 401），真实后果是**存储静默退化到 json**。要真正"没有这个插件"，必须把它从 `dsh.profile.bundles` / manifest 里摘掉（第 1 档就是这么做的）。

1. **整体卸载（不要这个插件了）**
   ```powershell
   # 关键一步：从 ~\.dsh\profiles\web\package.json 的 dsh.profile.bundles 里移除 "dsh-requirement-board"，
   # 并删掉 dependencies 里那一行——否则插件仍会从 bundle 层加载（路由与工具照旧存在）。
   Copy-Item 'C:\code\deepseek-harness\.artifacts\requirement-board\rollout\backup-20261004-0636\profiles\web\cordis.patch.yml' 'C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml' -Force
   Copy-Item '…\rollout\backup-20261004-0636\profiles\web\package.json' 'C:\Users\Administrator\.dsh\profiles\web\package.json' -Force
   Copy-Item '…\rollout\backup-20261004-0636\profiles\web\pnpm-lock.yaml' 'C:\Users\Administrator\.dsh\profiles\web\pnpm-lock.yaml' -Force
   # （退回的 manifest 仍指向开发目录；若要彻底移除，请编辑 bundles 列表而不是只回退文件）
   # 再把 node_modules\dsh-requirement-board 指回 C:\code\deepseek-harness\.artifacts\requirement-board
   ```
   效果：工具、面板、prompt 段与四个预设的角色声明一起消失；**数据仍在 sqlite 库里**（`~\storages\requirement_board.db`），旧模板/需求不丢。skill 可删 `~\.dsh\skills\requirement-board-tasks\`。
2. **只退回 JSON 存储**：把 `cordis.patch.yml` 里 `routes.requirement_board` 改成 `json` → 重启 → 用工具的 `export` 动作反向导出业务数据；域层不变，只换介质。
3. **退回旧版插件**：把 `~\bundles\dsh-requirement-board\` 换回上一版 → 重启。⚠️ **域名版本 2 的记录对 v1 代码不可读**，所以退回前先 `export` 留底。

备份清单：`rollout\backup-20261004-0636\profiles\web\{cordis.patch.yml,package.json,pnpm-lock.yaml}`（均为改动前原件的逐字节副本）。

## 5. 维护陷阱（后续改动必须知道）

1. **四个自定义预设被整段重述**在 profile 补丁层里（`preset-godot-review-board` / `preset-godot-game-suite` / `preset-game-mechanics-designer` / `preset-godot-shader-developer`）。因为 id 定向补丁**整体替换** config、且嵌套 `plugins` 列表无法追加：这些 bundle 侧一旦改了 persona/tool 行，profile 侧必须**镜像同样改动**，否则该 preset 会一直跑旧配置（启动时的 live launch 检查会报"某 preset 不再激活"）。
2. **两份插件副本**：开发树 `.artifacts\requirement-board`（gitignored，仍是开发/测试的事实源）与部署副本 `~\.dsh\bundles\dsh-requirement-board`（193 文件，运行中的那一份）。改完开发树要**重新同步**才能生效（`robocopy .artifacts\requirement-board ~\.dsh\bundles\dsh-requirement-board /E /XD node_modules rollout` + 重新建 5 个 junction + 重启）。
3. **5 个依赖 junction 指向仓库 checkout**（`C:\code\deepseek-harness\...`）。仓库被移动/删除、或 pnpm store 版本变化（`zod@4.4.3` 路径）会让部署副本解析失败。
4. **skill 同名两份**：项目级 `.agents/skills/requirement-board-tasks`（rank 200）与用户级 `~\.dsh\skills\requirement-board-tasks`（rank 400）。同层按 rank 先到先得，**项目级生效、用户级被隐藏并记一条告警**（内容相同）。跨项目时用户级那份才生效。
5. **`--dump-config` 会重写 `cordis.yml` 的 mtime**（内容不变），不要据此判断"配置被改过"。

## 6. 独立验收（R-6）结论与待跟进

独立报告：`tests/verification/R-verification.md`（反证角色自写读取器/比较器，不采信作者读数）。

- **成立**：真 profile + 3109 + 不带 `--patch` 起得来；部署副本与开发树各跑 `live.mjs` 均 **35/35 exit 0**；生产补丁与 `dev.overlay.yml` **组合语义等价（差异清单为空；两层各 195 条目）**；不重复导入（`.migrated` 与 `imported.at` 全程未变）；同名 skill 两侧逐字节相同且**项目级副本生效**；两条红控一"静默"一"响亮"且都复原。
- **更正 1（重要）**：回滚 profile 补丁**不会**移除插件路由（见 §4 开头的警示）。
- **更正 2**：库 global 的 `revision` 现为 **31**（不是导入时的 0；live 运行把它 1→16→31），`execSync.ignored` 为 **73**。
- **更正 3（我的命令错）**：从部署副本目录跑 `node --import tsx/esm tests/live.mjs …` 必然 `ERR_MODULE_NOT_FOUND: tsx`（副本侧没有 tsx）。`tests/live.mjs` 是零 import 的纯 HTTP 客户端，用裸 `node tests/live.mjs <url> <token>` 即可。
- 干净读数：`3109` 与全部 31xx 已释放；仓库工作树未新增未跟踪项；`cordis.patch.yml` 复原后 sha256 逐字节相同。

### 待跟进：一个常驻的 json 作用域看板（未解决）

- 现象：一旦 `~\.dsh\storages\requirement_board.json` 被写成带 `global` 块的 v2 形态，**宿主进程族里某个作用域会持续改写它**（`execSync.ignored` 14→61；临时实例已死仍在写；按字节复原只能压住约 35 秒）。
- 已证：生产根看板**确实走 sqlite**（正控：根 `revision` 随 live 从 16 涨到 31），所以这不是路由失效，而是**另有作用域挂在 json 后端**上。
- 影响：面板与 HTTP 都读根看板（sqlite），**用户可见数据没有分裂**；代价是该 json 文件的 mtime 在宿主运行时不稳定，"正常启动不碰它"只在它保持 `global: null` 旧形态时成立。
- 未定：写入者的**作用域身份**（无 handle/openfiles 工具，且 3080 禁止探测）。候选机制：某个会话/预设作用域自行实例化了 `storage-domain`，取到的是 bundle 层默认（json）而非 profile 补丁层的路由——S2 硬条件 ③ 在"作用域"维度上的翻版。
- 建议下一步（需宿主重启窗口，不要探测 3080）：把 `- id: storage-domain` 的路由覆盖**从 profile 补丁层挪到插件 bundle 自己的 `cordis.patch.yml`**（bundle 层覆盖对所有由它播种的作用域生效），再观察 json 写入是否消失；或用临时实例复现并定位作用域来源。

## 7. Post-R 缺陷修复：面板空白（2026-10-04 10:25）

**症状**（用户报告）：重启后的 3080 里，侧边栏「需求看板」入口在，点开**主列一片空白**（连标题/筛选器都没有）。

**根因**：`client.js` 两处把渲染器绑定的 `use<Name>` 钩子当无参函数调用（`BoardPage` 的 `props.useBoard()`、`BoardToast` 的 `useToast()`）。渲染器绑定是 `useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)`（`packages/client/ui-renderer/src/client/bind.ts:21-26`），**selector 必填**；传 `undefined` 后 React 抛 `TypeError: l is not a function`，槽位渲染器吞掉并只记 `slot entry crashed in 'main'` / `'shell.overlay'` → 条目整块不渲染；侧边栏图标不经过钩子所以照常显示。

**修复**：工厂内加 `identity = value => value`，两处改为 `props.useBoard(identity)` / `useToast(identity)`。开发树与部署副本逐字节同步，`client.js` `694BBA17…` → **`6687242B1B09A29838EDC675302F4889E33445607A20E60EB0AE7CC575A9EBE6`**（148070 B）。

**验证**：真浏览器（Playwright + chromium 1228）0 错误、面板完整渲染；新增常驻门 `tests/verification/panel-render.e2e.mjs` → **绿 7/7 exit 0**，**红控 1/7 exit 1**（把少传 selector 改回部署副本），复原逐字节一致；截图 `tests/verification/_panel_render.png`。

**为什么 277 项 `client-smoke` 没抓到**：它用手工假渲染器/假槽位，不经过真实 uSES 绑定，"钩子必填 selector"这条平台契约在假件里根本不存在（与 D26 的假 connection 同型）。**真浏览器门是这类缺陷唯一的守门人**；`client-smoke` 仍是域/控制器/文案的有效回归，但不能再当作"面板可用"的证据。

**部署生效**：客户端产物按内容哈希发 URL（`?rev=…`），副本一改浏览器**刷新**即取新字节（宿主 HMR 也会 stat-poll 热换）；**无需重启宿主**。

**与缺陷无关的第二层事实**：生产库 `requirements = 0` / `templates = 1` / `roles = 2` —— R 迁移的旧 JSON 本来就只有 1 条模板、0 条需求，空板不是数据丢失；开发期 `dev-board.db` 已不存在，没有可补迁的数据。

## 8. 未完成 / 待办

- ~~R-6 独立验收~~ ✅ 已完成，见 §6。
- ~~面板可渲染性~~ ✅ 已由 `tests/verification/panel-render.e2e.mjs` 常驻守门（见 §8）。
- **面板人工四条（剩下三条）**：① 显式角色（四个自定义预设之一）prompt 出现"你是角色…"与职能；② ~~兜底角色~~ ✅ 已有真实样本（本会话角色段 `cordis` / `no duties recorded`）；③ 真机派发六步（需真模型通道起 continuable 子会话）；④ 真机执行同步（持锁会话起子智能体/后台任务，观察执行单元随真实进程变化，失败长什么样也要写）。
- **常驻 json 作用域看板**（§6 待跟进）：写入者身份未定，建议在宿主重启窗口把 `storage-domain` 路由覆盖挪到 bundle 层验证。
- **分支/提交**：仍是零提交（`.artifacts/` 被 gitignore；唯一受控交付物是 `.agents/skills/requirement-board-tasks/**`）。待用户裁定。

## 9. 部署副本更新（2026-10-08：skill 规范变更后同步）

**触发**：需求看板 skill 新增第 15 条「流程模板要匹配需求本身的流程」，三份副本（`.agents/skills/`、包内 `skills/`、`~\.dsh\skills\`）逐字节相同 = **18555 B / sha256 前缀 `90BDC0B97D57…`**。部署副本此前**没有** `skills/`、补丁里也没有 skill 行，只能靠 `~\.dsh\skills\` 那份生效。

**做法**：用仓库包 `C:\code\deepseek-harness\bundles\dsh-requirement-board` 的**全部受控文件**（`git ls-files` = 102）覆盖部署副本，**排除** `package.json` 与 `dev/**`；部署侧独有内容一律保留（`tests/verification/_*` 181 个原始读数、`probes/*.json`、`live-board.db*`、截图、`dev.overlay.yml`、`_r-import.overlay.yml`、`node_modules\` 的 2 个入口 / 5 个 junction）。

**结果**：部署副本 286 → **290** 文件；99 个受控文件逐文件 sha256 与仓库侧一致（**0 缺失 / 0 不一致**）。关键新值：`client.js = DDF9C6AE90B7…`（159064 B，取代 §7 的 `6687242B…`）、`cordis.patch.yml = 7B8192D18AD8…`（31 → 53 行）。

**生效路径**：

- `cordis.patch.yml` 新增 bundle 层 `skill-filesystem-requirement-board` 行（`providerName: requirement-board`、`includeDefaultRoots: false`、`!!js` 从已安装包解析 `skills/`）。`plugin_manager { action: "list_bundles" }` 已即时重读出两行 `[requirement-board, skill-filesystem-requirement-board]`（补丁解析通过）；但**该行的激活仍需重启 `dsh web`**（INSTALL.md §升级 3）。
- `client.js` / `locale/*.json`：刷新页面即生效，不必重启。
- 静态校验：`!!js` 表达式按 loader 的方式在三种 baseUrl（仓库路径 / 部署真实路径 / profile 符号链接路径）求值，都得到 `<部署包>\skills`，其下 `SKILL.md` 与 `references\{dispatch,roles}.md` 均存在——部署包 `package.json` 的 `exports` 含 `./package.json`，包内自引用即可解析，不依赖 profile 的符号链接。

**有意不做**：

- **`package.json` 与 junction 机制**：本节当时按旧机制保留（理由见上）；**同日稍后按用户指示迁移为 peer 形态并删除 junction，见 §9.1**。
- `dev/**`：仓库把两个 overlay 挪进了 `dev\`，部署侧仍在根目录；本次未动，需要时单独处理。

**新分发路径的影响**：skill 现由 bundle 的全局层发布，`~\.dsh\skills\requirement-board-tasks\` 成为冗余副本（INSTALL.md 第 55 行即如此描述）；本次**未删除**用户级目录。§5.4 的"同名两份"表述以本节为准。

**坑**：`git ls-files` 对非 ASCII 路径默认做 C 风格转义（`"\350\257\204…"`），PowerShell 会把它解析成非法路径并**静默跳过**——`评审文档.md` 第一次就漏拷了。同步后必须按文件系统枚举复核，或单独显式拷贝这一份。

### 9.1 依赖机制迁移（2026-10-08 同日，按用户指示）

**背景**：§9 之前部署副本仍是 `dependencies` + `node_modules\` 5 个 junction 的旧机制（R-1 / S1），而 INSTALL.md §依赖是怎么解析的 已把 junction 定为要取代的不可移植做法。

**做了什么**：① `package.json` 覆盖为仓库版（`peerDependencies`: `@deepseek-ai/dsh-storage-domain`、`zod`；无 `dependencies`；`files` 含 `skills`）；② **删除整个 `node_modules\`**（`zod` 与 `@deepseek-ai\dsh-storage{,-domain,-json,-sqlite}` 四个 junction；`@deepseek-ai` 影子目录本身是真实目录，子项才是 junction）；③ 删除冗余的用户级 skill 副本 `~\.dsh\skills\requirement-board-tasks\`（skill 改由 bundle 全局层发布，INSTALL.md 第 55 行即此设计）。

**备份与回滚**：`C:\code\deepseek-harness\.artifacts\requirement-board\deployment-20261008\` —— `package.json.old`、`junctions.txt`（5 个 junction 的绝对目标）、`restore.ps1`（一键复原 manifest 与全部 junction）。

**证据（按真实启动路径 `apps/cli/src/profile-boot.ts:206` 复刻，而非只读文档）**：

- `createRuntimeResolution({ installAnchor: apps/cli/package.json, profile: web })` 把 `dsh-requirement-board` 列为 linked root，并把 `zod`（由 `packages/goal/goal` 声明）与 `@deepseek-ai/dsh-storage-domain`（由 `packages/bundle/base` 声明）列为 installation-scope 条目。
- 装 `installRuntimeInterception` 后 `import <部署包>/host/images.js` 与 `host/domain.js` 均成功（6 / 11 个导出）。
- **红控**：同一脚本不装 interception → `ERR_MODULE_NOT_FOUND: Cannot find package 'zod' imported from …\bundles\dsh-requirement-board\host\images.js`，证明解析来自拦截层（即该 linked 包的 `peerDependencies`），不是残留 `node_modules`。
- 静态裸名扫描：15 个运行时文件只用到两个裸名 `zod`、`@deepseek-ai/dsh-storage-domain`，都在新 peer 清单内（旧清单多声明的 `storage-sqlite` 从未被包内代码引用）。

**代价（必须知道）**：部署副本**不再能跑自己的套件**——`node tests/smoke.mjs` 之类是普通 Node 程序、不经过拦截层，需要真实 `node_modules`（INSTALL.md §验证 已如此说明）。§3 第 5 行的"部署副本自证 66/66"自此只在带 `node_modules` 链接的**开发侧**副本上可复现。要恢复该能力：给开发侧副本补一套等价的 `node_modules` 链接（或把 `bundles/*` 纳入 pnpm workspace），**不要**再放回部署副本。

**与 §9 的其余部分的关系**：迁移对已加载的 3080 宿主无影响（模块已在内存）；§9 的 skill 行仍需重启 `dsh web` 才激活。§2 与 §5.3 关于 junction 的描述自此作废，以本节为准。
