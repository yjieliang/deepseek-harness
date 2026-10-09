# Stage R 独立验证报告（composition-verifier）

验证对象：阶段 R「把需求看板做成可部署 bundle 并切到 sqlite 存储」的七项断言。
方法：独立复算（自写读取器 / 组合比较器），只读取证；生产文件只在第 6、7 条做临时改动，且每次改动后按字节复原并核对 sha256。
作者：composition-verifier（反证角色）。本报告不改实现、不改文档、不改 `tests/live.mjs`。

> **已被取代（superseded，2026-10-08）**：本报告是阶段 R 的时点记录，下列读数不再代表现状——
> `SKILL.md` 现为 **18555 B / sha256 前缀 `90BDC0B97D57…`**（§5 表里的 `16152 B` / `625BB869A5C2A944` 是当时读数），
> 且 skill 的分发路径新增了「部署包内 `skills/` + bundle 层 `skill-filesystem-requirement-board` 行」
> （见 `R-ROLLOUT.md` §9）。其余结论（sqlite 路由、组合等价、回滚演练、同名去重规则）按原样仍然成立。
>
> **本文件同时保存第二轮报告**：流程模板版本化（§11.9 测试计划落成断言 + 反向验证），见文末
> 「第二轮：流程模板版本化（对抗性验证）」。第一轮全文原样保留，未删改。

工作目录：`C:\code\deepseek-harness\.artifacts\requirement-board\tests\verification\`
原始读数：同目录 `_r_*.txt` / `_r_*.raw.txt`（PowerShell 重定向的 `_*.txt` 为 UTF-16LE，按类豁免字节检查）。

---

## 1. 实例与启动（第 1 条）

用例：真实 profile 临时实例，端口 3109，**不带** `--patch`。

```
TSX_TSCONFIG_PATH=C:\code\deepseek-harness\tsconfig.json
node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 3109
```

| 读数 | 值 |
| --- | --- |
| 启动行 | `dsh web: http://127.0.0.1:3109/?token=W2bQ4ShGpymOkYQWpJawz1-s4qrHhrNrs1cm3RVS_bM` |
| 3109 监听 | 启动前 0 → 启动后 1 |
| `~\.dsh` 文件数 | 7916（与 Lead 读数一致，快照见 `_r_baseline.txt`） |
| boot 日志异常 | 仅 `ExperimentalWarning: SQLite is an experimental feature`（node:sqlite 自身告警） |

裸词 `web` 被 `apps/cli/src/args.ts:201-205` 当作 **profile 名**展开，因此该命令等价于 `--profile web --no-open --port 3109`；`--patch` 未参与，实例走 profile 补丁（含 sqlite 路由）。原始日志：`_r_boot_3109.txt`。

---

## 2. live 套件两次读数（第 2 条）

### 2.1 过程缺陷（先记这里，因为它影响 Lead 给出的命令）

Lead 给的命令是「在部署副本目录里跑 `node --import tsx/esm tests/live.mjs …`」。原样执行**必然失败**：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from
C:\Users\Administrator\.dsh\bundles\dsh-requirement-board\
```

原因：`tsx` 只存在于 `C:\code\deepseek-harness\node_modules\tsx`；`~\.dsh`、`~\.dsh\bundles`、`~\.dsh\profiles\web` 的 `node_modules` 下都没有它，`--import tsx/esm` 按 CWD 解析所以失败（原始输出 `_r_live_bundle_tsx.txt`，exit 1）。
等价可行做法：`tests/live.mjs` **自身零 import**（纯 HTTP 客户端，只用全局 `fetch`），所以该副本用裸 `node tests/live.mjs` 即可；或者从仓库根用**绝对路径**指向副本文件。

### 2.2 两次读数

| 运行 | 命令（CWD） | 结果 |
| --- | --- | --- |
| 部署副本 | `node tests/live.mjs http://127.0.0.1:3109 <token>`（`~\.dsh\bundles\dsh-requirement-board`） | **35/35，exit 0**（`_r_live_bundle.txt`） |
| 开发树副本 | `node --import tsx/esm tests/live.mjs http://127.0.0.1:3109 <token>`（`.artifacts\requirement-board`） | **35/35，exit 0**（`_r_live_dev.txt`） |

两次都打印 `ok every probe requirement was deleted again` 与 `ok the board is back to its previous contents`，且运行后 sqlite 计数回到基线（§4），确认套件自清理生效。两次读数一致，跨副本无差异。

---

## 3. 组合等价：生产补丁 vs 开发 overlay（第 3 条）

自写比较器 `r-dumpconfig.mjs`（不解析 YAML 方言，按层/条目分块逐行比对，只归一化「sqlite 文件路径」这一处已文档化的 dev/prod 差异）：

```
node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config                       > _r_dump_prod.raw.txt
node --import tsx/esm apps/cli/src/bin.ts --profile web --patch .artifacts\requirement-board\dev.overlay.yml --dump-config > _r_dump_dev.raw.txt
node r-dumpconfig.mjs _r_dump_prod.raw.txt _r_dump_dev.raw.txt
```

| 读数 | 生产 | 开发 |
| --- | --- | --- |
| 层数 | 46 | 47 |
| 条目数 | 195 | 195 |
| 只在一侧存在的 id | 无 | 无 |
| 归一化后条目块差异 | **无** | **无** |

**差异清单：空。** 唯一结构差别是承载 `storage-sqlite` insert 的**层不同**（生产在 `profiles\web\cordis.patch.yml` 层，开发在 `dev.overlay.yml` 层），组合结果等价。

逐条断言（13 项全过，`r-dumpconfig` exit 0，原始输出 `_r_dumpconfig.txt`）：

- 插件行存在且 `name: dsh-requirement-board`，`importLegacy: false`；
- `storage-sqlite` 指向**生产**库 `C:/Users/Administrator/.dsh/storages/requirement_board.db`，`journalMode: wal`；生产层不含 `dev-board.db`；
- `storage-domain` 保持 `backend: json`，路由键是**下划线** `requirement_board: sqlite`，且不含连字符写法；
- 4 个预设（`preset-godot-review-board` / `-godot-game-suite` / `-game-mechanics-designer` / `-godot-shader-developer`）各带一条 `dsh-requirement-board/role` 声明，`roleId` 与预设 id 一致。

已知非缺陷：`--dump-config` 会重写 `~\.dsh\profiles\web\cordis.yml` 的 mtime；其内容 sha256 前后均为 `C300DCF2EBC5F02062D6591268D29D3DB6FE45E0CB138F5467276FE2BA06076E`（未变）。
自查修正：比较器第一版的正则把缩进 6 的**嵌套插件行**当成了顶层条目（236 条、14 项中 4 项假失败）；改为只匹配行首 `- id:` 后为 195 条、13 项全过。第一版结论不可用，已弃。

