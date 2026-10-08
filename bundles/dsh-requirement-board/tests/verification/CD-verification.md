# C / D 阶段独立验证报告（证伪视角）

- 验证人：`composition-verifier`（非实现作者）
- 被验证：**task-15（C：决策需求 + `kind` 不可变）**、**task-16（D：门禁 + 优先级继承 + `advanceable`）**
- 作者：`storage-migration`（复核期间仍在并行编辑 `host/*`、`index.js`）
- 交付物：本文件；仪器 `.artifacts/requirement-board/tests/verification/{cd-verify.mjs, cd-composition.mjs}`；原始日志同目录 `_cd_*.txt`

---

## 0. 结论摘要

**C / D 的功能裁决我独立复现并全部证实**，未发现"实现根本没生效"级别的缺陷。发现 3 个实际问题（1 个真缺口、1 个提示词缺陷、1 个诊断顺序），另有 2 条越界/卫生备注。§4.4 表格的独立读数与 `LEAD-DECISIONS.md:183` 的裁决一致，但我量到的是 **3 处矛盾而不是 1 处**，见 §4。

### 0.1 哈希钉（D19）

```
8ce482b5-f0612bcd-3f11f627-9f750d6e-d63a60a5-d665f584-8de20f40-cd615698-dbc691bb-b836fccd-
21e2f84f-76d850a3-3f71a501-a107e1bc-986f1c21-c7978c33-92fdcfcb-875fc6e9-f04b30ce-8e042156-
d003f11c-eaa4f20a-02545fd4-75e53a4c-2444bf68-44b6cce9-1b9ff3f2-372ba7d2
```

28 个文件（根 `*.js` + `host/*.js` + `tests/*.mjs`，按文件名序）。关键位：

| 文件 | 截断哈希 |
| --- | --- |
| `index.js` | `f0612bcd` |
| `host/dispatch.js` | `d63a60a5` |
| `host/http.js` | `cd615698` |
| `host/service.js` | `76d850a3` |
| `host/tools.js` | `a107e1bc` |
| `tests/gates.mjs` | `d003f11c` |
| `tests/decision.mjs` | `92fdcfcb` |

三套仪器（json / sqlite / 真实组合）在**同一哈希**下跑完（跑前跑后 digest 相同，`_cd_digest_pinned.txt`）。**跑完后作者又改了 `host/service.js`（`76d850a3` → 之后再次变化）与 `tests/roles.mjs`**，所以本报告的读数归属上表这一个哈希；此后任何哈希变化都需要重跑。

### 0.2 判定表

| # | 验收项 | 判定 | 证据位置 |
| --- | --- | --- | --- |
| C1 | `kind` 不可变（服务 / 面板指令 / 工具 / 面板工具 / 创建期词表） | **证实** | §2.1 |
| C1b | 绕过写库（直接 `table.put` 非法 `kind`） | **证伪（延迟校验）** | F1、§2.1 |
| C2 | 决策"人类专属"在执行该操作的地方（claim/queue/transition/archive/delete/delegate/revoke/checklist） | **证实** | §2.2 |
| C2b | 决策 `checklist` 的拒绝诊断 | **证伪（顺序）** | F3、§2.2 |
| C3 | `requestedBy` 首建者、不被后续更新覆盖 | **证实** | §2.3 |
| C4 | 决策不进 tool `list{claimable}` / prompt 工作区 / 面板 pool | **证实** | §2.4 |
| C4b | **被派发的决策不进 `Delegated to you`** | **证伪** | F2、§2.4 |
| C5 | `stats` 口径自洽、无 C/D 自身占位死字段 | **证实** | §2.5 |
| D1 | `blocksOn` 门禁（advance/complete 拒、`force` 越并记 history、`rollback` 不受门禁、`jump` 要 force、写链接要锁且记 history） | **证实** | §3.1 |
| D2 | 两张图**各自**成环 + 跨图独立 + 深链终止 + 库内环不挂读 | **证实** | §3.2 |
| D3 | `delete` 同链解绑 `blocksOn`/`parentId`/队列 + `unbound` 回执 + history note | **证实** | §3.3 |
| D4 | 优先级继承（抬高拦路者、多级、封顶、不落盘、回落、归档仍挡仍被抬） | **证实** | §3.4 |
| D5 | `advanceable` 与 `transition` 同源（11 态全对齐） | **证实** | §3.5 |
| D5b | §4.4 表格公式 `claimable && !gated` | **证伪（3 处矛盾）** | §4 |
| D6 | 四条读路径同源（`get`/`list`/`snapshot`/`changesSince`） | **证实** | §3.6 |
| D7 | prompt `[high↑]` 只给被抬高者、按 section、任务与决策共用 | **证实** | §3.7 |
| D8 | 错误码顺序：模板节点依赖先于跨需求门禁 | **证实** | §3.8 |
| D9 | `blocksOn` 20 条上限 | **证实** | §3.9 |
| — | 作者自测套件（C/D 相关） | **绿 1080/1080** | §1.3 |
| — | live 实例自证（3106/3099） | **未验证** | §7 |

