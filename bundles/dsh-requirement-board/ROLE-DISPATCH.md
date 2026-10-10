# 角色化任务分发实现方案（v6）

> 状态：**阶段 0–G 文档同步已落地**；实现与测试是事实源（`host/**`、`index.js`、`client.js`、`cordis.patch.yml`、`tests/**`），本文档据此同步。现状实现见 [DESIGN.md](DESIGN.md)，存储迁移见 [OPTIMIZATION.md](OPTIMIZATION.md)，裁定记录见 [LEAD-DECISIONS.md](LEAD-DECISIONS.md)。
> 一句话：**角色是库里的实体**（ID + 职能），会话通过预设拿到自己的角色；**派给子会话时由派发方为该任务铸造一个临时角色 ID 并指名该子会话**；
> **执行前必须先注册任务并上锁**（锁按任务 ID，互斥但不做内容去重）；**一个会话同时只持一把锁，多任务靠队列排队（排队即软预留）**；
> 会话 / 子智能体 / 后台任务的**状态变动实时同步进库**；门禁**可选**、有门禁时拦路那条等级**自动抬高**；**创建任务后不通知角色**，也不自动认领；规范由**单独一个 skill**承担。

## 1. 目标与边界

### 1.1 要达成的

| 你的要求                         | 落地形态                                                                 |
| --- | --- |
| 角色之间不耦合                      | 角色记录之间没有层级/父子/依赖；需求单向引用角色 id；路由只按**职能**匹配（3.6 / 5.6）                 |
| 数据库存有角色信息：职能与 ID             | `roles` 表（domain 记录）`{ id, name, duties, source }`（3.1 / 4.1）        |
| 有对应职能的需求/建议时，创建需求给指定角色       | 先 `requirement_role{action:'list'}` 看职能 → 匹配就填 `role`；不匹配/跨职能留空（5.6） |
| 会话 AI 有自己的角色                 | 预设的 `board-role` 行声明 `roleId`；没声明的预设**用预设 id 兜底**（2.1）               |
| **给子会话发任务：为该任务定一个临时角色 ID**   | `delegate` 为**这条任务**铸造 `ephemeral` 角色并把任务 `role` 设为它（5.5）            |
| **告诉子会话"这是你的角色 ID / 你负责什么"** | 两条通道：派发方按模板说一次 + 看板把它注入子会话的 prompt（**不自报角色**）                        |
| **子会话用这个角色 ID 去接指定的任务**      | 该任务的 `delegatedTo.session` = 子会话 → 子会话对这条任务天然有资格（5.4 判定表第 3 条）       |
| **一个会话同时只允许一个任务锁**           | 第二把锁 → `conflict{code:'session-busy'}`（5.2）                          |
| **允许先把任务排队，从而执行多任务**         | `queue`/`unqueue`：每会话一个队列，**排队即软预留**，完成手上的再接队头（5.3）                  |
| 执行前先注册任务再跑                   | 注册(`create`) → 上锁(`claim`) → 执行 → 推进 → 完成；**无锁不得推进/改定义**（5.1 / 5.4）  |
| 任务状态同步，含子智能体与后台任务 | 执行单元 `executions[]` 实时落库；子智能体走 `subagent/start` / `subagent/end`，后台任务走 `jobs` 事件（5.5） |
| 任务上锁：同一任务 ID 不允许两个会话执行       | 锁按**任务 ID** 互斥，写链内 CAS；**不做内容去重**（5.2）                               |
| 任务角色可选，不指定则都可接               | `role: ''` = 任意角色可认领；填了角色 = 只有该角色（或该任务的被指名会话）能接                      |
| 主动推动角色接任务，不自动接               | 机制上无自动认领路径；prompt 用推动措辞 + `list{claimable:true}`；规范在 skill（5.11）     |
| 门禁是可选设置                      | `blocksOn` 默认空；只有"必须先清前置才能推进"时才设（5.8）                                |
| 有门禁时任务等级提高                   | **优先级继承**：拦路那条抬到不低于它挡住的最紧急那条，封顶 `urgent`（5.9）                        |
| 需要我做决策时创建需求给我                | `kind:'decision'` + `human` 保留角色；面板"待你决策"队列；**只能由人在面板推进**（5.7）       |
| 美术与程序配合协作                    | 同角色内 → 临时角色派给子会话；跨角色 → 注册任务给该角色，等它的会话来认领（5.5 / 5.11）                 |
| 任务创建有一套规范                    | **单独一个 skill**（开发期 `<repo>/.agents/skills/`，启动期提升到 `~/.dsh/skills/`；见 §7），含派发模板    |

### 1.2 做不到 / 不做

- **依赖一个部署前提**：派发链要求子智能体为 **`backgroundMode: 'continuable'`**（bundle 默认已开：`packages/bundle/base/cordis.patch.yml:375`；三个预设也各有：`packages/bundle/web-app/presets/standard.patch.yml:100`、`packages/bundle/web-app/presets/ptc.patch.yml:100`、`packages/bundle/web-app/presets/cordis.patch.yml:99`），因为只有 continuable 的工具回执带子会话 id（`subagentId`，`tool-subagent/src/index.ts:536`）；foreground 会阻塞到结束、one-shot 后台只回 `jobId`。换用默认配置的部署必须显式打开这个模式，否则派发链不可用。
- **不改子会话的预设**：经模型可见的子智能体工具（及其它 driver / workflow / team）**没有任何预设或角色入参**（证据见 2.4）。平台只在**插件代码**层提供 `agentPresets.select()` 与 `agents.create({ setup })` 两条通道，本方案**不使用**（角色是数据实体不是预设，且 `select` 有首轮竞态）。
- **不自动创建/恢复会话**：不使用 `agents.create()` / `resume()` 去"派活即起执行会话"。
- **不唤醒**：会话 AI 只在有人给它回合时运行；子智能体由父会话的工具调用驱动。
- **不通知**：创建/派发不产生任何面向角色的信令（5.10）；子会话知道自己的角色与任务，靠派发方的消息 + 看板注入它的 prompt。
- **不自动认领、不自动分配、不自动开工**（`complete` 只**提示**队头，不自动上锁，5.1）。
- **不拦平台工具**：默认不阻止任何会话使用子智能体或后台任务；硬门槛 `requireLockForExecution` 默认关（5.4）。
- **不做内容去重**：不看标题/描述是否相同，不去重、不合并、不校验唯一性 —— 只认任务 ID（5.2）。
- **不承诺多进程安全**：迁移到平台存储后**文件级**不会互相覆盖，但语义级仍是"单 Host 进程权威"（OPTIMIZATION.md 2.7）。
- **不为"以后可能换数据库"预留抽象**：接口层由平台 `ctx.storage.domain` 提供（阶段 0）。

## 2. 会话与子会话的角色

### 2.1 我自己的角色（两级）

```js
const agents  = ctx.get('agents')          // 可选服务
const presets = ctx.get('agentPresets')    // 可选服务
const agent   = agents?.get(sessionId)
const declared = agent === undefined ? undefined : presets?.serviceFor(agent, 'requirementBoardRole')
const presetRole = declared?.roleId ?? (agent === undefined ? undefined : presets?.composedPreset(agent.ctx))
// 我自己的角色 = { roleId, roleName, duties } | undefined
```

依据：`serviceFor(agent, name)` 读"某个 Agent 预设组内部提供的服务"（仓库先例 `packages/api/session-controller/src/skill-catalog.ts:62-64`）；它只返回该 scope 自身 realm 的实例（`packages/preset/agent-preset-registry/tests/registry.spec.ts:214-216`）；`composedPreset(ctx)` 给出预设 id 兜底。

**兜底是关键**：没有显式声明的预设自动用**预设 id** 当角色，所以内置预设零改动就有角色。`agents`/`agentPresets` 都是**可选读取**，读不到就降级（2.6）。

**兜底值必须本身就是合法角色 id**：预设 id 是平台的自由字符串（`packages/preset/agent-preset-registry/src/index.ts:83` 只要求非空），所以形如 `Art Team` 的 id 按 §2.3 的同一套格式拒绝 —— **不建档、prompt 无角色段**，并按 id 各报一次具名 warn（`host/roles.js` 的 `resolveOwn`/`#warnPresetId`）。记下一个谁也路由不到的角色是这条链唯一不能产生的后果。

**注意**：这里解析的是"我自己的角色"，用于**公共任务**的资格。**被指派给我的任务**（`delegatedTo.session === 我`）另有资格来源，见 5.4 判定表第 3 条 —— 不需要在会话上做"绑定优先"的角色覆盖。

### 2.2 本机的覆盖结果（8 个预设）

| Loader 行                                                                         | 预设 id                | `presetRole` | 来源                                                      |
| -------------------------------------------------------------------------------- | -------------------- | ------------ | ------------------------------------------------------- |
| `preset-standard` / `ptc` / `minimal` / `cordis`                                 | 同名                   | 兜底值（可显式覆盖）   | 内置（web-app bundle）；不给内置预设加行（opt-in 不进 shipped defaults） |
| `preset-godot-review-board`                                                      | `godot-review-board` | 可显式覆盖        | profile patch                                           |
| `preset-godot-game-suite` / `game-mechanics-designer` / `godot-shader-developer` | 同名                   | 可显式覆盖        | 自定义插件包                                                  |

**已知代价**：内置预设的兜底角色**没有职能**（`dutiesMissing`），按职能路由只对写了 `duties` 的角色有效（3.4）。这是"零改动"的代价，写进限制。

### 2.3 自定义预设显式声明（必须包在 isolate 组里）

```json
// package.json
"exports": { "./role": "./role.js" }
```

```yaml
# profile patch 里该预设的 config.plugins 中加这一段
- name: cordis:group
  group: true
  isolate: { requirementBoardRole: true }
  config:
    - id: board-role
      name: dsh-requirement-board/role
      config: { roleId: art, roleName: 美术, duties: [角色立绘, 场景概念图, UI 图标] }
```

`role.js` 是**函数插件**：命名导出 `name` / `inject` / `apply`，**无 default**（混用导出形式会让 Loader 丢弃命名空间）；不声明 `Config` schema（不为几行配置引入 zod）。

**必须用 `isolate` 组包裹**：预设里直接 `provide` 等于往进程全局发布服务，注册表会把该预设判定为 **broken** 并列出泄漏的服务名（`registry.spec.ts:359-366`）；隔离后 `serviceFor` 才读得到（`:207-217`）。写法与 shipped 预设一致（`packages/bundle/web-app/presets/standard.patch.yml:42-49` 等三处）。

校验在加载时 fail loud：`roleId` 匹配 `^[a-z][a-z0-9_-]{0,31}$`、**不得以 `tmp-` 开头**（派发铸造的保留前缀）、**且不得等于 `human`**（保留角色；否则自定义预设能劫持"要人拍板"的语义）。同一套校验也用在面板 `put`。`roleName` ≤40 字，`duties` ≤12 项、每项 ≤40 字。

### 2.4 子会话的角色：平台事实

| 事实                                                                                                    | 证据                                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 子会话的 `meta.agentPreset` 恒等于父会话当前预设，无入参可覆盖                                                             | `packages/subagent/subagent/src/child-agent.ts:139-157`                        |
| 子组合从父会话组合出来                                                                                           | 同文件 `:205` `composeFrom(childCtx, parent.ctx)`                                 |
| `ChildComposition` 只有每子会话的 `persona` / `toolFilter`                                                   | 同文件 `:159-165`                                                                 |
| 子智能体工具入参只有 `description` / `prompt` / `provider` / `model` / `reasoning_effort` / `run_in_background` | `packages/subagent/tool-subagent/src/index.ts:389-428`                         |
| 各 driver / workflow / team 的能力位也没有 preset                                                             | `subagent/src/types.ts:130-136,145-201`；`tool-agent-team/src/index.ts:175-213` |

**结论**：子会话继承父会话的角色；**"给子会话定义角色"= 给这条任务铸造一个临时角色 ID**（5.5），而不是改它的预设。跨角色的活不能派给子会话（它接不了），只能注册任务等那个角色的会话认领。

### 2.5 可信边界

| 入口          | actor 来源                                    | 可信度                  | 用于角色鉴权与锁         |
| ----------- | ------------------------------------------- | -------------------- | ---------------- |
| Agent 工具    | `exec.agent.id`（服务端取得）                      | 可信                   | 可以               |
| HTTP 路由（面板） | `body.session`（客户端自报）                       | 不可信                  | **不可以**（面板视为"人"） |
| 子会话         | `exec.agent.id` 命中任务的 `delegatedTo.session` | 可信（**派发方写入，子会话不自报**） | 可以               |

