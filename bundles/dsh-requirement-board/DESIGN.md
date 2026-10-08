# 需求看板（dsh-requirement-board）设计说明

跨会话需求管理插件：一个 Host 进程内的所有会话共享同一份需求数据，流程模板可自定义，
节点流转实时同步到每个打开的页面，AI 在每个模型步骤都能读到看板并直接改它。

本文件说明模块划分、核心数据结构、关键接口与状态同步机制；安装与使用见 [README.md](./README.md)。
本文件描述的是**当前实现**；角色化任务分发（按角色派活、认领、排队、派给子会话、待人类决策、跨角色门禁、执行同步）的完整规格与裁定见
[ROLE-DISPATCH.md](./ROLE-DISPATCH.md)，存储后端的选型与迁移记录见 [OPTIMIZATION.md](./OPTIMIZATION.md)。

---

## 1. 交付物与需求覆盖

| # | 需求 | 实现位置 | 状态 |
|---|---|---|---|
| 1 | 需求数据模型 + 多会话共享读写 + 并发一致性 | `host/model.js`、`host/domain.js`、`host/service.js` | 完成 |
| 2 | 可定制流程模板（节点名称/顺序/前置依赖/处理人/完成条件），绑定模板并按节点流转，支持推进与回退 | `host/templates.js`、`host/flow.js` | 完成 |
| 3 | 节点状态变更实时同步到其他会话，保留完整流转记录 | `host/domain.js`（单域写链）+ `host/http.js`（SSE）+ `client.js` | 完成 |
| 4 | 流程图渲染，节点自动更新（已完成/进行中/未开始），点击节点看详情与流转历史 | `client.js` → `FlowChart` / `NodeDetail` / `History`（依赖分层 SVG 图，见 4.5） | 完成 |
| 5 | 需求列表 + 进度视图，按会话/负责人/状态筛选，展示整体完成率、节点耗时、阻塞项 | `client.js` → `StatsStrip` / `ProgressPanel`；`host/flow.js` → `computeStats` | 完成 |
| 6 | 会话 AI 也能获取这些信息 | `index.js`（`systemPrompt.context`）+ `host/tools.js`（`requirement_board`、`flow_template`、`requirement_role`） | 完成 |
| 7 | 角色化分发：角色解析与建档、执行锁、执行队列（软预留）、子会话派发、决策需求、跨需求门禁、优先级继承、执行状态同步 | `host/roles.js`、`host/dispatch.js`、`host/runs.js`、`host/service.js`、`host/tools.js`、`client.js` | 完成，规格见 ROLE-DISPATCH.md |

---

## 2. 模块划分

依赖方向自上而下单向，没有任何模块反向依赖上层；`client.js` 与 Host 侧完全解耦，只通过 HTTP 契约通信。

| 文件 | 角色 | 职责 | 依赖 |
|---|---|---|---|
| `index.js` | Host 插件入口 | 解析配置、打开域并 bootstrap、构造 service（注入端口 `agents`/`presets`/`jobs`/`owns`）、把消费者（Agent 工具 / 浏览器路由 / 模型上下文 / 生命周期事件）挂到 Cordis 上 | 下列全部 |
| `host/model.js` | 领域常量与校验 | 枚举、`BoardError`、`fail()`、id 生成、字段解析器（`asString`/`asEnum`…）、角色声明解析 | 无 |
| `host/config.js` | 配置边界 | 校验并解析 `cordis.patch.yml` 的原始行配置，越界/类型错即 `invalid-config` | `model.js` |
| `host/domain.js` | 持久化表单 | 域声明（4 表 + global）、zod 记录 schema、bootstrap、内置模板种子、旧 JSON 一次性导入、revision 自愈 | `model.js`、`templates.js` |
| `host/templates.js` | 流程模板 | 内置模板、模板归一化、节点 id 派生、环检测、前置依赖判定 | `model.js` |
| `host/flow.js` | 流程引擎 | 节点状态推导（唯一来源）、完成条件判定、流转执行、统计聚合 | `model.js`、`templates.js` |
| `host/dispatch.js` | 判定与派生 | `lockState`、`claimable`、`advanceable`、门禁与优先级继承的派生索引 | `model.js` |
| `host/runs.js` | 执行同步 | 执行单元属性判定、事件 → 单元更新、条数截断、结算 | `model.js` |
| `host/roles.js` | 角色注册表 | 两级解析链、`roles` 表读写、临时角色铸造、prompt 角色行、启动 sweep | `model.js` |
| `host/service.js` | 业务服务 | 全部用例：需求/模板/角色/队列/派发/决策/门禁/执行/统计/快照/`changes`/prompt | 上述全部 |
| `host/http.js` | 浏览器传输层 | `prefix` 路由、JSON 解析、命令分发、SSE 流、信任门（`connection` 判定或回环 Origin） | `model.js`、service |
| `host/tools.js` | Agent 工具 | 三个工具的参数 schema 与结果渲染 | service（复用 `http.js` 的 `ENDPOINTS`） |
| `client.js` | 浏览器半边 | 侧边栏入口 + 根级 toast host + 主面板：列表、筛选、统计、流程图、节点详情、流转历史、新建/编辑表单、队列、角色管理、执行单元表 | 仅平台 React |
| `role.js` | 预设侧入口 | 在 preset 的 `isolate: { requirementBoardRole: true }` 组里发布该预设的角色声明 | `host/model.js` |
| `cordis.patch.yml` | 装载清单 | 唯一的 Host 行与它的配置 | — |

