# V8 / 阶段 G 独立收口核对（`composition-verifier`）

范围：**只看文档说了什么、代码实际是什么**，不替代作者自测。本报告的证据全部是
`tests/verification/` 下的可重跑仪器与原始日志；实现、文档、`tests/live.mjs` 均未改动
（写入范围仅 `tests/verification/**`）。临时 web 实例**未启动**（本阶段不需要），
3080 全程未触碰。

---

## 0 钉住的版本

### 0.1 被核对的文档（我的字节测量，`Get-FileHash -Algorithm SHA256`）

| 文档 | 字节 | 最后写入 | SHA256 |
|---|---|---|---|
| `ROLE-DISPATCH.md` | 86855 | 10-04 05:37:49 | `C2BFF5647430628AC3886951220BFCD598702ED487512E8A0DD0527EF1ABE1E0` |
| `DESIGN.md` | 31798 | 10-04 05:35:48 | `6BB497E7B9BB7A8893EE96B6879F12559AF90989C6A7091173FAB804741A6177` |
| `README.md` | 15678 | 10-04 05:35:12 | `DCB9774912BE25FB93BDCF55CF96DBE0A81DAA43E9892420C4FABC8A15C0A96D` |
| `OPTIMIZATION.md` | 24794 | 10-04 05:35:40 | `3C341D37FDF616755F254D350B9FFD90A42B78A5FC0EA52315117EA21E820200` |
| `G-CHECKLIST.md` | 17367 | 10-04 05:38:08 | `4D89FA2BF85873170EE915BE22C5ED2E2C18E1CF2F5D5B35A6EDFF1628E0B59D` |

五份文档的最后写入时间都早于本阶段全部运行（05:5x 之后），所以本报告的结论只对这些
字节负责。`DESIGN.md` 与 `README.md` **不含任何 `file:line` 锚点**（见 §2.1），它们的
主张改由模块表/动作表/配置表逐条核对（§2.3）。

### 0.2 被核对的代码

代码侧钉在 Lead 给出的 27 文件 D19 摘要
`694bba17-89ed1fcd-5c8d3aee-20ca5447-be0a7cba-5584561e-48e3c080-69be916a-7460d4f9-4b06a18f-3f565616-9351989e-3dcb6c4e-a22f0d5a-a226e071-e3a9261c-24015b2e-520cfd9e-dd49b42c-afb4b2d0-1b4c3b22-50efaabb-b2ba560e-dbd75745-42fd0707-2c4a0603-656242c4`
（含 `host/domain.js E0A5C8C7…`、`index.js CBAED579…`、`tests/harness.mjs 79AB2C57…`、
`tests/domain.mjs 7D0AF9F9…`、`host/service.js 9351989E…`）。锚点核对是对这棵树做的；
本报告不重复 Lead 的摘要计算。

### 0.3 本机行号陷阱（影响一切「第 N 行」结论）

本机 pwsh 的 `Get-Content` 按 **GBK** 解码无 BOM 的 UTF-8：`ROLE-DISPATCH.md` 实际 723 个
LF / 724 行，`Get-Content` 只数出 **530** 行，`-Raw` + `-split "\n"` 数出 **531**；同一文件里
`unsupported-legacy-version` 的真实行号是 **583**（Node 与 `Select-String` 一致），
`Get-Content` 报 **425**。本报告所有行号以 **Node `split('\n')` / `read` 工具**为准；
`tests/verification/_*.txt` 之所以按类豁免，也和重定向写出的 UTF-16LE 有关。

---

## 1 跑了什么

