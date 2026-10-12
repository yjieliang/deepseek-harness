# dsh-godot-tech-director · 技术总监专家预设

把交付包 `production/presets/godot-tech-director-交付包.md` 落成一个可用的 dsh agent preset：
**权衡 · 技术总监 · Godot 专家**（preset id `godot-tech-director`，`order` 67）。

立项理由（需求原文）：《诡秘之主》的性能阈值已经钉死却没人负责核对，架构决策也没有技术验收方——
这个预设补的就是「技术终裁／性能预算／ADR 验收签注／技术门控与豁免」这四个签注权。

> 本包只做 **DSH 侧配置**（preset ＋ 角色声明 ＋ 自检），**不碰游戏仓库代码**，也**不改其它预设的行为**。

---

## 1. 结论先行

| 项 | 决定 |
|---|---|
| 形态 | **单专家预设**（一个 persona ＋ 一套工具面 ＋ 一个角色声明），无 skills 包（理由见 §5） |
| persona | 交付包 **§4 正文逐字**（180 行），不手抄：由 `tools/gen-preset.mjs` 从交付包生成 |
| 角色声明 | 交付包 **§1 isolate 组逐字**：`roleId: godot-tech-director` · 8 条 `duties`；**随包走**，不在 profile 层重述 |
| 组合基线 | 照发行版 `standard` preset 的对应行**逐字段一致**；裁掉 delegation / planning / goal / skill / schedule / plugin-manager |
| `order` | **67**（不是交付包建议的 66——66 已被 2026-10-11 装上的 `godot-qa-expert` 占用，见 §4） |
| 安装位置 | `C:\code\deepseek-harness\bundles\dsh-godot-tech-director`（与 `dsh-godot-qa-expert`、`dsh-godot-engine-reviewer` 同址） |

---

## 2. 交付包 → 落点的逐项对应