**为什么这样切**：看板规则只存在于 `flow.js`/`dispatch.js`/`service.js` 各一份，`http.js` 与 `tools.js` 都是薄适配层——
浏览器点"完成并推进"和 AI 调 `transition` 走的是同一个 `transitionRequirement()`；面板的"能接"与 prompt 的"Claimable for you"走的是同一个 `claimable()`。

---

## 3. 核心数据结构

### 3.1 存储表单（域 `requirement_board`，version 2）

```jsonc
// host/domain.js: requirementBoardDomain
defineDomain({
  name: 'requirement_board',   // 必须匹配 UNIT_NAME_RE /^[a-z][a-z0-9_]*$/，连字符会静默路由到别的键
  version: 2,                  // 不声明 compatibleVersions：介质按精确版本戳校验
  tables: { requirements, templates, roles, queues },   // 每表一个 zod 记录 schema
  global: { schemaVersion: 2, revision: 0, execSync: { ignored: 0, gaps: 0 } },
})
```

- **记录的 zod 校验发生在持久化读边界**：`open` 逐条解析，任何一条不合法都以 `invalid-record` 让整个 open 失败；进程内 `put`/`update` 不重复校验，所以写路径必须把记录留在 schema 内。
- `global` 单例字段：`schemaVersion`（字面量 2）、`revision`（域级单调递增，SSE 与 `changes` 用）、`execSync.{ignored,gaps}`（执行同步计数）、`imported?`（`{ at, count }`，旧 JSON 只导一次的凭据）。
- 存储后端由部署的 `storage-domain.routes.requirement_board` 决定（开发期 sqlite，回退 json 是运行时天然路径）；插件自己不选路径，也没有 `dataDir` 配置。

### 3.2 需求记录（`requirements` 表）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | `req_` + 10 位十六进制，`mintId('req')` 生成 |
| `title` / `description` | `string` | 标题（≤200）/ 描述（≤8000） |
| `kind` | `'task'\|'decision'`? | 缺省读作 `task`；`decision` 是人类专属（3.6 与 ROLE-DISPATCH.md §5.7） |
| `priority` | `'low'\|'normal'\|'high'\|'urgent'` | 自身优先级，默认 `normal` |
| `owner` | `string` | 负责人，可为空 |
| `role` | `string`? | 路由到的角色 id，`''` = 公共任务 |
| `sessions` | `string[]` | 所属会话；创建时自动并入创建者会话 |
| `parentId` | `string\|null`? | 父需求 |
| `blocksOn` | `string[]`? | **我声明的前置**（我依赖谁）；`blockedBy`/`gated` 是它的在线派生 |
| `labels` | `string[]` | 自由标签 |
| `images` | `ImageRef[]`? | 粘贴图片的**引用**；编码后的字节在记录之外（4.3 的路由与 §8 的 `imageDir`），缺省读作 `[]` |
| `templateId` / `nodeId` | `string` | 绑定的流程模板与当前节点 |
| `status` | `'active'\|'blocked'\|'done'\|'archived'` | 需求状态（与节点状态正交） |
| `blockReason` / `blockedAt` | `string` / `ISO\|null` | 阻塞原因与起始时刻 |
| `nodes` | `Record<nodeId, NodeState>` | 每个节点的运行态 |
| `history` | `HistoryEntry[]` | 只追加，上限 500 条 |
| `lock` | `Lock\|null`? | `{ session, name, at, touchedAt, orphaned? }` |
| `delegatedTo` | `{ session, name, roleId, roleBefore, at }\|null`? | 当前命名委托；`roleBefore` 是委托发生时的 `role` |
| `executions` / `executionsTruncated` | `ExecutionUnit[]`? / `boolean`? | 执行观察，有界（≤ `maxExecutions`）；超出丢最旧并置真 |
| `sync` / `execRev` | `{ gap, syncedAt }?` / `number`? | 执行同步状态与**独立的观察版本** |
| `rev` | `number` | **记录级**单调递增，CAS 依据；执行同步写不推进它 |
| `createdAt` / `updatedAt` / `createdBy` / `updatedBy` / `requestedBy` | `ISO` / `string` | 审计字段；`requestedBy` 在 `create` 时定格 |
| `lastChangedBy` 等 | — | **不存在**：字段以本表为准 |

