# dsh-art-director · 美术总监专家预设

把交付包 `production/presets/art-director-交付包.md` 落成一个可用的 dsh agent preset：
**维奥拉 · 美术总监**（preset id `art-director`，`order` 69）。

立项理由（需求原文）：`req_cc85142d94`「产出 Art Bible（美术风格仲裁文档）」从 2026-10-08 起挂着没人接，
而项目的风格决策**已经定了一大半**（`美术资源规划-v1.md` 507 行可执行规格 ＋ `game-concept.md` §9 Visual Identity Anchor
＋ 核芯判断 ＋ 47/165 张人裁定案）——缺的不是"定风格的人"，是"**收敛与仲裁**的人"与"放量门禁的判定人"。

> 本包只做 **DSH 侧配置**（preset ＋ 角色声明 ＋ 自检），**不碰游戏仓库代码**，也**不改其它预设的行为**。

---

## 1. 结论先行

| 项 | 决定 |
|---|---|
| 形态 | **单专家预设**（一个 persona ＋ 一套工具面 ＋ 一个角色声明），无 skills 包（上游附件里没有，见 §6） |
| persona | 交付包 **§3 正文逐字**（60 行 / 4,637 字），不手抄：由 `tools/gen-preset.mjs` 从交付包生成 |
| 角色声明 | 交付包 **§1 isolate 组逐字**：`roleId: art-director` · 7 条 `duties`；**随包走**，不在 profile 层重述 |
| 组合基线 | 照 `standard` preset 的对应行**逐字段一致**；裁掉 delegation / planning / goal / skill / schedule / plugin-manager |
| `order` | **69**（不是交付包建议的 68——67 已被 `godot-tech-director`、68 已被 `producer` 占用，见 §2） |
| 安装位置 | `C:\code\deepseek-harness\bundles\dsh-art-director`（与 `dsh-godot-tech-director`、`dsh-godot-qa-expert` 同址） |

---

## 2. 交付包 → 落点的逐项对应

