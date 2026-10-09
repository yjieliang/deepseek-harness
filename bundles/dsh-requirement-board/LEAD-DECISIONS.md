# Lead 裁决记录（角色化任务分发实施）

> 本文件由 Team Lead 维护，记录实施期间对 ROLE-DISPATCH.md / OPTIMIZATION.md 的**实测修正与拍板**。
> 它是 Phase G 文档同步的输入；不是方案的第二份真相——方案正文仍以 ROLE-DISPATCH.md 为准，冲突处以本文件的实测证据为准。

## D1 域名必须是 `requirement_board`（阻断级）

- 证据：`packages/storage/storage/src/backend.ts:10` `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`；用已构建 lib 实测 `defineDomain({ name: 'requirement-board' })` 抛 `must match /^[a-z][a-z0-9_]*$/`，`requirement_board` 通过。
- 裁决：domain name = **`requirement_board`**；`storage-domain.routes` 的键必须写 `requirement_board: sqlite`。
- 后果：写 `requirement-board` 会**静默不匹配**并退回默认后端，不报错；因此 S2 的验收必须断言「路由真的生效」（库文件被创建/写入），不能只看进程起来了。
- 待办：ROLE-DISPATCH §4.1、§2.4 的 routes 键与 OPTIMIZATION §3.1 的域名字样在 Phase G 同步（含 regex 证据）。

## D2 依赖清单

- `dependencies`：`zod`（^4.4.3，跟随 storage-domain）、`@deepseek-ai/dsh-storage-domain`（`defineDomain`/`domainTable`）、`@deepseek-ai/dsh-storage-sqlite`。
- `devDependencies`（离线测试用真后端）：`@deepseek-ai/dsh-storage`、`@deepseek-ai/dsh-storage-json`。
- 为什么 storage-sqlite 必须在 `dependencies`：profile 的解析清单只收集 `dependencies` + `peerDependencies`（`packages/boot/app-boot/src/profile.ts:368` `profileDependencyNames`），`devDependencies` 不参与，所以放进 devDependencies 时裸名行 `@deepseek-ai/dsh-storage-sqlite` 在 dev 期加载不了。
- **这是开发期 shim，不是最终归属**：storage-sqlite 在语义上是 profile 组合项（OPTIMIZATION §2.2）；开发期借插件 manifest 承载只是不写 `~/.dsh/profiles/web/**` 的权宜。阶段 R 的正确落点是 profile 自己的 resolver manifest（`~/.dsh/profiles/web/package.json` 的 `dependencies`）或随 bundle 的安装清单。
- 解析必须同时覆盖两个入口：① dsh 进程内 import；② 从 `.artifacts/requirement-board` 直接 `node tests/*.mjs`。两条都要有实测证据（task-1）。

## D3 domain version = 2，去掉 `compatibleVersions`

- 证据：`compatibleVersions` 只被 `storage-json/per-record-unit.ts` 读取；`single` 布局（`format.ts`）与 sqlite 后端（`storage-sqlite/src/index.ts` 的 `units.version` 校验）都直接以 `version-mismatch` 拒绝不符版本。
- 裁决：`version: 2`（与 ROLE-DISPATCH §4.6/§13.3 的「升到 2」一致），**不声明 `compatibleVersions`**；v1 数据的真实通道是旧 JSON 的 `importLegacy`（自研 JSON 本来就没有 unit 头）。
- JSDoc 需写明：该字段在当前介质下不承担迁移，所以不声明；避免留下死配置。

## D4 `delete` 的 CAS

- 平台 `table.delete` 没有变换钩子，CAS 无法与 delete 同槽。
- 裁决：**仅当调用方给了 `expectedRev`** 时，先 `update(id, record => { CAS 门；返回 record })` 再 `delete`（原子正确）；没给 `expectedRev` 时保持今天的 `get` + `delete` 行为不变。不扩权、不改变无预期版本调用的语义。

## D5 legacy 路径归属

- `host/config.js` 只新增 `importLegacy`（布尔，默认 false）；路径推导（`$DSH_PROFILE_DIR/requirement-board/…`，否则 `~/.dsh/requirement-board/…`）收在 `host/domain.js` 内部，仅供导入器使用。
- 导出 `importLegacyDocument(domain, { path })` 便于测试注入路径。**不**新增 `legacyPath` 配置项。

## D6 O1 清理口径

- 实测裸 `catch {` 全仓 3 处：`host/http.js:75`、`host/store.js:167`（随 store.js 整删）、`client.js:375`（不在本阶段范围）。任务书里「4 处」是把死代码与裸 catch 混计。
- 裁决：按「删 4 项死代码 + 命名本阶段范围内的每一处裸 catch」执行。死代码 = `model.js` 的 `NODE_STATUSES`、`asIsoInstant`；`service.js` 的 `readiness`；`http.js` 对 `ROUTE_PREFIX` 的多余 `export`。`DESIGN.md` 接口表删 `readiness` 行属 Phase G。

## D7 写路径必须自保 schema

- 证据：zod 只在 `open` 的 `loadAll` 逐条 `valueSchema.parse`（`storage-domain/src/index.ts:119-143`）；`put`/`update` 不做校验。OPTIMIZATION §2.3「写入时在持久化边界再校验」在当前平台**不成立**。
- 裁决：`.strict()` 的记录 schema 只含持久字段（`flow`/`progress` 这类派生值只在 `presentRequirement` 出现）；写路径自己保证记录符合 schema，否则下次 open 整域被拒。`table.update` 的变换函数**不得原地修改记录**：先 `structuredClone` 再交给 `flow.js` 原地改。

## D8 `domain/changed` 必须过滤域

- 事件由 storage-domain 的 ctx 发出，但 Cordis 对「首参是字符串」的 emit 不施加 ctx filter → **全 app 广播**。
- 裁决：插件内裸 `ctx.on('domain/changed', h)`（随 fiber dispose），handler **必须**按 `change.domain === 'requirement_board'` 过滤。

## D9 task-3 的写范围追加

- 若存储迁移确实需要改 `host/flow.js` 的函数签名，task-3 owner 可以改 `host/flow.js`（原范围未列），但必须向 Lead 报一句。优先保持 `computeStats(document, …)` 签名不变。

## D10 阶段顺序

- 阶段 0 是硬前置（写放大决定 `executionSync` 能否默认为 true）。A1/A2/A3/B/C/D/E 与阶段 0 共享 `host/service.js`、`host/tools.js`、`index.js`，因此**同一时刻只允许一个 owner 写这些文件**；`host/runs.js`、`host/dispatch.js`、`host/roles.js`、`role.js` 是新文件，可在接口冻结后并行。

## D11 挂载期失败必须 loud，不许静默消失

- 证据（task-5 真组合通道实测）：`await store.open()` 在 async effect 里 reject 时，Cordis 会吞掉该 rejection 并 dispose 掉那个 effect（`vendor/cordis/src/fiber.ts:545-548` 只在自身 teardown 失败时才补记日志），结果 entry 仍报 `active`、无 warn/error、**工具表为空**——插件等于静默消失。
- 裁决：
  1. 阶段 0 的 `ctx.storageDomain.open(spec)` 失败**必须表现为 entry 激活失败**（像 probe run 1 的 `dsh: warning: N entries did not activate` 那样带明确 error），不能走"被吞掉的 async effect"这条路。做法：把 open 放在会让 Loader 看到 reject 的位置（例如在 `apply` 返回的 promise 上失败），或在 effect 内 catch 后 `logger.error` 并 rethrow 到 Loader 可见路径。
  2. 真组合通道里要有一条断言：**存储打不开 → 明确报错**（不是"entry 仍 active 且工具表为空"）。task-5 已把该断言写成 A1-gated PENDING（`cases.mjs` 的 `A1_STORE_CONTAINMENT_LANDED`），阶段 0/V2 要把它接上。
  3. 与 A1 的「建档失败不连累会话创建」不冲突：那条要求的是**不向上抛 + 恰好一条结构化 warn**（会话创建是别人的关键路径）；本条要求的是**自己的存储打不开时不许沉默**。两者都要，别用一条覆盖另一条。

## D12 task-4 追加范围与一处导入静默缺口

- task-4（A1）的写范围**追加 `host/domain.js`**：roles 表字段若需扩充在这里改。
- 复核阶段 0 发现：`bootstrapRequirementBoard` 在 `importLegacy` 打开、无 `imported` 收据、而表已非空时返回 `domain-not-empty` 且**不写日志**——那正是「上次一次性导入中途失败」的状态（旧文件留着重放、板子半导入、完全静默）。§4.6 承诺导入路径「从不静默」，因此 task-4 必须补一条结构化 warn（点名文件路径 + 可能是中断的导入、需人工确认）并加用例。

## D13 A1 复核裁决

- **`ports` 用解析器**（`() => ctx.get('agents')`）而非实例快照：可选服务可能后挂载。JSDoc 写明「每次读重新解析」。
- **新错误码 `invalid-role`**：`human` 保留字与 `tmp-` 前缀在 `role.js` 挂载即抛，面板 `put` 返回 409。阶段 G 补进 §8 错误码表与 locale 词条。
- **`asStringArray` 的 `itemMax` 改为真校验**（原为死参数，7 处调用方传了却从不校验）：保留全局修法，不回缩成只在 `parseRoleDeclaration` 内校验。代价是既有边界真正生效（labels≤60 / sessions≤200 / checklist≤160 / dependsOn≤64 / duties≤40），属**行为变化**：要求每个新生效边界各有一条拒绝用例，并在阶段 G 文档点名。
- **面板 UI + locale 留给 UI 任务**（§13.1：client 侧最后动）；A1 只交付 host 数据面（`role.list/put/delete` + `snapshot.roles`）。
- **角色写同样发 `domain/changed`**（每条写两帧：记录 + revision）；per-table 区分与合并窗口留阶段 E，写进 JSDoc。
- sweep 只清当前已存在的引用类型（孤儿 `tmp-*`、队列幽灵项），对 `delegatedTo`/`blocksOn` 以 `deferred:[{reference,reason}]` 具名返回并在挂载时 info 点名——不是静默跳过。