| 仪器 | 命令（工作目录 = 仓库根） | 原始日志 |
|---|---|---|
| `g-anchors.mjs` | `node --import tsx/esm tests/verification/g-anchors.mjs extract` | `_g_anchors_extract.txt` |
| 同上（语义） | `… g-anchors.mjs semantic` | `_g_anchors_semantic.txt` |
| 同上（全量） | `… g-anchors.mjs all` | `_g_anchors_all.txt` |
| `g-receipts.mjs` | `… g-receipts.mjs` | `_g_receipts.txt` |
| `g-hygiene.mjs` | `… g-hygiene.mjs before` / `after` / `all` | `_g_dsh_before.txt`、`_g_dsh_after.txt`、`_g_hygiene.txt` |
| 红控 1/2/3 | 见 §6 | `_g_red_semantic.txt`、`_g_red_anchor.txt`、`_g_red_hygiene.txt` |
| 作者套件 | `queue.mjs`、`roles.mjs`、`runs.mjs`、`cd-verify.mjs`（json/sqlite）、`e-verify.mjs`（json/sqlite） | `_g_run_<name>.txt` |
| 语法 | `node --check`（tests + probes + 板根，41 个 `.js`/`.mjs`） | 控制台（0 失败） |

环境固定：`TSX_TSCONFIG_PATH=C:\code\deepseek-harness\tsconfig.json`。

---

## 2 A：文档锚点清点 + 承重语义

### 2.1 机械清点（`g-anchors.mjs extract`，退出码 1 = 有真缺陷）

```
ROLE-DISPATCH.md: 724 lines, 54 anchor occurrences
DESIGN.md:        397 lines,  0 anchor occurrences
README.md:        223 lines,  0 anchor occurrences
OPTIMIZATION.md:  253 lines,  1 anchor occurrences
G-CHECKLIST.md:    52 lines, 56 anchor occurrences
111 次出现 / 103 个去重锚点
resolved=100 unresolved-file=0 out-of-bounds=2 blank=0 ambiguous=2
target classes: plugin=81 skill=4 deployment=2 repo=8 repo-suffix=5
                repo-suffix-ambiguous(5)=2 doc-context=1
133/134 checks passed      ← 唯一红项 = 「每段行号都在界内」
```

- **0 个文件找不到**：14 个平台/技能/部署引用（`SKILL.md`、`references/dispatch.md`、
  `lifecycle.ts`、`registry.spec.ts`、`registry.spec.ts` 所属包等）全部解析成功；
  解析范围 = 插件树 → 仓库（按后缀唯一匹配）→ `.agents/skills/requirement-board-tasks` → `~/.dsh`。
- **2 个锚点越界**（同一文件的两次引用，真缺陷）：`~/.dsh/profiles/web/cordis.yml:324`
  与 `:495-496`；该文件只有 4 行有效内容。详见 §5 的 F-G1。
- **2 个锚点机械歧义**（非缺陷，已裁定）：裸文件名 `lifecycle.ts:134-163`、`:140-144`
  在仓库中有 5 个同名文件；文档正文用的是 `subagent/src/lifecycle.ts` 这样的部分路径。
  裁定 = `packages/subagent/subagent/src/lifecycle.ts`，依据是该段确实导出 `observeRun`
  且 `:140-144` 正是 `const identity = { runId: SubagentRunId(randomUUID()), provider, id: run.id … }`
  （§2.3 的承重行把它按裁定后的完整路径断言，通过）。`registry.spec.ts:359-366` 靠
  「同一文档里出现过的完整路径」规则唯一解析到
  `packages/preset/agent-preset-registry/tests/registry.spec.ts`（`[doc-context]`）。
- **0 个锚点落在空行**：说明行号不是「蒙对的行附近」，而是确实指着内容。

### 2.2 承重语义核对（`g-anchors.mjs semantic`）

131 条人工策展的承重检查 + 3 条清点检查 = **134**，**133 通过**，唯一红项就是上面那 2 个
越界锚点（合起来算 1 条）。策展覆盖：