### 0.3 能让它红的证据（≥2 条，D19）

| 对照 | 变异 | 结果 | 结论 |
| --- | --- | --- | --- |
| A（LIVE） | 把 `dispatch.js` 里 `advanceable` 的持锁子句改成 `return true` | 175/182，**新增 4 条红**，`LIVE CONTROL` 绿 | 我的"`advanceable` 与实操对齐"断言确实能红 |
| B（OLD） | 把 `service.js` `#assertLinks` 两处成环守卫改成恒假（= D 之前没有成环拒绝） | 176/182，**新增 3 条红**，`OLD CONTROL` 绿 | 我的成环断言确实能红，且能复现 D 之前的老缺口 |

两份对照的基底文件哈希**逐字节等于**钉住的 `service.js`(`76d850a3`) / `dispatch.js`(`d63a60a5`)（copy base 比对为 True）。变异副本已删除（`_red-cd-live/`、`_red-cd-old/` 均不存在）。

---

## 1. 我跑了什么

### 1.1 仪器

| 文件 | 覆盖 | 用法 |
| --- | --- | --- |
| `tests/verification/cd-verify.mjs` | 服务层 13 节：`kind` 不可变/绕过写库、人类专属、`requestedBy`、可接池、`stats`、门禁、节点完成条件、成环、delete 解绑、优先级继承、`advanceable` 11 态矩阵、四条读路径、prompt 标签、20 上限 | `node --import tsx/esm …/cd-verify.mjs`；`RB_CD_BACKEND=sqlite`；`RB_CD_SERVICE=./副本/host/service.js` |
| `tests/verification/cd-composition.mjs` | 真实组合：挂载真 `index.js` + Storage/StorageJson/StorageDomain/Tools/SystemPrompt + role 域 + preset stub；走 `requirement_board` / `flow_template` 工具与真 `systemPrompt.assemble()` 文本；卸载后写旧记录再挂载读回 | `node --import tsx/esm …/cd-composition.mjs`；`RB_CD_INDEX=…` |
| `tests/verification/b-digest.mjs` | D19 摘要（B 阶段留下的同一件工具，自动纳入新文件） | `node …/b-digest.mjs` |

判定口径（自校验，不靠我"觉得"）：
`advanceable === (实际 advance 没有被权限/门禁类理由拒绝)`，其中权限/门禁类码 = `forbidden`（`lock-required`/`decision-task`）、`invalid-transition`（`blocked-by`）、`dependency-not-met`；**`completion-not-met` 明确不算**（§4.4 正文与实现都把它留给 `transition` 判，见 §3.5 的 [6b] 证据）。矩阵里任何一行只要 `advanceable` 与实操分叉就会红。

### 1.2 原始结果

| 命令 | 结果 |
| --- | --- |
| `node cd-verify.mjs`（json） | **178/181**，3 条 FAIL = F1×2 + F2 |
| `RB_CD_BACKEND=sqlite node cd-verify.mjs` | **178/181**，同样 3 条 FAIL |
| `node cd-composition.mjs`（真组合，json） | **47/48**，1 条 FAIL = F2（模型可见文本） |
| 对照 A（LIVE 变异） | 175/182（4 红 + 控制绿） |
| 对照 B（OLD 变异） | 176/182（3 红 + 控制绿） |

日志：`_cd_json.txt`、`_cd_sqlite.txt`、`_cd_composition.txt`、`_cd_mutant_live.txt`、`_cd_mutant_old.txt`、`_cd_digest_before.txt`、`_cd_digest_after.txt`、`_cd_digest_pinned.txt`。

### 1.3 作者自测套件（同一 C/D 文件集，客户端/`runs.js` 在我跑的时候并行变动，与本报告无关）

```
gates     exit=0  246/246
decision  exit=0  228/228
dispatch  exit=0  302/302
queue     exit=0  304/304
                  合计 1080/1080
```

原始输出：`_cd_author_{gates,decision,dispatch,queue}.txt`。

### 1.4 仪器自检（我先修掉了 4 处自己的 bug，避免把仪器缺陷当发现）

1. 组合层工具参数是**扁平**的（`{action:'update', id, kind}`），我一开始传了 `patch:{…}` → 被工具执行器忽略，导致"工具没拒绝 `kind`"的假红；改扁平后为真拒绝。
2. 读路径比对时把字符串 id 写成了 `rich.id`（`undefined`）→ 假红；改为 `rich`。
3. 优先级继承方向我一开始反了（以为是"被挡的继承"），实测实现是**抬高拦路者**（`dispatch.js:157-206`，与 task-16 正文 `effectivePriority(req)=max(own, max{effectivePriority(d) | req ∈ blockedBy(d)})` 一致）；按正文重写用例。
4. 组合里 `ctx.storageDomain` 在插件外是 `undefined`，要用 `ctx.get('storageDomain')`；且 `decode`/raw 表只能在**未挂载**时写，故改成三段式（挂载→卸载写旧记录→再挂载）。

---

## 2. C（task-15）逐条