`NodeState = { status: 'pending'|'active'|'done', enteredAt, completedAt, checks: boolean[], assignee, note }`
`ExecutionUnit = { ref, kind: 'subagent'|'job', label, status, progress, detail, startedAt, finishedAt, updatedAt }`，
`status ∈ running|stopping|completed|killed|failed`。
`ImageRef = { id, name, mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif', byteLength, width, height, createdAt }`，
`id` 形如 `img-<uuid>`，同时是外置字节的文件名主干；`width`/`height` 由文件头部解析，不解码整图。
`images` 在 v2 之后加入且**故意不升版本戳**：新增字段声明为 optional，旧记录便读作"没有图片"；
改版本戳则相反——介质按精确版本戳校验且没有迁移，升号会让既有数据直接打不开（`host/images.js` 是字节仓库）。

### 3.3 流程模板（`templates` 表：`FlowTemplate` / `TemplateNode`）

```jsonc
{
  "id": "tpl-standard", "name": "标准研发流程", "description": "...",
  "version": 1, "builtin": true, "createdAt": "...", "updatedAt": "...", "createdBy": "...",
  "nodes": [{
    "id": "review",                    // 由名称派生，CJK 保留；重名自动加后缀
    "name": "需求评审", "order": 0,
    "dependsOn": ["design"],           // 声明式前置依赖，装载时做环检测
    "assignee": "张三",                 // 处理人
    "description": "…",
    "completion": {
      "type": "manual" | "checklist",
      "checklist": ["范围明确"],        // type=checklist 时需求逐项勾选
      "requireNote": false             // 是否必须填写说明才能离开该节点
    }
  }]
}
```

内置 `tpl-standard`：需求评审 → 方案设计 → 开发实现 → 测试验证 → 发布上线（评审/验证为 checklist）。`templates` 表为空时由 bootstrap 种下。

### 3.4 流转记录（`history`，内嵌数组）

`{ id, at, by, byName, action, from, fromName, to, toName, fromStatus, toStatus, note, force, durationMs, blockedBy? }`

`action ∈ create|retemplate|advance|rollback|jump|complete|reopen|block|unblock|archive|restore|update|claim|release|delegate|revoke-delegation`。
`checklist`、`queue`、`unqueue` **不写** history（前者只改节点检查项，后两者只写 `queues` 表）。
`durationMs` 是"在上一个节点停留了多久"，节点耗时统计直接聚合它。

### 3.5 角色与队列记录

| 表 | 键 | 字段 |
|---|---|---|
| `roles` | 角色 id（≤32，`^[a-z][a-z0-9_-]*$`，不得以 `tmp-` 开头、不得等于 `human`） | `{ id, name, duties: string[], source, ephemeral, boundSession?, boundTask?, createdAt, updatedAt }` |
| `queues` | 会话 id | `{ sessionId, sessionName, items: [{ id, at }], updatedAt }` |

`source ∈ preset|manual|observed|delegated`；`ephemeral=true` 的角色 id 恒为 `tmp-<reqId>`，由派发铸造、由结算删除，面板 `put`/`delete` 拒绝手改。队列是**软预留**：不产生锁，也不产生执行单元。

### 3.6 派生视图（不落盘）

`service` 呈现一条需求时，把模板与运行态合并成 `flow`/`progress`，并附上按调用方计算的资格与门禁：

```jsonc
"flow": [ { "id","name","order","dependsOn","assignee","description","completion","status","enteredAt","completedAt","checks","note" } ],
"progress": { "done": 2, "total": 5, "ratio": 0.4, "activeNode": { "id","name","enteredAt" } },
"template": { "id","name","version","builtin","nodeCount" },
"claimable": true, "advanceable": false,          // 为 `me` 作答；`me===''` 是面板
"lock": null, "delegatedTo": null, "reservedBy": null,
"running": 1, "executions": [ /* ... */ ], "executionsTruncated": false, "execRev": 3, "sync": { "gap": false, "syncedAt": "..." },
"blockedBy": ["req_…"], "gated": true, "blocksOn": ["req_…"],
"effectivePriority": "urgent", "escalated": true, "parentId": null, "children": ["req_…"]
```

**`flow` 与 `progress` 永不存储**——它们由 `flow.js` 的节点推导从模板与运行态算出。这样"节点完成了吗"只有一个判定点，界面、工具、统计不可能给出相互矛盾的答案。

