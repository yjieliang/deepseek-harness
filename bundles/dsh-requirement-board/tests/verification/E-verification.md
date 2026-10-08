# V7：独立验证 E（执行同步 / 鉴权门 / 读放大 / 挂载零写 / F1–F5 复核）

- 任务：task-23「V7：独立验证 E」，作者 `storage-migration`（task-19）
- 验证者：`composition-verifier`（角色 证伪/独立复核），与作者不同会话、不同实现路径
- 结论：**E 的核心断言全部成立**（旧 `rev` 不因观测推进、鉴权门按请求事实判定、合并读放大 ≤1 帧且 0 可关、挂载期写次数 0、F2/F3/F4/F5 已修）；**F1 只修了入口，未修存量** —— 发现 2 处缺陷（`byKind` 词表被撑大、含非法 `kind` 的记录会让整块看板**打不开**），2 条读数在两个后端一致。

## 0. 读数归属的 revision（D19 纪律）

本报告所有读数都取自下列哈希的同一份代码，验证前后未改动任何实现文件。

| 文件 | SHA256 |
| --- | --- |
| `host/service.js` | `AEF74B2A000CDEB8221AEBD709F83BF0865CA3D0B9B7A3E60679BB088D852BB1` |
| `host/http.js` | `69BE916AF23CA5554FBC461DAFD34A27F652589702A43EDA0DFC4E258D250536` |
| `host/runs.js` | `3F5656160961EFE4B5B8CC1C9F026042AAB3F1D68E9BCF994B5893EB60FEF924` |
| `host/config.js` | `20CA54478FBCE38E984E52B4013E7CBA0BCA45B506B9080EE565E0862062DBA0` |
| `host/domain.js` | `188EACCC7876C6A80EABD2E8C2196F1B9B4F6554A9336C8FC8C492040D6476BA` |
| `index.js` | `89ED1FCDEB2EB615D11F0C9B98FAC9B36D37863B9188C5E02AB411436BA903A0` |

27 文件 D19 摘要（`tests/verification/b-digest.mjs`，验证结束时刻）：

```
694bba17-89ed1fcd-5c8d3aee-20ca5447-be0a7cba-188eaccc-48e3c080-69be916a-7460d4f9-4b06a18f-3f565616-aef74b2a-3dcb6c4e-a22f0d5a-a5bf6739-e3a9261c-24015b2e-520cfd9e-4d765a1c-afb4b2d0-1b4c3b22-c230a354-b2ba560e-dbd75745-42fd0707-1dcfaa61-656242c4
```

与 V6 的 28 文件摘要相比少了 `tests/_rb-debug-smoke.mjs`：**F5 的残留文件已删除**，摘要计数从 28 回到 27。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `tests/verification/E-verification.md` | 本报告 |
| `tests/verification/e-verify.mjs` | 服务/域层仪器，152 断言（json）/150（sqlite），12 节 |
| `tests/verification/e-composition.mjs` | 真实 `index.js` 组合仪器，55 断言，8 节 |
| `tests/verification/live-auth.mjs` | **不改**作者 `tests/live.mjs` 的包装器：取引导 token 换会话 cookie，再原样 import 作者套件（§11） |
| `_e_json.txt` / `_e_sqlite.txt` / `_e_composition.txt` | 原始输出（保留，见 §10） |
| `_e_red_rev.txt` / `_e_red_coal.txt` / `_e_red_http.txt` | 三条「变红」对照的原始输出 |
| `_e_author_{runs,loader,live}.txt` / `_e_digest_after.txt` | 作者套件与 D19 摘要原始输出 |
| `_e_live_3108.txt` / `_e_live_3108_nocred.txt` | 临时实例 3108 上的 live 收口（带凭据 35/35、无凭据 2/8） |

复现命令（仓库根目录）：

```sh
TSX_TSCONFIG_PATH=C:\code\deepseek-harness\tsconfig.json node --import tsx/esm \
  .artifacts/requirement-board/tests/verification/e-verify.mjs
RB_E_BACKEND=sqlite … e-verify.mjs
… e-composition.mjs                      # RB_E_INDEX=<组合根> 可换被测组合
… tests/runs.mjs ; … tests/loader.mjs    # 作者套件
```

仪器都只用 `makeTempDir` 建立临时存储根；不开端口、不建会话、不写 `~/.dsh`。