### 2.1 C1 `kind` 不可变 —— 证实

服务层（原始输出见 `_cd_json.txt`）：

```
ok   service update{kind} is refused
ok   the panel command update{kind} is refused          # dispatchBoardCommand{action:'update',patch:{kind}}
ok   an invalid kind is still refused first             # {reason:'kind-immutable'}
ok   the refused update changed neither kind nor rev
ok   a decision cannot be turned back into a task
ok   an invalid kind is refused at create with the value received   # details.received='epic'
ok   the kind filter refuses an unknown kind            # list{kind:'epic'} → invalid-argument
```

组合层（真 `index.js` + 工具）：

```
ok   the tool refuses a session update of kind          # {action:'update',id,kind:'decision'} → 错误文本含 kind
ok   the refused update wrote nothing                   # kind='task' 且 rev 未动
ok   the panel path refuses an invalid kind too
note an undeclared "patch" argument is ignored by the tool executor, and the kind stays task
ok   the tool reads a legacy record as a task           # 旧记录（无 kind）读为 task
```

补一条**绕过**读数（见 F1）：直接 `table.put` 一个 `kind:'epic'` 的记录在运行期被接受，但**重新打开域时被拒**：

```
note the injected record reads kind="epic" claimable=false advanceable=false and claim succeeded
note after the accepted claim the injected record reads claimable=false advanceable=true status=active
note reopening the domain over the injected record: refused invalid-record
note the load failure reads: domain 'requirement_board': stored record 'req_epicopen' in table
     'requirements' does not match its schema
```

即：**写路径（服务/工具/面板指令）拒绝非法 `kind` 成立；表本身不是运行期守卫，它是加载期守卫**。作者的写范围里没有任何路径能造出这种记录（服务 `create` 用 `asEnum`、`update` 直接 `kind-immutable`），所以这是纵深防御缺口而不是可达缺陷。另注：未知字段（`epicField:1`）同样在 `put` 时被接受、在加载时被拒。

### 2.2 C2 决策"人类专属"在操作里执行 —— 证实（附 1 条诊断顺序发现）

我**不经过面板、不经过 HTTP**，直接调服务方法、且传入非空 `session`：

```
ok   claim by a session refuses the decision          # forbidden/decision-task
ok   queue by a session refuses the decision
ok   transition by a session refuses the decision
ok   archive by a session refuses the decision
ok   delete by a session refuses the decision
ok   delegate by a session refuses the decision
ok   revoke by a session refuses the decision
ok   the decision cannot be claimed even by a session it is delegated to
ok   a delegated decision is still not claimable for its named session
ok   the panel advances the decision
ok   the panel archives the decision
ok   the panel deletes the decision
ok   the panel delegates the decision
ok   the panel cannot claim: it holds no lock          # invalid-argument/session-required
ok   the panel cannot queue: it reserves nothing
ok   a session may restate a decision's priority       # update whitelist 允许 priority
ok   a session may not reroute a decision              # forbidden/decision-task (role)
ok   a session may not change a decision's owner
ok   a session may not gate a decision
ok   the panel may reroute a decision
ok   a task's priority changes without a lock
ok   a task's role needs the lock                      # forbidden/lock-required
ok   the holder may reroute the task
```

组合层同样成立（`_cd_composition.txt`），包括 `checklist`：

```
ok   the tool refuses claim/queue/transition/archive/delete/delegate on a decision by a session
ok   the tool refuses a checklist tick on a decision by a session
note its refusal reads: "Error: \"req_…\" requires its execution lock: session \"sess_parent\" does not hold it"
```

→ 行为正确（会话永远勾不动决策），但**理由码是 `lock-required` 而不是 `decision-task`**：`setChecklist` 先判锁再判人类专属，会和 §2.2"决策就是给人拍的、你不用去拿锁"的提示互相打脸，模型可能因此去 `claim` 一个永远 `claim` 不了的决策。见 F3。

### 2.3 C3 `requestedBy` 是首建者 —— 证实

```
ok   the first requester is the creating actor
ok   a later update does not rewrite requestedBy        # 改名后仍 '甲'
ok   a second record with the same title is a separate requester
ok   a panel-created decision keeps the panel name
ok   an unnamed actor falls back to the registry name   # session→注册表名 '甲'
ok   a session the registry does not know falls back to its id   # 'ses_ghost'
ok   requestedBy is not touched by reads
```

组合层：assembled text 里 `- req_… 挡住紧急活的决策 · requested by 甲` ✓。

### 2.4 C4 决策不进任何可接池 —— 证实；**被派发的决策仍进 `Delegated to you`** —— 证伪

```
ok   the service pool has no decision
ok   the snapshot pool has no decision
ok   the panel pool has no decision
ok   the decision is absent from every work section
ok   the decision is present in the human section
ok   the tool pool for a session has no decision
ok   the tool pool for the panel has no decision
ok   the kind filter still finds it
```

F2 的反证（服务层）：