| 家族 | 条数 | 断言方式 |
|---|---|---|
| README「18 个动作」 | 18 | 每个动作名在 `host/tools.js`+`host/service.js`+`host/http.js` 里作为动作/方法存在 |
| §5.12 配置键（README 8+4） | 12 | 每个键名出现在 `host/config.js` |
| §8.2 失败码表 | 16 | 表里 15 个码逐个在 `host/*.js` 的 `fail('…')` 出现；`invalid-record` 另断言 `openBoardDomain` 包装存在 |
| DESIGN 模块表 | 15 | 每个模块行断言其职责符号（`resolveConfig`、`computeStats`、`advanceable`、`createBoardHandler`、`requirementBoardRole` …） |
| §6 prompt 段序 | 5 | `Delegated to you` / `Claimable for you` / `Your queue` / `Executing now` / `Waiting on the human` 全在 `service.js:2890-3063`，且各自的行号区间一致 |
| §4.4 / §4.5 | 2 | `dispatch.js:208-245` 含 `advanceable`；`dispatch.js:86-116` 含 `claimable`（「单一公式」的落点） |
| §5.3 | 2 | `dispatch.js:322-340` 含 `lockState`；`service.js:2870-2883` 是 `#queueView` |
| §5.5 | 4 | `index.js:103-111` 的 `createOwnershipPort`、`service.js:1626-1740` 的 `delegate`、`#settleDelegation`、`runs.js:230-243` 的截断 |
| §5.6 | 4 | 三个工具名 + `tools.js:160-165` 的 `case 'get'` |
| §5.7 | 4 | `service.js:1850-1878` 决策拒绝、`#assertOwnedTarget`、`tests/decision.mjs:201-254`、`tests/delegate.mjs:536` |
| §5.9 | 5 | `stats()`、`criticalPath`、`[high↑]` 升级、`changesSince`、`snapshot()` |
| §8.1 | 8 | `ENDPOINTS`、`ROUTE_PREFIX`、`createBoardHandler`、`host/http.js:196-238` 命令面、`:151-235` 动作穷举、`:167-177` transition 参数、`:47` 的 256 KiB 上界、`unknown action` |
| 已知漂移点 | 8 | `unsupported-legacy-version` 实际位置；`openBoardDomain` 诊断包装；`stored … is not one of …; value …`；`byKind` 闭集派生；`continuable` 与端口默认的**真实来源**；面板无 `claim`/`queue`（否定式：`host/http.js` 内不存在 `case 'claim'`/`case 'queue'`） |

`DESIGN.md`/`README.md` 的价值不在行号锚点，而在这三张表：15 个模块职责、18 个动作、
12 个配置键——都已逐条落到符号上。

---

## 3 B：整张回执深等值断言，加字段后还成立吗

### 3.1 机械清点（`g-receipts.mjs`，5/5 通过）

插件的套件**不用 `node:assert`**，用的是本地 `check(label, ok, detail)`；因此「整张回执深等值」
只有四种形态，仪器把它们全部抽出来：

| 形态 | 含义 |
|---|---|
| R1 | `JSON.stringify(调用结果) === JSON.stringify({ …字面量… })` |
| R2 | `JSON.stringify(调用结果) === <变量>`（整条存储记录快照） |
| R3 | `Object.keys(x).sort() === JSON.stringify([…])`（精确键集） |
| R4 | 两段读路径互相 `JSON.stringify` 比较（两侧都是重算的） |

实测：**R1/R2/R3 共 11 条**，**R4 共 45 条**（分布在 11 个文件）。R1/R2/R3 全表：

```
composition/cases.mjs:142   [R1/sub-value]     report.warnBeforeRoleDispatch === { logger: [], stderr: [] }
queue.mjs:471               [R1/api receipt]   await service.disposeSession('ses_ZZ') === { session, releasedQueueItems, settledDelegations, orphaned }   ← settledDelegations
roles.mjs:215               [R1/api receipt]   board.service.listRoles().items[0].holders === { online: 2, idle: 1, running: 1 }
roles.mjs:222               [R1/sub-value]     after.unregistered[0].holders === { online: 2, idle: 1, running: 1 }
runs.mjs:438                [R1/纯函数]        attributeExecution(…) === { requirementId: 'req_2', session: A.session }
runs.mjs:754                [R1/sub-value]     jobs.subscriptions[0].filter === { owners: 'all' }
runs.mjs:810                [R1/纯函数]        allowed === { kind: 'allow' }
verification/cd-verify.mjs:656  [R2/stored record] raw(world, low) === storedBefore
verification/cd-verify.mjs:824  [R1/field projection] pick(legacyGet) 与 pick(legacyList) 等的字段投影比较
verification/e-verify.mjs:482   [R1/api receipt]   off.…getRequirement(id, session).sync === { enabled:false, gap:false, syncedAt:null, reason:'execution-sync-disabled' }
verification/e-verify.mjs:606   [R3/exact key set] byKind 的键集 === ['decision','task']
```