---

## 4. 关键接口

### 4.1 服务（`RequirementService`）

| 方法 | 说明 |
|---|---|
| `listRequirements(filter, me)` | 过滤 `session`/`owner`/`status`/`priority`/`kind`/`role`/`templateId`/`query`/`claimable`/`limit`（`status:'open'` = 未完成且未归档）；返回 `{ items, total, limit, offset }`；`claimable` 与 prompt 同源 |
| `getRequirement(id, me)` | 单个需求的完整派生视图（`flow`/`progress`/`history`/`lastTransition` + 3.6 的资格、门禁、执行字段） |
| `createRequirement(input, actor)` | 建需求；`sessions` 自动并入调用者会话，节点跳到模板首节点，`requestedBy` 定格；`images` 传图片 id 列表（未知 id 报 `invalid-image`，不是静默丢弃） |
| `claim(id, input, actor)` / `release(id, input, actor)` | 拿锁 / 放锁；`claim` 走 `judgeClaim` 判定表，`locked` 时若该需求在自己队列里则 `details.queued:true` |
| `queue(id, input, actor)` / `unqueue(id, input, actor)` / `queueOf(session)` | 软预留：追加/移除/读取本会话队列（`queue` 需要非空会话；面板用 `unqueue{targetSession}` 清任意会话） |
| `delegate(id, input, actor)` | 派给子会话（`session` 指名目标）；`revoke:true` 撤销；同一套收尾见 ROLE-DISPATCH.md §5.5 |
| `updateRequirement(id, patch, actor)` | 改 `title`/`description`/`priority`/`owner`/`labels`/`sessions`/`templateId`/`role`/`parentId`/`blocksOn`/`images`；决策的合法子集更窄；`kind` 不可变 |
| `transitionRequirement(id, input, actor)` | 流转：`advance` / `rollback` / `jump` / `complete` / `reopen` |
| `setChecklist(id, { index, checked }, actor)` | 勾选当前节点的检查项 |
| `blockRequirement` / `unblockRequirement` | 阻塞（需 `reason`）/ 解除 |
| `setArchived(id, { archived }, actor)` | 归档 / 恢复；归档同时释放预留并结算委托 |
| `deleteRequirement(id, { expectedRev }, actor)` | 删除，并在同一写链里从所有 `blocksOn`、`parentId`、队列中解绑该 id |
| `listTemplates` / `getTemplate` / `createTemplate` / `deleteTemplate` | 模板管理；删除被引用模板需 `force`，否则 `in-use` |
| `listRoles` / `putRole` / `deleteRole` / `establishRole(agent)` | 角色表管理；`establishRole` 在 `agent/created` 时建档（失败不连累创建） |
| `disposeSession(agent)` | 会话结束的收尾：释放队列、结算委托、锁标孤儿 |
| `sweepDangling()` | 启动 sweep：清孤儿 `tmp-*` 角色、队列幽灵项、悬挂 `blocksOn`/`parentId`、已销毁会话的 `delegatedTo`；不可判定项以 `deferred` 具名返回 |
| `stats(options)` | `computeStats`（见 4.6）+ `byKind`/`byRole`/`decisions`/`criticalPath`（**计数**）/`queues`/`queued`/`reserved`/`orphanedLocks`/`pendingDelegations`/`running`/`execSync` |
| `changesSince(since)` | `since` 之后的变更与流转；返回 `{ since, requirements, transitions, revision, truncated }`（`truncated` = 流转超过 200 条） |
| `snapshot(filter, me)` | `{ revision, generatedAt, requirements, total, templates, roles, stats, queues }` |
| `promptContext(session, limit)` | 该会话在一个模型步骤里看到的看板文本（段序见 ROLE-DISPATCH.md §6） |

**写操作的返回约定**：除 `delete*` 外，每个写方法都返回**同一个**派生视图（presented
requirement）——`flow` / `progress` / `history` / 最近一次流转 `lastTransition`。流转不再额外
返回 `{ requirement, transition }`，勾选不再额外返回 `{ requirement, checklist }`：调用方（面板、
AI 工具、HTTP 命令）只需读一个形状，`lastTransition` 就是"刚刚发生了什么"的回执。HTTP 命令
响应与 `snapshot` 里的需求对象同构。

### 4.2 Agent 工具

| 工具 | 动作 |
|---|---|
| `requirement_board` | `list` `get` `create` `update` `claim` `release` `queue` `unqueue` `delegate` `transition` `checklist` `block` `unblock` `archive` `restore` `delete` `stats` `changes` |
| `flow_template` | `list` `get` `create` `delete` |
| `requirement_role` | `list`（`put`/`delete` 只走面板 HTTP） |

