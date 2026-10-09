# 需求看板 Requirement Board

一个跨会话需求管理插件：本 Harness 的所有会话共享同一份需求数据，流程模板可自定义，
节点流转实时同步到每个打开的页面，会话里的 AI 也能读写同一块看板。

- 侧边栏「需求看板」入口 + 主面板（列表、筛选、统计、流程图、节点详情、流转历史、队列、角色、执行单元）
- 三个 Agent 工具：`requirement_board` / `flow_template` / `requirement_role`
- **随包携带 skill `requirement-board-tasks`**：建、接、派看板任务的规范（查重、角色路由、一条任务一个交付物、
  选流程模板、先注册再跑、排队、派给子会话、跨角色门禁、要人拍板）随插件一起发布，装到哪台机器都在会话目录里
- 每个模型步骤自动注入当前看板摘要（角色行 + 指派 / 可接 / 我的队列 / 执行中 / 本会话 / 其他会话 / 待人类决策）
- **角色化分发**：按角色路由任务、执行锁、执行队列（软预留）、把同角色的活派给子会话、待人类决策的需求、跨需求门禁与优先级继承、执行状态自动同步
- **图片粘贴**：新建需求时可直接粘贴截图或选文件（PNG/JPEG/WebP/GIF，单张 ≤20 MiB，最多 20 张）；字节存在 `imageDir` 目录、记录里只留引用，agent 通过工具拿到引用与文件绝对路径
- 数据落在平台存储域 `requirement_board`（开发期 sqlite，JSON 后端是运行时回退路径）

模块划分、数据结构、接口与同步/并发机制见 [DESIGN.md](./DESIGN.md)；角色化分发的完整规格（判定表、
错误码、prompt 段落、已知边界）见 [ROLE-DISPATCH.md](./ROLE-DISPATCH.md)；存储后端选型与迁移记录见
[OPTIMIZATION.md](./OPTIMIZATION.md)。

---

## 安装

本包住在仓库的 `bundles/dsh-requirement-board/`，**随分支走**。安装是 profile 级、持久的：影响该 profile
的所有会话，重启后依然生效。

```
plugin_manager { action: "install_bundle", target: "<仓库绝对路径>\\bundles\\dsh-requirement-board" }
```

本地目录安装是**链接**语义：profile 的 `node_modules` 里放符号链接指向这个目录，不拷贝、也不按 `files`
过滤，所以改完 Host 代码要重启 `dsh web`（浏览器半边刷新页面即可）。`application: applied` 表示已生效；
`restart-required` 表示重启后才生效。装好后刷新 `http://127.0.0.1:3080`，侧边栏出现「需求看板」。

依赖（`@deepseek-ai/dsh-storage-domain`、`zod`）由 DSH 的运行时解析拦截按 `peerDependencies` 供给，
包内不放 `node_modules`。`cordis.patch.yml` 另外插一条部署级 `skill-filesystem` 行，把本包的
`skills/requirement-board-tasks/` 发布进 skill 注册表的全局层——任何 preset 的会话都读得到，无需改 preset。
安装、跨版本豁免、skill 挂载、SQLite 路由与 preset 角色声明见 [INSTALL.md](./INSTALL.md)。

---

## 使用

### 面板

1. **列表**：左栏按筛选条件列出需求；点一条在右栏展开详情。卡片上有锁持有者与时长、执行中数量、
   已派给谁（未接）、被谁排队预留、角色徽标、`↑` 抬高与关键路径标记。
2. **筛选**：搜索框 + 状态 / 优先级 / 负责人 / 所属会话 / 角色 / 类型下拉，以及"只看可接"、"执行中"、
   "已派发"、"我的角色"。"状态 = 未完成"表示"既没完成也没归档"。
3. **统计条**：整体完成率、总数、进行中、阻塞、阻塞项计数、停滞项计数；另有角色分布、决策数、
   队列/预留、孤儿锁、待接派的派发、执行同步缺口。`criticalPath` 是**被抬高的条数**，逐条的标记是 `escalated`。