### 3.2 逐条结论：全部仍然成立

四个新字段（`changed` / `settledDelegations` / `unbound` / `queued`）**没有任何一条**
被静默吸收。逐条理由：

1. `queue.mjs:471`（唯一带新字段的整张回执）——字面量里**已经含 `settledDelegations`**，
   即该断言在加字段的同一次改动里被同步更新；仍相等。
2. `roles.mjs:215/222`——比的是 `holders` 这个子对象，加字段动的是回执顶层；仍相等。
3. `runs.mjs:438` / `runs.mjs:810`——比的是两个**纯函数**的返回值
   （`attributeExecution` → `{requirementId, session}`、`executionGateDecision` → `{kind:'allow'}`）；
   E 阶段没有给它们加字段；仍相等。
4. `e-verify.mjs:482`——`sync` 子视图按设计是精确形状；`settledDelegations` 挂在 dispose 回执上，
   不在这里；仍相等。
5. `e-verify.mjs:606`——精确键集，且**正是** F-E1（`byKind` 开口）修复后的守门断言；仍相等。
6. `cd-verify.mjs:656`——整条存储记录快照，故意用整对象证明「读不写盘」；仍相等。
7. R4 的 45 条是「两条读路径互相比较」（get/list/snapshot/diff、面板与工具），
   两侧都由同一实现重算：只有两条路径出现分歧才会红，加字段不会；仍相等。

### 3.3 仍然相等的这些，跑过了

| 套件 | 结果 | 日志 |
|---|---|---|
| `tests/queue.mjs` | **304/304** | `_g_run_queue.txt` |
| `tests/roles.mjs` | **220/220** | `_g_run_roles.txt` |
| `tests/runs.mjs` | **312/312** | `_g_run_runs.txt` |
| `tests/verification/cd-verify.mjs` | **181/181**（json）、**181/181**（sqlite） | `_g_run_cd-json.txt`、`_g_run_cd-sqlite.txt` |
| `tests/verification/e-verify.mjs` | **153/153**（json）、**151/151**（sqlite） | `_g_run_e-json.txt`、`_g_run_e-sqlite.txt` |

全部退出码 0。`composition/cases.mjs:142` 那条是子进程夹具的报告字段，由组合用例驱动，
本阶段没有单独起组合子进程（见 §8）。

---

## 4 C：卫生与残留

### 4.1 字节卫生（`g-hygiene.mjs all`，6/6 通过）

扫描 `tests/**` + `locale/` + `probes/` + 板根共 **73 个文本文件**（含本报告）
（`tests/verification/_*.txt` 原始日志与 `*.raw.json` 按类豁免）：

- 0 个 UTF-8 BOM；0 个非法 UTF-8；
- 0 个 CR（全 LF）；
- 0 个不是「恰好一个结尾 LF」；
- `locale/*.json`（2）、`probes/*.json`（3）、`package.json` 共 **6 个 JSON 全部可 `JSON.parse`**。

**自查命中并已修**：我新写的 `g-hygiene.mjs` 与 `g-receipts.mjs` 初次落盘时**没有结尾 LF**
（末字节 `0x29`），被自己的扫描器抓出后补上，复跑 6/6。这是本阶段唯一一次自我打回，
留在这里作记录。

- `node --check`：`tests/` + `probes/` + 板根 **41 个 `.js`/`.mjs`，0 失败**
  （只扫 `tests/` 时是 35 个、0 失败）。