```
FAIL a delegated decision is not listed as delegated work for that session
     Delegated to you (1) — claim it before you start:
     - req_7a9e422530 [normal] 被派发的问题 · node 1/3 一 · active ·
       delegated by 面板人 () · your role for this task: tmp-req_7a9e422530
note a delegated decision appears 3 time(s) in the prompt for its named session
note its "Waiting on the human" line: - req_19eddff87b [normal] 该人决定 · requested by 甲 |
     - req_4eb34e27f9 [normal] 被派发的问题 · requested by 面板人 |
```

真组合里同样（模型可见文本层面）：

```
FAIL a delegated decision is not offered as delegated work
     Delegated to you (1) — claim it before you start:
     - req_f8e4556279 [normal] 该人拍板的问题 · node 2/3 二 · active · your role for this task: tmp-req_f8e4556279
ok   it is still named as waiting on the human
ok   and the named session still cannot claim it          # claimable=false
```

即 prompt 会在同一份文本里**既叫这个会话"先去 claim，这是你的活"，又在人肉区把它列为待拍板**，而 `claim` 对决策永远 `forbidden/decision-task`。B 阶段结论"被派发的决策永远 claim 不了"在这里得到了 prompt 侧的实证。

### 2.5 C5 `stats` 口径 —— 证实（越界项另记）

场景固定（7 个 task：1 done、1 archived、5 open；2 个 decision：1 done、1 open；1 条队列预留；1 把孤儿锁；1 条待接派发）：

```
ok   byKind counts open work per kind                 # {"task":5,"decision":1}
ok   decisions counts the open question only          # 1
ok   byStatus keeps the finished and archived records # done=2 archived=1
ok   queued/reserved/queues agree on the one reservation
ok   orphanedLocks counts the lock a dead session left
ok   pendingDelegations counts the unclaimed delegation
ok   criticalPath is the number of raised blockers, by one reading   # =1，与逐条 recompute 一致
ok   the documented fields all exist
ok   no placeholder field of C/D's own is present
ok   byRole groups unrouted work under the empty role
note stage-E fields are present in stats at this digest (out of C/D scope):
     running=0 execSync={"ignored":0,"gaps":2}
```

`running`/`execSync` 是 E 阶段的字段，已随 `host/runs.js` 落地且非空（`running=0`、`execSync={ignored:0,gaps:2}`），**不属于 C/D 判真伪范围**，仅记录：task-15/16 原文里"stats 里不该有 E 的占位字段"这条在**当前 tree 已不再成立**（那时 E 还没落地）。

---

## 3. D（task-16）逐条

### 3.1 D1 门禁 —— 证实

```
note the gate refusal payload reads: {"code":"invalid-transition","details":
     {"reason":"blocked-by","id":"req_51d29cd540","action":"advance","blockedBy":["req_fe59769fc8"]}}
ok   the holder cannot advance past an unfinished blocker
ok   the refusal wrote nothing
ok   the holder cannot complete past an unfinished blocker
ok   the refused complete left the record active
ok   force advances and records which gate it overrode
ok   the history entry names the blocker it overrode          # history[].blockedBy=[blocker]
ok   rollback is not gated, but still needs a preceding node
ok   rollback from node two to node one is allowed while blocked
ok   jump insists on force
ok   another session cannot rewrite the gate links            # forbidden/lock-required
ok   the holder clears the gate link
ok   clearing a gate link is recorded in the history          # note: gates: parentId "", blocksOn []
ok   and sets it again
ok   setting a gate link is recorded in the history           # note 含 blocksOn [req_…]
ok   and the gate is armed again
ok   the gated record is still blocked after all that
ok   completing the blocker frees the gate
ok   and it advances without force now
```

细节：`force` 的 history 条目同时带 `force:true` 与 `blockedBy:[…]`，满足"记下越过了哪道门"；`complete` 也走门禁（否则抬高没有强制力）。

### 3.2 D2 成环与深链 —— 证实

```
ok   a requirement cannot be its own parent           # self-reference/parentId
ok   a requirement cannot block on itself             # self-reference/blocksOn
ok   the reverse parent link would close a cycle      # cycle/parentId
ok   the reverse blocksOn link would close a cycle    # cycle/blocksOn
ok   a parent link is accepted on the fresh pair
ok   the reverse parent link is refused on the fresh pair
ok   the same pair is legal in the other graph
ok   the pair is a parent cycle and a legal gate at the same time
ok   a link to a record that does not exist is refused
ok   the deepest record has no children
ok   the root of the chain has one child
ok   a 120-deep chain builds and reads without hanging          # note: 120-deep parent chain built in N ms
ok   a stored parent cycle still reads
ok   a stored cycle does not hang the read paths
```

"两张图各自"被正面证实：**同一对 (d,e)** 在 `parentId` 图上成环被拒，在 `blocksOn` 图上作为合法门禁被接受并派生出 `gated=true`。深链 120 层构建+读取不挂；直接写库造出的 `parentId` 环也不会让 `get`/`list`/`snapshot`/`stats`/`promptContext` 挂死（`escalationIndex` 的 `open` 集合兜住）。

### 3.3 D3 `delete` 同链解绑 —— 证实