三者都是 `service` 的薄包装，模型的 JSON 参数在工具边界解析，结果以受 `MAX_RENDER = 6000` 字符约束的文本返回（截断时提示收窄筛选条件）。`get` 额外带上调用方自己的 `queue`。

### 4.3 HTTP 端点（`/api/requirement-board`）

| 端点 | 说明 |
|---|---|
| `GET /snapshot?status=&owner=&session=&priority=&kind=&role=&templateId=&query=&claimable=&limit=&offset=&me=` | 面板初始数据与增量刷新；`me` 是会话 id（不是角色名） |
| `GET /events` | SSE：`ready`（连接建立）、`changed`（任何一次提交，按 `sseCoalesceMs` 合并）；心跳 15s |
| `GET /health` | 存活探测 |
| `POST /command` | `{ action, session, name, me, id, ... }`，动作面含 `refresh/list/create/update/transition/checklist/release/unqueue/delegate/block/unblock/archive/restore/delete/stats/changes/template.*/role.*`；**没有** `claim`/`queue` |
| `POST /image?name=` | **二进制**：body 就是图片字节，`content-type` 是媒体类型，`name` 是原文件名。成功回 `{ image: ImageRef }`；仅 PNG/JPEG/WebP/GIF，单张 ≤20 MiB |
| `GET /image/<id>` | 取回已存图片的字节（`content-type` 为存储时的媒体类型）；未知 id 回 404 |

统一信封：成功 `{ ok: true, data }`；失败 `{ ok: false, error: { code, message, details } }`，
`BoardError` 映射为 **409**，其余为 **500**；图片路由是例外，按 HTTP 语义作答
（`not-found` 404、`invalid-image` 400、`unsupported-media-type` 415、`image-too-large` 413）。JSON 请求体上限 256 KiB（图片上传是二进制路由，按单张
20 MiB 判定，不走这个上限），信任判定优先用平台的
`connection.requestRejection`（401/403），没有该服务时退回回环 `Origin` 校验（403 `forbidden-origin`）。
失败码与 `details` 全集见 ROLE-DISPATCH.md §8.2。

### 4.4 Client 插件注册

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: 'requirement-board', order: 20, label: () => t('panel'), locale: NS }, PanelIcon))
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay', id: 'requirement-board.toast', order: 30, locale: NS, inject: () => ({ hooks: { toast }, dismissToast }) }, BoardToast))
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: 'requirement-board', locale: NS, inject: () => face }, BoardPage))
```

toast host 注册在 `shell.overlay` 而不是面板里：它必须比面板活得久，命令导致面板关闭时仍要报结果。
面板通过 `inject` 面拿到 `{ getSnapshot, subscribe, refresh, recheck, setFilter, controller }`，渲染层把它绑定成组件里的 `props.useBoard()`。
所有文案经 `ctx.locale.register(NS, { en, zh })` 注册后由 `t()` 读取，无硬编码文案。

### 4.5 流程图布局（`client.js` → `FlowChart`）

渲染的是**依赖图**，不是模板列表顺序，且不引入任何第三方库（Mermaid / dagre / cytoscape 都不在
Web 客户端的基线模块表里，客户端插件也不允许用 `dsh.client.external` 拉库）：

1. **分层**：`column(node) = max(column(parent)) + 1`，无前置依赖为 0。所以列的先后就是"前置条件都齐了"
   的推进顺序；某节点依赖更靠后的节点时列序依然正确（`dependsOn` 中不在 `flow` 里的 id 忽略）。
2. **行**：同一列按 `flow` 顺序纵向排开，行距固定，保证盒子不重叠。
3. **坐标**：整数像素（`150×62`，列距 `54`，行距 `12`），节点是 `position:absolute` 的按钮，
   边是同一坐标系上的一个 `<svg>` 覆盖层，因此边的端点必然落在盒子左右边缘的中点上。
4. **边**：每一条 `dependsOn` 都画一条三次贝塞尔 + 独立箭头（`polygon`，不用 `<marker>`，避免多实例 id 冲突）；
   父节点 `done` 时整条边转绿。**跨步依赖**（列距 > 1）会下潜到被跨列所有节点下方的一条"车道"再水平穿行，
   下潜与回升都在半个列距内完成，因此不会切进中间列的节点；到位后仍是水平进入，箭头方向保持向右。
5. 画布高度按最深的车道再加高，宽度按最后一列推算；容器横向滚动（`overflow-x:auto`），窄栏下不会挤坏面板。

### 4.6 统计口径（`flow.js` → `computeStats`）

`total` 不含归档、`archived` 单列；`byStatus` 含归档，`byPriority` 不含；`completionRate = done / total`；
`byOwner`/`bySession` 是 `{ owner|session, total, done, blocked, active }` 的分组；`nodeDurations` 按
`templateId::nodeId` 聚合 `advance`/`complete` 的 `durationMs`；`blocked` 是当前阻塞项，`stalled` 是活跃节点
闲置超过 `stallAfterHours` 的项。`service.stats()` 在它之上补角色/决策/队列/执行同步读数，其中
`criticalPath` 是**计数**，每行的 `escalated` 才是该条的标记。

---

## 5. 状态同步机制

同步分三层，各自解决一个问题：

```
① 同一份数据        一个 Host 进程 = 一个 storage-domain 域 = 一份已提交记录集
                    → 会话之间共享读写是进程属性，不靠消息传递
