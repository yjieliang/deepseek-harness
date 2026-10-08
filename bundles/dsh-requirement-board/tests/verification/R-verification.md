# Stage R 独立验证报告（composition-verifier）

验证对象：阶段 R「把需求看板做成可部署 bundle 并切到 sqlite 存储」的七项断言。
方法：独立复算（自写读取器 / 组合比较器），只读取证；生产文件只在第 6、7 条做临时改动，且每次改动后按字节复原并核对 sha256。
作者：composition-verifier（反证角色）。本报告不改实现、不改文档、不改 `tests/live.mjs`。

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
| `SKILL.md` | 两侧**逐字节相同**：16152 B，sha256 前缀 `625BB869A5C2A944` |
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