`role` 只在工具层解析后传入 service；HTTP 入口禁止携带角色，且 `session` 非空的 actor 不得 `claim`。**面板的"操作目标会话"走独立参数 `targetSession`，不复用 `session`**（后者在工具路径上是 actor，语义不能混）。在 service 层强制，两个入口各测一次拒绝。
**新暴露的限制**：`jobs.list(caller)` 的过滤是 `job.owner === undefined || job.owner.id === caller`（`packages/jobs/jobs-local/src/index.ts:306-310`）—— **无主 job 对所有 caller 都可见**，所以它**不是鉴权**；本插件只在同步用途上使用它，不把它当权限边界。

### 2.6 没有角色 / `human`

服务缺失且无声明时该会话只能认领 `role:''` 的任务，prompt 不出现角色段。`holders` 派生在 `agents` 缺失时返回 `{ online: null }` 并标注"无法统计"，不假装 0（3.5）。
**`human` 是保留角色**：等于"要人拍板"，不是给 AI 的角色池；`human` 会话能看决策队列但不能替人推进（5.7）。

## 3. 角色记录

### 3.1 记录结构（`roles` 表，每角色一条 domain 记录）

| 字段                           | 类型                                                  | 说明                                      |
| ---------------------------- | --------------------------------------------------- | --------------------------------------- |
| `id`                         | `string`                                            | 角色 id；`tmp-` 前缀为派发铸造的临时角色               |
| `name` / `duties`            | `string` / `string[]`                               | 显示名（缺省 = id）；**职能** ≤12 项、每项 ≤40 字      |
| `source`                     | `'preset' \| 'manual' \| 'observed' \| 'delegated'` | 记录怎么来的                                  |
| `ephemeral`                  | `boolean`                                           | 临时角色：随任务收尾删除（3.3）                       |
| `boundSession` / `boundTask` | `string`                                            | **仅临时角色**：绑定到哪个会话、哪条任务（**每任务至多一个临时角色**） |
| `createdAt` / `updatedAt`    | ISO                                                 |                                         |

约束：`roles` 是**扁平表**，记录之间无任何关系 —— "角色之间不耦合"落在结构上就是这个。`boundSession`/`boundTask` 是**任务绑定**，不是角色之间的关系。

### 3.2 建档时机（四种来源）

| 来源          | 时机                                              | 写入内容                                                                   |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `preset`    | `agent/created` 里解析到该会话的角色声明                    | 取自 `board-role` 行；与库里现值不同才写                                            |
| `manual`    | **面板**编辑角色（HTTP；模型面不开放，见 5.6）                   | 显式给的 `name`/`duties`                                                   |
| `observed`  | `agent/created` 里没有声明、只有预设 id 兜底（2.1）    | 只建 `{ id, name: id, duties: [] }`，标 `dutiesMissing`                    |
| `delegated` | `delegate` 派发                                   | 铸造 `tmp-<任务id>`，`ephemeral`，带 `boundSession`/`boundTask`，`duties` 取派发方给的 |

**需求引用不是建档时机**：`create`/`update`/`delegate` 写下的 `role` 只按格式校验，既不查角色表也不补记录。库里没有该 id 时它是**派生可见**的未登记状态（`roleUnregistered`，3.4），不是一个 `observed` 记录 —— 引用本身不足以定义职能。

`agent/created` 契约（已核对）：serial、`payload: { agent, source, signal? }`（`signal` 可选）、"ready for per-agent initialization **after factory setup**"、**"listeners run in order and are awaited before creation resolves"**、**"a throw or rejection fails creation"**。

三条硬约束：

1. **建档失败绝不能连累会话创建**：监听器**单语句 try**，`catch (error)` 命名错误与原因后写结构化 warn，不向上抛。
2. **不在读路径写库**（prompt 组装、面板渲染只读）；**执行同步的对账也不在读路径**（5.5）。
3. 常见情况（角色已在库且无变化）**零写入**。

### 3.3 临时角色的生命周期（每任务一个）

| 事件                        | 处理（同一写链：串行、非原子）                                                       |
| ------------------------- | -------------------------------------------------------------- |
| `delegate`                | 铸造（或替换）该任务的临时角色；任务 `role` = 它、`delegatedTo` 记录（含 `roleBefore`） |
| 重复 `delegate` 同一任务        | 先收尾旧委托（同 revoke），再建新的 —— 不允许两个临时角色指向同一任务                       |
| 任务 `complete` / `archive` | 删临时角色；清 `delegatedTo`；`role` 回退 `roleBefore`；**无论是否已被 claim**  |
| 目标会话 `agent/disposed`     | 同上；已 claim 时锁标 `orphaned`、running 单元结算、清该会话队列                  |
| `delegate{revoke:true}`   | 同上，并结算该任务的 `executions`（5.5）                                   |

**不变量**：任务收尾后 `role` 一定回到 `roleBefore`，绝不留下指向已删除角色的 `role`（否则任何会话都无法解析资格）。

### 3.4 缺职能怎么办（降级，不报错）

- 无 `duties` → `dutiesMissing: true`：**记录与预设声明都没有**职能时才算（`host/roles.js` 的 `#present` 与 `promptLine` 用同一条规则）。记录为空但声明有职能时，`requirement_role{list}`、面板与 prompt 一律报声明里的职能，不报"无法按职能路由"。
- 需求引用了库里没有的角色 → 允许，返回带 `roleUnregistered: true`，`list` 列为 `unregistered`。**引用本身就是证据**：即使没有任何活会话持有该 id，只要它被需求引用就列出，`holders` 计 `{ online: 0, idle: 0, running: 0 }`（`agents` 缺失时 `holders.online` 为 `null`）；角色删除不再级联，未登记状态由这条派生规则持续可见。
- 从不静默：要么能路由，要么明说。

### 3.5 持有人与在线状态（派生，不落盘）

`ctx.agents.list()` + `agent.status` → `holders(roleId) => { online, idle, running }`；临时角色另显示 `boundSession`/`boundTask`。
服务缺失 → `{ online: null }` + "无法统计"。
**边界（服务契约原话）**："Ambient presence is neither liveness proof nor authorization" —— 只用于展示与路由参考；鉴权仍走 `exec.agent.id`。

### 3.6 角色之间不耦合

扁平表；引用只有"需求 → 角色"单向；路由只按职能（5.6）；跨角色先后关系只表达在**需求**的 `blocksOn` 上。

### 3.7 预设 ↔ 角色的对照（派生，不落盘）

- 记录的 `source` 说的是"谁建的档"，**不是**"它属于哪个预设"：预设 id 兜底建档时二者恰好相同，但被面板改过的记录是 `manual`，删除重建后也可能对不上。所以对照关系不存字段，每次现算。
- 算法（`host/roles.js` → `presetRoster()`）：`agentPresets.list()` 取组合里声明的每个预设 → 有活会话时取该会话解析出的角色 id（`confirmed: true`）→ 没有活会话时按"预设 id 本身是合法角色 id"推定（`confirmed: false`，面板标"推定"）→ 连合法角色 id 都不是则为 `''`（面板标"不能作角色 id"）。`recorded` 查 `roles` 表，`dutiesMissing` 与角色列表同一条规则（3.4）。
- 读不到名册要能区分两种原因：组合没挂 `agentPresets` → `unavailable: { code: 'service-absent' }`；`list()` 抛错或没回数组 → `{ code: 'read-failed', detail }`。"名册为空"与"读不到"不是一回事，文案分开。
- 一键登记**不新增写路径**：面板按该行预填 id 与显示名，再走既有的 `role.put`（落成 `source: 'manual'`），登记后该行 `recorded` 转真。
- 不进 `snapshot()`：它同步、且在每次刷新/健康检查/SSE `ready` 都走，而 `agentPresets.list()` 要逐预设做启用诊断（异步）。面板只在打开角色管理时按需读一次（§8.1）。

## 4. 存储与数据模型

### 4.1 存储（阶段 0 迁移后）

接口层是平台 `ctx.storage.domain`；介质路由到 SQLite：

```js
defineDomain({
  name: 'requirement_board',                     // 域名必须匹配 UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/
  version: 2,                                    // 不声明 compatibleVersions：介质按精确版本戳校验
  tables: {
    requirements: domainTable(requirementRecordSchema),   // 每条需求一行
    templates:    domainTable(templateRecordSchema),
    roles:        domainTable(roleRecordSchema),          // 每个角色一行
    queues:       domainTable(sessionQueueRecordSchema),  // 每个会话一行（key = sessionId）
  },
  global: { schema: globalSchema, initial: { schemaVersion: 2, revision: 0, execSync: { ignored: 0, gaps: 0 } } },
})
```

**域名与路由键都写 `requirement_board`**（`host/domain.js:47-48`、`dev.overlay.yml:20-31`）：连字符不匹配 `UNIT_NAME_RE`，会静默落到默认后端而进程不报错。

**为什么写路径不经应用层整文档重写**：`storage-domain` 每条记录一次**单行 UPDATE**，写入成本与文档规模无关，`executionSync` 才能默认为 true。**执行单元不单独建表**：它是需求记录里的有界数组（≤ `maxExecutions`），一次 UPDATE；**平台不提供跨行事务**（单域一条串行写链，`storage-domain/src/domain.ts:148-149`），跨行一致性靠**防御性 join + 启动 sweep** 兜。

**启动 sweep**（插件挂载时跑一次，只写日志不写 history）：清掉队列里指向不存在任务的项、`blocksOn` 里的悬挂 id、无 `boundTask` 的孤儿 `tmp-*` 角色、`delegatedTo` 指向已销毁会话且角色已删的任务。派生字段（`reservedBy`/`children`/`blockedBy`）**一律对不存在的 id 做防御性 join**，不假设引用完整 —— 进程崩在跨行写中间时，这些引用会悬空。

写路径（CAS 在写链的槽位上）：

```js
await domain.table('requirements').update(id, record => {
  if (expectedRev !== undefined && record.rev !== expectedRev) {
    throw new BoardError('conflict', 'requirement changed', { expected: expectedRev, current: record.rev, lastChangedBy: record.lastChangedBy })
  }
  return recompute({ ...record, ...patch })
})
await domain.global.set({ ...globals, revision: revisionCounter })
```

**`rev` 只由"定义/流程写"推进**：`create`/`update`/`transition`/`checklist`/`block`/`unblock`/`archive`/`restore`/`claim`/`release`/`delegate`（含 `revoke`）推进 `rev`；**`queue`/`unqueue` 只写 `queues` 表与全局 revision，不动记录 `rev`**；**执行同步的写（`executions`/`sync` 字段）保留原 `rev`**，另记 `execRev` —— 否则长跑任务的进度抖动会让模型手里的 `expectedRev` 永远过期，陷入"重读→又变→再冲突"。
`domain/changed` 在提交点之后按写序发出 → SSE 的唯一来源（`store.onChange` 删除）。**每次链上写都会 emit**（含不推进 `rev` 的执行同步），所以转发前必须按 `sseCoalesceMs`（默认 300ms）合并 —— 否则一个多话 job 的进度抖动就把所有打开的面板拖进全量 refetch 风暴。


### 4.2 需求记录字段（持久化）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `role` | `string` | `''` | 可选；`''` = 任意角色可接；`tmp-*` = 该任务被指名派发（5.5） |
| `kind` | `'task' \| 'decision'` | `'task'` | **创建后不可变**（5.7） |
| `lock` | `{ session, name, at, touchedAt, orphaned? } \| null` | `null` | 执行锁；`at` = 认领时间（展示），`touchedAt` = 租约基准（5.2） |
| `delegatedTo` | `{ session, name, roleId, roleBefore, at } \| null` | `null` | 指名派发给哪个会话（5.5） |
| `executions` | `ExecutionUnit[]` | `[]` | 有界（≤ `maxExecutions`）；超出时置 `executionsTruncated` |
| `sync` | `{ gap: boolean, syncedAt: ISO \| null }` | `{ gap: false, syncedAt: null }` | 该任务的对账状态（5.5） |
| `parentId` / `blocksOn` | `string \| null` / `string[]` | `null` / `[]` | 上级需求；**可选门禁**（≤20、必须存在、不得成环） |
| `requestedBy` | `string` | `''` | `create` 时定格为调用方显示名（无名字时用会话 id）；决策队列"谁在等你" |
| 既有字段 | | | `id`/`title`/`description`/`priority`/`owner`/`sessions`/`labels`/`status`/`templateId`/`nodeId`/`nodes`/`blockReason`/`blockedAt`/`rev`/`createdAt`/`updatedAt`/`createdBy`/`updatedBy`/`history` |

