# 需求看板插件优化设计方案（v2）

> 状态：**已实施并落地**（存储接口迁移与 SQLite 路由都在运行，当前实现见 [DESIGN.md](DESIGN.md)）；本文件回答"当初为什么这么改"，以及各优化项的落点。
> 与本文件并行的另一个方案是[角色化任务分发](ROLE-DISPATCH.md)（按角色派活、AI 认领、待人类决策队列、跨角色门禁）；两者的先后已由阶段 0 解决：本文件先落地，角色化方案在同一套 domain 表单上继续。
> 结论先行：**存储接口改用平台 `ctx.storage.domain` 表单；本部署的数据库选型定为 SQLite（`@deepseek-ai/dsh-storage-sqlite`，`journalMode: wal`）；插件自己不再管文件路径、原子写与 rebase。**

## 1. 迁移前评估与处置

### 1.1 迁移前已成立、不得破坏的东西

| 不变量 | 实现 | 测试锚点 |
|---|---|---|
| 节点状态只推导、不落盘 | `flow.js` `recomputeNodes()` 是唯一来源 | `tests/smoke.mjs` 66 项、`tests/gates.mjs` 246 项 |
| `history` 只追加、上限 500 | `service.js` / `flow.js` 在每次流转尾部追加 | `tests/smoke.mjs`、`tests/live.mjs` |
| 所有写命令返回同一个派生视图 | `#present()`，写结果就是完整视图 | smoke 的写返回断言 + live 预检 |
| 单进程内不丢更新 | 域写链 + 记录级 `rev` 与可选 `expectedRev` CAS | `tests/smoke.mjs`、`tests/domain.mjs` |
| 人机两面看到同一份数据 | SSE `changed` + `systemPrompt.context` + `requirement_board{action:'changes'}` | `tests/client-smoke.mjs`、`tests/live.mjs`（含模型可见性实证） |
| 零原生编译、无构建步骤 | 纯 ESM；外部依赖只有 `zod` 与平台 storage 包 | `node tests/loader.mjs` 53 项 |

`tests/live.mjs` 是对**已运行服务器**的端到端预检，需要一个装了本插件的 Host（默认 `http://127.0.0.1:3080`）；没有可用的 Host 时它无法自证，这一点写在 README 的测试小节。

### 1.2 问题清单

| # | 问题 | 证据 | 影响 | 级别 | 现状（代码锚点） |
|---|---|---|---|---|---|
| 1 | 存储层自研，整文件重写 + 文件戳 rebase | `host/store.js` `#rebaseIfReplaced()`、`size:mtimeMs` 戳；DESIGN 已知限制已承认跨进程只"尽力而为" | 每次写重写整个文档；两个 Host 进程共享同一文件时靠时间戳猜测，可能互相覆盖 | P0 | **已解决**：`host/store.js` 已删；`host/domain.js` 声明域表单，单行 UPDATE + 平台单域写链 |
| 2 | 持久化记录**没有**逐条校验 | `#readDocument()` 只校验 `schemaVersion` 与整体可解析；没有 per-record 校验 | 手工改坏一条记录会让整份文档在后续读取时才炸，且报错位置不明确 | P0 | **已解决**：每表一个 zod schema，`open` 逐条校验，坏记录 → `invalid-record`（`host/domain.js:256-270`） |
| 3 | 死代码 4 处 | `model.js` 的 `NODE_STATUSES`、`asIsoInstant`；`service.js` 的 `readiness(id)`；`http.js` 对 `ROUTE_PREFIX` 的多余 `export` | 读者要判断哪些是活的；`DESIGN.md` 接口表还在列 `readiness` | P1 | **已删**：四个符号在 `host/model.js`/`host/service.js`/`host/http.js` 中都不存在；`DESIGN.md` 不再列 `readiness` |
| 4 | 空 `catch` 未命名错误 | `host/store.js` 约 167 行 `catch {` | 违反仓库 "an empty `catch` names the error and why" | P1 | **已命名**：`host/**`、`index.js`、`client.js` 内已无裸 `catch {` |
| 5 | 图表只有 shim 级验证，无导出 | `tests/client-smoke.mjs` 从渲染几何反推，但没有浏览器截图回归；AI 只能拿到文本 | 视觉回归无人守；跨会话想让 AI 描述流程图时没有图 | P2 | **未做（取舍）**：仍是手写 SVG + 几何反推断言；真实浏览器验收走 `record-browser-gif`（阶段 G/R 人工项） |
| 6 | SSE 无补偿重放 | 客户端只依赖 `EventSource` 自动重连 | 断线期间的变化要等下一次全量 refetch，`changes` 也没有游标 | P2 | **未做（取舍）**：重连后全量快照；`changesSince(since)` 提供游标语义并以 `truncated` 标记 200 条以上 |
| 7 | 路由无认证 | `host/http.js` 只校验回环 Origin，且**缺 `Origin` 头即放行** | 本机其它进程可读改写看板 | P2 —— **已定：不做**（插件侧写进限制，不宣称是权限系统；真要边界另立平台级需求，见 [ROLE-DISPATCH.md](ROLE-DISPATCH.md) §11） | **已定不做**：先用平台 `connection.requestRejection`（401/403），无该服务时退回回环 Origin 校验 |
| 8 | 安装位置与仓库内其它插件不一致，且**没有任何外部依赖解析能力** | 其它 4 个插件在 `~/.dsh/bundles/`，本插件在 `.artifacts/requirement-board/`；实测 `zod` / `@deepseek-ai/*` 在 bundle 目录下均 `ERR_MODULE_NOT_FOUND` | 插件今天靠"零外部依赖"绕过了这个问题；一旦引入 zod（P1 必需）就必须同时解决依赖声明与安装方式（见 2.5） | P1 | **已解决（开发期）**：`node_modules` 用 junction + `package.json` 声明依赖；启动期归位与 bundle 安装仍属阶段 R（见 2.5、5） |

