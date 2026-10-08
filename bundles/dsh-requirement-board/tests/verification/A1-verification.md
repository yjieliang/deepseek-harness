# A1 独立验证报告（task-8）

- 验证者：`composition-verifier`（独立成员，非实现者；实现者为 `storage-migration`）
- 被测对象：`.artifacts/requirement-board` 的 A1 角色与解析链（`ROLE-DISPATCH.md` §9「A1 角色与解析链」完成定义、§10 测试策略相关条目）
- 判定口径：每条完成定义给 **已验证 / 未验证 / 反证成立**，并附**我自己的命令与原始输出**；实现者的断言与结论一律不作为证据。
- 结论摘要：**§9-A1 的 7 条 smoke 判据 + 1 条 live 判据中，6 条已验证，2 条部分验证（分项列出），另有 8 项明确未验证**。未发现实现缺陷；发现 1 项**判据与实现措辞不一致**（见「观察 A」，非缺陷）与 1 项**仓库缺口**（§10 的 recorded-session snapshot pin 不存在，见未验证 §5）。红证据齐备（见 §5）。

## 1. 复现命令

三个独立 instrument，均在仓库根目录运行。前两个不需要网络、不建会话、不写 `~/.dsh`；第三个会短暂启动 `dsh web`（3101/3102）并在结束时停掉。

```sh
# 1) 真组合通道（Loader + 子进程，5 个场景）
node --import tsx/esm .artifacts/requirement-board/tests/loader.mjs

# 2) 进程内独立复现（真实 storage/tools/systemPrompt + 真实 role.js，假 agents/agentPresets）
$env:TSX_TSCONFIG_PATH = 'C:\code\deepseek-harness\tsconfig.json'   # pwsh；bash 用 TSX_TSCONFIG_PATH=...
node --import tsx/esm .artifacts/requirement-board/tests/verification/a1-chain.mjs

# 3) live：预设 roster 与面板 CRUD（3101 正例，3102 两个反例，逐个启停）
node .artifacts/requirement-board/tests/verification/live-presets.mjs
```

第 3 项的启动形式（`--patch` 必须出现在 booted app 的参数之前，否则 `passThroughOptions` 会把它们当成 app 参数）：

```sh
pnpm dsh --profile web --patch .artifacts/requirement-board/dev.overlay.yml \
  --patch .artifacts/requirement-board/tests/verification/live-storage-isolation.overlay.yml \
  --no-open --port 3101
```

第 3 项的 phase 2/3 需要两个**仅验证用**的反例覆盖层；按 Lead 要求用完即删，全文如下（重现时先写回这两个文件）：

`tests/verification/negative-human-declaration.overlay.yml`

```yaml
- insert:
    - id: preset-verification-human
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: verification-human
        name: Verification human declaration
        order: 90
        plugins:
          - id: verification-human-role
            name: cordis:group
            group: true
            isolate:
              requirementBoardRole: true
            config:
              - id: board-role-human
                name: dsh-requirement-board/role
                config:
                  roleId: human
                  roleName: Verification human
                  duties:
                    - must be refused
```

`tests/verification/negative-unisolated-declaration.overlay.yml`

```yaml
- insert:
    - id: preset-verification-unisolated
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: verification-unisolated
        name: Verification unisolated declaration
        order: 91
        plugins:
          - id: board-role-unisolated
            name: dsh-requirement-board/role
            config:
              roleId: verification-unisolated
              roleName: Verification unisolated
              duties:
                - must not leak
```

> 清理说明：这两个反例覆盖层按 Lead 要求已在使用后删除。`live-presets.mjs` 检测到文件缺失时会打印 `skip:` 并只跑 phase 1（打印 9/9），因此重现完整 19/19 需先按上面的内容写回这两个文件。

## 2. 被测版本（哈希 + 修改时间）

实现者的 `host/**` 在我的验证期间被并发修改，故记录三组版本。**R3 是三个 instrument 全部为绿的同一组哈希**；R1/R2 上的绿结果也附上，用于说明没有「只在某一侧通过」。