```
ok   the gate is armed before the delete              # blockedBy=[blocker] 且 criticalPath=1
ok   the panel deletes the blocker
ok   the receipt lists what was unbound               # unbound 同时含被挡者与孩子
ok   the deleted id is out of blocksOn, blockedBy and gated
ok   the child lost its parent
ok   the unbinding is recorded on the unbound record  # note: unbound from "<id>", which was deleted
ok   the deleted id left the queue that reserved it
ok   a live reservation on another record is untouched
ok   criticalPath fell back to zero
ok   the deleted record is gone                       # not-found
```

### 3.4 D4 优先级继承 —— 证实（方向按正文，不是按我的直觉）

实现语义（`dispatch.js:157-206`）：**抬高"拦路那条"**，传播沿 `blocksOn` 反向逐级；封顶 `urgent`；`escalated` 为派生值；不落盘。用例：`urgentWork(urgent) → middle(normal) → low(low)`。

```
ok   the raised record is the blocker, not the waiter
ok   the urgency travels one more level through the chain
ok   the work that raises is not itself raised
ok   gated marks only the records that wait
ok   nothing was written by the reads
ok   the stored record has no derived field
ok   the stored priority is byte-for-byte what was created
ok   stats.criticalPath counts both raised blockers          # 2
ok   an archived blocker still blocks
ok   an archived blocker is still raised by the work it holds up
note the archived middle blocker stops passing the raise on: low reads low/false
ok   a shelved link no longer raises what it waits on
ok   criticalPath followed the shelving down                 # 1
ok   the archived record is still never written to
ok   the escalation fell back for the unlinked record
ok   the record with nothing left to hold up keeps its own priority
ok   criticalPath fell back with it                          # 0
```

一条**新事实**（不是缺陷，但值得写进正文/文档）：归档中间挡路者后，它仍被上方在做的活抬高（`escalated=true`），但因为它自己 `!inProgress`，**不再把抬高往下传**（`low` 回落到自身 `low`），`criticalPath` 2→1。正文只说"归档的挡路需求不算完成"，没说"也不参与继续传播"。

### 3.5 D5 `advanceable` 与实操同源 —— 证实；§4.4 表格 —— 证伪（见 §4）

11 态矩阵全部对齐（`_cd_json.txt` 的 `note` 行，`§4.4-table` 列 = 表格公式 `claimable && !gated`）：

```
note idle task, session:                  claimable=true  gated=false advanceable=false actual=forbidden/lock-required   §4.4-table=true  ← MISMATCH
note task locked by the session:          claimable=true  gated=false advanceable=true  actual=advanced                  §4.4-table=true
note task locked by another session:      claimable=false gated=false advanceable=false actual=forbidden/lock-required   §4.4-table=false
note gated task locked by the session:    claimable=true  gated=true  advanceable=false actual=invalid-transition/blocked-by §4.4-table=false
note finished task:                       claimable=false gated=false advanceable=false actual=forbidden/lock-required   §4.4-table=false
note archived task, lock retained:        claimable=false gated=false advanceable=false actual=invalid-transition/          §4.4-table=false
note decision, session:                   claimable=false gated=false advanceable=false actual=forbidden/decision-task      §4.4-table=false
note decision, panel:                     claimable=false gated=false advanceable=true  actual=advanced                     §4.4-table=false ← MISMATCH
note idle task, panel:                    claimable=true  gated=false advanceable=true  actual=advanced                     §4.4-table=true
note gated task, panel:                   claimable=true  gated=true  advanceable=false actual=invalid-transition/blocked-by §4.4-table=false
note task with an unmet node prerequisite: claimable=true gated=false advanceable=false actual=dependency-not-met/          §4.4-table=true  ← MISMATCH
```

边界（有意分叉，被显式验证）：

```
ok   the lock holder reads advanceable although the node needs a tick   # advanceable=true
ok   and only `transition` judges the completion condition             # completion-not-met
note the completion refusal reads: {"code":"completion-not-met","details":
     {"node":"n1","reason":"checklist-incomplete","missing":["看过"]}}
ok   the checklist entry is ticked
ok   and then the same advance succeeds
```

→ `advanceable` **不含**节点自身的完成条件（`completion-not-met`），但**含**节点前置依赖（`dependency-not-met`）。这正是 §4.4 表格漏掉的第三类。

### 3.6 D6 四条读路径同源 —— 证实

```
ok   get and list agree field by field
ok   get and snapshot agree field by field
ok   the catch-up path agrees on every shared field          # kind/requestedBy/parentId/blocksOn/children/
                                                             # blockedBy/gated/effectivePriority/escalated/status/…
ok   the child link is derived, not stored
ok   get, list and the snapshot all expose the two eligibility answers
ok   the catch-up path deliberately omits them               # changesSince 不带 claimable/advanceable
ok   a legacy record is normalized the same way on all paths # 无 kind/requestedBy/links 的旧记录
ok   the snapshot statistics come from the same stats
```

### 3.7 D7 prompt `[high↑]` —— 证实