4. **流程图**：按 **前置依赖分层** 渲染——每个节点排在它最靠后的前置节点的右边一列，同列节点纵向错开，
   每一对 `dependsOn` 关系都画一条带箭头的边；完成 = 绿色 ✔、进行中 = 高亮 ◐、未开始 = 灰色 ○。
   依赖跨步时边会绕到被跨节点下方，不会压在节点上；列的先后就是需求的实际推进顺序。
   点任意节点即可看到它的处理人、完成条件、检查项、进入/完成时间、停留时长与此刻允许的操作。
5. **流转历史**：倒序展示每一次流转（谁、何时、从哪个节点到哪个节点、说明、耗时）。
6. **队列**：按会话分组的软预留列表，队头由服务端给出；可清任意会话的预留（面板动作 `unqueue` 带
   `targetSession`）。面板**没有"认领"按钮**——面板 actor 的会话是空串，占锁会让所有 AI 会话被锁挡住
   直到租约过期；要让某个会话做就"派发"。
7. **角色管理**：角色列表（id、显示名、职能、在线/空闲、未完成数），临时角色行标 `ephemeral` 与绑定；
   可手工新增/编辑/删除（只走面板，模型侧只有 `list`）。
8. **执行单元**：任务详情里列出被观察到的子智能体与后台任务（种类/标签/状态/进度/起止），
   `executionsTruncated` 表示只保留最近的若干条，`sync.gap` 表示丢过观察。
9. **新建需求 / 新建流程模板**：右上角两个按钮。模板节点一行一个：`名称 | 负责人 | 检查项1;检查项2`。
10. **进度视图**：右栏底部常驻，展示各节点平均耗时（样本数 / 平均 / 最短 / 最长）、阻塞项、停滞项。

### 和 AI 一起用

对会话里的 AI 直接说需求即可，例如：

- "在看板上建一条需求：登录页支持企业微信扫码，负责人张三，优先级高"
- "把 `req_1a2b3c4d5e` 推进到下一个节点"
- "把刚才那条需求回退到方案设计，说明：接口契约要改"
- "现在整体进度如何？有哪些阻塞项？"
- "这条活给 `godot-review-board` 角色做，我手上有活先排进队列"
- "把这条需求派给子会话 `ses_xxx`"
- "帮我拍个板：描边用 2px 还是 3px？（选项 A/B 与代价写在描述里）"

AI 用的工具与面板走同一套服务方法，所以 AI 的改动会立刻出现在面板上，反之亦然。
任务创建与派发的行为规范另有一份随仓库的 skill：`.agents/skills/requirement-board-tasks/`。

### 工具

**`requirement_board`**（18 个动作）

| action | 关键参数 | 说明 |
|---|---|---|
| `list` | `session` `owner` `status` `priority` `kind` `role` `templateId` `query` `claimable` `limit` | 列表与筛选，`status: "open"` = 未完成；`claimable: true` 只列当前 `me` 能接的 |
| `get` | `id` | 单条完整视图（`flow`/`progress`/`history` + 锁、委托、执行单元、门禁、`claimable`/`advanceable`），并附调用方自己的 `queue` |
| `create` | `title`（必填）`description` `kind` `priority` `owner` `templateId` `role` `sessions` `labels` `parentId` `blocksOn` | 自动并入你的会话，落在模板首节点 |
| `update` | `id` + 要改的字段 | 可改 `title`/`description`/`priority`/`owner`/`labels`/`sessions`/`templateId`/`role`/`parentId`/`blocksOn`；`kind` 不可变 |
| `claim` / `release` | `id` | 拿锁 / 放锁；`claim` 的拒绝理由区分"被锁"（可能附 `queued:true`）、"被预留"、"已有别的锁" |
| `queue` / `unqueue` | `id` | 排队（软预留）/ 取消；`unqueue` 只清自己的，面板可清任意会话 |
| `delegate` | `id` `session` `duties` `roleName` `revoke` | 派给指名子会话（每任务一个临时角色）；`revoke: true` 撤销 |
| `transition` | `id` `transition` `to` `note` `force` | `advance` / `rollback`（需 `to`+`note`）/ `jump`（需 `to`+`note`+`force`）/ `complete` / `reopen` |
| `checklist` | `id` `index` `checked` | 勾选当前节点的检查项 |
| `block` / `unblock` | `id` `reason` | 阻塞需原因 |
| `archive` / `restore` | `id` | 归档 / 恢复；归档同时释放预留并结算委托 |
| `delete` | `id` | 删除需求及其历史，并解绑引用它的门禁链接与队列项 |
| `stats` | — | 完成率、分布、节点耗时、阻塞与停滞、角色/决策/队列/执行同步读数 |
| `changes` | `since` | 某个时刻之后的变更与流转（补上下文用） |