---

## 4. 数据面（第 4 条）

读取器 `r-db.mjs`（`node:sqlite`，`readOnly: true`）。表布局是 unit 作用域，名称为 `u_requirement_board_*`：

| 表 | 行数 |
| --- | --- |
| `u_requirement_board_requirements` | 0 |
| `u_requirement_board_roles` | 1（`cordis`，observed，createdAt `2026-10-04T01:29:47.706Z`） |
| `u_requirement_board_queues` | 0 |
| `u_requirement_board_templates` | 1（`tpl-standard`，builtin，5 节点） |
| `unit_globals` | 1 |
| `units` | 1（`requirement_board`，version 2） |

- `global.imported`：`{"at":"2026-10-03T22:43:18.865Z","count":1}` —— 全部启动过程中**未变**。
- 二次启动不重复导入：`requirement-board.json.migrated` 全程 sha256 `7484CB6621E6F9BE66A5A2B9A7707A0498C8250BB0520DDA3EDD4F53AA8A84A0`、mtime `2026-10-04 01:12:05`（未变）；`imported.at` 未变。**该断言成立。**
- 旧 json 域文件 `~\.dsh\storages\requirement_board.json`：正常启动 + 两次 live 之后（09:36:48 采样）仍为 2771 B / sha256 `EB9B83C6754EA77C7682BAE8BE76815915F586DDE58F5C00A53B76B920D2B7BD` / mtime `2026-10-04 02:07:03` —— **未被生产启动触碰**。

**与 Lead 给定数值的漂移（需更正）**：`unit_globals` 的 `revision` 现为 **31**（不是 0；正常 live 运行会把 1→16→31），`execSync.ignored` 现为 **73**（`executionSync` 默认 true，bundle 补丁没有关掉它）。`revision` 的增长在最终一轮 live 中作为「生产确实走 sqlite」的正控使用（§7a 的反例）。

补充读数：主库文件 `requirement_board.db` 的 mtime 停在 `01:27:43`，变化都在 `-wal`（结束时 148352 B）里。经 sqlite 读到的是一致的；只看主文件 mtime 会得出「库没动」的错误结论。

---

## 5. skill 重名量化（第 5 条）

| 项 | 读数 |
| --- | --- |
| 项目级目录 | `C:\code\deepseek-harness\.agents\skills\requirement-board-tasks`（存在，3 文件） |
| 用户级目录 | `C:\Users\Administrator\.dsh\skills\requirement-board-tasks`（存在，3 文件） |
| `SKILL.md` | 两侧**逐字节相同**：16152 B，sha256 前缀 `625BB869A5C2A944`（**已被取代 2026-10-08**：现 18555 B / `90BDC0B97D57…`） |
| 目录是否报重名 | 未报错；目录只列出一个 `requirement-board-tasks` |
| 实际生效 | **项目级副本** |

生效判定的实证：调用 `skill` 工具加载该技能，返回头为
`Base directory for this skill: C:\code\deepseek-harness\.agents\skills\requirement-board-tasks`
（`renderSkillContent` 在 `packages/skill/skill/src/index.ts:170-196` 输出该行）。

机制（代码级，含行号）：

- 根与优先级：`packages/skill/skill-filesystem/src/index.ts:36-40` —— `PROJECT_DSH=100`、**`PROJECT_AGENTS=200`**、`CUSTOM=300`、**`USER_DSH=400`**、`USER_AGENTS=500`、`BUNDLED=600`；两个目录分别是 `.agents/skills`（rank 200）与 `~\.dsh\skills`（rank 400）。
- 同层去重：`packages/skill/skill/src/index.ts:567-578` 先按 rank 升序排序再**先到先得**，落选者打印
  `skill "<name>" from <source> ignored because a higher-priority skill already exists`（第 575 行）并跳过；
- 跨层：`packages/skill/skill/src/index.ts:552-556` 「近层静默遮蔽远层」；`packages/skill/skill/README.md:140` 明确写「later lower-priority candidates … are logged and hidden」且**没有 API 能列出被遮蔽的定义**。

**未能证实的部分**：该 warn 行在实际日志里**没有找到**。`~\.dsh\logs` 最新文件停在 `2026-10-04 00:17:41`（早于 09:29 的重启），3109 的 boot 日志也没有 skill 行——技能集合是**懒收集**（首次 list/load 才收集），而这个部署的宿主把 logger 输出写在自己的控制台上，我无法读取，也**不允许探测/重启 3080**。所以「会记一条 warn」是代码可证的，「本机确实落了这条 warn」未能观测。

销毁动作：无。两个目录都保持原样（未删、未改）。

---

## 6. 回滚演练（第 6 条，必须复原）

| 步 | 动作 | 读数 |
| --- | --- | --- |
| 0 | 备份生产补丁 | 59539 B / `21A66A761A3A079C061CCCC7BA45B68AF9763352BA75291D72CF11B7B7432A4C` |
| 1 | 换成 rollout 备份补丁 | 2070 B / `EF23B4B5096E21F1F0823DEF98433AC21916E4A047AF396F49FF6D1F49FA3872`（**62 行**，是用户原始补丁，不是 5 行） |
| 2 | 起 3109 | 监听 1；boot 日志只有 banner，**无错误** |
| 3 | 未认证探测 | `/api/requirement-board/{health,requirements,}` 均 **401**，且响应体是**看板自己的**结构化错误 `{"ok":false,"error":{"code":"unauthenticated",…}}` |
| 4 | 数据落点 | json 文件被改写：mtime `02:07:03`→`09:39:48`，sha256 `EB9B83C6…`→`A43C565C103CC8E3A614D9741FC49C7D7B53F9D227F656DB83F75ED1A8CA3C7A`；sqlite 未被动 |
| 5 | 复原生产补丁 | 59539 B / `21A66A76…`（**逐字节相同**） |
| 6 | 再起 3109 + live | **35/35，exit 0**（`_r_live_after_restore.txt`） |

原始读数：`_r_rollback_probe.txt`、`_r_after_restore.txt`。

**断言与 Lead 预期不符**：换回备份补丁后，插件路由**并没有消失**（不是 404）。因为看板插件行来自 **bundle 层**（`dsh-requirement-board` 的 `cordis.patch.yml`），profile 补丁只提供 sqlite 路由与预设角色声明。回滚的真实后果是**存储静默退化到 json 后端**（第 4 行读数），路由与鉴权照旧工作。

「路由确实不存在」长什么样，见 §7b（认证后 **404 `not found`**）。因此第 6 条若要断言「路由不存在」，需要先卸载/破坏插件，而不是回滚 profile 补丁。

