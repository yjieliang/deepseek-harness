# B 阶段独立验证（task-14）

- 验证人：`composition-verifier`（非实现作者）
- 验证对象：阶段 B「子会话派发 / 临时角色 / 统一收尾 / 所有权端口 / 角色回退 / 挂载期清理」+ Lead 的三条裁决
- 方法：**证伪**。所有判据都由我自己的 instrument 从公开面（service 方法、模型可见工具、prompt 段落、domain 表记录、端口收到的真实入参）测得；不读作者测试常量、不引用作者检查结果作为证据。
- 未改一行实现：`git diff` 为空，改动仅落在 `tests/verification/**`。
- 原始输出：本目录 `_b_*.txt`（下表逐条对应）。

---

## 0 结论摘要

| # | 攻击方向 | 裁决 | 关键证据 |
|---|---|---|---|
| 1 | D19 哈希纪律（基线须覆盖 `tests/*.mjs`） | **证实**（基线已扩到根 `*.js` + `host/*.js` + `tests/*.mjs`） | `b-digest.mjs`；两批运行前后 hash 相同 |
| 2 | `isOwnedBy` 参数契约（最重要目标） | **证伪 → 已修复 → 复验通过** | 修复前 67/69（红）；修复后 `b-delegate` **79/79** ×2 后端 + `b-composition` **17/17** |
| 3 | `roleBefore` 计时 + "调用方自己就能接" | **证实**（链式再派发已按裁决 2 接受） | 改角色后派发 `roleBefore='art'`；二次派发永不为 `tmp-*` |
| 4 | 三路收尾收敛（revoke / disposed / 重复派发） | **证实**（有意差异仅锁模式；另记 1 条 C 阶段事实） | 三份逐字段 close-up |
| 5 | 挂载期 sweep 真清理（非仅 deferred） | **证实** + 旧缺口可复现 | 前后 close-up；旧缺口 mutant 68/73（5 项红） |
| 6 | prompt 分段（`Delegated to you` 仅指名会话、Claimable 降权、面板无） | **证实** | 按段解析 |
| 7 | 队列/锁交互（预留） | **证伪 → 按裁决 1 修复 → 复验通过** | 第三方预留 → `conflict{reserved}`；目标自留 → 收编 |
| — | 先 claim 后 delegate 幂等收编 | **证实** | 锁与 `at` 不动、`roleBefore` 为 claim 当时值 |
| — | 判定表第 3 条命中 | **证实** | 指名会话 claim 成功；非指名 `forbidden{role-mismatch}` |

**两条"能变红"的证据**（详见 §4）：
1. **判据是活的**：把适配器改回传字符串（mutant）→ `b-composition` 13/19，同一套检查在 shipped 上 17/19；shipped 上带 `RB_B_MUTANT=1` 时两条 MUTANT CONTROL 必红。
2. **旧缺口已复现**：把 `sweepDangling` 的结算调用摘掉（mutant）→ `b-delegate` 68/73，5 项 sweep 检查红；同一 instrument 在 shipped 上 72/73，唯一红的是 OLD CONTROL（因为 shipped 已无该缺口）。

---

## 1 方法与边界

### 1.1 instrument

| 文件 | 作用 | 检查数 |
|---|---|---|
| `b-delegate.mjs` | service 层七方向全量（手搭端口，`owns` 端口镜像 `index.js` 适配器） | 79（json）/ 79（sqlite） |
| `b-composition.mjs` | **真实组合**：真 `index.js` + 真 storage 栈 + 平台形状 stub `agents`，走模型可见工具 | 17 |
| `b-digest.mjs` | D19 摘要：根 `*.js` + `host/*.js` + `tests/*.mjs` | — |

运行方式（仓库根）：

```powershell
$env:TSX_TSCONFIG_PATH = 'C:\code\deepseek-harness\tsconfig.json'
node --import tsx/esm .artifacts/requirement-board/tests/verification/b-delegate.mjs
$env:RB_B_BACKEND='sqlite'; node --import tsx/esm ...\b-delegate.mjs
node --import tsx/esm ...\b-composition.mjs
node ...\b-digest.mjs
```

