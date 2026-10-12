# dsh-ux-designer · 交互设计师预设

把交付包 `production/presets/ux-designer-交付包.md` 落成一个可用的 dsh agent preset：
**沈简 · 交互设计师**（preset id `ux-designer`，`order` 70）。

立项理由（交付包 §0 判读）：五份上游角色卡里**最贴合本项目**的一份——它就是 **PC/Windows 桌面交互设计**，
而本项目正是**单机 PC/Windows ＋ 键鼠**。它带来的 A–F 评审标准全是可直接跑的门槛
（主线 ≤3 步 · 导航 ≤3 层 · 焦点可见 · 点击目标 ≥32×32 px · **100 ms** 内反馈 · >1 s 可取消 · 正文对比度 **≥4.5:1** · 125%/150% DPI 不溢出）。
更要紧的是它补了两处**评审点名的缺口**：**「新手前 5 分钟自解释」无人承接**，以及 S1 的 `## UI Requirements` 里写着
「**`ux-designer` 方向未咨询 —— Lean 模式，接口清单是助手自查替代**」——本预设到位后可**回补真咨询**。

> 本包只做 **DSH 侧配置**（preset ＋ 角色声明 ＋ 自检），**不碰游戏仓库代码**，也**不改其它预设的行为**。

---

## 1. 结论先行

| 项 | 决定 |
|---|---|
| 形态 | **单专家预设**（一个 persona ＋ 一套工具面 ＋ 一个角色声明），无 skills 包（理由见 §6） |
| persona | 交付包 **§3 正文逐字**（5,934 字符 / 109 行），不手抄：由 `tools/gen-preset.mjs` 从交付包生成 |
| 角色声明 | 交付包 **§1 isolate 组逐字**：`roleId: ux-designer` · 8 条 `duties`；**随包走**，不在 profile 层重述 |
| 组合基线 | 照发行版 `standard` preset 的对应行**逐字段一致**；裁掉 delegation / planning / goal / skill / schedule / plugin-manager |
| `order` | **70**（不是交付包建议的 69——69 已被 `art-director` 占用，68 已被 `producer`、67 已被 `godot-tech-director`，见 §2） |
| 安装位置 | `C:\code\deepseek-harness\bundles\dsh-ux-designer`（与 `dsh-godot-tech-director`、`dsh-godot-qa-expert`、`dsh-godot-engine-reviewer` 同址） |

---

## 2. 交付包 → 落点的逐项对应