- 同一批 JSON 若用 `Get-Content -Raw | ConvertFrom-Json` 读，会得到 2 个「假失败」
  （`locale/zh.json`、`package.json` 报 Unterminated string）——那是 §0.3 的 GBK 解码陷阱，
  不是文件问题；Node 的严格 UTF-8 解码器给出 6/6。

### 4.2 残留清单（只报，不代 Lead 清）

- 板根：`dev-board.db` 4096 B、`dev-board.db-shm` 32768 B、`dev-board.db-wal` 543872 B
  ——**留给 Lead 清**。
- `%TEMP%`：`e-verify-*` / `e-compose-*` = **0**（我的临时目录是干净的）；
  但存在约 66 个**更早阶段**留下的 `rb-*` 条目（`rb-smoke-out.txt`、`rb-runs.txt`、
  `rb-uic-*.cjs`、`rb-v2-red`、`rb-v2-green`、`rb-standalone-good/bad`、
  `rb-client-smoke.damaged.mjs`、`rb-recovered.mjs`、`rb-json-fIoXiQ` 等）。
  这些不在我的写入范围里，列出来供 Lead 决定是否清。
- 红控的变异树建在 `tests/verification/_red-g/`，用完即删（删除前先 `Resolve-Path` 校验
  目标就是该目录，校验通过才删）；周边无 `_red-e-*`/`_tmp*` 残留。
- `tests/` 下**没有点文件**，板内**没有 `.bak`**（`-Force` 递归查过）。

### 4.3 `~/.dsh` 前后对比（`before` / `after`，各 10 桶 529 文件）

| 桶 | 前 → 后 | 结论 |
|---|---|---|
| `profiles` | 34 → 34，哈希相同 | **未动** |
| `bundles` | 70 → 70，哈希相同 | **未动** |
| `requirement-board` | 1 → 1，哈希相同 | **未动** |
| `skills` / `attachments` / `cache` / `llm-deepseek` / `logs` | 哈希相同 | 未动 |
| `sessions` / `storages` | 148 → 148 / 150 → 150，哈希不同 | harness 自身的每轮会话状态，非本阶段写入 |

即：本阶段对部署树**零写入**（未启动临时实例，未走 launcher，因此连 profile 重写都没有）。

### 4.4 git 状态

- `git status --short`：仍是那 4 条既有未跟踪项（`.agents/skills/requirement-board-tasks/`、
  `.workbuddy/`、两个 `_tmp_*`），**没有新增**；
- `git diff --stat`：**空**。

---

## 5 「文档说 X，实际是 Z」完整清单