## D14 动作类锁要求 vs 既有 smoke（A2）

- 冲突：§5.4 要求「所有改结构定义的动作要求持锁」（`update` 的 `role`/`blocksOn`、`advance`、`checklist`、`block`、`archive`、`delete`），而 `tests/smoke.mjs` 全程用非空 AI 会话 `ses_A` 跑这些动作、从不 claim；落地后约 27 条会变 `forbidden`。
- 裁决：**改测试，不改设计**（选项 A）。授权 `tests/smoke.mjs` 进入 task-7 写范围，在 `create` 之后补一行 `claim`，把它写成新生命周期「先注册再跑」的记录；smoke 数量保持 54 且语义更新。
- 条件：第 122 行的 `conflict` 断言必须仍是 **CAS 冲突**（由持锁会话用过期 `expectedRev` 触发），不能被锁冲突顶掉；`forbidden`（无锁拒绝）必须由 `tests/dispatch.mjs` 的独立用例覆盖，不能因为 smoke 改了就没测。
- 否定项：不采用「只在工具面加锁」（破坏一份实现）、也不采用「A2 先不接线」（留半成品）。

## D15 A2 复核：间歇 flake、角色 prompt 归属、snapshot pin

- **必修 flake（test-reliability）**：`tests/dispatch.mjs` 的 `claim stores the holder and its lease` 间歇 FAIL（json/sqlite 同时红，退出码 1；实测约 1/3~1/5）。根因：`service.js:491` 建立新锁（`at === touchedAt`）后，**同一次写**又走 `service.js:324` 的「持锁会话任意写刷新 `touchedAt`」并以第二个 `nowIso()` 重打 → 跨毫秒即不相等。裁决：把严格不变量做成确定成立（一次写链只取一次时），**不许**把断言放宽成 `>=`；按类修所有「同一时刻应相等」的取时点；以连续 20 次运行全绿作为证据。
- **角色 prompt 的单一归属**：roles 表是 `name`/`duties` 的家，预设声明只是种子与兜底（有记录读记录 → 无记录回退声明 → 再回退预设 id）；**角色 id 永远来自解析链**，面板改名不得改变模型认领用的 id；`dutiesMissing` = 记录与声明都没有职能。理由：面板编辑必须在模型可见层面生效，`establish()` 文档的承诺才成立，`observed` 角色也不再长期空职能。此裁决使 §4.7/§6 的字面措辞过时 → **阶段 G 同步文档**。
- **snapshot pin 缺口**：§10/§483/§587 要求的 recorded-session snapshot（六段 prompt + 首轮工具 schema 字符预算）在仓库中不存在。裁决：属**阶段 R/G 的门**——插件尚未进入 profile，snapshot 树无法 pin；阶段 G 要么在装进 profile 后补上，要么在插件 README 里写明「未进 snapshot 树」的显式例外。缺口的记录见 `tests/verification/A1-verification.md`。
- **A1 验证判定（V3，独立成员）**：6 条已验证、2 条部分验证（sweep 的 `delegatedTo`/`blocksOn` 两类按构造推迟到 B/D；`delegated` 来源只验证保护规则）。**B 与 D 的任务书必须点名把这两类 sweep 真正接上**。

## D16 面板视角的 `claimable`、我的角色、客户端收窄

- **`claimable` 的两种口径（同一公式，只分支）**：`me !== ''` 是 AI 会话的资格判定（角色子句生效）；`me === ''` 是**面板的可接手池**（角色子句不生效，其余照旧）。理由：§3.5 角色/持有人是派生在线状态、不是鉴权；§2.5 人不受限；§8 面板**没有**认领按钮，它要的是"谁都能接的池子"而不是"我能认领的"。
- **面板「我的角色」**= 路由到保留角色 `human` 的条目（人自己的收件箱）；C 阶段 `kind:'decision'` 落地后扩成 `role === 'human' || kind === 'decision'`。
- **客户端收窄是临时手段**：`role`/`kind` 的服务端过滤要 C/D 才有（§5.6），UI-1 期间允许对已取回 payload 做**纯显示层**收窄，但不得在客户端重推 `claimable`/`effectivePriority`/门禁等任何 host 公式；UI-2 必须切回服务端过滤并加断言。
- **逐条「可接手」徽标**：面板额外取一次 `?claimable=true` 拿 id 集合（复用 host 公式），徽标只表达"可接手"，角色路由由角色徽标另行表达；额外 GET 的可接受性由阶段 E 的 `sseCoalesceMs` 合并窗口兜住。
- **锁的过期不暴露给 client**：`lock` 只落存储字段（`expired` 是读时派生、`staleClaimHours` 未暴露），面板只显示 age + 服务端给的 `orphaned`；§8 只要求"持有者 + 时长 + 孤儿标红"，不缺需求。

## D17 stage B 追加：`delegate` 的归属校验（confused deputy）

- 缺口：§5.5 的前置只约束**调用方**（自己接得住 + 是创建者/owner/sessions 成员），不校验**目标会话**是不是调用方的子会话。后果是任意会话可以把任务推给任意会话——目标会看到服务端注入的 `Delegated to you` 并可能去 `claim`（一条跨会话的指令通道）。
- 裁决：`delegate` 在 **`ctx.get('agents')` 可用时**要求 `agents.isOwnedBy(session, caller)`；不满足 → `forbidden{not-owned}`。**面板（`session === ''`）不受限**（人可以把任务派给任何会话）。端口不可用时放行并 **warn 一次**（具名降级，不静默）。
- 验证方式：不建真会话（不得写 `~/.dsh`），用 `tests/harness.mjs` 的 fake ctx 注入假 `agents` 端口，断言四情形：自己是父→通过 / 不是→拒绝 / 面板→放行 / 端口缺失→放行且恰一条 warn。
- 阶段 G 要把这条写进 §5.5 与 §11（它是对方案的一处加固，不是原方案已有内容）。

## D18 A3 复核裁决

- **flake 的修法被接受**：一次写链只读一次时钟（`at` 由调用方读出并传入 `#mutateRequirement`，续租/`updatedAt`/history/节点重算复用同一个 `at`），**严格不变量保留**、未放宽为 `>=`；证据 45 次运行 0 失败 + Lead 独立 10× 循环 0 失败。
- **`invalid-input` 与 `invalid-argument` 并存是规则，不是随意**：`invalid-argument` = 参数本身不可接受（未知动作、形状、上界）；`invalid-input` = 形状没问题但组合/状态不允许（队列满、派给自己）。**阶段 G 必须把这条边界写进 §8 错误码表**。
- **HTTP 无 `queue`**（理由同无 `claim`：面板不得代他人预留；`unqueue` 的 `targetSession` 才是人的覆盖手段）、**`disposeSession` 顺手 orphan 锁**、**`claim` 不释放预留**（预留保留到完成/归档/删除/unqueue）——全部批准。
- **`tests/roles.mjs` 越范围批准**：行为变化必须连测试一起改。
- **A2 遗留缺陷（`http.js` 的 `pick()` 恒 undefined → 九个查询参数全程失效）**：由 live 自证发现并修复，属正面收获；阶段 G 的错误码/接口文档要记，且必须有回归锚点断言守着（V4 独立复验）。
- **尾部换行**：artifact 目录全目录缺 `\n`（既有状态）。**阶段 G 在冻结树上一次性统一补**并做 `git diff --check` 口径检查；若这批文件最终不进受控源码（阶段 R 装到 `~/.dsh/bundles`），则在 README 写明该事实。
- **软预留无租约**（§5.3 有意取舍）：死会话预留靠 `agent/disposed` 与面板 `unqueue` 释放；事件丢失时靠 `stats.reserved` 可见。**阶段 G 文档点名这条取舍**，不改设计。

## D19 V4 复核裁决（A3 之外的三件小事 + 验证规范）

- **A3 六项全部证实**（flake 时钟单读审计、变异测试量化旧形状 20/200 红 / 现版本 0/200、九个查询参数真实路由断言、两口径对照、软预留零副作用、complete 自动放锁）。**无一被证伪**。
- **`queued=true` 不是死代码**：V4 的"公开不可达"只覆盖两种顺序，漏了「租约过期 → 他人软预留 → 原持锁者复活」这条公开路径。要求补该可达性用例（注入时间，不真等 8h）；若仍不可达，则在 JSDoc 与回报里写明依据。
- **`tests/harness.mjs` 静态 import sqlite 后端** → 连 json-only 运行也在 stderr 打 `ExperimentalWarning: SQLite`，会掩盖真正的 warn/error。改为按需动态 import，并给 json-only 无该 warning 的逐字证据。
- **一次 `queue` append 产生 3 个 `domain/changed` 帧**（建空行 + 写 item + revision）：把首项与行创建合并为一次写，降到 2 帧并加帧数断言。写放大是方案要治的东西，不靠 SSE 合并窗口兜。
- **验证规范（下一轮起生效）**：验证者的哈希基线必须**同时覆盖 `tests/*.mjs`**——V4 只覆盖 `index.js`+`host/*.js`，因此没能标出实现者中途重写测试的时刻（roles 204/210→220 就是这种噪声）。
- **跨阶段契约变化**：A 期的「receipt 全等」断言会被后续阶段（如 B 给 `disposeSession` 加 `settledDelegations`）打破。**阶段 G 做一次全量套件扫描**，实现者不必回头清。

## D20 B 复核裁决