| 文件 | R1（我的基线，peer 改动前） | R2（peer 02:16–02:20 改动后） | **R3（最终，三 instrument 同版）** |
| --- | --- | --- | --- |
| `index.js` | BB1EA985A4D16263 | BB1EA985A4D16263 | **BB1EA985A4D16263** @01:58:02 |
| `role.js` | 3F11F627B715E277 | 3F11F627B715E277 | **3F11F627B715E277** @01:56:35 |
| `client.js` | E3EDE10C4A589F38 | E3EDE10C4A589F38 | **E3EDE10C4A589F38** @10-03 18:28:59 |
| `host/config.js` | C42FC91145B7455F | 3E2AACCF51D85561 | **3E2AACCF51D85561** @02:16:53 |
| `host/domain.js` | 37F6F61B4FB7D3EC | 2278875A7BDEAE9D | **2278875A7BDEAE9D** @02:16:46 |
| `host/http.js` | DD04760737237358 | E285BAD6F581A166 | **E285BAD6F581A166** @02:20:29 |
| `host/model.js` | 355AEB55E38EB624 | D318E9A5F86DD44B | **D318E9A5F86DD44B** @02:19:44 |
| `host/roles.js` | 8B4E33E48462E479 | 31B6EED6B7B23A26 | **31B6EED6B7B23A26** @02:17:25 |
| `host/service.js` | F0F3AD2F497E7BD6 | 477F59C0449203D6 | **D356A8EEA2CEA3F8** @02:29:19 |
| `host/tools.js` | 8CBC4B71748E79CA | 0136C6EA23B57F56 | **0136C6EA23B57F56** @02:20:16 |
| `host/dispatch.js` | （未测到） | 01B63FF9618B5666 | **01B63FF9618B5666** @02:16:37 |
| `host/flow.js` | ADB8A8524E998883 | ADB8A8524E998883 | **ADB8A8524E998883** @10-03 17:48:35 |
| `host/templates.js` | 3F71A501F189D901 | 3F71A501F189D901 | **3F71A501F189D901** @10-03 15:39:07 |

运行与版本对照（本地时间）：

| 运行 | instrument | 版本 | 结果 |
| --- | --- | --- | --- |
| 02:15 | 真组合通道 | R1 | `53/53 checks passed`，exit 0 |
| 02:22 | `a1-chain.mjs` | R2 | `36/36 checks passed`，exit 0 |
| 02:24 | 真组合通道 | R2 | `53/53 checks passed`，exit 0 |
| 02:30–02:33 | live 三段 | R2→R3（`service.js` 于 02:29:19 变化，三段均在其后启动） | `19/19 checks passed`，exit 0 |
| 02:36 | `a1-chain.mjs` | R3 | `40/40 checks passed`，exit 0 |
| 02:38 | 真组合通道 | R3 | `53/53 checks passed`，exit 0 |

**关于「红即 mid-edit」的处理**：本轮从未出现可归因于实现的红，因此未触发「同哈希复跑一次」；唯一跨版本变化的文件是 `host/service.js`（02:29:19），其前后两侧（R2 与 R3）均为绿。所有红都来自我自己的断言/线格式错误，逐条列在 §5，以免把「我的错」或「真缺陷」混为一谈。

## 3. 逐条判定（§9-A1 完成定义）