## 2. 点名五条的判定

### 2.1 执行同步写不推进 `rev` —— 证实（含点名用例）

一条被 `claim` 的活（`rev=2`、`execRev=0`、`history=2`）之后，注入 **5 条 `subagent/start` + 5 条作业注册**（10 条互不相同的观测）：

```
ok   ten execution events wrote ten execRev steps
ok   the record revision did not move
ok   updatedAt did not move
ok   history did not grow
ok   a transition holding the pre-observation revision still commits   ← 点名用例
ok   the same revision is stale after the transition
ok   a flow transition leaves execRev alone too
```

- 10 条观测各写一次：`execRev` 0 → 10；`rev` 仍为 2，`updatedAt`/`history` 不动。
- 拿**观测之前的 `rev`（2）** 作 `expectedRev` 调 `transitionRequirement` **仍然成功**（推进到 `n2`）；同一 `rev` 再用一次得到 `conflict`，随后 `rev=3`、`execRev` 仍为 10 —— 观测数据没有污染业务并发控制。
- 该用例可被变红（§7 对照 A）。

### 2.2 鉴权门（含「传错形状就 400」的回退对照）—— 证实

真实组合（`index.js` + 真实 `webServer` 存根 + 真实 `connection` 存根）注册出的路由处理器被逐条驱动：

| 请求 | 期望 | 实测 |
| --- | --- | --- |
| 无凭据 | 401 `unauthenticated` | 401 ✓ |
| 有效凭据 + 跨站 `Origin` | 403 `forbidden-origin` | 403 ✓ |
| 有效凭据 + 环回 | 200 | 200 ✓ |
| 有效凭据 + 可信 `Origin` | 200 | 200 ✓ |
| 只有 `Origin` / 只有 `Host` | 401 | 401 ✓ |
| `?token=<有效值>`（无 cookie） | 401 | 401 ✓ |
| 空 cookie / 伪造 cookie / 过期 cookie | 401 | 401 ✓ |
| 另一个用户的有效凭据 | 200 | 200 ✓（这是**认证**，不是授权） |
| 有效凭据 + 不可信 `Origin` | 403 | 403 ✓ |
| `/health`、`/events` 同样过门 | 401 | 401 ✓ |

形状对照（防回退）：

```
ok   the door was handed the request object once per attempt
ok   the door never saw a wrong-shaped argument          # wrongShape === 0
ok   the argument is the very request the handler received   # 同一对象，非副本、非 headers 袋
ok   the stub treats a request fact object as a request
ok   the stub treats a bare header bag as the wrong shape (400)
```

我的 `connection` 存根读的是 `request.headers` 且要求 `request.url` 是字符串；喂它一个**裸 headers 袋**会返回 `400`，而路由对 `400` 不做拒绝判定 —— 所以一旦实现回退成 `requestRejection(req.headers)`，`无凭据 → 401` 会立刻变成 `200`。§7 对照 C 证明了这一点（10 条红）。

### 2.3 合并读放大 —— 证实（0 对照为真）

10 条执行事件在一个 **500ms** 窗口内（实测突发 61ms）：

```
ok   ten execution writes delivered exactly one frame        # 1 帧
ok   the merged frame carries the newest revision
ok   a transition is delivered without waiting for the window
ok   the transition is visible immediately                   # nodeId -> n2
ok   the queued execution frame is still delivered afterwards
```

- 一次执行写会产生**两条** `domain/changed`（记录 + 全局 revision），所以「无合并」的 0 对照是 **20 帧**：
  `ok sseCoalesceMs 0 forwards every domain change`（§7 对照 B 把它变红为 20 帧）。
- 定义性写入不被窗口吞掉：合并期内发起 `transition`，帧立即送达（`framesBefore → framesAfter` 增长），记录状态立刻可见，未送出的执行帧随后仍会送达（不丢）。
- 说明：合并是**按窗口**的，突发耗时超过窗口时会按窗口数各出一帧——这是窗口语义，不是漏合并。

### 2.4 挂载期写次数为 0 —— 证实（写故障注入）

`createMountContext` + **拒绝一切写入的存储**（任何 `table.put/update/delete`、`global.set` 都抛错并计数）：