`ExecutionUnit = { ref, kind: 'subagent' | 'job', label, status, progress, detail, startedAt, finishedAt, updatedAt }`（`host/domain.js:146-165`）；`ref` 是子会话 id/runId 或 job id，重复观察更新同一条；`stale` 按 `stallAfterHours` 读时派生、不落盘（`host/service.js:802-805`）。
`EXEC_STATUSES = ['running', 'stopping', 'completed', 'killed', 'failed']`（协议常量，`host/model.js:46`）；`executions` 超过 `maxExecutions` 丢最旧并把 `executionsTruncated` 置真（`host/runs.js:230-243`）。

### 4.3 队列记录（`queues` 表，每会话一行）

```js
{ sessionId, sessionName, items: [{ id, at }], updatedAt }   // items ≤ maxQueueItems
```

队列是**每会话私有的执行计划 + 软预留**（5.3）；`reservedBy` 由它反查派生。会话销毁删行；任务收尾时从所有队列行里移除该 id（跨行，在同一写链里按固定顺序执行）。

### 4.4 派生字段（不落盘）

| 派生字段 | 计算 | 用途 |
|---|---|---|
| `blockedBy` / `gated` | `blocksOn` 里当前未完成（未 `done`、未 `archived`）的项 / 该集合非空 | 门禁、prompt、面板 |
| `effectivePriority` / `escalated` | 优先级继承（5.9） | 排序与展示 |
| `running` | `executions` 里 `running`/`stopping` 的条数 | 面板"执行中"、prompt |
| `claimable` | **唯一公式**（4.5） | `list{claimable}` 与 prompt 共用同一个函数 |
| `advanceable` | **正典公式**：`（锁在手上 ∨ 面板）∧ 跨需求门禁已清 ∧ 节点前置已满足 ∧ 状态 ∉ {done,archived} ∧ kind 允许` | prompt 区分"能接"与"能推进"；节点自身完成条件（`completion-not-met`）有意不入（`host/dispatch.js:208-245`） |
| `reservedBy` | 反查 `queues` | 预留；非空且非我 → `claimable` 为假 |
| `roleUnregistered` | `role !== ''` 且 `roles` 表无此 id | 面板角色徽标标警、`get`/`list` 回执；未登记的引用不接线到任何会话 |
| `unregistered`（角色列表） | （活会话解析到的 id ∪ 需求 `role` 引用到的 id）减去已有记录的 id | `requirement_role{list}` 与面板角色页；引用即证据，不需要活会话 |
| `children` | 反查 `parentId` | 父需求详情 |

### 4.5 `claimable` 的唯一公式

```text
claimable(req, me) =
     req.status !== 'done' && !req.archived
  && req.kind === 'task'
  && lockAllows(req.lock, me)                       // free | mine | orphaned | expired（5.2）
  && (req.reservedBy === null || req.reservedBy === me)
  && (req.role === '' || req.role === myRole || req.delegatedTo?.session === me)
```

`list{claimable}`、prompt 的"Claimable for you"段、面板"只看可接"筛选**全部调用这一个函数**。
面板（`me === ''`）不来角色子句：它问的是"可接手池"，不是"我能认领的"（`host/dispatch.js:86-116`）。

### 4.6 domain 版本、迁移与回滚

- `version: 2`，**不声明 `compatibleVersions`**：本部署选的介质（sqlite，以及 JSON 的 `single` 布局）按精确版本戳校验，旧戳不可读；v1 数据的通道是 `importLegacy`（旧 JSON 没有 unit 头）。**与 OPTIMIZATION.md 的 1→2 是同一次升级**。
- 从旧 `requirement-board.json` 导入是**显式开关** `importLegacy`（默认关）：`requirements`/`templates` 为空**且**开关打开**且** global 无 `imported` 标记时才导一次，导完写 `imported: { at, count }` 防重放；旧文件改名 `*.migrated` 保留；`nextRevision = max(global.revision, max(record.rev))` 自愈；`export` 动作可反向导出。**这条开关的存在就是为了让开发库永远不会误吸生产数据**。
- **SQLite 的物理布局版本由平台管**（`PRAGMA user_version`，平台不提供迁移）：DSH 升级前后要做一次导出/导入演练（P2 验收项）。
- 一次坏记录在 `open` 时即报 `invalid-record`（zod 逐条校验），不再等到后续读取才炸。

### 4.7 流转记录（history）词表

既有：`create`/`retemplate`/`advance`/`rollback`/`jump`/`complete`/`reopen`/`block`/`unblock`/`archive`/`restore`/`update`。
新增：`claim`/`release`/`delegate`/`revoke-delegation`。`queue`/`unqueue` 与 `checklist` **不写** history（`host/service.js`、`host/flow.js:253-265`）。
执行单元状态变化**不进** history（它有自己的字段 + `execRev`）。

## 5. 注册、上锁、队列与派发

### 5.1 生命周期（先注册再跑）

| 步 | 动作 | 结果 |
|---|---|---|
| 1 注册 | `create` | 任务进看板，`lock: null`（**不自动上锁**） |
| 2 上锁 | `claim` | `lock` = 调用方；history 记 `claim`；顺带对账该会话已在跑的单元 |
| 3 执行 | 回合 / 子智能体 / 后台任务 / workflow | 执行单元按归属实时落库（5.5） |
| 4 推进 | `checklist` / `transition` | 要求**持有该任务锁**（5.4） |
| 5 完成 | `complete` | 自动放锁 + 结算单元；回执**只提示队头**（不自动上锁） |
| 交接/放弃 | `release` | 显式放锁；回执提示队头 |

### 5.2 锁

- 互斥单元是**任务 ID**；判定在写链的同一次 `update` 里完成。
- `lockAllows(lock, me)`：`null` → 可；`lock.session === me` → 可（幂等）；`lock.orphaned` → 可（**立即**接管，不必等租约）；`now - (lock.touchedAt ?? lock.at) > staleClaimHours`（默认 8h）→ 可；否则 `conflict{code:'locked', current:{session,name,at,touchedAt,orphaned,expired}}`。
- **`lock` 只按 ID 判断，绝不比较标题/描述**：内容相同但 ID 不同的两条任务各自有锁、可并行；不做去重/合并/唯一性校验。
- **一个会话同时只持一把锁**：`conflict{code:'session-busy', current, queueHead}`；多任务靠队列（5.3）。
- **孤儿锁**：会话 `agent/disposed` 时锁标 `orphaned: true`（不静默放弃）、running 单元结算、队列行与临时角色清理 —— 状态可见且**可立即接管**。子会话短命，这条尤其重要。
- **续约**：持锁会话的**任何成功写**（`checklist`/`transition`/定义修改/执行同步落库）在同一次 `update` 里顺带刷新 `lock.touchedAt` —— 否则跑了 8h 以上的**合法长任务**会被租约静默易主，原会话下一步推进被拒、两个会话的执行单元混进同一任务。
- `complete`/`archive` 自动放锁时，**同一写链**里把该锁下未结算的单元记为 `killed`（cause `owner-released`）并发一次变更。
- `delete` 一并删除执行单元、并从所有队列与所有 `blocksOn` 里移除该 id。
- 原子性来自平台写链 + `rev` CAS；HTTP 入口不能带 `session` 认领（2.5）。

### 5.3 执行队列（一把锁怎么执行多任务）

| 动作 | 语义 |
|---|---|
| `queue{id}` | 追加到**我的**队列并**软预留**。要求：未归档未完成、`kind==='task'`、**角色/绑定资格成立**、`lockAllows` 成立、未被别人预留、不在队列里（幂等）、队列未满。**不取锁** |
| `unqueue{id}`（面板另接受 `targetSession`） | 从我的队列移除（幂等）。**面板可用 `targetSession` 清除任意会话的预留**（人覆盖 AI）；`targetSession` 是**操作目标**，与 actor 的 `session` 分开 |

- 释放路径：`unqueue`、我的 `agent/disposed`、任务完成/归档/删除、`revoke`（释放**目标会话**在该任务上的预留）、`delegate`（释放**调用方自己**在该任务上的预留）；**面板可随时抢下并清预留**（`host/service.js:1873-1985`、`1972-2013`）。
- 队头被别人**上锁** → `claim` 返回 `conflict`（`details.queued:true`）并提示 `unqueue` 换一条；**不自动改队列**。公开可达序列：租约过期 → 他人合法软预留 → 原持锁者再写一次使锁复活 → 预留者 `claim` 命中该分支（`host/dispatch.js:322-340`，`tests/queue.mjs` 用注入时间证实）。
- 上界 `maxQueueItems`（默认 20），超出 `invalid-input`。
- **已知取舍**：软预留**没有租约**（你的选择）—— 一个活着但卡住的会话会占住队内任务。处置：会话结束自动释放 + 面板可见 + 人可清；`stats.reserved` 计入观测。若实测被占死，加一个预留租约配置是小改动。

### 5.4 无锁不得推进 / 改定义（动作类）

| 动作类 | 要求锁 | 说明 |
|---|---|---|
| `checklist` / `transition`（含 `complete`） | **要** | 推进流程；`advance` 与 `complete` 另受跨需求门禁（5.8），`rollback` 不受 |
| `update{role, blocksOn, parentId, templateId}` / `block` / `unblock` / `archive` / `delete` | **要** | 改定义或状态；`templateId` 会重绑整张节点图，必须持锁 |
| `update{title, description, priority, owner, labels, sessions, note}` | 不要 | 非结构性修改 |
| `create` / `claim` / `release` / `queue` / `unqueue` / `delegate` | 不要 | 各有自己的前置（`delegate` 见 5.5） |
| 面板（`session` 为空 = 人） | **不受限** | 人工兜底；`kind:'decision'` 本就只有人能推进 |

**`claim` 的有序判定表**（同一次写链判定，机器码稳定）：

| 序 | 判定 | 失败 |
|---|---|---|
| 1 | 归档 / 已完成 | `invalid-state` |
| 2 | `kind === 'decision'` 且调用方是 AI | `forbidden` `decision-task` |
| 3 | 角色/绑定资格：`role === ''` ‖ `role === myRole` ‖ `delegatedTo.session === me` | `forbidden` `role-mismatch`（details 带 `role`/`delegatedTo`） |
| 4 | `lockAllows`（5.2） | `conflict` `locked`（details `current`） |
| 5 | 预留：`reservedBy ∈ {null, me}` | `conflict` `reserved`（details `reservedBy`） |
| 6 | 一会话一把锁 | `conflict` `session-busy`（details `current` + `queueHead`） |

`queue` 用**同一张表**（去掉第 6 条），所以"能 claim 不能 queue"的矛盾不再存在。

**可选硬门槛** `requireLockForExecution`（默认 **false**，已定）：打开后用 `tools/pre-execute` 拒绝"没有持锁会话"调用子智能体/后台任务的工具。**拒绝文案必须给出路**："该会话没有持有看板任务锁；先 `claim` 或 `queue` 一个任务，或请管理员关闭 `requireLockForExecution`。"（打开后会拦掉与看板无关的正常使用）**放行分支必须调 `next()`**（不调即短路整条链 —— 仓库 waterfall 规则），并配"放行不改变结果"的用例。**诚实的定位**：本方案的强制力范围是**插件自己的操作面**；平台工具面默认不设卡，所以"执行前先注册"在默认部署下是**规范约束 + 操作面强制**，不是全进程机械强制（写进 §11）。

### 5.5 派发给子会话（为该任务铸造临时角色）

**六步**