- **`source` 用 `'delegated'` + `ephemeral:true`**（§3.1/§3.2 的 enum 是权威；任务文本里的 `'ephemeral'` 是 Lead 的简写，已更正）。
- **批准**：收尾六处 + sweep 共用 `#settleDelegation`（`lock:'release'|'orphan'|'keep'` 显式传入）；delegate/revoke 返回呈现对象超集；派发锁前置用 `lockState().allows`（孤儿/过期不阻塞）；重复派发按**收尾后** role 判定"自己就能接"；临时角色删旧铸新（不变式"每任务至多一个 `tmp-<id>`"仍成立）。
- **两级服务内写链批准，但必须补不变量**：键 `requirement:<id>` → `session:<id>`，固定先 r 后 s、任何路径不得反向；**加重入护栏（fail loud，不许挂住）**并加测试。理由：靠变异测试证明"两级都承重"是好的，但缺护栏时一次重入就会挂死整个域写链。
- **`revoke` 必须释放目标会话在该任务上的软预留**（Lead 追加，进 C 阶段步骤 0）：收尾后目标会话已无资格 `claim`，却仍占预留 → 任务被接不了的会话挡住，只能人工清。§5.3 的释放清单字面没列 `revoke`，阶段 G 补文档。
- **`stats.orphanedLocks`**（§5.6 列了但未实现）→ C 阶段步骤 0 补齐。
- **未验证项归属**：decision 的 `delegate` 拒绝分支 → C；真实六步子会话端到端（真 `isOwnedBy` + 真子会话）→ G；D17 目前是假端口实测（未创建真会话、未写 `~/.dsh`），G 若做真机需要另开受控 profile。

## D21 V5 命中：`isOwnedBy` 的端口契约用错（B 的真实缺陷）

- **事实（Lead 已在平台源码确认）**：`AgentRegistry.isOwnedBy(id: SessionId, owner: Agent)` 的实现是 `this.store.get(id)?.owner === owner`，第二参数按**对象身份**比较。B 的实现传的是**两个会话 id 字符串** → 真实组合下**每次非面板 `delegate` 都 `forbidden{not-owned}`**；面板路径（`session === ''`）绕过校验，所以作者的 live 自证（走面板命令）是绿的。
- **为什么套件没抓到**：`tests/delegate.mjs` 的 fake 端口实现的是**双字符串契约**，与平台契约不同 → 绿着错。这正是 `packages/AGENTS.md`「产品可见插件必须有真组合测试」与「fake 必须 faithful」要防的事。
- **修法（强制）**：① 插件自己的端口契约显式定义成 id 形状（如 `owns(childId, parentId)`），**适配只留在 `index.js` 端口边界**；② 适配器要把 `parentId` 解析成 Agent（公开访问器，或从 `agent/created`/会话作用域捕获）；③ **不许**把"永远 false"留在真实路径上；两条路都不通时只能"放行 + 恰一条具名 warn"；④ 测试 fake 改成**平台形状**（第二参数必须对象身份，并断言 `typeof === 'object'`）；⑤ 加"契约形状"回归锚点，使这类 bug 不能回来。
- **同时裁决**：`delegate` **必须看软预留**（被调用方与目标之外的会话预留 → `conflict{reserved}`；预留者恰为目标 → 合法收编），与 `claim` 判定表对称；**允许链式再派发**（临时角色持有者派给自己的子会话，`effectiveRole = roleBefore` 判定），并要求文档写明。
- **教训（写进验证规范）**：fake 与真实平台谓词不同 = 套件绿、真机必红。验证者必须记录"真实入参"并说明 faithful 到什么程度。

## D22 V5 结论与两条规则

- **D21 的缺陷已修复并独立复验**：新契约 `ports.owns(target, caller) => boolean | undefined`（id 形状），平台知识只在 `index.js` 的 `createOwnershipPort`（`agents.get(caller)` → `isOwnedBy(target, ownerAgent)`）；`undefined` = 判不了 → 放行 + 具名 warn 一次。V5 用**平台形状 stub** 的真组合 instrument 复验 17/17，并断言边界递出的第二参数是 **Agent 对象**；变异回"传字符串"立刻红（详情打出 `string`）。作者套件同步改成平台形状并加锚点（`delegate` 330/330）。
- **`delegate` 与软预留**（与 `claim` 判定表对称）：第三方持有预留 → `conflict{reserved}`；预留者恰为目标 → 合法收编；**预留者恰为调用方 → 在同一次写链里释放调用方自己的预留**（不转成目标的队列项、也不报错）。理由：任何"造出被指名会话接不了的任务"的路径都不接受（同 D20 否掉 `revoke` 现状的理由）。
- **`delegate{revoke:true}` 在无委托的任务上保持幂等成功**，但回执必须 `changed:false` 且写 0 次；有委托时 `changed:true`。与 `unqueue`、无锁 `release` 的幂等清理形状对称。
- **允许链式再派发**（持有委托的会话派给**自己的**子会话）：接受；`roleBefore` 取结算后当前值、永不为 `tmp-*`；全任务仍只有一行 `tmp-<id>`，`boundSession` 指向最深的受派会话；被取代的会话 `claim` → `role-mismatch`；prompt 只在最深会话出现 `Delegated to you`。文档条目留 G。
- **未验证项**（记录，不阻断）：真机 continuable 子会话链（`subagentId`）、真实 `AgentRegistry`（V5 只复刻谓词与 `get`/`list`）、3105 活通道（有意跳过，全程未开 socket）。

## D23 C 复核裁决

- **§9-C「六动作 × 两入口 = 12 条拒绝」按分解记录**：面板 command **无** `claim`/`queue`（A3 批准的设计）、command 的 `delegate` actor 恒为面板，因此字面 12 条不可达；实测 15 条拒绝（其中 12 条 `decision-task`）+ **服务层同三动作 3 条**，后者证明**规则在操作里而不在表面**。阶段 G 把 §9-C 改写为这个分解并写明 command 无 `claim`/`queue`。
- **`block`/`unblock`/`checklist` 不纳入决策的人类专属清单**：§5.7 的六个动作即规格；`kind` 不可变 + `update` 白名单已关掉"改成任务再认领"的后门，`block` 不提供通往执行的路径。**保持现状**，JSDoc 写明这是有意边界与理由，阶段 G 写进文档"已知边界"（并记录 `block`/`checklist` 是否需要锁这一事实）。
- **`delegate` 释放调用方自身预留放在需求写成功之后**（批准）：拒绝路径（self-delegate、`expectedRev` 冲突）发生在 transform 内部，写前释放会让被拒的派发也丢预留。已断言"被拒的自派发后预留仍在"。
- **`stats` 只统计未结束（非 done/archived）**：批准，JSDoc 写明口径。`requestedBy` 回退链 `actor.name → 注册表显示名 → 会话 id` 批准（避免 prompt 里出现裸会话 id）。
- **决策段措辞**采用逐字 `Waiting on the human (N) — only the human advances these:`（测试钉住）。
- **派发后的决策没人能 `claim`**（`claimable()` 要求 `kind==='task'`）：批准并写进阶段 G 文档——派发决策的语义是"把问题交给某会话准备上下文"，不是交给它执行。
- **链式再派发**的文档条目、`block`/`checklist` 残留、§9-C 分解——三项归阶段 G。

## D24 F-sync（skill ↔ 实现）裁决与收口

- **判据取实现、逐条给"规则 → 实现锚点（文件:行）"对照**：F-sync 交付的对照表（R1–R14）是这次对齐的权威记录，**14 条规模未变**、无参数表/调用语法、`user-invocable: false` 保持、三份文件同步、未 commit。（**已被取代 2026-10-08**：看板 skill 现为 15 条——新增「流程模板要匹配需求本身的流程」，见 `SKILL.md` 第 15 条；本条保留为 D24 时点记录。）
- **R8「执行状态」写"看板目前不同步"是正确的**：E 阶段未落地前，skill 不许把未实现的能力写成既有能力。**E 落地后必须翻面**（已开收口任务）。
- **R9/R10 只做文档字面校对**（按 Lead 指示不写实现细节）：D 落地后由 Lead 把事实交给 skill 作者收口，避免它猜实现。
- **`roles.md` 重新生成的依据**：`dev.overlay.yml` 的 4 条声明 + 8 个预设实况（4 个 observed 兜底无职能、4 个自定义声明有 duties）+ `roles.js`/`model.js`/`templates.js`。
- **历史报告不改**：`A1-verification.md` 的"观察 A（prompt 不读 roles 表）"被 A3 的 D15 落地推翻（`promptLine` 现在读 records）。**V3 的报告是当时的实录，不修改**；但 skill 与后续文档不得再引用该过时结论。收口任务已包含这一条。

## D25 UI-2a 复核与两条宿主缺口

- **UI-2a 通过**（`client-smoke` 126 → **184**，`client.js` 1894 → 2393 行；DICT en/zh 各 195 键键集一致）。要点：视图切换器（board/queue/decisions）各自重述口径；队列视图按 `reservedBy` 聚合并提供"清除预留"；委托徽标+详情+撤销；决策视图常驻"只有人能推进"notice 且编辑表单**不提供 kind**；`BoardToast` 新增 `muted` 档（幂等清理"本来就没有"既非成功也非失败）；空态区分"看板为空"与"过滤后为空"（用 `total` 判断是错的）；计数条按**存在性守卫**渲染（宿主没报的计数不编造 0）。
- **`role` 过滤必须补到宿主**（D16 的"服务端过滤"要求）：`GET /snapshot` 现有参数缺 `role`，`listRequirements` 没有 role 子句 → 面板只能本地收窄。**这同时解决"人的收件箱"**：`?role=human` 就是 §D16 的「我的角色(human)」口径（`me` 是会话 id，不可能表达"角色=human"）。
- **队列顺序/队头必须补到宿主**：snapshot 每条只有 `reservedBy`，没有队列顺序；面板因此只能表达"谁占着哪些"、无法表达"下一个是谁"。要求 snapshot 增加按会话的队列视图（`[{session, items:[{id,at}], head}]`），复用已有的 `#queueHeadOf`/`#presentQueue`，不许在客户端编造顺序。
- 两条缺口归 **E 阶段**（见该任务步骤 0）；UI-2b 在 E 落地后接上，并把 `role` 过滤从本地收窄切到服务端、给队列视图补"下一个是谁"。
- 客户端的 `changed:false` → `muted` 逻辑对 `unqueue` 与 `revoke` 一致；若今后 `release` 也返回 `changed`，沿用同一判断（语义已统一为"幂等清理"）。