副作用与复原：回滚把 json 域文件写成了带 `global` 块的新文档，这一步**唤醒**了宿主里一个仍在运行的 json 作用域（见 §8），使该文件此后被反复改写；我已按字节复原（含 mtime），复原后 35 s 内保持稳定，随后又被该作用域改写（见 §8 时间线）。

---

## 7. 红控（第 7 条，≥2 个可红项）

### 7a 连字符路由键 → 静默回退 json

用临时 overlay（`_r_red_hyphen.overlay.yml`，**不改生产补丁**）把 `storage-domain.routes` 的键改成 `requirement-board`：

```yaml
- id: storage-domain
  config:
    backend: json
    routes:
      requirement-board: sqlite
```

| 读数 | 值 |
| --- | --- |
| boot 日志 | 只有 banner，**没有任何告警**（静默） |
| live 套件 | **35/35，exit 0**（看板照常工作） |
| json `revision` | 0 → **15**（写入落到 json 文件） |
| sqlite `revision` | **16 → 16**（完全没动） |

两条独立读数同时成立，证明「连字符键 → 单位匹配不到路由 → 静默回退 json」。原始输出：`_r_red7a_hyphen.txt`、`_r_live_hyphen.txt`。

### 7b 依赖 junction 改名 → 响亮失败

把部署副本的 `node_modules\zod`（Junction → `…\.pnpm\zod@4.4.3\node_modules\zod`）改名后启动：

```
dsh: warning: 1 entry did not activate
requirement-board (dsh-requirement-board): failed to import
```

| 探测 | 结果 |
| --- | --- |
| 未认证 `/api/requirement-board/health` | 401 `unauthorized`（平台鉴权门的裸字符串，**不是**看板的结构化 401） |
| 认证后（`/?token=` 换取 cookie） | **404 `not found`**（路由确实不存在） |
| 进程 | **不崩溃**：GUI 照常监听，只有该条目没激活 |

「响亮」= 一行 warning + 条目未激活，不是退出；host 依旧服务。junction 已复原（target 与原来一致，`Test-Path` 为 True）。原始输出：`_r_red7b_nozod.txt`、`_r_red7b_probe_auth.txt`。
复原后重跑（§9）live **35/35，exit 0**。

---

## 8. 复原与不变量（最终态）

| 对象 | 期望 | 最终读数 |
| --- | --- | --- |
| `~\.dsh\profiles\web\cordis.patch.yml` | `21A66A76…` / 59539 B | ✅ 相同（逐字节） |
| `~\.dsh\profiles\web\cordis.yml` | `C300DCF2…` | ✅ 相同（mtime 因 `--dump-config` 变化） |
| `requirement-board.json.migrated` | `7484CB66…` / `01:12:05` | ✅ 相同 |
| `~\.dsh\storages\requirement_board.json` | `EB9B83C6…` / `02:07:03` | ⚠️ 按字节复原两次（含 mtime），但那个常驻作用域会再次改写：最终 `108EEF259A358BBA59F1640991BD307E24BD72A624DB65F385876A21E5893D70` / `09:47:34`；宿主运行时无法长期保持 |
| zod junction | → `…\.pnpm\zod@4.4.3\node_modules\zod` | ✅ 相同 |
| 3109 / 31xx 监听 | 0 | ✅ 0 / 0 |
| `~\.dsh` 文件数 | 7916 | ✅ 7916 |
| 仓库工作树 | 4 项既有未跟踪 | ✅ 未新增（`.agents/skills/requirement-board-tasks/`、`.workbuddy/`、两个 `_tmp_*`） |

### 关于 json 文件被反复改写（一份独立发现）

时间线（每个点多次采样，才发现这不是抖动）：

1. 正常实例 + 两次 live：文件**完全没动**（02:07:03）。
2. 回滚启动（09:39:48）把它写成了带 `global` 块的新文档。
3. 此后**即使 3109 已死**，文件仍被改写（09:41:11 → 09:41:26 → 09:41:52 → 09:42:38 → 09:45:47 → 09:47:34；`global.revision` 回到 0、`execSync.ignored` 一路 14→61）。杀死 3109 后仍继续写，证明写入者不是我起的任何实例。
4. 把文件按字节复原成 `global: null` 的旧文档后，写入保持安静 35 s（`EB9B83C6…` / 02:07:03），随后在 09:47:34 再次被改写。也就是说它是**按事件去抖刷新**，复原只能短暂压住，不能在宿主运行时保持。

可证结论：机器上有一个**常驻的 json 作用域看板域**（只能收窄到 09:29:38-39 启动的三个 node 进程这一族，也就是 3080 宿主；不能探测、不能杀），它只在这份 json 文档带 `global` 块时才维护它。所以：

- 「正常启动不碰 json 文件」**成立**（第 1 点），但这是**有条件的**：一旦有谁把 json 文档写成带 `global` 的 v2 形态，该常驻作用域就会接管并反复改写，此后主 json 文件不再具有稳定 mtime；
- 生产根看板确实走 sqlite（正控：`revision` 随 live 增长 16→31），所以这不是 sqlite 路由失效，而是**另一个作用域仍挂在 json 后端上**；
- 我没有能力终止它（不能用任何手段碰 3080 那一族进程）。若 Lead 要求「json 文件永不变化」，需要在宿主侧查这个作用域的来源，而不是在 profile 补丁里。

---

## 9. 未验证 / 无法验证项

1. 「技能重名会记一条 warn」——代码可证，**日志未观测到**（该部署不落 logger 文件；`~\.dsh\logs` 最新文件早于重启）。
2. 常驻 json 写入者的**身份**（进程级）——只能收窄到 09:29:38-39 启动的宿主进程族；无 handle/openfiles 类工具，且 3080 禁止探测与重启。旁证指向「某个**会话作用域**的看板」：json 文档的 `execSync.ignored` 随我的活动增长（14→61），而 sqlite 根看板的同名计数器自 09:40 起冻结在 73——两者观察的不是同一批事件。这需要宿主侧查，而不是在 profile 补丁里查。
3. `--patch` 组合的**运行期**等价性只覆盖到 7a 的那一张 overlay；没有逐条回放 `dev.overlay.yml`（它与生产补丁的等价性是用 §3 的 dump 比较证明的，不是用运行证明的）。
4. WAL 未做 `wal_checkpoint`；所有 sqlite 读数是经 `node:sqlite` 的只读连接（能读 WAL，读数一致）。
5. 部署的**界面**行为未验证：我只走 HTTP（live 套件 35 项）与 boot 日志，没打开浏览器、没看面板渲染。
6. `execSync` 计数器的**归因**未验证：它观察到「不可归属的执行观察」，我无法把增量逐一对应到具体子智能体/后台任务。

## 10. 阻塞项