**`flow_template`**：`list` / `get` / `create`（`name` + `nodes[]`）/ `revise`（**追加一个版本**，存量需求一行不动）/ `migrate`（把需求迁到新版，不指名 `requirementIds` 即全部迁移、需 `force`）/ `archive`（`archive: false` 恢复）/ `clone`（改内置流程的正路）/ `delete`（被引用时需 `force`，会改绑受影响需求并写历史）。裁剪历史版本的 `prune` 只在面板、不在工具面。
**`requirement_role`**：`list`（含 `dutiesMissing`/`unregistered`/`ephemeral`/`boundSession`/`boundTask`/`holders`）。

所有写操作都可带 `expectedRev`：与库中不一致时返回 `conflict{expected,current}` 而不会覆盖其它会话的修改。
参数本身不合法（未知动作、形状、上界、非法 `kind`）报 `invalid-argument`；写法没问题但当前组合/状态不允许
（队列已满、把任务派给自己）报 `invalid-input`。完整失败码表见 ROLE-DISPATCH.md §8.2。

---

## HTTP 接口

浏览器半边使用，也可自行调用（`http: false` 可关闭）：

| 端点 | 说明 |
|---|---|
| `GET  /api/requirement-board/snapshot` | 快照：`{ revision, generatedAt, requirements, total, templates, roles, stats, queues }`；支持 `status`/`owner`/`session`/`priority`/`kind`/`role`/`templateId`/`query`/`claimable`/`limit`/`offset`/`me` |
| `GET  /api/requirement-board/events` | SSE：`ready` 与 `changed`（写提交后按 `sseCoalesceMs` 合并），15s 心跳 |
| `GET  /api/requirement-board/health` | 存活探测 |
| `POST /api/requirement-board/command` | `{ "action": "transition", "id": "req_…", "transition": "advance", "expectedRev": 7 }` |
| `POST /api/requirement-board/image?name=` | 图片字节上传：**body 是原始字节**（不是 JSON），`content-type` 是媒体类型，`name` 是原文件名；回 `{ image: { id, name, mediaType, byteLength, width, height, createdAt } }` |
| `GET  /api/requirement-board/image/<id>` | 取回图片字节（`content-type` 为存储时的媒体类型）；未知 id 回 404 |

`me` 是**会话 id**（不是角色名），它只决定 `claimable`/`advanceable` 为谁作答；`?role=human` 是人的收件箱
（决策需求与 `human` 角色的任务），`?claimable=true` 是"这个 `me` 现在能接的"。面板 command **没有**
`claim`/`queue`：`session` 非空的需求不得认领。

信封：成功 `{ "ok": true, "data": … }`；失败 `{ "ok": false, "error": { "code", "message", "details" } }`。
`BoardError` 返回 409，其余 500。信任判定先用平台的连接服务（401/403），没有该服务时退回回环 `Origin` 校验（403）。
图片上传/读取是**二进制路由**：上限按单张 20 MiB 判定，不受 JSON 的 256 KiB 请求体上限约束。
除 `delete` 外，所有写命令的 `data` 都是同一个需求派生视图（含 `flow` / `progress` / `history` /
`lastTransition`），与 `snapshot` 里的需求对象同构。`update` 的字段放在 `patch` 里，`expectedRev` 放在信封顶层。

---

## 配置