### 1.2 faithful fake 复刻到什么程度（Lead 要求写明）

`b-composition.mjs` 的 stub 只复刻 board 真正读到的平台行为：

**复刻了**
- `isOwnedBy(id, owner)` 的**签名与语义**：`store.get(id)?.owner === owner`，`owner` 为 **Agent 对象、按身份比较**（`packages/core/agent/src/index.ts:578-580` 逐字复刻）。
- `get(id)` / `list()` 返回 Agent，Agent 带 `ctx.presetId`（`composedPreset` 读的字段）。
- 记录**每一次** `isOwnedBy` 的实参（`recordedArgs`），用于断言"边界到底递了对象还是字符串"。

**没有复刻（因此不构成证据）**
- `AgentRegistry` 的 `withInitiator` / 作用域创建 / 生命周期事件（`agent/created` 由测试直接 `ctx.serial` 触发）。
- 真实子会话的 `meta.agentPreset === 父会话预设`（本脚本用 stub 名单直接给定预设）。
- 真实 `Agent` 对象上的 `session`/`store` 内部结构、`resume`、`dispose`。
- 真机 `continuable` 部署前提（`subagentId` 回执）——见 §5。

### 1.3 哈希与并发编辑

`host/service.js` 在我验证期间被 `storage-migration` 连续改写（C 阶段 + Lead 派发的 step-0 修复），其中一个中间态 `REQ_KINDS` 未导入导致套件 `ReferenceError`（**中途状态，不判缺陷**，符合 Lead 指示）。处理方式：

- 每个批次**前后各取一次 digest**，本报告只引用前后一致的批次；
- 修复前的那次观测早于 digest 工具存在，记为"hash 未记录"（原始日志仍在 `_b_run1.txt`），并用**可复现的 mutant** 在已记录 digest 上重现同一失败（§4.1）。

**修复后 digest（24 文件）**

```
5d1c9110-75f1f37c-3f11f627-3f22818c-076bec31-421ae307-adb8a852-a634b06b-8c57717c-ad36b81b
-6bef5699-3f71a501-5a2d41af-3a81763c-5e532c62-57575eab-1a8e4fbd-8e042156-eaa4f20a-02545fd4
-75e53a4c-2444bf68-255d5ea8-372ba7d2
```

文件表（`b-digest.mjs` 同摘要打印，顺序即上串顺序）：`client.js` `index.js` `role.js` `host/{config,dispatch,domain,flow,http,model,roles,service,templates,tools}.js` `tests/{client-smoke,decision,delegate,dispatch,domain,harness,live,loader,queue,roles,smoke}.mjs`。
本次全部结论在此 digest 上测得（批次前后一致，见 `_b_digest_before.txt`/`_b_digest_after.txt`）。

> `storage-migration` 仍在推进 C、作者仍在改套件，同一套 instrument 已在连续多个 revision 上全绿（`host/service.js` `ba9b22a3`→`6bef5699`；期间新增 `tests/decision.mjs`）。最后一次复核时唯一变化的是 `tests/client-smoke.mjs`（`3a81763c`→`e34230ab`），它不在 `delegate.mjs`/`loader.mjs` 的 import 图内，作者可按 §7 复核当前 revision。

> D19 教训：基线必须包含 `tests/*.mjs`。本次正好证明其必要性——作者把 fake 端口从"双字符串"改成"平台形状"会让 `tests/delegate.mjs` 的 hash 变化；若基线不含 `tests/*.mjs`，同一 digest 下"套件绿着错"无法被发现。基线还额外覆盖根 `*.js`（`client.js`/`role.js`），比 Lead 要求更宽。

---

## 2 关键发现：`owns` 端口契约（方向 2）

### 2.1 事实