② 变化推送          写链提交成功后 → domain/changed → 转发本域 → SSE `changed`
                    → 每个打开的页面重新拉一次快照并重渲染（跨会话实时可见）
③ 模型可见性        systemPrompt.context 的 text 是"每次组装步骤重新求值"的函数
                    → 每个模型步骤都读到当前看板；漏掉的用 requirement_board action:"changes" 补
```

**写入到其他会话可见的完整链路**

```
会话 A 的用户点击"完成并推进"
  → fetch POST /command {action:'transition', transition:'advance', expectedRev}
  → dispatchBoardCommand → service.transitionRequirement
  → 域写链：取记录 → 重算节点 → 校验前置依赖与完成条件 → 单行 UPDATE → 提交
  → domain/changed { domain:'requirement_board', … } → service.publishDomainChange
  → SSE 向所有已连接页面推 changed（同一合并窗口内的事件合成一帧）
  → 会话 B 的页面（以及同一浏览器里所有打开的页面）refetch /snapshot 并重绘流程图

会话 C 的 AI 下一步：systemPrompt 重新求值 promptContext(sessionC) → 看到最新节点
```

**为什么用 SSE 而不是轮询**：面板需要"实时"；`EventSource` 原生自带重连，
Host 侧只需在 `res.write` 上推事件，不引入 WebSocket 依赖。SSE 不受 gzip 影响；
`name`/`locale` 字段保持与其它面板一致，`ready` 事件用于点亮面板上的连接状态点。

**为什么数据走 HTTP 而不是 `ctx.remote`**：远程调用需要 typert 的构建期类型图生成，
而本插件必须以"可被 profile 直接安装"的形式交付；HTTP 路由 + `fetch` 没有任何构建期要求。

---

## 6. 并发更新与一致性

策略是"**单一写链 + 记录级乐观并发 + 单行提交 + 启动 sweep 兜跨行**"：

| 机制 | 位置 | 保证 |
|---|---|---|
| 单一权威记录集 | `host/domain.js` | 域是唯一数据源，读永远看到某个已提交代 |
| 单域写链 | 平台 `storage-domain` | 同域写入串行；读-改-写不会交错，并发写不会丢更新 |
| 记录级 CAS | `service.js` `#mutateRequirement` | 调用方可传 `expectedRev`；不一致抛 `conflict`，`details` 带 `{ expected, current }`，绝不覆盖别人的修改 |
| 独立观察版本 | `service.js` `#mutateExecutions` | 执行同步写 `executions`/`sync` 时只推 `execRev`，**不推 `rev`**，长跑进度不会让模型手里的 `expectedRev` 失效 |
| 无版本化字段 | `flow.js` 节点推导 | 节点状态只推导不存储，避免"状态与模板漂移" |
| 只追加审计 | `service.js` | `history` 只追加（上限 500），流转记录不可被后续写入改写 |
| 失败即零写 | `service.js` / `flow.js` | mutator 抛错 → 不提交、不广播，调用方拿到带机器码的错误 |
| 跨行一致性 | `service.js` `sweepDangling()` | 平台没有跨行事务，`delete` 同链解绑、启动 sweep 兜悬挂引用；不可判定项以 `deferred` 具名返回 |

**冲突处置**（由调用方选，插件不替它决定）：① 重读并重试——`get` 拿新 `rev` 后带新 `expectedRev` 重发，AI 与面板的默认流程；② 显式越权——`force: true` 跳过未满足的完成条件/门禁，并记入 `history.blockedBy`；③ 不传 `expectedRev` 时按后写提交，但节点状态仍由同一个推导函数给出，不会出现半新半旧。

---

## 7. 流程语义