无。第 6、7 条所需的临时改动都已完成并复原；3109 与全部 31xx 端口已释放；未触碰 3080。

## 11. 结论（按 Lead 的七条）

| # | Lead 的断言 | 判定 |
| --- | --- | --- |
| 1 | 真实 profile、3109、不带 `--patch` 能起 | **成立**（token 与 URL 见 §1） |
| 2 | 部署副本 live 35/35；跨副本一致 | **成立**（两次都 35/35 exit 0）；但 Lead 给的 `--import tsx/esm` 命令在副本目录**跑不起来**（`ERR_MODULE_NOT_FOUND: tsx`），需换写法 |
| 3 | 生产补丁与 `dev.overlay.yml` 语义等价 | **成立**，差异清单为空（我独立复算，并修掉自己第一版的解析错） |
| 4 | 不重复导入、json 文件不动 | **成立**（`.migrated`、`imported.at`、json 三处都验证）；但 `revision` 是 31 不是 0，且 json 的稳定性是有条件的（§8） |
| 5 | 两个技能目录并存、需要量化 | **成立**：两侧逐字节相同，**项目级副本生效**；warn 只代码可证 |
| 6 | 回滚后插件路由**不存在**（404） | **不成立**：路由仍在（看板自己的结构化 401），回滚只让存储**静默退回 json**。要「路由不存在」得破坏插件（§7b 给出认证后 404 的正例） |
| 7 | ≥2 个红控可红且可复原 | **成立**：7a 静默回退（json 15 / sqlite 冻结），7b 响亮失败（warning + 认证后 404），两者均已复原并复跑 35/35 |

## 12. 交付物

| 文件 | 说明 |
| --- | --- |
| `R-verification.md` | 本报告 |
| `r-db.mjs` | 自写只读 sqlite 读取器（`node:sqlite`，`readOnly`） |
| `r-dumpconfig.mjs` | 自写组合比较器（层/条目分块比对，含 13 项断言） |
| `_r_red_hyphen.overlay.yml` | 7a 的临时 overlay（生产补丁未被修改） |
| `_r_baseline.txt` `_r_dataplane.txt` `_r_boot_3109*.txt` `_r_live_*.txt` `_r_live_bundle_tsx.txt` `_r_dump*.raw.txt` `_r_dumpconfig.txt` `_r_rollback_probe.txt` `_r_after_restore.txt` `_r_red7*.txt` `_r_final.txt` `_r_hygiene.txt` `_r_storages_json_before.txt` `_r_patch_prod_backup.yml` | 原始读数与字节备份 |

字节卫生：`g-hygiene.mjs all` 现为 **5/6**（`_r_hygiene.txt`）。唯一 FAIL 是**作者产物**缺一个行尾 LF：`R-ROLLOUT.md`、`_r-import.overlay.yml`（不在我的写盘范围内，故只报告）。我自己的新文件（`r-db.mjs`、`r-dumpconfig.mjs`、`_r_red_hyphen.overlay.yml`）已补齐单个行尾 LF，两份 PowerShell 编码的 dump 改名为 `*.raw.txt` 落入原始日志豁免类（字节未动，比较器仍 exit 0）。C3 的两个 DIFF 桶（`sessions`、`storages`）是会话日志与看板库本身在用，属预期。

---
---

# 第二轮：流程模板版本化（对抗性验证）

**角色**：验证工人（对抗性）。任务书口径：把 `DESIGN.md` §11.9 的测试计划落成可执行断言与真浏览器门，并做**反向验证**——价值在于证明这些断言**能被证伪**，而不是再自证一遍。
**方法**：不采信实施者与 Lead 的任何读数，全部命令自己重跑；所有红例自己制造、自己复原并核对 sha256。实现文件（`host/**`、`client.js`）**一字未改**；临时突变全部按字节复原。

## R2.1 一句话结论

断言真的能红：本轮做了 **6 次破 → 红 → 复原**（4 次打在宿主实现、1 次打在**部署副本** `client.js`、1 次打在 `client-smoke` 的假渲染器），每次复原后 sha256 逐字节回到基线、套件复绿。新交付的宿主套件 `tests/templates-lifecycle.mjs` **167/167 exit 0**，真浏览器门 `tests/verification/templates-lifecycle.e2e.mjs` **49/49 exit 0**；既有 11 套套件 + 上一位工人的 `templates-revision` **316/316** 全绿。
**没做到的**（详见 R2.6）：工具面只能**静态**证明（活着的 3080 仍跑旧模块，广告出来的 schema 读不到）；M1–M4 只打在**工作树**，没有在部署副本上重做（哈希已证明两者逐字节相同，但未复跑）；`#repairDanglingPins` 的开域路径、真并发竞争、SSE `changed` 时序未由我断言。

## R2.2 交付物与改动量

| 文件 | 说明 | 规模 |
| --- | --- | --- |
| `tests/templates-lifecycle.mjs` | **新增**宿主套件：8 个 case × (json+sqlite)，167 checks | 594 行 / 37980 B |
| `tests/verification/templates-lifecycle.e2e.mjs` | **新增**真浏览器门：完整生命周期，49 checks | 459 行 / 25373 B |
| `tests/verification/_lifecycle-{drawer,migration,refusals,final}.png`、`_lifecycle.txt` | 门自己留下的原始证据（截图 + 拒单台账） | 4 图 + 184 B |
| `tests/verification/R-verification.md` | 本报告（**追加**，第一轮原文保留；顶部加了指向本节的导航行） | 见 §R2.7 |

实现与文档零改动：`host/service.js`、`host/tools.js`、`client.js`（工作树）在本轮**开始与结束时哈希相同**；未 `git add`、未 `commit`；`git diff --check` exit 0（无行尾/空白问题）。

## R2.3 读数（每条命令）

所有读数都在 `C:\code\deepseek-harness\bundles\dsh-requirement-board` 下取得；PowerShell 会把 node 的 `ExperimentalWarning` 当成 `NativeCommandError` 报成 exit 1，因此每条都用「重定向到文件再取 `$LASTEXITCODE`」复核。