| 交付包 | 要求 | 落点 |
|---|---|---|
| §1 | 角色声明组（`roleId` / `roleName` / 8 duties），**不可省** `isolate: { requirementBoardRole: true }` | `presets/godot-tech-director.patch.yml` 的 `requirement-board-role` 组，逐字生成 |
| §2 | 预设骨架：`order`、各行照 standard 基线、⚠️ `tool-fs-search.sampleOverCapGlobResults` **必填** | 同文件 14 行行集；`tools/gtd-check.mjs` 对必填 Config 逐条断言 |
| §2 | `persona.suffix` 放本机事实（Godot 可执行文件位置 ＋ 不要臆造版本号） | `suffix`：`D:\Godot\` 下 4.7.2-stable 的两个 exe ＋「调用前先列目录确认」 |
| §4 | persona 正文整段进 `prefix` | 逐字；`gtd-check` 断言 `prefix === §4 正文` |
| §2 | 装完照同类自建包写并跑一遍 `tools/*-check.mjs` | `tools/gtd-check.mjs`（契约 ＋ 逐字 ＋ 漂移 ＋ 外部事实） |
| §3 | `name` 与 `roleId` 保持一致；`description` 换短中文 | `config.id = godot-tech-director`；描述取 §2 的四项签注权 |
| §3 | 确认附件首尾行是否为 `\---` | 附件确实是 `\---`；本包不读 frontmatter，故无影响（见 NOTICE） |

**三处有意的偏离**（都记在这里，避免下次有人把它当漏做）：

1. **`order` 66 → 67**。交付包写作时同族最大是 65；2026-10-11 `godot-qa-expert` 已用 66。`gtd-check` 每次现场扫描同族
   `order` 值并断言 67 未冲突，所以这条不是一次性判断，而是可复查的断言。
2. **`description` 无权威原文**。交付包只说「换成短中文」，未给字面文本；这里取 §1 duties 的四项签注权写一行。
3. **`suffix` 写的是 4.7.2-stable**（不是同族旧包里的 4.6.3）：`D:\Godot\` 实列到 `Godot_v4.7.2-stable_win64.exe` 与
   `..._console.exe`，`project.yaml` 的 `engine.path` 也指向前者。仍保留「先列目录确认真实文件名、不要臆造版本号」的降险写法。

---

## 3. 组合行表（14 行）

| 行 | 插件 | 关键配置 |
|---|---|---|
| `persona` | `@deepseek-ai/dsh-persona` | §4 正文 ＋ 本机 Godot 事实 |
| `agent-instructions` | `@deepseek-ai/dsh-agent-instructions` | `maxBytes: 65536`——它写的是本项目文档，项目 `AGENTS.md` 该生效 |
| `time-context` | `@deepseek-ai/dsh-time-context` | 与当前 `standard` 基线对齐（同族 2026-10-01 的四个旧包没有这一行） |
| `tool-bash` / `tool-pwsh` | — | 平台二选一，`!!js` 判平台 |
| `tool-fs` / `tool-fs-search` | — | `sampleOverCapGlobResults: false`（**必填**，漏掉即整条 preset 变 broken） |
| `tool-jobs` | — | 长跑取证（探针、基准）走后台作业 |
| `compaction` | `cordis:group` | 3 成员（basic / compact 命令 / result-pruner）＋ 两个 isolate 标志 |
| `tool-ask-user` / `tool-todo` / `present` | — | 照基线；`allowParallelInProgress: true` |
| `tool-web` | `@deepseek-ai/dsh-tool-web` | `fetch: true` / `searchTimeoutMs: 60000`——风险点是「Godot 4.x 小版本间 API 变动」 |
| `requirement-board-role` | `cordis:group` ＋ `dsh-requirement-board/role` | **必须包在 `isolate: { requirementBoardRole: true }` 组内**；`roleId: godot-tech-director` |

**为什么这是唯一证据**：本机 `standard` / `godot-game-suite` 就是「有角色 id、缺职能」的下场——看板按职能路由时收不到活。
所以 `duties` 非空且与交付包 §1 逐字一致，是「这个角色能按职能接到活」的判据，也是 §6 要回写的证据之一。

---

## 4. 落地与取证（2026-10-11）

| 步骤 | 结果 |
|---|---|
| 生成 preset | `node tools/gen-preset.mjs --write` → 13,129 字符 / 269 行 / 21,166 B / LF / 无 BOM |
| 静态契约 | `node tools/gtd-check.mjs` → **通过 100 项 / 全部契约检查通过**（含与交付包 §1/§4 逐字断言与无漂移断言） |
| 装入 profile | `install_bundle` → `application: applied`、`pnpm exitCode 0`、`warnings: []` |
| 激活（进程内） | `list_plugins` → `include:preset-godot-tech-director`：`enabled: true` · `fiberPhase: active` · 无诊断 |
| 激活（启动期 A/B） | 干净 9,259 B / preset 命中 0；抽掉必填 Config 后 10,531 B / 点名 `agent preset godot-tech-director: tool-fs-search … invalid config`；已还原且字节一致 |
| 既有门禁 | 同族 `gsd-check` / `gse-check` / `gqe-check` 均 exit 0 |
| 角色可查 | ⏳ **待新建会话**：安装后 `requirement_role list` 尚无该 id（声明在 isolate 组内，只有活会话能读到）——见 INSTALL.md §5 |
| 会话自报 | ⏳ **待新建会话**并选中本预设（已有会话看不到新预设）——见 INSTALL.md §6 |

---

## 5. 维护要点（与同族自建包同一套教训）

- **抄来的行必须逐字段一致**。上游给某行新增**必填** Config 字段时，抄来的行会缺字段 → 该行激活失败 →
  **整条 preset 变 broken**，而 GUI 里只表现为「选择器里看不到它」。已发生的实例：`tool-fs-search` 的
  `sampleOverCapGlobResults`。改动后先跑 `tools/gtd-check.mjs`。
- **带 id 的补丁行是 config 整体替换、不深合并**；profile 用户层在 bundle 层之后应用。
  本包**刻意不在** `~/.dsh/profiles/web/cordis.patch.yml` 里重述整条 config（重述即漂移），角色声明随包走。
  代价见 INSTALL.md §5：**没有会话在线时**别的会话可能按职能挑不到它。
- **本文件不覆盖** `agent-preset-registry` 的 `default` / `selectedDefault`（用户层会赢，实测）。
- **persona 不手改**：改内容改交付包，再 `node tools/gen-preset.mjs --write`；`gtd-check` 会拦下手改。
- **与 `producer` 角色的耦合——已闭合（2026-10-11）**：交付包 §4 里「工期／范围 → 交**用户本人**」的**四处**
  （决策权限表的「工期承诺 / 人力 / 砍不砍功能」行 · 管辖之外的「工期与范围取舍」行 · 冲突裁决的「越界转交」条 ·
  《风险与工期影响分析》的「汇总结论」条）已随 `dsh-producer` 上线改成「**转 `producer`**，决定权仍在用户」。
  本节原先点名两处；另两处挂着同一句「本机无制作人」的旧理由，留着会自相矛盾，故一并改齐。
  persona 已同批重新生成（13,129 → 13,151 字符），`gtd-check` 的逐字与无漂移断言保证它与交付包一致。

---

## 6. 未做与已知缺口

- **没有 skills 包**：交付包 §7 已裁定不移植（网上那份 `technical-director` skill 的 ADR 格式与性能目标都更弱，
  移植即退步），并给了三个拆出 skill 的触发条件（基线表出现第三张 / persona 超过约 25 KB / 签注模板要能按名加载）。
  当前 persona 约 11 KB，三条都不满足。
- **不碰游戏仓库**：本包未向 `D:\Godot\projects\dndGame` 写入任何字节；只读它 `production/presets/` 下的交付包。
- **frontmatter 与上游脚本**：`displayName` / `profession` / `maxTurns` 本机不读，未收录；附件里也没有脚本与模板。
- **`\---` 的形态**：附件首尾行确为 `\---`；本包不使用 frontmatter，因此不构成阻塞，但也没有进一步追查来源。
