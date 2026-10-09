# 需求看板插件扩展指南

## Summary

这份文档面向**以后要给这个插件加功能的人**（人或 agent）。它回答三件事：加东西该动哪个文件、哪些规则不能破、改完拿什么证明没弄坏。

读者假定你已经能读这份仓库的代码、能起一个临时 `dsh web` 实例；不假定你读过 `ROLE-DISPATCH.md`（设计正文）或 `DESIGN.md`。

## Table of Contents

- [1. 五分钟心智模型](#1-五分钟心智模型)
- [2. 文件地图](#2-文件地图)
- [3. 契约与硬约束](#3-契约与硬约束)
- [4. 扩展配方](#4-扩展配方)
- [5. 数据与存储](#5-数据与存储)
- [6. 部署与生效](#6-部署与生效)
- [7. 排错手册](#7-排错手册)
- [8. 已知坑与未解问题](#8-已知坑与未解问题)
- [9. 关键锚点索引](#9-关键锚点索引)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

## 1. 五分钟心智模型

插件有三个层，每层只做一件事：

```
Agent 面   tools(3) + skill(requirement-board-tasks)        ← 模型只经这里读写
Host 面    index.js → host/*.js → RequirementService        ← 规则唯一实现处
浏览器面   client.js（一个 plain-JS Client 模块）           ← 只读快照 + 发命令
数据面     一个 ctx.storageDomain 域（json 或 sqlite 后端）
```

**一条数据流**：任何会话写一次 → 域提交 → `domain/changed` → `RequirementService` 发一条 SSE 帧 → 每个打开的页面重取 `/snapshot` 重渲染。跨会话同步就是这么来的，页面侧没有第二套状态机。

**一句话规则**：规则只写在 `host/` 里；`host/tools.js` 与 `host/http.js` 是同一个服务的两个**适配器**（同样的入参、同样的失败），页面只会「读快照 + 发命令」。任何"只在一个适配器里实现"的业务分支都是缺陷。

## 2. 文件地图

| 文件 | 职责 | 动它意味着 |
|---|---|---|
| `package.json` | 插件清单：`exports`（`.`/`./role`/`./client`/`locale/*.json`）、`files`、依赖、`dsh.bundle.patch`、`dsh.client`（`platform: web`） | 加一个对外入口或改打包面 |
| `index.js` | Host 入口：建域、建服务、接线工具/路由/prompt/事件（`domain/changed`、`agent/created`、`agent/disposed`、`subagent/start`、`subagent/end`、`tools/pre-execute`，注入 `jobs`/`systemPrompt`/`webServer`） | 加一个新消费者或新事件源 |
| `host/service.js` | **唯一操作面**：约 35 个方法，读/写/所有权/执行同步/统计全在这里 | 加一个动作（第一优先落点） |
| `host/domain.js` | 持久形态：域声明、zod 记录 schema（在**持久读边界**校验）、`bootstrap`/`open`/`close` | 改记录字段或表 |
| `host/images.js` | 粘贴图片的字节仓库：媒体类型与单张/张数上限、id 正则、头部解析尺寸、外置文件读写（`imageDir`） | 改图片存储或上限 |
| `host/model.js` | 共享词汇：标识符、闭枚举、边界校验、唯一错误类型 `fail()` | 加一个校验或枚举 |
| `host/flow.js` | 流程引擎：`recomputeNodes` 派生节点状态、流转规则、统计 | 改流转语义 |
| `host/dispatch.js` | 执行锁与认领判定表，派生 `advanceable` 与门禁/升级索引 | 改锁或可推进判定 |
| `host/roles.js` | 角色注册表：两层链路决定会话自身角色，派生 `dutiesMissing`/`holders`/`open`/`unregistered`（未登记 = 活会话解析到的 id ∪ 需求引用到的 id） | 改角色派生 |
| `host/runs.js` | 执行同步：观测 subagent 与后台任务，折叠成有界执行单元 | 加一个新执行生产者 |
| `host/templates.js` | 内置标准模板、输入归一化、结构不变量（节点 id 唯一、`dependsOn` 无环、`order` 等于数组下标） | 改模板规则 |
| `host/http.js` | 浏览器传输：前缀路由 `/api/requirement-board` + `/snapshot` `/` `/events` `/health` `/command` `/image`（二进制） | 加一个端点（先问是否该进 service） |
| `host/tools.js` | 三个模型工具：`requirement_board`、`flow_template`、`requirement_role` | 加工具或加参数 |
| `host/config.js` | 行配置解析：无 Loader `Config` schema，这里是唯一校验点；已移除键（`dataDir`/`documentPath`）**按名报错**；`imageDir` 管记录之外的图片字节 | 加配置项 |
| `role.js` | 预设内的一行：在 `isolate: { requirementBoardRole: true }` 组里 `provide` 角色声明 | 改角色声明格式 |
| `client.js` | 浏览器半：DICT（en/zh）→ 控制器/快照源 → 组件 → CSS → 末尾三处注册 | 改面板 |
| `locale/en.json`、`locale/zh.json` | **插件卡片**的标题与描述（由 app-boot 的 package-meta 读取），与 `client.js` 的 DICT 是两回事 | 改插件在插件页/侧边栏的显示名 |
| `cordis.patch.yml` | 插件自带的 bundle 层补丁（一行插件 + 12 个 config 键） | 改默认配置 |
| `dev.overlay.yml` / `_r-import.overlay.yml` | 开发与一次性导入用的覆盖层 | 起临时实例时用 |
| `tests/*.mjs`（12 个套件） | 作者套件，裸 `node` 可跑 | 改行为必须跟着改 |
| `tests/verification/*.mjs` | 独立验收仪器与常驻门 | 加新证据 |
| `probes/`、`rollout/` | S1/S2 探针与部署/回滚记录 | 一般只读 |
| `README.md`/`DESIGN.md`/`ROLE-DISPATCH.md`/`OPTIMIZATION.md`/`G-CHECKLIST.md` | 设计正文与追踪清单 | 改设计先改它们 |

## 3. 契约与硬约束

### 3.1 Host 侧

- **一个能力只实现一次**，且在 `host/service.js`。工具与路由是适配器：同样的方法、同样的失败对象；不要在适配器里补业务分支。
- **不可信输入只有两个边界**：工具参数与 HTTP body。校验都在 `host/model.js`（zod/`fail()`）；进程内服务调用已由调用方类型保证，不要为它加运行时校验。
- **失败口径一致**：所有操作 `throw` 同一个错误类型，带 `code` 与 `details.reason`。面板的文案映射就建在 `code` + `reason` 上（`client.js` 的 `DICT` 与 `ERROR_KEYS`/`*_REASONS`）。
- **配置项必须可从 `cordis.patch.yml` 改**，默认值写在 `host/config.js` 里并与它约束的对象放在一起（`LOCK_LEASE_HOURS` 是范例）；不要新增隐藏常量。
- **派生值不落库**：节点状态（`recomputeNodes`）、`advanceable`、角色派生视图都是纯函数派生，读的时候算，不写回记录。

### 3.2 Client 侧

- **配注册只有三处**：`ctx.slots.inject('sidebar.panellist' | 'shell.overlay' | 'main', () => ctx.slots.register({...}, Component))`。要新开一个槽位位置，先确认 shell 声明过它（未声明的槽位注册在加载时失败）。
- **`inject` 只返回普通数据与回调**：`hooks` 隔间里放**裸可观察源**（渲染器绑成 `use<Name>`），组件永远看不到源本身。
- **`use<Name>` 的选择器是必填参数**。`props.useBoard(identity)` 而不是 `props.useBoard()`；漏传会在 React 内部炸成 `TypeError: l is not a function`，而槽位渲染器会**吞掉**它，表现是"面板一片空白、侧边栏图标还在"。
- **只有最新一次读取能 `publish`**：控制器用 `readSeq` 判"最新一次读取生效"、用 `AbortController` 取消在飞的那次，`changed` 驱动的读取走 200ms 尾随去抖（`CHANGED_READ_DEBOUNCE_MS` 是客户端节奏常量；部署可调的那一个是宿主的 `sseCoalesceMs`）。判据**不能**写成"`revision` 不小于当前"——同一 `revision` 下的不同筛选查询会被误丢（见 §8）。
- **优先用平台原生件**：`require('@deepseek-ai/dsh-client-ui-primitives')` 属基线外置，动态 bundle 可直接要（无需声明）。面板的 `Modal`/`Button`/`Tag`/`Pill`/`Checkbox`/`Input`/`Toast`/`StateDot` 都来自它；不要再手写这些控件或它们的颜色。
- **原生件的已知缺口**：`Tag` 只接收 `tone`/`className`/`children`（**不吃 `title`，也不透传其它 rest**）——需要 `title` 时外包一层 `<span title>`；`Button` 没有 danger 变体，危险动作 = `variant: 'outline'` + `.rb-btn-danger`（双类选择器提特异性，portal 内也生效）。
- **Portal 会脱离面板排版上下文**：`Modal` 渲染到 `body`，所以 `.rb-dialog, .rb-dialog-wide` 必须自带 `font-size:13px; line-height:1.5; color:var(--dsw-alias-label-primary)`。宽版类名是 `rb-dialog-wide`，只写 `.rb-dialog` 不匹配——这类错只有真浏览器能发现。
- **CSS 只用 `--dsw-*` token**，禁止字面色值；字重上限 500。
- **CSS 字符串是 JS 模板字符串**：注释里不能出现反引号或 `${`，否则直接截断样式表（已踩过一次）。

### 3.3 部署侧（改存储或 profile 时必读）

S2 结论，四条硬条件：

1. **域键必须是 `requirement_board`（下划线）**。写成连字符会**静默**退回 json 后端，不报任何错。
2. `storage-sqlite` 行必须用 `insert:` 形式（不是覆盖式替换），否则拿不到后端路径。
3. `- id: storage-domain` 这条**整条被替换**：要保留 json 后端就必须重述 `backend: json`，再加 `requirement_board: sqlite`。
4. 裸行（只写包名）只有在**插件的 `dependencies` 里**才解析得到。

同理 `- id: requirement-board` 的 config 行也是整条替换：改了就得把 12 个键重述一遍，否则其余键回落到插件默认值。

**两副本**：开发树 `.artifacts/requirement-board/` 与部署副本 `~/.dsh/bundles/dsh-requirement-board/`。改开发树后必须 `Copy-Item` 覆盖部署副本并核对哈希；部署副本里还多出 5 个依赖 junction（`zod`、`@deepseek-ai/dsh-storage{,-domain,-json,-sqlite}`）。R-1 记录的 193 文件清单此后不再逐字节成立（文档与仪器只在开发树增长），**以 `client.js`/`host/**` 的哈希为准**。

### 3.4 测试诚信（本项目吃过三次同型教训）

**假件必须忠于真契约，否则绿灯是假的。** 已发生三次：

- 假 connection 与真 `requestRejection(request)` 共享同一个错误契约 → 整个前缀路由 400。
- 假渲染器不经过真实 uSES 绑定 → 277 项全绿却漏掉"钩子必填选择器"，生产面板空白。
- `client-smoke` 的模块加载器对**任何** specifier 都返回 React → 原生件全是 `undefined`，`h(undefined,…)` 退化成 fragment，277 项从未真正看见它们。

因此：**面板可用性只有真浏览器门作数**（`tests/verification/panel-render.e2e.mjs`）；假件只配断言真实 DOM 契约（`type="button"`、`role="dialog"`、`data-tone`），不要断言 CSS-module 类名或自造的 `data-variant`。

## 4. 扩展配方

每个配方都是「改哪 → 怎么改 → 怎么验」。验完把证据落到 `tests/verification/_<tag>.txt`（原始日志豁免编码规则，但**必须以恰好一个 LF 结尾**）。

### 4.1 加一个服务动作

1. `host/service.js` 里加方法：读 `domain`、跑规则、`commit` 后发 `publishDomainChange`。动作是"用户意图"，派生值不算动作。
2. 需要新校验/枚举 → `host/model.js`；涉及节点状态 → 走 `host/flow.js` 的 `recomputeNodes`；涉及锁 → 走 `host/dispatch.js`。
3. 失败一律 `fail(code, message, details)`，并给面板补文案键（见 4.6）。
4. 验：`node tests/<相关套件>.mjs`（`domain`/`dispatch`/`queue`/`roles`/`runs`/`decision`/`delegate` 按领域挑）。

### 4.2 加一个工具或工具参数

1. 工具是适配器：解析 JSON 参数 → 调 4.1 的方法 → 渲染有界文本结果。参数 schema 与描述属于**模型可见契约**，按模型视角写，不要出现 UI/传输词汇。
2. 新工具要同时进 `index.js` 的注册列表，并在 `.agents/skills/requirement-board-tasks/SKILL.md` 里说明"什么时候用它"（否则模型不知道何时调用）。
3. 工具描述与结果文本会被快照测试钉住：改了要有意为之，并跑 `node tests/smoke.mjs`。
4. 验：`node tests/smoke.mjs` + `node tests/loader.mjs`（真实 Loader 组合面）。

### 4.3 加一个 HTTP 字段或端点

1. 先问：这是不是一个**服务动作**？是 → 落 4.1，`host/http.js` 只加转发分支。
2. 路由形状固定：`GET /api/requirement-board/snapshot|/`、`GET /events`（SSE）、`GET /health`、`POST /command`。
3. 新增快照字段要同时改 `client.js` 的控制器快照初始值与 `snapshot()` 的合并逻辑（控制器里的 `publish(patch)` 是唯一合并点）。
4. 验：`node tests/client-smoke.mjs`（客户端控制器假件）+ 真浏览器门。

### 4.4 加一个需求字段（纵切，最容易漏层）

按顺序改，每层都要动：

| 层 | 改什么 |
|---|---|
| `host/domain.js` | 记录 schema（zod 在持久读边界校验），必要时 `SCHEMA_VERSION` 与迁移 |
| `host/model.js` | 字段的校验/枚举与默认值 |
| `host/service.js` | 创建/更新时写入，读出时投影 |
| `host/tools.js` | 工具参数与结果文本（模型要能读写它） |
| `host/http.js` | 若在快照里，确认透传 |
| `client.js` | DICT 文案、筛选控件、详情/卡片渲染 |
| `tests/*.mjs` | 至少一个域级用例 + 一条快照/工具读数 |
| 验收仪器 | 若改了持久形态，加一条真后端（json+sqlite 双跑）读数 |

**持久字段改名/删除**要按仓库规矩写升级指南（这是外部可感变化）。

### 4.5 加一个面板视图或页签

1. `client.js` 的视图状态在 `BoardPage` 的 `view`（现有 `board`/`queue`/`decisions`），页签用 `Pill` 渲染。
2. 新视图的渲染函数放在主页面下方，与 `QueueView` 同级；数据只来自快照，不要自己发请求。
3. 文案进 `DICT`（en/zh 成对）。
4. 验：**给真浏览器门加一条断言**（例如新页签文本可见、点击后 `innerText` 含某个键词），否则这个视图没有任何守卫。

### 4.6 加一份文案（三个文案面，别混）

| 文案面 | 位置 | 读者 |
|---|---|---|
| 面板内文案 | `client.js` 的 `DICT`，`en` 与 `zh` **成对**增加 | 用户 |
| 插件卡片标题/描述 | `locale/en.json` + `locale/zh.json`（`package.json` 的 `meta.title`/`description` 是兜底） | 插件页/侧边栏 |
| 模型可见文案 | `host/tools.js` 的工具描述与结果、`service.promptContext()` 的段落 | 模型 |

三者不共享字典。用户文案用 `t('key')` 取；模型文案直接写（它有快照钉住）。

### 4.7 加一个配置项

1. 在 `host/config.js` 的返回值里加键，用 `requireString`/`requireNumber`/`requireBoolean`/`requireInteger` **带范围**，默认值就地写在约束旁边。
2. 在 `cordis.patch.yml` 的 `config` 里加同名键与注释（bundle 层默认值）。
3. 需要重启宿主才生效（config 在插件加载时解析）。
4. 验：起一个临时实例 `--dump-config` 或直接看行读出的值；`node tests/smoke.mjs`。

### 4.8 加一个角色预设

1. 预设里加一行 `board-role`，放进 `isolate: { requirementBoardRole: true }` 组（见 `role.js` 的说明：不隔离会把服务发到全进程，预设注册表会报该预设损坏）。
2. 行里三个字段 `{ roleId, roleName, duties }`，由 `parseRoleDeclaration` 把关（非法 roleId 在写行的地方就报错）。
3. `.agents/skills/requirement-board-tasks/references/roles.md` 里登记职能，供派发时查。
4. 验：起实例看该角色的 prompt 段落是否出现"你是角色…"与职能；看板角色列表里应出现该角色。

### 4.9 加一条常驻验证门

1. 放 `tests/verification/`，命名 `<域>-<用途>.mjs`；原始输出落 `_<tag>.txt`/`.png`。
2. 必须能**红**：先让它在一个已知坏状态下失败一次（红控），把红读数与修好后的绿读数都记下来。做不到红的门不算门。
3. 依赖外部实例的门要**要求显式凭据**（base + boot token），无凭据时以命名原因退出（`exit 2`），不要静默跳过；**会写数据的门要在文件头写明写什么**（`panel-render.e2e.mjs` 建一条探测需求再删掉，只许打临时实例）。
4. 文件以恰好一个 LF 结尾，然后跑 `node tests/verification/g-hygiene.mjs all`（应 6/6）。

### 4.10 验证阶梯（选最小够用的那一档）

| 你改了什么 | 最少证据 |
|---|---|
| `host/` 规则 | 相关作者套件 `node tests/<name>.mjs` |
| 工具描述/结果 | `node tests/smoke.mjs` + `node tests/loader.mjs` |
| `client.js` 任何可见行为 | `node tests/client-smoke.mjs` **和** `node tests/verification/panel-render.e2e.mjs <base> <token>` |
| 存储路由/部署副本 | 临时实例真机 `node tests/live.mjs <base> <token>`（无凭据会响亮失败） |
| 任意文件 | `node tests/verification/g-hygiene.mjs all`（6/6） |

本轮全量读数（2026-10-04 15:33，11 个套件共 **2556 项**全绿；不含需要真机凭据的 `live.mjs` 与需要 runner 的 `composition/driver.mjs`）：`tests/verification/_ext_suites.txt`。这张表是**阶梯**，不是每次都要跑全量——按你改动的那一行挑最小的一档。

## 5. 数据与存储

- **一个域**：键 `requirement_board`，四张表 `u_requirement_board_{requirements,roles,queues,templates}`，另有 `units` 与 `unit_globals`。作用域是 unit：每个 unit 有自己的表实例。
- **`unit_globals` 单例**：`{ schemaVersion, revision, execSync: { ignored, gaps }, imported: { at, count } }`。`revision` 是文档版本号（面板用它判断快照新旧）；`execSync.ignored/gaps` 是执行同步的观测计数；`imported` 是一次性导入回执。
- **后端由 storage-domain 路由决定**，不由插件决定：`backend: json` → `~/.dsh/storages/<域>.json`；`requirement_board: sqlite` → `storage-sqlite` 行的 `path`（生产为 `~/.dsh/storages/requirement_board.db`，`journalMode: wal`）。
- **一次性导入**：`importLegacy: true` 恰好在一次启动里生效，把旧文档（profile 目录下 `requirement-board/requirement-board.json`）搬进域，成功后改名 `.migrated` 并写 `imported` 回执。默认关闭——打开它会让开发看板吸收别的部署的记录。
- **旧 JSON 的残留写入**：当 `~/.dsh/storages/requirement_board.json` 处于带 `global` 块的 v2 形态时，宿主进程族里**另有一个作用域**会持续改写它（详见第 8 节）。
- **数据不足时的现象**：生产库当前 `requirements = 0`（迁移只带来 1 条模板、0 条需求），面板显示空态是正常的，不是丢数据。

## 6. 部署与生效

1. **bundle 归位**：把开发树复制到 `~/.dsh/bundles/dsh-requirement-board/`（排除 `node_modules` 与 `rollout`），再补 5 个依赖 junction。
2. **profile 指向**：`~/.dsh/profiles/web/package.json` 加 `"dsh-requirement-board": "link:<bundle 绝对路径>"`，`pnpm-lock.yaml` 跟着补三行，`node_modules/` 下建相对符号链接（与另外 4 个 bundle 同款）。
3. **存储路由**：把 `storage-sqlite` + `storage-domain` 两行并进 `~/.dsh/profiles/web/cordis.patch.yml`（遵守 3.3 的四条硬条件）。
4. **一次性导入**：用 `_r-import.overlay.yml` 起一次（`importLegacy: true`），确认 `imported.count` 后撤掉。
5. **生效**：客户端产物按内容哈希发 URL（`?rev=…`），**改完部署副本刷新浏览器即取新字节**（宿主 HMR 也会 stat-poll 该行热换）；**只有改了 `host/**` 或 `cordis.patch.yml` 才需要重启 `dsh web`**。
6. **回滚三层**：① 停用面板（撤 profile 指向）→ ② 恢复 profile 补丁 → ③ 完全卸载（删 bundle + 存储文件）。
   **注意**：恢复 profile 补丁**不会**移除插件路由（路由来自 bundle 层），它的真实效果是存储静默退回 json——不要把它当成"关掉插件"。

## 7. 排错手册

| 症状 | 首查 | 已证根因 |
|---|---|---|
| 侧边栏有点，主列一片空白 | 浏览器 console 的 `slot entry crashed in 'main'` | `use<Name>()` 漏传选择器 → React 抛 `l is not a function` 被槽位渲染器吞掉 |
| 面板路由 404/401 | `host/http.js` 的前缀与鉴权门 | 前缀 401 是正常的（未带凭据）；404 说明路由没注册 |
| 存储看起来没换后端 | profile 补丁里的域键拼写 | 键写成连字符 → **静默**退回 json |
| `--dump-config` 少了配置键 | 该行是否被整条替换 | `- id: X` 覆盖是整条替换，未重述的键回落默认 |
| 契约测试全绿但真机坏 | 假件是否共享真契约 | 假 connection / 假渲染器 / 假加载器三次同型 |
| 对话框内容字号/颜色不对 | 是否 portal 到 `body` | Modal 脱离 `.rb-root`，卡片需自带排版上下文 |
| 危险按钮不红 | 注入顺序或特异性 | 与平台 outline 同特异性时谁后注入谁赢 → 用双类选择器 |
| 样式表整体失效 | CSS 模板字符串被截断 | 注释里出现反引号或 `${` |

## 8. 已知坑与未解问题

- **常驻 json 作用域写入者（未解决）**：只要 `~/.dsh/storages/requirement_board.json` 带 `global` 块，就有另一个作用域持续改写它（`execSync.ignored` 随之上涨），临时实例死亡也停不下来。已证生产根看板确实走 sqlite（正控：`revision` 随真机写入上涨），所以**用户可见数据没有分裂**，代价是该 json 的 mtime 不稳定。候选修法：把 `- id: storage-domain` 的路由覆盖**从 profile 补丁挪进插件 bundle 自己的 `cordis.patch.yml`**（bundle 层覆盖对所有由它播种的作用域生效）。需要宿主重启窗口，不要探测用户的 3080。
- **文档锚点漂移（未解决，2026-10-04 记录）**：`g-anchors.mjs all` 当前 **113/134**，21 处红**全部**是
  `ROLE-DISPATCH.md` 指向 `host/**` 的行号锚点（`host/service.js`／`http.js`／`tools.js`／`domain.js`），起于
  13:29–13:36 那轮 host 改动的行号平移；`DESIGN.md`／`README.md`／`OPTIMIZATION.md`／`G-CHECKLIST.md` 无红。
  读数见 `tests/verification/_o9_anchors_pre_existing.txt`。修法是把这 21 条的 `from`/`to` 与断言语按当前实现重定位；
  **不要**为了让门变绿而放宽断言。
- **两副本漂移**：部署副本只在功能文件上与开发树同步；`README/DESIGN/EXTENDING` 与 `tests/verification/**` 只在开发树增长。要发布/交接时必须整树重同步一次。
- **`Tag` 不吃 `title`**、**`Button` 无 danger 变体**：见 3.2；每次用到都要显式处理，别指望它们透传。
- **面板没有 CSS 复验工具**：样式是 JS 里的字符串，没有 CSS Modules/lint 覆盖，只有真浏览器门 + 截图。新增样式请同时加断言（计算色/字号），否则回归无人守。
- **型号/字号纪律靠人守**：`--dsw-*` token 与 ≤500 字重是本项目的硬规则，但没有自动门。
- **实时链的顺序守卫（已解决，2026-10-04）**：`client.js` 的 `createBoardController` 原先每收到一帧 `changed`
  就整份 refetch（`refresh()`），响应**无条件 publish**：没有序号或版本比较、没有去抖、也不取消在飞请求。写密集时
  （实测文档 `revision` 457、两条需求的执行观察各 137/237 次）读取请求互相重叠，**后到的旧响应把面板盖回较旧的
  `revision`**：还在变的那条看着不对、早就不动的看着正常，手动刷新（单次读取）又是对的——数据本身始终正确。
  现在三件事都落在客户端：`changed` 经 `CHANGED_READ_DEBOUNCE_MS`（200ms）尾随去抖合并成一次读取；每次读取取一个
  `readSeq` 序号，**只有最新一次能 `publish`**；新读取用 `AbortController` 取消在飞的那次。判据落在"最新一次读取生效"
  上，**不是"`revision` 不大于当前就丢弃"**：同一 `revision` 下的不同筛选查询必须照旧无条件生效。代价是面板比提交点
  晚至多一个去抖窗口。证据：`tests/client-smoke.mjs` 314/314（乱序不覆盖、突发合并成一次、被取消的读取、筛选切换照旧）、
  三条红控 `tests/verification/_o9_red_controls.txt`、真浏览器门 14/14 `tests/verification/_o9_panel_render.txt`
  （门新增活链断言：写入一条探测需求必须出现在面板上）。

## 9. 关键锚点索引

Host（行号为当前开发树）：

| 锚点 | 位置 |
|---|---|
| 服务类 | `host/service.js:228` `export class RequirementService` |
| 读方法 | `listRequirements:1188`、`getRequirement:1258`、`queueOf:1590`、`snapshot:2843`、`stats:2735`、`changesSince:2815`、`promptContext:2890` |
| 写方法 | `createRequirement:1283`、`updateRequirement:2219`、`transitionRequirement:2273`、`setChecklist:2339`、`blockRequirement:2367`、`unblockRequirement:2399`、`setArchived:2430`、`deleteRequirement:2476` |
| 所有权 | `claim:1373`、`release:1421`、`queue:1470`、`unqueue:1537`、`delegate:1626`、`disposeSession:2071`、`establishRole:2649` |
| 执行同步 | `observeSubagent:959`、`observeJobEvent:989`、`reconcileSession:1031`、`settleExecutionUnits:1131` |
| 配置解析 | `host/config.js:28` `resolveConfig`（键表见文件内注释） |
| 路由前缀 | `host/http.js:13` `ROUTE_PREFIX`；分支 `:284`（snapshot）、`:301`（events）、`:305`（health）、`:309`（command） |
| 工具 | `host/tools.js:262`（`requirement_board`）、`:295`（`flow_template`）、`:330`（`requirement_role`） |
| Host 接线 | `index.js:155`（域生命周期）、`:164`（ports）、`:174`（domain/changed）、`:219/225`（subagent）、`:231`（jobs）、`:251`（tools/pre-execute）、`:268`（systemPrompt）、`:281`（webServer） |

Client（`client.js` 是单文件，按函数名检索；行号会因编辑漂移）：

| 锚点 | 说明 |
|---|---|
| 头部文档字符串 | 三层与 SSE 数据流的自述 |
| `DICT` | 全部用户可见文案（en/zh 成对），行 41 起 |
| `createSnapshotSource` / `createBoardController` | 唯一的快照源与控制器 |
| `CHANGED_READ_DEBOUNCE_MS` / `readSeq` / `inFlight` | 读取调度：changed 尾随去抖、最新读取守卫、取消在飞读取 |
| `publish(patch)` | 唯一快照合并点（控制器内） |
| `Dialog` | 基于平台 `Modal` 的对话框包装 |
| `PanelIcon` / `BoardPage` / `BoardToast` | 三个槽位条目的组件 |
| 末尾注册 | `locale.register(NS, DICT)`、`slots.inject('sidebar.panellist'｜'shell.overlay'｜'main')` |

验收仪器：

| 仪器 | 用途 |
|---|---|
| `tests/verification/panel-render.e2e.mjs <base> <token>` | 常驻真浏览器门（19 项：入口、`.rb-root`、控件、标题、空态/内容、页签、四轮 0 console 错误、危险按钮存在与 token 比色、新建需求对话框的图片选择器与辅助层（11px + label-secondary + 单行）、活链"写入探测需求→面板出现→删除"；**会写数据**） |
| `tests/verification/g-hygiene.mjs all` | 字节卫生与残留盘点（6 项） |
| `tests/verification/g-anchors.mjs` / `g-receipts.mjs` | 文档锚点与回执全等扫描（锚点当前 **113/134**，21 处漂移全在 `ROLE-DISPATCH.md`，见 §8；回执 5/5） |
| `tests/verification/live.mjs` / `live-auth.mjs` / `live-presets.mjs` | 真机 HTTP/鉴权/预设 |
| `tests/verification/cd-verify.mjs`、`e-verify.mjs`、`a3-*.mjs`、`b-*.mjs` | 各阶段独立验收（json+sqlite 双跑、红控、变更时钟） |
| `tests/verification/r-db.mjs` / `r-dumpconfig.mjs` | 生产库读数与 `--dump-config` 断言 |

## Further Exploration

- 设计正文与语义细则：[ROLE-DISPATCH.md](ROLE-DISPATCH.md)（角色派发、锁、门禁、执行同步）、[DESIGN.md](DESIGN.md)（数据形态与面板）、[OPTIMIZATION.md](OPTIMIZATION.md)（读写放大与优化）。
- 部署与回滚实录：[R-ROLLOUT.md](R-ROLLOUT.md)；独立验收报告：[tests/verification/R-verification.md](tests/verification/R-verification.md)。
- 裁定与踩坑记录：[LEAD-DECISIONS.md](LEAD-DECISIONS.md)（D26/D32 是两次同型测试诚信教训）。
- 插件开发平台规则：仓库 `.agents/skills/cordis-plugin-development`、`.agents/skills/dsh-client-ui-ux`、`docs/subsystems/slots.md`、`docs/web-styling.md`。

## Dev Note

本节非权威，是待定方向与工作假设：

- 三个未截到的对话框（需求详情 / force / 删除确认）需要带数据的实例；计划用开发存储的临时实例造数后补图。
- 面板的"角色行第二行"（`未完成: 0 在线 0 · 空闲 0 · 执行中 0`）读起来像调试输出，属于文案与层级问题，换原生件治不了；待定改法是把四个计数收敛成"有人/没人"两态。
- `.rb-*` 这类自造类名在换用原生件后仍有残留（表格、流程图、选择器、文本域平台没有对应件）；后续可考虑把「行/卡片/表格」也提炼成面板内的两三个共享组件，而不是每处手写。
- 若以后要把它做成可发布的 bundle（而非本机插件），需要补：`files` 覆盖 `EXTENDING.md`、`locale` 与全部 runtime 相对导入、publint 面、以及一条不依赖本机 profile 的安装路径验证。