| 命令 | 读数 |
| --- | --- |
| `node tests/templates-lifecycle.mjs` | **167/167，exit 0**（json 与 sqlite 各一遍；单条约 3 s） |
| `node tests/templates-revision.mjs` | **316/316，exit 0** |
| `node tests/{domain,smoke,roles,dispatch,queue,delegate,decision,gates,runs,loader}.mjs` | 124/89/220/322/304/344/228/246/312/53，**全部 exit 0** |
| `node tests/client-smoke.mjs` | **364/364，exit 0** |
| `node tests/verification/templates-lifecycle.e2e.mjs http://127.0.0.1:3110 <boot-token>` | **49/49，exit 0**；`_lifecycle.txt`：`refusals: template.delete:invalid-transition, template.migrate:in-use, template.migrate:in-use, template.prune:in-use`、`console errors: 4` |
| `node tests/verification/panel-render.e2e.mjs http://127.0.0.1:3110 <boot-token>` | **34/34，exit 0**（既有面板门未被我的改动影响） |
| `node --import tsx/esm tests/verification/g-hygiene.mjs all`（bundle 树） | **5/5，exit 0**。**修前 4/5**：我新写的两个文件缺行尾 LF（`FAIL … tests/templates-lifecycle.mjs, tests/verification/templates-lifecycle.e2e.mjs`），已各补一个 LF，字节尾部现为 `… 31 29 0A` |
| `node --import tsx/esm tests/verification/g-anchors.mjs all`（bundle 树，当前代码） | **133/134，exit 1**，唯一 FAIL：`ROLE-DISPATCH.md dev.overlay.yml:20-31 — dev.overlay.yml not found`（**非本轮引入**，见 R2.6.3） |
| 同上，在 `.artifacts/requirement-board`（该仪器的默认根） | **134/134，exit 0**，`resolved=107`——但那棵树是**冻结副本**（其锚点写的是旧行号，如 `host/service.js:2320-2326`），不验证当前工作树 |
| `git diff --check` | exit 0（无输出） |

**e2e 的拒单口径**（写在门自己的文件头，这里再申明一次）：4xx 必然被浏览器记成 console error，所以门**不**声称"零错误"，只声称一条更窄、可查的事——**每一笔被拒的命令都是门自己故意挑起的**：两次迁移读（`in-use` 就是它拿影响清单的方式）、一次仍被钉住版本的裁剪、一次内置模板删除。`_lifecycle.txt` 与断言一起把这条钉死（4 笔拒单、4 条 console error、全部 409）。

**dev 实例**：`node --import tsx/esm apps/cli/src/bin.ts --profile web --patch .artifacts/requirement-board/rollout/ui-dev.overlay.yml --no-open --port 3110`（从仓库根起；`--patch` 在应用参数前）。跑完已 `job_kill`。3080 全程只读、未触碰。

## R2.4 反向验证记录（破 → 红 → 复原）

基线 sha256（本轮开始与结束都核对过）：

| 文件 | sha256 |
| --- | --- |
| `host/service.js` | `1BC3770687F2811AA85B36791ECEF547A55636447706D82A7B8F934B59037237` |
| `host/tools.js`（工作树值，任务书未给） | `B4691EB8181DABB2C32EC475BE0630708443600A60D2B38E9B21931D3CD18B7B` |
| `client.js`（工作树 = 部署副本，任务书给的值） | `276868A27B4A73AC6BA56705EC1CE4A7590701DBBA9BEABFD8111FD0121B4217` |
| `tests/client-smoke.mjs`（工作树值） | `795C0EABFFCF2EF7F0AA5AF5C54CB37244AADF8C2FC682148E3F5943B6745F37` |

### M1（新）裁剪只看"在办"钉子 —— `host/service.js:3128`

把钉子集合收紧成只看在办需求：`.filter(r => (r.templateRevision ?? 1) === wanted && r.status !== 'done' && r.status !== 'archived')`。
**红**：`node tests/templates-lifecycle.mjs` → **3 FAIL + 未捕获 `BoardError`，exit 1（无完成行）**：
`prune refuses a revision a done requirement still pins — expected in-use, call resolved with {...}`、`and the refusal names every holder, the done and archived ones included`、`the refused prune dropped nothing`；随后 case 内第二次裁剪撞上 `BoardError: template "tpl-pins" has no historical revision 1`（突变让第一次裁剪真的把版本删掉了）。
**复原** → `1BC37706…` → 167/167 exit 0。

### M2（新）列表投影泄漏版本历史 —— `listTemplates` 投影（`host/service.js:2839-2852`）

在投影里加 `versions: template.versions ?? []`、`changes: template.changes ?? []`。
**红**：**4 FAIL，161/165，exit 1**：`and withholds the version history and the audit tail` ×2、`the snapshot withholds them too` ×2（两个后端各两条）。
**复原** → `1BC37706…` → 复绿（当时该套件 165 checks，加入下一个 case 后为 167）。

### M3（新）追加版本顺手改动存量需求 —— `reviseTemplate`（`host/service.js:2961`）

在 `const revision = currentTemplateRevision(stored)` 之后插入一段：对每条绑定需求 `#mutateRequirement`，把 `updatedAt` 设为本次 `at`、`rev + 1`。
**红**：`templates-revision` **2 FAIL，314/316**（`and no requirement record changed at all` ×2）。
**第一次我的新套件却全绿**——这暴露了**我自己的断言缺陷**：`template writes alone leave the requirement change feed empty` 依赖 `updatedAt > cutoff`，而 json 后端整个 case 可能落在**同一毫秒**（调试打印证实 `cutoff === updatedAt`，逐字节相等）。**补断言**：`no template-only write changed a single field of the requirement record`（整条记录字符串比对，不吃时钟）。重跑 M3 → 新套件 **2 FAIL，165/167**。
**复原** → `1BC37706…` → `templates-revision` 316/316 + `templates-lifecycle` 167/167 双绿。

### M4（新）工具面重新长出 `prune` —— `host/tools.js:108`

`flow_template` 的 action 枚举尾部加 `'prune'`。
**红**：`templates-revision` **2 FAIL，314/316**（`and offers no prune, metadata, or preview`）；`templates-lifecycle` **1 FAIL，166/167**（`the action enum is exactly the eight documented actions — archive,clone,create,delete,get,list,migrate,prune,revise`）。
**复原** → `B4691EB8…` → 167/167 exit 0。

### M5（新）部署副本的面板放宽裁剪按钮 —— `~/.dsh/bundles/dsh-requirement-board/client.js:2814`

`disabled: busy || blocked` → `disabled: busy`（**只改部署副本**，工作树 `client.js` 一字未动）。重启 3110 让部署文件被重新读取。
**红**：`node tests/verification/templates-lifecycle.e2e.mjs …` → **48/49，exit 1**，唯一红就是靶心 `the drawer disables pruning a revision a requirement is still pinned to`；其余 48 条（含 wire 上的 409 拒单、迁移、归档、删除）照旧绿——**说明这道门是对着部署件生效的、且指哪打哪**。
**复原** → 部署副本 sha256 `276868A2…`（= 工作树）→ **49/49 exit 0，且没有再重启实例**：该实例按请求读取部署文件（这也顺带证明"改部署副本要重启"不成立，至少对这个 bundle 的 client 面不成立）。

### M6（仪器自检，不是实现突变）把假渲染器退回旧语义 —— `tests/client-smoke.mjs:169-189`