```
ok   mounting with both registries succeeds against a store that refuses every write
ok   mounting with both registries attempted no write          # 0 次
ok   mounting with both registries logged no warning
ok   the mount registered the execution listeners              # subagent/start + subagent/end
ok   the mount registered the browser route once
ok   the mount registered the prompt context once
ok   the mount registered the board tools
ok   mounting with no registry at all attempted no write       # 缺 jobs/agents 也不写
ok   and still attempted no write for the derived gap
ok   a composition without registries warns exactly once about it
```

两条腿都是 **0 次写入**：jar 齐备时 mount 只注册效果；缺注册表时 `assertExecutionPorts()` 只警告一次、`sync` 视图按派生报告 `gap`，**同样一次都不写**。真实完整 Cordis 组合侧另有字节级复核：`ok mounting a board over an existing medium writes nothing`（remount 前后介质逐字节相同）、`ok the remount did not bump the record revision`。

### 2.5 F1–F5 复核 —— F2/F3/F4/F5 证实，**F1 部分证伪**

| 项 | 判定 | 证据 |
| --- | --- | --- |
| F1 非法 `kind` | **部分证伪** | 入口已堵：`claim` 拒绝（`forbidden/invalid-kind`）、池子不收录、`claimable=false`、`advanceable=false`；**但** `stats.byKind` 仍被撑大成 `{"task":0,"decision":0,"epic":1}`，且**重启时整块看板打不开**（`invalid-record`）。见 §3 |
| F2 决策不进「Delegated to you」 | 证实 | 真实组合装配文本按节解析：`ok the delegated decision is not in the delegated section`、`ok the delegated decision is in the human section`、`ok the decision appears exactly once in the whole prompt`、`ok the named session still cannot claim its decision` |
| F3 决策诊断顺序 | 证实 | `checklist`/`block`/`unblock`/`transition` 四种操作对决策全部报 `forbidden/decision-task`（服务层），真实组合文本亦为 `decision-task` |
| F4 空/同值 update 零写 | 证实 | 空 patch、同值 patch 都不动 `rev`、`updatedAt`、`history`、全局 revision，**介质逐字节不变**；陈旧 `expectedRev` 仍 `conflict`；真改一次 `rev+1` |
| F5 残留文件 | 证实 | `tests/_rb-debug-smoke.mjs` 已不存在；D19 摘要 27 文件（不再含它） |

## 3. 发现（两个，必须在收尾前处理或明确接受）

### F-E1 统计词表未闭合：`stats.byKind` 随存量非法 `kind` 撑大

- 读数（json 与 sqlite 一致）：`FAIL the statistics vocabulary stays closed — {"task":0,"decision":0,"epic":1}`
- 位置：`host/service.js` 统计处 `byKind[kind] = (byKind[kind] ?? 0) + 1`（约 2770 行），对记录的 `kind` 不做闭集裁剪。
- 影响：面板统计出现 `epic` 这类从未定义的键；`kind` 的闭集（`task`/`decision`）在**读路径**上并未真正闭合，与 F1「口径唯一」的意图相悖。
- 建议最小修：统计与任何按 `kind` 分组的读路径都先走 `kind === 'decision' ? 'decision' : 'task'`（与 `promptContext`、池子、`dispatch` 的判定同一口径），或在 `healRevision` 同层做一次存量归一。

### F-E2 标签（严重）：一条非法 `kind` 记录会让整块看板打不开

- 读数（json 与 sqlite 一致）：

```
FAIL reopening the board accepts the record instead of failing the open —
  invalid-record: domain 'requirement_board': stored record 'req_…' in table 'requirements' does not match its schema
```

- 路径：`host/domain.js` 的记录 schema 仍为 `kind: z.enum(REQ_KINDS).optional()`，`bootstrapRequirementBoard` 的加载/校验在**打开域**时抛错。
- 影响：F1 的第三部分（「重启不 `invalid-record`」）未达成，而且是**可用性**问题——存量里只要有一条越界 `kind`（旧版本写入、手工改库、外部工具写入），整个插件及面板都起不来，而不是把该记录隔离/归一。
- 建议最小修：schema 对 `kind` 放宽为字符串并在读路径归一（`decision` 之外一律 `task`），或在 open 后的修复步骤里把越界值改写为 `task` 并记一条 warn，而不是让 `parse` 阻塞打开。

## 4. 其余方向的判定