| # | 完成定义 | 判定 | 我的证据 |
| --- | --- | --- | --- |
| 1 | 解析链三态 | **已验证** | `a1-chain.mjs` [1]/[1b]/[1c]：声明态 `source=preset` + 2 条职能；兜底态 `source=observed`、`dutiesMissing=true`、`duties=[]`；无 registry 态不建记录、prompt 无角色段。真组合 `role-resolution` 用真 `ctx.systemPrompt.assemble()` 复核 |
| 2 | 建档去重（无变化零写入） | **已验证** | 自己订阅 `domain/changed` 计数：首次 >0 帧，**第二次恰 0 帧**且记录字节不变（`a1-chain` [2]）；真组合同一断言（`roleFrames.repeat === 0`） |
| 3 | 建档失败不影响创建 | **已验证** | 介质级故障（unit 路径变目录）下 `agent/created` 串行派发仍 resolve、**恰 1 条** warn 且点名会话（`a1-chain` [3]）；`Promise.all` 双派发不 reject、各 1 条 warn（[3b]）；真组合 `throwing-store` 11/11 硬断言通过 |
| 4 | 声明 `human` 被拒 | **已验证** | 挂载即抛 `invalid-role`（`role.js` + `human`）；面板 409 + 机器码；`tmp-` 前缀同样 409（`a1-chain` [4]）；live：反例预设 roster 报 broken 且文案为 `"human" is reserved for the human decision-maker...`；live 面板 HTTP 409 复现（phase 1） |
| 5 | 未登记角色 → `unregistered` | **已验证** | `requirement_role{list}` 的 `unregistered` 含在用但无记录的 id，`holders.online=1`、`dutiesMissing=true`，且 `items` 中无该 id（`a1-chain` [1]；真组合同断言） |
| 6 | 缺职能 → `dutiesMissing` | **已验证** | 兜底角色行 `dutiesMissing=true` 且 prompt 写 `no duties recorded, so this role cannot be routed by function`（[1]） |
| 7 | sweep 清掉 **4 类**悬挂引用 | **部分验证 2/4；其余 2 类未验证且已证「非静默跳过」** | 孤儿 `tmp-` 角色已清、挂队列幽灵项已清（含混合队列只删幽灵项）、无悬挂的 `tmp-keep` 保留；日志 `startup sweep removed 1 orphan temporary role(s) and 2 dangling queue item(s); 2 reference class(es) are not checked yet (delegatedTo, blocksOn)`。`blocksOn` 属阶段 D、`delegatedTo` 属阶段 B，当前记录**没有**这两个字段，故这 2 类无法在 A1 被清；实现把它们作为 `deferred` 具名上报（`a1-chain` [5] `deferred` 断言）。判据「4 类」在 A1 不可满足，实现未隐瞒该差距 |
| 8 | live：角色 CRUD 只走面板 | **已验证** | live phase 1 真 HTTP：`role.put` 200 + `source=manual`、`role.list` 可见、`role.delete` 200、`human` 409；模型侧 `requirement_role` schema 只有 `action: ['list']`（我从真实工具表读的 schema），非 `list` 动作被拒（`a1-chain` [4]、真组合 `role-resolution`） |

§9-A1「内容」列逐项：

| 内容项 | 判定 | 证据 |
| --- | --- | --- |
| 预设声明解析 | **已验证** | 真 `role.js` 行 + 真 Loader 挂载；live 反例 broken 文案逐字来自该行 |
| `roles` 表 | **已验证** | 记录经 `requirement_role{list}`、面板 HTTP、以及介质文件三处读回 |
| 四种建档来源 | **3 种已验证；`delegated` 的「保护规则」已验证、其「铸造」未验证** | preset/observed/manual 均有正向证据；`delegated` 无生产者（阶段 B），但已证声明与兜底都**不覆盖** `manual`/`delegated` 记录且零写入（[1c]） |
| `agent/created` 建档 | **已验证** | 真 `ctx.serial('agent/created')` 路径，真组合与进程内各一遍 |
| `requirement_role{list}` | **已验证** | schema `properties={action}`、`enum=['list']`、`additionalProperties=false`；返回 `{items, unregistered}` |
| `human` 保留字校验 | **已验证** | 见 #4（挂载点、面板、live 反例三处） |
| prompt 角色段 | **已验证** | 真 `systemPrompt.assemble({scope})` 文本含 `You are role "art" (Art Director) — 美术与音频资产规范, 资产合规清单.`；全局装配无角色段 |
| 面板角色与筛选 | **角色：已验证；筛选：未验证** | 角色 CRUD 见 #8；面板**筛选**属客户端 UI，我的三个 instrument 均不覆盖 |
| 启动 sweep | **已验证（2/4 类，见 #7）** | 两次挂载共享同一介质；第二次挂载后读介质记录 + 读日志 |

原始输出（节选，全文见运行日志）：