## D26 D 复核与面板路由的鉴权一致性缺陷

- **`advanceable` 按 §5.6 正文口径实现是正确的，§4.4 表格那行是错的**：空闲且无门禁的记录 `claimable=true` 而 `advanceable=false`、实际 `advance` 返回 `forbidden{lock-required}`；照表格 `claimable && !gated` 会让派生值与"实际推得动"矛盾。**阶段 G 改 §4.4 表格为 `advanceable = 持锁 ∧ !gated`**（`claimable` 继续答"能接"）。
- **`tests/roles.mjs` 越范围批准**（D 改了 sweep 行为，测试必须跟着改；同 A3 先例）。
- **归档挡路者仍参与抬高——保持现状**：§5.8 明写"归档不算完成 —— 仍在"，既挡路也该抬高；单点收敛在 `escalationIndex` 的 `inProgress`。
- 旧记录兼容（缺 `blocksOn`/`parentId` 读作空/根、`getRequirement(id, me='')` 默认面板）批准。
- **面板路由鉴权一致性缺陷（安全）**：实测 `/api/requirement-board/*` 不带登录 cookie 也返回 200，只有跨源才 403。平台约定是 `connection.requestRejection(request): 401 | 403 | undefined`（`packages/client/connection/src/api-request-trust.ts` + `browser-auth.ts`；消费先例 `packages/host/open-in-app/src/index.ts:80`）——注意形参是**请求事实对象**（内部读 `request.headers` 的 Host/Origin/sec-fetch-site），**不是 header bag**：D26 原文写成 `requestRejection(headers)` 是错的，E 阶段按该错误口径实现后 live 实测整个前缀路由 **400**（面板完全不可用），已改为 `requestRejection(req)` 并加断言（假 connection 也按 `request.headers` 读）。**处置**：面板路由优先用该端口（可选注入），保留现有 loopback Origin 检查作为服务缺席时的回退；口径写进 JSDoc；live 复验"无 cookie → 401、有 cookie → 200"（已通过）。归 **E 阶段步骤 0.3**。
- **`?role=` 过滤与队列顺序/队头**（D25 的两条宿主缺口）同归 E 阶段步骤 0；UI-2c 在 E 落地后接上。

## D27 V6/UI-2b 裁决、`advanceable` 正典公式、以及 5 个待修缺陷

- **V6 结论**：C/D 的**功能裁决全部证实**（`kind` 不可变、人类专属在操作里、`requestedBy` 首建、决策不进任何池、`stats` 口径、`advance`+`complete` 门禁、`force`/`rollback`/`jump`、**两图各自成环 + 跨图独立 + 120 深链终止**、`delete` 同链解绑、抬高拦路者/封顶/不落盘/回落/归档仍挡、四条读路径同源、`[high↑]` 按段、模板依赖先于门禁、20 条上限）。作者套件同文件集 1080/1080。两条"能变红"对照（拆 `advanceable` 持锁子句、拆成环守卫）成立。
- **`advanceable` 正典公式（修正 D26，采纳 V6 的独立读数）**：矛盾有 **3 处**（空闲会话、决策+面板、持锁但节点前置未满足），不是 1 处。正典 = **（锁在手上 ∨ 面板）∧ 跨需求门禁已清 ∧ 节点前置已满足（模板依赖）∧ 状态 ∉ {done, archived} ∧ kind 允许**；**`completion-not-met` 有意不入**（节点自身完成条件不是"能不能推进"的一部分，已用显式证据固定）。**要改两处**：§4.4 **表格**与 §5.6 **正文**（正文同样漏了"节点前置已满足"），并写进 `advanceable` 的 JSDoc，否则改一处会再次分叉。
- **F1–F5（V6 发现，全部派给 E 修）**：①`judgeClaim` 的 `kind` 子句与池子不一致（直接写库塞 `kind:'epic'` → 池子拒但 `claim` 成功、`byKind` 撑出 `epic`、下次开机 `invalid-record`）→ 两边同用 `kind === 'task'`；②**模型可见**：被派发的决策仍进 `Delegated to you` 且提示去 claim 一个恒拒的东西 → 加 kind 子句；③决策的 `checklist` 报 `lock-required` 而非 `decision-task` → `#assertHumanOnly` 必须在锁检查之前；④空 patch 的 `update` 仍推进 `rev` → 无变化应零写（不推 `rev`、不记 history）；⑤`tests/_rb-debug-smoke.mjs` 是作者调试残留 → 删。
- **UI-2b 结论**：`client-smoke` 184 → **225**；`TakeBadge` 删除，`claimable`/`advanceable` 彻底分成两个徽标；关键路径标记 + "自身 priority vs 有效等级（只读推导、未写回）"、门禁双向 + `gated`、`force` 三步显式确认（拒绝 → 原地报价 → 确认弹窗）。**本轮实测修掉两个真缺陷**：①详情"换选中项重置"用 `useEffect` 会被重挂载清掉用户正在改的门禁字段与屏上的 force 拒绝 → 改渲染期 state 调整；②force 报价改为单槽按需求 id 归属，残留报价不会在别的需求上开门。
- **写 `blocksOn`/`blockedBy` 方向时别再搞反**：宿主里 `blocksOn` = 我声明的前置（我依赖谁），`blockedBy`/`gated` = **当前挡着我的未完成项**。E 的任务文本曾把两者注反，UI-2b 按宿主事实做了。G 阶段要核对 ROLE-DISPATCH 自己的措辞。
- **面板仍缺的宿主能力（不阻断，记录为取舍）**：①反向索引（谁在等我 / 我挡着谁）未暴露，面板用 `escalated`/`effectivePriority` 作"我在抬高下游"的信号；②`stats.criticalPath` 是**计数**、每行 `escalated` 才是标记，下游易混，需在工具描述/文档点名；③`invalid-transition{blocked-by}` 的 `details.blockedBy` 只给 id，页面能解析 `title (id)`，被筛掉时只能显示裸 id（`{id,title}` 是可选改进）。
- **环境硬规矩（本机）**：**不要用 `Get-Content`/`Set-Content`/`-replace` 处理含 CJK 的文件**——PowerShell 5.1 的 GB2312 往返会把 UTF-8 中文毁掉（本轮 `tests/client-smoke.mjs` 实际丢过 75 个汉字，靠会话日志逐帧恢复）。写文件用编辑工具或 Node 脚本。这条**属于用户机器事实，未写入 `~/.dsh`**（开发期边界），只在本决策文件与回报里点明。
- **E 中途态**：`tests/loader.mjs`（组合通道）与 `tests/runs.mjs` 在 E 施工期间红，其余 host 套件在 E 写 `service.js` 的瞬间也会红。**E 收尾时这两条必须绿**——`packages/AGENTS.md` 要求产品可见插件有真组合证据，loader 红就是缺陷不是噪声。

## D28 E 复核裁决

- **E 通过**：Lead 独立复跑 11 套件全 exit 0（`runs` 308、`loader` 53、`gates` 246、`decision` 228、`delegate` 344、`queue` 304、`dispatch` 302、`roles` 220、`domain` 88、`smoke` 66、`client-smoke` 225），`_rb-*` 调试残留已清除。
- **接口签名教训**：`connection.requestRejection(request)` 的形参是**请求事实对象**（内部读 `request.headers`），D26 原文写成 `(headers)` 是**错的**；按错口径实现后 live 实测整个 `/api/requirement-board/*` 前缀 **400**、面板不可用。已更正并加断言（假件也按 `request.headers` 读）。**这是"真组合 + 真 HTTP 不可替代"的又一例证**：单测与假件与缺陷同错时，只有实机路径能暴露。
- **接受的实现口径**：`sync.gaps` 只计**真正丢掉的观察**（不再计"从未注入"）；`executionChanged` 只比 `status`/`progress`/`detail`（`finishedAt` 每边重写、计入会导致"重复同状态也写"）；`requireLockForExecution` 的拒词与 `EXECUTION_TOOLS` 清单由实现者定并写进 JSDoc（§5.4 只给行为不给词表）；`cordis.patch.yml` 不加开关行（默认值够用）。
- **未验证项（记录）**：live 无法证明"真实子任务/job 落进 `executions`"（本机无 `DEEPSEEK_API_KEY`，起不了真会话/job）——由 `tests/runs.mjs` 的真 `DomainFacility` + 真 `apply` 挂载与 loader 组合通道覆盖；**真机六步子会话流程整体仍属阶段 G 的待用户确认项**。
- **E 新增的宿主能力已供 UI-2c 使用**：`snapshot().queues = [{session, items:[{id,at}], head}]`（与 `unqueue` 回执 `head` 同源）、`?role=` 服务端过滤（`role=human` 即可表达"人的收件箱"）、鉴权门（无 cookie 401 / 跨源 403 / 有 cookie 200）。
- **并行收尾**：UI-2c（client-ui）、V7（composition-verifier）、F-sync 收口（skill-author）、G 文档同步（新成员 `doc-sync`，task-24）已同时启动；prompt/schema 预算 pin（等价 snapshot 守门 + README 例外）排在 V7 之后。

## D29 写入者协议：禁止整树改写，冻结后再做一次卫生

