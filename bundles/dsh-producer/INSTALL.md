# 安装与验证（dsh-producer）

本包只做一件事：往 `web` profile 里加一条 agent preset 行（`preset-producer`）。它**不改**任何既有预设、**不改** profile 用户层、**不碰**游戏仓库代码。

## 1. 前置

| 项 | 要求 |
|---|---|
| profile | `web`（预设名册只在 web / desktop 组合里存在；headless 没有名册） |
| 依赖 | 无。本包零依赖，生成器借 dsh checkout 的 `js-yaml`（`DSH_CHECKOUT` 可覆盖，默认 `C:/code/deepseek-harness`） |
| 交付包 | `D:\Godot\projects\dndGame\production\presets\producer-交付包.md`（`PRD_AUTHORITY` 可覆盖） |

## 2. 安装

```
plugin_manager action=install_bundle target=C:\code\deepseek-harness\bundles\dsh-producer
```

预期：`stage: enable` · `changed: true` · `application: applied` · `packageResult.exitCode 0` · `warnings: []`。

## 3. 校验

```powershell
cd C:\code\deepseek-harness\bundles\dsh-producer
node tools/gen-preset.mjs --write     # 重新生成（应与磁盘一致）
node tools/prd-check.mjs              # 契约检查；有 FAIL 时 exit 1
```

`prd-check` 五组断言：**A** 文件与包契约 · **B** preset 结构（行集/顺序/`order` 现场扫描/必填 Config/isolate/`!!js`）· **C** 权威逐字（persona 与 §1/§3、无漂移、承重标记）· **D** 文本卫生（BOM/CR/尾换行/U+FFFD/占位符/MIT 原文）· **E** profile 接线。

> 安装前 **E 组两条必然 FAIL**（依赖与 `dsh.profile.bundles` 都还没有 `dsh-producer`）——这是预期状态，装完再跑应当全绿。

## 4. 激活期日志 A/B（怎么拿到「它真的被装上了」的机器证据）

`dsh web` **只在失败时**写启动日志（`%USERPROFILE%\.dsh\logs\startup-*.log`）。所以用「撞已占用端口」逼一次失败，读它写了什么：

```powershell
# B：干净态 —— 预期日志里 preset 命中 0 行
pnpm dsh web --port 3080 --no-open

# A：故障对照 —— 临时删掉 tool-fs-search 的 sampleOverCapGlobResults，再跑一次
#    预期日志点名：agent preset producer: tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config
#    对照完立刻还原：node tools/gen-preset.mjs --write
```

**为什么这算证据**：A 轮证明这条失败路径**会**点名本预设，所以 B 轮的「0 命中」不是空洞的。

## 5. 角色声明预期

- 声明随本 bundle 走，**不在** `~\.dsh\profiles\web\cordis.patch.yml` 里重述。
- 因此安装后 `requirement_role list` **不会**出现 `producer`：看板的角色目录只列「有记录」或「被活会话/需求引用」的 id（`dsh-requirement-board/host/roles.js` 的 `list()`）。
- 新建一个选中本预设的会话后，它会以 `producer` / 「磐石 · 制作人」出现在 `unregistered` 段（`holders.online ≥ 1`、`dutiesMissing: false`），此时 duties 才可读——**这是「角色能按职能接到活」的唯一证据**。
- 若要让它**落库**（`source: manual` 记录、面板可见），在面板角色管理里对 `producer` 一键登记；`manual` 优先级高于预设声明，两条路等价。

## 6. GUI 冒烟（判据）

1. 打开 `http://127.0.0.1:3080`，**新建会话**（已有会话看不到新预设）。
2. 预设选择器里应能看到「**磐石 · 制作人**」。
3. 让它自报身份：确认**角色 id `producer` 与显示名「磐石 · 制作人」**正确，再 `requirement_role list` 复核。
4. 顺带确认它把「不做派发」当边界（问它要不要替你建需求，答"不建，归 `ccgs-studio`"）。

## 7. 升级与回退

| 动作 | 做法 |
|---|---|
| 改 persona / 角色声明 | 改**交付包** → `node tools/gen-preset.mjs --write` → `node tools/prd-check.mjs` → **新建会话**验证（已有会话保持启动时的修订） |
| 改行集 | 改 `tools/gen-preset.mjs` 的 `TEMPLATE` → 重新生成 → `prd-check` 的 `EXPECTED_ROWS` 同批更新 |
| 临时停用 | `plugin_manager action=set_plugin target=preset-producer enabled=false` |
| 卸载 | `plugin_manager action=remove_bundle target=dsh-producer` |
| 装不回去 | 本包只新增一个 preset 行，不动任何既有 preset；`list_bundles` 确认列表里没有残留即可 |

## 8. 已知限制

- 预设只在 **web / desktop** 可用；headless 没有预设名册，也不能用来做 §6 的会话冒烟。
- **路径级写权限不是机制约束**：`toolFilter` 只能整工具开关。「维护本项目文档、不碰代码」是提示词纪律，不是沙箱边界。
- **与 `godot-tech-director` 的文档耦合**：技术总监交付包 §5 第 8 条与其 ⚠️ 注要求——**建了 `producer` 之后**，TD persona 里两处「工期／范围 → 交用户本人」应改为「转 `producer`，决定权仍在用户」。本包上线即意味着该条件成立（见 README §6 与 TD 交付包 §6 施工回执）。
- `order` 68 的合法性由 `prd-check` **现场扫描**得出，不是写死的判断。

## 9. 安装记录

| 日期 | 操作 | 版本 | 结果 |
|---|---|---|---|
| 2026-10-11 | 建包（工作区 `bundles/dsh-producer`） | 0.1.0 | `gen-preset --write` 生成 10,147 字符 / 196 行 / 16,607 B preset |
| 2026-10-11 | 静态契约（安装前） | 0.1.0 | 90 通过 + 2 失败，两条失败正是 §3 预告的 E 组接线（依赖与 `dsh.profile.bundles` 尚未含 `dsh-producer`） |
| 2026-10-11 | `install_bundle` 装入 `web` profile | 0.1.0 | `application: applied`、`pnpm exitCode 0`、`warnings: []`；profile 新增 `link:` 依赖 |
| 2026-10-11 | 静态契约（安装后） | 0.1.0 | `prd-check` **通过 92 项 / 全部契约检查通过**（exit 0） |
| 2026-10-11 | 进程内名册 | 0.1.0 | `list_plugins`：`include:preset-producer` `enabled: true` · `fiberPhase: active` · 无诊断（清单共 207 条，本行第 204 条） |
| 2026-10-11 | 激活期 A/B（§4） | 0.1.0 | 干净 9,259 B / preset 命中 **0**；抽掉必填 Config 后 10,520 B / **2 行**，L250 点名 `agent preset producer: tool-fs-search … invalid config`；已还原且字节一致 |
| 2026-10-11 | 既有门禁回归 | 0.1.0 | `gtd-check` / `gsd-check` / `gse-check` / `gqe-check` 均 exit 0 |
| 2026-10-11 | 会话冒烟（§6） | 0.1.0 | 待用户新建会话：验收 2/3 尚未取证 |