| # | 方向 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | 旧 `rev` 后 `transition` 仍成功 | 证实 | §2.1 |
| 2 | 鉴权门与 `requestRejection(request)` | 证实 | §2.2 |
| 3 | 合并读放大 + 0 对照 | 证实 | §2.3 |
| 4 | 挂载期写次数 0 | 证实 | §2.4 |
| 5 | F1–F5 | F1 部分证伪，其余证实 | §2.5、§3 |
| 6 | 无锁观测 `ignored+1`、重放不写、`output` 不落库 | 证实 | `ok a lockless observation is ignored, not stored`、`ok the ignored counter moved`、`ok the board revision did not move for a counter`、`ok a repeat of the same start writes nothing`、`ok a repeat of the same terminal status writes nothing`、`ok an output event stores nothing and is not "ignored"`、`ok the medium is byte-identical after an output event` |
| 7 | 缺 `jobs`/`agents` 警告恰好一次 + `sync.gap` | 证实 | `ok the missing ports are named in a stable order`（`['jobs','agents']`）、`ok the warning is emitted exactly once`（三次调用仅 1 条 warn）、`ok the derived view reports the gap without a stored mark`（`reason: missing-registry-jobs-agents`）、`ok a missing registry does not move the gap counter` |
| 8 | `maxExecutions` 截断 + `truncated` | 证实 | `ok the unit list is bounded to maxExecutions`（6 条进 5 条留）、`ok the record is marked truncated`、`ok the oldest unit was dropped`、`ok the newest unit was kept` |
| 9 | `claim` 期间对账 `jobs.list(owner)` | 证实 | `ok reconciliation added the live job the stream never saw`、`ok reconciliation reports the unobserved settlement`、`ok the stored gap marks the lost observation`、`ok it left the unobserved unit rather than inventing an outcome`、`ok claim reconciliation folds in a job registered before the claim`、`ok a broken registry does not fail the claim` + `ok the gap counter moved once` |
| 10 | 每条新注册各有 disposer、dispose 后不写 | 证实 | `ok the route disposer ran with the fiber`、`ok the job subscription was disposed with the fiber`、`ok the board tool is gone after disposal`、`ok the prompt context section is gone after disposal`、`ok no execution write landed after disposal`（介质逐字节相同）、`ok replaying a job event through the disposed subscription is inert`；`ok closing a board whose queue write was refused did not reject a late write` |
| 11 | `?role=` 精确集 + `me`/`claimable` 组合优先级 + 未知 role 口径 | 证实 | 服务层：`ok the role filter returns exactly the routing set`、`ok status open narrows it to the unfinished record`、`ok claimable intersects the role filter instead of widening it`、`ok the other role returns only its own record`、`ok an unknown role is an empty set, not an error`；HTTP 层：`ok ?role= returns exactly its set through the route`、`ok role and claimable intersect exactly`、`ok a role the session cannot take yields the empty intersection`、`ok an unknown role is an empty set through the route`；口径记录：未知但格式合法的 role → **空集、不报错**；格式非法（`'role e1!'`）→ `invalid-role` |
| 12 | 队列顺序与 `head` 同源、head 被第三方上锁 | 证实（含一个「不可达」结论） | `ok the queue row keeps the reservation order`、`ok the head is the first stored item`、`ok the unqueue receipt head matches the snapshot source`、`ok the snapshot agrees with the receipt`、`ok clearing a tail item keeps the head`；「head 被第三方上锁」这个状态**在 API 上不可达**：`ok reserving a record another session locked is refused`（`conflict/locked`）、`ok reserving a record another session reserved is refused`（`conflict/reserved`）、`ok a reserved item is never claimable by another session` |
| 13 | `executionSync:false` 如实报告并可在重开后恢复 | 证实 | `{"enabled":false,"gap":false,"syncedAt":null,"reason":"execution-sync-disabled"}`、`ok no observation is stored while sync is off`、`ok reconciliation says sync is off`、`ok settling is a no-op while sync is off`、`ok the sync view reports enabled after reopening`、`ok observations store again after reopening` |
| 14 | 作者 `tests/loader.mjs` 绿 | 证实 | 53/53（另有 `tests/runs.mjs` 308/308） |

## 5. 观察（非缺陷，但值得写进收尾说明）