- **事件**：G 文档任务开工时，`doc-sync` 在 5:25:22 对 `.artifacts/requirement-board/**` 做了**全树字节归一**（122 个文本文件：UTF-8 无 BOM、LF、恰一个尾换行），**越出它的声明写范围**（它只该写 `ROLE-DISPATCH.md`/`DESIGN.md`/`README.md`/`readme.md`/`OPTIMIZATION.md`/`G-CHECKLIST.md`/`package.json`），且与三名在写者（client-ui 的 `client.js`/`tests/client-smoke.mjs`、composition-verifier 的 `tests/verification/**`）存在亚秒级竞争窗口。
- **裁定**：①**任何成员不得对整树或他人文件做批量改写/格式化/字节归一**，即使"无语义改动"——批量脚本不受文件版本守卫保护，必须显式协调；②"所有文件恰一个尾换行 / LF / 无 BOM"这条**由 Lead 在所有写入者停手后的冻结时刻做一次**并记账，过程中成员只做**自己清单内文件**的自检，报告里只能自称"Author 侧预检"。
- **风险评估（无需补偿）**：各在写者对该时刻的写入都**晚于** 5:25:22（`e-verify.mjs` 5:25:58、`_e_*.txt` 5:26:0x、`client.js` 5:26:41、`client-smoke.mjs` 5:27:03），且 Lead 独立复跑 11 套件全绿（含 `client-smoke`）——若发生旧内容回写，行为测试不可能全绿。doc-sync 当时看到的 `client-smoke` 2 条红是 client-ui 的进行中状态，**不是缺陷、无丢更新证据**。
- **留痕**：临时/调试文件（client-ui 的 `tests/.uic-hygiene.cjs`、V6 的 `_cd_*.txt`、V7 的 `_e_*.txt`）在冻结时由 Lead 统一决定保留为证据还是清除。

## D30 V7 裁决、F-E1/F-E2 的两个相反处置、以及 3080 越界事故

- **V7 通过（四条点名全部证实）**：①拿旧 `rev` 灌 10 条执行观测后 `execRev=10`、`rev` 不动、旧 `rev` 的 `transition` **成功**（同 rev 再用才 `conflict`）；②鉴权门 401/403/200 与 8 条绕过（只 Origin/只 Host/`?token=`/空 cookie/伪造/过期/他人凭据/跨源）全对，且门收到的是**同一个 request 对象**；③500ms 窗口内 10 个执行事件 → **1 帧**，业务 `transition` 不被吞，`sseCoalesceMs:0` → 20 帧；④**挂载期写次数 0**（写故障 store 上两条腿都是 0 次写，缺注册表腿 warn 恰一次、派生 gap、仍 0 写）。F2/F3/F4/F5 证实。三条变红对照成立。
- **F1 部分证伪，拆成两个处置（方向相反，理由必须写清）**：
  - **F-E1 是缺陷**：`stats.byKind` 给闭集外的 `kind` 造桶（`{task:0,decision:0,epic:1}`），与池子/`judgeClaim` 的闭集口径不一致 → **修**（`byKind` 与池子共用同一条判据），已派 storage-migration。
  - **F-E2 是设计行为，不改**：存量非法 `kind` 使整块看板 `invalid-record` 打不开。**不采纳"读路径归一化"**：阶段 0 验收条目就是"坏记录 open 报 `invalid-record`"（`tests/domain.mjs` 有断言）、D7 定了"写路径自守 schema、开库大声拒绝"、`version: 2` 明确无 `compatibleVersions`（政策：前代不隐含回退或降级支持）、而**静默把无法理解的值当 `task` 会重解释持久数据**（违反 fails-loud / never-silently-skip）。**唯一要改的是诊断**：错误信息必须带 zod issue path（点名 `kind` 与收到的值），让运维 30 秒修好；JSDoc 写清"拒绝是设计的一部分，超出封闭并集的值只可能来自手工改库或更新版本，本插件选择大声拒绝而不是猜"。
- **3080 越界事故（V7）**：V7 直接跑 `tests/live.mjs`，而它默认访问 **3080**（用户正在用的 GUI）。后果已量化：3080 上跑的是**旧构建**（写 `schemaVersion: 1` 的旧 JSON），探针自建自删、板上仍是 `requirements: {}`，只多了一个 revision 计数器；被写的文件是 `~/.dsh/requirement-board/requirement-board.json`。**规则**：任何人**不得再访问 3080**；需要 live 证据一律用临时实例（3099/3106/3107/3108…）并在收尾停掉。V7 那条 `a done requirement is excluded from the open filter` 的失败属**宿主旧版本读数**，与当前 revision 无关（同哈希源码两后端已证明 `status=open` 排除已完成记录）。
- **开发期 `~/.dsh` 足迹审计（Lead 亲查）**：自 02:00 起只有三处——`storages/requirement_board.json`（02:07，v2 域存储，`requirements/roles/queues` 全空，只有内置模板）、`requirement-board/requirement-board.json`（05:30，旧版式，空板，事故写入）、`profiles/web/cordis.yml`（05:12，**内容仍是 stock 4 行**，mtime 被触但无可归因改动）；profile 补丁层 `cordis.patch.yml` **不含**本插件或存储路由行（阶段 R 未泄漏）。`profiles/web/node_modules/dsh-requirement-board` 是开发期软链（设计内）。**两处板数据都是空板，无用户数据**。
- **PowerShell 编码教训的精确版**：`Get-Content` 在 PS 5.1 控制台会**按 GB2312 误读 UTF-8**，因此看到的中文乱码可能只是**读侧**假象——本次我一度以为 `~/.dsh/profiles/web/cordis.patch.yml` 的 `displayName` 坏了（`闃块噷浜戠櫨鐐?`），用 `read` 工具核实**文件本身是好的**（`阿里云百炼`）。所以规矩是双向的：处理含 CJK 的文件**读**也用 `read`/Node，**写**绝不用 `Set-Content`/`-replace`。
- **UI-2c 通过**：`client-smoke` 225 → **279**（去重后 **277**，删掉的是 UI-2b 遗留的重复夹具块，逐字节比对确认无独有断言），`client.js` 2939 行；`role` 切服务端（本地收窄层及其标签彻底删除）、队列队头取自 `snapshot.queues`（与 `unqueue` 回执 `head` 同源、不自排序）、执行单元三态（同步关/有 gap/同步且空**严格分开**）、`stats.running`/`execSync.*` 存在性守卫、**401/403 终态提示**（`authExpired`/`authCrossOrigin`，SSE 关闭、不自动重试；保留一个**用户手动**的"重新检查"按钮，裁定接受：禁的是自动重试循环，不是手动出口）。
- **F-sync 收口通过**：R8 整条翻面为"执行状态：看板自动同步"（含 `executions`/`sync` 三态读法、`execRev` 与 `rev` 解耦、真机事件无证据如实标注、`workflow` 不再列为被追踪对象）；R9/R10 升级为实现事实；顺带对齐 R5（`requireLockForExecution` 使"非全进程强制"不再成立）、R13 与 `dispatch.md §4` 的"被指派 ≠ 推得动"；14 条不变、无参数表、三份文件同步、LF-only。（**已被取代 2026-10-08**：现为 15 条，多出「流程模板匹配」一条；本条保留为 D30 时点记录。）

## D31 G 文档同步裁决、原始日志豁免、以及 live.mjs 的凭据口径

- **G 文档同步通过**：`ROLE-DISPATCH.md`/`DESIGN.md`/`README.md`/`OPTIMIZATION.md`/`G-CHECKLIST.md` 与实现对齐，**10 处"文档与实现矛盾"只改文档、未擅自动实现**（§5.7 的"六动作×两入口"实测分解、§4.4 `advanceable` 旧式、§4.7 history 词表多列 `queue`/`unqueue`/`checklist`、§8.2 漏 `unsupported-legacy-version`、DESIGN 的 `readiness`/`host/store.js`/`schemaVersion: 1`/两表/`dataDir`、README 的"profile 目录 JSON 文档"与 13 动作、OPTIMIZATION 的域键 `requirement-board`/`version: 1`/`compatibleVersions` 承诺/`storage-sqlite` 行缺 `insert`、§5.3 释放路径、§5.5 归属与链式再派发、§5.6/§5.9/§5.12 字段与语义）。
- **`package.json` 的 `files` 补 `cordis.patch.yml`（Lead 已改）**：`dsh.bundle.patch` 指向它，`install_bundle` 现在能用不代表 `npm pack`/发布不会缺文件；`role.js` 已在列表（§9-G 成立）。
- **原始捕获日志豁免源码卫生规则**：`tests/verification/_*.txt` 是**原始证据**，允许 UTF-16LE/BOM；`_e_*.txt` **保持原样不再转**。doc-sync 在 5:25:22 把早期 `_a3_*`/`_b_*`/`_cd_*` 转成 UTF-8/LF 一事**接受**（内容逐字节语义未变、无测试读它们），但**在最终回报里如实披露**：早期原始日志的字节编码被归一过一次。
- **`G-CHECKLIST.md` 保留裁定编号**（它是动作追踪清单）；四份正文文档**不得**出现裁定编号（裁定留在本文件）。
- **`live.mjs` 35/35 已达成**：composition-verifier 用**当前源码**在临时实例 **3108** 上跑出 35/35，且**未改作者套件**——新增 `tests/verification/live-auth.mjs`（启动 token → 一次会话 cookie → 附到套件每个 `fetch`，即浏览器打开 GUI 的同一路径）。**无凭据只有 2/8**（`?token=` 加在 API 上、`Bearer`、仅 loopback `Origin` 全 401）——这恰好是"鉴权门在真实部署下真的挡人"的正向证据。已批准给 `tests/live.mjs` 加**可选**凭据参数（`argv[3]`/`DSH_BOARD_TOKEN`），并要求**无凭据时响亮失败并点名原因**，不再报 2/8 那种迷惑结果。
- **`~/.dsh/profiles/web/cordis.yml` 的 mtime 悬案解开**：启动器每次启动都会按原样重写该文件（内容始终是空根 `[]`，223 B），不是任何成员改的。
- **残留处置**：`.artifacts/requirement-board/.artifacts/.../_tmp_stats/`（测试残留，无任何测试引用或生成它）**已由 Lead 删除**；仓库根 `_tmp_27116_*`/`_tmp_45252_*`（0 B）与 `.workbuddy/` **不是本次引入，保留不动**，在最终回报里点名"归属未知、非本次产物、未处理"。`dev-board.db*` 在全部 live 跑完后由 Lead 清理。
- **V8（task-26）独立收口核对已开**：全量文档锚点存在性 + ≥40 条承重锚点语义核对（因 doc-sync 读取的树此后又被 F-E1/F-E2 微修改过）、receipt 全等扫描（G 清单第 40 项，A 阶段的整份回执深比较是否被后续阶段加字段弄成假绿/假红）、卫生与残留独立读数、边界核对。**本轮之后所有人冻结**，冻结时刻由 Lead 做**一次**全树卫生检查。