## 2. 数据库与存储接口选型

### 2.1 候选

| 代号 | 方案 |
|---|---|
| A | 自研 JSON 文件（迁移前的实现）：一个 `requirement-board.json` + `.tmp`/`rename` + 文件戳 rebase |
| B | 平台 `ctx.storage.domain` 表单，域名路由到 `json` 后端 |
| C | 平台 `ctx.storage.domain` 表单，域名路由到 `sqlite` 后端 |
| D | 自研 `node:sqlite`（Node 内建，自己写 schema/事务/迁移） |
| E | `better-sqlite3`（原生扩展） |
| F | 外部数据库（Postgres / MySQL / 独立 SQLite 服务） |

### 2.2 评估矩阵

| 维度 | A 自研 JSON | B domain+json | **C domain+sqlite（选定）** | D 自研 node:sqlite | E better-sqlite3 | F 外部 DB |
|---|---|---|---|---|---|---|
| 单条写入成本 | 整文件重写 | 整个 unit 重写 | **单行 UPDATE** | 单行 UPDATE | 单行 UPDATE | 网络往返 |
| 逐条 schema 校验 | 无 | zod：open 时全量 + 写入时在持久化边界 | **同 B** | 自己写 | 自己写 | 自己写 |
| 写串行化 | 自己维护 promise 链 | 平台"每域一条写链" | **同 B** | 自己维护 | 自己维护 | 数据库事务 |
| 变更事件 | 自建 `onChange` | 平台 `domain/changed`（进程内、按写序） | **同 B** | 自建 | 自建 | 自建 |
| 依赖代价 | 0 | `zod` + `@deepseek-ai/dsh-storage-domain` | **同 B**（后端是 profile 组合项，不是插件依赖） | 0 | 原生编译 + 供应链 | 服务器运维 |
| 零原生编译 | 是 | 是 | **是**（`node:sqlite` 是 Node 内建） | 是 | **否** | 是 |
| 跨进程语义 | 时间戳猜测，可能覆盖 | 平台未提供（列为 deferred） | **同 B：文件级不会互相覆盖，语义级仍需单进程** | 可自己加 | 需自己加 | 由数据库提供 |
| 适用面 | 极小规模、可容忍整文件重写 | 需要在纯文本里看/改数据 | **本项目的默认** | 想零依赖但接受重复平台能力 | 已有 SQLite 技术栈 | 多机部署 |