```text
# node --import tsx/esm .artifacts/requirement-board/tests/loader.mjs   （R3）
role resolution (end-to-end, real Loader)
  ok      the declared preset role was established through the registration chain
  ok      the preset realm hides the declaration from the root realm
  ok      the real prompt assembly names the declared role and its duties
  ok      an undeclared preset falls back to its preset id with no duties
  ok      a role id in use but unrecorded is reported as unregistered
  ok      an identical second establishment writes nothing
  ok      the global assembly carries no role line
  ok      the role tool schema exposes only list
  ok      the model cannot manage roles through the tool
throwing store (建档 failure)
  ok      agent creation survives a throwing 建档 store write
  ok      the contained 建档 failure logged exactly one requirement-board warn naming the session it ignored
53/53 checks passed
```

```text
# node ... tests/verification/a1-chain.mjs   （R3）
[3] 建档 store failure does not break the creation dispatch
  ok   the creation dispatch resolves despite the failing role write
  ok   exactly one structured warn names the session it ignored
  ok   the medium really is broken (the board tool reports the failed write)
[3b] concurrent failing registrations are each contained
  ok   Promise.all of two failing creations does not reject
  ok   each failed registration produced exactly one warn
[4] human is reserved: the declaration row and the panel
  ok   mounting role.js with roleId "human" throws invalid-role
  ok   the panel refuses roleId "human" with 409 and the machine code
[5] startup sweep of dangling references
  ok   the orphan temporary role was removed
  ok   a temporary role bound to a live task was kept
  ok   a queue holding only dangling items was removed
  ok   a mixed queue kept the live item and dropped the dangling one
  ok   the two unimplemented reference classes are named as deferred, not skipped silently
40/40 checks passed
```

```text
# node ... tests/verification/live-presets.mjs   （R3，三段）
phase 1 — positive control (dev.overlay.yml), port 3101
  ok   the live panel creates a role / lists it with its manual source / refuses roleId "human" with 409 / deletes it
  ok   the live roster answers over the product RPC channel
  ok   the live roster carries all eight shipped presets
  ok   every preset activates: no preset is broken
phase 2 — negative control (roleId "human"), port 3102
  ok   a declaration whose roleId is "human" makes its preset broken for that reason
phase 3 — negative control (declaration outside its isolate group), port 3102
  ok   a declaration without its isolate group makes its preset broken
19/19 checks passed
```

live 原始 roster（正例，节选）：8 条、`broken` 全为 null、`godot-review-board` 为 `isDefault`：

```json
[{"id":"standard","isDefault":false,"broken":null},{"id":"ptc","isDefault":false,"broken":null},
 {"id":"minimal","isDefault":false,"broken":null},{"id":"cordis","isDefault":false,"broken":null},
 {"id":"godot-review-board","name":"Godot 项目评审团","isDefault":true,"broken":null},
 {"id":"godot-game-suite","name":"银橙AI · Godot 引擎开发专家","isDefault":false,"broken":null},
 {"id":"game-mechanics-designer","name":"机枢 · 游戏机制与数值设计师","isDefault":false,"broken":null},
 {"id":"godot-shader-developer","name":"渲染达 · Godot 着色器开发者","isDefault":false,"broken":null}]
```

live 反例 `broken` 文案（逐字，来自 `/rpc`→`/api` 的真实响应）：

```text
verification-human        → board-role-human (dsh-requirement-board/role): "human" is reserved for the human decision-maker and cannot be declared as an AI role
verification-unisolated   → Preset services require isolate realms: requirementBoardRole
```

`dev.overlay.yml` 声明生效性：**已验证**。正例 `total=8, broken=0`；两个反例各自 broken 且 8 个作者预设仍全绿（归因清晰）。

## 4. 独立复核过的实现事实（不依赖作者结论）