## D32 生产缺陷修复：面板空白（槽位钩子少传 selector）与新增真浏览器渲染门

- **用户报告**：重启后的 3080 里侧边栏「需求看板」入口在，点开主列**一片空白**（连标题、筛选器、按钮都没有）。
- **根因（真浏览器取证，非推断）**：`client.js` 两处把渲染器绑定的 `use<Name>` 钩子当无参函数调用——`BoardPage` 的 `props.useBoard()`、`BoardToast` 的 `useToast()`。渲染器的绑定是 `useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)`（`packages/client/ui-renderer/src/client/bind.ts:21-26`），**selector 必填**；传 `undefined` 后 React 内部抛 `TypeError: l is not a function`，槽位渲染器捕获后只记 `slot entry crashed in 'main'` / `'shell.overlay'`，于是**条目整块不渲染**、面板空白；侧边栏图标不经过钩子，所以只有它活着——与用户看到的症状精确一致。
- **取证方式**：Lead 自写 Playwright 探针打开真壳（chromium 1228），抓到 4 条 console 错误与完整堆栈并截图。**这是本项目第一次真正打开面板**；D/E/G 三轮的"面板"证据此前全是 HTTP 级。
- **修复**：`client.js` 在工厂内加一个 `identity` 选择器，两处改为 `props.useBoard(identity)` / `useToast(identity)`；开发树与部署副本**逐字节同步**（`client.js` `694BBA17…` → **`6687242B1B09A29838EDC675302F4889E33445607A20E60EB0AE7CC575A9EBE6`**，148070 B）。改动由 Lead 在 frozen 状态下直接实施：缺陷已在生产、修复面只有 2 处调用点且契约由平台源码固定，等一个回合的成本高于风险；**纪律代价如实记录**（client-ui 未参与本次修改，其冻结哈希作废）。
- **验证**：真浏览器 0 错误、面板完整渲染（标题 / 看板·队列·要我拍板 / 统计卡 / 筛选器 / 空态）。新增常驻门 `tests/verification/panel-render.e2e.mjs`（`<base> <token>`，与 `live.mjs` 同凭据口径，无凭据 exit 2）：**绿 7/7 exit 0；红控 1/7 exit 1**（把少传 selector 改回部署副本 → `.rb-root` 不存在、4 条错误），复原后逐字节一致；截图 `tests/verification/_panel_render.png`。
- **为什么 277 项 `client-smoke` 全绿却没抓到**：那套件用手工假渲染器/假槽位，**不经过真实的 uSES 绑定**，"钩子必填 selector"这条平台契约在假件里不存在——与本项目已吃过一次的教训同型（D26 的假 connection 与真 `requestRejection(request)` 共享同一个错误契约）。**新的浏览器门是这类缺陷唯一的守门人**；`client-smoke` 保留其原有价值（域/控制器/文案），但不再被当作"面板可用"的证据。
- **面板空白的第二层事实（与缺陷无关）**：生产库 `requirements = 0`、`templates = 1`、`roles = 2`。R 迁移的旧 JSON 里本来只有 1 条模板、**0 条需求**，所以"空板"不是数据丢失；空态文案是"还没有需求。可以在这里新建，或让 AI 创建。"。开发期 `dev-board.db` 已不存在（`unable to open database file`），没有可补迁的开发期数据。
- **部署生效方式**：客户端产物按内容哈希发 URL（`?rev=…`），部署副本一改，浏览器**刷新**即取新字节（宿主侧 `dsh-client-hmr` 也会 stat-poll 该行并热换）；**不需要重启宿主**，若刷新后仍空白再重启 `dsh web`。

## D33 角色管理 UI 整容：改用平台原生件（route A）与第三次同型测试诚信教训