1. **队列不校验调用者自己的锁**：一条已被本会话上锁的记录仍可被本会话 `queue`（`ok a target this session already holds the lock on is accepted into its own queue`），于是队列头可以是「被自己锁住」的项；`unqueue` 撤回预约不影响锁（`ok the redundant reservation can be taken back without touching the lock`）。语义上无害，但面板会把「正在执行」的项同时显示为「排队中」。
2. **单纯字段编辑不写 history**：`update` 改标题后 `rev+1`、`updatedAt` 变化，但 `history` 长度不变；只有门禁链、锁等动作追加历史。E 未把 history 作为判据，记录在此避免误读。
3. **自愿 `release` 不结算执行单元**：`settleExecutionUnits` 只在撤销委派（service.js:1836）与 `disposeSession`（2099）被调用；`release` 后仍 `running` 的单元保持 `running`，直到下次 `claim` 时对账（那时若作业已不在注册表就标 `gap`）或 72h 陈旧。想立刻收敛的话，可把 `release` 也纳入结算触发点。
4. **无 `connection` 时的回退门更窄**：路由退回自己的 `Origin` 检查后，**完全没有 `Origin` 头**的请求会被放行（`ok the fallback serves a request with no Origin at all`）。这是插件边界内能看到的极限，注释里已写明；生产组合应始终提供 `connection`。
5. **一次执行写在域上产生两条变更**（记录 + 全局 revision）：合并窗口对二者都生效，所以「无合并」的帧数是 2×事件数。这不是重复写，但读放大口径要按此计。

## 6. 变红对照（3 条，均可精确复现）

三条对照都按 D19 纪律做：先取基线哈希 → 复制整块看板到 `.artifacts/_red-e-*` → 只改副本一处 → 用 `RB_E_SERVICE` / `RB_E_INDEX` 指向副本重跑 → 记录红点 → 删除副本 → 复核基线哈希未变。

| 对照 | 改动（仅副本） | 红点 |
| --- | --- | --- |
| A 写观测也推 `rev` | `#mutateExecutions` 的 `draft.execRev = …+1` 后追加 `; draft.rev = (draft.rev ?? 0) + 1` | 4 条红，含点名用例：`FAIL the record revision did not move — rev=12 held=2`、`FAIL a transition holding the pre-observation revision still commits — conflict/`、`FAIL the transition is the only thing that moved rev — rev=12` |
| B 合并窗口失效 | `publishDomainChange` 的 `if (this.#executionWrites === 0 \|\| sseCoalesceMs <= 0)` 改为 `if (true)` | `FAIL ten execution writes delivered exactly one frame — 20 frames (immediate 20, burst 64ms)`、`FAIL the merged frame carries the newest revision` |
| C 门被喂 headers 袋 | `host/http.js` 的 `connection.requestRejection(req)` 改为 `…(req.headers)` | 10 条红：`FAIL a request with no credential is refused 401 — 200 …`、跨站 403→200、`/events` 401→200、以及 6 条绕过用例全部 401→200（实现里 `400` 不构成拒绝，整扇门被打开） |

对照结论：**A 直接证明 §2.1 的读数是活的**（不是恒真断言）；B 证明「≤1 帧」不是空话；C 证明鉴权门只要传错形状就整体失效——正是点名要防的回退。

## 7. 作者套件读数

| 套件 | 读数 |
| --- | --- |
| `tests/runs.mjs` | 308/308 ✓ |
| `tests/loader.mjs` | 53/53 ✓ |
| `tests/live.mjs`（同哈希源码、临时实例 3108） | **35/35**（携带浏览器会话凭据）／2/8（无凭据，见 §11） |

**已收口**：5:30 那次打在 3080 上的 34/35 是**宿主旧构建**的读数（旧构建写 `schemaVersion: 1` 的 `~/.dsh/profiles/web/requirement-board/requirement-board.json`）。随后按 Lead 指令用**当前源码**在临时实例 **3108** 重跑：`tests/live.mjs` 一个字未改，**35/35** —— 包括点名要收口的 `a done requirement is excluded from the open filter`（`ok`）。无凭据时它只得 2/8（除清理动作外全部 401）。命令、归属与逐条读数见 §11。

## 8. 未验证项与原因