### 2.3 选型结论

**接口层：改用 B/C 共有的 `ctx.storage.domain` 表单。** 理由是它一次性删掉我自研的那一整层，而不是换一个更快的文件格式：

- 平台已经提供"每域一条写链"（`put`/`delete`/`update`/`global.set` 都排在同一条链上，`update` 的变换函数在**链上的槽位**执行），这套串行化比我手写的 promise 链更严格，也更少代码。
- `defineDomain` 用 zod 声明记录 schema，`open` 时校验每一条已存记录，写入时在持久化边界再校验 —— 直接补上问题 2。
- 写操作"后端确认持久化之后才 resolve"，`domain/changed` 在提交点之后按写序发出 —— SSE 的事件源从"我自己记得通知"变成平台契约。
- 我的 `BoardError` 语义可以继续保留，只把 `conflict` 的来源从"文件戳不符"换成"链上记录的 `rev` 不符"（见 3.2）。

**介质层：本项目默认路由到 SQLite（方案 C）。** 在同样的接口层下，`json` 与 `sqlite` 的差别只有介质：

- 需求看板是"读多写少但写点小"的形态（勾一个检查项、推进一个节点），SQLite 后端的布局是 `u_<unit>_<table>(key TEXT PRIMARY KEY, value TEXT)`，一条记录一次单行 UPDATE，写入成本与文档规模无关。
- 介质是 `node:sqlite`，Node 内建，**不引入原生编译**；相对于 `better-sqlite3` 那一档，它不新增任何 npm 依赖（zod 是 `domain` 表单带来的，与本后端无关）。表名、journal mode、单语句原子性都由平台实现，我一行 SQL 都不写。
- 数据落在一个普通 `.db` 文件里，可以用 `sqlite3` 命令行直接查。换到 domain 表单之后"内存是权威、介质是投影"，比起 `storage-json` 后端自己的 unit 目录布局，一个标准数据库文件更好排查。
- JSON 后端保留为**可切换路由**：需要在纯文本里直接看/改数据时，把 `routes` 改回 `json` 即可，插件代码不变（这正是把后端抽到 profile 组合、而不是硬编码在插件里的价值）。

### 2.4 本部署的落地配置

base bundle 只装 `storage` + `storage-json`（`root: dshHomePath('storages')`）+ `storage-domain`（`backend: json`）；`packages/bundle/**` 的补丁层里没有任何一处声明 `@deepseek-ai/dsh-storage-sqlite`，需要在 profile 的补丁层加一行。开发期的载体是 `dev.overlay.yml`（启动时 `--patch` 带入，`~/.dsh/profiles/web/**` 在阶段 R 之前不被写）：

```yaml
# 需求看板专用数据库：开发期落在工件目录里
- insert:
    - id: storage-sqlite
      name: "@deepseek-ai/dsh-storage-sqlite"
      config:
        path: "C:/code/deepseek-harness/.artifacts/requirement-board/dev-board.db"
        journalMode: wal
# 只给本域换后端，其它域继续走 json
- id: storage-domain
  config:
    backend: json
    routes:
      requirement_board: sqlite
```

要点：

- `insert` 是新增行的必需写法：补丁条目指名一个更早层没有的 `id` 而不带 `insert` 只会 warn "patch: entry not found" 并被跳过。
- 指名 `id` 的补丁是**整段替换**该行的 `config`，不是深合并；所以 `backend: json` 必须重述，否则该行以 `$.backend missing required value` 失败。
- 路由键是**存储单元名**，必须是下划线的 `requirement_board`：单元名按 `/^[a-z][a-z0-9_]*$/` 校验，连字符键匹配不到任何域，会静默回退到默认 `json` 后端且没有任何报错（`DOMAIN_NAME` 因此也必须是下划线——插件名保留连字符不受影响）。
- 生成路径也可以写成 `!!js dshHomePath('storages/requirement-board.db')`（base 层就是这么给 `storage-json` 定 root 的）；profile 补丁层是否绑定同一批 `!!js` 辅助函数未验证，所以开发期用绝对路径。
- SQLite 后端的物理布局版本用 `PRAGMA user_version` 记录，且**不提供迁移**（平台明确的前置版本姿态）；升级 DSH 时若布局版本变化，需要按 2.8 导出再导入。