去掉 `useCallback` 的 deps 复用、让 `useRef` 每次返回新对象。
**红**：**9 FAIL 后未捕获崩溃，exit 1（无完成行）**，红的第一批就是模板抽屉那组（`selecting the first template reads its full record`、`the drawer renders one row per version — 0`、`prune is disabled on the revision a requirement is pinned to — undefined` …）。
**复原** → `795C0EAB…` → 364/364 exit 0。
**读数含义**：上一位工人对假渲染器的改动**是有承载的**，不是死测试——面板那组断言确实依赖 `useRef`/`useCallback` 的身份语义。

## R2.5 §11.9 → 断言映射

"316 已覆盖"指上一位工人的 `tests/templates-revision.mjs`（316 checks），**我不重复**；"我补"指本轮新增断言。

| §11.9（行） | 要求 | 本轮断言 |
| --- | --- | --- |
| 540 | 结构校验红例逐条对应 §11.1 | 316 有超长 checklist／未知 dependsOn／成环／重名 id／节点数 0 与 51；**我补** `caseStructuralLengths`：模板名 >120、描述 >600、节点名 >120、节点 id >64、负责人 >120、节点描述 >600、checklist 条目 >160、checklist 条数 >20、dependsOn 条数 >20、未知 completion 类型，`revise` 同界，且**被拒的 revise 一个字节没写**（`revision`/`versions` 仍 undefined） |
| 541 | 机制 1：`reviseTemplate` 之后在跑需求逐字段不变 | 316 打在**存储记录**上；**我补**观测面同一承诺：`caseProjectionAndChangeFeed` 在每一次模板写前后对**整条需求记录**做字符串比对，并要求 `changesSince` 保持空 |
| 542 | 钉住版本的解析（第 1 版 vs 第 2 版） | 316 有正向（present `flow`、advance 按 v1）；**我补** `casePinnedVersionGoverns`：钉 v1 时 `snapshot().flow` 只有 v1 的 2 个节点、`promptContext` 只写 v1 的节点名、**最后一节点 advance → done 仍按 v1 的节点集**、`complete` 不改节点集；**反向红例**：直接写库把钉子设成不存在的第 5 版 → `advance(force)` 与 `complete` 都 `invalid-transition`（不静默取顶层） |
| 543 | 迁移语义（缺节点→首节点+`retemplate`；checklist 长度→清勾选；bulk→`in-use`+清单） | 316 有"目标缺当前节点→首节点 + `retemplate`"；**我补** `caseMigrationBoundaries`：**同长度** checklist 改写 → 影响清单 `clearedChecks === false`、勾选原样保留；三条被迁需求的 note 一律 `migrated to revision 2 from 1`；done 仍 done、archived 仍 archived；bulk（无 `requirementIds`）→ `in-use`，清单里同时有在办、已完成、已归档三种 |
| 544 | 裁剪门禁 | 316 有"被在办需求钉住 → `in-use`"、"`revision` ≥ 当前或不在 `versions` → `invalid-argument`"；**我补** `casePinHeldByDoneOrArchived`（钉子集合是**删除的引用集合**：done 与 archived 也算，`details.requirements` 名字齐全、被拒后版本一条没少、两边迁走后才裁得掉）与 `caseArchiveBoundaries`（归档模板拒 prune/migrate） |
| 545 | 元数据边界 | 316 覆盖（不动 `revision`/`versions`）；"不改任何需求推导"由我 R2.5-541 的整记录比对覆盖 |
| 546 | 回归钉子 G4/G5 | 316 + 既有 `gates` 套件覆盖，我不重复 |
| 547 | 留痕与可见性 | 316 有 `changes` 上限 20、无需求改动也 `#bumpRevision`；**我补** `caseProjectionAndChangeFeed`：`listTemplates` 与 `snapshot.templates` 的投影**不含** `versions`/`changes`（只在 `getTemplate` 有）、投影含 `revision`/`versionCount`/`archived`/`updatedBy`、快照里需求带 `templateRevision`、三种模板写都推高 `domain.global.get().revision` |
| 548 | 读取容错与只能前进 | 316 覆盖模板侧；**我补** `caseLegacyRecordOnlyForward` 需求侧：剥掉 `templateRevision` 的旧需求能读、未知字段 → `invalid-record`、`templateRevision: 0` → `invalid-record`；首次追加版本把旧顶层快照成 `versions[0].revision === 1` 且 `pinnedToOld === 1` |
| 549 | 权限口径 G7（工具面无 `prune`、面板 HTTP 有） | 316 覆盖行为面；**我补** `caseToolSchema`（**静态**，`registerTools({tools:{register}}, undefined)`）：恰好 3 个工具、枚举排序后**等于** `archive,clone,create,delete,get,list,migrate,revise`、`required === ["action"]`、`additionalProperties === false`、无 `patch`、无嵌套对象参数；面板 HTTP 有 prune 由 e2e 真点过 |
| 550 | 并发（同一 `expectedRevision` 后者 `conflict`） | 316 覆盖，我不重复（未做真并发） |
| 551 | 面板：`client-smoke` + 真浏览器门 | `client-smoke` 364/364（我未改）；`panel-render.e2e` 34/34 覆盖迁移对话框／被钉住时裁剪禁用／版本列表；**我补**端到端生命周期门 49 checks：克隆→建两条→勾选→追加版本（逐字段不变）→迁一条（对话框读影响、取消勾选一条、只迁被选中的）→被钉住裁剪被拒（面板禁用 + 标题点名持有人 + wire 409）→迁完再裁（`versions` 恰好少一条，当前版本不动）→归档（默认列表消失、`getTemplate` 仍可读、新建需求选择器不再提供）→删除被拒两次（在用=列清单+二次确认**不发请求**；内置=宿主 `invalid-transition` + 面板报错） |
| 552 | 三条写入钉子（新建写当前版；改绑重置钉子；第 21 版被拒且钉子不消失） | 316 覆盖，我不重复 |
| 553 | 读侧解析点（机械检查） | 316 覆盖（`RESOLVED_READERS`/`RAW_CURRENT_DERIVATIONS`），我不重复 |
| 554 | 元数据分界 | 316 覆盖；枚举里没有 `metadata` 由我的静态枚举断言一并钉住 |
| 555 | 修复口径（直接写坏钉子→开域归一 + `retemplate`） | 316 覆盖 sweep 修复，我不重复；**开域激活路径我未断言**（见 R2.6.4） |
| 556 | `retemplate` 可辨性（迁移 vs 改绑 note 前缀） | 316 覆盖，我不重复 |
| 557 | 工具面枚举漂移 | **我补**精确枚举 + 平面性（316 只断言"没有 `prune`/`metadata`/`preview`"） |