| 未验证 | 原因 |
| --- | --- |
| `requireLockForExecution: true` 端到端（真实 `tools/pre-execute` 瀑布拒绝一次工具调用） | 只验证了纯函数判定矩阵（`executionGateDecision`：执行类工具无锁→拒绝、有锁→放行、非执行类/空会话/无名→放行）与「关闭时不注册门」；真实组合的 waterfall 拒绝需要驱动 agent 工具栈，超出本轮边界 |
| 真实 `/events` 路由上的合并帧 | 只验证了它同样过鉴权门（401）；帧序列在服务层用转发域代理验证（§2.3），没有开流式 socket |
| 平台真实 `connection.requestRejection` 语义 | 属平台服务边界，插件只负责「把请求事实交给它」；我用镜像 401/403 的存根验证了传入形状与状态传递 |
| sqlite 上的完整组合挂载 | 组合仪器跑 json；服务层仪器两个后端都跑（json 150/152、sqlite 148/150，差异仅 2 条 json 专有的字节比对） |
| `promptMaxItems` 对「Delegated to you」的截断 | 未构造超过预算的委派集合 |

## 9. 边界与卫生证据

- `git status --short`：仅 4 条与本任务无关的未跟踪项（`.workbuddy/`、`.agents/skills/requirement-board-tasks/`、两个 `_tmp_*`）；`git diff --stat` 为空 —— **没有任何被跟踪文件被改动**，`.artifacts/` 属忽略目录。
- 实现文件哈希：对照跑前/跑后 4 个关键文件（`host/service.js`、`host/http.js`、`index.js`、`host/runs.js`）逐一 `same=True`。
- 副本清理：`.artifacts/_red-e-*` 跑完全部删除（`remaining _red-e-*: 0`）。
- 临时目录：本轮结束 `%TEMP%\e-verify-*`、`e-compose-*` 均为 0（含清理掉两条历史崩溃遗留）。
- 未触碰 `~/.dsh/**`；未重启任何服务；未使用 3107（本轮无需临时实例）。

## 10. 原始日志保留说明

`tests/verification/_e_*.txt` 全部**保留**作为证据（`_e_json.txt`、`_e_sqlite.txt`、`_e_composition.txt`、`_e_red_rev.txt`、`_e_red_coal.txt`、`_e_red_http.txt`、`_e_author_runs.txt`、`_e_author_loader.txt`、`_e_author_live.txt`、`_e_live_3108.txt`、`_e_live_3108_nocred.txt`、`_e_digest_after.txt`）。V6 的 `_cd_*.txt`、V5/V3 的 `_b_*`/`_a3_*` 也在同目录。冻结时的统一处理由 Lead 决定；我这边不再写入 `tests/verification/**` 以外的任何路径。

## 11. 附录：`live.mjs` 在当前源码上的收口（临时实例 3108）

**启动与归属**

```sh
node --import tsx/esm apps/cli/src/bin.ts web \
  --patch .artifacts/requirement-board/dev.overlay.yml --port 3108 --no-open
# 打印 http://127.0.0.1:3108/?token=TCmFawYHRhj_YT4E7lTj5oC4IkzHdF0-CQ1tZLaflYA
```

- **挂的是当前源码**：profile `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 把 `dsh-requirement-board` 链到 `link:C:/code/deepseek-harness/.artifacts/requirement-board` —— 即本报告 §0 钉住的同一份树。
- 该实例的域路由由 overlay 指向 **sqlite** `.artifacts/requirement-board/dev-board.db`（新板 `revision: 0`）；旧构建的 JSON 数据（`~/.dsh/profiles/web/requirement-board/requirement-board.json`）**没有被这次启动读写**（我只列出目录，没有读它）。
- 3080 全程零请求。

**凭据通道（实测）**

| 请求 | 结果 |
| --- | --- |
| `GET /api/requirement-board/health`（无凭据） | **401** `{"code":"unauthenticated","message":"this request carries no valid session credential for the board API"}` |
| `?token=<引导 token>` 加在 API 路径上 | **401**（引导 token 不走 API 查询串，与 §2.2 的口径一致） |
| `Authorization: Bearer <token>` | **401** |
| 仅 `Origin: http://127.0.0.1:3108` | **401** |
| `GET /?token=<引导 token>` → `303` + `Set-Cookie: dsh-auth-…`，再用该 cookie 请求 API | **200** |

**两条腿的读数**