- 平台：`AgentRegistry.isOwnedBy(id: SessionId, owner: Agent): boolean { return this.store.get(id)?.owner === owner }`（`packages/core/agent/src/index.ts:578-580`；JSDoc 明确 "the expected runtime creator agent"，按**对象身份**比较）。
- 插件端口契约（修复后）：`owns(targetId, callerId) -> boolean | undefined`，由 `service.js:1282-1297` 消费；`index.js:84-92` 的 `createOwnershipPort(ctx)` 是**唯一**把 id 翻成 Agent 的地方，`index.js:147` 接线 `owns: createOwnershipPort(ctx)`。
- 修复前：`host/service.js` 直接 `agents.isOwnedBy(target, caller)`，第二参数是**会话 id 字符串**；`index.js` 把真 `ctx.get('agents')` 原样交给插件，无适配层。

### 2.2 修复前证据（原始日志 `_b_run1.txt`，hash 未记录）

```
FAIL a session delegating to its own sub-session succeeds (spec §5.5 / D17)
     — forbidden/not-owned: session "ses_parent" does not own session "ses_child"
FAIL the binding was written — null
ok   the second argument is a session id string, where the platform requires an Agent
ok   the platform predicate is false for the recorded arguments and true for the owning Agent
67/69 checks passed on the json backend
```

端口收到的实参（我的 fake 记录）：`['ses_child', 'ses_parent']`，`typeof 第二参数 === 'string'`；同一 registry 用父 Agent 对象调用则返回 `true`。

**结论**：真实组合下每个非面板 `delegate` 必落 `forbidden{not-owned}`；面板路径（`who.session === ''`）绕过检查所以可用。这不是"顺序反了"——反序同样为 `false`——而是"把会话 id 当 Agent 传"。

### 2.3 作者的套件为何是绿的（修复前）

`tests/delegate.mjs` 当时的 fake 端口实现的是**双字符串契约** `(child, holder) => holder === 'ses_parent' && child === 'ses_child'`，与平台契约不同；同一场景换成平台形状即红（修复前的 `_b_run1.txt` 里我同时跑了三种形状对照）。修复后作者已按 Lead 要求改成平台形状并加锚点：`tests/delegate.mjs:50-65` 复刻 `AgentRegistry`、`:586` 断言 `typeof call.owner === 'object' && call.owner.id === 'ses_parent'`；套件从 246 → **330/330**。

### 2.4 修复后复验

| 运行 | 结果 | 原始日志 |
|---|---|---|
| `b-delegate` json | **79/79** | `_b_json.txt` |
| `b-delegate` sqlite | **79/79** | `_b_sqlite.txt` |
| `b-composition`（真 `index.js` + 平台形状 stub + 模型可见工具） | **17/17** | `_b_composition.txt` |
| 作者套件 `tests/delegate.mjs` | **330/330** | `_b_author_delegate.txt` |
| 仓库真实组合通道 `tests/loader.mjs` | **53/53** | `_b_loader.txt` |

`b-composition` 的四情形 + 两条路径：

```
ok   the AI path delegates to the caller's own sub-session
ok   the boundary adapter handed the platform a live Agent, not an id      # 实参是 Agent 对象
ok   the platform was asked about the named target
ok   another session's child is refused by the ownership check
ok   the panel path delegates to any session
ok   the panel path asks the ownership predicate for nothing
ok   the model-facing create succeeds through the composition
ok   the adapter resolves the caller id and confirms the owner
ok   another session's child is a decided false
ok   an unknown caller cannot be decided
ok   the panel caller cannot be decided by the adapter
ok   a composition whose registry cannot decide → allowed, 报一次
17/17 checks passed through the composition
```

模型可见的拒绝文本：`Error: session "sess_parent" does not own session "ses_alien"`（明确指出两个会话；机器码 `not-owned` 未出现在模型可见文本里，记为观察项，非缺陷）。

---

## 3 七方向逐项

### 3.1 方向 1：D19 哈希纪律 —— 证实