| 动作 | 前置条件 | 结果 |
|---|---|---|
| `advance` | 持锁或面板；当前节点完成条件满足（checklist 全勾 / manual 可离开 / `requireNote` 已填）；跨需求门禁已清（`blocksOn` 无未完成项）；下一节点 `dependsOn` 全部 done——后两者可用 `force` 越过 | 当前节点置 `done` 并盖章 `completedAt`，下一节点置 `active`；已是最后节点则整个需求 `done` |
| `rollback` | 持锁或面板；必须给 `to`（早于当前节点）与非空 `note`；**不受跨需求门禁** | 目标节点起的检查项与 `completedAt` 全部清空，目标节点重新 `active` |
| `jump` | 必须给 `to`、非空 `note`、`force: true` | 跳过中间节点直接前进；被跳过的节点保持未开始 |
| `complete` | 同 `advance` 的门禁与完成条件 | 只改需求状态为 `done`，节点不动；同链结算执行单元并放锁 |
| `reopen` | 需求处于 `done` | 回到 `active`，节点不动（`reopen` 后需先回退才能再推进） |
| `block` / `unblock` | `block` 需 `reason` | 只改需求状态与 `blockReason`，节点不动 |
| `archive` / `restore` | — | 归档的需求默认不出现在筛选（`status:'open'`）中；归档同时释放预留、结算委托 |

两类校验都在 `flow.js` 里、且在下一次节点推导之后进行——先让"正要离开的节点"算作已完成，
再判断下一节点的前置依赖是否满足，避免自相矛盾的拒绝。模板节点前置（`dependency-not-met`）先于跨需求门禁（`invalid-transition{blockedBy}`）判定。

---

## 8. 配置

`cordis.patch.yml` 里唯一一行 `requirement-board`，字段全部可选，在校验点上失败即抛（`invalid-config`）：

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `defaultTemplateId` | `tpl-standard` | 非空字符串 | 未指定模板时绑定哪个 |
| `stallAfterHours` | `72` | 0.1–8760 | 活跃节点多久没动算"停滞" |
| `promptContext` | `true` | — | 是否把看板注入模型上下文 |
| `promptMaxItems` | `12` | 1–100 | prompt 各段共享的总条数预算 |
| `http` | `true` | — | 是否注册浏览器路由 |
| `staleClaimHours` | `8` | 0.1–720 | 执行锁的租约 |
| `executionSync` | `true` | — | 是否订阅执行状态并落库 |
| `requireLockForExecution` | `false` | — | 可选硬门槛：无锁会话不得起子智能体/后台任务 |
| `maxExecutions` | `20` | 5–100（整数） | 每任务执行单元条数上限 |
| `maxQueueItems` | `20` | 5–100（整数） | 每会话队列长度上限 |
| `sseCoalesceMs` | `300` | 0–5000 | SSE 变更合并窗口 |
| `importLegacy` | `false` | — | 是否允许一次性导入旧 JSON |
| `imageDir` | `<看板目录>/images` | 非空字符串 | 粘贴图片的**字节目录**；字节在记录之外，所以这是唯一由配置（而不是存储路由）决定位置的数据 |

`dataDir`/`documentPath` 已移除：存储后端与路径是部署的 `storage-domain.routes` 选择，出现这两个键即 `invalid-config`。
`imageDir` 是这条规则的一个明确例外，理由同上：图片字节从不进记录，存储路由管不到它们。"看板目录"由运行时给出：
有 `DSH_PROFILE_DIR` 时是 `<profile>/requirement-board`，否则是 `~/.dsh/requirement-board`（与旧文档
`legacyDocumentPath()` 同源，两者由 `boardDirectory()` 统一推导，不会各自漂移）。

---

## 9. 测试与验证