| # | 文档位置（说的是 X） | 实际（Z） | 判定 |
|---|---|---|---|
| **F-G1a** | `ROLE-DISPATCH.md:36`：派发链要求子智能体为 `backgroundMode: 'continuable'`，并称「本机 `~/.dsh/profiles/web/cordis.yml:324` 已是」 | 该文件只有 4 行有效内容、**不含 `backgroundMode`**；该设置的真实来源是 `packages/bundle/base/cordis.patch.yml:375`（以及 `packages/bundle/web-app/presets/{standard,ptc,cordis}.patch.yml:100,112`） | 主张为真、**锚点错**（越界，不可核对）。建议把锚点换成 bundle 行 |
| **F-G1b** | `ROLE-DISPATCH.md:696`：端口默认取自 `~/.dsh/profiles/web/cordis.yml:495-496` | 同上文件只有 4 行；真实来源是 `packages/bundle/web-app/cordis.patch.yml:182-183` 的 `port: !!js ctx.webStartup.port ?? 3080` | 主张为真、**锚点错**（越界）。建议换锚点 |
| **F-G2** | 交接说明给出的「作者当前锚点」：`host/domain.js:466-468` = `unsupported-legacy-version` | 466-468 是 `importLegacyDocument`（函数声明在 464）头部一带，不是抛点；`fail('unsupported-legacy-version', …)` 实际在 **`host/domain.js:530-534`**（`if` 在 530、`fail` 在 **531**） | **交接锚点陈旧**（不是文档缺陷，§8.2 表本身不带行锚点）。⚠️ **本行数字已订正**：原写「`529-534`（530 行）」差一行，冻结轮用 Node 复核（文件哈希仍是 `E0A5C8C7…`，未变）为 530-534/531；`G-CHECKLIST.md:23` 的现行写法（`530-534`，`fail` 在 531）是对的 |
| **F-G3** | 裸文件名锚点 `lifecycle.ts:134-163`、`:140-144` | 仓库有 5 个 `lifecycle.ts`；语义上唯一正确的是 `packages/subagent/subagent/src/lifecycle.ts` | **机械歧义 × 2**（warn）。已按 §2.3 断言裁定结果并通过 |
| **F-G4** | `DESIGN.md`、`README.md` 被当作「有锚点的规范文档」使用 | 两份文档的 `file:line` 锚点数 **= 0**（只有模块表/字段表/测试清单） | 记录事实：这两份文档的正确核法是逐表落符号（§2.2 已做），不要等它们的行锚点 |
| **F-G5** | 负面主张：§8.1「面板 command 没有 `claim`/`queue`」、§8.2「收到不存在的动作报 `invalid-argument`，消息含 `unknown action`」 | `host/http.js` 的动作分发里确实**没有** `case 'claim'`/`case 'queue'`，但有 `case 'unqueue'`（面板可清预留）；`unknown action` 措辞存在 | **成立**（否定式断言已验证，未反例） |
| **F-G6** | §8.2 失败码表（15 个码） | 15/15 都能在 `host/*.js` 里找到抛出点；`invalid-record` 由平台读边界抛出、由 `host/domain.js` 的 `openBoardDomain` 补诊断 | **成立** |
| **F-G7** | README「18 个动作」「12 个配置键（8 列出 + 4 默认）」 | 18/18 动作、12/12 键都在代码中存在；`host/config.js` 的键集合恰好是这 12 个 | **成立** |
| **F-G8** | 我自己的一处卫生失手 | 新写的两个仪器初版缺结尾 LF | **自查已修**（§4.1） |

**没有发现**：文档承诺的字段/动作/失败码/端点在代码里缺失（0 个 unresolved）；
除 F-G1 的 2 个越界锚点外，**101 个锚点全部既存在、又在界内、又指着非空内容**。

---

## 6 红控（证明仪器不是橡皮图章）

三个变异体都建在 `tests/verification/_red-g/`，跑完即删（删除前校验绝对路径）。

| 红控 | 变异 | 结果 |
|---|---|---|
| **R1 语义**（`G_ROOT` 指向影子树） | 影子 `host/dispatch.js` 里 `advanceable` → `advancementGate`（4 处改名、0 残留） | `_g_red_semantic.txt`：`FAIL … dispatch.js:208-245 matches /advanceable/`、`FAIL DESIGN.md host/dispatch.js matches /advanceable/`，**126/131，退出码 1**（另有 3 条「影子树没复制 `tests/`」的 not-found 噪声，属预期） |
| **R2 锚点**（`G_DOC_DIR` 指向变异文档） | `G-CHECKLIST.md` 里把 `host/dispatch.js:302-309` 改成 `:1402-1409` | `_g_red_anchor.txt`：`out-of-bounds=3`（变异锚点 + 既有 2 个），`FAIL every referenced line range is in bounds`，**退出码 1** |
| **R3 卫生**（`G_BOARD` 指向变异树） | 放入 BOM + CRLF + 无结尾 LF 的 `.mjs`，外加非法 JSON | `_g_red_hygiene.txt`：BOM / CR / 结尾 LF / JSON 解析**四条同时红**，**1/5，退出码 1** |

三条都「能红」，说明 §2 的 100 个通过项、§4 的 6 项卫生都是可证伪的实测，而不是空断言。

---

## 7 作者/他人套件（同一棵树上的现状）