| 交付包 | 要求 | 落点 |
|---|---|---|
| §1 | 角色声明组（`roleId` / `roleName` / 7 duties），**不可省** `isolate: { requirementBoardRole: true }` | `presets/art-director.patch.yml` 的 `requirement-board-role` 组，逐字生成 |
| §2 | 预设骨架：`order`、各行照 standard 基线、⚠️ `tool-fs-search.sampleOverCapGlobResults` **必填** | 同文件 14 行行集；`tools/ard-check.mjs` 对必填 Config 逐条断言 |
| §2 | `persona.suffix` 放本机事实（Godot 可执行文件位置 ＋ "不要臆造版本号"） | `suffix`：`D:\Godot\` 下 4.7.2-stable 的两个 exe ＋「调用前先列目录确认」 |
| §3 | persona 正文整段进 `prefix` | 逐字；`ard-check` 断言 `prefix === §3 正文` |
| §2 | `config.id` = roleId、`config.name` = 卡里的花名 | `art-director` / `维奥拉 · 美术总监`（`ard-check` 断言两者一致） |
| §2 | 装完照同类自建包写并跑一遍 `tools/*-check.mjs` | `tools/ard-check.mjs`（契约 ＋ 逐字 ＋ 漂移 ＋ 外部事实） |

**三处有意的偏离**（都记在这里，避免下次有人把它当漏做）：

1. **`order` 68 → 69**。交付包 §2 建议 68，但 68 在 2026-10-11 已由 `producer`（`~/.dsh/bundles/dsh-producer/presets/producer.patch.yml`）占用，
   67 由 `godot-tech-director` 占用。`ard-check` 每次现场扫描同族 `presets/` 下的 `order` 值，**并断言 67/68 确有占用、69 未冲突**——
   所以这条不是一次性判断，而是可复查的断言。
2. **`description` 无权威原文**。交付包只给了一个「如「Art Bible ／ 风格仲裁 ／ 资产规格与命名 ／ 放量门禁」」的示例，
   且要求「按 §1 的 7 条 duties 归纳」。落点取 5 个签注面：`Art Bible 制定维护 / 美术风格与视觉仲裁 / 资产规格与命名 / 界面视觉定调 / 美术放量门禁`。
3. **`suffix` 不重复 §3 已有的取证句**。模板（`dsh-godot-tech-director`）的 suffix 末尾是「……不要臆造版本号；引擎行为主张必须能指到实测，不得凭记忆断言 API」。
   art-director 的 §3 正文里**已经有**同类纪律（`## 项目锚定` 的「与此冲突的一律先纠正自己」＋ Q4 的 `NOT ASSESSED` 处理），
   照抄会变成同一句纪律说两遍 ⇒ 本包 suffix **只补 `{{cwd}}` 与本机 Godot 事实**。`ard-check` 有一条断言专门拦这种重复。

---

## 3. 组合行表（14 行）

| 行 | 插件 | 关键配置 |
|---|---|---|
| `persona` | `@deepseek-ai/dsh-persona` | §3 正文（4,637 字）＋ 本机 Godot 事实 |
| `agent-instructions` | `@deepseek-ai/dsh-agent-instructions` | `maxBytes: 65536`——它要守项目红线与既有美术规格，项目 `AGENTS.md` 该生效 |
| `time-context` | `@deepseek-ai/dsh-time-context` | 与当前 `standard` 基线对齐（同族 2026-10-01 的四个旧包没有这一行） |
| `tool-bash` / `tool-pwsh` | — | 平台二选一，`!!js` 判平台（`!js` 是非法写法） |
| `tool-fs` / `tool-fs-search` | — | `sampleOverCapGlobResults: false`（**必填**，漏掉即整条 preset 变 broken） |
| `tool-jobs` | — | 长跑取证（批量核色带、跑门禁脚本）走后台作业 |
| `compaction` | `cordis:group` | 3 成员（basic / compact 命令 / result-pruner）＋ 两个 isolate 标志 |
| `tool-ask-user` / `tool-todo` / `present` | — | 照基线；`allowParallelInProgress: true` |
| `tool-web` | `@deepseek-ai/dsh-tool-web` | `fetch: true` / `searchTimeoutMs: 60000`——参考锚点检索与素材来源核实要联网 |
| `requirement-board-role` | `cordis:group` ＋ `dsh-requirement-board/role` | **必须包在 `isolate: { requirementBoardRole: true }` 组内**；`roleId: art-director` |

**为什么这是唯一证据**：本机 `standard` / `godot-game-suite` 就是「有角色 id、缺职能」的下场——看板按职能路由时收不到活。
所以 `duties` 非空且与交付包 §1 逐字一致，是「这个角色能按职能接到活」的判据。

---

## 4. 落地与取证（2026-10-11 · cordis）

| 步骤 | 结果 | 证据来源 |
|---|---|---|
| 生成 preset | `node tools/gen-preset.mjs --write` → **8,715 字符 / 149 行 / 14,500 B** / LF / 无 BOM | 本施工会话实跑 |
| 静态契约（装前） | `node tools/ard-check.mjs` → 通过 118 项 / **FAIL 1 项**：`web profile 未接线 dsh-art-director`（未安装⇒预期红） | 本施工会话实跑 |
| 静态契约（装后） | `node tools/ard-check.mjs` → **通过 128 项 / 全部契约检查通过（exit 0）** | 本施工会话实跑 |
| 文本卫生 | BOM / 尾换行 / U+FFFD / CR / 占位残渣 / 悬空链接 / 机器路径泄漏 全绿 | `ard-check` 卫生组 |
| 生成器无漂移 | 磁盘 preset == `tools/gen-preset.mjs` 渲染结果（逐字节） | `ard-check` 漂移断言 |
| 变异测试（断言不是摆设） | 14 个变异体（删必填 Config / `order` 改 68 / 改 duty / 删 isolate / roleId 改形 / 手改 persona / `!js` / BOM / 机器路径泄漏 / 占位残渣 / 包名 / 删行 / tool-web 漂移 / 删文件）→ **14/14 全部 exit 1，无静默通过** | 本施工会话实跑 |
| 接线 A/B（三态） | 假 `USERPROFILE` 下：未安装 → 1 红；半接线（只有 link 依赖）→ 1 红；两处齐全 → exit 0 | 本施工会话实跑 |
| 装入 profile | 已观察 `~/.dsh/profiles/web/package.json` 含 `"dsh-art-director": "link:C:/code/deepseek-harness/bundles/dsh-art-director"` 且 `dsh.profile.bundles` 列出本包（文件 mtime `2026-10-11 04:42:27`）——**由主会话安装，本施工会话未调用 `plugin_manager`** | profile 文件元数据 |
| 激活（进程内名册） | ✅ `list_plugins` → `include:preset-art-director`：`enabled: true` · `fiberPhase: active` · 无诊断 | 清单共 209 条 |
| 激活（启动期日志 A/B） | ✅ 干净启动日志 9,259 B / preset 命中 **0**；抽掉必填 Config 后 10,524 B / 点名 `agent preset art-director: tool-fs-search … invalid config`；已还原且字节一致（14,500 B） | 见 INSTALL.md §4 |
| 既有门禁回归 | ✅ `gtd-check` / `prd-check` / `gsd-check` / `gse-check` / `gqe-check` 全绿（exit 0） | 另 `uxcheck` 116 项 exit 0 |
| 角色可查 | ⏳ **待新建会话**：安装后 `requirement_role list` 仍**不会**出现 `art-director`（声明在 isolate 组内，只有活会话能读到） | 待新建会话 |

**接线断言不是「未安装即红」的固定红**：它读**当下**的 profile 状态并断言自洽——未安装时红（预期），
已安装时绿，**半接线（只有 link 依赖没进 `bundles` 列表）单独报错**。三条路径都实测过（见上「接线 A/B」）。
**不要为了让脚本变绿而删掉它**——它是「装上了没有」的唯一静态证据。

---

## 5. 维护要点（与同族自建包同一套教训）

- **抄来的行必须逐字段一致**。上游给某行新增**必填** Config 字段时，抄来的行会缺字段 → 该行激活失败 →
  **整条 preset 变 broken**，而 GUI 里只表现为「选择器里看不到它」。已发生的实例：`tool-fs-search` 的
  `sampleOverCapGlobResults`。改动后先跑 `tools/ard-check.mjs`。
- **带 id 的补丁行是 config 整体替换、不深合并**；profile 用户层在 bundle 层之后应用。
  本包**刻意不在** `~/.dsh/profiles/web/cordis.patch.yml` 里重述整条 config（重述即漂移），角色声明随包走。
- **persona 不手改**：改内容改交付包，再 `node tools/gen-preset.mjs --write`；`ard-check` 的「磁盘文件 == 生成器输出」会拦下手改。
- **与 `producer` / `ux-designer` / `godot-shader-developer` 的三个分界**（persona 已写明）：
  产能数字 → `producer`；可用性 → `ux-designer`（冲突时**以可读性优先**）；材质光照**实现** → `godot-shader-developer`（口径仍归本角色）。
  2026-10-11 同日施工后，这三个角色在本机都已有 preset（`producer` order 68 · `ux-designer` order 70），
  所以 persona 里点名它们不再是前瞻引用；`ard-check` 的 order 现场快照会随同族新增自动更新。

---

## 6. 未做与已知缺口

- **没有 skills 包**：上游 `art-director.md` 附件里没有 skills 包/脚本/模板（同族三份都没有）。
  persona 里引的 `/art-bible` 与 `/asset-spec` 是**游戏仓库侧既有技能**，不是本包提供的。
- **不碰游戏仓库**：本包未向 `D:\Godot\projects\dndGame` 写入任何字节；只读它 `production/presets/` 下的交付包。
  （唯一的写入是本包完成后由施工会话向交付包 **§6 追加一节施工回执**，那是任务要求的回写。）
- **附件 frontmatter 未收录**：`displayName` / `profession` / `maxTurns: 50` 本机 preset 不读。
- **交付包 §6 的 `\---` 疑点已核实**（实读只读副本）：附件 55 行，第 **1 行与第 19 行**是 `\---`（转义形态），
  **不是**交付包写的「第 1 / 11 行」（第 11 行是空行）。本包不读 frontmatter，故不构成阻塞；详见 NOTICE.md。