- **用户报告**：角色管理页面 UI 样式难看。**诊断（真浏览器取证，非审美推断）**：该对话框的遮罩与卡片同用 `--dsw-alias-bg-overlay`（scrim token）→ 渲染成均匀灰板、海拔不可见；内部控件全部自绘，度量与平台不一致。给用户两条路线，**用户选 A：改用平台 primitives 根治**（而不是逐个调自绘 CSS）。
- **先证前提再动手**：`require('@deepseek-ai/dsh-client-ui-primitives')` 在**部署态可解析**，且原生件 CSS 由 shell 静态样式表提供（`PLATFORM_MODULES` 基线外置，动态 bundle 无需声明）——这是"能不能复用原生件"的唯一门槛，先实证再排计划。
- **切片 1（Lead 实施）：对话框 → 平台 `Modal`。** 删 `.rb-overlay` 与手写 Escape 监听；遮罩、表面、圆角、海拔、遮罩模糊、Escape（仅顶层）、Tab 陷阱、`[data-modal-autofocus]` 进入焦点、焦点归还、窗口边缘内缩全部由平台接管。踩坑两处，都只有真浏览器能发现：① 宽版对话框类名是 `rb-dialog-wide`，只写 `.rb-dialog` 不匹配规则；② `Modal` portal 到 `body` 脱离 `.rb-root`，正文从 13px 变 16px，卡片须自带排版上下文。
- **切片 2（client-ui 实施）：44 处 `h('button')` → `Button`**（primary 11 / outline 9 / ghost 24；`sm` 26 / 默认 `md` 18），删 7 条 `.rb-btn*`。`Button` 无 danger 变体 → 危险动作 = `variant:'outline'` + `.rb-btn-danger`；**该覆盖改为双类选择器 `.rb-btn-danger.rb-btn-danger`**，不再依赖"与平台 outline 谁后注入"，并把契约写进浏览器门：新增两条断言（危险按钮计算色 == `--dsw-alias-state-error-primary`），门 **7/7 → 10/10**。
- **切片 3：25 处徽标 → `Tag`**（outline 9 / warning 6 / info 6 / success 3 / danger 1 + 2 处动态映射）。9 处带 tooltip 的外包 `<span title>`（`Tag` 只接收 tone/className/children，逐处核对无 rest 属性丢失）；删 20 条 `.rb-badge*`，保留 `.rb-badge-group`（它是布局容器）。**Lead 的两处修正**：`-run`（运行中）在映射表里被我写成 `info`，按语义（运行中=健康活动态）改回 `success`；详情页 kv 行的两个值**回退为 token 化墨色文字**而非药丸——它们原本没有基类 `rb-badge`，旧表现本来就是彩色文字，且 kv 值位置再放药丸会与状态徽标抢同一视觉通道。
- **第三次同型测试诚信教训（本条最重要）**：`tests/client-smoke.mjs` 的模块加载器写成"任何 specifier 都返回 React"，于是 `Modal`/`Button`/`Tag` 全部是 `undefined`、`h(undefined, …)` 退化成 fragment——**切片 1 在这套件里"绿"正是这个原因，277 项从未真正看见原生件**。至此三次同型：D26 假 connection 与真 `requestRejection(request)` 共享同一个错误契约；D32 假渲染器不经过真实 uSES 绑定；D33 假加载器把一切 specifier 映成 React。**共同机理：假件与真件共享同一个错误契约，于是假件永远为真。** 修法：假件只还原**真实 DOM 契约**（`type="button"`、`data-tone`、`role="dialog"`、`role="alert"`），**不发明真件没有的属性**（不造 `data-variant`/`data-size`，因为真件只把 variant 变成 CSS-module 类名）；样式与颜色的断言搬到浏览器门。被改动的 6 组 `client-smoke` 检查项已逐条记录在案，其中一条是"Escape 由 `Modal` 接管后页面不再注册 document keydown"。
- **机械替换优于人眼清单的一处硬证据**：切片 3 的 codemod 带"每处必须唯一匹配"断言，抓出人工 grep 漏掉的 2 处三元表达式类名（`claimableAnswer === true ? 'rb-badge-take' : ''`）——它们连基类都没有，删 CSS 后会彻底掉色。人工清单不可作为替换完备性的证据。
- **用户可感的能力变化（已批准，将向用户点名）**：平台 `Toast` **没有关闭按钮**（契约是自动淡出），切片 4 切过去后"手动关闭气泡"这一能力消失，关闭按钮的断言随之删除；控制器侧 `dismissToast` 不作废——它成为 `Toast.onDone` 回调。若用户要求保留手动关闭，用 `Toast.actions` 补一个"知道了"。
- **部署与验证**：每片都 `Copy-Item` 同步部署副本并核对哈希（切片 3 后 `B2105C5D0F044FBE0DD85FB71566621C40C75A2EF883A864D4DCDE741922A7CD`）；每片跑 `client-smoke`（277/277）+ `panel-render.e2e`（10/10）+ 多面探针（0 console/page 错误，`legacyButtonClasses`/`legacyBadgeClasses` 均为空、面板内无 600 字重）+ 卫生 6/6。生效方式同 D32（刷新即取新字节）。
- **切片 4：`Pill` 1 / `Checkbox` 1 / `StateDot` 1 / `Toast` 1 / `Input` 15。** 全文件原生件最终用量：`Modal` 1、`Button` 43、`Tag` 24、`Input` 15、`Pill`/`Checkbox`/`StateDot`/`Toast` 各 1。删 `.rb-input`、`.rb-dot*`、`.rb-check-inline`、`.rb-view*`、5 条 `.rb-toast*`，并删掉全文件**唯一的字面色值**（`rgba(0,0,0,.28)`）；`select`/`textarea` 平台无对应件，保留原生元素但框体度量按 `Input` 对齐（全部 token）。
- **Lead 三条裁定的执行与平台契约核实**：① `-run` → `tone:'success'`（运行中=健康活动态）；② 详情页 kv 行两个值回到**纯文本上墨**（新增 `.rb-ink-success`/`.rb-ink-info`，只用 token），不再是药丸；③ Toast 全量切平台件，`onDone: () => dismissToast()`（`dismissToast` 由"关闭按钮回调"变为生命周期回调，控制器契约不变），`dismiss` 文案键从 en/zh 两块 DICT 删除（`locale/*.json` 本来就没有它）。**平台契约实测**：`Toast.tone` **只允许 `'success'`**（错误态没有红色变体）→ 映射为 info→`success`+3500ms、muted→无 tone+3500ms、error→无 tone+**8000ms**；`Toast` portal 到 `body` 且**顶部居中**（旧自绘件是底部居中）——这是可见变化。
- **`client-smoke` 切片 4 改动 5 处 + 新增 1 处**：toast 替身改为忠实还原真实 DOM（`role="alert"` + 行内 `--dsh-toast-hold` + success 图标）；"关闭动作可及性"断言改为"`role="alert"` 且不持有任何关闭控件"；新增 `a refusal is the long-hold weight, not the short one`（8000ms）作为新契约下"拒绝 ≠ 轻提示"唯一可观测差别。**278/278**（277 + 1）。另：`Checkbox` 同样不透传 rest，过滤器复选框**丢掉 `name` 属性**——grep 确认无任何测试/探针按 name 选它，故无断言需改；这是平台件的第二个透传缺口，已记录。
- **Lead 独立复验（不采信实施者报告）**：`client.js` 开发树与部署副本 SHA256 逐字节相同（`BE843AF9A8197989…`），`index.js` 亦同（`CBAED579ACCB0AB2…`）；`client-smoke` **278/278**；`panel-render.e2e` **10/10 exit 0**（含"危险按钮计算色 == error token"`rgb(236,19,19)` 两条新断言）；`g-hygiene all` **6/6**；全 `client.js` 字面色值扫描 **0 命中**。
- **审计出的两处有意保留的手绘控件（例外，非漏网）**：`rb-node`（流程图节点，`client.js:1553`）——它是**可视化元素恰好可点**（选中节点），`Button` 的四种变体都自带控件度量与内边距，会破坏图表坐标布局；`rb-card-title`（`client.js:2749`，整卡宽的点击标题，`role="listitem"`）——卡片本身即控件，套 `Button` 会在卡头里引入第二层盒模型。两者都只用 token、有 hover/focus 面，且不被平台件覆盖。
- **可见证据**：四片共 6 张截图（`_ui_slice4-*.png`：看板/队列/要我拍板/新建需求/新建流程模板/角色管理）+ 切片 2–3 的多面探针读数（`legacyButtonClasses`/`legacyBadgeClasses`/`legacyControlClasses` 全为空、面板内无 600 字重）。**仍缺**需求详情 / force / 删除确认三个对话框与详情视图里 `Input`/`StateDot`/`Toast` 的实时截图：生产库 0 条需求且不许写，已派专职子会话用**开发存储临时实例（3110，DB 落 `rollout/`）**造数补齐，不碰 3080/3109 与生产库。
- **用户裁定（三条，2026-10-04）**：① 接受 `Toast` 无手动关闭（平台契约是自动淡出，位置改为顶部居中）；② 角色行文案收敛成两态；③ 补齐开发存储实例的视觉取证。
- **角色行文案（用户裁定后实施）**：由 `未完成: 0 在线 0 · 空闲 0 · 执行中 0` 改为 **`{n} 个未完成 · {m} 人在线`**，有人在执行时才追加 ` · {k} 执行中`，无人时为 **`{n} 个未完成 · 暂无人在线`**（无法统计时保留 `无法统计在线状态`）。**`空闲` 键被删除**：它是 `在线 − 执行中` 的派生值，四个计数里那个冗余项正是"像调试输出"的根源。两个 `roleHolders`/`roleIdle` 旧键随之删除，en/zh 成对替换为 `roleOpen`/`roleHoldersCount`/`roleRunningCount`/`roleNoHolders`；`client-smoke` 那条只断言"含这两个词"的检查项改成**断言两态文本且不再出现 `空闲 0`**（仍 278/278）。
- **视觉取证（用户裁定后补齐）**：开发存储临时实例（**3110**，`rollout/ui-dev.overlay.yml` + `rollout/ui-dev-board.db`）造数，拍到四个面——需求详情、被门禁拒绝的就地提示、**force 对话框**、**删除确认对话框**（`_ui_dev-detail.png`/`_ui_dev-blocked.png`/`_ui_dev-force.png`/`_ui_dev-delete.png`）。取证目标达成：三个对话框都是平台 `Modal`（`role="dialog"`，白卡/28px/海拔/遮罩模糊），**Escape 关闭力对话框与删除对话框均实测通过**（顶层 Modal 自己的路径），危险按钮在对话框 footer 里保持红墨，平台 Toast 为顶部居中横幅，kv 行的 `可接手`/`推不动` 为墨色文字（裁定 ② 的形态）。
- **`--patch` 位置陷阱（值得记的启动契约）**：`--patch` 必须出现在 app 参数之前；`dsh web --patch …` 里的裸词 `web` 会被展开成 **profile 名**，于是 `--patch` 变成 app 参数并被拒绝（`unknown option '--patch'`）。正确形式：`node --import tsx/esm apps/cli/src/bin.ts --profile web --patch <overlay> --no-open --port 3110`。这条早在 `A1-verification.md:24` 记录过，本轮由 Lead 独立复现一次。
- **overlay 审计**：被杀子会话留下的 `ui-dev.overlay.yml` 我逐条核过 S2 四条硬条件后才复用——它只按 id 覆盖 `storage-sqlite` 的 `path`（条件 3 要求整条替换，故重述了 `journalMode`），**不碰域路由**（条件 1 的域键保持 `requirement_board`），未引入裸行（条件 4），`importLegacy` 走默认 false。`!!js` 求值经 `--dump-config` 与"DB 真的落在 rollout 下"两重实证。
- **生产库未被写入（硬证据）**：取证前后生产库 `requirements = 0`、`templates = 1`、`queues = 0`；`roles` 由 2 → 3、`execSync.ignored` 由 83 → 456 都是**活宿主 3080 的运行时效应**（该宿主观测到我派的子会话事件、会话按预设声明角色），不是本轮的写入。开发库 4 条需求全部只存在于 `rollout/ui-dev-board.db`。
- **新增常驻仪器 `tests/verification/ui-dev-shots.mjs`**（`<base> <token>`，无凭据 exit 2）：自己造数、驱动真 UI、断言三面为平台 Modal 且 Escape 可关，**16/16 exit 0**。仪器本身踩到并修正了一个断言错误：门禁拒绝在 wire 上映射为 **HTTP 409**，浏览器把任何 4xx 记成 console error，所以"页面零错误"是个**做不到也不该断言**的目标；正确断言是"**唯一被拒的命令、唯一的 console 行，都是它自己故意挑起的那一次 `blocked-by` 推进**"。另：因为仪器自己的外部写入会让页面快照 stale，它在驱动前**重载页面**消除该竞态，而不是忽略冲突。
- **一处未修的文案债（报给用户，未擅自改）**：门禁拒绝的 Toast 是"本地化标题 + 原始英文主机细节"的混排（`被未完成的需求挡着。( "req_…" is blocked by unfinished requirement(s): req_…)`）。`client-smoke` 有一条检查项明确要求携带原始细节，所以这是**有意设计**，但读起来是混语；要不要本地化或折叠由用户定。

## D34 流程模板管理的形态裁决：追加版本（存量不动）、归档、模型可改可删、面板表单

- **用户表态（先于本条）**："修改模板我希望不影响存量模板"，随后对几个取舍答"按推荐来"；本轮只改设计与本文件，`host/*.js`、`client.js` 一行未动。
- **机制裁决：追加版本（机制 1）**，否决"就地改模板"与"新增模板版本表"。模板顶层字段永远是"最新版"（读法与今天同构），历史版进 `versions`（有界 20 条）；需求加可选字段 `templateRevision` 钉住自己跑的那一版。**改模板 ＝ 追加版本，完全不碰 `requirements`**；把需求迁到新版是独立动作，且必须先列出受影响需求（"全部迁移"要 `force`）；裁剪历史版本被任何需求钉住即拒（`in-use`）。
- **只加可选字段、不升域版本号**：`requirementBoardDomain.version` 仍是 2——这套介质按精确版本戳校验且没有迁移，升号＝现有库整库打不开；加可选字段有现成先例（`images`，`host/domain.js:22-26`）。代价如实记录：**只能前进不能后退**（旧构建的 `.strict()` 会拒绝带新字段的记录），回滚必须连数据一起回（口径同 R-ROLLOUT.md §9.1）。
- **存量零迁移**：没有 `revision`/`versions` 的模板读作"第 1 版、无历史"，没有 `templateRevision` 的需求读作"钉在第 1 版"——**不需要任何回填写入**；首次追加版本时才把当时的顶层字段快照进 `versions`。
- **Q3 归档**（硬删的常规替代）、**Q4 模型可改/可归档/可删**（删除必须带影响清单 + 需求侧 `retemplate` 留痕；**裁剪历史版本不进工具面，面板独有**）、**Q5 面板表单 + 只读流程图预览**（不做拖拽）。
- **一处设计细节（可推翻，已向用户点名）**：模板级 `name`/`description` 原地改（不动 `revision`、不进历史），**只有节点数组的变动**才追加版本。若要求"连改名也保留旧名"，改成一律追加版本即可。
- **改动面（实现时最该先看的一条）**：读侧要引入 `templateAtRevision(template, revision)`——`advance`/`complete` 的节点判定、`recomputeNodes`、快照的 `flow` 投影、prompt 段都必须取"该需求钉住的那一版"，不能再直接用顶层 `nodes`。这是本次唯一有全局影响的改动点。
- **落盘**：`DESIGN.md` §11（11.3–11.10 整段改写，§11.10 由"待决"转为"已裁决"）；看板上该裁决以决策需求 `req_c2c26f95db` 呈现（决策类需求只能由人推进）。
- **只读独立评审（同日）抓到三条阻断**，已全部落盘：① 新建需求必须写**当前** revision（否则模板到 v2 后新建的需求会被读成钉 v1、继续跑旧流程）；② 两条改绑路径（`updateRequirement{templateId}`、`deleteTemplate` 的 `force` 改绑）必须把钉子重置为目标模板当前版（否则需求永久 `invalid-transition` 或静默用错版本）；③ `versions` 溢出必须**拒绝**（第 21 版报 `invalid-transition`），不能照 `maxExecutions` 的先例丢最旧——执行观测丢了无所谓，模板版本丢了违反 I2。另有五条应修（读侧解析点清单改为可 grep 规则、`listRequirements` 经 `summarize` 需一并加字段、裁剪的"被钉住"沿用删除的引用集合、模型侧改名走 `revise`、钉子悬空时开域修复）与四条可选项一并并入 §11。

