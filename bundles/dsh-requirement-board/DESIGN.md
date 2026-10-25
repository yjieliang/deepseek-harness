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
| `project` | `string`? | **项目标签**（≤60，可选）：需求归属的那摊活，面板据此筛选与分组；缺省读作 `''` = 不归属任何项目 |
| `kind` | `'task'\|'decision'`? | 缺省读作 `task`；`decision` 是人类专属（3.6 与 ROLE-DISPATCH.md §5.7） |
| `priority` | `'low'\|'normal'\|'high'\|'urgent'` | 自身优先级，默认 `normal` |
| `owner` | `string` | 负责人，可为空 |
| `role` | `string`? | 路由到的角色 id，`''` = 公共任务 |
| `sessions` | `string[]` | 所属会话；创建时自动并入创建者会话 |
| `parentId` | `string\|null`? | 父需求 |
| `blocksOn` | `string[]`? | **我声明的前置**（我依赖谁）；`blockedBy`/`gated` 是它的在线派生 |
| `labels` | `string[]` | 自由标签 |
| `images` | `ImageRef[]`? | 粘贴图片的**引用**；编码后的字节在记录之外（4.3 的路由与 §8 的 `imageDir`），缺省读作 `[]` |
| `options` | `{ id, prompt, choices: { id, label, detail?, recommended? }[] }[]`? | 结构化题面：≤6 题、每题 2–8 个选项、每题最多一个 `recommended`；题目 id 默认 `q1`…、选项 id 默认 `A`…；**有人作答后冻结**（ROLE-DISPATCH.md §5.7），缺省读作 `[]` |
| `answer` | `Record<questionId, choiceId>`? | **人专属**：面板上选出的答案，可部分作答；`decide` 命令是唯一写入口；缺省读作 `{}` |
| `answerNote` / `answeredAt` | `string`? / `ISO`? | 人选完附的一句理由（≤500）与最近作答时刻 |
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
`project` 与 `summary` 走同一条可选字段惯例（`schemaVersion` 仍为 2，旧记录读作 `''`），但**写入规则相反**：
`summary` 的空值被拒（补上就再也清不掉），`project` 的空值是合法写入——把需求摘出项目是一个正常请求，
所以 `update` 传 `''` 就是"从项目里拿出来"。项目**不是一级实体**：没有项目记录、状态、负责人或进度，
`project` 的全部含义就是这个字符串；面板的筛选、分组、表单候选都由它派生，没有第二份真相。

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
`durationMs` 是"在上一个节点停留了多久"，节点耗时统计直接聚合它。它是**停留**而非**工作**时长：
节点在 `create`（或上一次换节点）时就盖了 `enteredAt`，原地 `claim` 不重置它，所以没人接单的那段等待
也计入 `avg`/`min`/`max`；进度视图的耗时表头下有一行 `durationHint` 把这一点写给读者（面板口径不改，
"停留多久"也正是 `stalled` 判定的同一根时间轴）。

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
| `listRequirements(filter, me)` | 过滤 `session`/`owner`/`status`/`priority`/`kind`/`role`/`templateId`/`project`/`query`/`claimable`/`limit`（`status:'open'` = 未完成且未归档）；`project` 是**三态**：缺省/`null` = 不过滤，`''` = 只要不归属任何项目的，其余值 = 只要该项目；返回 `{ items, total, limit, offset }`；`claimable` 与 prompt 同源 |
| `getRequirement(id, me)` | 单个需求的完整派生视图（`flow`/`progress`/`history`/`lastTransition` + 3.6 的资格、门禁、执行字段） |
| `createRequirement(input, actor)` | 建需求；`summary` **必填**（空/缺 → `invalid-argument`，错误文案说明"一两句大白话"要求），`sessions` 自动并入调用者会话，节点跳到模板首节点，`requestedBy` 定格；`images` 传图片 id 列表（未知 id 报 `invalid-image`，不是静默丢弃）；`options` 传结构化题面（形状与上界见 4.1 字段表，非法即 `invalid-argument`，传 `[]` 等于没问）；`project` 可选（≤60，缺省 `''`） |
| `claim(id, input, actor)` / `release(id, input, actor)` | 拿锁 / 放锁；`claim` 走 `judgeClaim` 判定表，`locked` 时若该需求在自己队列里则 `details.queued:true` |
| `queue(id, input, actor)` / `unqueue(id, input, actor)` / `queueOf(session)` | 软预留：追加/移除/读取本会话队列（`queue` 需要非空会话；面板用 `unqueue{targetSession}` 清任意会话） |
| `delegate(id, input, actor)` | 派给子会话（`session` 指名目标）；`revoke:true` 撤销；同一套收尾见 ROLE-DISPATCH.md §5.5 |
| `updateRequirement(id, patch, actor)` | 改 `title`/`summary`/`project`/`description`/`priority`/`owner`/`labels`/`sessions`/`templateId`/`role`/`parentId`/`blocksOn`/`images`/`options`；决策的合法子集更窄（含 `options`，不含 `answer`）；`kind` 不可变；写 `summary` 走同一条 `asSummary`（空值同样被拒），写 `project` 走 `asProject`（空值合法 = 摘出项目）；已有选择时改题面报 `conflict{answered-options}`，同一份题面重发不算改动 |
| `decideRequirement(id, { answer, note, expectedRev }, actor)` | **只由面板调用**（非空 `session` 一律 `forbidden{human-only}`）：把 `{题目id: 选项id}` 并入 `answer`、记 `answeredAt`（`note` 非空则写 `answerNote`），追加一条 `decide` 历史；追加后若该决策所有题都已作答，再走一次 `transition{complete}` 收尾。没有题面 → `invalid-argument{no-options}`；题/选项不存在 → 带 `questionId`/`questions`/`choices` 的 `invalid-argument` |
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
| `snapshot(filter, me)` | `{ revision, generatedAt, requirements, total, templates, roles, stats, queues, projects }`；`projects` 是**全板**用到的项目名（不受 `filter` 影响）——面板的筛选、分组与表单候选都读它；若跟着筛选走，一筛就把"换回别的项目"的路也筛没了 |
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
| `GET /snapshot?status=&owner=&session=&priority=&kind=&role=&templateId=&project=&query=&claimable=&limit=&offset=&me=` | 面板初始数据与增量刷新；`me` 是会话 id（不是角色名）。`project` 是唯一**不能**靠"空值即省略"表达三态的键：路由在 `compact()` 丢掉空字段之后单独接上它，所以 `?project=`（空值）是"只要未归属"，整个键缺席才是"不过滤" |
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
| `node tests/domain.mjs` | 154 项：域表单与 zod 校验、`invalid-record`、导入幂等与凭据、`nextRevision` 自愈、两种后端一致、可选字段的向后兼容（简述必填且不可清空、项目可填可清） |
| `node tests/smoke.mjs` | 106 项：模板派生与环检测、完成条件闸门、推进/回退/跳转、乐观并发（含 HTTP 命令路径）、阻塞、统计、HTTP 分发、prompt 上下文、changes、重开进程、模板生命周期、简述与项目的写入与筛选 |
| `node tests/roles.mjs` | 298 项：解析链三态、四种建档来源、`human` 保留字、`dutiesMissing`、prompt 角色行、未登记角色的两种来源、启动 sweep、预设名册对照（活会话/推定/非法 id 三态与 `recorded` 拆分）与两种降级 |
| `node tests/dispatch.mjs` | 322 项：`lockState` 全分支、`claimable`/`advanceable` 单一公式、判定表、租约与孤儿锁、并发抢锁、每会话一把锁 |
| `node tests/queue.mjs` | 304 项：软预留追加幂等、上界、他人 `claim` 得 `reserved`、队头 `queued:true` 分支、并发恰一胜、dispose 与面板清预留 |
| `node tests/delegate.mjs` | 372 项：临时角色铸造与绑定、幂等收编、`roleBefore` 回退、归属校验（`owns` 三态 + 会话头判定）、派发期间禁改路由、写被拒收回临时角色、撤销与 dispose 同一套收尾、链式再派发 |
| `node tests/decision.mjs` | 228 项：`kind` 不可变、人类专属 12 条拒绝与两入口分解、决策不进任何池、`requestedBy` |
| `node tests/options.mjs` | 130 项：题面形状与上界、id 默认与去重、人的作答（面板命令）、人专属（服务/命令/工具三面拒绝、答案不进 `update`）、答完最后一题自动收尾、已有选择后题面冻结、改选留新历史、`expectedRev` 乐观并发、没有字段的旧记录仍可读且重开后选择仍在（json+sqlite 双跑） |
| `node tests/gates.mjs` | 246 项：`blocksOn`/`parentId` 环检测、门禁拒绝与 `force` 越权、优先级继承与回落、归档仍挡、`delete` 解绑 |
| `node tests/runs.mjs` | 312 项：子智能体与 job 事件落库、无锁事件 `ignored`、重复状态不写、`output` 不落库、截断、`sync.gap`、不推 `rev` |
| `node tests/client-smoke.mjs` | 535 项，浏览器半边：桩掉 module loader / React / 客户端服务 / `fetch` / `EventSource`，真实渲染并驱动交互；校验字典键对齐、插槽注册、SSE 生命周期、几何反推依赖图列与边、角色来源标签、预设对照区与一键登记预填、登记后重读名册（该行翻面）、名册两种降级文案、简述与项目读法（卡片标签、详情、筛选三态上线、按项目分组） |
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

- 写入面（2026-10-09 起）：`createTemplate`（`host/service.js:2954`）、`reviseTemplate`、`setTemplateMetadata`、`migrateRequirementsToRevision`、`pruneTemplateVersion`、`archiveTemplate`、`cloneTemplate` 与 `deleteTemplate`（`host/service.js:3313`）；工具 `flow_template` 有 `list`/`get`/`create`/`revise`/`migrate`/`archive`/`clone`/`delete` 八个分支（`host/tools.js:378-404`），**不含** `prune`/`metadata`/`preview`；面板命令 `template.*` 见 `host/http.js:292-320`。
- 结构校验集中在 `normalizeTemplate`（`host/templates.js:137`）：`name` 必填 ≤120（`:141`）；`nodes` 1..50（非空 `:143-145`、上界 `:146`）；节点 id 缺省由名称派生（slug 保留 CJK、重名加 `-2`，`:83`），显式 id ≤64（`:106`）、重名即 `invalid-argument`（`:107`）；`dependsOn` ≤20 项、每项 ≤64（`:119`）、必须指向本模板已有节点（`:152`）、不得自环（`:154`）、装载时做环检测（`:180`）；`completion.type ∈ manual|checklist`（`host/model.js:33`）；`checklist` ≤20 项、每项 ≤160（`:114`）；`description` ≤600（`:121`，模板级同值在 `:161`）；`assignee` ≤120（`:120`）。
- 那份 `version` 仍恒为 1（`host/templates.js:162`）；创建时写入的 `updatedAt`（`host/service.js:2959` 传入的 `now`）此后由每个写路径刷新——**版本管理的版本号是新增的 `revision` 字段，与 `version` 无关**（§11.4）。
- 内置 `tpl-standard` 不可删（`host/service.js:3316`），空库时种下（`host/domain.js:516-518`）。
- 模板与需求的耦合：需求存 `templateId`，节点状态是**按位置推导**的派生数据（`host/flow.js:41-46`：`index < currentIndex → done`、`index === currentIndex → active`）；当前节点不在模板里（`nodeIndex < 0`）时不会有任何节点是 `active`。
- 改绑已有路径：`updateRequirement` 把 `templateId` 当结构性字段（需要锁，`host/service.js:195`、`:2395-2396`），改绑后重算节点并写一条 `retemplate` 历史（`:2422-2439`、`:2452-2453`）。
- 删除被占用的模板：需 `force`，否则 `in-use` 并列出引用它的需求 id（`host/service.js:3320-3322`）；`force` 时逐个改绑到 `config.defaultTemplateId`，消失的当前节点重置为该模板首节点（`:3245-3268`）。
- 模板的增删改**不写需求 `history`**（§3.4 的 `action` 词汇表里没有模板动作）；`changesSince`（`host/service.js:3602`）同样只回需求与流转（`:3541`）。

### 11.2 缺口

**截至 2026-10-09 的闭合状态**：G1–G5、G7 已随宿主侧落地闭合——追加版本（`revise`）、`revision`/`versions`/`changes` 与 `expectedRevision` 提供版本与并发判据、模板侧留下 `changes`+`updatedBy` 且 `deleteTemplate` 收 `actor`、删除保护 `config.defaultTemplateId`、`force` 改绑经 `#retemplateEntry` 写 `retemplate(force:true)` 留痕、模型可改可归档可删而 `prune` 只在面板。**G6 也已闭合**：面板侧随本轮落地（模板抽屉、只读流程预览、版本历史、迁移对话框，`client.js` 已接线）。下面各条保留为"当时为什么算缺口"的记录，其中的现在式说法（如"只拒内置""不写 history""没有更新动作"）已被上面的状态取代。

- **G1 不能编辑**：改名、改节点、改完成条件只能"删了重建"，而删除会把在办需求整体改绑到默认模板并丢掉节点进度——"改一个字"的代价与"换掉整个流程"相同。
- **G2 版本字段是死的**：`version` 恒 1、`updatedAt` 只在创建时写（11.1），既无法表达"模板已演进"，也没有并发判据。
- **G3 没有审计**：模板的增删改不落在任何历史里；`deleteTemplate` 连 actor 参数都没有（`host/service.js:3313`），模板侧只有创建时写的 `createdBy`。
- **G4 删除不保护配置默认模板**：`deleteTemplate` 只拒内置（`:3237`）。若 `config.defaultTemplateId` 指向非内置模板，删掉它之后新建需求的默认模板解析（`:1532-1534`）会撞上 `#template` 的 `not-found`（`:491-497`），`force` 改绑的落点（`:3246`）也会一起取不到。
- **G5 `force` 改绑不留痕**：删除时对每个需求只改字段，transform 没有追加 `history` 条目（`:3257-3267`；`#mutateRequirement` 的签名 `host/service.js:1131` 也没有历史参数），需求侧看不到"我的流程什么时候被换了"。
- **G6 面板只有"新建"**：无编辑、无删除接线、无引用可见性、无流程预览（`client.js:2245` 的 `CreateTemplateDialog`、`:2977` 的入口按钮、`:3139` 的 `template.create` 接线；`template.delete` 有宿主路由但没有客户端调用）。
- **G7 权限口径不一致**：角色管理是"面板独有"（`host/service.js:3404`、`host/http.js:324-328`），模板却是模型可写（`host/tools.js:378-404`），既不要锁也没有角色约束。

### 11.3 不变量

- **I1 节点 id 是身份，名称只是标签**：改节点名不改 id；改 id 等价于"删旧节点 + 加新节点"，必须在追加的那个版本里显式表达。
- **I2 需求永远钉在一个仍然存在的版本上**：需求用可选字段 `templateRevision`（11.4）记住自己跑在哪一版；**新写入一律显式带这个字段**，只有本次改动之前写入的存量记录才读作第 1 版（三个写入点见 11.4）。**任何被需求钉住的版本都不得被裁剪**——裁剪时必须拒绝并列出钉住它的需求（11.6），否则那条需求的流程无从解析。
- **I3 改模板不改任何需求**（机制 1 的核心承诺，2026-10-08 裁决）：追加版本只写模板记录一个键，**完全不碰 `requirements`**；在跑需求的 `nodeId`、节点状态、已勾选项一律原样。
- **I4 只有显式迁移才会动需求，且必须事前可见**：迁移到新版时，若某需求当前的 `nodeId` 不在目标版本里，按既有先例归一到目标版本的首节点（`host/service.js:3339`、`:2434`）并写一条 `retemplate` 历史（note 记 `node <旧> 已不在第 N 版 → <新>`，沿用 §3.4 既有词汇、不新增动作）；`checklist` 长度变化会清空该节点的已勾选项（`host/flow.js:48-50`）。迁移前必须能列出"哪几条受影响、各自会变成什么样"。
- **I5 破坏性动作必须留痕**：需求侧写 `retemplate`（含 `force` 与原因），模板侧写自己的 `changes`（11.4）。
- **I6 内置模板不可改、不可删、不可归档**：要改内置流程就 `clone` 出一个自定义模板，再改那个副本（11.5）。

### 11.4 数据模型（已裁决：机制 1——追加版本；不新建表、不升域版本号）

**模板记录**（`host/domain.js:306` 的 `templateRecordSchema`，`.strict()`）：顶层字段仍是"最新版"，读法与今天同构；只**新增可选字段**。

- `revision`（正整数，当前版本号；缺省读作 1）。
- `versions`（**历史版本**数组，从旧到新，**当前版不在其中**；有界，上限 20 条——它是审计尾巴、不是运行参数，所以不进 `Config`，与可配的 `maxExecutions` 不同）：每项 `{ revision, at, by, name, description, nodes, summary }`。**溢出策略是拒绝，不是自动丢最旧**：追加第 21 个版本时报 `invalid-transition`（提示先裁剪旧版本）。这与 `maxExecutions` 那种"超限丢最旧并标 `executionsTruncated`"（`host/config.js:70-72`、`host/domain.js:250`）**故意不同**——执行观测丢了无所谓，模板版本丢了就违反 I2。
- `archived`（布尔）、`updatedBy`、`supersedes`（`cloneTemplate` 的来源模板 id）。
- `changes`（`{ at, by, revision, summary }` 的有界数组，上限同上）。`summary` 由服务端按 diff 生成（`改名 A→B`、`+节点 C`、`-节点 D`、`依赖 D→E`、`checklist 2→3`），面板直接展示。

**需求记录**（`host/domain.js` 的 `requirementRecordSchema`）新增可选字段：`templateRevision`（正整数，钉住所用模板版本）。**三个写入点必须一起改，缺一处机制 1 就自相矛盾**：① **新建时写当前版本**——`createRequirement` 的记录字面量今天只有 `templateId`/`nodeId`（`host/service.js:1635-1641`），必须补 `templateRevision = template.revision ?? 1`，否则模板改到 v2 之后新建的需求会被读成钉在 v1、继续跑旧流程（与机制 1 的意图正相反）；② **两条改绑路径必须重置钉子**——`updateRequirement{templateId}`（`:2422-2439`）与 `deleteTemplate` 的 `force` 改绑（`:3245-3268`）都要把钉子写到**目标模板的当前 `revision`**，否则旧版本号在新模板里找不到，该需求会永久 `invalid-transition`（present/advance 全废），或撞上新模板同号版本而静默用错版本；③ **"缺省读作 1"只适用于本次改动之前写入的存量记录**，新写入一律显式带字段。

**为什么不用升版本号**：`version`（schema 必填、恒 1，`host/templates.js:162`）是历史遗留字段，不承担管理语义；**管理版本是 `revision`**。存档格式**不升** `requirementBoardDomain.version`（现为 2，`host/domain.js:370`）：这套介质按精确版本戳校验且没有迁移（§3.1），升号会让现有库整库打不开——**sqlite 对版本戳做精确比较且完全不看 `compatibleVersions`**（`packages/storage/storage-sqlite/src/index.ts:100-110`），JSON 整单元格式同样直接拒绝（`packages/storage/storage-json/src/format.ts:66-71`），而 `compatibleVersions` 只对 per-record 文档生效（`packages/storage/storage-json/src/per-record-unit.ts:106`）；看板没声明 `layout`，默认就是 `single`（`packages/storage/storage-domain/src/spec.ts:41-47`）。加**可选字段**不升版本号——代码里有现成先例：`images` 就是后加的，`host/domain.js:22-26` 明确写了那次为什么不升。代价是这次改动**只能前进不能后退**：新版本写过的记录带新字段，旧构建的 `.strict()` schema 会拒绝打开；回滚必须连数据一起回（口径同 R-ROLLOUT.md §9.1 的备份/回滚）。

**存量数据零迁移**：现有模板没有 `revision`/`versions` → 读作"第 1 版、无历史"；现有需求没有 `templateRevision` → 读作"钉在第 1 版"。两者都自洽，**不需要任何回填写入**；首次追加版本（`revision` 2）时才把当时的顶层字段快照进 `versions`。

**读侧解析点**：所有"拿模板节点去推导"的地方都要改成"取该需求钉住的那一版"——`advance`/`complete` 的节点判定、`recomputeNodes`、快照的 `flow` 投影、prompt 段，都要先经一个 `templateAtRevision(template, revision)`：`revision === 当前 revision` 取顶层，否则在 `versions` 里找，找不到即 `invalid-transition`（说明 I2 的裁剪门禁被绕过）。这是本节改动面最大的一处。**规则可 grep：任何接收 `template` 并读顶层 `.nodes` 的函数，其调用方都必须先经 `templateAtRevision`**；已知点位（实现时以此为准，并再 grep 一遍 `.nodes`）：`host/service.js:230-275`（`buildFlow`/`presentRequirement`，即快照 `flow` 投影的本体）、`:268-309`（`summarize` 的 `nodeName`/`nodeIndex`/`nodeCount`）、`:3619-3627`（prompt 段的节点名）、`:2422-2439` 与 `:3245-3268`（两条改绑路径）、`host/flow.js:139-143`/`:173`/`:179-191`/`:231-233`/`:254`、`host/templates.js:273`/`:286-289`/`:298-299`。

**钉子指向不存在的版本时的修复口径**：与既有的启动 sweep `sweepDangling()`（DESIGN §4.1:189）同路——**开域时修复**：把该需求的钉子归一到当前 `revision`、按 I4 归一节点并写一条 `retemplate`（note 记 `pinned revision <n> missing → <m>`），用户可见行为是"这条需求被打回最新版"，而不是永久打不开。B2 修好之后，这个状态只可能来自外部直接改库，所以修复是兜底、不是常规路径。

### 11.5 服务 API（拟议；权限与门禁按 11.10 的裁决）

