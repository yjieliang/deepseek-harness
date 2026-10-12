# dsh-producer —— 「磐石 · 制作人」预设

把《诡秘之主》项目的**制作人**做成一个可用的 DSH 专家会话：盯范围边界、排里程碑、按真实可用工时算账、维护风险登记表、清理跨角色阻塞、统一进度口径。
上游卡是「一人独立开发」语境下的 **TPM（技术项目管理）**角色卡；本包只做**形态转换**（角色卡 → agent preset），不改内容。

## 1. 结论

| 项 | 值 |
|---|---|
| 预设 id | **`producer`**（= 角色 id；CCGS 技能正文点名的就是这个原生 id） |
| 显示名 | **磐石 · 制作人** |
| `order` | **68** |
| 安装位置 | `C:\code\deepseek-harness\bundles\dsh-producer`（与 `dsh-godot-tech-director`、`dsh-godot-qa-expert` 同址） |
| 权威来源 | `D:\Godot\projects\dndGame\production\presets\producer-交付包.md`（§1 角色声明 · §3 persona 正文） |
| 不手抄 | persona 与角色声明由 `tools/gen-preset.mjs` 从交付包生成；`tools/prd-check.mjs` 反向断言「磁盘文件 == 生成器输出」 |

**它不管什么**（照交付包 §3 的注意事项）：**不做派发** —— 不建需求、不派活、不改路由（那归 `ccgs-studio`）；也不替用户拍范围与工期的板，只出建议与代价。

## 2. 与交付包的偏离（3 处，均为落地所需）

| # | 交付包说 | 本包做 | 为什么 |
|---|---|---|---|
| 1 | §2 建议 `order` **67** | **68** | 67 已被 2026-10-11 同日施工的 `godot-tech-director` 占用；`prd-check` 每次**现场扫描**同族 bundle 并断言 68 未被占用、且为当前最大值 |
| 2 | §1 的角色声明组 | 原样搬入 preset 的 `plugins` 末尾 | 声明**随自己 bundle 走**（交付包 §2 明确「不必改 web profile 用户层」），单点真相，不在 profile 层重述 |
| 3 | §3 正文只给「整段放进 `persona.prefix`」 | 另补 `suffix`（本机 Godot 事实 ＋「不要臆造版本号」） | `suffix` 不是角色内容，是本机事实；与同族包逐字一致，避免各包各写一份 |

## 3. 交付包 → 落点映射

| 交付包 | 落点 |
|---|---|
| §1 角色声明组（`isolate: { requirementBoardRole: true }`） | `presets/producer.patch.yml` 末尾 `requirement-board-role` 组，原样 |
| §3 persona 正文（整段） | `persona.config.prefix`（块标量 `\|`），逐字 |
| §2 行清单（persona / agent-instructions / tool-web / compaction 组 … 照 standard 基线逐字段一致） | preset 的 14 行插件行，顺序照交付包 §2 |
| §2 ⚠️ `tool-fs-search.sampleOverCapGlobResults` **必填** | 该行 `config.sampleOverCapGlobResults: false`（`prd-check` 断言它在） |
| §2 「`config.id` 必须 = roleId」 | `config.id: producer` ＋ 角色声明 `roleId: producer`（断言相等） |
| §4 变更清单 14 条 | **不落进本包** —— 那是「正文为什么长这样」的溯源，留在交付包 |
| §5 命名裁决（用本卡正文做 `producer`） | `config.id` 用原生 `producer`（而非 `tpm`） |

## 4. 落地与取证

| 步骤 | 结果 |
|---|---|
| 生成 preset | `node tools/gen-preset.mjs --write` → 10,147 字符 / 196 行 / 16,607 B / LF / 无 BOM |
| 静态契约 | `node tools/prd-check.mjs` → **通过 92 项 / 全部契约检查通过**；安装前同一脚本是 90 通过 + 2 失败（E 组接线两条） |
| 装入 profile | `install_bundle` → `application: applied`、`pnpm exitCode 0`、`warnings: []`；profile 新增 `"dsh-producer": "link:C:/code/deepseek-harness/bundles/dsh-producer"` |
| 激活（进程内） | `list_plugins` → `include:preset-producer`：`enabled: true` · `fiberPhase: active` · 无诊断（清单 207 条，本行为第 204 条） |
| 激活（启动期 A/B） | 干净 9,259 B / preset 命中 **0**；抽掉必填 Config 后 10,520 B / L250 点名 `agent preset producer: tool-fs-search … invalid config`；已还原且字节一致（16,607 B） |
| 既有门禁 | `gtd-check` / `gsd-check` / `gse-check` / `gqe-check` 均 exit 0 |
| 交叉联动 | 本包上线使技术总监交付包 §5 第 8 条的 ⚠️ 条件成立 ⇒ 已改那四处「交用户本人」为「转 `producer`」，TD preset 同批重生成（13,129 → 13,151 字符，`gtd-check` 仍 100 项全绿） |
| 角色可查 | ⏳ **待新建会话**：角色声明在 isolate 组内，只有活会话能读到（安装后 `requirement_role list` 不会有该 id，除非有会话或需求引用它） |
| 会话自报 | ⏳ **待新建会话**并选中本预设（已有会话看不到新预设） |

## 5. 维护要点（与同族自建包同一套教训）

- **改 persona 只改交付包**，然后 `node tools/gen-preset.mjs --write` ＋ `node tools/prd-check.mjs`；手改 preset 会被「无漂移」断言打回。
- **`tool-fs-search` 的 `sampleOverCapGlobResults` 不能删**：删了该行激活失败 → 整条预设 broken，而 GUI 里**只表现为「选择器看不到它」**（不报错）。
- **角色声明不能脱离 `isolate`**：直接 provide 会把服务发布到进程全局，注册表随即把整条预设判 broken。
- **`!!js` 不是 `!js`**：前者只允许出现在 `config` 与 `disabled`，后者不合法。
- **id 与 roleId 必须相等**：预设 id ≠ 角色 id 时，看板按角色路由接不到活。
- **`order` 要现场判定**：`prd-check` 扫 `C:\code\deepseek-harness\bundles` 与 `~\.dsh\bundles`，同族再装新预设时它会重判。
- **安装后必须新建会话**才看得到：已有会话保留启动时的预设名册。

## 6. 未做与缺口

- **未建 `production/风险登记表.md`** —— 那是该角色**上线后自己**的产出（交付包 §3 把它定为唯一新建文档），不属本次施工。
- **未改 `~\.dsh\profiles\web\cordis.patch.yml`** —— 声明随 bundle 走；profile 只由 `install_bundle` 新增一条 `link:` 依赖。
- **未移植上游 skills 包** —— 上游那份卡不带 skills/脚本/模板（交付包 §6），且同族「权衡」的联网核查结论是不移植（技术总监交付包 §7）。
- **未验证**：交付包 §6 列的「每周可用工时」等前置事实是**运行时**要问用户的东西，不是本包能填的。
