# 需求看板（dsh-requirement-board）设计说明

跨会话需求管理插件：一个 Host 进程内的所有会话共享同一份需求数据，流程模板可自定义，
节点流转实时同步到每个打开的页面，AI 在每个模型步骤都能读到看板并直接改它。

本文件说明模块划分、核心数据结构、关键接口与状态同步机制；安装与使用见 [README.md](./README.md)。
本文件描述的是**当前实现**，唯一的例外是 [§11 流程模板管理](#11-流程模板管理)——那一章的**宿主侧与面板侧都已落地**（真浏览器门的读数见 §11.9），章内已标明；角色化任务分发（按角色派活、认领、排队、派给子会话、待人类决策、跨角色门禁、执行同步）的完整规格与裁定见
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
| `title` / `summary` / `description` | `string` | 标题（≤200）/ **简述**（≤300，必填：一两句大白话，面板的主读数）/ 描述（≤8000，范围+验收+交付） |
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

模板的**管理**能力（编辑、归档、影响预览与改绑语义）只是设计，见 §11；§3.3 与 §4.1 描述的写入面目前只有建与删。

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

`source ∈ preset|manual|observed|delegated`（`observed` = 预设 id 兜底，需求引用**不**建档）；`ephemeral=true` 的角色 id 恒为 `tmp-<reqId>`，由派发铸造、由结算删除，面板 `put`/`delete` 拒绝手改。未登记角色是**派生**状态：`list().unregistered` 由"活会话解析到的 id ∪ 需求 `role` 引用到的 id"减去已有记录得出，需求侧另有 `roleUnregistered` —— 删除角色不级联，也不留不可见的悬挂路由。队列是**软预留**：不产生锁，也不产生执行单元。**预设与角色的对照同样是派生的**（`listRoleCatalogue().presets`，规则见 ROLE-DISPATCH.md §3.7）：`source` 只记"谁建的档"，组合里声明了哪些预设、各自解析到哪个角色，每次读时现算。

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
| `createRequirement(input, actor)` | 建需求；`summary` **必填**（空/缺 → `invalid-argument`，错误文案说明"一两句大白话"要求），`sessions` 自动并入调用者会话，节点跳到模板首节点，`requestedBy` 定格；`images` 传图片 id 列表（未知 id 报 `invalid-image`，不是静默丢弃） |
| `claim(id, input, actor)` / `release(id, input, actor)` | 拿锁 / 放锁；`claim` 走 `judgeClaim` 判定表，`locked` 时若该需求在自己队列里则 `details.queued:true` |
| `queue(id, input, actor)` / `unqueue(id, input, actor)` / `queueOf(session)` | 软预留：追加/移除/读取本会话队列（`queue` 需要非空会话；面板用 `unqueue{targetSession}` 清任意会话） |
| `delegate(id, input, actor)` | 派给子会话（`session` 指名目标）；`revoke:true` 撤销；同一套收尾见 ROLE-DISPATCH.md §5.5 |
| `updateRequirement(id, patch, actor)` | 改 `title`/`summary`/`description`/`priority`/`owner`/`labels`/`sessions`/`templateId`/`role`/`parentId`/`blocksOn`/`images`；决策的合法子集更窄；`kind` 不可变；写 `summary` 走同一条 `asSummary`（空值同样被拒） |
| `transitionRequirement(id, input, actor)` | 流转：`advance` / `rollback` / `jump` / `complete` / `reopen` |
| `setChecklist(id, { index, checked }, actor)` | 勾选当前节点的检查项 |
| `blockRequirement` / `unblockRequirement` | 阻塞（需 `reason`）/ 解除 |
| `setArchived(id, { archived }, actor)` | 归档 / 恢复；归档同时释放预留并结算委托 |
| `deleteRequirement(id, { expectedRev }, actor)` | 删除，并在同一写链里从所有 `blocksOn`、`parentId`、队列中解绑该 id |
| `listTemplates` / `getTemplate` / `createTemplate` / `deleteTemplate` | 模板管理；删除被引用模板需 `force`，否则 `in-use` |
| `listRoles` / `putRole` / `deleteRole` / `establishRole(agent)` | 角色表管理；`establishRole` 在 `agent/created` 时建档（失败不连累创建）；`listRoles` 是同步派生视图（来源、在线/空闲、未完成数、未登记） |
| `listRoleCatalogue()` | `listRoles()` 再加 `presets`：组合里声明的每个预设与其角色的对照（`{ items, unavailable }`，规则见 ROLE-DISPATCH.md §3.7）。异步，因为 `agentPresets.list()` 要逐预设做启用诊断；**不并入 `snapshot()`**（同步热点路径），只由 `role.list` 命令按需读 |
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
| `node tests/smoke.mjs` | 89 项：模板派生与环检测、完成条件闸门、推进/回退/跳转、乐观并发（含 HTTP 命令路径）、阻塞、统计、HTTP 分发、prompt 上下文、changes、重开进程、模板生命周期 |
| `node tests/roles.mjs` | 298 项：解析链三态、四种建档来源、`human` 保留字、`dutiesMissing`、prompt 角色行、未登记角色的两种来源、启动 sweep、预设名册对照（活会话/推定/非法 id 三态与 `recorded` 拆分）与两种降级 |
| `node tests/dispatch.mjs` | 302 项：`lockState` 全分支、`claimable`/`advanceable` 单一公式、判定表、租约与孤儿锁、并发抢锁、每会话一把锁 |
| `node tests/queue.mjs` | 304 项：软预留追加幂等、上界、他人 `claim` 得 `reserved`、队头 `queued:true` 分支、并发恰一胜、dispose 与面板清预留 |
| `node tests/delegate.mjs` | 372 项：临时角色铸造与绑定、幂等收编、`roleBefore` 回退、归属校验（`owns` 三态 + 会话头判定）、派发期间禁改路由、写被拒收回临时角色、撤销与 dispose 同一套收尾、链式再派发 |
| `node tests/decision.mjs` | 228 项：`kind` 不可变、人类专属 12 条拒绝与两入口分解、决策不进任何池、`requestedBy` |
| `node tests/gates.mjs` | 246 项：`blocksOn`/`parentId` 环检测、门禁拒绝与 `force` 越权、优先级继承与回落、归档仍挡、`delete` 解绑 |
| `node tests/runs.mjs` | 308 项：子智能体与 job 事件落库、无锁事件 `ignored`、重复状态不写、`output` 不落库、截断、`sync.gap`、不推 `rev` |
| `node tests/client-smoke.mjs` | 380 项，浏览器半边：桩掉 module loader / React / 客户端服务 / `fetch` / `EventSource`，真实渲染并驱动交互；校验字典键对齐、插槽注册、SSE 生命周期、几何反推依赖图列与边、角色来源标签、预设对照区与一键登记预填、登记后重读名册（该行翻面）、名册两种降级文案 |
| `node tests/loader.mjs` | 53 项：装载清单、配置越界、`dataDir` 拒绝、插件行与路由 |
| `node tests/composition/**` | 真组合通道：装配 Loader 配置与 stub 服务，验证挂载、失败收容与 disposer |
| `node tests/verification/**` | 各阶段独立验证仪器（A1/A3/B/CD/E 链、变异对照、快照摘要），报告见同目录 `*-verification.md` |
| `node tests/verification/panel-render.e2e.mjs <baseUrl> <token>` | 真浏览器门（Playwright/Chromium）：面板挂载与控制、角色对话框的 token 特异性、**预设对照区（一预设一行、未建档才有登记按钮、推定与非法 id 分标）与一键登记落库（登记后自行删回）**、图片选择器层级、写入经 SSE 必达面板、模板抽屉与迁移拒绝；留 `_panel_render.png` 与 `_role_roster.png` |
| `node tests/live.mjs [baseUrl] [token]` | 对**已运行**服务器的端到端检查：真实 HTTP 命令、完整走完 5 个节点、SSE 推送、Origin 守卫、陈旧 `expectedRev` 拒绝、筛选与统计，最后清理自己造的探针需求 |

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
- **模板的改进是"追加版本"，不是就地改、也不该删了重建**：那份恒为 1 的 `version`（`host/templates.js:162`）不承担语义，从前"改一个节点名也得删掉重建"——而删除会把在办需求整体改绑到默认模板并丢掉节点进度。宿主侧现在有了 `revise`（追加一个版本，存量需求一行不动）、`migrate`（显式把需求迁到新版）、`archive`/`clone`，模板侧也留下 `changes`/`updatedBy` 审计（[§11](#11-流程模板管理)、[LEAD-DECISIONS.md](./LEAD-DECISIONS.md) D35）；面板上的编辑/归档/迁移界面也已落地（§11.7）。

---

## 11. 流程模板管理

**状态（2026-10-09）**：宿主侧与面板侧都已落地——`host/*.js` 的字段（`revision`/`versions`/`archived`/`updatedBy`/`supersedes`/`changes` 与需求的 `templateRevision`）、三个写入点、读侧 `templateAtRevision` 解析、六个服务方法、`flow_template` 的 `revise`/`migrate`/`archive`/`clone` 与面板 HTTP 命令都已存在，证据与验收读数见 [LEAD-DECISIONS.md](./LEAD-DECISIONS.md) D35。面板侧（§11.7 的模板抽屉与迁移对话框）与 §11.9 的真浏览器门也已落地——抽屉 34/34、生命周期 49/49，读数见 [R-verification.md](./tests/verification/R-verification.md)；`prune` 只有面板命令、工具面不提供。11.3–11.9 因此既是设计、也是已落地部分的验收口径，11.10 是 2026-10-08 的用户裁决。

### 11.1 现状（实现事实）

- 写入面（2026-10-09 起）：`createTemplate`（`host/service.js:2913`）、`reviseTemplate`、`setTemplateMetadata`、`migrateRequirementsToRevision`、`pruneTemplateVersion`、`archiveTemplate`、`cloneTemplate` 与 `deleteTemplate`（`host/service.js:3272`）；工具 `flow_template` 有 `list`/`get`/`create`/`revise`/`migrate`/`archive`/`clone`/`delete` 八个分支（`host/tools.js:369-395`），**不含** `prune`/`metadata`/`preview`；面板命令 `template.*` 见 `host/http.js:292-320`。
- 结构校验集中在 `normalizeTemplate`（`host/templates.js:137`）：`name` 必填 ≤120（`:141`）；`nodes` 1..50（非空 `:143-145`、上界 `:146`）；节点 id 缺省由名称派生（slug 保留 CJK、重名加 `-2`，`:83`），显式 id ≤64（`:106`）、重名即 `invalid-argument`（`:107`）；`dependsOn` ≤20 项、每项 ≤64（`:119`）、必须指向本模板已有节点（`:152`）、不得自环（`:154`）、装载时做环检测（`:180`）；`completion.type ∈ manual|checklist`（`host/model.js:33`）；`checklist` ≤20 项、每项 ≤160（`:114`）；`description` ≤600（`:121`，模板级同值在 `:161`）；`assignee` ≤120（`:120`）。
- 那份 `version` 仍恒为 1（`host/templates.js:162`）；创建时写入的 `updatedAt`（`host/service.js:2918` 传入的 `now`）此后由每个写路径刷新——**版本管理的版本号是新增的 `revision` 字段，与 `version` 无关**（§11.4）。
- 内置 `tpl-standard` 不可删（`host/service.js:3275`），空库时种下（`host/domain.js:507-509`）。
- 模板与需求的耦合：需求存 `templateId`，节点状态是**按位置推导**的派生数据（`host/flow.js:41-46`：`index < currentIndex → done`、`index === currentIndex → active`）；当前节点不在模板里（`nodeIndex < 0`）时不会有任何节点是 `active`。
- 改绑已有路径：`updateRequirement` 把 `templateId` 当结构性字段（需要锁，`host/service.js:170`、`:2395-2396`），改绑后重算节点并写一条 `retemplate` 历史（`:2422-2439`、`:2452-2453`）。
- 删除被占用的模板：需 `force`，否则 `in-use` 并列出引用它的需求 id（`host/service.js:3279-3281`）；`force` 时逐个改绑到 `config.defaultTemplateId`，消失的当前节点重置为该模板首节点（`:3245-3268`）。
- 模板的增删改**不写需求 `history`**（§3.4 的 `action` 词汇表里没有模板动作）；`changesSince`（`host/service.js:3561`）同样只回需求与流转（`:3541`）。

### 11.2 缺口

**截至 2026-10-09 的闭合状态**：G1–G5、G7 已随宿主侧落地闭合——追加版本（`revise`）、`revision`/`versions`/`changes` 与 `expectedRevision` 提供版本与并发判据、模板侧留下 `changes`+`updatedBy` 且 `deleteTemplate` 收 `actor`、删除保护 `config.defaultTemplateId`、`force` 改绑经 `#retemplateEntry` 写 `retemplate(force:true)` 留痕、模型可改可归档可删而 `prune` 只在面板。**G6 也已闭合**：面板侧随本轮落地（模板抽屉、只读流程预览、版本历史、迁移对话框，`client.js` 已接线）。下面各条保留为"当时为什么算缺口"的记录，其中的现在式说法（如"只拒内置""不写 history""没有更新动作"）已被上面的状态取代。

- **G1 不能编辑**：改名、改节点、改完成条件只能"删了重建"，而删除会把在办需求整体改绑到默认模板并丢掉节点进度——"改一个字"的代价与"换掉整个流程"相同。
- **G2 版本字段是死的**：`version` 恒 1、`updatedAt` 只在创建时写（11.1），既无法表达"模板已演进"，也没有并发判据。
- **G3 没有审计**：模板的增删改不落在任何历史里；`deleteTemplate` 连 actor 参数都没有（`host/service.js:3272`），模板侧只有创建时写的 `createdBy`。
- **G4 删除不保护配置默认模板**：`deleteTemplate` 只拒内置（`:3237`）。若 `config.defaultTemplateId` 指向非内置模板，删掉它之后新建需求的默认模板解析（`:1532-1534`）会撞上 `#template` 的 `not-found`（`:491-497`），`force` 改绑的落点（`:3246`）也会一起取不到。
- **G5 `force` 改绑不留痕**：删除时对每个需求只改字段，transform 没有追加 `history` 条目（`:3257-3267`；`#mutateRequirement` 的签名 `host/service.js:1099` 也没有历史参数），需求侧看不到"我的流程什么时候被换了"。
- **G6 面板只有"新建"**：无编辑、无删除接线、无引用可见性、无流程预览（`client.js:2159` 的 `CreateTemplateDialog`、`:2977` 的入口按钮、`:3139` 的 `template.create` 接线；`template.delete` 有宿主路由但没有客户端调用）。
- **G7 权限口径不一致**：角色管理是"面板独有"（`host/service.js:3363`、`host/http.js:324-328`），模板却是模型可写（`host/tools.js:369-395`），既不要锁也没有角色约束。

### 11.3 不变量

- **I1 节点 id 是身份，名称只是标签**：改节点名不改 id；改 id 等价于"删旧节点 + 加新节点"，必须在追加的那个版本里显式表达。
- **I2 需求永远钉在一个仍然存在的版本上**：需求用可选字段 `templateRevision`（11.4）记住自己跑在哪一版；**新写入一律显式带这个字段**，只有本次改动之前写入的存量记录才读作第 1 版（三个写入点见 11.4）。**任何被需求钉住的版本都不得被裁剪**——裁剪时必须拒绝并列出钉住它的需求（11.6），否则那条需求的流程无从解析。
- **I3 改模板不改任何需求**（机制 1 的核心承诺，2026-10-08 裁决）：追加版本只写模板记录一个键，**完全不碰 `requirements`**；在跑需求的 `nodeId`、节点状态、已勾选项一律原样。
- **I4 只有显式迁移才会动需求，且必须事前可见**：迁移到新版时，若某需求当前的 `nodeId` 不在目标版本里，按既有先例归一到目标版本的首节点（`host/service.js:3298`、`:2434`）并写一条 `retemplate` 历史（note 记 `node <旧> 已不在第 N 版 → <新>`，沿用 §3.4 既有词汇、不新增动作）；`checklist` 长度变化会清空该节点的已勾选项（`host/flow.js:48-50`）。迁移前必须能列出"哪几条受影响、各自会变成什么样"。
- **I5 破坏性动作必须留痕**：需求侧写 `retemplate`（含 `force` 与原因），模板侧写自己的 `changes`（11.4）。
- **I6 内置模板不可改、不可删、不可归档**：要改内置流程就 `clone` 出一个自定义模板，再改那个副本（11.5）。

### 11.4 数据模型（已裁决：机制 1——追加版本；不新建表、不升域版本号）

**模板记录**（`host/domain.js:297` 的 `templateRecordSchema`，`.strict()`）：顶层字段仍是"最新版"，读法与今天同构；只**新增可选字段**。

- `revision`（正整数，当前版本号；缺省读作 1）。
- `versions`（**历史版本**数组，从旧到新，**当前版不在其中**；有界，上限 20 条——它是审计尾巴、不是运行参数，所以不进 `Config`，与可配的 `maxExecutions` 不同）：每项 `{ revision, at, by, name, description, nodes, summary }`。**溢出策略是拒绝，不是自动丢最旧**：追加第 21 个版本时报 `invalid-transition`（提示先裁剪旧版本）。这与 `maxExecutions` 那种"超限丢最旧并标 `executionsTruncated`"（`host/config.js:70-72`、`host/domain.js:241`）**故意不同**——执行观测丢了无所谓，模板版本丢了就违反 I2。
- `archived`（布尔）、`updatedBy`、`supersedes`（`cloneTemplate` 的来源模板 id）。
- `changes`（`{ at, by, revision, summary }` 的有界数组，上限同上）。`summary` 由服务端按 diff 生成（`改名 A→B`、`+节点 C`、`-节点 D`、`依赖 D→E`、`checklist 2→3`），面板直接展示。

**需求记录**（`host/domain.js` 的 `requirementRecordSchema`）新增可选字段：`templateRevision`（正整数，钉住所用模板版本）。**三个写入点必须一起改，缺一处机制 1 就自相矛盾**：① **新建时写当前版本**——`createRequirement` 的记录字面量今天只有 `templateId`/`nodeId`（`host/service.js:1595-1601`），必须补 `templateRevision = template.revision ?? 1`，否则模板改到 v2 之后新建的需求会被读成钉在 v1、继续跑旧流程（与机制 1 的意图正相反）；② **两条改绑路径必须重置钉子**——`updateRequirement{templateId}`（`:2422-2439`）与 `deleteTemplate` 的 `force` 改绑（`:3245-3268`）都要把钉子写到**目标模板的当前 `revision`**，否则旧版本号在新模板里找不到，该需求会永久 `invalid-transition`（present/advance 全废），或撞上新模板同号版本而静默用错版本；③ **"缺省读作 1"只适用于本次改动之前写入的存量记录**，新写入一律显式带字段。

**为什么不用升版本号**：`version`（schema 必填、恒 1，`host/templates.js:162`）是历史遗留字段，不承担管理语义；**管理版本是 `revision`**。存档格式**不升** `requirementBoardDomain.version`（现为 2，`host/domain.js:361`）：这套介质按精确版本戳校验且没有迁移（§3.1），升号会让现有库整库打不开——**sqlite 对版本戳做精确比较且完全不看 `compatibleVersions`**（`packages/storage/storage-sqlite/src/index.ts:100-110`），JSON 整单元格式同样直接拒绝（`packages/storage/storage-json/src/format.ts:66-71`），而 `compatibleVersions` 只对 per-record 文档生效（`packages/storage/storage-json/src/per-record-unit.ts:106`）；看板没声明 `layout`，默认就是 `single`（`packages/storage/storage-domain/src/spec.ts:41-47`）。加**可选字段**不升版本号——代码里有现成先例：`images` 就是后加的，`host/domain.js:22-26` 明确写了那次为什么不升。代价是这次改动**只能前进不能后退**：新版本写过的记录带新字段，旧构建的 `.strict()` schema 会拒绝打开；回滚必须连数据一起回（口径同 R-ROLLOUT.md §9.1 的备份/回滚）。

**存量数据零迁移**：现有模板没有 `revision`/`versions` → 读作"第 1 版、无历史"；现有需求没有 `templateRevision` → 读作"钉在第 1 版"。两者都自洽，**不需要任何回填写入**；首次追加版本（`revision` 2）时才把当时的顶层字段快照进 `versions`。

**读侧解析点**：所有"拿模板节点去推导"的地方都要改成"取该需求钉住的那一版"——`advance`/`complete` 的节点判定、`recomputeNodes`、快照的 `flow` 投影、prompt 段，都要先经一个 `templateAtRevision(template, revision)`：`revision === 当前 revision` 取顶层，否则在 `versions` 里找，找不到即 `invalid-transition`（说明 I2 的裁剪门禁被绕过）。这是本节改动面最大的一处。**规则可 grep：任何接收 `template` 并读顶层 `.nodes` 的函数，其调用方都必须先经 `templateAtRevision`**；已知点位（实现时以此为准，并再 grep 一遍 `.nodes`）：`host/service.js:205-250`（`buildFlow`/`presentRequirement`，即快照 `flow` 投影的本体）、`:268-309`（`summarize` 的 `nodeName`/`nodeIndex`/`nodeCount`）、`:3619-3627`（prompt 段的节点名）、`:2422-2439` 与 `:3245-3268`（两条改绑路径）、`host/flow.js:139-143`/`:173`/`:179-191`/`:231-233`/`:254`、`host/templates.js:273`/`:286-289`/`:298-299`。

**钉子指向不存在的版本时的修复口径**：与既有的启动 sweep `sweepDangling()`（DESIGN §4.1:189）同路——**开域时修复**：把该需求的钉子归一到当前 `revision`、按 I4 归一节点并写一条 `retemplate`（note 记 `pinned revision <n> missing → <m>`），用户可见行为是"这条需求被打回最新版"，而不是永久打不开。B2 修好之后，这个状态只可能来自外部直接改库，所以修复是兜底、不是常规路径。

### 11.5 服务 API（拟议；权限与门禁按 11.10 的裁决）

| 方法 | 语义 |
|---|---|
| `reviseTemplate(id, patch, actor)` | **追加一个版本**。`patch = { name?, description?, nodes?, expectedRevision? }`；内置拒绝（`invalid-transition`，I6）；节点结构复用 `normalizeTemplate`（`host/templates.js:137`）校验；`expectedRevision` 不符 → `conflict`；成功后 `revision + 1`、把旧顶层快照推进 `versions`、`changes` 追加一条摘要、写 `updatedBy`/`updatedAt`、**显式 `#bumpRevision()`**；**不碰任何需求**（I3）；返回模板派生视图（含"仍有 N 条钉在旧版"——这是信息，不是门禁）。**模型侧要改模板名/描述就走这个动作**（即追加一个只改名字的版本；工具面没有 `metadata`，见 11.7） |
| `setTemplateMetadata(id, { name?, description? }, actor)` | **原地改**模板级名字/描述：不动 `revision`、不进历史（它不改变任何需求的流程与进度）。内置拒绝。这条划定了"元数据 vs 结构"的分界线：**节点数组的任何变动一律走 `reviseTemplate`**。**只由面板调用**（模型侧改名走 `revise`，见 11.7）。`versions` 每项记的是"当时顶层的名字"，所以原地改名之后历史版本的名称与顶层会不一致——这是有意的（历史版本记当时的实况） |
| `migrateRequirementsToRevision(id, revision, { requirementIds? }, actor, force?)` | 把钉在旧版的需求迁到 `revision`（缺省最新版）。**必须事前列出受影响需求**：逐条给 `{ id, nodeId, next, clearedChecks }`；未指定 `requirementIds` 即"全部钉在旧版的需求"，此时必须带 `force`；目标 `revision` 必须存在（等于当前版或落在 `versions` 里），归档模板同样拒绝（`invalid-transition`）；每条改动写 `retemplate` 历史（I4），**note 用可辨前缀**（迁移记 `migrated to revision <n> from <m>`，与今天改绑的 `bound to template <id>`（`host/service.js:2491`）区分）——`action` 沿用 `retemplate` 足够，`host/domain.js:83-92` 的 `action` 是开放非空字符串 |
| `pruneTemplateVersion(id, revision, actor)` | 裁剪一个历史版本。`revision` 必须 < 当前且存在于 `versions`；**被钉住即拒绝**（`in-use` + 需求清单，I2）；**判定集合与删除的引用集合相同**——所有 `templateId` 匹配的需求，含 done/archived（`host/service.js:3279`），只看在办会漏掉归档需求，它们下次 open 就不可解析。**面板独有**，不进工具面（11.7） |
| `archiveTemplate(id, { archived }, actor)` | 归档/恢复。内置拒绝（I6）；归档后不出现在"新建需求"的选择器里，但 `listTemplates({ includeArchived: true })` 可见；被引用仍可归档（它仍是那些需求的当前流程）；保护 `config.defaultTemplateId` |
| `cloneTemplate(id, { name }, actor)` | 以现有模板（含内置、按当前版）为底新建自定义模板，`supersedes` 记来源 id——改内置流程的正路（I6） |
| `previewRevisionImpact(id, patch)` | **只读**：算出"若按这个 patch 追加版本，哪些需求仍钉在旧版、若迁移各自会变成什么样"，供面板确认对话框用。**工具面不加 `preview` 动作**：模型从 `migrate`/`prune` 失败的 `details`（11.8）拿同一份明细——两侧同源 |
| `setDefaultTemplate` | **不做**：`defaultTemplateId` 是部署配置（§8），不是运行时可改状态；但删除与归档必须保护它（G4） |

**`patch.nodes` 是完整的目标节点列表（全量替换，不做增量合并）**：带 `id` 的条目按 id 更新，不带的按创建规则派生 id（`host/templates.js:83`），`id` 未出现在新数组里的节点即被删除。这样"删节点 + 改依赖"在同一次 patch 里完成、不需要两步，也没有合并语义的二义性；代价是调用方必须回传整份节点（面板表单本来就持有整份）。

**并发判据**：`expectedRevision` 指模板记录**当前**的 `revision`（不是文档 `global.revision`，也不是需求的 `rev`）；缺省即不做 CAS（与需求侧 `#mutateRequirement` 的缺省语义一致，`host/service.js:1092`），不符时报 `conflict` 并给 `details = { expected, current }`（同需求侧写法 `:1069-1072`）。追加是唯一会撞车的地方：两个编辑者同时追加，后者必须 `conflict`，而不是悄悄把版本推成 3。

**字段保全**：`normalizeTemplate` 仍用来校验并塑造**新版本的** `name`/`description`/`nodes`，但落盘记录必须显式带回 `id`/`createdAt`/`builtin`/`createdBy`/`archived`/`changes`/`supersedes`，并自行把旧顶层推进 `versions`、`revision` 取旧值 +1。直接照搬它的返回值落盘会静默重置 `createdAt`（`host/templates.js:164` 的 `input.createdAt || now`）并丢掉 `createdBy`（`host/service.js:2919` 是在它之外补写的）。

**必须显式 `#bumpRevision()`**：`createTemplate`（`:2883`）与 `deleteTemplate`（`:3271`）都调它，而 `#mutateRequirement` 只在被走到时才 bump（`:1085`）。追加版本、改元数据、裁剪都可能完全不经过需求写路径——不补这一步，其它打开的面板收不到 `changed`。

**HTTP 命令名**（现状见 §4.3 的 `template.*`）：新增 `template.revise` / `template.metadata` / `template.migrate` / `template.prune` / `template.archive` / `template.clone` / `template.get`。

**默认模板的解析与保护（G4 与存量坏配置）**：写侧——`deleteTemplate` 与 `archiveTemplate` 都拒绝对 `config.defaultTemplateId` 指向的模板动手（`invalid-transition`）。读侧——省略 `templateId` 时的解析链为 `config.defaultTemplateId` → 内置 `tpl-standard` → `templates` 表首个记录，仍无则 `not-found`（保持 loud）。这条链兜住已经坏掉的存量配置：`deleteTemplate` 自述非事务（`:3216-3218` 的 consecutive chain writes），中途失败会留下部分改绑，因此 **fallback 必须在任何写之前先解析**，解析不到就直接失败、一个需求都不改；重跑删除是幂等的（已改绑的需求不再属于引用集合）。

**归档的保护范围与可见性**：`archiveTemplate` 与删除同码保护 `config.defaultTemplateId`；显式 `templateId` 不接受归档模板（`create`/`update` 都报 `invalid-transition`），而 `getTemplate` 仍返回归档模板（面板要能看详情）；`listTemplates` 默认不含归档、`includeArchived: true` 才含（工具与面板同参）。`snapshot()` 直接复用 `listTemplates().items`（`host/service.js:3597`），归档对面板列表的可见性由这一处决定。

**`listTemplates` 的投影必须扩字段**：它逐字段枚举（`:2837-2852`），新字段要加进去才会到面板：`revision`/`updatedBy`/`archived`/版本条数随列表下发；`versions`/`changes` **不下发到快照**（每次 `changed` 帧都重读整份快照，历史版本与审计尾巴会让它变肥），只在 `getTemplate` 的完整记录里给。面板抽屉因此两步：`template.list` 拿列表与 `revision`，打开详情时 `template.get` 取版本历史与 `changes`。需求的钉住版本要随需求视图下发，而且**两处口径不同**：`listRequirements` **确定是**逐条经 `summarize`（`host/service.js:1455-1462` → `:268-309` 的手写对象字面量），所以 `templateRevision` 必须加进 `summarize`；而 `snapshot()` 的需求对象走 `getRequirement` → `#present` → `presentRequirement`，其 `...requirement` 展开（`:203`）会自动带上新字段。别只改一处。

`deleteTemplate` 保留为受控的硬删路径，补三处：拒绝删除 `config.defaultTemplateId` 指向的模板（`invalid-transition`，与内置同码）；改绑前先解析 fallback（解析不到就失败且不改任何需求）；`force` 改绑时为每个受影响需求写一条 `retemplate` 历史（note 记 `template <id> deleted → <fallback>`、`force: true`）。注意它与机制 1 的关系：追加版本不动需求，**删除会作废所有钉住的版本并改绑全部引用**，所以它仍是最重的动作——面板提示应优先引导用归档。

### 11.6 编辑对在跑需求的影响（规则表）

**在办**指 `status` 既不是 `done` 也不是 `archived`（即 §4.1 的 `open`，含 `blocked`）：门禁只看在办需求；而删除的引用集合仍是"所有 `templateId` 匹配的需求"（含 done/archived，现状 `host/service.js:3279`），因为删除会把它们一起改绑——两个集合的差别是有意的，不要合并。

**机制 1 把"改模板"和"动需求"彻底分开**：门禁只落在**会改变需求**的三个操作上（迁移、裁剪、删除）；追加版本与元数据编辑一律放行。

| 操作 | 对在办需求的影响 | 处理 |
|---|---|---|
| 追加版本 `reviseTemplate` | **无**（I3）：`nodeId`、节点状态、勾选原样；只有"仍钉旧版"的条数会被面板提示 | 放行 |
| 改绑到另一个模板 `updateRequirement{templateId}`（**现状已有**） | 按新模板重算节点、勾选项可能清空；**钉子必须重置为目标模板当前版**（11.4 的写入点②），否则旧版本号在新模板里找不到、该需求永久 `invalid-transition` | 已有路径、不新增门禁；但钉子重置要与 §11.5 同批改 |
| 改模板级名字/描述 `setTemplateMetadata` | 无（不改流程与进度） | 放行 |
| 迁移到新版 `migrateRequirementsToRevision` | 当前节点可能变、下一节点可能变；`checklist` 长度变化会清空该节点已勾选项（`host/flow.js:48-50`） | 必须先列出受影响需求；"全部迁移"需 `force` |
| 裁剪历史版本 `pruneTemplateVersion` | 被钉住即无法解析流程（I2） | 被钉住 → `in-use` + 清单；面板独有 |
| 归档 / 恢复 | 无（在用需求照旧按各自钉住的版本跑） | 放行；保护 `config.defaultTemplateId` |
| 删除模板 | 所有引用（含各钉住的版本）改绑默认模板并重算 | `force` + 清单 + 需求侧 `retemplate`（现状加强） |

判据统一为：**这个操作是否改变任一在办需求的"当前节点 id"或"下一节点 id"，或清空其已勾选项，或让被钉住的版本消失**——是则需要"先列清单（必要时 `force`）"，否则直接放行。

### 11.7 工具面、skill 与面板

- `flow_template` 增加 `revise` / `migrate` / `archive` / `clone`；**不加 `prune`**（事务性清理，面板独有）与 `preview`（理由见 11.5）。`TEMPLATE_PARAMETERS` 是 `additionalProperties: false`（`host/tools.js:108-130`），所以新参数走**平铺字段**、与现有 `create` 风格一致：`action` 枚举加这四个，参数面为 `id`/`name`/`description`/`nodes`/`expectedRevision`/`revision`/`requirementIds`/`force`/`archived`/`includeArchived`；**不引入嵌套 `patch` 对象**（那会同时改掉 `create` 的形状）。工具描述必须写清两件事：**`revise` 只是追加版本、不改任何需求**；**`migrate` 才会动需求、且要先看受影响清单**——否则模型会把 `revise` 当成"立即生效"而跳过迁移，用户会以为流程改了却没改。
- **工具面不加 `metadata` 动作**：模型要改模板名/描述就走 `revise`（追加版本）；`setTemplateMetadata` 只由面板调用。两侧语义不同是有意的——面板是人在改标签（不进历史），模型是在改流程（要留痕）。
- **工具面 `get` 必须投影掉 `versions`/`changes`**：`getTemplate` 今天返回原始记录（`host/service.js:2903-2904`），带上版本历史后会撞 `renderJson` 的 6000 字符截断（`host/tools.js:27-31`），而那句截断文案还指向别的工具（`read one requirement with action get`，`:31`；模板工具共用同一个 `renderJson`，`:352`）。模型侧 `get` 给"当前 `revision` + 当前节点 + 版本条数"，完整历史只走面板 HTTP `template.get`。
- 下游文本同步项：`ROLE-DISPATCH.md` §7.2 与**所有副本**的第 15 条（`.agents/skills/requirement-board-tasks/SKILL.md`、随包发布的 `skills/requirement-board-tasks/SKILL.md`、部署副本里那份）要改成"模板流程要改进时用 `revise` 追加版本（不动在跑需求），再把相关需求 `migrate` 过去；不要为避碎片化而新建模板"。仓库内三份（`ROLE-DISPATCH.md` §7.2、`.agents/skills/…` 与随包 `skills/…`）已随宿主侧落地同批改准；**部署副本里那份要等同步部署副本时一起更新**。
- 面板：把 `client.js:2977` 的"新建流程模板"扩展为模板抽屉——列表（内置标记、节点数、`revision`、`updatedAt`、在用需求数、**仍钉旧版的条数**）+ 详情（复用 §4.5 的 `FlowChart` 只读预览 + 版本历史列表，每条版本标"被几条需求钉住"）+ 编辑表单（节点增删改、前置、完成条件、checklist 行编辑；**保存＝追加版本**）+ 迁移对话框（列出受影响需求与各自变化，勾选要迁的）+ 归档/删除（删除要列引用需求）+ 裁剪（被钉住时禁用并显示原因）。编辑态留在客户端内存、不落盘，避免"半成品模板"被新需求选中。
- 新文案进 `client.js` 的两份 locale 字典（键集必须一致，`client-smoke` 有断言）。

### 11.8 失败码（沿用现有词汇，不新增）

`invalid-argument`（11.1 的结构规则；`prune` 的 `revision` 不合法也算）、`not-found`、`conflict`（`expectedRevision` 不符，与需求侧的 `expectedRev` 同义，`details = { expected, current }`）、`in-use`（两处：迁移未确认、裁剪被钉住；`details.requirements` 给需求清单，`details.affected` 逐条给 `{ id, nodeId, revision, next, clearedChecks }`——这就是模型在没有 `preview` 动作时判断代价的依据）、`invalid-transition`（内置不可改/删/归档、`config.defaultTemplateId` 指向的模板不可删/归档、把归档模板绑给需求、钉住的版本在 `versions` 里找不到）、`invalid-config`（fallback 解析不到，删除前先失败且一个需求都不改）。全集见 ROLE-DISPATCH.md §8.2，实现时同步 §3.3、§4.1–4.3、§9 与本节。

### 11.9 测试计划

- 结构校验红例逐条对应 11.1 的规则（超长 checklist、未知 `dependsOn`、成环、重名 id、节点数 0 与 51），沿用现有 `tests/*.mjs` 的 check 计数风格。
- **机制 1 的核心钉子**：`reviseTemplate` 之后，在跑需求的 `nodeId`、`nodes` 状态、`checks`、`history` **逐字段不变**；同时模板侧 `revision + 1`、`versions` 多一条、`changes` 多一条、`updatedAt` 前进。这是整节最该先写的一条断言。
- **钉住版本的解析**：当某需求钉在第 1 版、模板已到第 2 版时，`advance`/`complete`/快照 `flow` 都必须按**第 1 版**的节点推导（第 2 版新增或删除的节点对它无影响）；迁到第 2 版后才按第 2 版。反向红例：把某需求钉到一个已被裁剪的 `revision`，必须 `invalid-transition` 而不是静默取顶层。
- 迁移语义：当前节点不在目标版本 → 归一目标版本首节点 + 写 `retemplate`；`checklist` 长度变化 → 清空勾选；未指定 `requirementIds` 的"全部迁移" → `in-use` + 清单；逐条断言迁移后的节点与勾选。
- 裁剪门禁：被钉住 → `in-use` 且数据一个字节不改；无人钉住 → 成功且 `versions` 少一条；`revision` ≥ 当前或不在 `versions` 里 → `invalid-argument`。
- 元数据边界：`setTemplateMetadata` **不动** `revision` 与 `versions`，且不改任何需求的推导结果。
- 回归钉子：配置默认模板拒删（G4）；删除的 `force` 改绑写 `retemplate`（G5）。
- 模板侧留痕与可见性：`changes` 超过 20 条时保留最近 20（G3）；**没有需求被改动时也必须 `#bumpRevision`**，否则其它面板收不到 `changed`；`listTemplates` 的投影含 `revision`/`updatedBy`/`archived`/版本条数，`versions`/`changes` 只在 `getTemplate` 里；快照里能看到需求的 `templateRevision`。
- 读取容错与"只能前进"：一条没有任何新字段的旧记录要能读成"第 1 版、未归档、钉第 1 版"；同一份记录塞进未知字段后，当前 `.strict()` schema 必须拒绝——把这条只能前进的代价钉成可执行断言，而不是只写在文档里。
- 权限口径（G7，按 Q4 裁决）：断言模型可调用 `revise`/`migrate`/`archive`/`delete`（删除必定带引用清单与需求侧 `retemplate`），且**工具面没有 `prune`**、面板 HTTP 有。不要留中间态。
- 并发：两个编辑者用同一个 `expectedRevision` 追加，后者必须 `conflict`。
- 面板：`client-smoke` 覆盖新抽屉渲染与 `template.revise`/`template.migrate` 接线；真浏览器门（`tests/verification/panel-render.e2e.mjs`）覆盖迁移对话框、被钉住时裁剪禁用、以及版本历史列表。**`client-smoke` 用手工假渲染器，槽位与钩子契约只有真浏览器门守得住**（R-ROLLOUT.md §7 与 D33 的教训）。
- **写入语义（三条阻断的钉子）**：① 模板改到 v2 之后**新建**的需求，`templateRevision` 必须是 2 而不是 1；② 走 `updateRequirement{templateId}` 与 `deleteTemplate` 的 `force` 改绑之后，钉子必须等于目标模板的当前 `revision`，且随后 `advance`/`present` 不报 `invalid-transition`；③ 追加到第 21 个版本必须被拒（`invalid-transition`），且**被钉住的版本不会因为追加而消失**。
- **读侧解析点**：不逐处写断言（太笨重），改为**一条机械检查**——grep 出所有读顶层 `.nodes` 的函数，断言其调用方都经过 `templateAtRevision`；§11.4 那份点位清单可直接当起点。面板侧另断言列表与快照都能看到 `templateRevision`（`summarize` 加了、`presentRequirement` 自动透传）。
- **元数据分界**：`setTemplateMetadata` 只由面板调用（模型面没有 `metadata` 动作）；模型改名走 `revise` 会**追加一个版本**——两条断言。
- **修复口径**：直接写库把某需求的 `templateRevision` 改成不存在的版本（公开 API 到不了这个状态：裁剪被钉住即拒、迁移校验目标存在；`tests/harness.mjs:17-25` 暴露 `openBoardDomain`/`RequirementService`，可行），再开域，断言该需求被归一到当前版并留下 `retemplate`；`invalid-transition` 不该作为常规可见状态出现。
- **`retemplate` 的可辨性**：迁移写的历史 note 前缀与改绑不同（`migrated to revision <n> from <m>` vs `bound to template <id>`），断言两者可区分。
- 工具面：动作枚举的变化要有断言钉住（含"没有 `metadata`/`prune`/`preview`"），避免描述与实现漂移。

### 11.10 已裁决（2026-10-08，用户）

- **机制 1（追加版本、存量不动）**：改模板 ＝ 追加一个新版本，在跑需求一行不改；把需求迁到新版是独立动作。**已否决**"就地改模板"与"新增模板版本表"两种做法。
- **Q2 迁移门禁**：会改变在办需求的操作必须先列出受影响需求（"全部迁移"要 `force`）；改模板本身不拦。
- **Q3 归档**：加归档，作为硬删的常规替代路径。
- **Q4 权限**：模型可改、可归档、可删；删除必须带影响清单并在需求侧留痕。**裁剪历史版本留给面板**（不进工具面）。
- **Q5 面板形态**：表单 + 只读流程图预览（不做拖拽）。
- **一处设计细节（可推翻）**：模板级 `name`/`description` 原地改（不动 `revision`、不进历史），**只有节点数组的变动**才追加版本。若要求"连改名也要保留旧名"，改成一律追加版本即可。
- 本条裁决记入 LEAD-DECISIONS.md **D34**。看板上以 `req_c2c26f95db` 呈现给人拍板。
- **评审补丁（同日，只读独立评审）**：三条阻断与五条应修已并入上文——新建需求要写当前版本（11.4 写入点①）、两条改绑路径要重置钉子（写入点②）、`versions` 溢出拒绝而非丢最旧（11.4）；读侧解析点改成可 grep 的规则并附点位清单（11.4）、`listRequirements` 确定走 `summarize` 需一并加（11.5）、裁剪的"被钉住"判定沿用删除的引用集合且归档模板一律拒（11.5）、模型侧改名走 `revise`（11.7）、钉子悬空时开域修复（11.4）；四条可选项也分别落进 11.4/11.5/11.7/11.9。

**不在本节范围**：模板的导入导出与跨部署共享、模板级权限（RBAC）、模板继承与组合。