| 方法 | 语义 |
|---|---|
| `reviseTemplate(id, patch, actor)` | **追加一个版本**。`patch = { name?, description?, nodes?, expectedRevision? }`；内置拒绝（`invalid-transition`，I6）；节点结构复用 `normalizeTemplate`（`host/templates.js:137`）校验；`expectedRevision` 不符 → `conflict`；成功后 `revision + 1`、把旧顶层快照推进 `versions`、`changes` 追加一条摘要、写 `updatedBy`/`updatedAt`、**显式 `#bumpRevision()`**；**不碰任何需求**（I3）；返回模板派生视图（含"仍有 N 条钉在旧版"——这是信息，不是门禁）。**模型侧要改模板名/描述就走这个动作**（即追加一个只改名字的版本；工具面没有 `metadata`，见 11.7） |
| `setTemplateMetadata(id, { name?, description? }, actor)` | **原地改**模板级名字/描述：不动 `revision`、不进历史（它不改变任何需求的流程与进度）。内置拒绝。这条划定了"元数据 vs 结构"的分界线：**节点数组的任何变动一律走 `reviseTemplate`**。**只由面板调用**（模型侧改名走 `revise`，见 11.7）。`versions` 每项记的是"当时顶层的名字"，所以原地改名之后历史版本的名称与顶层会不一致——这是有意的（历史版本记当时的实况） |
| `migrateRequirementsToRevision(id, revision, { requirementIds? }, actor, force?)` | 把钉在旧版的需求迁到 `revision`（缺省最新版）。**必须事前列出受影响需求**：逐条给 `{ id, nodeId, next, clearedChecks }`；未指定 `requirementIds` 即"全部钉在旧版的需求"，此时必须带 `force`；目标 `revision` 必须存在（等于当前版或落在 `versions` 里），归档模板同样拒绝（`invalid-transition`）；每条改动写 `retemplate` 历史（I4），**note 用可辨前缀**（迁移记 `migrated to revision <n> from <m>`，与今天改绑的 `bound to template <id>`（`host/service.js:2532`）区分）——`action` 沿用 `retemplate` 足够，`host/domain.js:83-92` 的 `action` 是开放非空字符串 |
| `pruneTemplateVersion(id, revision, actor)` | 裁剪一个历史版本。`revision` 必须 < 当前且存在于 `versions`；**被钉住即拒绝**（`in-use` + 需求清单，I2）；**判定集合与删除的引用集合相同**——所有 `templateId` 匹配的需求，含 done/archived（`host/service.js:3320`），只看在办会漏掉归档需求，它们下次 open 就不可解析。**面板独有**，不进工具面（11.7） |
| `archiveTemplate(id, { archived }, actor)` | 归档/恢复。内置拒绝（I6）；归档后不出现在"新建需求"的选择器里，但 `listTemplates({ includeArchived: true })` 可见；被引用仍可归档（它仍是那些需求的当前流程）；保护 `config.defaultTemplateId` |
| `cloneTemplate(id, { name }, actor)` | 以现有模板（含内置、按当前版）为底新建自定义模板，`supersedes` 记来源 id——改内置流程的正路（I6） |
| `previewRevisionImpact(id, patch)` | **只读**：算出"若按这个 patch 追加版本，哪些需求仍钉在旧版、若迁移各自会变成什么样"，供面板确认对话框用。**工具面不加 `preview` 动作**：模型从 `migrate`/`prune` 失败的 `details`（11.8）拿同一份明细——两侧同源 |
| `setDefaultTemplate` | **不做**：`defaultTemplateId` 是部署配置（§8），不是运行时可改状态；但删除与归档必须保护它（G4） |

**`patch.nodes` 是完整的目标节点列表（全量替换，不做增量合并）**：带 `id` 的条目按 id 更新，不带的按创建规则派生 id（`host/templates.js:83`），`id` 未出现在新数组里的节点即被删除。这样"删节点 + 改依赖"在同一次 patch 里完成、不需要两步，也没有合并语义的二义性；代价是调用方必须回传整份节点（面板表单本来就持有整份）。

**并发判据**：`expectedRevision` 指模板记录**当前**的 `revision`（不是文档 `global.revision`，也不是需求的 `rev`）；缺省即不做 CAS（与需求侧 `#mutateRequirement` 的缺省语义一致，`host/service.js:1124`），不符时报 `conflict` 并给 `details = { expected, current }`（同需求侧写法 `:1069-1072`）。追加是唯一会撞车的地方：两个编辑者同时追加，后者必须 `conflict`，而不是悄悄把版本推成 3。

**字段保全**：`normalizeTemplate` 仍用来校验并塑造**新版本的** `name`/`description`/`nodes`，但落盘记录必须显式带回 `id`/`createdAt`/`builtin`/`createdBy`/`archived`/`changes`/`supersedes`，并自行把旧顶层推进 `versions`、`revision` 取旧值 +1。直接照搬它的返回值落盘会静默重置 `createdAt`（`host/templates.js:164` 的 `input.createdAt || now`）并丢掉 `createdBy`（`host/service.js:2960` 是在它之外补写的）。

**必须显式 `#bumpRevision()`**：`createTemplate`（`:2883`）与 `deleteTemplate`（`:3271`）都调它，而 `#mutateRequirement` 只在被走到时才 bump（`:1085`）。追加版本、改元数据、裁剪都可能完全不经过需求写路径——不补这一步，其它打开的面板收不到 `changed`。

**HTTP 命令名**（现状见 §4.3 的 `template.*`）：新增 `template.revise` / `template.metadata` / `template.migrate` / `template.prune` / `template.archive` / `template.clone` / `template.get`。

**默认模板的解析与保护（G4 与存量坏配置）**：写侧——`deleteTemplate` 与 `archiveTemplate` 都拒绝对 `config.defaultTemplateId` 指向的模板动手（`invalid-transition`）。读侧——省略 `templateId` 时的解析链为 `config.defaultTemplateId` → 内置 `tpl-standard` → `templates` 表首个记录，仍无则 `not-found`（保持 loud）。这条链兜住已经坏掉的存量配置：`deleteTemplate` 自述非事务（`:3216-3218` 的 consecutive chain writes），中途失败会留下部分改绑，因此 **fallback 必须在任何写之前先解析**，解析不到就直接失败、一个需求都不改；重跑删除是幂等的（已改绑的需求不再属于引用集合）。

**归档的保护范围与可见性**：`archiveTemplate` 与删除同码保护 `config.defaultTemplateId`；显式 `templateId` 不接受归档模板（`create`/`update` 都报 `invalid-transition`），而 `getTemplate` 仍返回归档模板（面板要能看详情）；`listTemplates` 默认不含归档、`includeArchived: true` 才含（工具与面板同参）。`snapshot()` 直接复用 `listTemplates().items`（`host/service.js:3638`），归档对面板列表的可见性由这一处决定。

**`listTemplates` 的投影必须扩字段**：它逐字段枚举（`:2837-2852`），新字段要加进去才会到面板：`revision`/`updatedBy`/`archived`/版本条数随列表下发；`versions`/`changes` **不下发到快照**（每次 `changed` 帧都重读整份快照，历史版本与审计尾巴会让它变肥），只在 `getTemplate` 的完整记录里给。面板抽屉因此两步：`template.list` 拿列表与 `revision`，打开详情时 `template.get` 取版本历史与 `changes`。需求的钉住版本要随需求视图下发，而且**两处口径不同**：`listRequirements` **确定是**逐条经 `summarize`（`host/service.js:1494-1501` → `:268-309` 的手写对象字面量），所以 `templateRevision` 必须加进 `summarize`；而 `snapshot()` 的需求对象走 `getRequirement` → `#present` → `presentRequirement`，其 `...requirement` 展开（`:203`）会自动带上新字段。别只改一处。

`deleteTemplate` 保留为受控的硬删路径，补三处：拒绝删除 `config.defaultTemplateId` 指向的模板（`invalid-transition`，与内置同码）；改绑前先解析 fallback（解析不到就失败且不改任何需求）；`force` 改绑时为每个受影响需求写一条 `retemplate` 历史（note 记 `template <id> deleted → <fallback>`、`force: true`）。注意它与机制 1 的关系：追加版本不动需求，**删除会作废所有钉住的版本并改绑全部引用**，所以它仍是最重的动作——面板提示应优先引导用归档。

### 11.6 编辑对在跑需求的影响（规则表）

**在办**指 `status` 既不是 `done` 也不是 `archived`（即 §4.1 的 `open`，含 `blocked`）：门禁只看在办需求；而删除的引用集合仍是"所有 `templateId` 匹配的需求"（含 done/archived，现状 `host/service.js:3320`），因为删除会把它们一起改绑——两个集合的差别是有意的，不要合并。

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

- `flow_template` 增加 `revise` / `migrate` / `archive` / `clone`；**不加 `prune`**（事务性清理，面板独有）与 `preview`（理由见 11.5）。`TEMPLATE_PARAMETERS` 是 `additionalProperties: false`（`host/tools.js:112-134`），所以新参数走**平铺字段**、与现有 `create` 风格一致：`action` 枚举加这四个，参数面为 `id`/`name`/`description`/`nodes`/`expectedRevision`/`revision`/`requirementIds`/`force`/`archived`/`includeArchived`；**不引入嵌套 `patch` 对象**（那会同时改掉 `create` 的形状）。工具描述必须写清两件事：**`revise` 只是追加版本、不改任何需求**；**`migrate` 才会动需求、且要先看受影响清单**——否则模型会把 `revise` 当成"立即生效"而跳过迁移，用户会以为流程改了却没改。
- **工具面不加 `metadata` 动作**：模型要改模板名/描述就走 `revise`（追加版本）；`setTemplateMetadata` 只由面板调用。两侧语义不同是有意的——面板是人在改标签（不进历史），模型是在改流程（要留痕）。
- **工具面 `get` 必须投影掉 `versions`/`changes`**：`getTemplate` 今天返回原始记录（`host/service.js:2944-2945`），带上版本历史后会撞 `renderJson` 的 6000 字符截断（`host/tools.js:27-31`），而那句截断文案还指向别的工具（`read one requirement with action get`，`:31`；模板工具共用同一个 `renderJson`，`:352`）。模型侧 `get` 给"当前 `revision` + 当前节点 + 版本条数"，完整历史只走面板 HTTP `template.get`。
- 下游文本同步项：`ROLE-DISPATCH.md` §7.2 与**所有副本**的第 15 条（`.agents/skills/requirement-board-tasks/SKILL.md`、随包发布的 `skills/requirement-board-tasks/SKILL.md`、部署副本里那份）要改成"模板流程要改进时用 `revise` 追加版本（不动在跑需求），再把相关需求 `migrate` 过去；不要为避碎片化而新建模板"。仓库内三份（`ROLE-DISPATCH.md` §7.2、`.agents/skills/…` 与随包 `skills/…`）已随宿主侧落地同批改准；**部署副本里那份要等同步部署副本时一起更新**。
- 面板：把 `client.js:3065` 的"新建流程模板"扩展为模板抽屉——列表（内置标记、节点数、`revision`、`updatedAt`、在用需求数、**仍钉旧版的条数**）+ 详情（复用 §4.5 的 `FlowChart` 只读预览 + 版本历史列表，每条版本标"被几条需求钉住"）+ 编辑表单（节点增删改、前置、完成条件、checklist 行编辑；**保存＝追加版本**）+ 迁移对话框（列出受影响需求与各自变化，勾选要迁的）+ 归档/删除（删除要列引用需求）+ 裁剪（被钉住时禁用并显示原因）。编辑态留在客户端内存、不落盘，避免"半成品模板"被新需求选中。
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

---

## 12. 角色管理交互（并排两栏 · 表单弹窗 · 逐条职责 · 就地删除 · 检索 · 未保存处置）

**状态（2026-10-10）**：规格定稿于本节（看板 `req_0a88e9eed7`）；实现与两门读数在 §12.7 回填。规格的选择依据是看板需求里由用户 2026-10-10 指定的两条硬约束——角色管理与预设模式管理**左右并排**、新建角色**走弹窗**——本节只把它们落成可实现的形态，不改已统一的视觉语言（`UI-REDESIGN.md`）。

### 12.1 现状（实测，2026-10-10 评审复核）

| 摩擦点 | 实测位置 | 表现 |
|---|---|---|
| 表单位置 | `client.js:2329`（`draft !== null` 插在 Dialog body 最前），列表在其后 `:2362-2369` | 点下方某行的「编辑」后要回到顶部找表单；行本身不带任何"正在编辑"标记 |
| 职责是逗号文本 | `:2181` `join(', ')`、`:2189` `split(',')`、`:2341` 单个 `Input` | 不能逐条增删；职责本身不能含逗号；12 项/40 字上界只写在标签里、无就地校验 |
| 删除确认在末尾 | `:2371`（在 `rosterSection()` `:2370` 之后） | 与发起删除的行不相邻；列表长时确认块落在视野外 |
| 单滚动体、无检索 | `:2362-2370` 三段平铺在一个 body 里 | 只有「未登记」有区块标题；无检索、无计数；角色一多只能滚 |
| 失败与丢输入 | 失败经 `run` `:4706-4717` → `controller.notify` → `shell.overlay` 的 app toast `:5310-5316`（在模态遮罩之下）；关窗 `:2322`、切换编辑对象 `:2178` 直接覆盖 `draft` | 失败原因与发起处无位置关系；未保存内容静默丢弃 |

写侧上界是 Host 明文，面板要与之一致：`host/model.js:283-296`（`roleId` 须匹配 `ROLE_ID_RE` = `^[a-z][a-z0-9_-]{0,31}$`、`roleName` ≤ 40、`duties` ≤ 12 项 × ≤ 40 字），`host/model.js:172-185`（空项丢弃、重复项保留首次出现）。

### 12.2 形态决定

**D1 并排两栏。** 角色管理对话框改用新宽度类 `.rb-dialog-roles { width:min(920px, 100%) }`，`Dialog`（`:2041-2050`）增加可选 `className`（给出时取代默认的 `rb-dialog`/`rb-dialog-wide`/`rb-dialog-drawer` 三档）。理由：现有 `.rb-dialog-wide` 是 `min(680px,100%)`（`:1893`），两栏下每栏仅约 320px，容不下一行「显示名 + id 标签 + 编辑/删除按钮 + 职责标签」；920px 给出每栏约 432px。body 顶层是 `.rb-roles-grid`（`display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); min-height:0; flex:1`），左栏 `border-right:1px solid var(--dsw-alias-border-l1)` 与右栏分开；每栏结构是「栏标题 + 自己的检索框 + 自己的滚动体 `.rb-roles-scroll{overflow:auto;min-height:0;flex:1}`」，所以两栏各自滚动、各自检索、互不串位。

**窄宽度退化（不得退回上下堆叠）。** `@media (max-width:760px)` 下把网格改为 `grid-template-columns:minmax(300px,1fr) minmax(300px,1fr); overflow-x:auto`：**两栏仍并排，超出部分由网格横向滚动承载**。理由：并排是这条需求的硬约束，而两栏的价值正在于「一个预设指向哪个角色」的左右对照——堆叠后对照要来回滚动，退化收益为负；横向滚动保留一眼两栏。实测读数见 §12.7。

**D2 表单弹窗。** `draft` 从"内联表单值"改为"表单弹窗的开关 + 初值"，**三个入口共用这一层**：footer「新建角色」（`role.new`）、行内编辑（`role.edit.<id>`）、预设一键登记（`preset.register.<presetId>`）。弹窗是平台 `Modal` 之上的第二层，仍用 `Dialog` 包装；层栈（`useModalLayer`）给顶层独占 Esc 与 Tab，所以 Esc 与遮罩点击关的是**表单弹窗**，对话框的关闭控件在弹窗开启期间不可达——不自建遮罩、不自己抓 Esc。字段与既有契约一致：`role.roleId`（改既有角色 `disabled`）、`role.roleName`、逐条职责编辑器（D3）。弹窗标题写明对象，这就是"正在编辑哪一行"的可辨性来源：新建 `newRole`、编辑 `edit · <显示名> (<id>)`、预设登记 `presetRegister · <显示名> (<id>)`；同时列表里那一行在该弹窗开启期间带 `aria-current="true"` 与 `.rb-role-row-editing`（回到列表即无标记）。表单弹窗的动作行放在 body 的 `form` 内而不是 `Modal.footer`，理由见 D8。关闭后列表与预设名册状态都不丢——名册与两栏检索词属于对话框组件，不属于弹窗（§12.5）。保存成功即关窗，并沿用现状**一次** `role.list` 重读（`:2156-2176`），不新增读。

**D3 职责逐条编辑。** 草稿里的 `duties` 由"一行逗号文本"改成 `string[]`：每条一个 `Input`（`name: 'role.duty.<i>'`）、行尾「移除」（`name: 'role.duty.remove.<i>'`）、末尾「添加一条」（`name: 'role.duty.add'`）；条目**可含逗号**（不再 split）。上界与提示：条数 ≤ 12、每条 ≤ 40 字，编辑器常驻显示 `n/12` 计数，达到 12 时「添加一条」`disabled`；`roleId` 的字符集与 `roleName` ≤ 40 也在弹窗内就地校验（错误落位见 D6）。**空职责**：提交时丢弃空行——与 `asStringArray` 的既有语义一致，面板只是把它讲清楚（提示"空行不会写入"）；全空是合法输入，正是 `dutiesMissing` 的来源。**重复条目**：与 Host 一致地保留首次出现、合并后续重复，并在提示里说明合并了几条，**不报成失败**。提交体仍是 `role.put` 的 `duties` 数组，Host 侧一行不改。

**D4 删除确认就地。** `confirmId` 命中的那一行在自己行内展开确认条（该行子树内的一个块，含 `removeRoleConfirm` 文案与确认/取消），不再渲染到 body 末尾。同一时刻只有一行处于确认态；点另一行的删除会切换确认行；取消即恢复原状。确认后仍走 `role.delete` 与随后的一次 `role.list` 重读。

**D5 两栏检索与分组。** 左栏检索框 `role.search`，右栏 `preset.search`；匹配字段：左栏 `id`/显示名/职责，右栏 `id`/显示名/`roleId`/名册里的职责；空串不过滤，匹配是 trim 后的大小写不敏感包含。左栏分三组并带计数：**已登记**（`items` 里 `ephemeral !== true`）、**临时**（`ephemeral === true`）、**未登记**（`unregistered`）；组标题显示过滤后的条数，过滤后为空则不显示该组标题。右栏是 `rolePresets` 一节，标题带过滤后条数。**三态判定先于过滤**：`presets === null`（读取中）/`unavailable`（两种降级文案）/空名册三态沿用现有键，不因为检索词而改变——"读不到"不是"没匹配"。三组全空时用新键 `rolesNoMatch`（区别于 `rolesEmpty` 的"一个角色都没有"）；右栏无匹配用 `presetsNoMatch`。检索只影响显示，不影响任何写入与读取。

**D6 错误落位。** `run` 的全局 toast 行为不动（其它对话框继续用）；角色管理自己在调用处拿到失败并就地显示：保存失败进表单弹窗内的错误块（`invalid-role` / `invalid-argument` 的 `message` 直接展示），删除失败进该行的错误块。**就地显示时不再重复发 app toast**——角色管理因此改走 `controller.command` 自行处理，而不是复用 `run` 的错误分支；这条只改角色管理。一键登记成功后行状态即时变化，靠的仍是"保存成功后一次 `role.list` 重读"（未建档行翻成已建档）。

**D7 未保存处置。** 判据是草稿与初值不同（逐字段比较，职责比数组与顺序）；未改动时关闭不打断。已改动时关闭表单弹窗（取消 / Esc / 遮罩）**不关窗**，改为在弹窗内显示确认条（`roleDiscardConfirm` + 「丢弃并关闭」`roleDiscardConfirmDrop` / 「继续编辑」`roleDiscardConfirmKeep`），点「丢弃并关闭」才真的关；不用平台 `confirm()`（阻塞、不可本地化），也不静默丢弃。另外两条被需求点名的路径在决定 2 之后**天然不存在**，因为它们都要触达弹窗背后的控件：带着未保存草稿关闭对话框、以及带着草稿切换到另一个编辑对象，都被顶层遮罩挡住（层栈独占 Esc 与 Tab）。先按 D7 处理弹窗，再关对话框。

**D8 键盘路径。** Enter：表单弹窗的 body 用 `h('form', { onSubmit })` 包裹，保存按钮 `type:'submit'`、取消 `type:'button'`（`Button`/`Input` 都透传原生属性，见 `packages/client/ui-primitives/src/Button.tsx:27`、`Input.tsx:17`），所以任一输入框内按 Enter 即提交；这也是动作行必须留在 `form` 内的原因——放进 `Modal.footer` 就不在表单里，原生 Enter 没有落点。Esc：平台层栈关顶层弹窗，有未保存改动时先出确认条，**确认条显示期间再按 Esc 只收起确认条、不丢弃输入**（丢弃必须显式点「丢弃并关闭」）。打开时的进入焦点由平台接管，落点是第一个输入框（DOM 顺序即 `role.roleId`），实测记录进 §12.7。

### 12.3 状态矩阵

| 状态 | 左栏（角色） | 右栏（预设模式） | 表单弹窗 |
|---|---|---|---|
| 空 | 无任何已登记/临时/未登记 → `rolesEmpty`（沿用） | 名册读到但无预设 → `presetsEmpty`（沿用） | 不适用 |
| 加载 | `status === 'loading' && !loaded` → 骨架 `rb-skeleton`（沿用） | `presets === null` → `presetsReading`（沿用） | 打开时名册已在读，弹窗不等待名册 |
| 失败 | 仍显示 board 快照里的 roles（读取失败不改这一栏） | `unavailable` 两种降级文案（沿用，含 Host 的 detail） | 保存/删除失败 → 弹窗内/行内就地错误（D6） |
| 编辑中 | 该行 `aria-current="true"` + `.rb-role-row-editing` | 不变 | 第二层弹窗，标题写明对象（D2） |
| 未保存 | 不变 | 不变 | 确认条（D7），Esc 不丢弃 |
| 过滤无匹配 | 组标题消失、`rolesNoMatch` | 标题计数为 0、`presetsNoMatch` | 不适用 |