### 2.5 依赖与安装位置（S1 结论）

`defineDomain` 的记录 schema 是 **zod**（`storage-domain` 的依赖是 `zod@^4.4.3`），所以插件要 `import 'zod'`。纯 Node 下在 bundle 目录里实测：

```text
zod                             -> ERR_MODULE_NOT_FOUND
@deepseek-ai/dsh-storage-domain -> ERR_MODULE_NOT_FOUND
@deepseek-ai/dsh-storage        -> ERR_MODULE_NOT_FOUND
```

S1 的结论（实录见 [probes/S1-S2.md](probes/S1-S2.md)）：插件目录下的 `node_modules`
用 **junction** 指到仓库的 pnpm store，于是运行时解析成立；`package.json` 因此显式声明

```json
"dependencies": {
  "zod": "^4.4.3",
  "@deepseek-ai/dsh-storage-domain": "0.2.1-alpha.1",
  "@deepseek-ai/dsh-storage-sqlite": "0.2.1-alpha.1"
},
"devDependencies": {
  "@deepseek-ai/dsh-storage": "0.2.1-alpha.1",
  "@deepseek-ai/dsh-storage-json": "0.2.1-alpha.1"
}
```

要点：

- `storage-domain` 与 `storage-sqlite` 必须在**插件自己的 `dependencies`** 里：装载清单引用的是插件行，loader 按插件包的解析路径找 `@deepseek-ai/*`。
- `storage` / `storage-json` 只在测试与探针里直接用，所以放 `devDependencies`。
- junction 是**开发期**手段：`node_modules` 不进受控源码（`.artifacts/` 被 `.gitignore` 忽略），启动期把它换成真实安装属阶段 R。
- 仓库内另外 4 个插件都在 `~/.dsh/bundles/` 下，本 bundle 在 `.artifacts/requirement-board/`；搬迁同样属阶段 R，`~/.dsh` 在开发期不被写。

### 2.6 明确放弃的方案

- **D 自研 `node:sqlite`**：技术上可行且能保住零依赖，但会把平台的 schema 校验、写链、事件三件事各抄一遍，正好落在仓库 "prefer maintained dependencies over hand-rolling" 的反面。
- **E `better-sqlite3`**：原生扩展需要编译工具链与安装脚本审批，而 `node:sqlite` 已经内建；没有任何收益。
- **F 外部数据库**：单机、单用户的看板不值得引入一个需要运维的服务；如果将来要多机共享，正确的下一步是平台 storage 的远程后端，而不是我在插件里连一个库。

### 2.7 一致性语义

- **单进程权威不变**：`storage-domain` 的读取来自已验证的内存状态，介质是它的持久投影；同进程内所有写在一条链上，不交错。
- **CAS 更强了**：`expectedRev` 的比对发生在写链的变换函数里，读—比—写之间没有窗口（迁移前是"读记录 → 比 rev → 写文件"，同进程内也靠串行化兜底）。见 3.2。
- **跨进程仍不保证语义级一致**：平台的 `domain/changed` 是进程内事件，跨进程变更推送被平台列为 deferred。SQLite 消除了"两个进程各自整文件覆盖"，但两个 Host 进程共用一个 `.db` 时按记录 last-write-wins，平台不做冲突检测。因此"同一份数据只由一个 Host 进程写"仍然是硬约束，写在文档的已知限制里——它比迁移前的时间戳猜测更明确，但不是"多进程安全"。

### 2.8 迁移与回滚