| 步 | 谁 | 做什么 |
|---|---|---|
| 1 | 父会话 | 用平台子智能体工具以 **continuable 后台模式**起子会话；**子会话 id 从工具回执的 `subagentId` 取**（`tool-subagent/src/index.ts:536`；foreground 会阻塞到结束、one-shot 后台只回 `jobId`）；插件侧再用 `subagent/start` 的 `id` 交叉校验（`packages/subagent/subagent/src/lifecycle.ts:140-144`） |
| 2 | 父会话 | `delegate{ id, session:<子会话id>, duties:[…], roleName? }` |
| 3 | 插件 | 为**这条任务**铸造/替换临时角色 `tmp-<任务id>`（`ephemeral`，带 `boundSession`/`boundTask`）；任务 `role` = 它、`delegatedTo` 记录（`roleBefore` = **派发前的当前值**）；返回 `{ roleId, id }`；history 记 `delegate` |
| 4 | 父会话 | **delegate 之后**用 `send_message` 发模板：任务 ID / 先 claim 再跑 / 验收与范围；**不复述角色 ID**（权威来源是看板注入段，7.2①）—— 初始 prompt 只写待命提示 |
| 5 | 子会话 | 也能从看板注入段看到 `Delegated to you`（服务端注入，6）；`claim{id}` → 判定表第 3 条命中 `delegatedTo.session === 我` → 通过 → 上锁 |
| 6 | 子会话 | 执行 → 推进 → `complete`（自动放锁；临时角色与绑定清理；`role` 回退） |

**前置（fail loud）**：调用方必须是**自己就能接**这条任务（`role` 为空/等于我的角色）**且**是创建者、`owner` 或 `sessions` 成员（或面板）；`session` 不得是调用方自己（要自己做请直接 `claim`）；任务未归档未完成，且锁持有者不是**目标会话以外**的会话 —— **锁持有者恰为目标会话时幂等收编**（补写绑定、不报 conflict：子会话继承父角色，所以在我 delegate 之前它就有资格 `claim`，这是正常路径而非异常）；同一任务重复 `delegate` 先收尾旧委托；**第三方会话的预留** → `conflict{reserved}`，目标会话自己的预留是收编路径，调用方自己的预留被本次调用释放；被指名会话可链式再派发给它的子会话（资格按结算后的 `roleBefore` 取，`host/service.js:1873-1985`）。

**`roleBefore` 取值写死**：取**派发时的当前 `role`**（不是创建时值）—— `revoke`/完成时要把任务退回"上一个可用状态"，而创建时值可能已被合法的 `update{role}` 覆盖。因为"重复 delegate 先收尾旧委托"，收编时读到的值**永远不可能是 `tmp-*`**，所以二次派发（revoke → delegate 新子会话）能正确回退。

**派发期间路由归委托所有**：`delegatedTo !== null` 时 `update{role}` 改成一个**不同**的 id 被拒（`conflict{delegated-role}`）—— 结算一定会把它抹回 `roleBefore`，接受一个必然被擦掉的写就是把降级留给用户去看。把当前值**原样写回**是零变化（面板保存别的字段时总是带上 `role`，所以这条必须放行）。非派发状态下改 `role` 照常落地，并写一条 `update` history（`role "a" -> "b"`）。

**写被拒要收回刚铸造的临时角色**：`role` 先铸造、需求后命名（步 3），所以需求写链里的任何拒绝（CAS 版本不符、并发委托、锁变动）都会留一行需求不再引用的临时角色。`delegate` 在 `catch` 里重读需求，**只有 `role !== tmp-<任务id>`**（证明写没落地）才删该行；删失败只写 warn，随后原样抛出原错误。启动 sweep 是兜底，不是第一道防线。

**初始 prompt 待命模板**（派发前唯一发给子会话的内容）："你即将接到一个看板任务。先不要自己认领任何任务；等我把角色 ID 与任务 ID 发给你，那时按 `claim` 的说明拿锁再开始。" —— 与 §6"存在待接指派时 `Claimable` 段降权"配合，避免子会话用**唯一那把锁**去接别的公共任务。
**撤销** `delegate{revoke:true}`：解绑、删临时角色、清 `delegatedTo`、`role` 回退、**结算该任务的 `executions` 与锁**（放锁或标孤儿）—— 与会话 dispose 同一套收尾。

**归属校验失败不写任何记录**：`owns(target, caller)` 判为 `false` 时 `delegate` 在锁与角色表之前抛出 `forbidden{not-owned}`，需求记录、临时角色、绑定与 history 都不动（`tests/delegate.mjs` 的 `caseOwnership`）。
**判定顺序（三道）**：① **先问平台谓词**——能答的注册表（含可持久判定的实现）说 `true` 就是 `true`，与目标是否还活着无关；② 谓词说 `false` 时读**目标自己会话头里的 `header.parentSession`**（平台记录的创建关系）：等于调用方 → `true`，等于别的会话 → `false`；③ 两者都没有依据时——目标没有活 Agent（continuable 子会话按需物化）、注册表不可用、或调用方无活 Agent → `undefined` → 放行 + 具名 warn 一次。有活 Agent 且谓词 `false`、会话头也指别人或缺失 → 决定性的 `false`（`index.js:111-132`）。
**同一套收尾**：`#settleDelegation` 是唯一实现，被 7 处调用 —— 重复 `delegate`、`revoke`、`agent/disposed`（锁标孤儿）、`complete`、`archive`、`delete` 各一次，加上启动 sweep 一次（`host/service.js:2037-3445`）；六件事（`role` 回退、清 `delegatedTo`、删临时角色、放锁或标孤儿、结算执行单元、释放预留）都在它内部。

**执行同步的归属与通道**

| 观察对象 | 订阅 | 字段 |
|---|---|---|
| 子智能体 | **`subagent/start` / `subagent/end`**（`packages/subagent/subagent/src/lifecycle.ts:134-163`，payload `{ runId, provider, id: 子会话id, local }`，`end` 带 `stopReason`/`lastAssistantMessage`） | 起止成对；`id` 就是归属子会话 |
| 归属校验 | 端口是 id 形状的 `owns(target, caller)`，平台知识只留在 `index.js` 边界：平台谓词 `isOwnedBy(id, owner: Agent)` 按**对象身份**比较（传字符串恒 false），适配器用 `agents.get(caller)` 换回 Agent；**谓词先答**（`true` 即采纳），`false` 时按目标会话头的 `header.parentSession` 判定，二者都无依据（注册表不可用、调用方或目标无活 Agent）→ `undefined` → 放行 + 具名 warn 一次（`index.js:111-132`、`host/service.js` 的 `#assertOwnedTarget`） | 确认这确实是该持锁会话的子会话；`false` 拒绝，`undefined` 降级放行 |
| 后台任务 | `ctx.jobs.events.subscribe({ owners: 'all' }, …)`，`registered`/`progress`/`stopping`/`settled`/`removed` | `JobView`：`owner`（会话）、`kind`、`label`、`status`、`startedAt`/`finishedAt` |
| kind 过滤 | **不做白名单**：除已知 `subagent`/`workflow` 外的所有 kind 都算后台任务（本机是 `pwsh`，不是 `bash`） | `JobKindMap` 合并出 `bash`/`subagent`/`pwsh`/`pty-send`/`workflow` |
| 会话活动 | `agent/status`（`idle ⇄ running`）、`agent/disposed` | **只作"该会话有活动"展示**；任务归因只用上两行（defensive-patterns："async state is not synchronous state"，一个 `running` 区间可能包含多个回合与注入工作） |
| workflow 子跑 | `workflow/agent-start` / `agent-end` + workflow 自身 job | `childId` 即子会话 |

**归属规则**：执行单元只挂到 `owner` 会话**当前持有锁**的任务；无持锁会话的事件不落库，计入 `global.execSync.ignored`（并在 `stats` 里可见）—— 这是**常态**不是异常：默认不拦平台工具，非看板执行本来就不该落库，**不是丢数据**。
**写纪律**：只在状态或进度文本变化时写；`output` 事件不落库（那是输出字节坐标，会高频抖动）；`executions` ≤ `maxExecutions`（默认 20），超出丢最旧并把 `executionsTruncated` 置真；写 `executions` **只推进 `execRev`、不推进 `rev`**（4.1）。
**降级要分类**："无锁会话的事件" → `execSync.ignored`（常态）；"`executionSync:true` 但 `ctx.jobs`/`agents` 缺失"或对账失败是**组合不一致** → `execSync.gaps` + 启动时 warn 一次，并把 `sync.gap` 渲染进 `get`/prompt/面板，不静默。
**对账**（不在读路径）：在 `claim` 成功时、插件启动时、显式动作时用 `ctx.jobs.list(holderSessionId)` 补齐该会话已在跑的 job（`caller` 只是弱标识，见 2.5）；发现差异才写并更新 `sync.syncedAt`。

### 5.6 工具面

| 工具 | 动作 | 说明 |
|---|---|---|
| `requirement_board`（18 个动作） | `list`/`get`/`create`/`update`/`claim`/`release`/`queue`/`unqueue`/`delegate`/`transition`/`checklist`/`block`/`unblock`/`archive`/`restore`/`delete`/`stats`/`changes`；**没有 `assign`** | `get` 返回 `lock`/`delegatedTo`/`executions`/`executionsTruncated`/`execRev`/`running`/`sync`/`claimable`/`advanceable` 与该会话自己的 `queue`（`host/tools.js:210-215`） |
| `requirement_role`（模型面 1 个动作） | `list`（含 `dutiesMissing`/`unregistered`/`ephemeral`/`boundSession`/`boundTask`/`holders`/`open`） | `put`/`delete` **只走面板 HTTP**（角色管理是人/预设的事） |

参数：`create`/`update` 接受 `role`/`parentId`/`blocksOn`（`kind` 只在 `create` 时有意义；`update` 带 `kind` 一律 `invalid-argument{kind-immutable}`）；`list` 接受 `session`/`owner`/`status`/`priority`/`kind`/`role`/`templateId`/`query`/`claimable`/`limit`（**没有** `running`/`queue`/`sort`/`offset`）；`stats` 增加 `byKind`/`byRole`/`decisions`/`criticalPath`/`queues`/`queued`/`reserved`/`orphanedLocks`/`pendingDelegations`/`running`/`execSync`（`ignored`/`gaps`，`host/service.js:3522-3590`）。
**首轮 token 预算**：18 + 1 个动作都进首轮请求；**首轮工具 JSON schema 字符数的固定断言**是阶段 G 的未竟项（见 §9 与清单 §5）——插件当前不进受控源码，README 记明该例外与理由，超支就继续砍动作/合并参数（`agent-experience` 要求）。

### 5.7 决策类需求只能由人推进

`kind === 'decision'` 且调用方是 AI 时：`claim`/`transition`/`archive`/`delete`/`delegate`/`queue` 六个动作一律 `forbidden`（`details.reason:'decision-task'`）；`update` 只允许 `{title, description, priority, labels, sessions}`。面板路径不受限。
**两入口实测分解（12 条拒绝）**：工具入口 6 条（六个动作）+ 1 条（`delegate{revoke:true}`）；command 入口 `claim`/`queue` 各 1 条 `invalid-argument`（**面板 command 没有这两个动作**），`transition`/`archive`/`delete` 各 1 条 `decision-task`。服务层对同三个动作的拒绝证明"规则在操作里"，不是靠入口缺失（`tests/decision.mjs:201-254`）。
**`kind` 创建后不可变**：`update{kind}` 在 AI 与面板两条路径都返回 `invalid-argument{kind-immutable}`，记录与 `rev` 不动；否则 `update{kind:'task'}` 能让 AI 把决策改成普通任务再认领（`host/service.js:2560-2566`）。
**已知边界**：`block`/`unblock`/`checklist` **有意不**加进上面六个动作的清单（`kind` 不可变 + `update` 白名单已关后门，`block` 不通向执行），但它们仍先按同一条人类专属规则拒绝 AI —— 决策的锁永远拿不到，先报 `lock-required` 会把模型引向一把没人能拿的锁；在普通任务上它们照常要求持锁（`host/service.js:2186-2214`、`2498-2585`）。

### 5.8 门禁（可选）

- `blocksOn` 默认空；可创建时设，也可之后 `update`（**要锁 + 记 history**）。
- `blockedBy` 非空时 `advance` **与 `complete`** 都被拒 → `invalid-transition{blockedBy:[…]}`；`force:true` 可越并记 history（`complete` 也走门禁，否则抬高没有强制力）。
- `jump` 本来就要 `force`；`rollback` 不受门禁（后退不是推进）。
- 写 `blocksOn`/`parentId` 校验：目标存在、不得自指、**两张图各自不得成环**（`parentId` 与 `blocksOn` 分开检出，`parentId` 环会让 `children` 派生不终止）。
- **`delete` 同一写链里从所有 `blocksOn` 与所有队列移除该 id**（永久悬挂；平台无跨行事务，跨行中间崩溃由启动 sweep 兜，4.1）；归档的挡路需求不算完成 —— 仍在，需 `force` 或重开，写进工具描述与 skill。
- 与模板节点 `dependsOn` 的关系：先判模板依赖（`dependency-not-met`），再判跨需求门禁（`invalid-transition`），错误码顺序写进工具描述。