### 12.4 明确不动

`host/**` 与 `roles` 表 schema；`role.put` / `role.delete` / `role.list` 的契约、字段与校验；角色解析优先链与预设对照数据来源；`tmp-*` / `ephemeral` / 未登记角色的既有语义；派发、临时角色与锁的语义；需求主视图与其它对话框；不引外链资源。视觉上只用既有 token 与组件（`--dsw-alias-*`、`--dsw-radius-*`、`--rb-*`、`Button`/`Input`/`Tag`/`Modal`），不新造颜色、字号或圆角，不重排面板其余部分。`run` 的全局 toast 语义保持（只让角色管理不再走它的错误分支）；`locale/zh.json`、`locale/en.json` 保持 meta-only（面板文案字典是 `client.js` 的 `DICT.en`/`DICT.zh`，经 `locale.register` 注册，client-smoke 校验两本键对齐——验收第 10 条点名的两个文件只有 `meta.title`/`meta.description`，见评审记录）。

### 12.5 实现落点

- `client.js`：`RolesDialog`（`:2139-2386`）重写为「对话框壳体 + 两栏 + 检索 + 分组 + 就地确认」，新增 `RoleFormDialog`（第二层弹窗 + 职责编辑器 + 未保存确认条）；`Dialog`（`:2041-2050`）增加可选 `className`；新增 DICT 键（`en` 段 `:197-`、`zh` 段 `:587-`，两本键必须一一对应）：`rolesColumn`、`presetsColumn`、`roleSearch`、`presetSearch`、`roleGroupRegistered`、`roleGroupEphemeral`、`rolesNoMatch`、`presetsNoMatch`、`roleDutyAdd`、`roleDutyRemove`、`roleDutyCount`、`roleDutyEmptyHint`、`roleDutyMerged`、`roleDiscardConfirm`、`roleDiscardConfirmDrop`、`roleDiscardConfirmKeep`、`roleFormError`、`roleRowError`、`roleEditTitle`、`roleRegisterTitle`；可复用的既有键：`newRole`、`edit`、`save`、`cancel`、`close`、`presetRegister`、`removeRole`、`removeRoleConfirm`、`confirm`、`rolesEmpty`、`presetsEmpty`、`presetsReading`、`presetsUnavailableAbsent`、`presetsUnavailableFailed`、`rolesUnregistered`、`roleDutiesMissing`、`roleId`、`roleName`、`roleDuties`。
- 样式改**授权源** `rollout/new-panel.css`，再用 `node rollout/splice-css.mjs` 重拼进 `client.js`（`:24-31` 按边界行定位，不按行号）；新增类：`.rb-dialog-roles`、`.rb-roles-grid`、`.rb-roles-col`、`.rb-roles-col-head`、`.rb-roles-scroll`、`.rb-roles-search`、`.rb-group-head`、`.rb-role-row-editing`、`.rb-role-confirm`、`.rb-duty-row`、`.rb-duty-count`、`.rb-form-error`、`.rb-preset-empty`。
- 部署副本：`node rollout/sync-deployment.mjs <devRoot> <deploymentRoot>`（逐文件 sha256 比对后只重写不等者），随后复核逐字节一致；该路径在工作区外，写入按沙箱规则一次性申请权限。

**控件命名（两条门的断言面，实现必须照这套名字）。** 沿用既有 `name` 属性约定，新增/保留如下：`role.search`、`preset.search`；`role.new`（footer 新建）；`role.edit.<id>`、`role.remove.<id>`；表单弹窗内 `role.roleId`、`role.roleName`、`role.duty.<i>`、`role.duty.remove.<i>`、`role.duty.add`、`role.save`（`type:'submit'`）、`role.cancel`；未保存确认条 `role.discard.drop`、`role.discard.keep`；行内删除确认 `role.confirm.<id>`、`role.confirm.cancel.<id>`；预设一键登记 `preset.register.<id>`（既有名）；就地错误块 `role.form.error`（弹窗内）与 `role.row.error.<id>`（行内）。第二层表单弹窗在真浏览器里以「`[role="dialog"]` 的个数为 2、顶层那个含 `form [name="role.roleId"]`」判定；行分组标题与计数用 `<组名> <计数>` 的可见文本断言，不新增自造 `data-*` 钩子。

### 12.6 验收与门

| 门 | 命令 | 覆盖 |
|---|---|---|
| 源码级 | `node tests/client-smoke.mjs` | §12.2 D1–D8（含弹窗开关、键盘路径、失败态、未保存确认条），在 `:1721-1854` 段内扩展 |
| 真浏览器 | `node tests/verification/panel-render.e2e.mjs <baseUrl> <token>` | 五条最小覆盖：并排两栏（两栏几何不重叠、各自持有自己的行锚点、每栏有自己的滚动容器）、新建弹窗（第二层 `[role="dialog"]` + 标题可辨）、职责逐条增删（含条目含逗号）、检索（行数收敛且每个 `h3` 组标题子树内的可见行数等于当前可见总数）、删除确认就地（确认元素在被删行的子树内）；插入点在角色管理段内（原 `:250` 之后）。两条附属修正：门显式固定调色板（页内 `data-ds-dark-theme`，暗/亮各一条强调色断言），缺锚点时一律记**具名失败**并跳过依赖该读数的深层检查，不再抛异常终止整条门 |
| 字节卫生 | `node --import tsx/esm tests/verification/g-hygiene.mjs all` | 无 BOM、合法 UTF-8、仅 LF、恰一个尾 LF；`locale/*.json` 可解析 |
| Host 未动 | `node tests/roles.mjs` | 298 项保持全绿即证明 `role.*` 契约与解析链未变 |

真浏览器门需要**临时实例**，禁触 3080：`node --import tsx/esm apps/cli/src/bin.ts --profile web --patch .artifacts/requirement-board/rollout/ui-dev.overlay.yml --no-open --port 3110`（`--patch` 必须在 app 参数之前），token 取启动行里的 `?token=`。

**改坏即红**：按 `EXTENDING.md:187` 的规范与 `COUNTER-PROOF.md` 的三段式（变异点 → 两门各自 RED + FAIL 原文 → 恢复后复跑绿），用 `rollout/counter-proof.mjs <label> <pattern> <replacement>` 触发，产物落 `tests/verification/_roles_red_*.txt`；两门必须**同时**转红再转绿，做不到红的门不算门。

**证据（§12.7 的读数来源）**：改前/改后各一组截图，落 `screenshots/`，命名 `<label>-NN-<region>.png`，由同一脚本 `rollout/roles-evidence.mjs <base> <bootToken> <label> [--palette=light|dark]` 生成，**改前与改后步骤名一致**：`00-opener`、`01-side-by-side`、`02-new-dialog`、`03-edit-in-place`、`04-duties`、`05-unsaved-bar`、`06-search`、`07-delete-inline`；改前组 `roles-before-*`、改后组 `roles-after-*`，两套各再出一组暗色调色板（`roles-*-dark-*`）。配套 `roles-<label>[-dark]-readings.json` 每步记录 `url`/`theme`/`darkThemeAttr`/`dialogCount`/`dialogBox`/`dialogChildren`/`geometry`/`scrollers`/`headings`/`roleRowCount`/`presetRowCount`/`dialogText` 与 `hitAreas`（对关键控件在中心点与四个近边点用 `document.elementFromPoint` 取回节点，报是否命中该控件或其子树——本仓库此前没有命中区读数实现，这是新增的读数方法）；本代实现里不存在的控件记入顶层 `missing`，不记为失败。调色板用页内 `document.body` 的 `data-ds-dark-theme` 切换（平台自身客户端测试的做法；本实例的主题偏好是显式值，`emulateMedia` 不生效，实测见 §12.7）。窄视口由一次性探针落 `screenshots/roles-narrow-readings.json`（1440/760/700 三档）。

### 12.7 读数（build / verify 节点回填）

| 项 | 改前 | 改后 |
|---|---|---|
| 对话框宽度 / 两栏列宽 | **680px 单列**：`dialogChildren` 仅 2 项（内容＋页脚）；角色列表与预设模式同处**一个**滚动体（`rb-role-list` 768/360） | **920px 两栏**：1440 视口下列宽 436+436（`x=284`/`720`）；每栏各自 `.rb-roles-scroll`——左 468/468（2 行，不需滚）、右 1199/468（11 行，会滚）；`grid-template-columns` = `minmax(0,1fr) minmax(0,1fr)` |
| 窄视口两栏与横向滚动 | —（改前无两栏，无从比较） | **两栏始终并排**：760px→对话框 712、列 332+332；700px→652、列 302+302；`overflow-x:auto` 在 ≤760px 生效，但两档实测 `scrollWidth == clientWidth`（664 / 604），即**当前并不产生横向滚动**（最小两栏内容仍装得下）；该属性是超窄视口的兜底，不是已发生的滚动 |
| 分组标题（含计数） | 无标题元素、无计数 | `h3.rb-group-head`：`已登记 2`、`预设模式 11`；检索后 `已登记 1` 且组内可见行数 1，门④已加严为「标题内唯一数字 run == 该组可见行数」硬判据 |
| 行内删除确认位置 | 确认块在 body 末尾 `y=726` | 所属行子树内 `y=438`，`row.contains(confirm)=true`、非 body 末元素、`near=true` |
| 命中区（本仓库新增读数法） | `role.new` 按钮**无 `name` 属性**（只能按文本定位），故未测 | `role.new` / `role.search` / `role.remove.*` / `role.confirm.*` 在中心点＋四个近边点**全部命中控件自身**（`hitAreas` 全 `true`，无被遮罩吞点击的控件） |
| 调色板 | — | 页内 `data-ds-dark-theme` 可切换：强调色 `#c2410c ↔ #f06423`、对话框底色 `白 ↔ rgb(44,44,46)`、正文色 `rgb(15,17,21) ↔ rgb(249,250,251)`；`emulateMedia({colorScheme})` 在本实例**无效**（主题偏好是显式值，非 `system`）；改前/改后各出亮/暗两套截图 |
| `client-smoke.mjs` | **408/408**（用部署副本自测的基线；任务书原记的 389 是错的） | **451/451** |
| `panel-render.e2e.mjs` | **58/63**：五条新断言全部以**具名 FAIL** 记录、零 TypeError（`_roles_red_pre_impl.txt`） | **63/63**（`_roles_after_gate.txt`） |
| 其它门 | 298/298 · 6/6 · 同步 | `roles.mjs` 298/298 · `g-hygiene all` 6/6 · `splice-css --check` 同步 |
| 反证（改坏即红） | — | **强调色变异**（`--rb-accent:#f06423;`→`#f06424;`）：两门**同时红**（`client-smoke 450/451`、`panel-render 61/63`）→ 恢复后 `451/451`、`63/63`（`_roles_red_accent.txt`）。**两栏压成一栏**（`minmax(0,1fr) minmax(0,1fr)`→`minmax(0,1fr)`）：真浏览器门红 `62/63`（断言①给出堆叠几何：右栏 `y=473` 落到左栏 `y=184` 之下）→ 恢复绿；`client-smoke` 在该变异下**按设计保持绿**（它的 CSS 覆盖是 token 注册表与标记类名，不是布局），此处如实记录这一非对称，不掩盖（`_roles_red_grid.txt`） |

## 13. 面板按钮描边可见性（全部按钮 · 主按钮含描边 · 四态 · 两主题）

对应需求 `req_81a5e56f23`。视觉基线来自概念稿 `reference/kanban-redesign.html:102-106` 的 `.btn { border: 1px solid var(--line) }`；上一轮视觉统一漏了实现这一环。

### 13.1 现状（2026-10-10 实测，改前读数 `screenshots/stroke-before-readings.json`）

- 平台原语 `packages/client/ui-primitives/src/Button.module.css`：`.button { border: none }`（:8）；**只有 `.outline` 有边框**，且是 `border: 0.5px solid var(--dsw-alias-border-l3)`（:54-55）；`.ghost` / `.primary` / `.toolbar` 无边框。`.primary` 填充 `--dsw-alias-button-primary-fill`。
- 中性描边 token 两臂实测（`ui-theme/src/styles/design-platform.css`）：亮 `l1 rgba(0,0,0,.04)`、`l2 rgba(0,0,0,.1)`、`l3 rgba(0,0,0,.12)`；暗 `l1 rgba(255,255,255,.06)`、`l2 rgba(255,255,255,.12)`、`l3 rgba(255,255,255,.16)`。**l3 是最强的一档中性描边**。
- **对话框被 portal 到 `.rb-root` 之外**：实测链 `DIV._dialog_o6lrb_33.rb-dialog-roles < DIV._root_o6lrb_6`，`insideRoot=false`。任何以 `.rb-root` 为作用域的规则都够不到对话框按钮。
- 面板里大量**非按钮控件本身就是 `<button>`**：`rb-card`（需求卡 330×132）、`rb-chip`（项目胶囊 95.7×26）、`rb-seg`（看板/队列/要我拍板，规则里已显式 `border:0`）、`rb-node`（流程节点 150×62）、`rb-clear`。一刀切的 `button` 选择器会把它们全部描上边，与「非按钮控件不动」冲突。
- 改前实测描边（亮色 1440×900，54 个按钮）：对话框内 **9× `primary`=`0px none`**、2× `ghost`=`0px none`、1× 关闭图标=`0px none`、2× `outline+rb-btn-danger`=`1px rgb(236,19,19)`；面板内 `primary` 全 `0px`（新建需求 78×32、md 98×36、sm 44×28）；顶栏 `ghost+rb-btn`=`1px l2`（已有描边）、详情行 `ghost`=`1px l2`。两主题 0 控制台错误。
- 主按钮「看起来没有边框」是两条叠加的结果：平台 `border: none` + 面板 `.rb-btn-primary.rb-btn-primary { border-color: transparent }`（`new-panel.css:60`）——宽度为 0 时 `border-color` 不画任何东西。

### 13.2 形态决定

- **D1 机制（硬要求）**：面板自己的标记类 `rb-btn` 挂在按钮元素上，规则用重复类名提权、不依赖加载顺序、不命中平台哈希类名。不用标签选择器（13.1 的「非按钮控件也是 button」）也不用 `.rb-root` 作用域（对话框在它之外）。
- **D2 线宽与颜色**：中性按钮 `border: 1px solid var(--dsw-alias-border-l3)`；主按钮改为 `border: 1px solid var(--rb-accent-strong)`（亮 `#9a3412` / 暗 `#ff7733`，与填充同色系，避免灰边压在橙底上发浑）；危险按钮沿用既有 `--dsw-alias-state-error-primary`。
- **D3 提权到三重复类名（顺序无关）**：`.rb-btn.rb-btn` 是 (0,2,0)，而既有的 `.rb-btn-primary.rb-btn-primary` 与 `.rb-btn-danger.rb-btn-danger` 也是 (0,2,0)——同权时 `border` 简写与 `border-color` 谁赢取决于加载顺序，正是本条要避免的。凡必须压过基线规则的按钮规则一律写**三重复类名**（`.rb-btn-primary.rb-btn-primary.rb-btn-primary` 等，(0,3,0)）。门要断言这三重复形式存在，防止将来被改回两重又变成顺序依赖。
- **D4 不动**：`rb-card` / `rb-chip` / `rb-seg` / `rb-node` / `rb-clear` / `rb-tab` 等非按钮控件；目标平台原语 `packages/client/ui-primitives` **零改动**；顶栏 `.rb-header .rb-btn.rb-btn`（(0,3,0)，l2）保持原样，其改前读数即回归基线；`--dsw-*` 只读不新增。
- **D5 四态**：rest = 1px（中性 l3 / 主按钮 accent-strong）；`hover` 与 `active` **显式重述** `border-color`，不许清除；`focus-visible` 只改 `border-color`，**不声明 `outline`**——平台的焦点环是 `:focus-visible { outline-width:2px; outline-color:var(--dsw-alias-state-business-primary) }`（`focus.css:10-13`），且指针模态下被显式置透明（`focus.css:18-19`），所以四态测量必须先切到键盘模态；`disabled` 用不透明中性色 `--dsw-alias-label-tertiary` 补偿平台 `:disabled { opacity: .4 }`，并以**像素采样**证明复合后仍看得见（合成 alpha 与实测色一并记录，不只报 computed style）。
- **D6 几何**：只动 `border`，不动 `padding` / `height` / `font-size`；平台 `.button` 已 `box-sizing: border-box`，外框尺寸不变，`inline-flex` 居中使文字仍居中——仍按 sm/md × primary/ghost/outline 实测宽高与文字基线，改前读数即对照。
- **D7 枚举**：由脚本 `rollout/button-inventory.mjs` 从 `client.js` 生成（`h(Button, …)` 使用点 + 原始 `<button>` 非按钮控件清单），表落 §13.3；可复跑，避免手抄遗漏。

### 13.3 按钮使用点枚举（由 `rollout/button-inventory.mjs` 生成）

<!-- BEGIN stroke-inventory (generated by rollout/button-inventory.mjs; do not hand-edit) -->
**按钮使用点：79 个**（源码里 `h(Button, …)` 的全部调用点；脚本 `rollout/button-inventory.mjs` 从 `client.js` 解析，可复跑）。

**覆盖核验**：未带 `rb-btn` 标记的站点 **0** 个（全部带标记，非抽样）；重复声明 `rb-btn` 的站点 0 个；标记类改写前的站点数是 3（另有 14 个只带变体类，本次合并成 `rb-btn <变体类>`）。

**几何回补标记（§13.6）**：改前描边宽度为 0、需要从水平 padding 各回补 1px 的站点 56 个，已带 `rb-btn-pad` 的 56 个；不该回补却带标记的 0 个。`sm` 档站点 57 个，已带 `rb-btn-sm` 的 57 个。回补值：中性/主按钮 md 14→13、sm 10→9，顶栏主按钮 13→12（它改前 padding 来自面板规则而非平台，见 §13.6）。

**主按钮描边范围（§13.6）**：`variant:'primary'` 且不带面板 accent 皮肤的站点 11 个，已带 `rb-btn-primary-stroke` 的 11 个；多标的 0 个。这些站点走 `border-color: var(--rb-accent-strong)` 而不是中性 l3，因为平台 primary 填充在亮色近黑、暗色近白，l3 叠加后与填充几乎同色（逐像素读数见 `screenshots/stroke-pixels.json`）。

改前/改后两列是**声明值**：按平台原语与面板规则的选择器权重、源码先后顺序逐长手解析（`BEFORE_RULES`/`AFTER_RULES`，同一份脚本），不是浏览器读数；实测读数见 §13.5。