1. **一次性导入**：`importLegacy: true` 时，domain 里没有 `requirements` 记录、`global` 没有 `imported` 凭据、旧 `requirement-board.json` 存在（路径由 `$DSH_PROFILE_DIR` 或 `~/.dsh` 派生）→ 读旧文档、逐条校验并 `put` 需求与模板、写 `global.imported = { at, count }`，然后把旧文件改名为 `requirement-board.json.migrated`（不删除）。三个前提任一不成立就什么都不做；文件存在但不合法则**大声失败**而不是跳过。
2. **计数器的自愈**：`nextRevision = max(global.revision, max(record.rev))`，这样即使"记录已落盘、global 还没写"时崩溃，重启后也不会发出重复的 `rev`。
3. **备份与回滚**：用平台介质的导出/导入；旧文件保留为 `.migrated`，可回滚到迁移前的文档。插件**不提供** `export` 动作——导出是部署面的事，不是看板动作。
4. **domain 版本升级**：`version` 从 1 升到 2 时，新记录 schema 把新增字段全部声明为 optional（旧记录读作 `task`/空角色/无锁/无委托/无门禁），旧数据本身不走 domain 版本，而是由 1 的导入通道读入。`compatibleVersions` **故意不声明**：本部署选定的介质（sqlite 与 JSON `single` 布局）对版本戳做精确相等比对，声明兼容版本不会让旧戳变可读，只会给出错误的兼容承诺。

## 3. 目标存储设计

### 3.1 domain 规格（现状）

```js
defineDomain({
  name: 'requirement_board',          // 同时是后端 unit 名，须匹配 UNIT_NAME_RE /^[a-z][a-z0-9_]*$/；连字符会静默路由到默认后端
  version: 2,                         // 不声明 compatibleVersions：介质按精确版本戳校验
  tables: {
    requirements: domainTable(requirementRecordSchema),  // 需求持久化记录（含 kind/role/parentId/blocksOn/lock/delegatedTo/executions/sync/execRev）
    templates: domainTable(templateRecordSchema),        // 流程模板
    roles: domainTable(roleRecordSchema),                // 角色注册表（阶段 A1 填）
    queues: domainTable(sessionQueueRecordSchema),       // 每会话执行队列（阶段 A2 填，键 = 会话 id）
  },
  global: {
    schema: globalSchema,             // { schemaVersion: 2, revision, execSync: { ignored, gaps }, imported? }
    initial: { schemaVersion: 2, revision: 0, execSync: { ignored: 0, gaps: 0 } },
  },
})
```

记录字段与旧持久化记录一致（`id`/`title`/`description`/`priority`/`owner`/`sessions`/`status`/`templateId`/`rev`/`createdAt`/`updatedAt`/节点运行态/`history`），另加角色化分发引入的 optional 字段；没有 `flow` 与 `progress`——它们是推导值。

### 3.2 写路径与 CAS

```js
// 变换函数在写链的槽位上执行：这里读到的 record 就是权威内存状态，不会被别的写插入
await domain.table('requirements').update(id, record => {
  if (expectedRev !== undefined && record.rev !== expectedRev) {
    throw new BoardError('conflict', 'requirement changed', { expected: expectedRev, current: record.rev })
  }
  const next = recompute(record, patch)
  return { ...next, rev: ++revisionCounter, updatedAt: nowIso() }
})
await domain.global.set({ ...global, revision: revisionCounter })   // 同一条链，后写
```

实际落点是 `service.js` 的 `#mutateRequirement()`（记录写）与 `#mutateExecutions()`（执行观察写）。

- `recompute()` 就是 `flow.js` `recomputeNodes()` + `validateTransition()`，一行不改 —— 领域规则与介质解耦后更容易单测。
- **执行观察写只推 `execRev`**：`executions`/`sync`/`executionsTruncated` 的更新不使 `rev` 前进，因此长跑进度不会让模型手里的 `expectedRev` 失效。
- HTTP 层的 409/`conflict` 与 `{expected, current}` 载荷不变，客户端代码不用改。

### 3.3 事件与 SSE

`domain/changed` 替代 `store.onChange`：同一个进程内、按写序、提交点之后发出。HTTP 层的 SSE 端点只订阅它并按需重读快照，客户端的 `EventSource` 与 `changed` 语义不变。

### 3.4 已移除的部件

- `host/store.js` 整体（文件读写、`.tmp`+rename、文件戳 rebase、`onChange`）已删除。
- `service.js` 里构造 store 的参数与 `dataDir`/`documentPath` 配置项已移除（改用平台存储，插件不再选路径）；旧配置现在报 `invalid-config`。
- 1.2 问题 3、4 列出的 4 处死代码与未命名 `catch` 已删除/命名。

## 4. 其他优化项