| 交付包 | 要求 | 落点 |
|---|---|---|
| §1 | 角色声明组（`roleId` / `roleName` / 8 duties），**不可省** `isolate: { requirementBoardRole: true }` | `presets/ux-designer.patch.yml` 的 `requirement-board-role` 组，逐字生成 |
| §1 | `roleId` 用 `ux-designer`（**不用**卡里的 `pc-interaction-designer`） | 同上；理由见 §6（GDD 已用此 id 登记） |
| §2 | 预设骨架：`order`、各行照 standard 基线、⚠️ `tool-fs-search.sampleOverCapGlobResults` **必填** | 同文件 14 行行集；`tools/uxcheck.mjs` 对必填 Config 逐条断言 |
| §2 | `persona.suffix` 放本机事实（Godot 可执行文件位置 ＋ 「不要臆造版本号」） | `suffix`：`D:\Godot\` 下 4.7.2-stable 的两个 exe ＋「调用前先列目录确认」 |
| §2 | `config.description` 一句话短中文（取自 duties） | 8 项职责串成一行（交付包只给示例句式，字面文本由本包定，见偏离 2） |
| §3 | persona 正文整段进 `prefix` | 逐字；`uxcheck` 断言 `prefix === §3 正文` |
| §5 | 4.5:1 对比度 vs「极暗夜戏」的冲突口径 | **不另写**：交付包 §5 的过渡期规则已逐字写进 §3 正文的 F 组（「你照常提出 4.5:1 的意见、并写明不修的后果，但不得据此推翻已定的美术口径；冲突一律登记为待裁项」）⇒ 照抄，未自行改判 |
| §2 / §6 | 装完照同类自建包写并跑一遍 `tools/*-check.mjs` | `tools/uxcheck.mjs`（契约 ＋ 逐字 ＋ 漂移 ＋ 外部事实） |

**三处有意的偏离**（都记在这里，避免下次有人把它当漏做）：

1. **`order` 69 → 70**。交付包写作时同族最大是 65，它自己建议 69；但 2026-10-11 同日施工的
   `godot-tech-director` 已用 67（交付包写作时它按「66 技术总监 · 67 制作人 · 68 美术总监」估的号已经整体后移），
   `producer` 用 68、`art-director` 用 69。`uxcheck` 每次**现场扫描**同族 `order` 值并断言 70 未冲突，
   所以这条不是一次性判断，而是可复查的断言。
2. **`description` 无权威原文**。交付包只说「一句话短中文，如「…」」，未给必须逐字的字面文本；
   本包取 §1 duties 的 8 项职责写成一行（与 `gen-preset.mjs` 的 `TEMPLATE` 一致）。
3. **`suffix` 的引擎路径沿用同族写法**（`D:\Godot\` 下 4.7.2-stable 的两个 exe）。交付包 §3 正文里
   锚定的是「Godot **4.7.2-stable**」；本包不重复 §3 已有的同类句，只补本机**可执行文件**事实
   ＋「调用前先列目录确认真实文件名、不要臆造版本号」。

---

## 3. 组合行表（14 行）

| 行 | 插件 | 关键配置 |
|---|---|---|
| `persona` | `@deepseek-ai/dsh-persona` | §3 正文 ＋ 本机 Godot 事实 |
| `agent-instructions` | `@deepseek-ai/dsh-agent-instructions` | `maxBytes: 65536`——它要守项目字体 / 文案 / 红线约定，项目 `AGENTS.md` 该生效 |
| `time-context` | `@deepseek-ai/dsh-time-context` | 与当前 `standard` 基线对齐 |
| `tool-bash` / `tool-pwsh` | — | 平台二选一，`!!js` 判平台 |
| `tool-fs` / `tool-fs-search` | — | `sampleOverCapGlobResults: false`（**必填**，漏掉即整条 preset 变 broken） |
| `tool-jobs` | — | 长跑核对（逐屏走查、多文档归档）走后台作业 |
| `compaction` | `cordis:group` | 3 成员（basic / compact 命令 / result-pruner）＋ 两个 isolate 标志 |
| `tool-ask-user` / `tool-todo` / `present` | — | 照基线；`allowParallelInProgress: true`。`tool-ask-user` 对这份 persona 是**承重**的：它写死「信息不足时先提问，一次问全，不挤牙膏」 |
| `tool-web` | `@deepseek-ai/dsh-tool-web` | `fetch: true` / `searchTimeoutMs: 60000`——风险点是「无障碍规范与 Windows 惯例需查证」 |
| `requirement-board-role` | `cordis:group` ＋ `dsh-requirement-board/role` | **必须包在 `isolate: { requirementBoardRole: true }` 组内**；`roleId: ux-designer` |

**为什么这是唯一证据**：本机 `standard` / `godot-game-suite` 就是「有角色 id、缺职能」的下场——看板按职能路由时收不到活。
所以 `duties` 非空且与交付包 §1 逐字一致，是「这个角色能按职能接到活」的判据，也是交付包 §6 施工回执要回写的证据之一。

---

## 4. 落地与取证（2026-10-11）

| 步骤 | 结果 |
|---|---|
| 生成 preset | `node tools/gen-preset.mjs --write` → 10,564 字符 / 198 行 / 18,478 B / LF / 无 BOM |
| 静态契约 | `node tools/uxcheck.mjs` → **通过 116 项 / FAIL 0 项（exit 0）**。安装前那 2 项「web profile 已接线」为**预期红**（见 INSTALL §3）；装入 profile 后转绿 |
| 装入 profile | ✅ 已接线：`~/.dsh/profiles/web/package.json` 有 `"dsh-ux-designer": "link:…/bundles/dsh-ux-designer"`，且 `dsh.profile.bundles` 末项为本包（**静态读数**，`uxcheck` 断言） |
| 激活（进程内） | ✅ `list_plugins` → `include:preset-ux-designer`：`enabled: true` · `fiberPhase: active` · 无诊断（清单共 209 条） |
| 激活（启动期 A/B） | ✅ 干净启动日志 9,259 B / preset 命中 **0**；抽掉必填 Config 后 10,523 B / 点名 `agent preset ux-designer: tool-fs-search … invalid config`；已还原且字节一致（18,478 B） |
| 既有门禁 | ✅ `gtd-check` / `prd-check` / `gsd-check` / `gse-check` / `gqe-check` 全绿（exit 0） |
| 角色可查 | ⏳ **待新建会话**：安装后 `requirement_role list` 仍**不会**出现 `ux-designer` —— 声明在 isolate 组内，只有活会话能读到（该工具只列「有记录」或「被会话/需求引用」的角色） |
| 会话自报 | ⏳ **待新建会话**并选中本预设（已有会话看不到新预设） |

---

## 5. 维护要点（与同族自建包同一套教训）

- **抄来的行必须逐字段一致**。上游给某行新增**必填** Config 字段时，抄来的行会缺字段 → 该行激活失败 →
  **整条 preset 变 broken**，而 GUI 里只表现为「选择器里看不到它」。已发生的实例：`tool-fs-search` 的
  `sampleOverCapGlobResults`。改动后先跑 `tools/uxcheck.mjs`。
- **带 id 的补丁行是 config 整体替换、不深合并**；profile 用户层在 bundle 层之后应用。
  本包**刻意不在** `~/.dsh/profiles/web/cordis.patch.yml` 里重述整条 config（重述即漂移），角色声明随包走。
  代价见 INSTALL.md §5：**没有会话在线时**别的会话可能按职能挑不到它。
- **本文件不覆盖** `agent-preset-registry` 的 `default` / `selectedDefault`（用户层会赢，实测）。
- **persona 不手改**：改内容改交付包，再 `node tools/gen-preset.mjs --write`；`uxcheck` 会拦下手改。
- **与 `art-director` 的耦合（交付包 §5 自己点名的「唯一会真打架的地方」）**：对比度 4.5:1 vs「极暗夜戏」。
  用户已裁决 **2026-10-11「先放着，等 Art Bible 开工时再裁」**，该题已追加到 Art Bible 需求
  （`req_cc85142d94`）描述末尾。persona 里写着过渡期规则，**本包不自行改判**；
  Art Bible 定案后应回到交付包 §5 与 persona F 组同步修订。

---

## 6. 未做与已知缺口

- **没有 skills 包**：交付包 §6 记录「上游是否带 skills 包/脚本 —— 附件里**没有**（同族五份都没有）」。
  本包同样不发明 skills；若将来 persona 超过约 25 KB 或评审模板要能按名加载，再拆。
- **不碰游戏仓库**：本包未向 `D:\Godot\projects\dndGame` 写入任何字节；只读它 `production/presets/` 下的交付包，
  并在其 §6 追加了一节施工回执（这一处写入是本次任务的交付物之一）。
- **`roleId` 取名理由**（交付包 §1 的两条硬证据）：① 项目自己的 GDD `design/gdd/iso-grid-and-pathfinding.md`
  （本文件 §1 立项理由里引用的那份）
  的 `## UI Requirements` 已用 **`ux-designer`** 指代这个角色（「未咨询的代理：`ux-designer` 方向 未咨询—— Lean 模式」），
  换 id 会让那条登记永远对不上号；② 分而治之总控 §2.4 的规矩（用 CCGS 原生名）。
- **未核实项**（交付包 §6 已点名，本包不替它下结论）：CCGS 的 `team-ui` / `ux-design` / `ux-review` 技能正文里
  是否**逐字**点名 `ux-designer` —— 交付包未核实，本包也没核实；**但 §1 的 id 决定不依赖它**。
- **窗口/缩放策略未知**：交付包 §6 记录未读 `project.godot` 的 `display/window` 段 ⇒ A–F 里的
  **DPI 125%/150%** 那条**怎么落地未定**。这是 persona 自己的规矩（环境信息缺失**先问不脑补**），不是本包的缺口。
- **frontmatter 与上游脚本**：`displayName` / `profession` / `maxTurns: 50` 本机不读，未收录。