`cordis.patch.yml` 里唯一一行 `requirement-board`；列出的 9 个键都有默认值，其余 4 个（`executionSync`、
`requireLockForExecution`、`maxExecutions`、`sseCoalesceMs`）使用 `host/config.js` 的默认值：

```yaml
- insert:
    - id: requirement-board
      name: dsh-requirement-board
      config:
        defaultTemplateId: tpl-standard
        stallAfterHours: 72          # 活跃节点多久没动算"停滞"
        staleClaimHours: 8           # 执行锁租约（小时）
        promptContext: true          # 把看板注入每个模型步骤
        promptMaxItems: 12           # prompt 各段共享的总条数预算
        maxQueueItems: 20            # 每会话队列长度上限
        http: true                   # 注册浏览器路由
        importLegacy: false          # 旧 JSON 一次性导入（只该在阶段 R 开一次）
        imageDir: ''                 # 粘贴图片的字节目录；留空即默认（<看板目录>/images）
```

数值越界或类型不对会在装载时立即报 `invalid-config`，不会静默取默认值。
全部 13 个字段、默认值与范围见 [DESIGN.md](./DESIGN.md) §8。**没有 `dataDir`**：存储后端与路径由部署的
`storage-domain.routes.requirement_board` 决定；`imageDir` 是唯一例外（图片字节从不进记录，存储路由管不到）。

---

## 数据、备份与导入

数据在存储域 `requirement_board`（version 2）里，四张表 `requirements` / `templates` / `roles` / `queues`
加一个全局单例（`revision`、执行同步计数、导入凭据）。介质由部署选择：开发期 `dev.overlay.yml` 把它路由到
sqlite（`.artifacts/requirement-board/dev-board.db`），键写错会静默回退 JSON 后端且没有任何报错——所以路由键
必须是下划线的 `requirement_board`。

- 备份/迁移用平台介质的导出/导入；JSON 后端下介质就是一个完整文件，任何时刻都不半写（先写 `.tmp` 再 rename）。
- 打开时逐条 zod 校验：任何一条不合法都以 `invalid-record` 拒绝启动，不会猜测解析。
- **旧 JSON 导入**：`importLegacy: true` 时才尝试一次，且要求域里没有需求记录、全局没有 `imported` 凭据；
  导完把源文件改名为 `*.migrated` 保留。默认关闭，避免开发库误吸生产数据。
- **图片字节在记录之外**：一个图片一个文件（`<id>.<ext>`）加同名 `.json` 元数据，默认在看板目录下的
  `images`（`imageDir`；看板目录＝运行时 `DSH_PROFILE_DIR` 下的 `requirement-board`，没有该变量时
  `~/.dsh/requirement-board`）。文件不可变——归档或删除需求都不会删文件，因为一张图
  可能被多条需求引用、上传也可能发生在任何记录命名它之前；所以**备份要连这个目录一起备**，
  孤儿文件是预期状态，不是悬挂引用。

---

## 开发与测试

```powershell
cd <仓库绝对路径>\bundles\dsh-requirement-board
node tests/domain.mjs         # 域表单与导入：124 项
node tests/smoke.mjs          # Host 流程/并发/HTTP/图片：89 项
node tests/roles.mjs          # 角色解析链与建档：220 项
node tests/dispatch.mjs       # 锁与判定表：322 项
node tests/queue.mjs          # 执行队列与软预留：304 项
node tests/delegate.mjs       # 子会话派发：344 项
node tests/decision.mjs       # 决策需求：228 项
node tests/gates.mjs          # 门禁与优先级继承：246 项
node tests/runs.mjs           # 执行状态同步：312 项
node tests/client-smoke.mjs   # 浏览器半边（桩件真实渲染）：314 项
node tests/templates-revision.mjs   # 模板版本管理（追加版本、钉版本、迁移、裁剪）：316 项
node tests/loader.mjs         # 装载清单与配置：53 项
node tests/composition/driver.mjs   # 真组合通道（需 runner 提供隔离 cwd 与环境）
node tests/verification/*.mjs       # 各阶段独立验证仪器
node tests/live.mjs [baseUrl]       # 对已运行服务器（默认 http://127.0.0.1:3080）的端到端检查
```