| # | 优化项 | 收益 | 成本 | 风险 | 级别 | 现状 |
|---|---|---|---|---|---|---|
| O1 | 删死代码 4 处 + 空 `catch` 命名 | 读者不用再判断死活；`DESIGN.md` 接口表与实际一致 | 极小 | 无 | P1 | **已完成**（四个符号已删；`host/**`、`index.js`、`client.js` 已无裸 `catch {`） |
| O2 | 把 `readiness` 语义**用起来**：作为 `get` 返回的一个字段（"下一个节点还缺什么"），不删概念 | AI 能回答"为什么还不能推进"，不用自己推 | 小 | 与 `nextNodeId` 语义重叠，需要定义清楚 | P1 | **已由 O1 取代**：`readiness` 删除；"为什么还不能推进"由 `advanceable` 与三个拒绝码（`invalid-transition{blockedBy}` / `dependency-not-met` / `completion-not-met`）承担 |
| O3 | `changes` 加 `since` 游标 + SSE `Last-Event-ID` 重放 | 断线后只补增量，不整份 refetch | 中 | 需要 `rev` 单调且跨重启稳定（2.8 的自愈保证） | P2 | **一半**：`changesSince(since)` 已提供游标（`truncated` 标记流转超 200 条）；SSE `Last-Event-ID` 重放未做，重连后仍是全量快照 |
| O4 | 导出图：`export flow` 提供 SVG 与 Mermaid 文本 | 会话 AI 能贴图；人能存档 | 中 | Mermaid 文本是纯字符串产物，不引入渲染依赖 | P2 | **未做** |
| O5 | 浏览器截图回归 | 替代"只有 shim 几何断言"的现状 | 中 | 需要浏览器自动化通道与稳定的截图比对 | P2 | **未做**；真实浏览器验收走 `record-browser-gif` 人工项 |
| O6 | 可观测性：写入数/冲突数/SSE 连接数计数 + 结构化日志 | 线上问题可定位 | 小 | 避免日志里出现需求正文 | P2 | **未做**；唯一的计数器是 `global.execSync.{ignored,gaps}` |
| O7 | 路由可选 token | 本机其它进程不能读写看板（实际挡不住同用户进程，见下） | 小 | 需要与 Web 服务的 token 机制对齐，不能自创一套 | P2 —— **已定：不做**（见 1.2 与该决定在 [ROLE-DISPATCH.md](ROLE-DISPATCH.md) §11 的限制条款） | **已定不做** |
| O8 | 描述/README 与实现同步（本文件 + DESIGN.md + README.md） | 文档不再落后于代码 | 小 | 无 | 每阶段随做 | **进行中**：三份文档已按阶段 E 之后的代码收口；2026-10-04 追加图片输入（`images`）与实时链缺陷（O9）两轮收口，O9 修复后同步已收口；裁定编号留在 [LEAD-DECISIONS.md](LEAD-DECISIONS.md)，不进正文 |
| O9 | 客户端读取调度：`changed` 驱动的尾随去抖 + "最新一次读取生效"的序号守卫 + 取消在飞请求 | 消除乱序覆盖（面板回退到旧 `revision`），并压掉写密集时的重复整份读取 | 小 | 只改客户端读取调度，不动 Host 与 401 终态策略；筛选切换必须仍无条件生效（同一 `revision`、不同查询） | P1 | **已完成（2026-10-04）**：三件都落在 `client.js` 的 `createBoardController`——`CHANGED_READ_DEBOUNCE_MS` 尾随去抖、`readSeq` 最新读取守卫、`AbortController` 取消在飞读取；筛选切换照旧无条件生效。定位与现象见 [EXTENDING.md](EXTENDING.md) §8。证据：`tests/client-smoke.mjs` 314/314（乱序不覆盖、突发合并成一次读取、被取消的读取、同一 `revision` 的筛选切换）、三条红控 `tests/verification/_o9_red_controls.txt`、真浏览器门 14/14 `tests/verification/_o9_panel_render.txt`（门新增"写入必达面板"的活链断言） |

## 5. 分阶段计划与验收