```
ok   the raised task carries the arrow                       # [urgent↑]
ok   the plain task carries no arrow
ok   the work that raises is not marked as raised
ok   a raised decision uses the same tag implementation      # 决策也能被抬高并带 [urgent↑]
ok   a plain decision carries no arrow
ok   the arrow names exactly the raised records
ok   both records sit in the section that means them         # 决策在 Waiting on the human
ok   a decision is never listed as claimable work
ok   the decision really gates the urgent work behind it     # worker.gated=true, criticalPath=2
```

真组合里同一个 tag 出现在**装配后的运行时上下文**里（`systemPrompt.assemble()`→`renderContextSections`）：`[urgent↑]` 落在被抬高的 task 与被抬高的 decision 行上，抬高者无箭头。跨 kind 的门禁链（决策挡住紧急活）在两个层面都成立。

### 3.8 D8 错误码顺序 —— 证实

```
ok   a template with a forward node dependency is created
ok   a second session takes the lock on the doubly-gated record
ok   the node prerequisite is judged before the cross-requirement gate   # dependency-not-met（不是 blocked-by）
```

### 3.9 D9 链接上限 —— 证实

```
ok   a gate list longer than the declared bound is refused   # 21 条 → invalid-argument
ok   the same list at the declared bound is accepted         # 20 条
ok   all twenty links read back
```

---

## 4. §4.4 表格的独立读数（Lead 最关心的一项）

**我的读数：表格 `advanceable = claimable && !gated` 与实际推得动在 3 处矛盾，不是 1 处。** 三处方向各异：

| 场景 | 表格 | 实现/实操 | 差异性质 |
| --- | --- | --- | --- |
| 空闲、无门禁、会话 | `true` | `false`，`advance` → `forbidden{lock-required}` | 表格**高估**"能推进"（把"能接"当"能推"） |
| 决策、面板 | `false`（`claimable=false`，因为 `kind!=='task'`） | `true`，面板 `advance` 直接成功 | 表格**低估**人类（面板无人持锁，`claimable` 对它本就恒无意义） |
| 持锁、无门禁、但当前节点前置依赖未满足 | `true` | `false`，`advance` → `dependency-not-met` | 表格漏掉**节点前置依赖**这一类门禁 |

同源公式（与 task-16 正文一致、也是我实测的行为）：

```
advanceable(record, me) =
    状态不是 done/archived
  ∧ !gated                                  （或 transition 时给 force）
  ∧ !prerequisiteMissing                    （节点 dependsOn；缺的是表格这一项）
  ∧ kind 允许（decision → 只允许 me===''）
  ∧ (me === '' ? true : 锁在手上)
  // 节点自身的完成条件（completion-not-met）不属于 advanceable：那是内容，不是许可
```

**建议的表格修正**（`ROLE-DISPATCH.md:262` 那一行）：

```diff
-| `advanceable` | `claimable && !gated` | prompt 区分"能接"与"能推进" |
+| `advanceable` | 锁在手上（面板无人持锁，恒真）∧ 门禁已清 ∧ 节点前置已满足 ∧ 状态非 done/archived ∧ `kind` 允许 | prompt 区分"能接"与"能推进"；`claimable` 只答"能接"，节点自身的完成条件由 `transition` 判（`completion-not-met`） |
```

**与既有记录的关系（我核对过，避免重复劳动）**：`LEAD-DECISIONS.md:183` 已裁定"正文口径正确、§4.4 表格那行错"，`G-CHECKLIST.md:31` 已有未勾选项"改为按正文口径"。我的独立实测**支持**该裁定，但要提醒两点，否则 G 改完还会留缝：

1. 只把表格改成 `持锁 ∧ !gated` 仍会错两处：**面板**（无锁可用，实测 `advanceable=true`）与 **决策**（`kind` 子句，实测会话 false / 面板 true）；
2. task-16 的**正文**公式同样漏了**节点前置依赖**（`dependency-not-met`，实测 `advanceable=false`），如果只改表格不改正文，两处又会对不上。建议正文与表格一次改齐（下面 §5 F1 之外的 D5 修正项）。

---

## 5. 发现与建议

### F1（真缺口，低可达性）直接写库的非法 `kind` 会让"可接池"与"claim"分叉

**现象**（json + sqlite 一致，`_cd_json.txt`）：

```
note the injected record reads kind="epic" claimable=false advanceable=false and claim succeeded
note after the accepted claim the injected record reads claimable=false advanceable=true status=active
note after that the injected kind is rejected by LiST filters: list{kind:'epic'} → invalid-argument
FAIL an unknown kind is not both unclaimable and claimable — {"claimable":false,"claim":"accepted"}
FAIL an unknown kind does not enlarge the byKind vocabulary  — {"task":1,"decision":1,"epic":1}
note reopening the domain over the injected record: refused invalid-record
```

四条事实：(1) `claimable` 因 `kind!=='task'` 为 false，但 `judgeClaim` 只认 `kind==='decision'`，于是**池子说不能接、操作却接了**；(2) 接锁后该记录 `claimable=false` 而 `advanceable=true`；(3) `stats.byKind` 被撑出未知键 `epic`（口径词表不是封闭的）；(4) 重启加载时被 `invalid-record` 拒绝，**也就是说这条记录会把下一次开机弄坏**（fail loud，但代价是整块板子起不来）。