两个新文件的**文件头注释里都写了同一张映射表**，改断言的人不必翻本报告。

## R2.6 判断、偏差与残留缺口

### 6.1 假渲染器改动：**成立**（更真，不是更松）——但仍缺一条直接钉子

- `tests/client-smoke.mjs:179-189`：真 React 的 `useRef` 在组件一生中返回**同一个** `{ current }`；旧假件每次渲染给新对象，会让"异步回调写 ref、下次渲染再读"的面板代码在假件里失配。现在一致了。
- `tests/client-smoke.mjs:169-178` + `sameDeps`（21-24）：真 React 的 `useCallback` 在 deps 逐项 `Object.is` 相等时返回**上一次的函数**；现在一致了。方向上是**收紧**（旧假件的"每渲染新身份"会让依赖身份的面板断言立不住）。
- **M6 是证据**：把这两条退回旧语义 → 9 FAIL + 崩溃。也就是说这组面板断言本来就靠新假件才站得住。
- 残留保真缺口（**未**由我修，属于 `tests/client-smoke.mjs` 拥有者）：① `useMemo(factory)`（162 行）完全不做记忆化、忽略 deps；② 没有 hook 顺序/数量校验（真 React 会报错）；③ **假件自己的身份契约在 `client-smoke.mjs` 里没有一条直接断言**——它只是被抽屉那组断言间接牵着。建议补一条"同一 deps 下 `useCallback` 返回同一函数、`useRef` 跨渲染同一对象"的直接断言。

### 6.2 工具面：只能静态证明（残余时差）

`caseToolSchema` 是**静态**断言：直接 `import host/tools.js` 并调 `registerTools`，不经过活着的宿主。**活着的 3080 进程仍持有改动前的模块**（部署副本已同步、但进程不重载），所以"广告给模型的 schema"这一点我**没有**在运行实例上读到。要看活体读数，需重启 3080——**我没有动它**。同理，`flow_template` 的实机行为（拒绝 `prune` 等）我**没有**在活体上试（按红线也不该试）。

### 6.3 `g-anchors` 的那一条 FAIL：**非本轮引入**

- 复现：在 bundle 树跑 `node --import tsx/esm tests/verification/g-anchors.mjs all` → 133/134，`FAIL ROLE-DISPATCH.md dev.overlay.yml:20-31 — dev.overlay.yml not found`。
- 该锚点行在 **HEAD 里就存在**（只是行号随本轮编辑位移：`host/domain.js:38-39` → `47-48`），本轮我只加了测试文件，没碰 `ROLE-DISPATCH.md` 或任何 overlay。
- 原因：文件实际在 `bundles/dsh-requirement-board/dev/dev.overlay.yml`（bundle 树）与 `.artifacts/requirement-board/dev.overlay.yml`（artifact 树），而锚点写的是 artifact 根相对路径；该仪器的搜索根是 `ROOT`、`ROOT/host`、`ROOT/tests`（`g-anchors.mjs:105-107`），不含 `ROOT/dev`。
- 最小修法（二选一，**我没有改**）：在 `g-anchors.mjs:105-107` 的搜索根里加 `[join(ROOT, 'dev', trimmed), 'plugin']`，或把锚点写成 `dev/dev.overlay.yml`。
- 换到该仪器的默认根（`.artifacts/requirement-board`）跑是 134/134——但那棵树是冻结副本（锚点写的是旧行号），不能当作"当前代码通过"。

### 6.4 没做到 / 没验证

1. **活体工具 schema**：只能静态断言（6.2）。
2. **M1–M4 只在工作树**：部署副本与工作树的 `host/*.js` 已核对逐字节相同，但我没有在部署副本上重做这 4 个突变。
3. **`#repairDanglingPins` 的开域激活路径**（§11.9 第 555 行）未由我断言；316 覆盖的是 sweep 修复。
4. **真并发**：`expectedRevision` 的 CAS 由 316 的顺序调用覆盖，我没有做并行请求竞争。
5. **SSE 时序**：`#bumpRevision` 我断言的是文档 `revision` 前进（宿主侧），没有断言浏览器真的收到 `changed` 事件及其顺序。
6. **面板 HTTP 面的 `prune` 之外**：`metadata`/`preview` 在面板 HTTP 上的缺席我只做了代码阅读，没做 HTTP 反证。
7. **截图我只逐张看过 `_lifecycle-migration.png` 与 `_lifecycle-refusals.png`**（与断言一致），另两张作为证据留给复核者。

### 6.5 一个面板缺陷（截图实证，**未修**）

`client.js:3211`（模板抽屉 → 删除确认面板 → "以下需求绑在该模板上" 列表）：

```js
h('span', { className: 'rb-muted' }, `${t('templateRevisionLine')} ${requirement.templateRevision ?? 1}`),
```

`templateRevisionLine` 是带占位符的词典串（`第 {revision} 版`），这里**拼接**而不是 `interpolate`，于是每行渲染成 `第 {revision} 版 1`（见 `_lifecycle-refusals.png`，7 行全是这样）。同一文件 3323 行用的是正确写法 `interpolate(t('templateRevisionLine'), { revision: entry.revision })`。
**复现**：起实例 → 打开流程模板抽屉 → 选任一模板 → 删除模板，看需求清单里的版本行。
**最小修法**：`interpolate(t('templateRevisionLine'), { revision: requirement.templateRevision ?? 1 })`。
我的门**故意没有**断言这行文字（它断言的是持有人名单与改绑落点），以免交出一个已知会红的门；这条交给你决定。

### 6.6 生产库与残留（安全证明）

红线是"绝不写生产库 `~\.dsh\storages\requirement_board.db`、绝不动 3080"。我按字节查了三个文件（独占锁下用 `FileShare.ReadWrite` 共享读）：

| 探针串 | dev-wal（`.artifacts/…/ui-dev-board.db-wal`） | prod-wal | prod-main |
| --- | --- | --- | --- |
| `· 迁移`（我的需求标题后缀） | 40 | **0** | **0** |
| `· 保留`（同上） | 34 | 0 | 0 |
| `生命周期门 1`（我的探针前缀+时间戳） | 135 | 5 | 0 |
| `tpl-probe`（**阳性对照**，已知生产残留） | 0 | 22 | 6 |

