# 安装与验证（INSTALL）

## 0. 前置条件

- dsh profile：`web` 或 `desktop`（preset 注册表由 web-app 层插入，headless 组合没有它）。
- 同 profile 内已装 `dsh-requirement-board`：本包的预设带一条角色声明行（`dsh-requirement-board/role`）。
  没有它时该行解析失败，**整条 preset 会变 broken**；若不需要按角色派发，请把 `requirement-board-role`
  那一组从 preset patch 里删掉再装。
- 本机 Godot 引擎（探针用）：`GODOT_BIN` 或常见目录下的 `Godot_v*`。本机实测路径
  `D:\godot\Godot_v4.7.2-stable_win64_console.exe`。

## 1. 安装

用 `plugin_manager` 的 `install_bundle`，`target` 传本包**绝对目录**：

```text
plugin_manager { action: "install_bundle", target: "C:/code/deepseek-harness/bundles/dsh-godot-engine-reviewer" }
```

它会自己写 profile 的依赖与 `dsh.profile.bundles`，**不要**用 shell 手改 profile。
安装会执行包代码，需要 Full access 或一次批准。

## 2. 静态自检（安装前先跑）

```powershell
node tools/ger-check.mjs
```

非 0 退出＝有断言不成立。它检查：package.json 无依赖、`files` 齐全、patch 能在 Loader YAML 方言下解析
（含 `!!js`）、preset id 与顺序、必填字段 `sampleOverCapGlobResults`、skills 目录按已安装包解析、
SKILL.md 引用的每个文件真实存在、技能文档读取预算、角色声明的形状与职能条数、以及编码/占位符残留。

## 3. 安装后必验四条

1. **preset 激活**：`plugin_manager { action: "list_plugins" }` → 存在 `preset-godot-engine-reviewer` 且
   `broken` 为 `null`。broken 会带诊断信息，先读诊断再动别的。
2. **角色声明生效**：`requirement_role { action: "list" }` → `godot-engine-reviewer` 带四条职能
   （不是「未记录职能」）。若显示缺职能而 preset 本身不 broken，见 §4 的退路。
3. **技能可见**：新会话选一次该 preset，`skill` 能加载 `godot-engine-review`。
4. **探针可跑**：在探针沙箱里

   ```powershell
   cmd /c run-probe.cmd
   ```

   看到 `PROBE/engine_version=…` 与原样退出码 0，并生成 `probe-output.txt`。

**新会话才生效**：已存在的会话与它们的子会话保留启动时的插件版本；改完 preset 必须在**新会话**里验。

## 4. 角色声明只有兜底时的退路

本包的声明写在 preset 自己的 `config.plugins` 里（`isolate: { requirementBoardRole: true }` 组内），
以便声明随包走、单点真相。若实测显示 bundle 层声明不生效，按 ROLE-DISPATCH §2.3 在
`~/.dsh/profiles/web/cordis.patch.yml` 里**整条重述**该 preset 的 config 并带上角色组——
id 定向补丁是 `config` 整体替换、不深合并；同时按 ROLE-DISPATCH §13.2 先备份
`cordis.patch.yml.bak-<日期>`。改完重新起实例并在新会话复验 §3 第 1、2 条。

## 5. 升级 dsh 后要复查的三处

工具名与插件名会随平台版本变动，改名会让**整条 preset 变 broken**（不是在挂载时报错，而是激活时）：

1. `tool-fs-search` 的必填字段 `sampleOverCapGlobResults`（漏掉即 broken，2026-09-30 同族预设实测）。
2. `skill-filesystem` 的 `customSkillDirs` 用 `!!js` + `createRequire(baseUrl).resolve('dsh-godot-engine-reviewer/package.json')`
   解析——包被改名/改目录时这里最先响。
3. 角色行 `dsh-requirement-board/role` 的 `roleId` / `duties` 约束（`^[a-z][a-z0-9_-]{0,31}$`、不得是 `human`、不得以 `tmp-` 开头、职能 ≤12 项且每项 ≤40 字）。

## 6. 卸载与回滚

```text
plugin_manager { action: "remove_bundle", target: "dsh-godot-engine-reviewer" }
```

随后 `list_plugins` 确认 `preset-godot-engine-reviewer` 已消失、其余 preset 仍 `broken: null`。
若曾按 §4 改过 profile 的 `cordis.patch.yml`，把备份还原并重启实例。

探针产物都在探针沙箱（`GODOT_PROBE_DIR` 或平台临时区），卸载本包不影响它们；被审工程从未被写入。