## D35 宿主侧落地、两次扰动验真，与"派发归属"不兼容

- **落地范围（看板 req_15b6cfb671）**：`host/domain.js`（`revision`/`versions`/`archived`/`updatedBy`/`supersedes`/`changes` 与需求的 `templateRevision` 全部可选，**`requirementBoardDomain.version` 实测仍为 2**）、`host/templates.js`（新增 `templateAtRevision`/`templateNodeView`/`templateView`）、`host/service.js`（六个新方法、写入点①②③、读侧解析、`#repairDanglingPins`、`#retemplateEntry`）、`host/tools.js`（工具面加 `revise`/`migrate`/`archive`/`clone`，**不加** `prune`/`metadata`/`preview`，`get` 投影掉 `versions`/`changes`）、`host/http.js`（`template.get|revise|metadata|migrate|prune|archive|clone`）。新增 `tests/templates-revision.mjs` 316 条断言（json + sqlite 双后端）。面板与真浏览器门仍属 req_574df2066a / req_8ab885146f，尚未开工。
- **Lead 独立复验（不采信实施者报告）**：新套件 316/316 exit 0；既有 11 个套件与 `client-smoke` 314/314 全绿；`g-hygiene all` 5/5；`git diff --check` 0；新建需求确实写当前版、两条改绑路径确实重置钉子（`host/service.js:1563`/`:2433`/`:3259`）。
- **反向验证（两次扰动；缺此步等于没验）**：① 删掉 `createRequirement` 的钉子写入（模拟评审抓到的 B1）→ **308/316，8 条红**；② 让 `pruneTemplateVersion` 忽略"被钉住"→ **3 条红**。两次都逐字节还原，`host/service.js` SHA256 回到 `1BC3770687F2811AA85B36791ECEF547A55636447706D82A7B8F934B59037237`。**"断言会红"这条读数比"316 全绿"更有价值**——D26/D32/D33 三次同型教训都出在没人验过假件能否变红。
- **一处平台不兼容（新增，值得记住）**：看板 `delegate` **拒绝**把需求派给 harness 的 continuable 子会话——报 `session "session-3782…" does not own session "ca1c9de9…"`，而平台自己的子会话记录写着 `parent=session-3782…`（本会话）。**裁决：不派发**（按"拿不到归属就显式报错、不静默换路"），改为 Lead 持锁 + 子会话只当实现工人，看板每一条写仍由 Lead 做。代价如实记：子会话没有独立角色，**其产出必须由 Lead 自己复验**（上面两次扰动就是这笔代价的兑付）。要走第 7 条派发，得先修看板的归属判定，或由人在面板上派。
- **固化四个实现判断点（可推翻）**：① `prune` **先判 revision 合法性、再判 `in-use`**（否则裁剪当前版会错报 `in-use`，与失败码表冲突）；② `changes[].revision` ＝ 该次写入**留下的当前版号**，故裁剪留下的痕迹会重复当前版号；③ 迁移清单里的 `clearedChecks` 是**布尔**（该节点勾选是否会被清空），不是清单或计数；④ 归档模板：显式点名新建、以及"绑定真的变化"的改绑拒绝，**已在跑的需求照旧可读可推进**，`migrate`/`prune` 一律拒。
- **顺手补上的两条设计项**：`deleteTemplate` 现在拒删 `config.defaultTemplateId`（G4），并把 `force` 改绑的每条需求写 `retemplate(force:true)` + `updatedAt`/`updatedBy`（G5）；两条改绑路径的历史形状抽成 `#retemplateEntry` 统一，该方法因此多一个可选 `actor` 参数。
- **本地跑测试需要的一处链接**：`bundles/dsh-requirement-board/node_modules` 现为指向 `.artifacts/requirement-board/node_modules`（zod + 4 个 storage 包）的 junction，git 忽略它；没有它，本 checkout 里任何 import 宿主的套件都起不来（`ERR_MODULE_NOT_FOUND: zod`）。它是开发期设施，**不进部署副本**（部署走 `peerDependencies`）。不要时 `Remove-Item` 撤掉即可。
- **锚点债（如实登记）**：g-anchors 只验"文件存在、行号在范围内、该行非空"，正文里写死的行号会随代码插入衰减——本次 600 行插入使约 50 处引用失灵，其中 **2 处指到空行**才被抓到（`DESIGN.md:430 → host/service.js:2728`、`G-CHECKLIST.md:22 → host/service.js:1664`）。本轮把被抓到的、§11 自身的、以及 `ROLE-DISPATCH.md`/`G-CHECKLIST.md`/`OPTIMIZATION.md`/`README.md` 的同类引用一并**按内容重定位**（同一批文档工人执行）。**更稳的做法（未采纳，留作提案）**：正文引用符号名而非行号，或让 g-anchors 对可定位引用做内容核对——否则每次大改都要重扫一遍。
- **待办**：宿主改动要**重启一次 `dsh web`** 才生效（父需求 req_d8779c1055 的"发布上线"节点负责，未在用户不知情时重启）；面板侧（req_574df2066a）与验证侧（req_8ab885146f）尚未开工。

## D36 角色管理六处修正（含 D35「派发归属不兼容」的修法）

- **背景**：用户要求"检查需求看板的角色管理逻辑"，审计列 F1–F6 六条，用户指示"进行优化"，六条一并落地。
- **F1 归属端口不再把"判不了"压成"不是我的孩子"**（D35 line 294 那条 live 缺陷的修法）：`false` **只对目标有活 Agent 时**下；目标没有活 Agent（continuable 子会话按需物化）→ `undefined` → 放行 + 具名 warn 一次；目标有活 Agent 但运行期 owner 已被父会话 resume 换掉 → 读**目标自己会话头的 `header.parentSession`**（平台记录的创建关系）判定：等于调用方放行、等于别的会话拒绝、缺失拒绝（`index.js` 的 `createOwnershipPort`）。理由：D35 那次拒绝的真实状态是"平台谓词判不了"，把它压成拒绝等于让 resume 过的会话永远派不出去；D35 的"不派发"是当时唯一不违"不静默换路"的选择，现在有了能判的来源。代价如实记：**目标 id 根本不存在（真幽灵）也从拒绝变成放行**，与"注册表不可用"同级降级、同由具名 warn 记账。
- **F2 未登记角色改为派生可见**：`unregistered` = （活会话解析到的 id ∪ 需求 `role` 引用到的 id）− 已有记录；每条需求新增派生字段 `roleUnregistered`，面板角色徽标标警。**需求引用不再算建档**：§3.2 原表把 `observed` 写成"create/update/delegate 引用了库里没有的 id"是文档漂移——代码里 `observed` 只表示**预设 id 兜底**；`roleUnregistered` 此前只写在 §3.4，代码里根本不存在（同一处漂移的产物）。
- **F3 prompt 与列表同口径**：`promptLine` 在记录 `duties` 为空时改用预设声明里的职能（与 `#present` 的 `dutiesMissing` 同一规则），不再出现"列表说可路由、prompt 说无法按职能路由"。
- **F4 兜底值加格式闸**：预设 id 兜底前先过 `ROLE_ID_RE`（平台只要求预设 id 非空，`packages/preset/agent-preset-registry/src/index.ts:83`）；不合形 → 该会话无角色 + 按 id 各 warn 一次，不记一个谁也路由不到的角色。
- **F5 派发期间不许改路由**：`delegatedTo !== null` 时把 `role` 改成一个**不同**的 id → `conflict{delegated-role}`（结算必然抹回 `roleBefore`，接受一个必然被擦掉的写就是把降级留给用户看）；**原样写回仍是零变化**——面板保存别的字段时总会带上 `role`，所以这条必须放行。非派发状态下改 `role` 现在补一条 `update` history（`role "a" -> "b"`）。
- **F6 写被拒就收回刚铸造的临时角色**：需求写链拒绝（CAS 版本不符、并发委托、锁变动）后 `delegate` 重读需求，**只有 `role !== tmp-<任务id>`**（证明写没落地）才删该行；删失败只 warn，随后原样抛原错误。启动 sweep 仍是兜底，不再是第一道防线。
- **证据**：`tests/roles.mjs` **260/260**（新增 3 案 × 2 后端）、`tests/delegate.mjs` **372/372**（新增 2 案 × 2 后端 + 适配器案扩到 15 条/后端）、`tests/dispatch.mjs`、`tests/client-smoke.mjs`、`g-receipts` 5/5、`g-anchors` 3/3 全绿。F1 的正向证据是"运行期 owner 被换掉后仍按会话头判定"（`caseOwnershipAdapter`）。**未验证**：真机上"按需物化的 continuable 子会话"这条仍没在受控 profile 里真跑（与 D35 的未验证项同源，需用户点头才碰 `~/.dsh`）。
- **锚点**：本次只把**自己改动的代码**的引用改成符号名（`createOwnershipPort`、`resolveOwn`/`promptLine`/`#present`、`#assertOwnedTarget`），没有全量重扫——D35 登记的锚点债仍在，正文里那些 `host/service.js:NNNN` 又会因本次约 40 行插入各差几十行。