| # | 位置（行:所在函数） | 容器（内→外，最多 3 层） | 变体 / 尺寸 | name | 标记类 | 改前描边 | 改后描边 | token |
|---|---|---|---|---|---|---|---|---|
| 1 | `client.js:2391` RoleFormDialog | div.rb-duty-row < div.rb-field < form | ghost / sm | — (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 2 | `client.js:2399` RoleFormDialog | div.rb-field < form < Dialog | ghost / sm | `role.duty.add` (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 3 | `client.js:2415` RoleFormDialog | div.rb-row < div.rb-panel < form | outline / md (platform default) | `role.discard.drop` | `rb-btn` | 0.5px solid var(--dsw-alias-border-l3) | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 4 | `client.js:2416` RoleFormDialog | div.rb-row < div.rb-panel < form | ghost / md (platform default) | `role.discard.keep` | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 5 | `client.js:2418` RoleFormDialog | div.rb-row < form < Dialog | primary / md (platform default) | `role.save` (disabled) | `rb-btn-primary-stroke rb-btn-pad rb-btn` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 6 | `client.js:2425` RoleFormDialog | div.rb-row < form < Dialog | ghost / md (platform default) | `role.cancel` | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 7 | `client.js:2621` RolesDialog | div.rb-row < div.rb-role-confirm | outline / md (platform default) | — (disabled) | `rb-btn rb-btn-danger` | 0.5px solid var(--dsw-alias-state-error-primary) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 8 | `client.js:2628` RolesDialog | div.rb-row < div.rb-role-confirm | ghost / md (platform default) | — | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 9 | `client.js:2660` RolesDialog | div.rb-role-head < div.rb-role-row | ghost / sm | — (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 10 | `client.js:2670` RolesDialog | div.rb-role-head < div.rb-role-row | outline / sm | — (disabled) | `rb-btn-sm rb-btn rb-btn-danger` | 0.5px solid var(--dsw-alias-state-error-primary) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 11 | `client.js:2714` RolesDialog | div.rb-role-head < div.rb-role-row.rb-preset-row | primary / sm | — (disabled) | `rb-btn-primary-stroke rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 12 | `client.js:2843` RolesDialog | Dialog.rb-dialog-roles | ghost / md (platform default) | `role.new` (disabled) | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 13 | `client.js:2852` RolesDialog | Dialog.rb-dialog-roles | ghost / md (platform default) | — | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 14 | `client.js:3300` NodeDetail | div.rb-row < div.rb-panel | outline / md (platform default) | — (disabled) | `rb-btn rb-btn-danger` | 0.5px solid var(--dsw-alias-state-error-primary) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 15 | `client.js:3308` NodeDetail | div.rb-row < div.rb-panel | primary / md (platform default) | — (disabled) | `rb-btn-primary-stroke rb-btn-pad rb-btn` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 16 | `client.js:3315` NodeDetail | div.rb-row < div.rb-panel | ghost / md (platform default) | — (disabled) | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 17 | `client.js:3321` NodeDetail | div.rb-row < div.rb-panel | ghost / md (platform default) | — (disabled) | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 18 | `client.js:3328` NodeDetail | div.rb-row < div.rb-panel | ghost / sm | — | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 19 | `client.js:3502` CreateRequirementDialog | div.rb-image-tile | ghost / sm | — | `rb-btn-pad rb-btn-sm rb-btn rb-image-remove` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 20 | `client.js:3517` CreateRequirementDialog | Dialog | ghost / md (platform default) | — | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 21 | `client.js:3518` CreateRequirementDialog | Dialog | primary / md (platform default) | — (disabled) | `rb-btn-primary-stroke rb-btn-pad rb-btn` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 22 | `client.js:3560` CreateRequirementDialog | div.rb-row < Field < Dialog | ghost / sm | `requirement.image.pick` | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 23 | `client.js:4047` TemplateDrawer | div.rb-node-card-head < div.rb-version-row | ghost / sm | — (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 24 | `client.js:4061` TemplateDrawer | div.rb-node-card-head < div.rb-version-row | ghost / sm | — (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 25 | `client.js:4099` TemplateDrawer | div.rb-row < div.rb-panel | outline / sm | `template.metadata.save` (disabled) | `rb-btn-sm rb-btn` | 0.5px solid var(--dsw-alias-border-l3) | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 26 | `client.js:4124` TemplateDrawer | div.rb-node-card-head < div.rb-node-card | ghost / sm | — (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 27 | `client.js:4132` TemplateDrawer | div.rb-node-card-head < div.rb-node-card | ghost / sm | — (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 28 | `client.js:4140` TemplateDrawer | div.rb-node-card-head < div.rb-node-card | ghost / sm | — (disabled) | `rb-btn-pad rb-btn-sm rb-btn rb-btn-danger` | 0px none | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 29 | `client.js:4200` TemplateDrawer | div.rb-check-row < div.rb-checks < div | ghost / sm | — (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 30 | `client.js:4208` TemplateDrawer | div < div.rb-node-card | ghost / sm | — (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 31 | `client.js:4217` TemplateDrawer | div.rb-row | ghost / sm | `template.node.add` (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 32 | `client.js:4226` TemplateDrawer | div.rb-row | ghost / sm | `template.edit.cancel` (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 33 | `client.js:4238` TemplateDrawer | div.rb-row | primary / sm | `template.revise.save` (disabled) | `rb-btn-primary-stroke rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 34 | `client.js:4285` TemplateDrawer | div.rb-row | ghost / sm | `template.edit` (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 35 | `client.js:4286` TemplateDrawer | div.rb-row | ghost / sm | `template.migrate` (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 36 | `client.js:4287` TemplateDrawer | div.rb-row | ghost / sm | `template.clone` (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 37 | `client.js:4288` TemplateDrawer | div.rb-row | ghost / sm | `template.archive` (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 38 | `client.js:4296` TemplateDrawer | div.rb-row | outline / sm | `template.delete` (disabled) | `rb-btn-sm rb-btn rb-btn-danger` | 0.5px solid var(--dsw-alias-state-error-primary) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 39 | `client.js:4320` TemplateDrawer | Dialog | ghost / md (platform default) | — | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 40 | `client.js:4331` TemplateDrawer | div.rb-drawer-list < div.rb-drawer < Dialog | ghost / sm | `template.new` (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 41 | `client.js:4359` TemplateDrawer | div.rb-row < div.rb-panel < div.rb-drawer-list | primary / sm | `template.create` (disabled) | `rb-btn-primary-stroke rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 42 | `client.js:4367` TemplateDrawer | div.rb-row < div.rb-panel < div.rb-drawer-list | ghost / sm | — | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 43 | `client.js:4405` TemplateDrawer | div.rb-notice.rb-notice-force < div.rb-drawer-body < div.rb-drawer | outline / sm | — (disabled) | `rb-btn-sm rb-btn rb-btn-danger` | 0.5px solid var(--dsw-alias-state-error-primary) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 44 | `client.js:4412` TemplateDrawer | div.rb-notice.rb-notice-force < div.rb-drawer-body < div.rb-drawer | ghost / sm | — | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 45 | `client.js:4439` TemplateDrawer | div.rb-row < div.rb-panel < Dialog | primary / sm | `template.clone.confirm` (disabled) | `rb-btn-primary-stroke rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 46 | `client.js:4447` TemplateDrawer | div.rb-row < div.rb-panel < Dialog | ghost / sm | — | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 47 | `client.js:4468` TemplateDrawer | div.rb-row < div < div.rb-panel | outline / sm | `template.delete.confirm` (disabled) | `rb-btn-sm rb-btn rb-btn-danger` | 0.5px solid var(--dsw-alias-state-error-primary) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 48 | `client.js:4482` TemplateDrawer | div.rb-row < div < div.rb-panel | ghost / sm | — | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 49 | `client.js:4589` MigrateTemplateDialog | Dialog | ghost / md (platform default) | — | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 50 | `client.js:4591` MigrateTemplateDialog | Dialog | primary / md (platform default) | — (disabled) | `rb-btn-primary-stroke rb-btn-pad rb-btn` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 51 | `client.js:4592` MigrateTemplateDialog | Dialog | primary / md (platform default) | — (disabled) | `rb-btn-primary-stroke rb-btn-pad rb-btn` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 52 | `client.js:4610` MigrateTemplateDialog | div.rb-row < Dialog | ghost / sm | `template.migrate.all` (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 53 | `client.js:4618` MigrateTemplateDialog | div.rb-row < Dialog | ghost / sm | `template.migrate.pick` (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 54 | `client.js:4661` DelegationForm | div.rb-row < div.rb-panel | primary / sm | `delegate.submit` (disabled) | `rb-btn-primary-stroke rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 55 | `client.js:4738` EditFields | div.rb-row < div.rb-panel | ghost / sm | — | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 56 | `client.js:4739` EditFields | div.rb-row < div.rb-panel | primary / sm | `edit.save` (disabled) | `rb-btn-primary-stroke rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 57 | `client.js:4896` RequirementDetail | div.rb-detail-actions < div.rb-detail-top < div | ghost / sm | — (disabled) | `rb-btn-sm rb-btn` | 1px solid var(--dsw-alias-border-l2) | 1px solid var(--dsw-alias-border-l2) | `--dsw-alias-border-l2` |
| 58 | `client.js:4904` RequirementDetail | div.rb-detail-actions < div.rb-detail-top < div | ghost / sm | — (disabled) | `rb-btn-sm rb-btn` | 1px solid var(--dsw-alias-border-l2) | 1px solid var(--dsw-alias-border-l2) | `--dsw-alias-border-l2` |
| 59 | `client.js:4913` RequirementDetail | div.rb-detail-actions < div.rb-detail-top < div | ghost / sm | — (disabled) | `rb-btn-sm rb-btn` | 1px solid var(--dsw-alias-border-l2) | 1px solid var(--dsw-alias-border-l2) | `--dsw-alias-border-l2` |
| 60 | `client.js:4922` RequirementDetail | div.rb-detail-actions < div.rb-detail-top < div | ghost / sm | — (disabled) | `rb-btn-sm rb-btn` | 1px solid var(--dsw-alias-border-l2) | 1px solid var(--dsw-alias-border-l2) | `--dsw-alias-border-l2` |
| 61 | `client.js:4929` RequirementDetail | div.rb-detail-actions < div.rb-detail-top < div | ghost / sm | — (disabled) | `rb-btn-sm rb-btn` | 1px solid var(--dsw-alias-border-l2) | 1px solid var(--dsw-alias-border-l2) | `--dsw-alias-border-l2` |
| 62 | `client.js:4936` RequirementDetail | div.rb-detail-actions < div.rb-detail-top < div | outline / sm | — (disabled) | `rb-btn-sm rb-btn rb-btn-danger` | 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 63 | `client.js:5046` RequirementDetail | div.rb-row < div.rb-panel < div | outline / sm | — (disabled) | `rb-btn-sm rb-btn rb-btn-danger` | 0.5px solid var(--dsw-alias-state-error-primary) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 64 | `client.js:5075` RequirementDetail | div.rb-row < div.rb-panel < div | outline / sm | `revoke.delegation` (disabled) | `rb-btn-sm rb-btn rb-btn-danger` | 0.5px solid var(--dsw-alias-state-error-primary) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 65 | `client.js:5117` RequirementDetail | div.rb-notice.rb-notice-force < div | ghost / sm | `force.request` (disabled) | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 66 | `client.js:5125` RequirementDetail | div.rb-notice.rb-notice-force < div | ghost / sm | — | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 67 | `client.js:5140` RequirementDetail | Dialog < div | ghost / md (platform default) | — | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 68 | `client.js:5141` RequirementDetail | Dialog < div | outline / md (platform default) | `force.confirm` (disabled) | `rb-btn rb-btn-danger` | 0.5px solid var(--dsw-alias-state-error-primary) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 69 | `client.js:5165` RequirementDetail | Dialog < div | ghost / md (platform default) | — | `rb-btn-pad rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 70 | `client.js:5166` RequirementDetail | Dialog < div | outline / md (platform default) | — (disabled) | `rb-btn rb-btn-danger` | 0.5px solid var(--dsw-alias-state-error-primary) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 71 | `client.js:5487` BoardPage | div.rb-queue-row | ghost / sm | — | `rb-btn-pad rb-btn-sm rb-btn rb-queue-title` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 72 | `client.js:5495` BoardPage | div.rb-queue-row | outline / sm | — (disabled) | `rb-btn-sm rb-btn rb-btn-danger` | 0.5px solid var(--dsw-alias-state-error-primary) | 1px solid var(--dsw-alias-state-error-primary) | `--dsw-alias-state-error-primary` |
| 73 | `client.js:5597` BoardPage | div.rb-header < div.rb-root | ghost / sm | `refresh` (disabled) | `rb-btn-sm rb-btn` | 1px solid var(--dsw-alias-border-l2) | 1px solid var(--dsw-alias-border-l2) | `--dsw-alias-border-l2` |
| 74 | `client.js:5605` BoardPage | div.rb-header < div.rb-root | ghost / sm | — | `rb-btn-sm rb-btn` | 1px solid var(--dsw-alias-border-l2) | 1px solid var(--dsw-alias-border-l2) | `--dsw-alias-border-l2` |
| 75 | `client.js:5606` BoardPage | div.rb-header < div.rb-root | ghost / sm | — | `rb-btn-sm rb-btn` | 1px solid var(--dsw-alias-border-l2) | 1px solid var(--dsw-alias-border-l2) | `--dsw-alias-border-l2` |
| 76 | `client.js:5607` BoardPage | div.rb-header < div.rb-root | primary / sm | — | `rb-btn-sm rb-btn rb-btn-primary` | 0px none | 1px solid var(--rb-accent-strong) | `--rb-accent-strong` |
| 77 | `client.js:5631` BoardPage | div.rb-notice.rb-notice-auth < div.rb-root | ghost / sm | `auth.recheck` | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 78 | `client.js:5641` BoardPage | div.rb-notice.rb-notice-stale < div.rb-root | ghost / sm | — | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |
| 79 | `client.js:5646` BoardPage | div.rb-notice.rb-notice-error < div.rb-root | ghost / sm | — | `rb-btn-pad rb-btn-sm rb-btn` | 0px none | 1px solid var(--dsw-alias-border-l3) | `--dsw-alias-border-l3` |

**非按钮控件（不动清单，§13.2 D4）**：面板里这些元素本身就是 `<button>`，但语义不是动作按钮，一刀切的 `button` 选择器会把它们全部描上边。

| 位置（行:所在函数） | 类名 | 不动原因 |
|---|---|---|
| `client.js:3116` FlowChart | `rb-node` | 流程图节点卡，自带 1px `--dsw-alias-border-l1` 与激活/选中态；不是动作按钮 |
| `client.js:4372` TemplateDrawer | `rb-template-row` | 模板抽屉的整行选择行（占满抽屉宽度），自带 `rb-template-row-picked` 选中态；不是动作按钮 |
| `client.js:5515` BoardPage | `rb-card` | 需求卡：可点的整块容器，自带 1px `--dsw-alias-border-l1` 与 `rb-card-selected` 选中态；描边会把它误当动作按钮 |
| `client.js:5727` BoardPage | `rb-clear` | 「清除全部」文本式清除控件，无描边是设计基线 |
| `client.js:5433` BoardPage | `rb-chip` `rb-chip-on` `rb-chip`（平台 `Pill`） | 项目/角色筛选胶囊：自带 1px `--dsw-alias-border-l1` 与选中态，不是动作按钮 |
| `client.js:5615` BoardPage | `view` `entry` `key` `rb-seg` `rb-seg-on` `rb-seg`（平台 `Pill`） | 看板/队列/要我拍板分段控件：规则里已显式 `border:0`，描边会与 `rb-segmented` 外框叠成双层边框 |
| （无源码位置：平台 `Modal` 内部） | `Modal.module.css .close` | 平台 `Modal` 自带的关闭按钮（`packages/client/ui-primitives/src/Modal.module.css` 的 `.close`）：由平台渲染、不在面板源码里，面板标记类够不到，属平台原语（D4 零改动） |
<!-- END stroke-inventory -->

---
### 13.4 门与反证

| 门 | 断言 | 反证 |
|---|---|---|
| `tests/client-smoke.mjs` | 输出来源里**每个** `h(Button, …)` 使用点都带 `rb-btn`（79 个，不是抽样）；无重复标记；带 `rb-btn-pad` 的站点不可能是自带 padding 的 `rb-btn-primary`；`rb-btn-primary-stroke` 与 `rb-btn-primary` 互斥；样式表里 `.rb-btn.rb-btn` 是 1px l3、四态各有 `border-color` 臂、`focus-visible` 不写 `outline`、`disabled` 是 label-tertiary、主/危险是三重复类名、详情行保住 l2、三条 padding 回补值、`--rb-accent-strong` 声明在主题载体上；胶囊/卡片/节点/分段控件不沾按钮描边 | 改回 `transparent`/`0`/删掉某条回补应转红 |
| `tests/verification/panel-render.e2e.mjs` | 真实浏览器：面板内与 portal 出来的对话框内各取按钮，亮/暗两主题 `border-width == 1px`、`border-style == solid`、颜色非透明（22 个带 `rb-btn-primary-stroke` 的读数、6 个危险读数）；hover / active / focus-visible 四态 × 两主题（6 个代表控件）；焦点环仍是平台 2px；**几何判据**：逐控件比对改前读数 `screenshots/stroke-before-readings.json`，外框宽高差 0.1px 内为 0（`rest` 38/38、`light` 54/54、`dark` 54/54） | 同上（两门须同时红） |
| `tests/roles.mjs` / `g-hygiene.mjs` | 298/298、6/6 保持 | — |
| `rollout/splice-css.mjs --check` | `rollout/new-panel.css` 与 `client.js` 里的样式表字面量一致 | 改一边不改另一边应报 DIFFERS |

### 13.5 证据

- 改前基线：`screenshots/stroke-before-readings.json`（54 个可见按钮 × 面板/亮/暗三视图）、`screenshots/stroke-inventory-before.json`（79 个使用点的改前类名）。
- 改后读数：`screenshots/stroke-after-readings.json`（三视图 + `states` 四态 × 两主题 + `disabled` + `geometry` 146/146）；逐像素合成：`screenshots/stroke-pixels.json` 与 `screenshots/stroke-after-disabled-crop.png`（deviceScaleFactor 4）。
- 截图：`screenshots/stroke-after-01..04-*.png`（顶栏 / 详情操作行 / 对话框底部按钮行 / 模板抽屉）与 `screenshots/stroke-after-dark-01..04-*.png`。
- 几何冲突原始读数：`screenshots/stroke-geometry-conflict.json`。
- 门输出：`tests/verification/_stroke_after_gate.txt`（浏览器门）、`tests/verification/_stroke_red_<label>.txt`（反证）。
- 枚举：`screenshots/stroke-inventory-after.json` 与 §13.3 表格（`rollout/button-inventory.mjs` 生成）。

### 13.6 实测推翻的假设与取舍记录（2026-10-10）

本节记 §13.2 各条决定在实测中被推翻、修正或强化的地方，**不偷偷换方案**：每处都写清为什么、以及原始读数落在哪个文件。

**1）D6「外框尺寸不变」被实测推翻：`box-sizing:border-box` 不吸收自动宽度控件的 1px 描边。**
原始读数 `screenshots/stroke-geometry-conflict.json`（`rollout/geom-physics.mjs`：对同一控件先注入 `border:none !important`、再注入 `border:1px solid red !important`，交付态 padding 不动，差值就是描边的裸代价）：

| 控件 | 交付态 padding-left | 去边宽 | 加边宽 | Δ宽 | Δ高 |
|---|---|---|---|---|---|
| 顶栏 刷新 | 13px | 52.00 | 54.00 | +2.00 | 0.00 |
| 顶栏 新建需求 | 12px | 76.00 | 78.00 | +2.00 | 0.00 |
| 对话框 新建角色 | 13px | 82.00 | 84.00 | +2.00 | 0.00 |
| 行内 编辑 | 9px | 42.00 | 44.00 | +2.00 | 0.00 |
| 预设 登记角色 | 9px | 66.00 | 68.00 | +2.00 | 0.00 |
| 删除角色（outline） | 10px | 68.00 | 70.00 | +2.00 | 0.00 |

原因：`box-sizing:border-box` 只在宽度确定时把 border 算进盒内；这些按钮宽度是内容+padding+border 的自动宽度，于是 border 直接长到外框上。改前 `border-width` 为 0 的控件里，有 22 个是这次新增描边的对象。

**2）取舍（用户 2026-10-10 裁决，方案 B）：保留 1px 真 border，按档位从水平 padding 各回补 1px，做到外框零变化。**
标记集合（`screenshots/stroke-inventory-after.json` 的 `counts`，由枚举脚本与 codemod 双向核对）：`rb-btn` 79/79 使用点；`rb-btn-pad` 56 个；`rb-btn-sm` 57 个；`rb-btn-primary-stroke` 11 个。
回补值：中性/主按钮 md 14→13、sm 10→9；**顶栏主按钮 13→12**（它改前 padding 来自面板规则 `.rb-btn-primary.rb-btn-primary`，不是平台基准 14，见 §13.1）。
**不回补**的集合同样是硬约束：顶栏三个（`.rb-header .rb-btn.rb-btn` 已给 1px l2）、详情操作行六个（`.rb-detail-actions button` 已给 1px l2 + 11px padding）、全部 `outline` 站点（0.5px 计算宽度、1px 布局宽度，实测 0.00 变化）——回补反而会缩 2px。顶栏主按钮另有自己的 (0,4,0) 规则给出 12px，所以不挂 `rb-btn-pad`，否则两条同权 padding 只能靠源码顺序分胜负。
验收口径是**逐控件**而不是抽样：三视图共 146 个控件外框宽高在 0.1px 精度内全部不变（`rest` 38/38、`light` 54/54、`dark` 54/54），读数在 `screenshots/stroke-after-readings.json` 的 `geometry`，同一判据也进了渲染门。

**3）新发现：`--rb-accent-strong` 在 portal 出来的对话框里解析不到，`var()` 落回 `currentColor`。**
`--rb-accent*` 只声明在 `.rb-root`（`rollout/new-panel.css:10-34`），而平台 `Dialog` 把内容 portal 到 `.rb-root` 之外，于是对话框内按钮的 `border-color:var(--rb-accent-strong)` 是无效值，computed 值变成 `currentColor`。实测（探针第一版）：对话框内主按钮的描边读数是 `rgb(255,255,255)`（亮）/ `rgb(15,17,21)`（暗），即各自的前景色，而不是 accent。
修法：只在主题载体上补声明这一个 token（`body` / `body:not([data-ds-dark-theme])`，`rollout/new-panel.css:35-44`）——portal 出来的表面继承它。修后读数 `rgb(154,52,18)`（亮）/ `rgb(255,119,51)`（暗）。面板内完全不受影响：`.rb-root` 自己的声明仍然赢，`--rb-accent:` 仍是一主题一条。

**4）主按钮描边的范围 = 全部 `variant:'primary'` 站点，而不是只有带 `rb-btn-primary` 的那一个。**
`rb-btn-primary` 类只有 1 个使用点（顶栏「新建需求」）；D2 的「主按钮」是 12 个 `variant:'primary'` 站点，其中 11 个沿用平台填充（亮色近黑、暗色近白）。中性 l3 描边压在同亮度填充上等于没有描边——反证读数在 `screenshots/stroke-pixels.json`：同一个主按钮，交付的 accent-strong 描边 Δ(描边,填充) = **139**（亮）/ **200**（暗）；把描边换回 l3 后 Δ = **3** / **1**（差 1–3/255，肉眼不可辨）。
因此新增只带描边的标记 `rb-btn-primary-stroke`（11 个站点），只写 `border-color`，不动填充、高度、padding、字重。它不能复用 `rb-btn-primary`，因为那条规则连填充一起改（会把 36px 高的平台主按钮压成 32px 概念按钮）。

**5）详情操作行的描边色保持 l2，不是 l3。**
这 5 个 ghost 按钮改前就是 1px l2，是既有的有意设计；换成 l3 是可见变化且没有需求要求，所以用等权重作用域规则 `.rb-detail-actions .rb-btn.rb-btn`（0,3,0）保住 l2，几何不受影响。
该行唯一可见的颜色变化是危险按钮「删除角色」：改前 (0,2,0) 的 `color-mix(in srgb, error 30%, transparent)` 现在被 D2 要求的满色 `--dsw-alias-state-error-primary` 覆盖，亮 `rgb(236,19,19)` / 暗 `rgb(242,90,90)`。这是 D2 的既定要求，如实记为**可见变化**，不写成「零变化」。

**6）禁用态：不透明中性，穿过平台的 40% 不透明度。**
平台 `.button:disabled{opacity:.4}` 会把描边一起淡掉，D5 因此把禁用描边定为 `--dsw-alias-label-tertiary`（不透明）。逐像素读数（`stroke-after-disabled-crop.png`，deviceScaleFactor 4，由 `rollout/png-read.mjs` 解码而非复述 computed 值）：禁用按钮的描边与填充合成差 Δ = **48**（亮）/ **31**（暗），描边在合成后仍可辨。面板里 2 个真实禁用按钮（派发、完成并推进）读数 `1px solid rgb(129,133,140)` + `opacity:0.4`。

**7）四态与焦点环并存。**
四态 × 两主题读数在 `screenshots/stroke-after-readings.json` 的 `states`（6 个代表控件：面板 ghost sm、对话框 ghost md、对话框 ghost sm、对话框 danger sm、对话框 primary sm、表单 primary md）：default / hover / active / focus-visible 四态下描边都是 1px、solid、同一颜色。`focus-visible` 臂只声明 `border-color`，焦点环仍是平台自己的（`packages/client/ui-theme/src/styles/focus.css:10-13`，实测 `outline 2px` 亮 `rgb(65,118,230)` / 暗 `rgb(122,170,255)`），两者并存而不是互相顶掉。

---

## 14. 模板抽屉的「新建 / 复制」表单弹窗（第二层表单 · 未保存处置 · 错误落位 · 焦点归还）

**状态（2026-10-10）**：规格定稿于本节（看板 `req_8d1c3c36ef`，用户 2026-10-10 指定「与角色管理的新建弹窗一致」）；实现与两门读数在 §14.7 回填。本节只把 `req_0a88e9eed7` 的 `RoleFormDialog` 形态（§12.2 D2）搬到模板抽屉的「新建流程模板」，并顺带处置同形态的「复制」入口（需求把这一条交给设计节点定）。

### 14.1 现状（实测，2026-10-10 评审复核）

改前读数由 `rollout/template-dialog-evidence.mjs` 采集，落 `screenshots/template-before-readings.json`（亮色，1440×900，未改字节）：

| 验收面 | 改前实测 | 表现 |
|---|---|---|
| 弹窗形态 | 点「新建流程模板」后 `[role=dialog]` 个数仍为 **1**；`.rb-drawer-list .rb-panel` 出现 | 表单**就地展开在左列表列内**（`client.js:4339-4368`），不是第二层（与 §12.1 同源毛病） |
| 字段与动作行 | `template.new.name` / `.description` / `.nodes` 齐备；提交 `template.create` 是 `<button type="button">`、**不在任何 `<form>` 内** | Enter 不提交；提交按钮 `onClick` 直连 `createNew` |
| 焦点进入 | `data-modal-autofocus` 元素 **不存在**；点开后 `document.activeElement` 仍是 `template.new` 自己 | 焦点没有进入表单 |
| 键盘 / 未保存 | 填好名称与节点后按 Esc：`[role=dialog]` 个数 → **0** | Esc 被**抽屉自己的** Modal 收走，抽屉整体关闭，草稿**静默丢弃**（实测 `document.activeElement` 落回页头「流程模板管理」） |
| 错误落位 | 触发真实拒绝（51 行节点 → `template "nodes" must hold at most 50 entries`）后，同一句错话在页面上出现 **2 次**：抽屉内 `.rb-notice-error` ＋ `shell.overlay` 的应用 toast（`[role=alert]`） | 失败原因与发起处分离，且与抽屉内提示**重复** |
| 复制入口 | 点「复制」后仍是就地形态：只有 `template.clone.name`，提交 `template.clone.confirm`（`type=button`，不在 form 内），提示 `templateCloneHint` 在一行 `.rb-field-label` 里 | 与「新建」两种形态（需求第 2 条点名） |
| portal 与 token | `body` / `.rb-dialog-drawer` / `.rb-template-row-picked` 上 `--rb-accent`、`--rb-accent-line`、`--rb-accent-soft`、`--rb-tint-error`、`--rb-on-accent` **全部解析为空**，只有 §13.6 修过的 `--rb-accent-strong` 有值（`#9a3412`） | 选中行 `.rb-template-row-picked` 的 `border-color:var(--rb-accent-line)` 落回 `currentColor`：实测 `rgb(15,17,21)`，`box-shadow`（accent 竖条）为 `none` |

最后一行是本节新测到的**既有**事实，不是本条引入的：抽屉本身就是一个被 portal 到 `.rb-root` 之外的 `Dialog`，所以 §13.6 第 3 条那条机制（portal 出来的表面继承不到 `.rb-root` 的自定义属性）适用于整个 `--rb-accent*` / `--rb-tint-*` 族，而不只是描边那一个 token。取舍见 §14.8 第 1 条。

### 14.2 形态决定

**D1 第二层表单弹窗，两个入口共用一层。** 新增 `TemplateFormDialog`，用 `Dialog` 包一层平台 `Modal`，**不给 `className`**，于是它落在默认档 `.rb-dialog`（`min(560px,100%)`）——与角色表单弹窗同档（§12.7 实测 560px）。两个入口写同一个 `form` 状态：`template.new`（mode `new`）与 `template.clone`（mode `clone`）。理由：需求第 2 条推荐复用同一套表单层；两个入口两套形态正是本条要消灭的「新的不一致」，而就地展开的那两块（`:4339-4368`、`:4431-4448`）随之删除。标题写明对象，与 §12.2 D2 同一纪律：新建用 `newTemplate`，复制用 `templateCloneTitle` = `复制 · {name}`（`{name}` 是被复制的那个模板，来自 `row.name`）。

**D2 字段与动作行照现状，控件名进门的断言面。** `new`：`template.new.name`（`Input`，带 `data-modal-autofocus`）、`template.new.description`、`template.new.nodes`（`textarea`，`placeholder` 仍是 `templateNodesExample`，`minHeight:90`）。`clone`：`template.clone.name`（带 `data-modal-autofocus`）＋一行 `.rb-muted` 的 `templateCloneHint`（就是就地形态放在 `.rb-field-label` 里的那句）。动作行在 `form` 内：提交 `template.create`（`new`）/ `template.clone.confirm`（`clone`），`type:'submit'`、`variant:'primary'`、带 `rb-btn-primary-stroke rb-btn-pad rb-btn-sm rb-btn`，`disabled` 沿用现状判据 `busy || name 空 || （new）nodes 空`；取消 `template.form.cancel`，`type:'button'`、ghost。取消按钮**这轮才拿到 `name`**：就地形态那个取消没有任何名字（`:4367`、`:4447`），门无法寻址；这不是改名，是随旧标记一起消失后新加的可寻址锚点。

**D3 必填校验落位在弹窗内（就地说明缺什么）。** 提交在必填为空时仍为 `disabled`（沿用现状），同时表单内常驻一行 `.rb-muted`：名称空显示 `templateNameRequired`，`new` 下节点空再显示 `templateNodesRequired`，两项都满足则整行不渲染。理由：验收第 4 条要求「必填校验…显示在弹窗内」，而一个禁用的提交按钮只表达了「不能提交」，没有说出缺什么；这一行是纯派生值（由草稿算出），不新增状态。

**D4 失败落位在弹窗内，且不与抽屉重复。** `TemplateDrawer` 新增 `invokeQuiet` 属性，取 `BoardPage` 已有的 `invokeQuietly`（`:5252-5262`），只用在表单这两条写命令（`template.create` / `template.clone`）上：拒绝时**不弹**应用 toast（不发 `controller.notify`）、**不写**抽屉的 `notice`，错误交给弹窗自己的 `template.form.error` 块（复用 §12 的 `.rb-form-error`，文案 `templateFormError` ＋ Host 原文），弹窗保持打开、草稿留在屏上。理由：§12.2 D6 的同一条判据——toast 会淡出而草稿还在；实测改前同一句错话出现两次（§14.1），本决定正是消掉那次重复。抽屉其余路径（详情读失败、版本冲突提示、裁剪、迁移、归档、删除）继续走原来的 `run` / `invoke`，一行不动。

**D5 Enter 提交、Esc 取消、Tab 被顶层限制。** body 顶层是 `h('form', { onSubmit })`，提交按钮 `type:'submit'`，取消 `type:'button'`——于是任一字段里按 Enter 走原生表单提交，取消按钮不会顺手提交。Esc 与遮罩不再被抽屉收走：表单是第二层，`useModalLayer`（`packages/client/ui-primitives/src/useModalLayer.ts`）只把 Esc/Tab 交给栈顶，关的是**表单**（改前实测 Esc 关掉整个抽屉，见 §14.1）。焦点进入由 `[data-modal-autofocus]` 决定（平台层栈的初始焦点顺序），关闭时层栈把焦点还给「记录在挂载时刻的 `document.activeElement`」，也就是点开的那个按钮——`template.new` / `template.clone`。

**D6 未保存处置：先问再丢，问的时候不丢输入。** 草稿与开表单时的初值比对（`sameTemplateDraft`：`new` 比 `name`/`description`/`nodes`，`clone` 比 `name`）。没改过 → 直接关；改过 → 表单内出现确认条（`templateDiscardConfirm` ＋ `template.discard.drop`（outline）/ `template.discard.keep`（ghost）），复用 `.rb-panel` ＋ `.rb-row`，与 §12.2 D7 同形。确认条在屏时，Esc / 遮罩 / 关闭控件**收回确认条**而不是输入，丢弃始终是一次显式动作。**「关抽屉时草稿怎么办」不存在这条路径**：表单在顶层的遮罩之后，抽屉自己的关闭控件在表单开启期间不可达（平台层栈），所以草稿不会被抽屉带走；抽屉自己的状态（列表、`includeArchived`、`selectedId`）住在 `TemplateDrawer` 里，不住在表单里，关表单不碰它们。

**D7 保存成功：关窗 ＋ 沿用现有重读，不新增读。** `new`：`template.create` → `templateMutated` toast（不变）→ 关表单、清草稿 → `loadList(includeArchived)` → `setSelectedId(created id)`；选中项一变，抽屉既有的 `useEffect`（`:3782-3794`）就 `loadDetail(row.id)`，版本区随之刷新——这就是验收第 3 条说的「按现有方式刷新列表与版本区」，新增 0 次读。`clone`：`template.clone` → `templateCloned` toast → 关表单 → `loadList`，与 `:3969-3975` 完全一致。失败则两条路径都停在弹窗内（D4）。

**D8 就地删除 / 裁剪 / 归档确认条不动。** 抽屉里的 `deleting`、`deleteArmed`、`pruneTarget` 三个就地确认块与详情编辑体都不是本条的对象：需求只点了「新建」并让设计节点处置「复制」，删除/裁剪只有「明确不碰」的约束、没有要改的诉求。它们留在原处（枚举见 §14.4），一行不动。

### 14.3 状态矩阵

| 状态 | 表现 | 判据 |
|---|---|---|
| 空（必填未填） | 提交 `disabled`；表单内 `.rb-muted` 说明缺名称 /（新建）缺节点 | D3，门读 `template.create` 的 `disabled` 与那句提示 |
| 加载（命令在飞） | `busy === true`：提交与取消都 `disabled`；表单不关闭 | 沿用 `busy`（`invokeQuietly` 也走同一个 `setBusy`），不新增第二套忙态 |
| 失败（Host 拒绝） | 弹窗内 `template.form.error`；无 toast；草稿保留 | D4，门读该块存在且抽屉内无同句 |
| 未保存（关窗时草稿已改） | 确认条 ＋ 丢弃 / 继续编辑；Esc 先收确认条 | D6，门读 `template.discard.drop` / `.keep` |
| 未保存（关抽屉） | 不可达：顶层的遮罩压住抽屉的关闭控件 | D6 末段 |
| 保存成功 | 关窗 → 列表 / 版本区按现路径刷新；抽屉筛选与选中不丢 | D7，门读关窗后 `includeArchived` 勾选与选中行 |

### 14.4 明确不动（抽屉内入口逐个枚举）

改前后逐字节保留：`Dialog` footer 的「关闭」；列表筛选 `includeArchived` `Checkbox`；列表行 `.rb-template-row`（**非按钮控件**，不加 `rb-btn`，`role="list"` 容器 `.rb-template-rows` 不变）；详情操作行 `template.edit` / `template.migrate` / `template.archive` / `template.delete`；结构编辑器 `template.node.*`（含 `template.node.add`、`template.node.check.*`）、`template.edit.cancel`、`template.revise.save`；元数据字段与 `template.metadata.save`；版本历史 `template.prune.<revision>` 与就地裁剪确认条；归档/删除的就地确认条（`template.delete.confirm` 与其取消）；`MigrateTemplateDialog`（本来就是 Modal）；空态 `templateEmpty`、内置 `templateBuiltin` / 归档 `templateArchived` 标签与各计数。**只有两处消失**：新建的就地表单（`:4339-4368`）与复制的就地面板（`:4431-4448`），它们的字段名被 D2 原样搬进弹窗。`template.clone` 按钮本身位置、文案、`disabled` 不变，只有 `onClick` 从 `setCloning(true)` 变成开表单（与 `template.new` 一样）。`role.*` 命令契约、`template.*` 命令契约、`host/**`、`packages/**`、其它面板一律不碰。

### 14.5 实现落点与门的断言面

| 落点 | 位置（改前行号） | 门的锚点 |
|---|---|---|
| 新建按钮改开表单 | `client.js:4331-4338` | `name="template.new"` |
| 复制的就地面板删除、入口改开表单 | `:4287`、`:4431-4448` | `name="template.clone"` |
| 新增 `TemplateFormDialog` | 紧邻 `RoleFormDialog`（`:2359-2426`）之后 | 第二层 `[role=dialog]`（个数 2）且顶层含 `form [name="template.new.name"]`（复制时 `template.clone.name`） |
| 新增 `sameTemplateDraft` | 紧邻 `sameRoleDraft`（`:2304-2309`） | 未保存确认条 |
| `TemplateDrawer` 接 `invokeQuiet` | 挂载点 `:5798-5808` | 拒绝时 `template.form.error` 有值、抽屉内无同句、无 toast |
| 字典 | `client.js` `DICT.en`（模板段 ~`:452-480`）/ `DICT.zh`（~`:862-882`） | `client-smoke` 的 en/zh 键对齐断言 |

**新增字典键 7 个**（en/zh 对齐，均落在模板段）：`templateCloneTitle`、`templateNameRequired`、`templateNodesRequired`、`templateFormError`、`templateDiscardConfirm`、`templateDiscardConfirmDrop`、`templateDiscardConfirmKeep`。复用既有键：`newTemplate`、`templateName`、`templateDescription`、`templateNodes`、`templateNodesHint`、`templateNodesExample`、`create`、`templateClone`、`templateCloneHint`、`cancel`、`close`。

**样式改动 0 行。** 表单只用既有的 `.rb-field` / `.rb-muted` / `.rb-textarea` / `.rb-form-error` / `.rb-panel` / `.rb-row` 与既有按钮标记类，`rollout/new-panel.css` 一行不改——因此 `--rb-accent:` 仍是恰好两处、样式表里仍无颜色字面量、`splice-css --check` 平凡 in sync。这条也是 §14.4「不动」的一部分：本条不借机重绘任何既有表面。

### 14.6 门与反证

| 门 | 覆盖 | 命令 |
|---|---|---|
| `tests/client-smoke.mjs` | 弹窗开关（第二层 `[role=dialog]` 个数）、焦点进入的 `data-modal-autofocus`、Enter 提交（`form` ＋ `type=submit`）、取消关闭、错误落位（`template.form.error`，无 toast）、未保存三态（改过才问、丢弃关、继续留）、必填提示、复制入口同层 | `node tests/client-smoke.mjs`（基线 464/464） |
| `tests/verification/panel-render.e2e.mjs` | 真浏览器三条：①新建走弹窗（顶层 dialog ＋ 字段齐全 ＋ 弹窗宽 560 与角色表单同档）；②Esc 关表单不关抽屉、焦点回到 `template.new`（实测 `document.activeElement`）；③错误落位（真实 `invalid-argument` 拒绝落在弹窗内、抽屉内无同句、无 toast）＋ 关窗后抽屉筛选与选中不丢 | `node tests/verification/panel-render.e2e.mjs http://127.0.0.1:3110 <token>`（基线 71/71） |
| `tests/roles.mjs` | 角色面不受影响 | `node tests/roles.mjs`（基线 298/298） |
| `tests/verification/g-hygiene.mjs all` | 仓库卫生 | `node --import tsx/esm tests/verification/g-hygiene.mjs all`（基线 6/6） |
| 反证 | 两门同时红、再同时绿 | `node rollout/counter-proof.mjs <label> <pattern> <replacement> --file=client.js --no-splice` |

反证的目标是**声明的控件名**而不是 CSS：本条样式改动为 0 行，改 CSS 打不到新断言（§13 的 CSS 反证在这里不适用）。`counter-proof.mjs` 因此扩了一个可选的 `--file=`（默认仍是 `new-panel.css`，§13 的用法逐字不变）与 `--no-splice`，并新增「先备份、后写回」的逐字节还原。两条反证：`discard-name`（`template.discard.drop` 改名 → 未保存处置的两门断言同时红）与 `error-name`（`template.form.error` 改名 → 错误落位的两门断言同时红）。

### 14.7 读数（build / verify 节点回填，2026-10-10）

**改后实测**（同一支探针 `rollout/template-dialog-evidence.mjs`，亮色 1440×900；改前 `screenshots/template-before-readings.json`，改后 `screenshots/template-after-readings.json`，截图 `template-before-00..09-*.png` / `template-after-00..09-*.png`）：

| 读数 | 改前 | 改后 |
|---|---|---|
| 点「新建流程模板」后 `[role=dialog]` 个数 | **1**（就地展开） | **2**（第二层弹窗；顶层是 `rb-dialog`，实测宽 **560px**，与角色表单同档） |
| 表单字段所属层 | `.rb-drawer-list` 内就地 | 顶层弹窗内（`insideTopDialog`），抽屉列表内已无表单 |
| `data-modal-autofocus` / 进入焦点 | 无 / 仍是 `template.new` | `template.new.name` / `document.activeElement` = **`input[name=template.new.name]`** |
| 提交控件 | `<button type="button">`，不在 `<form>` 内 | **`type="submit"`，`insideForm: true`** |
| Esc（草稿已改） | `[role=dialog]` → **0**：抽屉被关、草稿静默丢失、焦点落回页头「流程模板管理」 | `[role=dialog]` 仍 2：抽屉在、草稿在、确认条在（`discardAsked: true`） |
| 关窗后焦点（`document.activeElement`） | 页头「流程模板管理」 | **`button[name=template.new]`**（层栈归还给调用控件） |
| 关窗后抽屉状态 | 抽屉已不在（`archived: null`，选中行 0） | 抽屉在，`includeArchived: true`、选中行仍是「标准研发流程」 |
| 错误落位（真实 51 行节点被拒） | 同一句错话出现 **2 次**：抽屉 `.rb-notice-error` ＋ 应用 toast | **1 次**：仅弹窗内 `.rb-form-error`；抽屉内无同句，`[role=alert]` 计数 0（无 toast） |
| 复制入口 | 就地：只有 `template.clone.name`，`type=button` | 第二层弹窗：`template.clone.name`（`data-modal-autofocus`）、`type=submit`、标题「复制 · 标准研发流程」 |

**四门数字**（改前 → 改后；命令见 §14.6）：

| 门 | 改前 | 改后 |
|---|---|---|
| `tests/client-smoke.mjs` | 464/464 | **489/489**（+25：弹窗开关与层归属、`data-modal-autofocus`、`type=submit` 与无 `onClick`、必填提示逐项消失、拒绝落位＋不重复＋不重读、未保存三态、抽屉状态保留、复制入口同层） |
| `tests/verification/panel-render.e2e.mjs` | 71/71 | **87/87**（+16：①新建弹窗的形状（2 层 / 560px / 真 submit / 取消可寻址 / 焦点进入）②Esc 归表单＋丢弃后焦点回到 `template.new`＋抽屉勾选与选中不丢 ③真实拒绝落弹窗内、抽屉无同句、无 toast、草稿仍在，另加控制台错误记账收尾） |
| `tests/roles.mjs` | 298/298 | 298/298（未改角色面） |
| `tests/verification/g-hygiene.mjs all` | 6/6 | 6/6 |

**同步与字节**：`rollout/sync-deployment.mjs` 报 `recheck: 0 differing`。`client.js` 改后 sha256 = `4159DE52EF85E34E62C9E3428D68B332A2FC333B407BA2DE07D5E33EC405F184`；`rollout/splice-css.mjs --check` 报 `in sync`，且一次真实 splice 前后 `client.js` 哈希不变（样式改动 0 行，见下）。

**反证记录（两门同时红、再同时绿，逐字节还原）**：

| 记录 | 改动 | 破坏时 | 还原后 |
|---|---|---|---|
| `tests/verification/_discard-name_red.txt` | `client.js`：`name: 'template.discard.drop'` → `…drop.off'` | `client-smoke` **RED**（在 `byName('template.discard.drop')` 处中止）；`panel-render` **RED**（`FAIL Esc 关的是表单：抽屉仍在（true），未保存先问（false/true）`） | 489/489 ｜ 87/87，`byte restore (client.js): exact` |
| `tests/verification/_error-name_red.txt` | `client.js`：`name: 'template.form.error'` → `…error.off'` | `client-smoke` **RED**（488/489：`a refused create is reported inside the form`）；`panel-render` **RED**（86/87，两条：`a refused create is reported inside the form` ＋ `拒绝落在弹窗内（2 层，error=false）`） | 489/489 ｜ 87/87，`byte restore (client.js): exact` |

改一处的**声明值**（门的断言面）而不是 CSS：本条样式改动 0 行，改 CSS 打不到新断言（§13 的 CSS 反证在此不适用）。两条都要求两门同时红再同时绿，脚本对红/绿都打印逐条 FAIL 与两门分数，并用逐字节比对证明还原（`--report` 让脚本自己以 UTF-8 写记录，避免 shell 转码污染记录）。

**改动行范围**（`rollout/changed-lines.mjs`，对 git 跟踪副本做 `git diff --no-index -U0`）：

| 文件 | 段数 | 增/删 | 主要落点（改后行号） |
|---|---|---|---|
| `client.js` | 20 | +180 / −69 | 469..475、886..892（`DICT.en`/`DICT.zh` 各 7 键）｜2352..2367（`sameTemplateDraft`）｜2458..2525（`TemplateFormDialog`）｜3765..3789（`TemplateDrawer` 签名与状态）｜4068..4148（`openForm`/`patchForm`/`dropForm`/`attemptCloseForm`/`cloneTemplate`/`createNew`）｜4433、4483（两个入口 `onClick`）｜4484、4547..4558（就地表单与就地复制面板换成弹窗外挂）｜5914（挂载点传 `invokeQuiet`） |
| `DESIGN.md` | 1 | +122 / −0 | 861..982（本节 §14） |
| `tests/client-smoke.mjs` | 12 | +168 / −15 | 1134..1151（通用辅助上移：`dialogs`/`masks`/`insideTopDialog`/`innerDialog`/`withClass`）｜1287..1318（复制入口改走表单提交）｜1344..1477（新建弹窗 25 条）｜1901..1905（删除后置重复定义） |
| `tests/verification/panel-render.e2e.mjs` | 1 | +147 / −0 | 964..1110（三条真浏览器判据 ＋ 控制台错误记账） |

**交付与同步**：开发树 `.artifacts/requirement-board/`（权威）→ `rollout/sync-deployment.mjs` 同步到部署副本 `%USERPROFILE%\.dsh\bundles\dsh-requirement-board`，`recheck: 0 differing`（586 个文件）；另同步 git 跟踪副本 `bundles/dsh-requirement-board/`，只搬真变化的交付物与记录共 11 个：`client.js`、`DESIGN.md`、`tests/client-smoke.mjs`、`tests/verification/panel-render.e2e.mjs`、`tests/verification/_panel_render.txt`、`_panel_render.png`、`_template_drawer.png`、`_template_migration.png`、`_role_roster.png`、新增的 `_discard-name_red.txt` 与 `_error-name_red.txt`。**不搬**：`rollout/`（工具，含 dev-only 的 `count-pattern.mjs`、`changed-lines.mjs`）与 `screenshots/`（跟踪副本里没有这个目录）；`locale/zh.json`、`locale/en.json` 逐字节未变。三方逐字节一致（dev ＝ tracked ＝ deployed）已用 `Get-FileHash` 验：`client.js`、`DESIGN.md`、两个测试文件、两条反证记录共 6 个文件全部 True。

**i18n 落点（与验收第 8 条的差异如实记录）**：新增 7 个键进 `client.js` 的 `DICT.en` / `DICT.zh`，经 `locale.register(NS, DICT)` 注册，组件内零硬编码文案；`client-smoke` 的 en/zh 键集合相等断言覆盖这 7 个键。`locale/zh.json` 与 `locale/en.json` **未改**：这两个文件只承载插件清单的 `meta.title` / `meta.description`（共 2 个键，实测），本条不新增面板标题或描述；§12 的角色文案同样落在 `DICT` 而非这两个文件。验收第 8 条字面要求改这两个文件，实际改的是本面板既有的字典面——差异在此写明，不含糊。

**零 `packages/**` 改动**：本条只写开发树与两个副本里的面板交付物，写入清单见上表与「交付与同步」，其中没有 `packages/**` 路径；`sync-deployment.mjs` 本次重写清单（28 个文件）同样只有 `client.js` / `DESIGN.md` / `rollout/**` / `screenshots/**` / `tests/**`，没有 `host/**`。注意：仓库工作区里 `packages/client/ui-primitives/src/markdown/*`、`packages/client/ui-sidebar-documentpreview/*`、`apps/web/tests/document-preview.e2e.ts` 等处的改动**不是本条产生的**（另一条需求的 Markdown 预览工作，未打开过这些文件）。

### 14.8 实测推翻的假设与取舍记录（2026-10-10）

**1）新建表单要进 portal，于是 `--rb-tint-error` 在弹窗里解析为空；本条选择「不扩修 token 族」。**
§14.1 末行实测：`--rb-accent` / `--rb-accent-line` / `--rb-tint-error` 在 `body`、抽屉、选中行上全为空。于是 `.rb-form-error` 的 `background:var(--rb-tint-error)` 在弹窗内是无效声明，合成回 `transparent`（描边与文字用 `--dsw-*`，仍然正确）。选择：**照旧复用 `.rb-form-error`**，因为角色表单弹窗里的同一个块就是这个渲染，而本条要的正是「与角色管理一致」。若按 §13.6 第 3 条把 `--rb-tint-error` 也补到主题载体上，会同时重绘 §12 的角色对话框、抽屉内 `.rb-notice-error`、`.rb-role-confirm` 等表面——那是另一条需求的可见变化，本条明确列为「不碰」。代价如实记录：弹窗内的错误块没有底色，只有描边与红字。同理，`.rb-template-row-picked` 的 accent 描边与竖条在抽屉内一直是坏的（实测落回 `currentColor` / `box-shadow:none`）；本条不动它，因为修它要动同一族载体声明。

**2）`splice-css.mjs --check` 之前不真的比对。**
DESIGN §13.4 把 `--check` 记为「改一边不改另一边应报 DIFFERS」，而脚本原先只打印行数并无条件 `exit 0`。本条把它改成真比对：读回 `client.js` 的样式表字面量，与 `new-panel.css` 逐行比，不一致就打印 `DIFFERS` 并 `exit 1`。这是**加强**既有工具，不削弱任何断言；本条样式改动 0 行，`--check` 在改前改后都是 in sync。

**3）改前 Esc 属于抽屉，不属于表单。**
需求假设「表单在抽屉里就地展开、Esc 是表单的事」。实测（§14.1）：填好字段按 Esc，`[role=dialog]` 从 1 掉到 **0**——Esc 被抽屉自己的 Modal 收走，整个抽屉关闭、草稿静默丢失，焦点落回页头。所以「Esc 取消表单」不是既有的可复用行为，而是 D5 新建的一层。这一条也是验收第 5 条（未保存处置）改前根本达不到的原因。

---

## 15. 面板语义色在 portal 出来的弹层里解析为空（错误块底色 · 选中行强调描边 · 门规改版）

**状态（2026-10-10）**：修 `.rb-root` 之外读不到的四个面板局部变量（`--rb-accent`、`--rb-accent-soft`、`--rb-accent-line`、`--rb-tint-error`）：只在主题载体 `body` / `body:not([data-ds-dark-theme])` 上各补一份，值与该主题的注册表臂一致；`.rb-root` 自己的注册表臂不动。同时把 `tests/client-smoke.mjs` 那条「`--rb-accent:` 恰好出现 2 次」的计数规则换成按规则块解析的结构化判据。

### 15.1 现状（实测，2026-10-10）

§13.6 第 3 条只把 `--rb-accent-strong` 补到了主题载体（`new-panel.css:50-59`），同一族的另外四个仍只在 `.rb-root` 的两臂里（`:11-13`、`:18`、`:29-31`）。平台把 `Modal`/`Dialog` 的内容 portal 到 `.rb-root` 之外（§13.1 的实测链、§14.1 的复现），于是弹层里的 `var()` 取不到值：**声明在计算值阶段被丢弃**，`background` 合成回 `transparent`、`border-color` 保留前一条规则给它的值、`box-shadow` 变 `none`。

改前读数（`rollout/portal-color-probe.mjs`，亮/暗各一遍，落 `screenshots/s15-before-readings.json`）：

| 读数点 | 亮色（改前） | 暗色（改前） | 位置 |
|---|---|---|---|
| 弹层空间的 `--rb-accent` / `-soft` / `-line` / `--rb-tint-error` | 四个全为空 | 四个全为空 | 每个 `[role="dialog"]` 上；同空间只有 `--rb-accent-strong` 非空（§13.6 已补的那个） |
| `.rb-form-error` 底色（模板新建弹窗、角色新建弹窗） | `rgba(0, 0, 0, 0)` | `rgba(0, 0, 0, 0)` | 弹层内，`.rb-root` 之外 |
| `.rb-role-confirm` 底色（角色管理对话框） | `rgba(0, 0, 0, 0)` | `rgba(0, 0, 0, 0)` | 同上 |
| `.rb-role-row-editing` 描边（角色表单弹窗寻址的那一行） | `rgba(0, 0, 0, 0.04)`（= 基础行描边 `border-l1`），`box-shadow: none` | `rgba(255, 255, 255, 0.06)`（同上） | 角色管理对话框里的行，随表单弹窗一起在 `.rb-root` 之外 |
| `.rb-template-row-picked` 描边（模板抽屉） | `rgba(0, 0, 0, 0.1)`（= 基础行描边 `border-l2`），`box-shadow: none` | `rgba(255, 255, 255, 0.12)`（同上） | 抽屉内 |
| `.rb-template-row-picked` 描边（新建/复制弹窗、迁移对话框） | `rgb(15, 17, 21)`（= 自身 `currentColor`） | `rgb(249, 250, 251)`（同上） | 两个弹层内另有一处 `.rb-template-row-picked`，它没有基础行描边可回退，落回 `currentColor` |
| `.rb-notice-hint` 左强调边（迁移对话框） | 左侧 3px 边落回基础描边 | 同上 | 弹层内 |

改前的**面板内**读数（同一脚本的 `.rb-root` 面板探针，425 个 `rb-*` 元素逐一取计算值）已经是对的：`.rb-card-selected` / `.rb-node-active` 描边 = `rgba(194, 65, 12, 0.35)`（亮）/ `rgba(240, 100, 35, 0.35)`（暗），错误块 tint 探针、危险状态标签探针、已走边探针都取到了值。**这就是本条的边界**：坏的只有 portal 出去的那几个表面，而不是 token 定义本身。

**受影响清单**（五个表面 × 两主题，逐个列，不抽样；截图见 `screenshots/s15-{before,after}-<palette>-<NN>-<surface>.png`）：

| # | 表面 | 打开方式（脚本里的真实操作） | 改前 → 改后 |
|---|---|---|---|
| 00 | 面板本体 `.rb-root` | 打开看板 | 不受影响（面板内自己的声明仍然赢；425 个元素 + 5 个状态探针逐条比对） |
| 01 | 角色管理对话框 | 点页头「角色管理」 | 受影响：`--rb-accent*` / `--rb-tint-error` 从空 → 有值；`.rb-role-confirm` 底色 `transparent` → tint |
| 02 | 角色表单弹窗（编辑态） | 对话框中点某行「编辑」 | 受影响：寻址行 `.rb-role-row-editing` 描边从基础行描边 → 该主题强调线，`box-shadow` 从 `none` → 强调竖条 |
| 02b | 角色表单弹窗（新建态 + 非法 id 被拒） | 点「新建」，id 填 `Human`（违反 Host 的 `^[a-z][a-z0-9_-]{0,31}$`，拒绝且不写盘） | 受影响：`.rb-form-error` 底色 `transparent` → tint |
| 03 | 模板抽屉 | 点页头「流程模板管理」 | 受影响：`--rb-accent*` 从空 → 有值；选中行 `.rb-template-row-picked` 描边从基础行描边 → 强调线 |
| 04 | 模板新建弹窗（51 行节点被拒） | 抽屉里点「新建」，节点填 51 行（超过 Host 的 50 节点上限，拒绝且不写盘） | 受影响：`.rb-form-error` 底色 → tint；同层选中行描边 → 强调线 |
| 05 | 迁移对话框 | 抽屉里点选中行的「迁移」 | 受影响：`--rb-accent*` 从空 → 有值；`.rb-notice-hint` 左强调边恢复 |

### 15.2 形态决定

**D1 只写主题载体，不写 `:root`。** 弹层要读到值，声明必须落在一个「弹层也在其子树里」的元素上。`:root`（= `html`）满足这个条件，但它同时是所有面板、外壳、其它插件页的祖先——`--rb-*` 是**本面板的**命名空间，写进 `:root` 会把面板私有变量变成全局可继承值，任何第三方面板只要同名就会被静默改色，而且浏览器门看不到这种污染（值照样解析成功）。主题载体 `body` / `body:not([data-ds-dark-theme])` 是 §13.6 已经为 `--rb-accent-strong` 选定的落点：既在弹层祖先链上，又仍在「一个主题一个臂」的既有结构里。代价：声明与 `.rb-root` 的注册表臂重复一次色值。

**D2 每臂各写一份 `--rb-tint-error`，尽管它与主题无关。** `--rb-tint-error` 的值是 `color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)`，两个主题臂取的是同一个平台 token（平台自己按主题给不同的红）。若只写一份（例如只写亮色臂），规则就要退化成「某个载体上有就行」，两臂就无法用同一条判据检查。选择：**tint 在两个载体臂里各写一份完全相同、不含主题色值的表达式**，换来的是「载体必须为该主题把这一族变量声明全」这条统一判据，以及「漏掉任一臂即红」。多出的一个字面重复是明码代价。

**D3 不新增变量、不改 token 定义。** 补的是四个既有变量，值直接抄同主题注册表臂的字面值；`--dsw-*` 只读，不新增、不覆盖。

### 15.3 状态矩阵（消费者 × 表面 × 主题）

| 消费者（`new-panel.css` 行） | 变量 | 面板内（`.rb-root`） | 弹层内（portal 出去） |
|---|---|---|---|
| `.rb-form-error`（`:576-579`） | `--rb-tint-error` | 改前对 → 改后对 | **改前 transparent → 改后 tint** |
| `.rb-role-confirm`（`:568-571`） | `--rb-tint-error` | 改前对 → 改后对 | **改前 transparent → 改后 tint** |
| `.rb-role-row.rb-role-row-editing`（`:593-594`） | `--rb-accent-line`、`--rb-accent` | 无生产方 | **改前基础描边＋`box-shadow:none` → 改后强调线＋强调竖条** |
| `.rb-template-row.rb-template-row-picked`（`:533-534`） | `--rb-accent-line`、`--rb-accent` | 无生产方 | **改前基础描边 / `currentColor` → 改后强调线** |
| `.rb-notice-hint`（`:480`） | `--rb-accent` | 改前对 → 改后对 | **改前落回基础描边 → 改后左强调边** |
| `.rb-card-selected`（`:271-272`） | `--rb-accent-line` | 改前对 → 改后对（无弹层表面） | — |
| `.rb-node-active`（`:422-423`） | `--rb-accent-line`、`--rb-accent-soft` | 改前对 → 改后对（无弹层表面） | — |
| `.rb-filters .rb-chip.rb-chip-on`（`:225-226`） | `--rb-accent-line`、`--rb-accent-soft`、`--rb-accent` | 改前对 → 改后对（无弹层表面） | — |
| `.rb-edge-done`（`:410-411`） | `--rb-accent-line` | 改前对 → 改后对（无弹层表面） | — |
| `.rb-stag-danger`（`:375-376`） | `--rb-tint-error` | 改前对 → 改后对 | — （**无生产方**，见 §15.8） |
| `.rb-gate-blocking`（`:394-395`） | `--rb-tint-error` | 改前对 → 改后对 | — |

### 15.4 明确不动

- **`.rb-root` 的两个注册表臂**：色值、选择器、顺序都不动。面板内零回归是**由层叠保证的**：元素自己的声明（`.rb-root` 上的）胜过它本来会从 `body` 继承的那份，浏览器门用逐元素读数证明这一点。
- **`--rb-accent-strong`**：§13.6 已经补过，本条不重复声明、不改值。
- **同族的其它变量**：`--rb-tint-success` / `--rb-tint-warn` / `--rb-tint-info` / `--rb-violet-soft` 在弹层内同样解析为空（`.rb-req-link` 的 `--rb-tint-info`、`.rb-notice-ok` 的 `--rb-tint-success` 等）。它们不在本条范围（需求只列了四个变量），**改前改后都为空**，属既存缺陷，逐条记在 §15.7 的「不受影响但同因」栏，不做静默扩修。
- **行为、文案、布局位置**：只补颜色解析，不动任何交互、`DICT`、结构；`locale/zh.json` / `locale/en.json` 逐字节不变。
- **`packages/**`、`host/**`**：零改动。

### 15.5 实现落点与门

**样式**（`rollout/new-panel.css` → `client.js`，经 `rollout/splice-css.mjs`）：

| 落点 | 改前 | 改后 |
|---|---|---|
| 主题载体（`:50-59`） | 两臂各只有 `--rb-accent-strong` 一条 | 两臂各补 `--rb-accent` / `--rb-accent-soft` / `--rb-accent-line` / `--rb-tint-error`，值与该臂注册表逐字一致 |
| `.rb-template-row.rb-template-row-picked`（`:533-534`） | `.rb-template-row-picked`（一类，被 `.rb-template-row:hover` 压掉） | 双类提权，选中描边在悬停时也生效 |
| `.rb-role-row.rb-role-row-editing`（`:593-594`） | `.rb-role-row-editing`（一类，被后置的 `.rb-role-row` 与 `:last-child` 压掉） | 双类提权，并移到基础行规则之后 |

`client.js`：样式表字面量 `1556..2229`（672 行），文件 6006 行。改前 sha256 `4159DE52EF85E34E62C9E3428D68B332A2FC333B407BA2DE07D5E33EC405F184` → 改后 `c789495ee92b0cd55e216d91ebce4532b1a2454a5049cb7535d4180b5d44fe4c`。`splice-css --check` 报 `in sync`。

**源码门 `tests/client-smoke.mjs`（`:3202-3274`）**：先用深度计数解析出全部顶层规则（`cssRules`），再由 `declarationsOf(selector, variable)` 返回某选择器下某变量的**全部**声明值（重复不会被悄悄折叠），`declaredOnce` 只在恰好一条时给值。四条新判据：

1. `the registry declares the accent family once per theme arm, with that arm's own values` —— `.rb-root` 与 `body:not([data-ds-dark-theme]) .rb-root` 两臂，各恰好一条 `--rb-accent` / `--rb-accent-soft` / `--rb-accent-line` / `--rb-accent-strong`，且等于该臂字面值（`#f06423` / `#c2410c` 等）。
2. `the registry declares the error tint with the platform's own error token, in both arms` —— `--rb-tint-error` 必须是 `color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)`；亮臂可以不重述（继承基础臂的同一表达式），重述则必须同值。
3. `the theme carrier repeats the portal-reachable family once per arm, matching its own arm` —— `body` 与 `body:not([data-ds-dark-theme])` 两臂，各恰好一条上述**五个**变量，且与该臂注册表一致。
4. `no panel variable is declared on :root, which would leak it into every other panel` —— 整张样式表不含 `:root`，解析出的规则里也没有 `:root` 选择器。

同时删除一条旧断言（`tests/client-smoke.mjs:3384-3386`）：它把载体规则钉成 `body { --rb-accent-strong:#ff7733; }` 的**单行字面拼写**，本条把该规则改成多行后必然变红。它的意图由判据 3 承接并加强：原来只钉 1 个变量、按空格拼写比对，现在按选择器读 5 个变量、每个变量恰好一条、两臂各自对齐。

**数字**：`tests/client-smoke.mjs` 489/489 → **491/491**（4 条新判据取代 1 条计数规则，另删 1 条字面断言）。

**真浏览器门 `tests/verification/panel-render.e2e.mjs`**（新增段落从 `:1318` 起，复用既有的 `closeEveryDialog` 与 `setStrokePalette`；三条判据都先确认目标元素 `closest('.rb-root') === null` 且在 `[role="dialog"]` 内，否则测到的不是 portal 表面；强调线色既不按主题名猜、也不只跟"同一个变量"自比——同时比同空间 `var(--rb-accent-line)` 的解析值**和**该主题的字面值 `rgba(194,65,12,.35)` / `rgba(240,100,35,.35)`）：

1. `portal 出来的错误块在弹层里取到非透明的错误色 tint` —— `.rb-form-error` 底色既不是 `rgba(0,0,0,0)` 也不是 `transparent`，且红通道占优（`rgba(…)` 与 `color(srgb …)` 两种序列化都读得出）。
2. `被表单寻址的角色行在弹层里取到该主题的强调线` —— `.rb-role-row-editing` 的 `border-color` 等于该主题强调线字面值，且 `box-shadow` 不是 `none`。
3. `抽屉的选中行在弹层里取到该主题的强调线` —— `.rb-template-row-picked` 同上。
4. 记账断言：本段只允许留下自己故意触发的两条 409（51 节点模板被 Host 拒），出现第三种控制台错误即红。

**数字**：`tests/verification/panel-render.e2e.mjs` 87/87 → **91/91**。

### 15.6 门与反证

**新门规抓住的三种改坏**（判据编号见 §15.5）：

| 改坏 | 源码门 `client-smoke` | 真浏览器门 `panel-render` |
|---|---|---|
| ① 任一臂的色值改错 | 判据 1（注册表臂）或判据 3（载体臂）变红，并打印该臂五个变量的实际值 | 改的是**载体**臂时：该主题的行描边不再等于字面值 → 判据 2 / 3 变红。只改注册表臂时它看不到——面板内本来就对，这正是职责分工 |
| ② 漏掉一个主题载体的声明 | 判据 3 变红（该臂 `declaredOnce` 返回 `null`） | 该主题的 tint 在弹层里变成 `rgba(0,0,0,0)` → 判据 1 变红 |
| ③ 把变量搬进 `:root` | 判据 4 变红（样式表含 `:root`）**并且**判据 3 变红（`body` 臂不再声明） | 判据 1 变红：`--rb-tint-error` 的值是 `color-mix(…, var(--dsw-alias-state-error-primary), …)`，而平台把这个 token 定义在 `body` / `body[data-ds-dark-theme]`（`packages/client/ui-theme/src/styles/design-platform.css:166`、`:284`）而不是 `html`——声明在 `:root` 上时该引用解析不到，整个变量在计算值阶段失效、tint 回到 `transparent`。只有字面 rgba 的 `--rb-accent-line` 还能解析 |

两条反证记录（`rollout/counter-proof.mjs`，每条都要求两门同时红、再同时绿、逐字节还原）：

| 记录 | 改动 | 破坏时 | 还原后 |
|---|---|---|---|
| `tests/verification/_s15-carrier-line_red.txt` | `new-panel.css`：暗色载体 `--rb-accent-line:rgba(240,100,35,.35)` → `…,.30)` | 两门都红：`client-smoke` **490/491**（判据 3 打印 `body: … --rb-accent-line=rgba(240,100,35,.30) …`）；`panel-render` **89/91**（判据 2 / 3 打印 `dark: role=rgba(240, 100, 35, 0.3) picked=rgba(240, 100, 35, 0.3) line=rgba(240, 100, 35, 0.3)`） | 491/491 ｜ 91/91；`byte restore (new-panel.css + client.js): exact` |
| `tests/verification/_s15-root-move_red.txt` | `new-panel.css`：暗色载体选择器 `body {` → `:root {` | 两门都红：`client-smoke` **489/491**（判据 4 `no panel variable is declared on :root` ＋ 判据 3 打印 `body: --rb-accent=null --rb-accent-soft=null …`）；`panel-render` **90/91**（判据 1 打印 `dark: error=rgba(0, 0, 0, 0)`；亮色仍对，因为亮色臂本来就在 `body:not([data-ds-dark-theme])` 上） | 491/491 ｜ 91/91；`byte restore (new-panel.css + client.js): exact` |

第 ③ 条记录推翻了我自己写 §15.2 D1 时的一个推断（当时把浏览器门当成**看不见** `:root` 污染的那一门）：它其实看得见，而且是以「真坏掉」的方式——`color-mix` 里的平台 token 不在 `html` 上。这条实测理由比原来的「会污染全局」硬。

### 15.7 读数（受影响清单与零回归，2026-10-10）

读数方式：`rollout/portal-color-probe.mjs` 连 3110 上的**真机**（部署副本的字节），亮/暗各走一遍六个表面；每次读数把该表面里**全部** `rb-*` 后代按「标签 + class 序列 + 出现序号」建键，记录每个元素的 border / background / color / box-shadow / stroke / fill / size，另加一组具名目标。`rollout/portal-color-diff.mjs` 按同一键逐元素比对改前/改后，记录落 `screenshots/s15-diff.txt`。

| # | 表面（真实操作） | rb-* 元素 | dump 变化 | 关键读数（改前 → 改后） | 截图 |
|---|---|---|---|---|---|
| 00 | 面板本体 `.rb-root` | 425 × 2 | **0** | 具名目标（`cardSelected` / `nodeActive` / `chipOn` / `cardProject`）与 5 个状态探针全部 identical | `s15-{before,after}-{light,dark}-00-panel.png` |
| 01 | 角色管理对话框 | 106 × 2 | 1 | `.rb-role-confirm` 底色 `rgba(0,0,0,0)` → `color(srgb 0.92549 0.0745098 0.0745098 / 0.12)`（亮）/ `color(srgb 0.94902 0.352941 0.352941 / 0.12)`（暗） | `…-01-roles.png` |
| 02 | 角色表单弹窗（编辑态） | 19 × 2 | 0 | `.rb-role-row-editing`（在下一层对话框里）描边 `rgba(0,0,0,0.04)` → `rgba(194,65,12,0.35)`（亮）、`rgba(255,255,255,0.06)` → `rgba(240,100,35,0.35)`（暗）；`box-shadow: none` → 强调竖条；底色（暗）`rgb(35,35,36)` → `rgb(44,44,46)` | `…-02-role-form.png` |
| 02b | 角色表单弹窗（新建态，非法 id 被 Host 拒） | 16 × 2 | 1 | `.rb-form-error` 底色 transparent → tint（同 01 的两个序列化） | `…-02b-role-new.png` |
| 03 | 模板抽屉 | 70 × 2 | 1 | `.rb-template-row-picked` 描边 `rgba(0,0,0,0.1)` → `rgba(194,65,12,0.35)`（亮）、`rgba(255,255,255,0.12)` → `rgba(240,100,35,0.35)`（暗）；`box-shadow: none` → 强调竖条 | `…-03-drawer.png` |
| 04 | 模板新建/复制弹窗（51 节点被 Host 拒） | 12 × 2 | 1 | `.rb-form-error` 底色 → tint；同层 `.rb-template-row-picked` 描边 `rgb(15,17,21)`（亮，= currentColor）/ `rgb(249,250,251)`（暗）→ 强调线 | `…-04-template-form.png` |
| 05 | 迁移对话框 | 6 × 2 | 0 | `.rb-template-row-picked`（在抽屉里）描边 currentColor → 强调线；`.rb-notice-hint` 左强调边由基础描边 → `--rb-accent` | `…-05-migration.png` |

「dump 变化 0 而读数变了」的两行不是遗漏：02 的编辑行属于**角色管理对话框**、05 的选中行属于**抽屉**，都在该表面的下一层，dump 的 scope 是当前最上层对话框，具名目标则按文档顺序取全局元素——两处都逐个列出，没有含糊。

**零回归（面板内）**：`00-panel` 的 425 个 `rb-*` 元素亮/暗各一遍逐元素比对，**0 个变化**，`inRoot === true` 的变化数同样是 0。这条不是推断，是实测：`.rb-root` 自己的声明确实赢过它本来会从 `body` 继承的那份。其中 `.rb-card-selected` / `.rb-node-active` 的描边改前就已经是 `rgba(194,65,12,0.35)` / `rgba(240,100,35,0.35)`。

**面板侧三个「看板上不存在实例」的状态**：错误块（`.rb-notice-error`，看板健康时没有失败读数）、危险状态标签（`.rb-stag-*`，见 §15.8）、已走流程边（`.rb-edge-done`，本队列没有越过首节点的需求）。探针用**真实状态类名**在真实 `.rb-root` 子树里读这三者：错误块探针读 `color(srgb … / 0.12)` 的 tint、危险标签探针读 tint 与 error 文字色、已走边探针读 `stroke: rgba(194,65,12,0.35)`（亮）/ `rgba(240,100,35,0.35)`（暗）——改前改后 identical。所以「面板内零变化」覆盖了需求点名的五类控件（错误块、选中行、激活节点、胶囊、流程边），不是只覆盖恰好在屏上的那几个。

**不受影响、但同一病因（既存缺陷，本条明确不修）**：`--rb-tint-success` / `--rb-tint-warn` / `--rb-tint-info`（`:16-17`、`:19`）、`--rb-violet` / `--rb-violet-soft`（`:15`、`:33`）、`--rb-accent-fill` / `--rb-on-accent`（`:13-14`、`:31-32`）、`--rb-num` / `--rb-mono`（`:20`）也都只声明在 `.rb-root`，在弹层里同样解析为空。后两者的差别要写清楚：

- `--rb-tint-*` / `--rb-violet*` / `--rb-accent-fill` / `--rb-on-accent`：消费方实例（`.rb-req-link` 用 `--rb-tint-info` 与 `--rb-mono`、`.rb-meta-v-num`、`.rb-count-chip`、`.rb-stag-num`）全部只出现在**面板本体**——`00-panel` 的 425 个元素里读到了 `.rb-meta-v-num`，六个弹层表面一个都没有。所以即使这些变量在弹层里是空的，也没有可见的掉色。
- `--rb-num` / `--rb-mono`：**在弹层里确有实例**。`02-role-form`（19 个元素）与 `02b-role-new`（16 个）的读数里都出现 `span.rb-duty-count`，它声明 `font-family: var(--rb-num)`，在弹层里取不到值、落回平台继承字体——症状是字体回退，不是掉色。本轮读数只记录颜色与盒模型、**不记录 `font-family`**，所以这一类没有数值读数；本条也没有为这两个变量补载体声明（载体只声明五个变量，由源码门判据 3 钉住），"改前改后同为空"的依据是载体规则未增变量、这些消费方的规则也未改。列在这里是为了把「同族还有哪些没修」说全，而不是声称它们已经被测过。

`locale/zh.json` / `locale/en.json` 逐字节未变：本条不新增文案，`DICT.en` / `DICT.zh` 也未改。

### 15.8 实测推翻的假设与取舍记录（2026-10-10）

**1）§14.8 第 1 条的「不碰」在本条被有意推翻。**
§14 把 `--rb-tint-error` 在弹窗里解析为空记为**选择不修**：修它「会同时重绘 §12 的角色对话框、抽屉内 `.rb-notice-error`、`.rb-role-confirm` 等表面——那是另一条需求的可见变化」。本条就是那条需求：可见变化是有意的，而且用逐元素读数证明变化范围正好落在这些弹层表面（面板内 425 个元素、亮暗各一遍、0 变化）。

**2）「变量能解析」不等于「那条描边就能生效」——本轮实测发现的第二个缺陷。**
补上载体声明之后，`.rb-role-row-editing` 的 `border-color` 实测**仍然是** `rgba(0, 0, 0, 0.04)`（亮）/ `rgba(255, 255, 255, 0.06)`（暗），只有 `box-shadow` 竖条变成了强调色。原因不是 portal，而是层叠：`.rb-role-row-editing`（一类，`:567`）与后置的 `.rb-role-row { border:1px solid … }`（`:585`）、`.rb-role-row:last-child`（`:588`）特异性相同而后者在后，所以它的 `border-color` 一直是一条死声明——这个缺陷与主题无关，改前改后都存在。`.rb-template-row-picked` 是同一类但条件更窄：它排在 `.rb-template-row` 之后，不悬停时能赢；鼠标停在那一行上时被 `.rb-template-row:hover`（一类 + 一伪类）压掉——这正是 03 抽屉改前读数显示中性 `rgba(0,0,0,0.1)` 的原因。
处置：按面板自己的既有惯例把两个状态臂改成**双类**（`.rb-role-row.rb-role-row-editing`、`.rb-template-row.rb-template-row-picked`），并把前者移到基础行规则之后。理由：验收第 3 条字面要求「`.rb-role-row-editing` 的 `border-color` 解析为强调色」，不修这两行则该断言永远不可能为真；把断言放宽成只看 `box-shadow` 属于「把门改松」，而单类写法本来就是这个缺陷本身。这两个选择器只由弹层里的渲染使用（`client.js:2758`、`:4508`），`.rb-root` 内没有生产方，所以面板内零回归不受影响。副作用（有意）如实记录：被寻址的角色行底色由 layer-1 变成 layer-2（暗色 `rgb(35,35,36)` → `rgb(44,44,46)`；亮色两者相同，看不出来）——这正是那条规则本来就写着的值。

**3）「`--rb-accent-strong` 在弹层里非空」不能当作「弹层配色已修好」的证据。**
改前读数里 `--rb-accent-strong` 在六个弹层空间都非空（§13.6 第 3 条补的），但它在弹层里**没有消费方**；真正有消费方的四个变量全是空的。所以新判据按「有消费方的族」来钉，而不是按「哪个变量看起来修过」。

**4）`.rb-stag-*` 整个族没有生产方。**
样式表里有 `.rb-stag-danger`（`:375-376`）、`.rb-stag-vio`、`.rb-stag-num`（`:377-380`），但 `client.js` 里没有任何一处渲染 `rb-stag`——平台 `Tag` 原语用自己的 class 体系。这一族既不受影响、也谈不上回归：真实看板上不存在这样的元素。它仍按零回归处理：探针用真实类名在真实子树里读，改前改后 identical。

**5）「不在屏上的状态」不能靠抽样跳过。**
`.rb-edge-done` / `.rb-node-done` 在本队列里没有实例（没有越过首节点的需求、没有已完成节点的需求）。处理：探针克隆一条真实 `.rb-edge` 组、加上真实状态类 `rb-edge-done` 再读它的 `stroke` / `fill`；错误块与危险标签同理用真实类名造帧、读在真实 `.rb-root` 子树里。这样测的是真规则与真子树，而不是把这类控件从「零回归」清单里划掉。

**6）探针自己也会被测出问题。**
第一版读数在点完胶囊后没有移开指针，`.rb-filters .rb-chip.rb-chip-on` 读到的是 `:hover` 的中性描边（`rgba(0,0,0,0.12)`）而不是选中态的强调线——改法是读前把指针移到 (4,4)。同一版还漏掉 05 迁移对话框：`closeDialogs()` 会把整个层栈（含抽屉）关掉，所以 05 必须重新打开抽屉、再点选中行的「迁移」。另外「51 节点被拒」这一步原来只等固定 1.8s，暗色那轮有一次在拒答落地前就读了弹窗，改成显式等 `.rb-form-error` 出现——一次实测出来的抖动，不是猜的。

**7）`splice-css.mjs` 拒绝反引号与 `${`，注释里也不能出现。**
本轮把两条新注释写成带反引号的代码引用，`splice` 直接抛 `the stylesheet contains a backtick, which would end the template literal`。工具是对的（样式表要嵌进模板字面量），改的是注释措辞——顺手记下：这是本面板所有 CSS 注释的隐含约束。

**8）「浏览器门看不见 `:root` 污染」是错的。**
写 §15.2 D1 时我按「值照样解析成功」推断真浏览器门对「把变量搬进 `:root`」是瞎的，只有源码门能钉住。反证记录 `_s15-root-move_red.txt` 实测推翻了它：搬到 `:root` 后暗色的 `.rb-form-error` 底色变成 `rgba(0, 0, 0, 0)`，判据 1 因此变红。原因值得单独记：`--rb-tint-error` 不是字面颜色，而是 `color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)`，而平台把 `--dsw-alias-state-error-primary` 定义在 `body` / `body[data-ds-dark-theme]` 上（`design-platform.css:166`、`:284`），`html` 上没有。所以「主题载体」这个落点不只是不污染全局，它还是唯一能让 tint 里的平台 token 解析到的位置之一——`body` 是既有结构里最靠近根的那个。字面 rgba 的 `--rb-accent-line` 在 `:root` 上仍能解析，这也是那一轮记录里行描边判据没跟着红的原因。

## 16. 同族剩余变量在弹层内的解析与数字字族的字体回退（逐变量实测 · 名字集合门规）

**状态（2026-10-11）**：修 `.rb-root` 之外读不到的第九个面板局部变量 `--rb-num`——与 §13.6 / §15 已补的五个**同块**，只在主题载体 `body` / `body:not([data-ds-dark-theme])` 两臂各补一份，值取同臂注册表的表达式；`.rb-root` 的两个注册表臂不动。同族另外八个变量（`--rb-mono`、`--rb-tint-success` / `--rb-tint-warn` / `--rb-tint-info`、`--rb-violet` / `--rb-violet-soft`、`--rb-accent-fill`、`--rb-on-accent`）**在弹层内没有任何消费元素**，按需求第 3 条明确记「无需补」，逐条证据见 §16.5。同时把 `tests/client-smoke.mjs` 里那条「载体与注册表臂一致」的判据换成**按名字集合**的判据：载体声明集必须恰好等于「弹层可达集」，注册表已声明集必须恰好等于「弹层可达集 ∪ 明确不补集」，且每条载体声明必须等于它自己那一臂解析出的值——新漏一个变量、或多出一个没人裁决的变量，都会红。

### 16.1 现状（实测，2026-10-11）

`.rb-root` 的基础臂声明 14 个 `--rb-*` 变量（`new-panel.css:11-20`）。§13.6 的 `--rb-accent-strong` 与 §15 的四个在主题载体上重复过一份，共 5 个「弹层可达」；其余 9 个只在 `.rb-root`，其中 `--rb-num` 在弹层里有真实消费方（本条补它），剩下 8 个没有。

改前读数（`rollout/portal-color-probe.mjs`，六个弹层表面 × 两主题，落 `screenshots/s16-before-readings.json`）：

| 读数点 | 亮色（改前） | 暗色（改前） | 位置 |
|---|---|---|---|
| `--rb-num` 在弹层空间 | 空 | 空 | 六个弹层表面（`01-roles` … `05-migration`），同空间里 §15 补过的五个都已有值 |
| `.rb-duty-count` 的 `font-family`（角色表单弹窗、角色新建弹窗） | `-apple-system, BlinkMacSystemFont, "Segoe UI", …` | 同 | 弹层内、`.rb-root` 之外 |
| `.rb-group-n` 的 `font-family`（角色管理对话框左栏分组计数） | 同上 | 同上 | 同上 |
| `.rb-en` 的 `font-family`（模板抽屉里的三处 section 英文名） | 同上 | 同上 | 同上 |
| 面板内读同一字族的元素（`.rb-stat-value`、面板里的 `.rb-en`） | `Montserrat, -apple-system, …` | 同 | `.rb-root` 内 |
| `.rb-duty-count` 的 `font-variant-numeric` | `tabular-nums` | 同 | 与本条无关的既有声明，改前改后一致 |

关键字面：`font-family` 是**继承属性**，一个 `var()` 解析不到值时该声明在计算值阶段退化为 `inherit`——所以弹层里的数字标签读到的不是「没有字体」而是「平台 UI 族」。这正是需求说的字体回退症状：同一个类在面板内是品牌族，在弹层内变成 UI 族，而它自己那一行 `font-family` 看起来「写着」。

平台侧事实：`--dsw-font-family-brand` / `--ds-font-family-code` 定义在 `:root` 上（`packages/client/ui-theme/src/styles/base.css:9-11`），因此在 `body` 与弹层里都解析得到；品牌字形是随包分发的 webfont（`packages/client/ui-theme/src/styles/brand-font.css`，`font-display: swap`），所以读数与截图都在 `document.fonts.ready` 之后取（探针在每次记录前等一次）。

### 16.2 形态决定

**D1 只补有消费方的，不为对齐补死声明**（需求第 3 条）。普查分两路并交叉验证：浏览器侧，六个弹层表面 × 两主题把每个 `rb-*` 元素的 class 序列与计算值都记下来，再按变量问「哪个表面出现了消费它的类」（`rollout/_s16-inventory.json`）；代码侧，把样式表字面量与其余代码分开，按「CSS 里声明过某变量的类」在 `client.js` 里数命名点（`rollout/_s16-usage.json`）。结论：只有 `--rb-num` 的消费类进过弹层（`.rb-duty-count`、`.rb-group-n`、`.rb-en`），其余八个的消费类一个都没进过。

**D2 `--rb-num` 与既有五个同块声明，一行一个变量，不另起规则块。** 取舍：合进同一块，规则块数量不随变量增长，判据只需读一个选择器、两臂形状完全一致；代价是这一块的职责变宽（既管颜色又管字体），靠块首注释与本节记录区分。没有把两臂合并成 `:root` 单点：理由同 §15.2 D1 与 §15.8 第 8 条（tint 依赖的平台 token 只定义在 `body` 上），`--rb-num` 依赖的 `--dsw-font-family-brand` 虽然在 `:root` 上也能解析，但落点必须统一，否则同一条载体判据判不住这一族。

**D3 两臂各写一份 `--rb-num`，尽管它与主题无关。** 理由同 §15.2 D2：判据是「载体必须为这一臂把这一族声明全」，值同为 `var(--dsw-font-family-brand)`，两臂同式才能一次判到位。

**D4 不改 token、不新增变量、不动 `.rb-root` 注册表臂的值。**

### 16.3 状态矩阵（变量 × 消费方 × 表面 × 主题）

| 变量 | 弹层里的消费方 | 面板内（`.rb-root`） | 弹层内（portal 出去） |
|---|---|---|---|
| `--rb-num` | `.rb-duty-count`（角色表单弹窗、角色新建弹窗）、`.rb-group-n`（角色管理对话框）、`.rb-en`（模板抽屉三处） | 改前对 → 改后对 | **改前平台 UI 族 → 改后品牌族** |
| `--rb-mono` | 无 | 改前对 → 改后对（`.rb-meta-v-mono`、`.rb-req-link`） | 无消费方，改前改后都为空 → 不补（§16.5） |
| `--rb-tint-success` | 无 | 改前对 → 改后对（`.rb-node-done`） | 同上 |
| `--rb-tint-warn` | 无 | 改前对 → 改后对（`.rb-stat-alert`、`.rb-notice-sync`、`.rb-notice-stale`） | 同上 |
| `--rb-tint-info` | 无 | 改前对 → 改后对（`.rb-req-link`） | 同上 |
| `--rb-violet` | 无 | 改前对 → 改后对（`.rb-count`、`.rb-queue-note`） | 同上 |
| `--rb-violet-soft` | 无 | 改前对 → 改后对（`.rb-count`） | 同上 |
| `--rb-accent-fill` | 无 | 改前对 → 改后对（`.rb-btn-primary`，仅页头「新建需求」一处） | 同上 |
| `--rb-on-accent` | 无 | 改前对 → 改后对（`.rb-btn-primary`、`.rb-logo`，都在页头） | 同上 |

### 16.4 明确不动

- **`.rb-root` 的两个注册表臂**：值、选择器、顺序都不动；面板内零回归由层叠保证（元素自己声明的那份胜过它本来会从 `body` 继承的那份），§16.8 逐元素读数证明。
- **§13.6 / §15 已补的五个载体声明**：不重复声明、不改值；`--rb-num` 只是加进同一块。
- **`font-variant-numeric` 与任何排版度量**：只修 `font-family` 的解析，不新增、不改字距/字号/行高。
- **行为、文案、布局位置**：不动任何交互、`DICT`、结构；`locale/zh.json` / `locale/en.json` 逐字节不变。
- **`packages/**`、`host/**`**：零改动（`--dsw-*` / `--ds-*` token 只读）。

### 16.5 无需补的变量及其理由（逐条）

判据是「弹层里有没有元素消费它」，不是「有没有代码引用它」（后者两路都查了，见 D1）。下表「弹层消费方」一列全部来自 §16.8 的逐元素读数：没有 = 六个弹层表面里没有任何元素的 class 序列涉及该变量的消费类。

| 变量 | 消费它的类（`client.js` 命名点） | 这些类在弹层里的实例 | 结论与理由 |
|---|---|---|---|
| `--rb-mono` | `.rb-meta-v-mono`(1)、`.rb-req-link`(1)、`.rb-session-id`(0)、`.rb-code`(0)、`.rb-mono`(0) | 0 | 消费方都在面板详情列（元信息行、需求链接）；三个类连面板里都没有命名点（`rb-session-id` / `rb-code` / `rb-mono` 是死 CSS，§16.5 末尾） |
| `--rb-tint-success` | `.rb-node-done`（由 `rb-node-${status}` 组合，`client.js:3248`）、`.rb-stag-ok`(0) | 0 | 弹层里的流程图只以**只读模板图**出现：`templateFlowNode()`（`client.js:3753`）把 `status` 硬写成 `'pending'`、`enteredAt`/`completedAt` 写 `null`，而组合状态类的只有 `client.js:3248` 一处——实测抽屉里 5 个节点全是 `rb-node-pending`、0 个 `rb-node-done`。`.rb-stag-ok` 是死 CSS |
| `--rb-tint-warn` | `.rb-stat-alert`(1)、`.rb-notice-sync`(2)、`.rb-notice-stale`(1)、`.rb-stag-warn`(0) | 0 | KPI 磁贴与提示条都在面板内；`.rb-stag-warn` 是死 CSS |
| `--rb-tint-info` | `.rb-req-link`(1) | 0 | 需求链接在面板详情列 |
| `--rb-violet` | `.rb-count`(1)、`.rb-queue-note`(1)、`.rb-tag`(0)、`.rb-stag-vio`(0)、`.rb-reserve`(0) | 0 | 计数与排队说明在面板内；后三个是死 CSS |
| `--rb-violet-soft` | `.rb-count`(1)、`.rb-tag`(0)、`.rb-stag-vio`(0)、`.rb-reserve`(0) | 0 | 同上 |
| `--rb-accent-fill` | `.rb-btn-primary`(1) | 0 | 全局只有页头「新建需求」一个使用点（`client.js:5742`）；弹层里的主按钮是平台 `variant:'primary'`，描边用 `--rb-accent-strong`（§13.6 已补） |
| `--rb-on-accent` | `.rb-btn-primary`(1)、`.rb-logo`(1) | 0 | 同上；`.rb-logo` 只在页头 |

**死 CSS 的处理**：`--rb-mono` 的 `rb-session-id` / `rb-code`、`--rb-violet*` 的 `rb-tag` / `rb-stag-vio` / `rb-reserve`、`--rb-tint-success` 的 `rb-stag-ok`、`--rb-tint-warn` 的 `rb-stag-warn` 在 `client.js` 里没有任何命名点（全表 34 个，`rollout/_s16-usage.json` 的 `dead`）。它们不是本条的删除对象（清死 CSS 会动到 §12/§14 已定的结构面，且需求明确不碰），但它们是「这个变量的消费方根本不存在」的一部分证据，所以逐个点名。**v3（2026-10-19，C-4）已删除这批死规则**：其中 `rb-count-chip` 与 `rb-def-row` 在 v3 复活为工具条计数与口径定义行，其余随规则块移除；变量裁决不变（消费方仍为零的变量照旧不随载体进 portal）。名单与勘误见 UI-REDESIGN §10。

**v3 增补裁决（2026-10-19，v3 优化轮）**：v3 引入的文字档 ink 族与填充强档按同一判据裁决：

| 变量 | 消费它的类 | 弹层里的实例 | 裁决 |
|---|---|---|---|
| `--rb-ink-err` | `.rb-notice-error`/`.rb-notice-auth`/`.rb-notice-force`（toast，`shell.overlay` 传送）、`.rb-form-error`/`.rb-role-confirm`（角色对话框，Modal 传送） | ≥1 | **补**：传送面消费 |
| `--rb-ink-warn` | `.rb-notice-stale`/`.rb-notice-sync`（toast 传送） | ≥1 | **补**：传送面消费 |
| `--rb-accent-fill-strong` | `.rb-btn-primary:hover`（仅页头） | 0 | 不补 |
| `--rb-ink-ok` | `.rb-mini-on`、`.rb-check-done`、`.rb-node-done .rb-node-mark`（面板内） | 0 | 不补 |
| `--rb-ink-info` | `.rb-req-link`（面板详情列） | 0 | 不补 |
| `--rb-ink-vio` | `.rb-count`、`.rb-tag`、`.rb-reserve`（面板内） | 0 | 不补 |
| `--rb-ink-accent` | `.rb-trigger-on`、`.rb-toggle-on`、`.rb-status-opt-on`（面板工具条） | 0 | 不补 |
| `--rb-radius-md` | `.rb-summary`（面板详情列；v3 补定义修复 C-2 直角） | 0 | 不补 |

对应 `tests/client-smoke.mjs` 的 `PORTAL_REACHABLE` 增加 `--rb-ink-err` / `--rb-ink-warn`，`NOT_CARRIED` 增加其余六项；载体两臂各补两条 ink 声明，值取同臂注册表表达式。

### 16.6 实现落点与门

**样式**（`rollout/new-panel.css` → `client.js`，经 `rollout/splice-css.mjs`）：两臂各加一条 `--rb-num:var(--dsw-font-family-brand);`，位置与其余五条同块（`:61`、`:67`）。

**源码门 `tests/client-smoke.mjs`**：删掉 §15 留下的那条「载体与注册表臂一致」判据，换成四条：

1. `the theme carrier declares exactly the portal-reachable family, once per arm` —— 用 `declaredNames(selector)` 从解析出的规则体里读出每个选择器声明的 `--rb-*` 名字集合，要求 `body` 与 `body:not([data-ds-dark-theme])` 两臂的名字集合都恰好等于 `PORTAL_REACHABLE`（`--rb-accent`、`--rb-accent-soft`、`--rb-accent-line`、`--rb-accent-strong`、`--rb-tint-error`、`--rb-num`，v3 起再加 `--rb-ink-err`、`--rb-ink-warn`）。
2. `every variable the registry declares is either carried or deliberately left out` —— `.rb-root` 基础臂声明的名字集合必须等于 `PORTAL_REACHABLE ∪ NOT_CARRIED`（v3 起十四个明确不补的），两个集合互不相交且都不能为空；亮臂注册表只能是基础臂的子集。**这条是「新漏一个变量就会红」的那个门**：注册表里多一个变量而没人裁决补不补，集合等式立刻不成立。
3. `each carried variable repeats the value its own arm resolves to in the registry` —— 载体上每条声明必须逐字等于它自己那一臂的注册表值（亮臂没有该变量时按基础臂）。
4. `the portaled duty counter reads the carried numeric family` —— 样式表里 `.rb-duty-count` 规则体必须同时含 `font-family:var(--rb-num)` 与 `font-variant-numeric:tabular-nums`。

**真浏览器门 `tests/verification/panel-render.e2e.mjs`**（§16 段落接在 §15 段落之后，复用 `closePortalLayers` / `setStrokePalette` / 同一次弹层读数）：四条判据，两主题各读一遍——

1. `同一弹层空间里的品牌族与平台 UI 族本来就可区分` —— 在弹层空间里放两个探针分别写 `var(--dsw-font-family-brand)` 与 `var(--dsw-font-family)`，两者必须非空且不相等，否则后面三条没有判别力。
2. `.rb-duty-count`（角色表单弹窗，`font-variant-numeric` 必须同时是 `tabular-nums`）、3. `.rb-group-n`（角色管理对话框）、4. `.rb-en`（模板抽屉）——三者的 `font-family` 必须等于同空间的品牌族参照、且不等于 UI 族参照，并且元素确实在 `.rb-root` 之外。
5. 记账判据：本段不产生新的控制台错误。
另加一条零回归判据：面板内的 `.rb-stat-value` 仍取品牌族。

**目标元素的定位方式**：`.rb-en` 在面板里有 13 个（详情列的 section 英文名），在抽屉里有 3 个，所以按类名 `document.querySelector` 会读到面板那一份——§16.9 第 1 条记录了这个坑。门与探针都在弹层里先找、找不到才退回整篇文档读：门按 `closest('.rb-root') === null` 优先，探针按 `[role="dialog"]` 逐个找。

### 16.7 门与反证

| 改坏 | 源码门 `client-smoke` | 真浏览器门 `panel-render` |
|---|---|---|
| ① 漏掉一个臂的 `--rb-num` | 判据 1 变红（该臂名字集合少一个）＋ 判据 3 | 该主题下三个消费方落回 UI 族 → 判据 2/3/4 变红 |
| ② 注册表里加一个没人裁决的变量 | 判据 2 变红（集合等式不成立） | 看不到——新变量若没人消费，浏览器里没有可读点；这正是源码门与浏览器门的职责分工 |
| ③ 把 `--rb-num` 的载体声明改成别的字族 | 判据 3 变红（与注册表值不一致） | 判据 2/3/4 变红（不再等于品牌族参照） |

**① 已经实测**（`rollout/_s16-phase.mjs red` / `restore`，记录 `tests/verification/_s16-num-carrier_red.txt`）：把 `body` 臂那一行删掉、重新 splice、发布之后——

- 源码门 `492/494`（`exit 1`），两条红正好点名被删的那一行：`the theme carrier declares exactly the portal-reachable family, once per arm`（打印 `body: --rb-accent --rb-accent-soft --rb-accent-line --rb-tint-error --rb-accent-strong`，少 `--rb-num`）与 `each carried variable repeats the value its own arm resolves to in the registry`（打印 `body: … --rb-num=null`）；
- 真浏览器门 `94/97`（`exit 1`），三条消费方判据在**暗色**下红、亮色下仍绿（暗色读回 `-apple-system, BlinkMacSystemFont, "Segoe UI", …`，亮色读回 `Montserrat, …`）——因为只删了一个臂，另一臂还撑着。这说明两门判的都是**逐臂、逐主题**的事实，而不是「这个变量在别处存在」。

写回修复字节并重新 splice 之后两门恢复 `494/494` 与 `97/97`，且 `client.js` 的 sha256 与改坏前逐字节相同（`_s16-phase.mjs` 在 `restore` 里对照 `_s16-fixed-hashes.json` 打印 `byte-exact restore`）。**这条反证比「跑绿了」更重要**：它证明两门确实盯着载体上的这一行，而不是碰巧一直绿。

② 与 ③ 未单独跑：② 的源码门那一半已由判据 2 的定义保证（集合等式），而它「浏览器门看不到」正是分工本身；③ 与 ① 的红法同源（判据 3 逐字比值 + 三条浏览器判据比品牌族参照），不重复消耗一次真机测量。

### 16.8 读数（受影响清单与零回归，2026-10-11）

读数方式：`rollout/portal-color-probe.mjs` 连 3110 上的真机（部署副本的字节），面板本体 + 六个弹层表面 × 亮/暗各走一遍；每个表面把**全部** `rb-*` 后代按「标签 + class 序列 + 出现序号」建键，记录 border / background / color / box-shadow / stroke / fill / **`font-family`** / **`font-variant-numeric`** / 外框尺寸，另加一组具名目标与「同一空间里的品牌族 / 平台 UI 族」两个参照探针，每次记录前等一次 `document.fonts.ready`。改前读数取自**已发布的旧字节**：`rollout/_s16-phase.mjs baseline` 把 git 跟踪副本里的 `client.js`（`C789495E…`，正是上一轮发布出去的那一份）覆盖到部署副本，跑完再把修复字节写回，两端哈希都在 `rollout/_s16-baseline.txt` 里核对过（`published the pre-fix client.js: hash matches` / `restored the fixed client.js: byte-exact`）——所以改前/改后是同一条字节级基线，不是重造的近似。逐元素比对落 `rollout/_s16-report.txt`。

**受影响清单（变量 × 表面 × 两主题）**：

| 变量 | 表面（真实操作） | 该空间的 `--rb-num` | 消费方读数（改前 → 改后） | 截图 |
|---|---|---|---|---|
| `--rb-num` | 00 面板本体 | 一直有值 | 面板内 425 个元素逐字段一致（不动） | `s16-{before,after}-<theme>-00-panel.png` |
| | 01 角色管理对话框 | 空 → 有值 | `.rb-group-n` ×2：UI 族 → 品牌族（其一 9×17 → 8×17） | `…-01-roles.png` |
| | 02 角色表单弹窗（编辑态） | 空 → 有值 | `.rb-duty-count`：UI 族 → 品牌族（22×15 → 27×14） | `…-02-role-form.png` |
| | 02b 角色表单弹窗（新建态 + 非法 id 被拒） | 空 → 有值 | `.rb-duty-count`：同上 | `…-02b-role-new.png` |
| | 03 模板抽屉 | 空 → 有值 | `.rb-en` ×3：UI 族 → 品牌族（46×16 → 53×16、52×16 → 58×16、60×16 → 67×16） | `…-03-drawer.png` |
| | 04 模板新建弹窗（51 行节点被拒） | 空 → 有值 | 同抽屉（抽屉仍在层下） | `…-04-template-form.png` |
| | 05 迁移对话框 | 空 → 有值 | 同抽屉 | `…-05-migration.png` |
| 其余八个 | 六个弹层表面 | 改前改后都为空 | 没有任何元素消费它们，逐字段一致 | 同上 |

`--rb-num` 在六个弹层表面里从空变成有值，是 12 处读数变化（6 表面 × 2 主题）；另外八个变量在弹层里**改前改后都是空、逐字段一致**。这两半同等重要：后者不是「没测」，而是「测了，读数一模一样」——§16.5 的「无需补」因此是实测结论而不是判断。

**逐字证据**（同一元素、同一主题，两轮只差两行 CSS）：

| 元素（表面） | 改前 `font-family` | 改后 `font-family` |
|---|---|---|
| `span.rb-duty-count`（02 / 02b，弹层内） | `-apple-system, BlinkMacSystemFont, "Segoe UI", …` | `Montserrat, -apple-system, BlinkMacSystemFont, "Segoe UI", …` |
| `span.rb-group-n`（01，弹层内） | 同上 | 同上 |
| `span.rb-en`（03，弹层内 ×3） | 同上 | 同上 |
| 同空间的品牌族参照 `var(--dsw-font-family-brand)` | `"Montserrat", -apple-system, …` | 不变 |
| 同空间的 UI 族参照 `var(--dsw-font-family)` | `-apple-system, BlinkMacSystemFont, …` | 不变 |
| `div.rb-stat-value`（00，面板内） | `Montserrat, …` | 不变 |

**零回归（`.rb-root` 内逐元素，不是抽样）**：亮色一轮比对 654 个元素，其中 `.rb-root` 内 **425 个逐字段全部一致**；暗色同。§15 用的 425 元素口径在这里原样复用，改前改后没有任何一个面板内元素移动。

**弹层内每个主题 15 个元素发生变化**，集合正好是「七个消费方 + 八个容器」：

- 消费方 7 个：`.rb-group-n` ×2、`.rb-duty-count` ×2、`.rb-en` ×3 —— `font-family` 真正换了族，外框尺寸也随之变（字宽不同）；
- 容器 8 个：`.rb-group` ×2、`.rb-dialog` ×2、`.rb-field` ×2、`.rb-field-label` ×2 —— 外框高度 +1px：品牌字形的行盒比平台 UI 族略高，把这一行顶高 1px。这是**同一个修复的可见后果**，不是第二处改动（截图可见）。

`font-variant-numeric` 在所有读数点上改前改后一致（`.rb-duty-count` 一直是 `tabular-nums`，其余 `normal`）：本条没有顺带改动任何排版声明。

**四道门**：`tests/client-smoke.mjs` **494/494**；`tests/verification/panel-render.e2e.mjs` **97/97**（§15 的 91 条 + 本条的 6 条）；`tests/roles.mjs` **298/298**；`g-hygiene.mjs all` **6/6**（含 C1 107 个文本文件字节卫生、C3 `~/.dsh` before/after）；`rollout/splice-css.mjs --check` → `in sync`（样式表字面量第 1556..2238 行 / 681 行）。部署副本同步 `recheck: 0 differing, 696 files`。

**可见面只动了两行 CSS**：`git diff --no-index --numstat` 对「改前字节 → 改后字节」报 `20 增 / 11 删`，`-U0` 只有三个 hunk——注释重写、`body` 臂 +1 行、`body:not([data-ds-dark-theme])` 臂 +1 行，全部落在两臂载体块与块首注释内。没有一行落在 JS、`DICT`、`locale/*.json` 或其它 CSS 规则上，这就是「无文案变更、无行为变更」的机器证据（`packages/**` 无本条改动，见 16.9 第 2 条）。

**反证**：`red`（删掉 `body` 臂的 `--rb-num`）→ 两门同时红；`restore`（写回修复字节）→ 两门同时绿并按哈希确认逐字节还原。记录 `tests/verification/_s16-num-carrier_red.txt`，结论见 §16.7。

### 16.9 实测推翻的假设与取舍记录（2026-10-11）

**1）「按类名查一次就能读到弹层那一份」是错的。** `.rb-en` 在面板里有 13 个实例（详情列的 section 英文名），在模板抽屉里有 3 个。`document.querySelector('.rb-en')` 按文档顺序返回面板那一份，于是第一条 §16 浏览器判据把面板元素读成了「模板抽屉的版本标签」，报 `no-dialog/in-root = brand`——**判据挂了，但它挂得对**：它证明的是「查询选错了元素」，不是「弹层里字族没修好」。改成「先在弹层各层里找，找不到才退回整篇文档」之后，三个消费方都在 `.rb-root` 之外读到品牌族。这条与 §15 的教训同类（读数的**取材**本身也会错），但方向相反：§15 是门看不见坏，这里是门看见了假对象。

**2）「`git status --porcelain packages` 为空」在本次会话里不成立，但与本条无关，如实分开记。** 工作区里 `packages/**` 确有未提交改动：`packages/client/ui-primitives/src/markdown/{MermaidBlock.tsx,MermaidBlock.module.css,render.tsx,MarkdownText.tsx}`、`tests/mermaid.client.spec.tsx`、`packages/client/ui-layout/src/client/{service.ts,stores.ts}` 与两份测试、`packages/client/ui-sidebar-documentpreview/src/client/markdown/MarkdownBody.tsx`，以及相关的 README/i18n 三件套——另一个会话正在做的 Markdown / Mermaid 功能。本条的全部改动落在 `.artifacts/requirement-board/` 这一棵 bundle 树内：改前→改后的字节 diff 只有那三个 hunk（`20 增 / 11 删`，全在样式表载体块），部署同步清单里也没有任何 `packages/` 路径。**这两件事必须在验收里分开**，否则「packages 有 diff」会被读成本条的平台污染。

**3）「`--rb-num` 在弹层里只有职责计数一个消费方」是错的。** 需求描述只点名 `span.rb-duty-count`。实测六个表面后，弹层里其实有**七个**消费方：`.rb-group-n` ×2（角色管理对话框左栏的分组计数）与 `.rb-en` ×3（模板抽屉里的 section 英文名）也在弹层里，而且同样退化成了 UI 族（§16.8 的 15 元素清单就是它们的全集）。`.rb-en` 尤其说明问题：它同时存在于面板与抽屉，按类名查一次读到的是面板那一份。若只按描述动手，三处判据会只盖住一个消费方。

**4）「修复带来的 1px 高度变化算回归吗」需要裁决。** 实测发现品牌字形把弹层里职责计数那一行顶高 1px（`.rb-field-label` 17→18、`.rb-field` 与 `.rb-dialog` 同步 +1）。这不是缺陷而是修复的必然结果——改前渲染的本来就是平台 UI 族，总要有个字形先落地。裁决：把它记成「受影响面的可见后果」并保留两主题截图，**不去压行高**——那会变成第二条改动，而需求明确不许动排版度量（`.rb-root` 内 425 个元素零变化，弹层内也只有这 15 个）。

**5）「无需补」的结论有一个边界，必须写下来。** 六个弹层表面里唯一会画流程图的表面是模板抽屉，而它的节点来自 `templateFlowNode()`（`client.js:3753`）——一个把 `status` 写成字面量 `'pending'` 的只读模板图（`enteredAt`/`completedAt` 都是 `null`）。所以 `.rb-node-done` 在弹层里**按构造**不可能出现，`--rb-tint-success` 的「无需补」成立。但这个结论依赖「弹层里只有只读模板图」这一事实，而不是依赖「`.rb-node-done` 这个类不存在」：如果将来某个弹层表面改画**某条需求的**流程图（带完成节点），`--rb-tint-success` 就该补上，而**两道门都不会自己发现这件事**——源码门判的是「注册表 ↔ 载体」的名字集合，浏览器门只读它被指到的那几个消费方。把这个边界写在这里，是它唯一能被发现的地方。

**6）「普查」本身也做了重跑。** §16.5 的结论不是一次性的：`rollout/_s16-inventory.mjs` 现在默认读 §16 的改后读数（`node rollout/_s16-inventory.mjs screenshots/s16-after-readings.json after` → `rollout/_s16-inventory-after.json`），重跑结果逐条复现：八个变量「panel-only（no portal consumer）」，`--rb-num` 的弹层消费面恰好是 `03-drawer`（`.rb-en`）、`01-roles`（`.rb-group-n`）、`02-role-form`/`02b-role-new`（`.rb-duty-count`）。