- 隔离语义我自己探过：`ctx.isolate('<svc>')` 内提供的服务在根不可见、域内可见；未进隔离表的服务提供方会进程级可见 —— 这正是 `verification-unisolated` 被 registry 判 broken 的机制。
- 真实工具表读出的 `requirement_role` schema（我从 `tools.schemas()` 读的，不是作者断言）：`{ type:'object', properties:{ action:{ type:'string', enum:['list'] } }, required:['action'], additionalProperties:false }`。
- `promptLine()` 只读 `resolveOwn()`（声明/兜底），不读 `roles` 表 —— 见「观察 A」。
- sweep 的删除条件与 `deferred` 文案来自 `host/roles.js` 的真实行为（两次挂载实测），不是读注释得出的结论。

## 5. 红证据（证明判据是活的）

1. **live 反例**：`verification-human` 与 `verification-unisolated` 各使 roster 出现 broken；若正例 `broken=0` 是空判据，这两条不可能同时成立。
2. **live 线格式摸索（真实红）**：roster 请求最初以 `/rpc/...`、`method:'list'`、`payload:{}` 发出，分别得到 405、`method does not match endpoint`、`payload must contain exactly one plain-object args field`，对应检查项从 `8/15`、`11/19` 失败到 `19/19` 通过 —— 说明「8 条预设」「broken=0」这些断言会真的失败。
3. **`a1-chain` 首次红（我自己的断言错，非实现缺陷）**：`39/40`，红项是我把「prompt 用存储行名称」当成期望；按 §476 修正为「prompt 用 `presetRole`」后转绿。这条红证明该用例确实执行到产品行为。
4. **同 harness 另两处我自己的红并已修正**：把 `ctx.serial` 返回值当成 `undefined`（实际返回末个监听器返回值）；sweep 期望 1 条队列幽灵项（实际两个队列各一条共 2 条，日志为 `2 dangling queue item(s)`）。
5. **通道红（task-6 记录，同一通道）**：把路由键改成 `missing-backend` 时 `3 FAIL`、条目 `pending (waiting for service: storageDomain)`、`waitedMs 20007`、exit 1；`A1_STORE_CONTAINMENT_LANDED=false` 时跑出 `36/36 … (stage A1 containment checks are pending)`，翻成 `true` 后同一门禁变为硬断言并通过 —— 门禁与失败路径都是活的。

## 6. 边界与污染检查

- **仓库受控文件**：`git status --short` 仅 4 条**既有**未跟踪项（`.agents/skills/requirement-board-tasks/`、`.workbuddy/`、两个 `_tmp_*`），`git diff --name-only` 与 `git diff --cached --name-only` **均为空** → 未改动任何受控文件。`.artifacts/` 由 `.gitignore:40` 忽略（`git check-ignore -v` 已核）。我自己在仓库根临时产生的 `_tmp_dump.txt/_tmp_dump.err/_tmp_live_out.txt` 已删除。
- **`~/.dsh`**：验证开始前/结束后各做一次全量快照（排除 `node_modules`、`cache`；`path+size+mtime+sha256`，共 525 个文件）。差异**仅 4 个文件、0 新增、0 删除**：
  - `sessions/--C-code-deepseek-harness--/c8ef4bf4-…/session.v4.jsonl.zstd`（18:30:25Z）
  - `sessions/--C-code-deepseek-harness--/56001337-…/session.v4.jsonl.zstd`（18:30:24Z）
  - `storages/session_projcache/sessions/c8ef4bf4-….json`、`…/56001337-….json`（18:30:20–22Z）
  这 4 个是**两个已存在的 agent 会话**（本会话与并发同伴会话）自身的日志/缓存追加，快照前它们就存在（`sessions/…c8ef4bf4…` 02:24 已在最新 5 条内）；`dsh web` 的启动不会创建会话，且我的 live run 期间没有任何 `~/.dsh/sessions/<新 id>` 出现。live 面板 CRUD 的落盘在我自设的隔离库 `tests/verification/live-board.db`，不在 `~/.dsh`。
- **端口**：`3080` 自始至终**未发送任何 HTTP 请求**（只用 TCP 可达性探测确认它仍在监听，前后一致 `listening=True`）；`3101/3102` 逐个启停，结束时均 `listening=False`；3099 是同伴的 live 服务，我未接触（且用隔离库避免与其共享 `dev-board.db`）。
- **未建会话**：三个 instrument 都没有启动 agent/session；`agent/created` 是本地串行派发或 stub roster。