1. **作者套件原样、不带凭据**：`node --import tsx/esm tests/live.mjs http://127.0.0.1:3108` → **2/8**（`_e_live_3108_nocred.txt`）：

```
FAIL the health route answers — {"ok":false,"error":{"code":"unauthenticated",…}}
FAIL the snapshot route answers — …
FAIL the route is reachable through the running server
FAIL the built-in template ships with the store
FAIL create succeeds — {"code":"unauthenticated",…}
FAIL the live check ran to completion — cannot continue without a created requirement
ok   every probe requirement was deleted again
ok   the board is back to its previous contents
```

2. **同一个文件、浏览器凭据由包装器携带**：`node --import tsx/esm tests/verification/live-auth.mjs http://127.0.0.1:3108 <token>` → **35/35**（`_e_live_3108.txt`）。`tests/live.mjs` **一个字未改**：`live-auth.mjs` 只用引导 token 取一次会话 cookie（模拟浏览器打开 GUI 的同一条路径），把 cookie 附到套件发出的每个 `fetch`，再按套件自己文档化的参数形式 `argv[2]` 传入 base URL 后 `import` 它。逐条为全 `ok`，含：

```
ok   create starts on the first node
ok   the finished node is stamped done
ok   a note opens the gate
ok   every node reads done
ok   stats counts the finished requirement
ok   a stale expectedRev is refused
ok   the conflict carries the current revision
ok   a done requirement is excluded from the open filter       ← 3080 上失败的那条
ok   the event stream opens with the right content type
ok   a committed change pushes a changed event to the open stream
ok   a foreign Origin is refused
ok   a loopback Origin is accepted
ok   every probe requirement was deleted again
ok   the board is back to its previous contents
35/35 checks passed
```

**对 `~/.dsh` 的触碰（如实记录）**：这次受权启动只碰到两处，均无内容变化或属已知项 ——

- `~/.dsh/profiles/web/cordis.yml` mtime 被推到 05:33:19，**内容仍是文档化的空根**（223 字节、`[]` + 3 行说明）：启动器把它按原样重写了一遍。`cordis.patch.yml`、`package.json`、`profiles/web/requirement-board/requirement-board.json` 的 mtime 都没动（前者 00:47，后两者 17:50 / 01:12），即**没有把看板行持久化进 profile**，dev 边界未破。
- `~/.dsh/requirement-board/requirement-board.json` 的 mtime 是 05:30:19 —— 那是 5:30 误打 3080 时的旧构建写入，与本附录的 3108 运行无关（3108 的域走 overlay 指定的 sqlite `.artifacts/requirement-board/dev-board.db`）。

**收尾**：`job_kill` 后 `Get-NetTCPConnection -LocalPort 3108 -State Listen` → `listeners=0`，TCP 连接探测 → `connect=REFUSED`。3108 未留下监听。

### 11.1 裁决落地：给 `tests/live.mjs` 加可选凭据参数（Lead 裁决后实施）

Lead 裁决：阶段 R 的「`live.mjs` 35/35」必须是任何人可复现的一条命令，故给套件加可选凭据，而不是要求先跑 wrapper。落地（写范围 `tests/live.mjs`）：

1. `argv[2]` 仍是 base URL（语义不变），**`argv[3]` 或 `DSH_BOARD_TOKEN`** 提供引导 token。
2. **无凭据立刻响亮失败**：`process.exit(2)` + `live: this suite needs a board credential: pass the boot token as the second argument (after the base URL) or set DSH_BOARD_TOKEN; a real deployment's credentials come from the browser login`。引导 token 被拒（页面不设 cookie）同样 `exit(2)`，并点名 `the boot token was refused: … answered 401 with no session cookie`。
3. 有凭据时套件自己完成 token→cookie 交换（`GET /?token=…` → `Set-Cookie: dsh-auth-…`），把 cookie 附到它发出的每个 `fetch`。
4. `tests/verification/live-auth.mjs` **保留**，作为「不改套件也能 35/35」的等价证据；上面的第 2 条腿即它的读数。

同一临时实例（3108，token `jjYwYHkh…`）上的四条腿：