见 §1.3。每批次前后 digest 一致；`b-digest.mjs` 用截断 SHA256(8) 以 `-` 连接，文件表随摘要打印。并发编辑导致的中间态（`REQ_KINDS` `ReferenceError`）按 Lead 指示不判缺陷。

### 3.2 方向 2：所有权端口 —— 证伪（已修复，复验通过）

见 §2。

### 3.3 方向 3：`roleBefore` 计时 —— 证实

- `create → claim → update{role:'art'} → complete（放锁）→ delegate`：**字面序列不可达**——`delegate` 对 done 任务返 `invalid-state`（`service.js` 前置；§5.5「任务未归档未完成」）。补一步面板 `reopen` 后：`roleBefore === 'art'`（取派发时当前值，不是创建时值）✓。
- `revoke` → `role` 回 `'art'`、`delegatedTo === null`、临时角色行删除 ✓。
- 二次派发（revoke → 新会话）：`roleBefore === 'art'`；替换活跃委托同样 `'art'`；任务上**只有一个** `tmp-*` 行 ✓。即"收编时读到的值永远不可能是 `tmp-*`"成立。
- 链式再派发（临时角色持有者把任务派给自己的子会话）：`effectiveRole = bound.roleBefore` + `#relatedTo` 通过，**被接受**（`_b_json.txt` note）；按裁决 2 接受，非缺陷，建议文档写明。
- "§5.5 前置按收尾后 role 判定"：判定口径是"调用方对 `roleBefore` 有资格"＋"是创建者/owner/成员"，与"自己就能接"一致；持有 `tmp-*` 的会话不会因此获得额外资格（`roleIdOf` 只走预设链）。

### 3.4 方向 4：三路收尾收敛 —— 证实（1 条有意差异 + 1 条 C 阶段事实）

同一初始态（role `art` → 派发 → 子会话 claim）分别走三条路径，逐字段 close-up：

```
revoke   {"role":"art","delegatedTo":null,"lock":null,"tempRoleRow":null,
          "history":"create,claim,release,delegate,claim,revoke-delegation"}
dispose  {"role":"art","delegatedTo":null,
          "lock":{"session":"ses_child",...,"orphaned":true},"tempRoleRow":null,
          "history":"create,claim,release,delegate,claim"}
replace  {"role":"tmp-<id>","delegatedTo":{"session":"ses_child2","roleBefore":"art",...},
          "lock":null,"tempRoleRow":{...boundSession:"ses_child2"...},
          "history":"create,claim,release,delegate,claim,revoke-delegation,delegate"}
```

- `revoke` 与 `disposed` 在 `role`/`delegatedTo`/临时角色行上**完全一致**，只有锁模式有意不同：`release` vs `orphan`（`orphaned:true` 表示"谁持过锁"可见，且立即可接管）。
- 重复派发是**替换**而非终结：旧委托被结算后铸造新绑定（`revoke-delegation` 后跟 `delegate`），其结算步与 `revoke` 一致。
- `dispose` 不写 history（生命周期工作不写历史），`revoke` 写 `revoke-delegation` ✓。
- **事实（C 阶段待办，我不修）**：`revoke` **不释放**目标会话对该任务的软预留（队列行仍在）——`ok revoking leaves the target session's soft reservation in place`；`dispose` 会释放（其职责）。

### 3.5 方向 5：挂载期 sweep 真清理 —— 证实（旧缺口可复现）

构造：派发 → 子会话 claim → 子会话从 live registry 消失 → 重开 service 执行 `sweepDangling()`：

```
before   {"role":"tmp-req_ef2c…","delegatedTo":{"session":"ses_child","roleBefore":""},
          "lock":{"session":"ses_child","name":"子","at":…,"touchedAt":…},   # 尚无 orphaned 字段
          "tempRoleRow":{…"source":"delegated","ephemeral":true…}}
report   {"dangledDelegations":["req_ef2c…"],
          "settledDelegations":[{"id":"req_ef2c…","roleId":"tmp-req_ef2c…"}],
          "deferred":[{"reference":"blocksOn",...}]}          # 已无 delegatedTo
after    {"role":"","delegatedTo":null,
          "lock":{"session":"ses_child","orphaned":true},"tempRoleRow":null}
```