| 套件 | 结果 | 日志 |
|---|---|---|
| `tests/runs.mjs` | 312/312 | `_e_author_runs.txt` / `_g_run_runs.txt` |
| `tests/loader.mjs` | 53/53 | `_e_author_loader.txt` |
| `tests/client-smoke.mjs` | 277/277 | `_e_author_client-smoke.txt` |
| `tests/queue.mjs` | 304/304 | `_g_run_queue.txt` |
| `tests/roles.mjs` | 220/220 | `_g_run_roles.txt` |
| `cd-verify.mjs` | 181/181 ×2 后端 | `_g_run_cd-*.txt` |
| `e-verify.mjs` | 153/153（json）、151/151（sqlite） | `_g_run_e-*.txt` |
| `e-composition.mjs` | 55/55 | `_e_composition.txt` |

---

## 8 未验证 / 边界

1. **未起临时实例**：本阶段不需要实时证据，因此 3109 未使用；`tests/live.mjs` 的凭据两段式
   证据沿用 E 阶段结论（`_e_live_3108_suite_*.txt`），本报告不重新主张。
2. **组合子进程夹具**（`tests/composition/driver.mjs`）本阶段未单独跑，`cases.mjs:142`
   那条整值断言只做了静态判断（不属于「回执」，是子进程报告字段）。
3. **行号口径**：一切行号 = Node 的 `split('\n')`（= `read` 工具 = `Select-String`）；
   本机 `Get-Content` 的 GBK 口径会给出不同数字，不要混用（§0.3）。
4. **`g-receipts` 的覆盖边界**：R2 只捕获「右侧是裸标识符」的快照；右侧为表达式的比较
   归入 R4 计数。没有 `node:assert` 深等值（仪器已断言此点）。
5. **写入边界**：只写了 `tests/verification/**`（三个仪器、本报告、日志）；
   实现、`host/**`、`client.js`、文档、`tests/live.mjs` 均未改；3080 未触碰；
   `~/.dsh` 部署桶零写入（§4.3）。
6. **残留不由我清**：`dev-board.db*` 与 `%TEMP%\rb-*` 只列清单，处置权在 Lead。

---

## 9 证据保留

`tests/verification/` 下本阶段全部 `_g_*.txt` 原样保留（PowerShell 重定向产物，按既有约定
属 `_*.txt` 豁免类，不做转码）：清点/语义/回执/卫生/红控/作者套件各一份；
`_g_dsh_before.txt`、`_g_dsh_after.txt` 是部署快照。仪器本体：
`g-anchors.mjs`、`g-receipts.mjs`、`g-hygiene.mjs`；报告：`G-verification.md`。

---

## 10 冻结轮增量（2026-10-04）

Lead 在冻结前发现两个早期仪器因后续裁定变红。本轮把它们更新到当前口径，并重跑全部非 live 仪器；
这是本轮唯一一次写入，写范围仍是 `tests/verification/**`。

### 10.1 两个仪器的订正（旧期望 → 新期望 → 依据）