## 7. 明确未验证项（含原因）

1. **真机会话创建路径下的「建档失败不连累创建」**：明令不建会话，故该判据是在「本地 `ctx.serial('agent/created')` + stub agents」上验证的；真机 `Agent` 创建链路未覆盖。
2. **sweep 的 `blocksOn` / `delegatedTo` 两类**：对应字段随阶段 D / B 到来，A1 的记录里不存在（实现已具名 `deferred`）。
3. **`delegated` 来源的铸造**：阶段 B 才有生产者；我只验证了它的保护规则。
4. **面板筛选 UI**（`status/owner/session/priority/query` 筛选的界面行为）：客户端，未由我的 instrument 覆盖。
5. **§10 的 recorded-session snapshot pin（含首轮工具 schema 字符数上限断言）在仓库中不存在**：`snapshots/` 全树 grep `requirement_board|requirement-board|You are role` 无命中，artifact 内也没有「该插件为何不能进 snapshot 树」的替代说明 —— 这是**缺口**，不是 A1 的行为缺陷，但按 §483/§562/§587 应补。
6. **sweep / 去重只在 JSON 后端上验证**：live（sqlite 路由）只跑了 roster + 面板 CRUD，未在 sqlite 上重放 sweep/去重（同一 domain 层，风险低，但确实未测）。
7. **作者 `dev.overlay.yml` 的 `dev-board.db` 路径未被我的 live run 覆盖**：为避免与 3099 共享可变状态，我用 `live-storage-isolation.overlay.yml` 把 `storage-sqlite.path` 改到 `tests/verification/live-board.db`（其余预设行与声明完全是作者的）。该覆盖层同一处也是 A2 自证的载体。
8. **prompt 段的可回放性（"model-visible ⟺ logged"）**：未验证 `systemPrompt.context` 的落盘/重建方式。

## 8. 观察（非缺陷，需 Lead 裁决或后续阶段处理）

**观察 A —— prompt 角色段与面板手工编辑的关系。** `host/roles.js` 的 `promptLine()` 只调用 `resolveOwn()`（预设声明或预设 id 兜底），**从不读 `roles` 表**。这与 §476「角色段：`presetRole` + 职能」一致，但我实测到一个后果：把同名 id 的角色以 `source: 'manual'` 写进表（面板改名/改职能）后，`requirement_role{list}` 与面板显示的是手工值，而模型看到的 prompt 仍是预设声明的名称与职能（`You are role "art" (Art Director) — 美术与音频资产规范, 资产合规清单`，而非 `Hand-made name`）。而 `establish()` 的文档说「a human's naming and duties survive every later session」——该承诺在 `roles` 表层面成立，在**模型可见**层面不成立。请裁决：这是预期（角色段永远以声明为准），还是需要让面板编辑也进入 prompt，或修正该文档措辞。

**观察 B —— live roster 的默认预设。** 正例里 `isDefault: true` 是 `godot-review-board`（profile 默认预设），四个内建预设只有 `id/order/isDefault`、无 `name`。仅记录事实，供对照。

## 9. 结论与建议

- §9-A1 的 8 条判据：**6 条已验证、2 条部分验证（#7 的 2/4 类、四种来源里的 `delegated` 铸造），无一条「反证成立」**；未发现实现缺陷，故我按任务要求**没有改动任何实现文件**。
- 建议：(a) 请就「观察 A」给出裁决；(b) 在阶段 B/D 落地时把 sweep 的 2 个 `deferred` 类补成真用例；(c) 补 §10 的 snapshot pin 或写明替代 pin（缺口 §5）；(d) `dev.overlay.yml` 的声明生效性已由 live 正例（`broken=0`）+ 两个反例独立确认，作者侧 3099 的自证与我的结论不冲突。
- 复跑顺序建议：先 `a1-chain.mjs`（约 15 s，最便宜），再通道（约 70 s），最后 live（约 2–3 min，需 3101/3102 空闲且 3080 不参与）。