- 真结算：临时角色行删除、`role` 回退、`delegatedTo` 清空、死持有者锁标 `orphaned`（可立即接管）✓
- `deferred` 不再含 `delegatedTo` 类 ✓
- 仅临时角色行缺失而持有者仍 live：结算但**保留锁**（`keep`），`lock.at` 不变 ✓
- 无 registry 时：`deferred` 明确报告"无法判断"并**不动**绑定（这是有定义的降级，真实组合总有 registry）✓

### 3.6 方向 6：prompt 分段 —— 证实（按段解析，非全文 contains）

- 指名会话：有 `Delegated to you` 段，段内含任务 id 与它对该任务的临时角色 id；该任务**不再**出现在它的 `Claimable` 段 ✓
- 存在待接指派时 `Claimable` 首行降权为"…only after the delegated work above" ✓
- 其他会话 prompt 无该段 ✓；面板 prompt 两段皆无 ✓

### 3.7 方向 7：队列/锁交互 —— 证伪（已按裁决 1 修复，复验通过）

- 修复前：`delegate` 不看预留 → 第三方预留时派发成功，被指名会话随后 `claim` 得 `conflict{reserved}`（"派了也接不了"）。记为待裁决项报 Lead。
- 裁决 1 落地后复验：第三方持有软预留 → `delegate` 返 **`conflict{reserved}`** 且**不写**任何记录（`delegatedTo` 仍 null、无临时角色行）；预留者恰为目标会话 → **合法收编**（派发成功，目标随后 claim 成功）✓
- 指名会话持另一把锁时 claim → `conflict{session-busy}` ✓；重复 claim 幂等（同锁、`at` 不变）✓

### 3.8 其他（B 核心路径）

- mint/binding：`roleId === 'tmp-<任务id>'`，需求 `role` 指向它，行 `source:'delegated'` + `ephemeral:true` + `boundSession`/`boundTask`，duties/name 落库，history `delegate` ✓；`tmp-*` 前缀面板不可手工声明（`invalid-role`）、不可手删（`conflict`）✓
- 先 claim 后 delegate：幂等收编，锁与 `at` 不变，`roleBefore` 为 claim 当时值（`''`）✓
- 判定表第 3 条：指名会话 claim `tmp-*` 任务成功；非指名 `forbidden{role-mismatch}` ✓
- 任务文本称 `source:'ephemeral'`，实测为 `source:'delegated'` + `ephemeral:true`（以代码为准，已更正）

### 3.9 其余前置条件（§5.5 逐条）—— 证实

| 调用 | 结果 |
|---|---|
| `delegate` 给调用方自己 | `invalid-input{delegate-to-self}` ✓ |
| 与任务无关的会话派发（既非创建者/owner/成员） | `forbidden{not-related}` ✓ |
| 角色不符的调用方派发按 `art` 路由的任务 | `forbidden{role-mismatch}`（角色门先于关系门）✓ |
| 已完成 / 已归档任务 | `invalid-state{invalid-state}` ✓ |
| 不存在的任务 | `not-found`（`details` 带 `id`，无 `reason`）✓ |
| 未委托的任务上 `delegate{revoke:true}` | **幂等空操作**：返回记录不变、不写任何东西、不报错（记为事实，非缺陷；是否应报 `invalid-state` 交 Lead 决定）✓ |

---

## 4 两条"能变红"的证据（可复现）

两个 mutant 都在 `tests/verification/` 内生成、运行后**已删除**；复现命令如下（均在 `tests/verification/` 下执行）。

### 4.1 判据是活的：适配器改回传字符串