| 仪器 / 断言 | 旧期望（A 时代） | 新期望（当前裁定） | 依据 |
|---|---|---|---|
| `a1-chain.mjs` 健康链路无 warn/error | 夹具用默认配置（`executionSync` 默认 true），健康链路必须零 warn | 夹具显式 `executionSync: false`（该组合不挂 jobs 注册表），断言仍是「零 warn/error」；具名同步 warn 的设计由 E 阶段证据覆盖 | §5.12；`host/config.js`；`tests/composition/cordis.yml`、`tests/roles.mjs` 同法 |
| `a1-chain.mjs` prompt 行 | 「反映实时声明，不反映记录」 | 「反映**记录**」：读到人手记录的 `(Hand-made name)` + `hand-made duty`，且不含声明的 `Art Director`；声明只在记录缺项时兜底 | **D15**；`ROLE-DISPATCH.md:491`；`host/roles.js:99-116`；声明 seed 路径仍由本套件 §[1] 断言覆盖 |
| `a1-chain.mjs` 临时角色被保留 | 只需 `boundTask` 指向一个存在的任务 | 该任务**同时**把 `role` 路由到这个临时角色（`tmp-keep`）；新增反例 `tmp-misrouted`（任务在、未绑定）必须被回收 | §3.3；`host/roles.js`:314-322 |
| `a1-chain.mjs` sweep 报告 | 「removed 1 orphan temporary role(s) …；`delegatedTo`/`blocksOn` 报 deferred、未检查」 | 「removed 2 …；unbound 1 dangling gate link(s)；settled 1 dangling delegation(s)」——四类**都是已完成的工作**；新增断言：gate 链接真的离开记录、delegation 真的被 settle（`delegatedTo=null`、`role` 回到 `roleBefore`）、有注册表时**不得出现** `not checked yet`/`deferred` | **D/D27**；`host/roles.js`:311-373；`host/service.js`:2693-2704 |
| `a3-clock.mjs` delete 读钟 | `delete` 读 0 次（不写 history） | `delete` 的**一条**收尾链恰好读 1 次；新增用例：一条链解绑两条 gate 记录（`unbound.length === 2`）仍只读 1 次，且两条 unbound history 的时间戳**相同**（一条链共用它读到的那一个瞬间） | `host/service.js`:2476-2511（`const at = nowIso()` 一次读取）、`:2526-2548`（`#unbindLinks` 复用该 `at`） |

`sweep` 的 deferred 类并未消失，只是需要「agent 注册表缺席」才出现（`host/roles.js`:369-372，
由 `tests/roles.mjs`:365 覆盖）；§[5] 现改为「有注册表时不得出现 deferred」的反向断言。

### 10.2 冻结轮原始结果（全部 exit 0）

- `g-hygiene.mjs all` **6/6**；`g-anchors.mjs all` **134/134**（`resolved=106 unresolved-file=0 out-of-bounds=0 blank=0 ambiguous=0`）；`g-receipts.mjs` **5/5**；
- `a1-chain.mjs` **44/44**（原 35/40）；`a3-clock.mjs` **32/32**（原 29/30）；
- 其余非 live 仪器全部 exit 0：`a3-chain` 90/90、`a3-mutation` exit 0（无 "checks passed" 行是它的输出形态）、`b-composition` 17/17、`b-delegate` 79/79、`b-digest` exit 0、`cd-composition` 48/48、`cd-verify` 181/181（json）与 181/181（sqlite）、`e-composition` 55/55、`e-verify` 153/153（json）与 151/151（sqlite）；
- 日志：汇总 `_g_run_inventory.txt`（每套件另有 `_g_inv_*.txt`），本轮重跑 `_g_run_final_*.txt`；
- `live-auth.mjs`、`live-presets.mjs` 需在跑实例 + token，本轮未跑（与 §8.1 一致）。
- `git status --short` 仍是那 4 条既有未跟踪项、`git diff --stat` 为空；本轮未写 `~/.dsh`。

### 10.3 文档在本轮之前被推进（§5 的 F-G1/F-G3 已闭环）

`ROLE-DISPATCH.md` 05:37:49 → **06:03:51**（`F897F229C4B5D7C079F13280560D18DF91AC54CE4BCDC0D9927818421BE9DEA9`）、
`G-CHECKLIST.md` 05:38:08 → **06:03:38**（`A38DF768331B8342776DF1D1A739763F6B227211FDE31E08DF9A1EFAABF5CBFD`）；
`DESIGN.md`/`README.md`/`OPTIMIZATION.md` 未变（哈希同 §0）。
于是 F-G1a/F-G1b 的部署锚点已换成 `packages/bundle/base/cordis.patch.yml:375` 与
`packages/bundle/web-app/cordis.patch.yml:182-183`，F-G3 的裸 `lifecycle.ts` 已写成完整路径，
`g-anchors` 的 2 个越界 + 2 个歧义随之归零。F-G4（DESIGN/README 无行锚点）与
F-G5/F-G6/F-G7（负面主张、15 码、18 动作/12 配置键）不受影响，仍然成立。