| 命令 | 读数 |
| --- | --- |
| `live.mjs http://127.0.0.1:3108 <token>` | `35/35 checks passed`，exit **0**（`_e_live_3108_suite_token.txt`） |
| `DSH_BOARD_TOKEN=<token> live.mjs http://127.0.0.1:3108` | `35/35 checks passed`，exit **0**（`_e_live_3108_suite_env.txt`） |
| `live.mjs http://127.0.0.1:3108`（无凭据） | exit **2**，上面那条点名原因，**未发出任何请求**（`_e_live_3108_suite_nocred.txt`） |
| `live.mjs http://127.0.0.1:3108 not-a-real-token` | exit **2**，`the boot token was refused … 401 with no session cookie`（`_e_live_3108_suite_badtoken.txt`） |

连带影响：改动后 `tests/runs.mjs` **312/312**、`tests/loader.mjs` **53/53**、`tests/client-smoke.mjs` **277/277**，均 exit 0。3108 收尾 `listeners=0`；3080 零请求；未改 `host/**`、`client.js`。

## 12. re-pin 附录：作者修 F1 后的复跑（与 §0–§3 不同 revision）

本附录的读数取自作者落修后的**新** revision（`host/service.js` mtime 05:32:53、`host/domain.js` 05:35:20），与 §0 钉住的 `AEF74B2A…`/`188EACCC…` **不是同一棵树**，两者不可混用。

| 文件 | SHA256（新） | 与 §0 相比 |
| --- | --- | --- |
| `host/service.js` | `9351989E7FF97036ED849A9C32DE860EA25D9F536B978F3129CFAF0AA10AEC24` | 变了（旧 `AEF74B2A…`） |
| `host/domain.js` | `5584561E19A45F3EFEAC5FD76A8A6CCC00FB315C6E9658F956BE5A7F1444608A` | 变了（旧 `188EACCC…`） |
| `host/http.js` | `69BE916AF23CA5554FBC461DAFD34A27F652589702A43EDA0DFC4E258D250536` | 未变 |
| `host/runs.js` | `3F5656160961EFE4B5B8CC1C9F026042AAB3F1D68E9BCF994B5893EB60FEF924` | 未变 |
| `index.js` | `89ED1FCDEB2EB615D11F0C9B98FAC9B36D37863B9188C5E02AB411436BA903A0` | 未变 |

27 文件 D19 摘要（新）：`694bba17-89ed1fcd-5c8d3aee-20ca5447-be0a7cba-5584561e-48e3c080-69be916a-7460d4f9-4b06a18f-3f565616-9351989e-3dcb6c4e-a22f0d5a-a226e071-e3a9261c-24015b2e-520cfd9e-dd49b42c-afb4b2d0-1b4c3b22-50efaabb-b2ba560e-dbd75745-42fd0707-2c4a0603-656242c4`
（除上表两项外，`host/tools.js`、`tests/{dispatch,harness,runs}.mjs` 也在动 —— 作者正在同一窗口内落修。）

| 仪器 | 新 revision 读数 | 变化 |
| --- | --- | --- |
| `e-verify.mjs`（json） | **152/153** | 原 150/152 |
| `e-verify.mjs`（sqlite） | **150/151** | 原 148/150 |
| `e-composition.mjs` | **55/55** | 不变 |
| `tests/runs.mjs` | 312/312 | 原 308/308 |

**两个发现的收口状态**

- **F-E1（`byKind` 词表被撑大）→ 已修**：新 revision 上 `ok the statistics vocabulary stays closed`（两后端都过）。我的仪器断言的是**目标行为**（闭集），所以它在修前红、修后绿，是一条可回归的判据。
- **F-E2（严重）→ 行为按 Lead 裁决保留，但诊断仍未落地**：`ok reopening a board that stores an unknown kind fails loud`（`invalid-record`，符合裁决）；但 `FAIL the refusal names the offending field — domain 'requirement_board': stored record 'req_…' in table 'requirements' does not match its schema` —— 消息里**没有 zod issue path、没有 `kind`**。按 Lead 的裁决（「诊断要修：错误信息要带 zod issue path（点名 `kind`）」），这一条在 `domain.js 5584561E…` 上**尚未实现**。
- 仪器口径已按裁决对齐：`e-verify.mjs` 的 [8] 现在断言「打开必须响亮失败（`invalid-record`）**且**消息点名越界字段」，不再断言「打开应当接受该记录」。

原始输出：`_e_json_repin.txt`、`_e_sqlite_repin.txt`、`_e_composition_repin.txt`、`_e_digest_repin.txt`。