```powershell
New-Item -ItemType Directory -Force _red-adapter\host | Out-Null
Copy-Item ..\..\index.js _red-adapter\index.js -Force
Copy-Item ..\..\host\*.js _red-adapter\host\ -Force
$t = Get-Content _red-adapter\index.js -Raw
$t2 = $t -replace 'const owner = agents\.get\(caller\)\r?\n\s*if \(owner === undefined\) return undefined\r?\n\s*return agents\.isOwnedBy\(target, owner\) === true', 'return agents.isOwnedBy(target, caller) === true'
[System.IO.File]::WriteAllText("$PWD\_red-adapter\index.js", $t2)   # → 88: return agents.isOwnedBy(target, caller) === true
$env:RB_B_INDEX='./_red-adapter/index.js'; $env:RB_B_MUTANT='1'
node --import tsx/esm b-composition.mjs
```

| 运行 | 结果 |
|---|---|
| mutant 适配器 + `RB_B_MUTANT=1` | **13/19**，真检查 6 项红；`MUTANT CONTROL` 两项绿 |
| shipped + `RB_B_MUTANT=1` | **17/19**，唯一红的正是两条 `MUTANT CONTROL` → **判据确实能区分** |

mutant 上的红（节选）：

```
FAIL the AI path delegates to the caller's own sub-session
     — Error: session "sess_parent" does not own session "sess_child"
FAIL the boundary adapter handed the platform a live Agent, not an id — string "sess_parent"
FAIL an unknown caller cannot be decided — false
FAIL the panel caller cannot be decided by the adapter — false
```

日志：`_b_comp_mutant.txt`（mutant）、`_b_comp_mutantcontrol.txt`（shipped 对照）。

### 4.2 复现旧缺口：sweep 只检测不结算

```powershell
New-Item -ItemType Directory -Force _red-copy-b\host | Out-Null
Copy-Item ..\..\host\*.js _red-copy-b\host\ -Force
$s = Get-Content _red-copy-b\host\service.js -Raw
$s2 = $s -replace 'const settled = await this\.#settleDelegation\(id, \{ lock \}\)', "const settled = { roleId: '' }"
[System.IO.File]::WriteAllText("$PWD\_red-copy-b\host\service.js", $s2)   # sweepDangling 内不再结算
$env:RB_B_SERVICE='./_red-copy-b/host/service.js'; $env:RB_B_OLD='1'
node --import tsx esm b-delegate.mjs
```

| 运行 | 结果 |
|---|---|
| shipped + `RB_B_OLD=1` | **72/73**，唯一红的是 `OLD CONTROL`（shipped 已无旧缺口）→ 旧缺口判据是活的 |
| mutant sweep + `RB_B_OLD=1` | **68/73**，5 项真检查红、`OLD CONTROL` 绿 → **旧缺口被复现** |

mutant 上的红：`settledDelegations` 空、`role` 仍 `tmp-*`、`delegatedTo` 未清、临时角色行仍在、死持有者锁未标 orphan、缺行案例未修复。日志：`_b_delegate_oldcontrol.txt`、`_b_delegate_mutant.txt`。

---

## 5 未验证项与理由（不冒充已验）

| 项 | 状态 | 理由 |
|---|---|---|
| 真机 `continuable` 派发链（起真子会话 → `subagentId` → `delegate` → `send_message`） | **未验证** | 需创建真实子会话与写 `~/.dsh`，任务边界禁止；属 §6「四条人工验收」第 ③ 条 |
| 3105 临时实例上的活通道 | **未验证（有意跳过）** | B 的端口/工具/HTTP 语义已在 `b-composition`（真 `index.js`）与 task-8 的活通道验证中覆盖；本次未开任何 socket，3080 未收到请求 |
| 真实 `AgentRegistry` 实例（`withInitiator`/作用域/生命周期） | **未验证** | 只复刻了 `isOwnedBy` 谓词与 `get`/`list`；见 §1.2 范围声明 |
| 仓库级"1330 检查全绿" | **部分验证** | C 正在改 `host/**`，只在本 digest 上重跑 B 相关两套：`delegate.mjs` 330/330、`loader.mjs` 53/53；作者新增的 `tests/decision.mjs` 未复核，其余套件未在本次 digest 重跑 |
| `tests/decision.mjs`（作者新加，24 文件基线新成员） | **未验证** | 不在 task-14 范围；D19 基线已自动纳入其 hash，本报告未判其内容 |
| `delegate{revoke}` 结算 `executions[]` | **未验证** | 属 E 阶段（执行同步）范围 |
| 模型可见错误文本是否带机器码 | **观察** | 文本为 `Error: session "…" does not own "…"`，无 `not-owned` 字面；信息足够，非缺陷 |
| 无 registry / 调用方不可解析时的降级 | **证实但记录** | `owns` 缺失或返回 `undefined` → 允许 + **只报一次**（`degraded`/`undecided` 两处检查）；调用方不在 registry 中同样走降级，属防御纵深缺口而非本例缺陷 |