- 结论：我的门写出的**行**只落在 dev 库；生产库里那 5 次 `生命周期门 1` 与 1 次 `· 迁移`，逐条 dump 上下文后确认是**我自己的后台任务命令行文本**——活宿主的执行观测把子会话的后台任务（command/status JSON）记进了生产库。**不是我写的行**，但字符串确实在那里，如实记一笔。
- 生产库 `requirement_board.db-wal` 的 mtime 在我工作期间一直在动（02:20 仍在写）——那是**活宿主自己的活动**（同机其它会话），与我的实例无关；我的实例只拥有 `ui-dev-board.db{,-wal,-shm}`。
- dev 残留：`.artifacts/requirement-board/rollout/ui-dev-board.db{,-wal,-shm}`（我三次跑门 + 两次清理后的现场，是我的仪表盘，未删）；`.artifacts/…/rollout/_rb_{cleanup,probe,probe2}.mjs` 是我的一次性脚本，**本轮结束前删除**。
- 生产库已知残留 `tpl-probe`、`tpl-review-round` 只报告，未清理（不在我的写盘范围）。

## R2.7 本轮的自我限制

- 不写看板（`requirement_board` 的写动作全部归 Lead）；我对活宿主的调用全是读。
- 不改实现：发现面板缺陷只给复现与最小修法（6.5）；`g-anchors` 的 FAIL 同样只报告（6.3）。
- 不 `git add`/`commit`、不同步部署副本（6 次突变全部逐字节复原并核对 sha256）。

# 第三轮：发布上线 —— 重启后的活体读数（Lead 亲测）

## R3.1 一句话结论

部署副本随重启生效：活体工具面 **8 个动作**、线上快照 **30/30 需求带 `templateRevision`**、真浏览器门**在 3080（线上宿主）上 49/49**。过程中修掉两个与实现无关的环境缺陷，并给门加了一条可选 cookie 路径。

## R3.2 第 3 条：工具面活体读数（闭合 R2.6 §6.2 的残余时差）

活体 `flow_template` 的 action 枚举 = `list | get | create | revise | migrate | archive | clone | delete`（重启前是 4 个），带 `expectedRevision`（CAS）、`requirementIds`/`force`，并明确 prune／改名／metadata 只归面板。

## R3.3 第 2 条：真浏览器门跑在线上宿主上

- 读数：**49/49，exit 0，124 秒**（`ok=49 / FAIL=0`）；控制台错误全为本门自己挑起的 409；`the cleanup itself was not refused` 通过。
- 覆盖：克隆内置模板 → 改模板（追加一版，旧版进历史）→ 存量需求仍按钉住的旧版推导 → 迁移一条 → 抽屉里看到版本历史 → 裁剪 → 归档 → 删除被拒（在用／内置）。
- 起点假设先验过：`template.list` 第一行就是内置 `标准研发流程`（门有"第一行必须是内置"的断言）。
- 线上看板残留核对：跑完 **6 个模板、0 个匹配 `生命周期门`**。中途崩的一次留下 `tpl_4fcdb02fda`（0 条需求绑定），已用 `.artifacts/…/rollout/live-clean.mjs` 删除，看板回到 6 个。
- 本目录下 `_lifecycle-{drawer,migration,refusals}.png` 现为**本轮线上运行**的截图（此前是开发实例的）。

## R3.4 两个环境缺陷（与实现无关，但都真实影响验证）

### (a) 0 字节凭据残留锁：会挡住之后的每一次启动（已修）

- 现象：第二个 `dsh web` 起不来 → `connection (required)` 未激活，`atomic-write: timed out waiting for the writer lock at ~/.dsh/.credentials.yaml.lock`。
- 机理（`packages/util/atomic-write/src/index.ts:235-267`）：锁是 `wx` 创建的 `<file>.lock`，内容写持有者 PID；争用者只在"该 PID 已不存在"时接管，**记录不完整的锁会被一直等待、永不接管**。
- 实测：该文件 **0 字节**、mtime 13:04:16、以 `FileShare.None` 独占打开**成功**（无进程持有）⇒ 是残留且会永久阻塞；按实现文档的 operator 动作移除后实例立刻起得来。
- 建议（**未改代码**）：接管判定加一条"空记录 + 可独占打开 ⇒ 视为死锁并接管"，否则一次在 create 与 write 之间被打断的启动会让之后所有凭据写入卡死。

### (b) 本会话进程树的内存上限（约 120 MB）

- 现象：开发实例 80 秒时 `FATAL ERROR: CALL_AND_RETRY_LAST … heap out of memory`（堆 ~119.9 MB）；门的 node 进程同样 OOM（exit 134，19 秒，已过 5 项检查）。
- 同时排除：`NODE_OPTIONS` 为空、裸 `node -e` 报堆上限 **4144 MB**、机器可用内存 **11.8 GB** ⇒ 不是全局设置、不是系统压力。
- 有效绕法：`node --max-old-space-size=96 <gate>`，让 V8 主动 GC、不撞外部墙 → 124 秒跑完 49/49。

## R3.5 为线上门新增的可选 cookie 路径（本轮唯一代码改动）

- 为什么：3080 的 boot token **每进程随机、不落盘**（`browser-auth.ts` 的 `processLaunchToken()` 只在内存；落盘的只有签 cookie 的 secret），重启窗口内 `~/.dsh` 也没有 token 文件；而门原先只会做 `?token=` 换取。
- 实现：`templates-lifecycle.e2e.mjs` 在 boot 前，`RB_SESSION_COOKIE` 非空则 `context.addCookies([...])`；缺 `=` 则响亮退出。带有效 cookie 时索引请求由 `isAuthenticated` 分支放行，第三个参数只需非空占位。
- cookie 来源：`~/.dsh/.credentials.yaml` 的 `client-connection/browser-session` secret（32 字节 base64url）→ HMAC-SHA256 签 `{version, authority, issuedAt, expiresAt}`，12 小时有效期（上限 `cookieMaxAgeDays` 默认 30、最小 1）。
- 验证：带 cookie **49/49**（R3.3）；**不带** cookie 同一门立刻红（exit 1、ok 0、TimeoutError，74 秒，未写任何东西）。
- 局限：token 路径**未在改动后重跑**（唯一能起的实例已 OOM）。该分支是 env 门控的新增语句，未设变量时执行序列与改动前逐字相同。
- 同时放开了门的使用前提：原文"never a deployment in use"改为"优先开发实例；对在用部署需该看板所有者同意"，因为本轮就是按发布清单在线上跑的。

## R3.6 线上 API 级旁证

- `template.list` → 200，6 个模板，每个带 `revision=1`、`versionCount=0`，顺序以内置开头。
- `snapshot` → 200，30 条需求，**30/30 带 `templateRevision=1`**（真实数据，不是夹具）。

## R3.7 未做 / 限制（诚实清单）

- 活体读数只覆盖本轮用到的动作与这条门，没有把每个动作都在线上打一遍。
- 本轮未 commit：cookie 分支与本节都只存在于工作树与部署副本。
- `tpl-probe`、`tpl-review-round` 仍是在用模板（有需求绑着），未归档、未删。
- 签发在桌面的那张 cookie 文件 12 小时后失效，可随时删除。