### 5.9 等级抬高：优先级继承

```text
effectivePriority(req) = max( own priority(req),
                              max{ effectivePriority(d) | req ∈ blockedBy(d) } )   // 封顶 urgent
```

- 抬高对象是**拦路那条**；被挡那条只标 `gated`。
- **不落盘、不改 `priority`**；前置清掉自动回落；`escalated` 派生。
- prompt/列表写 `[high↑]`；面板标"关键路径"；`stats.criticalPath` 是**计数**（被抬高的条数），每行的 `escalated` 才是那一条的标记（`host/service.js:3543-3575`）。
- 传播沿 `blocksOn` 单遍（图保证无环），每次读时重算。

### 5.10 不通知、不唤醒

创建与派发不写 Agent `inbox`、不发定向事件给会话、不调 `agents.create`/`resume`、不 schedule。子会话知道自己的角色与任务，靠派发方消息 + 看板注入它自己的 prompt（读路径）。唯一推送是看板变更给**开着的面板**。

### 5.11 主动推动，不自动认领

机制上无自动认领路径；prompt 用推动措辞 + `list{claimable:true}`；`claim` 的行为与租约写在**该动作自己的说明**里；规范（何时接、怎么派、怎么排队）写在 skill。

### 5.12 配置项

| 字段 | 默认 | 范围 | 用途 |
|---|---|---|---|
| `defaultTemplateId` | `'tpl-standard'` | 非空字符串 | 未指定模板时绑定哪个 |
| `stallAfterHours` | `72` | 0.1–8760 | 活跃节点多久没动算"停滞" |
| `promptContext` | `true` | — | 把看板注入模型上下文 |
| `promptMaxItems` | `12` | 1–100 | 各段共享的总条数预算（不是每段 12 条） |
| `http` | `true` | — | 注册浏览器路由 |
| `staleClaimHours` | `8` | 0.1–720 | 锁的租约 |
| `executionSync` | `true` | — | 订阅执行状态并落库 |
| `requireLockForExecution` | `false` | — | 可选硬门槛（5.4） |
| `maxExecutions` | `20` | 5–100（整数） | 每任务执行单元条数上限 |
| `maxQueueItems` | `20` | 5–100（整数） | 每会话队列长度上限 |
| `sseCoalesceMs` | `300` | 0–5000 | SSE 变更合并窗口（4.1 的读放大防护） |
| `importLegacy` | `false` | — | 是否允许一次性导入旧 JSON（4.6；只在阶段 R 开一次） |

`host/config.js` 是唯一校验点：类型/越界/空值一律 `invalid-config`，不静默取默认值。`cordis.patch.yml` 目前显式写其中 8 项（`defaultTemplateId`/`stallAfterHours`/`staleClaimHours`/`promptContext`/`promptMaxItems`/`maxQueueItems`/`http`/`importLegacy`），其余 4 项使用上面的默认值。
`dataDir`/`documentPath` 已不存在：出现即 `invalid-config`——存储后端与它的路径是 `storage-domain` 路由的部署选择。开发期隔离由存储后端的**独立路径**承担（§13.1）。
协议常量（不做配置）：`human` 角色名、`requirementBoardRole` 服务名、`tmp-` 前缀、`EXEC_STATUSES`、`EXECUTION_TOOLS`。

## 6. 模型可见面

prompt 按会话组装，段序固定（角色行 → `Delegated to you` → `Claimable for you` → `Your queue` → `Executing now` → `This session's requirements` → `Other sessions' requirements` → `Waiting on the human`），共享 `promptMaxItems` 总预算；决策段先占预算、最后输出（`host/service.js:3636-3813`）：

```text
<requirement-board>
Shared requirement board: 9 active requirement(s). Read and update it with the requirement_board tool; changes made in any session are visible here immediately.
You are role "art" (美术) — 角色立绘, 场景概念图, UI 图标.
Delegated to you (1) — claim it before you start:
- req_ab12 [high] 场景概念图切图 · node 1/5 方案设计 · active · delegated by 小画师 (ses_91c2) · your role for this task: tmp-req_ab12
Claimable for you (2) — claim one proactively:
- req_ef56 [urgent↑] 场景概念图 · node 3/5 开发实现 · active
- req_ij90 [normal] UI 图标导出 · node 1/5 需求评审 · active
Your queue (2 queued, next: req_b2c3):
- req_b2c3 [high] 战斗特效切图 · node 1/5 需求评审 · active
- req_kl34 [low] 参考图整理 · node 1/5 需求评审 · active
Executing now (1 held by you):
- req_gh78 [high] 场景概念图 · node 3/5 开发实现 · active · subagent running (2m) · job running (5m)
This session's requirements (2):
- req_mn12 [normal] 参考图归档 · node 1/3 归档 · active
- req_pq56 [low] 图标导出 · node 2/3 打包 · blocked · blocked: 等设计稿
Other sessions' requirements (3):
- req_rs78 [low] 图集打包 · node 2/4 打包 · active
Waiting on the human (1) — only the human advances these:
- req_cd34 [normal] 需要你决定美术风格 · requested by 小画师
</requirement-board>
```

- 角色段：`name`/`duties` 的单一权威是 roles 表的记录；记录不存在（被删或从未建档）时退到预设声明、再退到预设 id。角色 **id 永远来自解析链**，面板改名不改 id。`dutiesMissing` = 记录与预设声明**都没有** duties；记录为空但声明有职能时读声明（`host/roles.js` 的 `#present`/`promptLine`）。被指派的任务段单独标该任务的临时角色 id。
- **门禁呈现**：`get`/`list` 暴露 `gated`/`blockedBy`，面板按宿主事实显示；prompt 的条目行**不**带 `gated by` 标记（`host/service.js:3692-3740`，未决项见 §11）。
- 被别的会话预留的任务**不出现**在我的"可接"段。
- 我自己已持锁的任务**不出现在** "Claimable for you"（只出现在 "Executing now"）—— 同一任务只属于一段。
- 存在 `Delegated to you` 时，"Claimable" 段**降权**：措辞是"先接上面的指派，再考虑公共任务"，避免子会话用**唯一那把锁**去接别的活。
- 决策段对所有会话出现；决策需求不进"可接"段，也不进 "This session's"/"Other sessions'" 两段。
- 措辞是推动，不是自动；无"已被通知"暗示。
- **可回放性**：段文本来自 `systemPrompt.context`，可从会话日志重建；recorded-session snapshot pin 未落地（插件不进受控源码/profile），按 §10 在 README 记为**明确例外**。

## 7. 任务创建与派发规范（单独一个 skill）

### 7.1 交付形态

- 位置（两段，见 §13）：**开发期** = `<repo>/.agents/skills/requirement-board-tasks/SKILL.md`（`skill-filesystem` rank 200 `project-agents`，只在本仓库项目内可见）；**启动期**提升到 `~/.dsh/skills/requirement-board-tasks/`（rank 400 `user-dsh`，跨项目可用，与 `dsh-tui`/`qwen-image-21` 同级）。
- 格式：目录包 `<name>/SKILL.md`，frontmatter 必填 `name`/`description`；显式写 `user-invocable: false`（这是模型执行规范，不是给人手动调的命令）；只用 kebab-case 键。
- 资源：`references/roles.md`（标注为**生成快照 + 生成时间**，不是第二份真相）、`references/dispatch.md`（派发模板与协作示例）。
- 插件侧零改动：不注册 skill、不加 `skills/` 到 `files`、不注入 `skills` 服务、工具描述不引用 skill 名。方向是 **skill → 工具契约**。
- skill 正文**不逐字写工具调用语法**（那会让工具改名后 skill 静默过期，违反"同一事实只说一次"）；只写"用哪个动作、什么时候用、验收标准"，语法由工具自己的说明承载。

### 7.2 规范内容（skill 正文骨架）

1. **先查重**：`list{claimable:true}` 或 `list{query}`；已有同题就不新建（查重是人的判断，插件只按 ID 认任务）。
2. **先查角色职能**：`requirement_role{action:'list'}`，按职能决定 `role`；跨职能/谁都能做**留空**。
3. **一条任务一个交付物**：标题 `<动词> <宾语>（<交付物>）`，≤200 字，关键字前置。
4. **必填三件事**：`title`、`priority`、`description` 写清 **做什么 / 验收标准 / 交付到哪**。
5. **先注册再跑**：动手前先 `claim` 上锁；**没有锁不要开始干活**（无锁的推进与定义修改都会被拒）。
6. **多任务先排队**：手上有活时把后续任务 `queue` 起来（排队即软预留），完成手上的再接队头；不要试图同时开两条。
7. **派给子会话（模板四件事，不复述工具语法）**：① 你这条任务的角色 ID 由看板注入段（`Delegated to you`）给出 —— **注入段是权威来源**，派发方消息只作触发与确认、不重复铸造值；② 任务 `<reqId>`（`<标题>`）已注册给你；③ 开始前先按 `claim` 动作的说明拿锁，做完按 `complete` 的说明收尾；④ 验收标准与范围（不要碰什么、交付到哪）。**顺序是：起子会话（continuable）→ `delegate` → 用 `send_message` 发这份模板**（初始 prompt 只发待命提示，因为 `roleId` 在 `delegate` 之后才存在）；跨角色的活**不要**派给子会话（它继承你的角色、接不了），而是注册任务给目标角色。
8. **执行状态自动同步**：子智能体、后台任务、workflow 的状态自动挂到当前锁对应的任务，**不需要手工回报**，也不要为了"同步状态"重复建任务。
9. **门禁是可选项**：只有"必须先清掉某件事才能推进"时才设 `blocksOn`；拦路那条会被自动抬高，别手工再加 `urgent`。
10. **跨角色协作**：父需求 + 各自角色的子需求（`parentId`）+ `blocksOn` 表达"等谁"；跨角色建议也走创建需求这条路。
11. **要人拍板**：`kind:'decision'`，描述写 **选项 / 各自代价 / 默认建议**，`blocksOn` 指向等待中的任务。**建完就不能改成普通任务**。
12. **不建的任务**：一句话能答的、没有验收标准的、角色不明的、重复的。
13. **认领礼仪**：接之前 `get`；开工就 `claim`；做完写 `note` 再 `advance`；被门禁挡住**不 `force`**，除非写明理由。
14. **推进顺序**：勾 `checklist` → `transition{action:'advance'}` → 最后 `transition{action:'complete'}`。
15. **流程模板匹配（不符合就建模板）**：建需求前先 `flow_template{action:'list'}`，按这条活真实的生命周期挑 `templateId`；现有模板都对不上就先 `flow_template{action:'create'}` 把节点写成真实步骤（稳定 id、`dependsOn` 成链、该判完成的写成 checklist）再建需求。`templateId` 省略会**静默**绑默认模板，不能拿默认模板当占位；模板看板共享，要改进现有流程就 `flow_template{action:'revise'}` **追加一个版本**（存量需求一律不动，改错了不能就地改），需要换版的需求再用 `flow_template{action:'migrate'}` 迁到新版本（先看受影响清单；不指名 `requirementIds` 即"全部钉在旧版的"，需要 `force`）；此外 `archive`（`archive:false` 恢复）、`clone`（改内置流程的正路）、`delete`（按 `force` 把受影响需求改绑到默认模板并写一条历史）也在工具面，只有 `prune`（裁剪历史版本）留给面板。绑错的代价在推进时才暴露（`dependency-not-met`、检查项与交付物错位），事后改绑走 `update` 的 `templateId`（要锁）并重算节点状态。

### 7.3 与插件的关系

| 方向 | 内容 |
|---|---|
| skill → 工具 | 只用公开契约的**动作名与意图**，不复述参数与语法 |
| 插件 → skill | **没有引用**；不检测、不加载、不假设它存在 |
| 共同事实 | 动作/参数只在插件；规范（何时/怎么建、怎么派、怎么排队）只在 skill |
| 验收 | 开发期以 `project-agents` 出现在 `<repo>/.agents/skills/`，启动期提升为 `user-dsh`；能加载、覆盖十五条、**未出现工具参数表** |

## 8. 面板