---

## 6 教训（Lead 指定）

1. **fake 与真实平台谓词不同 → 套件绿、真机必红。** 作者的旧 fake 把 `isOwnedBy` 实现成"双字符串"；平台按 Agent 对象身份比较。同一句 `delegate` 在 fake 下通过、在真实组合下必拒。契约型端口（谁的参数是对象、谁是字符串）**必须有平台形状的 fake 断言**，否则单测通过毫无意义。
2. **D19 基线必须含 `tests/*.mjs`。** 作者改 fake 端口会让测试文件 hash 变化；不含测试文件的 digest 会漏掉"绿着错"。本报告基线还含根 `*.js`。
3. **判据要能变红才算验证。** 三条控制：mutant 适配器 13/19 vs shipped 17/19；shipped+`RB_B_MUTANT=1` 必红；mutant sweep 68/73 vs shipped+`OLD=1` 72/73。
4. **契约形状只许出现在一个地方。** 修复把平台签名收进 `index.js:createOwnershipPort`，board 只认 `owns(id, id)`——这正是"enforce a decision in the operation that makes it"的正面例子：契约转换在边界，插件内部不知道 Agent 是什么。
5. **并发编辑下的验证纪律**：批次前后取 digest、只在 digest 一致时下结论；中间态（`REQ_KINDS`）不判缺陷；修复前的历史观测若无 digest 就如实标注，并用带 digest 的 mutant 补证。

---

## 7 复验清单（供 Lead/author 复核）

```powershell
$env:TSX_TSCONFIG_PATH = 'C:\code\deepseek-harness\tsconfig.json'
cd C:\code\deepseek-harness\.artifacts\requirement-board\tests\verification
node b-digest.mjs                                     # 期望 23 文件，见 §1.3（service.js 随 C 推进会变）
node --import tsx/esm b-delegate.mjs                  # 79/79
$env:RB_B_BACKEND='sqlite'; node --import tsx/esm b-delegate.mjs; $env:RB_B_BACKEND=''   # 79/79
node --import tsx/esm b-composition.mjs               # 17/17
node --import tsx/esm ..\delegate.mjs                 # 330/330
node --import tsx/esm ..\loader.mjs                   # 53/53
```

## 8 边界证明

- `git status --short`：仅 4 条既有未跟踪项（`.agents/skills/requirement-board-tasks/`、`.workbuddy/`、`_tmp_27116_*`、`_tmp_45252_*`）；`git diff --stat` 空 → **未改一行实现**。
- `~/.dsh` 文件数：验证前后均为 **7713**，未写 Harness home、未创建真实会话。
- 未访问 3080、未开监听端口、未启动 3105。
- 临时存储根 `%TEMP%\b-verify-*` / `b-compose-*`：运行后清理（含此前崩溃遗留 11 个，清至 0）。
- mutant 副本 `_red-adapter/`、`_red-copy-b/` 运行后已删除，复现命令见 §4。
- 我的写入范围：仅 `tests/verification/**`（`b-delegate.mjs`、`b-composition.mjs`、`b-digest.mjs`、本报告、`_b_*.txt` 原始日志）。