**可达性**：服务/工具/HTTP 三条写路径都进不来（创建 `asEnum`、更新 `kind-immutable`）；只有"服务之外直接写表"（脚本、迁移、日后新 E 阶段写库、手工修数据）才可能。**这是纵深防御缺口，不是当前可达缺陷。**

**建议**（任一即可，按作者判断）：
- 读侧一致化：把 `judgeClaim`/`claimable`/`advanceable` 的 kind 判定统一成"`kind === 'task'` 才可 claim"（与池子同一口径，改动最小、最稳）；
- 或者让 `summarize`/`#present` 把词表外的 kind 归一到 `task` 并记一条 warn（`stats.byKind` 不再可能长出未知键）；
- 不建议只在 `put` 上加校验（域层的校验时机是加载期，见 `storage-domain/src/index.ts:124`）。

### F2（提示词缺陷，模型可见）被派发的决策仍出现在 `Delegated to you`

服务层与真组合都复现（§2.4）。`promptContext` 的 `Delegated to you` 过滤条件是 `delegatedTo?.session === session && lock?.session !== session`，**没有 kind 子句**，而 `claim/transition` 对决策恒拒。后果：模型被告知"先去 claim 这是你的活"并拿到 `your role for this task: tmp-req_…`，去 claim 只会拿到 `forbidden/decision-task`；同一条记录又在 `Waiting on the human` 出现。

**建议**：给 `Delegated to you` 加与池子相同的 kind 子句（`(record.kind ?? 'task') === 'task'`），一行过滤；决策照旧只在人肉区出现。另可选：`delegate` 对决策默认拒绝（现在只有 `session!==''` 时才拒），让"派发一个决策"本身不可能，从而两条路径一致。

### F3（诊断顺序）决策的 `checklist` 报 `lock-required` 而不是 `decision-task`

`setChecklist` 先 `assertLockHeld`，后 `#assertHumanOnly`（对比 `transition`/`archive`/`delete` 是先人类专属）。行为仍正确（会话勾不动决策），但模型收到的指引是"去拿锁"，而决策的锁永远拿不到（`claim` 会 `forbidden/decision-task`）。

**建议**：把 `#assertHumanOnly` 提到锁检查之前（顺序问题，零风险），并顺手审计 `block`/`unblock`/`release` 是否同序。

### F4（越界观察，属平台/工具层）未声明的工具参数被静默忽略，且空 patch 的 `update` 仍会推进 `rev`

组合层实测：`{action:'update', id, patch:{kind:'decision'}}`（`patch` 未在工具 schema 里声明）**不报错**，工具照常成功，且 `rev` 从 1 变 2——字段被丢掉、修订号却动了。

```
note an undeclared "patch" argument is ignored by the tool executor, and the kind stays task
ok   the refused update wrote nothing     # 这条用的是扁平参数，服务层拒绝，rev 不动
```

影响：模型用错参数名时得到"成功"的假象；`expectedRev` 的调用方可能被一次空更新打掉预期。**不属于 C/D 范围**（工具执行器的参数校验 + `updateRequirement` 空 patch 也写盘），仅记录给 Lead，建议单独开一条。

### F5（卫生，属作者）`tests/_rb-debug-smoke.mjs` 留在树里

D19 摘要里出现了 `tests/_rb-debug-smoke.mjs`（`986f1c21` → 之后又变），名字像调试残留，且会被摘要工具纳入。建议作者在 G 冻结前删掉（作者的写范围内）。

---

## 6. 红/绿对照的原始证据

### 6.1 对照 A（LIVE，"持锁子句没了"）

变异：`host/dispatch.js` 的 `advanceable` 末尾 `return lockState(record, me, now, leaseHours).state === 'mine'` → `return true`（唯一命中点 1 处）。

```
live 175/182 checks passed on the json backend
ok   LIVE CONTROL: the pre-D implementation calls the idle record advanceable

FAIL advanceable agrees with the actual verdict — idle task, session — advanceable=true refusal=forbidden/lock-required
FAIL advanceable agrees with the actual verdict — task locked by another session — advanceable=true refusal=forbidden/lock-required
FAIL the §4.4 table formula disagrees with the implementation in the idle case — {"name":"idle task, session","claimable":true,
     "advanceable":true,"gated":false,"refusal":"forbidden/lock-required","table":true}
FAIL the table disagrees with the implementation only where measured — {"mismatching":["task locked by another session",
     "decision, panel","task with an unmet node prerequisite"],"expectedMismatches":["idle task, session","decision, panel",
     "task with an unmet node prerequisite"],"mismatches":3}
```

### 6.2 对照 B（OLD，"D 之前没有成环拒绝"）

变异：`host/service.js` 的 `#assertLinks` 两处 `if (cursor === id) {` → `if (cursor === id && false) {`（命中 2 处：`parentId` 上溯环与 `blocksOn` DFS 环）。树的 HEAD 里没有 D 之前的版本，所以这是"把 D 的成环拒绝拿掉"的忠实替身。