| 位置 | 新增 |
|---|---|
| 顶部 | **"待你决策"队列**：标题、优先级、谁在等、挡住什么、创建时间；点开直接推进 |
| 角色管理 | 角色列表（**含 `put`/`delete` 编辑入口**）：id、显示名、职能、来源（`preset`/`manual`/`observed`/`delegated`）、在线/空闲、未完成数；临时角色行显示 `ephemeral` + `boundSession`/`boundTask`；缺职能/未登记高亮。**预设对照区**：列出组合里声明的每个预设（`agentPresets.list()`），逐行给出它解析到的角色 id、是否已建档、有无活会话、启用诊断，未建档的预设带**一键登记**（预填 id 与显示名，仍走 `role.put`）；打开对话框时读一次名册，`put`/`delete` 成功后再读一次，所以刚登记的那一行立刻翻面，不会继续显示"登记角色" |
| 列表卡片 | 🔒 锁持有者与时长（孤儿锁标红）、"执行中 N"、"已派给会话 X（未接）"、"已被会话 X 排队预留"、角色徽标、`↑` 抬高、"关键路径"/"被 N 条挡住" |
| 详情 | **执行单元表**（kind/label/status/时长/`progress`/`stale`/`executionsTruncated`）；锁、`delegatedTo`（含 `roleBefore`）、`blocksOn` 及状态、`effectivePriority`；**队列**（谁的、第几位）；按钮：释放 / 派发 / 撤销派发 / **清预留（`targetSession`）** / 推进（决策）—— **不设"认领"按钮**：面板 actor 的 `session` 是空串，写进 `lock.session` 会让 AI 侧 `lockAllows` 全部拒绝直到 8h 租约过期；而人本就不受锁约束，不需要占锁，要让某个会话做就"派发" |
| 筛选区 | 角色（含"任意角色"）、`kind`、"只看可接"、"执行中"、"已派发"、"我的角色" |
| 反馈 | 每个新失败码（`locked`/`reserved`/`session-busy`/`role-mismatch`/`decision-task`/队列满）都有 en/zh 文案，用 app 级 Toast 呈现，失败时保留原数据 |
| 状态 | 四个新表（决策队列/角色/执行单元/队列）各给空态与骨架；**SSE 断线时就地提示"同步中断，数据可能过期"**，重连后全量刷新 |
| locale | 文案全部走 en/zh 字典；新增元素只用既有 `--dsw-alias-*` token，字重 ≤500 |

### 8.1 面板数据接口

| 端点 | 参数 | 说明 |
|---|---|---|
| `GET /api/requirement-board/snapshot` | `status`/`owner`/`session`/`priority`/`kind`/`role`/`templateId`/`query`/`claimable`/`limit`/`offset`/`me` | 初始数据与刷新；`me` 是**会话 id**（不是角色名），只决定 `claimable`/`advanceable` 为谁作答；`me=''` 是面板本身 |
| `GET /api/requirement-board/events` | — | SSE：`ready` + `changed`（按 `sseCoalesceMs` 合并，15s 心跳） |
| `GET /api/requirement-board/health` | — | 存活探测 |
| `POST /api/requirement-board/command` | `{ action, session, name, me, id, ... }` | `refresh`/`list`/`create`/`update`/`transition`/`checklist`/`release`/`unqueue`/`delegate`（含 `revoke`）/`block`/`unblock`/`archive`/`restore`/`delete`/`stats`/`changes`/`template.*`/`role.*` |

快照信封 `{ ok: true, data: { revision, generatedAt, requirements, total, templates, roles, stats, queues } }`；`queues` 每行 `{ session, sessionName, items, head, length, updatedAt }`，顺序由服务端给（`host/service.js:3657-3664`，`host/http.js:382-396`）。
`?role=human` 是人的收件箱、`?claimable=true` 只回答"这个 `me` 现在能不能接"、`?session=` 是归属筛选，三者互相独立。每条需求带 `lock`/`delegatedTo`/`executions`/`executionsTruncated`/`execRev`/`running`/`sync`/`claimable`/`advanceable`/`blocksOn`/`blockedBy`/`gated`/`effectivePriority`/`escalated`/`parentId`/`children`/`reservedBy`/`roleUnregistered`。
失败信封 `{ ok: false, error: { code, message, details } }`：`BoardError` 一律 **409**，其余 **500**；信任判定（平台 `connection.requestRejection(request)`，缺席时回退回环 `Origin` 校验）在进入命令分发之前直接回 `401 unauthenticated` / `403 forbidden-origin`，方法不对回 `405 method-not-allowed`；请求体超过 256 KiB 仍是 `invalid-argument`（409，`host/http.js:79`）（`host/http.js:355-434`）。
**面板 command 没有** `claim`/`queue`：面板 actor 的 `session` 为空串，占锁会让 AI 侧全部 `lockAllows` 为假直到租约过期；`session` 非空的任务不得认领（`host/http.js:225-337`）。

`role.list` 多回一段 `presets`：`{ items, unavailable }`。`items` 每个声明过的预设一行 `{ id, name, broken, roleId, roleName, recorded, dutiesMissing, confirmed, online, open }`——`roleId` 优先取**活会话**解析到的 id，没有活会话时按"预设 id 本身是合法角色 id"推定（`confirmed` 标出这两种来源），预设 id 连角色 id 都不是时为 `''`；`recorded` 是 `roles` 表里有没有这条记录，`dutiesMissing` 与角色列表同源。`unavailable` 为 `null` 表示名册读到了，否则 `{ code: 'service-absent' | 'read-failed', detail? }`：前者是组合里没挂 `agentPresets`，后者是 `list()` 抛错或没回数组——**空名册与读不到名册是两件事**，面板分别给不同文案。这段**不进 `snapshot`**：`snapshot()` 是同步读、且每次刷新/健康检查/SSE `ready` 都会走，而 `agentPresets.list()` 要逐个预设做启用诊断，只能异步；面板打开角色管理时按需读一次。`items`/`unregistered` 与 `snapshot().roles` 同源同字段。

### 8.2 失败码与 `details`

`code` 是机器可读的一层，`details.reason` 是稳定子码。HTTP 下 `BoardError` 一律 **409**（其余 500）；工具下抛给模型。

| `code` | `details` | 触发 |
|---|---|---|
| `invalid-argument` | `reason`: `session-required`/`self-reference`/`cycle`/`missing-target`/`kind-immutable`；枚举与白名单情形不带 `reason`，而带 `received`（非法枚举值）或 `supported`（`update` 的允许字段） | 参数本身不可接受：未知动作、形状或上界不合法、非法 `kind`、自指/成环/目标不存在 |
| `invalid-input` | `reason`: `queue-full`（+`max`）/`delegate-to-self` | 形状没问题但组合或状态不允许 |
| `invalid-state` | `reason`: `write-chain-order`（+`held`/`key`）/`invalid-state`（+`id`/`status`） | 写链顺序被违反；`done`/`archived` 的记录不能再操作 |
| `invalid-transition` | `reason: blocked-by`（+`id`/`action`/`blockedBy`） | 状态或节点不允许该流转；`advance`/`complete` 的跨需求门禁未清（`rollback` 不走门禁，`jump` 另需 `force`） |
| `dependency-not-met` | `node`（+`missing`） | 模板节点的前置节点未完成（先于跨需求门禁判定） |
| `completion-not-met` | `node`/`reason`/`missing` | 当前节点的完成条件未满足 |
| `conflict` | `reason`: `locked`（+`id`/`current`/`queued`）/`reserved`（+`reservedBy`）/`session-busy`（+`id`/`current`/`queueHead`）/`delegated`（+`delegatedTo`）/`delegated-role`（+`role`/`delegatedTo`）；CAS 版本不符不带 `reason`，带 `expected`/`current` | 锁、软预留、一会话一把锁、已有委托、在派发期间改路由（5.5）、CAS 版本不符 |
| `forbidden` | `reason`: `decision-task`/`invalid-kind`（+`kind`）/`role-mismatch`（+`role`/`myRole`）/`not-owned`（+`target`/`owner`）/`not-related`（+`id`）/`lock-required`/`not-lock-holder`（+`current`）/`panel-only`（+`targetSession`） | 决策的人类专属、非任务 kind、角色不符、归属不符、无锁 |
| `invalid-role` | `roleId`，或 `role`（格式校验的两条路径） | 角色声明非法（格式、`tmp-` 前缀、`human` 保留字） |
| `not-found` | `id`（+`known`） | 需求/模板/角色不存在；`GET /image/<id>` 下也指没有这张已存图片 |
| `invalid-image` | `id`（+`path`） | `images` 里出现未落库的图片 id（不静默丢弃）；已存图片的元数据不可读、或引用在而字节文件不在 |
| `unsupported-media-type` | `received` | 上传的 `content-type` 不是 PNG/JPEG/WebP/GIF，或图片一个字节都没有 |
| `image-too-large` | `max` | 单张图片超过 20 MiB（上传时边读边判，不会先整个收下） |
| `in-use` | `id`（+`requirements`） | 模板仍被引用且未 `force` |
| `invalid-config` | — | 装载期配置非法（含出现 `dataDir`/`documentPath`） |
| `invalid-record` | — | 打开时逐条校验失败（平台在读边界抛出） |
| `malformed-legacy` | — | 旧 JSON 记录不符合 schema |
| `unsupported-legacy-version` | `found`（+`supported`） | 旧 JSON 的 `schemaVersion` 不是可导入的版本（只有 1 可导入） |

不经 `BoardError` 的传输层码：`401 unauthenticated`（缺/过期会话凭据）、`403 forbidden-origin`（跨源）、`405 method-not-allowed`（方法不对），详见 8.1。
图片路由是 409 规则的例外：`not-found` 404、`invalid-image` 400、`unsupported-media-type` 415、`image-too-large` 413。

幂等与非错误字段：`changed:false`（`revoke`/`unqueue`/无变化 `update`）、`settledDelegations`（`dispose` 结算了几条委托）、`unbound`（`delete` 清掉的引用）、`deleted:true`、`queued:true`（锁冲突时它是我的队头）、`execSync.{ignored,gaps}`。
面板 command 收到不存在的动作（`claim`/`queue`）报 `invalid-argument`，消息含 `unknown action`。

## 9. 分期与验收

阶段 0–G **全部在开发期环境里做**（§13.1：不写 profile、不写全局记忆）；只有 **R** 才动全局。