| 阶段 | 内容 | 完成定义（可验证） | 现状 |
|---|---|---|---|
| **P0 DAG 流程图、写返回归一、`live.mjs` 预检** | 分层 SVG 依赖图；所有写返回同一派生视图 | 离线套件按当时的计数全绿；`live.mjs` 需一个运行中的 Host | **已完成**：写返回归一由 `#present()` 统一，`tests/client-smoke.mjs` 从渲染几何反推依赖图列与边 |
| **P1 存储接口迁移** | 引入 `zod` 与 domain 表单；`defineDomain` + 表 + global；删 `store.js`；CAS 挪进写链；一次性导入 | 坏记录 open 报 `invalid-record`、`expectedRev` 不符在链上被拒、导入幂等、`nextRevision` 自愈；`dataDir` 移除后旧配置明确失败 | **已完成**：`tests/domain.mjs` 88 项、`tests/smoke.mjs` 66 项；`dataDir`/`documentPath` 现在报 `invalid-config` |
| **P2 SQLite 路由** | 2.4 的 profile 补丁 + 实测数据真的落在 `.db` 里 | 库文件生成于 `storage-sqlite` 的该域路径；`routes` 切回 `json` 后行为一致；两条路都进测试 | **已完成**：开发期库在 `.artifacts/requirement-board/dev-board.db`；双后端一致性由 `tests/domain.mjs` 与 `probes/` 的对照覆盖 |
| **P3 其余优化** | O1–O6 + O8 按级别推进（**O7 已定：不做**） | 每项各自的用例与文档更新；O5 需要截图通道可用 | **部分**：O1 完成、O2 由 O1 取代、O3 一半、O4/O5/O6 未做、O8 进行中、**O9 完成（2026-10-04）**；同时期的角色化分发（阶段 A–E）已落在同一套 domain 表单上，见 [ROLE-DISPATCH.md](ROLE-DISPATCH.md) |

P1 开工前的两个前置探测都已结论，实录见 [probes/S1-S2.md](probes/S1-S2.md)：

- **S1 依赖解析**：可行——插件目录 `node_modules` 用 junction 指向仓库 pnpm store，`package.json` 声明 `zod` 与两个 `@deepseek-ai/dsh-storage-*` 依赖后，运行中的 dsh 进程内解析成立（见 2.5）。
- **S2 组合写入**：可行，但有四条硬条件——新增 `storage-sqlite` 行必须带 `insert`；指名 `id` 的补丁整段替换 `config`，所以 `storage-domain` 必须重述 `backend: json`；路由键必须写成下划线的 `requirement_board`；`storage-sqlite` 必须在插件自己的 `dependencies` 里（见 2.4）。

## 6. 风险与现状

| 风险 | 说明 | 现状与应对 |
|---|---|---|
| zod 与 domain 表单的版本耦合 | 插件直接 import zod，DSH 升级 zod 大版本会同时影响两边 | `zod` 依赖范围跟随 `storage-domain`（S1 已确认解析成立） |
| `storage-sqlite` 无迁移 | 物理布局版本不符即拒绝，平台不做迁移 | 用平台介质的导出/导入 + DSH 升级演练；升级前先备份 `.db` |
| 同步驱动阻塞事件循环 | `node:sqlite` 每次调用阻塞 JS 线程，单语句级；看板规模可接受 | 不做批量大事务；写入路径保持单记录 |
| 跨进程无实时推送 | 平台 deferred | 文档明确"单 Host 进程权威"；不用"多进程安全"措辞 |
| 安装位置搬出仓库 | bundle 需要一次真实安装，安装位置变了解析规则也跟着变 | **未决**：开发期靠 junction；搬迁与真实安装属阶段 R |
| 改动面大 | 存储层是插件的心脏 | 已按 P1 → P2 → 角色化阶段顺序落地；旧文件改名保留在 `.migrated`，可回滚 |

## 7. 明确不做

- 不做多进程/多机共享（等平台的跨进程推送或远程后端）。
- 不引入界面依赖或构建步骤（流程图继续手写 SVG，不引 Mermaid/dagre/cytoscape）。
- 不把领域规则（流转、完成条件、前置依赖）搬进存储层：`flow.js` 仍是唯一来源。
- 不为"以后可能换数据库"预留抽象层：接口层已经由平台提供，插件只依赖 domain 表单。