离线套件都不需要网络、浏览器或构建步骤。`client-smoke.mjs` 用桩件替代 module loader / React /
客户端服务 / `fetch` / `EventSource`，真实渲染面板并驱动交互，因此能在没有浏览器的情况下抓到
渲染期错误、locale 字典键错位、未捕获的 Promise 拒绝等问题。`live.mjs` 会创建并删除自己的探针需求，
可直接对正在运行的 GUI 服务器执行。

> **改完 Host 代码要重启 `dsh web`**：profile 的 HMR 不监听插件模块文件，重新启用插件只会重跑配置，
> Node 的 ESM 缓存仍返回旧模块。浏览器半边不用重启——模块注册表按文件时间戳生成 `rev`，刷新页面即可。

---

## 验证报告索引

`tests/verification/` 下是各阶段独立验证者的实录（含变异对照与原始输出）。它们是**当时的实录**，保持原样；
其中一处结论与现状不同，读时以本条为准：

- `A1-verification.md` 的「观察 A（prompt 不读 roles 表）」**已被 A3 取代**：`host/roles.js` 的 `promptLine`
  现在读 `roles` 表的记录（记录不存在时才退到预设声明、再退到预设 id）。

---

## 限制与已知例外

- **权威数据只在一个 Host 进程内**；域内并发由平台的单域写链串行化，精确并发控制靠 `expectedRev`。
- 浏览器半边硬编码 `/api/requirement-board`（同源 Web GUI 场景）；桌面 `file://` 形态需要另配 base URL。
- 面板是根级插槽，不属于某个会话，因此"所属会话"在建需求时手动填写（AI 创建时会自动带上它自己的会话）。
- HTTP 路由只做平台信任判定或回环 `Origin` 校验，不做身份认证；面板操作不是权限系统。
- `history` 上限 500 条，超出后最早记录被裁掉（`changes` 同时返回 `truncated: true`）。
- **归属校验会降级**：`owns(target, caller)` 在会话注册表缺失或调用方没有活 Agent 时返回"不可判定"，
  此时放行并记一次具名 warn；只有明确判定为"不是你的子会话"才拒绝。
- **首轮工具 JSON schema 与 prompt 字符预算没有回归守门**：插件不进受控源码，仓库的
  recorded-session snapshot 树无法 pin 它（`tests/prompt-budget.mjs` 因此不存在）。这是**明确例外**：
  段序与各段文本以 `tests/client-smoke.mjs` 与 `tests/*.mjs` 的断言为准，字数上限只在人工复核时量。
- **本目录已在版本控制里**：`bundles/dsh-requirement-board/` 随分支分发，安装方式见 [INSTALL.md](./INSTALL.md)。
  早先的开发树 `.artifacts/requirement-board/`（`.gitignore` 第 40 行）已退役；本目录内的历史文档
  （OPTIMIZATION.md、R-ROLLOUT.md、各 verification 报告等）仍按当时的路径描述，读时以本条为准。
  文件卫生按受控源码的口径维护（UTF-8 无 BOM、LF、每个文件恰一个尾换行）。
- 真子会话端到端（真 `agents.isOwnedBy` + 真子会话）需要在受控 profile 下碰 `~/.dsh`，须用户确认后才能做；
  未获确认前，该路径由 `tests/delegate.mjs` 的注入端口覆盖。
- **面板比提交点晚至多一个去抖窗口**：`changed` 帧经 `CHANGED_READ_DEBOUNCE_MS`（200ms）尾随去抖合并成一次整份
  重读，每次重读取一个序号、**只有最新那次能覆盖面板**，新读取还会用 `AbortController` 取消在飞的那次。所以写密集时
  并发响应不会把面板退回较旧的 `revision`，代价是面板更新比提交晚一个去抖窗口。实现与证据见
  [EXTENDING.md](./EXTENDING.md) §8 与 [OPTIMIZATION.md](./OPTIMIZATION.md) O9。