| 阶段 | 内容 | 完成定义（可验证） |
|---|---|---|
| **0 存储迁移**（前置，依赖 OPTIMIZATION.md P1/P2） | **S1** 在运行中的 dsh 进程里确认 bundle 位置 `import 'zod'` 可解析（纯 Node 实测 `ERR_MODULE_NOT_FOUND`）；**S2** profile 补丁层新增 `storage-sqlite` 行 + `storage-domain.routes.requirement_board: sqlite` 是否被 Loader 接受；**P1** 引入 domain 表单（4 张表 + global）、CAS 挪进写链、删 `host/store.js`、一次性导入旧 JSON；**P2** 切 SQLite 路由 | 现有 smoke 66 / client-smoke 225 / loader 53 全绿；新增用例：坏记录 open 报 `invalid-record`、`expectedRev` 不符在链上被拒、导入幂等、`nextRevision` 自愈、`dataDir` 移除后旧配置明确失败、`importLegacy` 关闭时**不导入**（开发库不会被生产数据污染）、打开且无 `imported` 标记时只导一次；库文件生成于覆盖层指定的路径（开发期 `.artifacts/requirement-board/dev-board.db`）；`routes` 切回 `json` 行为一致；DSH 升级布局变更的导出/导入演练一次 |
| **A1 角色与解析链** | 预设声明解析、`roles` 表、四种建档来源、`agent/created` 建档（失败不连累创建）、`requirement_role{list}`、`human` 保留字校验、prompt 角色段、面板角色与筛选、**启动 sweep** | smoke：解析链三态 / 建档去重（无变化零写入）/ 建档失败不影响创建 / 声明 `human` 被拒 / 未登记角色 → `unregistered` / 缺职能 → `dutiesMissing` / **sweep 清掉 4 类悬挂引用**（队列幽灵项、悬挂 `blocksOn`、孤儿 tmp 角色、已销毁会话的 `delegatedTo`）；live：角色 CRUD 只走面板 |
| **A2 锁与判定表** | `lock`（`at`/`touchedAt`/孤儿/租约/续约）、`claim`/`release`、**判定表与 `lockState` 单一实现**、动作类锁要求、`claimable` 单一公式 | smoke：抢锁 `conflict{locked}` / **同内容不同 ID 各自持锁** / 第二把锁 `session-busy` 带 `queueHead` / 幂等重复 claim / 租约过期与**孤儿锁可立即接管**（`at=now` 对照不可接管）/ **持锁会话任意写刷新 `touchedAt` → 活跃长任务不被接管** / **并发 `Promise.all` 抢锁恰一胜** / 无锁推进 `forbidden` / **无锁改 `role`/`blocksOn`/`archive` 全被拒、面板同组操作全成功** / `claimable` 与 prompt 与面板筛选同源；live：HTTP `session` 非空不得认领 |
| **A3 执行队列** | `queues` 表、`queue`/`unqueue`、软预留、释放路径、面板队列视图 | smoke：追加幂等 / 上界 / 预留生效（他人 `claim` 拿 `reserved`）/ 预留不产生锁与执行单元 / `unqueue` 后他人可接 / 并发 `queue` 同一任务恰一胜 / dispose 释放预留 / **面板清任意会话预留** |
| **B 子会话派发** | `delegate`（**每任务一个临时角色** + `boundSession`/`boundTask` + `roleBefore`）、`revoke`、`delegatedTo`、子会话 prompt 段、派发模板 | smoke：铸造并绑定 / 重复 `delegate` 先收尾旧委托 / **先 claim 后 delegate → 幂等收编、不报 conflict** / 子会话 `claim` 成功（判定表第 3 条）/ 非指名会话 `forbidden{role-mismatch}` / 非创建者 `forbidden` / 派给自己 `invalid-input` / `revoke` 与 dispose 同一套收尾（放锁或孤儿 + `role` 回退 + 删临时角色 + 结算单元）/ **已 claim 的会话 dispose 后任务回到可接池**（阻断项用例）；人工：真机走完六步 |
| **C 决策队列** | `kind`（**不可变**）、`human` 保留角色、面板队列、`stats` 计数 | `kind:'decision'` 在 AI 侧 12 条拒绝：工具 6 动作 + `delegate{revoke}`，command 3 动作（`transition`/`archive`/`delete`）+ `claim`/`queue` 各一条 `unknown action`；服务层对同 3 个动作另有一条（规则在操作里，不靠入口缺失）；**`update{kind}` 被拒且 `kind` 不变**；面板可推进；`requestedBy` 取首条 `create` |
| **D 门禁 + 等级抬高** | `parentId`、`blocksOn`（可选，写入要锁+history）、派生 `blockedBy`/`gated`、`advance`/`complete` 门禁、环检测、继承 | 门禁拒绝与 `force` 越各一条（`advance` 与 `complete` 各一次）；挡路完成后自动可推进且**等级自动回落**；未知 id/自指/成环各一条；**`delete` 挡路者后引用被清、等级回落**；归档不算完成用例；继承用例（A 挡 B、B 为 urgent → A `urgent↑`；B 完成 → 回落；链式 A→B→C） |
| **E 执行同步** | `subagent/start`/`subagent/end` + `isOwnedBy` 归属、jobs 订阅（**不做 kind 白名单**）、`executions`/`sync`、写纪律、对账、上界 | 喂 `subagent/start`/`subagent/end` fixture → 落库并 emit 一次；喂 `JobEvent`（registered→running、settled→completed 带 `finishedAt`）→ 同上；**无锁会话事件不落库但 `execSync.ignored` +1**；重复同状态不写；`output` 不落库；`ctx.jobs` 缺失时 warn 一次并标 `sync.gap`；**执行同步写不推进 `rev`**（CAS 用例：拿旧 `rev` 的 `transition` 仍成功）；超 `maxExecutions` 置 `executionsTruncated`；`claim` 时 `jobs.list(owner)` 补齐；**订阅 disposer 被调用（HMR 用例）** / **10 个执行事件 → snapshot ≤1 次**（`sseCoalesceMs` 合并，读放大） |
| **F 任务规范 skill** | `SKILL.md` + `references/roles.md`（生成快照）+ `references/dispatch.md` | 开发期出现在 `<repo>/.agents/skills/`（`project-agents`）、启动期提升为 `user-dsh`；能加载、覆盖十五条、**不含工具参数表** |
| **G 文档与清理** | 本文件定稿 + DESIGN/README/OPTIMIZATION 同步；承接 O1：删 4 处死代码 + 命名 2 处裸 `catch`；`files` 加 `role.js` | 文档与实现一致且每条改动可锚到 `host/*.js`/`index.js`/`client.js`/`cordis.patch.yml`/`tests/*.mjs`；`DESIGN.md` 接口表删 `readiness`；`smoke.mjs` 的 `schemaVersion` 断言为 2；`package.json` `files` 含 `role.js`；工件文件卫生（恰一个尾换行、LF、无 BOM）；最终验收（全量套件、receipt 等值扫描、prompt/schema 预算 pin、真子会话 e2e、GIF、提交裁定）由 Lead 与独立验证者执行 |
| **R 启动（Rollout，唯一动全局的一步）** | 覆盖层内容并进 `web` profile、bundle 归位、skill 提升到 `~/.dsh/skills`、旧 JSON 导入、重启 `dsh web`（**O7 路由 token 已定：不做**，见 §11） | 见 §13.2：`live.mjs` 35/35 + 四条人工验收 + `--dump-config` 与覆盖层一致 + 回滚点已记录 |

## 10. 测试策略

- **可测性前提**：service 构造是**注入端口** `{ domain, config, ports: { agents, presets, jobs } }`；每个事件 handler 是**可直接调用的纯函数**（入参 sessionId/job view），事件适配层只做转发，用最小 fake ctx 记录监听器（仓库先例 `jobs-local/tests/jobs.spec.ts:116` 的 `collect()`）。
- `tests/smoke.mjs`：解析链三态、建档、派发、队列（预留与释放）、执行同步、判定表、门禁与继承；租约/对账用 fixture 时间戳（不注入时钟）+ 一条"`at=now` 不可接管"的对照。
- `tests/client-smoke.mjs`：决策队列、角色管理（含临时角色）、锁与执行单元表、队列视图、"执行中/已派发/只看可接"筛选、清预留按钮、空态/断线提示。
- `tests/live.mjs`：HTTP 面（决策数据、`session` 非空不得认领、无锁推进、门禁载荷、面板推进决策、角色 CRUD、面板派发/撤销/清预留）。
- **并发与生命周期**：`Promise.all` 抢同一把锁（恰一胜）；并发 `queue` 同一任务（恰一胜）；`expectedRev` 竞态。
- **HMR/卸载**：每个新注册（事件订阅、工具、HTTP 路由）各一条"dispose fiber → 观察移除"的用例。
- **真组合**："建档失败不连累会话创建"要一条 Loader 真组合 smoke（test-only `cordis.yml` + 会抛的 store，断言注册成功且有一条 warn）。
- **hard gate**（若打开）：在真实 tools runtime 上注册插件 + 假 agent，直接驱动 `tools/pre-execute`，断言 deny 与**放行分支调了 `next()`**。
- **recorded-session snapshot**：pin prompt 各段（角色/指派/可接/队列/执行中/本会话/其他会话/决策）—— 或说明该插件为何不能进 snapshot 树并给出替代 pin。
- **四条人工验收**（无法自动化）：① 显式角色（自定义预设 + `isolate` 组）→ prompt 出现"你是角色…"与职能；② 兜底角色（`standard` 预设）；③ **真机派发**（continuable 起子会话 → 从工具回执拿 `subagentId` → `delegate` → `send_message` 发模板 → 子会话 prompt 出现 "Delegated to you" 且 `claim` 成功 → 收尾后临时角色与绑定被清、`role` 回退）；④ 真机执行同步（持锁会话起子智能体与 `pwsh` 后台任务，确认单元随实际进程变化，**失败长什么样也要写**：例如该出现 `running` 却始终为空）。
- **写放大上界**：给每个任务/每分钟的 `executions` 写次数与文档字节上界，加一条约束用例（阶段 0 之后单行 UPDATE，这个上界才成立）。
- skill 不在包内：验收是"出现在目录 + 能加载 + 覆盖十五条"；若纳入版本控制，则加 spec 校验 frontmatter 与"不含参数表"。
- **SSE 读放大**：10 个连续执行事件 → `/snapshot` 请求 ≤1 次；`sseCoalesceMs: 0` 时逐条转发（对照，证明合并窗口是唯一来源）。
- **派发竞态收编**：先 `claim` 后 `delegate` → 幂等补写绑定、不报 conflict，且 `roleBefore` 记录的是 `claim` 当时的 role（阶段 B）。
- **启动 sweep**：手工往库里塞 4 类悬挂引用 → 挂载后被清掉且写日志（阶段 A1）。
- **租约续约**：持锁会话写一次 → `touchedAt` 前进（阶段 A2）。
- **部署前提**：起子会话后断言工具回执含 `subagentId`（`continuable`）；若为 `jobId`/阻塞，说明部署前提被破坏，用例必须显式失败而不是静默跳过。

## 11. 风险与未决问题

| 项 | 说明 | 处置 |
|---|---|---|
| **S1 zod 依赖解析** | 纯 Node 下 bundle 位置 `import 'zod'` 为 `ERR_MODULE_NOT_FOUND`；**已解决**：插件目录的 5 个 junction（zod + 4 个 workspace 包）让源码启动与纯 Node 两条入口都能解析 | 实测结论与复现命令见 `probes/S1-S2.md`；`zod ^4.4.3` 与 `@deepseek-ai/dsh-storage-domain` 在 `dependencies` |
| **S2 组合写入** | **已解决**：`insert:` 行 + `routes: requirement_board: sqlite`（键必须下划线）被 Loader 接受，四个硬条件见 `probes/S1-S2.md`；键写错会静默回退 json 且无报错 | 开发期载体是 `dev.overlay.yml`；退回 json 后端仍是运行时天然路径（接口层不变） |
| SQLite 无迁移 | 平台明确不做布局迁移 | 导出/导入脚本 + DSH 升级演练一次（P2） |
| 存储顺序 | 本方案与 OPTIMIZATION.md 都改 `service.js` 与版本号 | **已定：先做阶段 0**；P1/P2 全绿后再开工 A–G，域名版本一次升到 2 |
| **执行前先注册的强制力** | 强制范围是插件操作面；平台工具面默认不设卡 | 默认 `requireLockForExecution: false`；文档与 UI 都写明这是**规范约束 + 操作面强制**，不是全进程机械强制；要机械强制就打开开关（会拦所有会话的子智能体/后台任务） |
| `jobs.list(caller)` 是弱标识 | 过滤是 `job.owner === undefined` **或** `job.owner.id === caller`（**无主 job 谁都能看到**），不是鉴权 | 只用于同步对账；写进限制，不当权限边界 |
| 子智能体 id 的来源 | **continuable 的工具回执直接带 `subagentId`**（`tool-subagent/src/index.ts:536`）；插件侧用 `subagent/start` 的 `id` 交叉校验 | 已闭环，不再需要实测；`list_agents` 只列 continuable，仅作兜底 |
| 临时角色的铸造权 | 任何"能接这条任务 + 是创建者/owner/sessions 成员"的会话都能派 | 四条前置已收紧；无跨进程认证，写进限制 |
| 孤儿锁 | 短命子会话结束会留下锁 | 标 `orphaned` 且**可立即接管**；面板标红 |
| 软预留没有租约（已定） | 活着但卡住的会话会占住队内任务 | 会话结束自动释放；面板可见 + 人可清；`stats.reserved` 可观；若被占死再加预留租约（小改动） |
| **`agent/status` 不是任务归因** | 一个 `running` 区间可能含多个回合/注入工作（defensive-patterns） | 只作"会话有活动"展示；归因只用 `subagent/*` 与 `JobView.owner` |
| 工具面 18+1 的首轮 token | 每个动作都进首轮请求 | **未落地**：插件不进受控源码/profile，无法进 snapshot pin；README 记明该例外；超支就继续合并动作 |
| **归属校验端口** | 平台谓词 `isOwnedBy(id, owner: Agent)` 按**对象身份**比较；插件暴露 id 形状的 `owns(target, caller)`，适配器用 `agents.get(caller)` 换回 Agent | 记入限制：注册表不可用、调用方无活 Agent、或目标无活 Agent → 放行 + 具名 warn 一次；判定为 `false`（有活目标且不是调用方的子会话）才拒绝（`index.js:111-126`、`host/service.js` 的 `#assertOwnedTarget`） |
| **prompt 缺 `gated by` 标记** | 被门禁挡住的条目仍出现在 "Claimable for you"，条目行不标门禁；`get`/`list` 与面板有 `gated`/`blockedBy` | **待裁定**：是否在 prompt 补标记，或把 `gated` 条目移出可接段（`host/service.js:3692-3740`） |
| 4 个自定义预设各要加 `isolate` 组 | 动的是你的 profile 配置 | YAML 在 2.3；**待你确认**（阶段 R 决定）：不加就走兜底（角色 id = 预设 id，但无职能） |
| 内置预设角色没有职能 | 兜底角色 `duties` 为空 | 明确 `dutiesMissing` 降级（3.4）；按职能路由只对写了职能的角色有效 |
| prompt 段的可回放性 | 段文本经 `systemPrompt.context` 进入请求，可从会话日志重建 | recorded-session snapshot pin **未落地**（同上一条例外）；段序与文本见 §6 |
| 决策队列靠"HTTP 路径即人" | 由 HTTP 路径推定"人"—— 同一套无认证前提（见本表"面板操作无认证"行） | 不是权限模型；写进限制 |
| **开发期与启动期配置漂移** | 开发期靠 `dev.overlay.yml` 承载 profile 级改动，启动期才并进 profile | 两段用**同一份覆盖文件**；该文件保留为"启动记录"；启动后用 `dsh --dump-config` 对比覆盖层与 profile 的实际组合（`apps/cli/src/args.ts:170`） |
| **部署前提 `backgroundMode: 'continuable'`** | 派发链依赖它；本机已满足 | §1.2 已写明；换部署必须显式打开，否则派发链**不可用**（不是降级） |