| 命令 | 覆盖 |
|---|---|
| `node tests/domain.mjs` | 88 项：域表单与 zod 校验、`invalid-record`、导入幂等与凭据、`nextRevision` 自愈、两种后端一致 |
| `node tests/smoke.mjs` | 66 项：模板派生与环检测、完成条件闸门、推进/回退/跳转、乐观并发（含 HTTP 命令路径）、阻塞、统计、HTTP 分发、prompt 上下文、changes、重开进程、模板生命周期 |
| `node tests/roles.mjs` | 220 项：解析链三态、四种建档来源、`human` 保留字、`dutiesMissing`、prompt 角色行、启动 sweep |
| `node tests/dispatch.mjs` | 302 项：`lockState` 全分支、`claimable`/`advanceable` 单一公式、判定表、租约与孤儿锁、并发抢锁、每会话一把锁 |
| `node tests/queue.mjs` | 304 项：软预留追加幂等、上界、他人 `claim` 得 `reserved`、队头 `queued:true` 分支、并发恰一胜、dispose 与面板清预留 |
| `node tests/delegate.mjs` | 344 项：临时角色铸造与绑定、幂等收编、`roleBefore` 回退、归属校验（`owns` 三态）、撤销与 dispose 同一套收尾、链式再派发 |
| `node tests/decision.mjs` | 228 项：`kind` 不可变、人类专属 12 条拒绝与两入口分解、决策不进任何池、`requestedBy` |
| `node tests/gates.mjs` | 246 项：`blocksOn`/`parentId` 环检测、门禁拒绝与 `force` 越权、优先级继承与回落、归档仍挡、`delete` 解绑 |
| `node tests/runs.mjs` | 308 项：子智能体与 job 事件落库、无锁事件 `ignored`、重复状态不写、`output` 不落库、截断、`sync.gap`、不推 `rev` |
| `node tests/client-smoke.mjs` | 浏览器半边：桩掉 module loader / React / 客户端服务 / `fetch` / `EventSource`，真实渲染并驱动交互；校验字典键对齐、插槽注册、SSE 生命周期、几何反推依赖图列与边 |
| `node tests/loader.mjs` | 53 项：装载清单、配置越界、`dataDir` 拒绝、插件行与路由 |
| `node tests/composition/**` | 真组合通道：装配 Loader 配置与 stub 服务，验证挂载、失败收容与 disposer |
| `node tests/verification/**` | 各阶段独立验证仪器（A1/A3/B/CD/E 链、变异对照、快照摘要），报告见同目录 `*-verification.md` |
| `node tests/live.mjs [baseUrl]` | 对**已运行**服务器的端到端检查：真实 HTTP 命令、完整走完 5 个节点、SSE 推送、Origin 守卫、陈旧 `expectedRev` 拒绝、筛选与统计，最后清理自己造的探针需求 |

浏览器半边的测试用了一个小型 React 替身（函数组件、按实例保存的 state 槽、依赖比较的 effect、卸载清理），
所以它验证的是真实渲染路径，而不是字符串拼接。

---

## 10. 已知限制

- **单进程权威**：域内并发由写链串行化，精确并发控制靠 `expectedRev`；真正的多进程部署需要数据库或外部分布式锁。
- **浏览器半边硬编码了 `/api/requirement-board`**：同源 Web GUI 下正常；Electron/`file://` 桌面形态缺少
  fetch 桥接，需另配 base URL。
- **面板是根级插槽**：它不属于某个会话，因此新建需求表单里的"所属会话"是手填/多选（会话 id 建议来自
  列表里已有的值），而不是自动填当前会话；由 AI 创建的需求会自动带上该会话。
- `history` 上限 500 条，超出后最早记录被裁掉（`changes` 相应返回 `truncated: true`）。
- **面板操作不做身份认证**：只做平台信任判定（`connection.requestRejection`）或回环 `Origin` 校验，
  与本机 Web 服务的既有约定一致；不宣称是权限系统，路由属主自行承担安全策略。
- **`jobs.list(caller)` 是弱标识**：过滤是 `job.owner === undefined` 或 `job.owner.id === caller`（无主 job 谁都能看到），
  只用于同步对账，不作权限边界。
- **执行前先注册的强制力范围**：默认 `requireLockForExecution: false`；打开后拦的是**插件可见的工具面**，
  不是全进程机械强制。
- **归属校验降级**：`owns(target, caller)` 在注册表缺失或调用方无活 Agent 时返回 `undefined`，此时放行并 warn 一次；
  只有明确 `false` 才拒绝。
- **改 Host 代码需要重启 `dsh web` 进程**：profile 的 hmr 配置是 `root: []`（不监听插件模块文件），
  `plugin_manager` 的启用/停用只重新执行配置，Node 的 ESM 模块缓存仍返回旧模块。浏览器半边不受影响：
  客户端模块注册表按文件的 `mtime/ctime/size` 生成 `rev`，刷新页面即拿到新代码（客户端 HMR 接收器
  还可能在无刷新时热替换）。改完 Host 代码后请重启服务再按 README 的验证步骤确认。
- **面板更新比提交点晚至多一个去抖窗口**：`changed` 帧驱动整份快照重读，客户端 200ms 尾随去抖把一次写突发合并成
  一次读取（宿主那层合并窗口是可配的 `sseCoalesceMs`，客户端这个 200ms 是本地节奏常量）；每次重读取一个序号，
  只有最新那次 `publish`，新读取用 `AbortController` 取消在飞的那次。因此并发响应不会乱序落地、把面板退回较旧的
  文档 `revision`（存储里的数据始终正确），筛选切换也照旧无条件生效——判据是"最新一次读取"而不是"`revision` 不小于
  当前"。实现与证据见 [EXTENDING.md](EXTENDING.md) §8 与 [OPTIMIZATION.md](OPTIMIZATION.md) O9。