```
old 176/182 checks passed on the json backend
ok   OLD CONTROL: the pre-D board accepted the blocksOn cycle

FAIL the reverse parent link would close a cycle — no-code/no-reason
FAIL the reverse blocksOn link would close a cycle — no-code/no-reason
FAIL the reverse parent link is refused on the fresh pair — no-code/no-reason
```

### 6.3 对照基底与清理

```
copy matches base: service=True dispatch=True
  real host/service.js : A6D5C3965FC3FEB0E87F5176F3FAE3F0DAD8CEB12202DD0971117B3621B93AED   （= 76d850a3…）
  real host/dispatch.js: D63A60A53A0173FF32BD2577BD42DB29D68D450C499D37F4666F80EF1BF2CF45   （= d63a60a5…）
copies gone: True/True
```

（该次对照在上一轮钉住的 `service.js=76d850a3` 上跑；跑完后作者又改了 `service.js`，故上面另记"最终仪器"那次对照的控制结果：LIVE 175/182、OLD 176/182，控制项均绿。两次对照的新增红项完全一致。）

---

## 7. 未验证 / 未覆盖（含原因）

| 项 | 原因 |
| --- | --- |
| live 实例腿（3106 / 3099）：真实 HTTP 面板、真实 `AgentRegistry` 生命周期、真实会话链 | 未开任何 socket（任务边界：只允许临时实例 3106 且不碰 3080；我用进程内 `dispatchBoardCommand` + 真组合工具代替，覆盖面见 §1.1）。**3106 端口未使用，3080 未被访问/重启。** |
| E 阶段内容（`host/runs.js`、`stats.running`/`execSync`、`tests/runs.mjs`、`_rb-debug-smoke`） | 越界；只记录"当前 tree 里这些字段已存在且非空"。 |
| C/D 之外的旧结论（`delegate{revoke}` 幂等、B 阶段 `isOwnedBy` 修复等） | 已在 B 报告里给过判定，本报告不重复。 |
| 归档传递的文档化（"归档链不再往下传"） | 已实测（§3.4），但 task-16 正文/工具描述未写；作为发现记录而非证伪。 |
| `stats.criticalPath` 的"另一口径"（"挡住几条"） | 实现只有"被抬高的条数"一个口径（与正文一致）；另一口径未暴露，无需验。 |
| `update` 空 patch 推进 `rev` | 见 F4，属平台/工具层，未深挖 `expectedRev` 的连带影响。 |

---

## 8. 边界与卫生

- **没有改任何实现文件**：写范围仅 `tests/verification/**`（新增 `cd-verify.mjs`、`cd-composition.mjs`，其余为日志）；变异的 `host/*.js` 副本建在 `tests/verification/_red-cd-{live,old}/` 且**已删除**。
- 没有写 `~/.dsh/**`；没有创建/恢复真实会话；没有开监听端口。
- 临时存储根（`%TEMP%\cd-verify-*`、`%TEMP%\cd-compose-*`）全部清理，剩余 **0** 个。
- 作者仍在并行编辑：`service.js`、`http.js`、`tools.js`、`index.js`、`tests/roles.mjs`、`tests/_rb-debug-smoke.mjs` 都在我跑的过程中变化过；本报告所有 C/D 读数归属 §0.1 的钉住哈希，**此后若 `host/` 再变，请以本报告"_cd_json.txt"等日志为基线重跑一次**（重跑命令见 §1.1，约 3 分钟）。

### 8.1 边界证据（task-20 要求）

```
$ git -C C:\code\deepseek-harness status --short
?? .agents/skills/requirement-board-tasks/
?? .workbuddy/
?? _tmp_27116_10181fa358ba705e7673db06747f9c40
?? _tmp_45252_6baec7e420fff373fba2e8cfdee6264a

$ git status --short -- .artifacts
（空；`.artifacts/` 为忽略目录，故用 digest 而非 git 作实现文件的边界证据）
```

- **没有任何 tracked 文件被修改**（无 ` M ` 行）→ 仓库里的实现文件我一个都没碰；`.artifacts/requirement-board/**` 的写只有本目录（`tests/verification/**`），实现文件的哈希变化全部来自作者（见 §0.1 与 `_cd_digest_*.txt`）。
- 根目录两个 `_tmp_*` 与 `.workbuddy/` 是会话开始前就存在的未跟踪残留，不是我建的；`.agents/skills/requirement-board-tasks/` 是队友按 skill 目录约定新增的。
- `~/.dsh/**`：当前 7713 个文件；45 分钟内变动 11 个，逐条核对都是 **harness 自己的会话记录/工程缓存**（`sessions/*/session.v4.jsonl.zstd`、`storages/session_projcache/*`），我没有对 `~/.dsh/**` 发起任何写入；另有 `profiles/web/cordis.yml`（04:34:11）是并行会话/面板侧的改动，不属于我这条链（我只写 `tests/verification/**`）。