| **跨行写没有事务** | 平台单域一条串行写链，无跨行原子性 | 措辞统一为"同一写链"；防御性 join + 启动 sweep；sweep 用例（4.1 / 9-A1） |
| **面板操作无认证（OPTIMIZATION O7）—— 已定：不做** | `host/http.js:143-156` 的 `originAllowed` **缺 `Origin` 头时直接放行**（源码条件即"无 Origin 字符串 → true"），所以它只防浏览器跨站、不防本机进程；本方案新增的面板操作（清任意会话预留、角色增删、派发/撤销、推进决策）把这层暴露面**扩大了** | 写进限制：本机同用户进程可读写看板，**不宣称是权限系统**；与另外 4 个已装插件、平台 GUI 同一暴露面。真要边界应做成**平台级**需求（socket 权限 / 启动器下发 token，覆盖 GUI 整体），不归本插件单独加 |


## 12. 变更清单（文件级）

| 文件 | 改动 |
|---|---|
| `index.js` | **唯一装配点**：`agent/created`/`agent/status`/`agent/disposed`/`jobs.events.subscribe`/`tools/pre-execute`/HTTP 路由/SSE/工具注册**全部**走 `ctx.effect`/`ctx.on`，各自持有 disposer；扩展现有 `mountBoard` 生成器 |
| `host/domain.js`（新） | `defineDomain`（4 表 + global）、zod 记录 schema、**开关式导入**（`importLegacy` + `imported` 标记，4.6）、**启动 sweep**（清 4 类悬挂引用）、`nextRevision` 自愈、`export` |
| `host/store.js` | **删除**（随阶段 0） |
| `host/model.js` | 枚举与校验（`KINDS`/`HUMAN_ROLE`/`ROLE_RE`/`TMP_ROLE_RE`/`EXEC_STATUSES`）；删 `NODE_STATUSES`、`asIsoInstant` |
| `host/config.js` | **12 个配置字段**（5.12）；`dataDir`/`documentPath` 出现即 `invalid-config`（已移除）；`requireNumber` 风格不变 |
| `host/roles.js`（新） | 角色表：建档/去重/`unregistered`/缺职能/临时角色铸造替换与收尾；`agent/created` 监听（单语句 try + 命名 catch）；`holders`（服务缺失→`null`） |
| `host/dispatch.js`（新） | **判定表与 `lockState`/`claimable` 单一实现**、队列读写与预留、派发与撤销、需求图校验（两张图各自无环）、`effectivePriority` |
| `host/runs.js`（新） | 执行同步：`subagent/start`/`subagent/end` + `isOwnedBy`、jobs 订阅（不做 kind 白名单）、`agent/status` 仅作活动展示、写纪律（不推进 `rev`）、上界、对账、`execSync.ignored`/`gaps`；dispose 的整套收尾 |
| `host/service.js` | 18 个动作、动作类锁要求、决策类强制、门禁、派生字段、prompt 各段；构造改为注入端口；删 `readiness` |
| `host/tools.js` | `requirement_board` 18 动作（**不新增 `assign`**）；新工具 `requirement_role`**仅 `list`**；参数与动作说明分工；`isConcurrencySafe`/`presentCall`；（可选）`tools/pre-execute` 硬门槛（放行必调 `next()`） |
| `host/http.js` | 面板路径：**释放/派发/撤销**（**不提供"认领"**，理由见 §8）、清任意会话预留、决策推进、角色 `put`/`delete`、队列与执行单元视图；禁止非空 `session` 认领；命名已有裸 `catch`；删 `ROUTE_PREFIX` 多余 export |
| `client.js` | 决策队列、角色管理（含临时角色）、锁与执行单元表、队列视图、筛选、Toast 失败码、空态/骨架、断线提示、**不设"认领"按钮**、按 `sseCoalesceMs` 合并刷新、locale、token/字重 |
| `role.js`（新） | 函数插件（命名导出 `name`/`inject`/`apply`，无 default）：校验 `roleId`（禁 `tmp-` 前缀、**禁 `human`**）/`duties`，`ctx.provide('requirementBoardRole', …)` |
| `package.json` | 新增 `./role` 出口；`files` 加 `role.js`；声明 `zod`（+ 类型面 `@deepseek-ai/dsh-storage-domain`，按 S1 结论） |
| `cordis.patch.yml` | 显式写 8 个配置键（`defaultTemplateId`/`stallAfterHours`/`staleClaimHours`/`promptContext`/`promptMaxItems`/`maxQueueItems`/`http`/`importLegacy`）；不含 `dataDir` |
| `.artifacts/requirement-board/dev.overlay.yml`（新，**开发期**） | profile 级改动的唯一载体：`storage-sqlite` 行 + `storage-domain.routes` + 4 个自定义预设的 `isolate` 组 + `board-role` 行 + **存储后端独立路径**（`.artifacts/requirement-board/dev-board.db`）+ `importLegacy: false`；用 `dsh web --patch <该文件>` 生效，不写 profile |
| `~/.dsh/profiles/web/cordis.patch.yml`（**仅阶段 R**） | 把 `dev.overlay.yml` 的内容并进 profile；改前备份 `cordis.patch.yml.bak-<日期>` |
| `<repo>/.agents/skills/requirement-board-tasks/SKILL.md`（新，**开发期**，项目级 rank 200） | 任务创建与派发规范（7.2 十五条） |
| `<repo>/.agents/skills/requirement-board-tasks/references/roles.md`（新，开发期） | 角色与职能生成快照 + 生成时间 |
| `<repo>/.agents/skills/requirement-board-tasks/references/dispatch.md`（新，开发期） | 派发模板与美术↔程序协作示例 |
| `~/.dsh/skills/requirement-board-tasks/**`（**仅阶段 R**） | 从项目级提升为用户级（跨项目可用） |
| `tests/*.mjs` | 按第 9、10 节补；`smoke.mjs` 的 `schemaVersion` 断言改 v2 |
| 文档 | 本文件 + DESIGN/README/OPTIMIZATION 指针与限制同步（承接 O1 清理项） |

## 13. 实施与启动流程

**两段分明**：阶段 0–G 全在**开发期环境**里做，不写 profile、不写全局记忆；**阶段 R** 才是"入全局"。边界是**文件位置**，不是纪律口号 —— 下表可逐项核对。

### 13.1 开发期（不碰全局）

| 项 | 做法 |
|---|---|
| 工作目录 | `.artifacts/requirement-board/`（gitignored；插件本体、文档、测试都在这里） |
| profile 级改动：`storage-sqlite` 行、`storage-domain.routes`、4 个自定义预设的 `isolate` 组 + `board-role` 行 | 写进 **`dev.overlay.yml`**，用 `dsh web --patch <该文件>` 在**启动时叠加**（`--patch` 是"作用在 profile 层之后的额外覆盖层"，`apps/cli/src/args.ts:167-172`）；`~/.dsh/profiles/web/**` 一个字都不改 |
| 自动验收 | test-only `cordis.yml` 走 Loader 的**真组合测试**（仓库政策：产品可见插件必须有一条）+ `tests/smoke.mjs` / `client-smoke.mjs` / `live.mjs` |
| 需要看 GUI | 起**临时实例**：`dsh web --patch <dev.overlay.yml>`，端口取非 3080（端口来自 `!!js ctx.webStartup.port ?? 3080`，`packages/bundle/web-app/cordis.patch.yml:182-183`）；用受管后台任务起、验明它自己的 URL；**现有 3080 全程不动** |
| skill | 放 `<repo>/.agents/skills/requirement-board-tasks/`（项目级 rank 200）；**不装** `~/.dsh/skills/` |
| 数据 | 覆盖层给**存储后端一个独立路径**（`.artifacts/requirement-board/dev-board.db`）且 `importLegacy: false` —— **不是 `dataDir`**（阶段 0 已删除该配置，这里不能自相矛盾）；**不动**现有 `requirement-board.json` |
| **绝不改** | `~/.dsh/AGENTS.md`（全局记忆）、`~/.dsh/profiles/web/**`、`~/.dsh/skills/**`、`~/.dsh/bundles/**` |

**为什么不写全局记忆**：插件对会话的可见性靠**它自己的 prompt 段**（§6）和 skill，不靠 `AGENTS.md`；往那里写等于让每个无关会话都背这段规则，也把"插件行为"和"这台机器的环境事实"混在一起。要让其它项目也认得这套规范，那是阶段 R 的 `~/.dsh/skills/` 安装，不是改全局记忆。
**现有 GUI 不受影响**：3080 上的 `web` profile 保持现状可跑（它当前加载的是旧版插件），开发期的任何中间状态都不进它。
**临时实例方案的已知副作用**：临时实例与 3080 共享同一份插件目录（`~/.dsh/profiles/web/node_modules/dsh-requirement-board` → `.artifacts/`），所以开发期**重建 client bundle 后**，刷新 3080 页面会拉到"新 client + 旧 host"并可能报错；不刷新不受影响，3080 重启后自然一致。约定：**client 侧放到最后动**，改完只在临时实例验证；要彻底隔离 bundle 路径就得上独立 profile（已排除）。

### 13.2 阶段 R：启动（一次性入全局）

前置：阶段 0–G 全绿 + §10 四条人工验收通过 + 面板能看到 `stats` 与全部新失败码。（O7 路由 token 已定：不做，写进 §11 限制。）

1. bundle 归位：`.artifacts/requirement-board/` → `~/.dsh/bundles/dsh-requirement-board/`（按 S1 结论决定依赖声明方式，zod 随包落地）
2. skill 提升：`<repo>/.agents/skills/requirement-board-tasks/` → `~/.dsh/skills/`
3. **配置并入**：`dev.overlay.yml` 的内容并进 `~/.dsh/profiles/web/cordis.patch.yml`（改前备份 `.bak-<日期>`）
4. 数据导入：**先打开 `importLegacy` 再启动**，`requirement-board.json` → domain/SQLite 一次性导入（导完写 `imported` 标记防重放，再把开关关掉）；旧文件改名 `.migrated` 保留
5. 重启 `dsh web`（Host 插件不能热重载）—— **由你重启**，我不接管现有进程
6. 验收：`node tests/live.mjs` 期望 35/35 + 面板人工四条 + `dsh --dump-config` 显示的组合与覆盖层一致
7. 记录回滚点：profile 备份路径、旧 JSON 路径、域名版本、bundle 卸载命令

### 13.3 回滚

| 想退回 | 做什么 |
|---|---|
| 不要这个插件了 | 恢复 `cordis.patch.yml.bak-<日期>` → 重启 → 工具与面板消失（旧 JSON 仍在，数据没丢） |
| 退回 JSON 存储 | `routes.requirement-board` 切回 `json` → 重启 → 用 `export` 动作反向导出；domain 层不变，只换介质 |
| 退回旧版插件 | bundle 目录换回上一版 → 重启；**注意域名版本 2 的记录对 v1 代码不可读**，所以 v2 上线前先 `export` 留底 |
