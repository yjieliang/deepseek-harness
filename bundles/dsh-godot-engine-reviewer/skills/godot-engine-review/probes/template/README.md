# 探针脚手架（probe template）

一次只验一条主张的最小取证工程。**复制到探针沙箱再改**，不要在被审工程内就地修改。

## 用法

1. 解析探针目录：`GODOT_PROBE_DIR` → 否则平台临时区 `godot-engine-probes/<日期>-<案例>/`。**若会话工作区就是被审工程，探针一律不得落在该工程内。**
2. 复制本目录（`project.godot` / `probe.gd` / 运行器）到探针目录。
3. 只改 `probe.gd` 的 `_case()`：一条主张 = 一个探针，打印输入条件、观测值、重复次数。
4. 跑：

```powershell
cmd /c run-probe.cmd                                   # Windows（推荐；绕开 .ps1 执行策略）
cmd /c run-probe.cmd -ProbeDir D:\probes\p1 -Engine D:\Godot\Godot_v4.7.2-stable_win64_console.exe
```

```sh
GODOT_BIN=/opt/godot/godot sh run-probe.sh              # Linux / macOS
```

5. 把 `PROBE/` 行与 `probe-output.txt` 路径填进 `templates/probe-card.md`。**引擎自己写的那份文件才是原始证据**；终端输出用于人工核对。

## 本脚手架实测过的本机陷阱（2026-10-09，Windows + Godot 4.7.2-stable）

| # | 陷阱 | 实测现象 | 脚手架怎么绕 |
|---|---|---|---|
| 1 | 用 PowerShell 重定向捕获原生进程输出 | `& $engine ... 2>&1` **完全无输出**；`*>` 落文件得 **0 字节**（沙箱吞管道） | 裸调用 + 引擎自写 `probe-output.txt`（`FileAccess`，UTF-8） |
| 2 | `Get-Content` 默认按 GBK 解码 UTF-8 | 读回的证据中文变乱码（`妯℃澘鏈浛鎹?`） | 探针输出**只用 ASCII**；要读文件必须 `Get-Content -Raw -Encoding utf8` |
| 3 | `cmd.exe` 按 OEM 代码页解析 `.cmd` | UTF-8 中文注释被当成命令执行：`'是' is not recognized...` | `run-probe.cmd` **纯 ASCII** |
| 4 | `powershell.exe` 按 ANSI 解析无 BOM 的 `.ps1` | 中文注释导致解析错误（`missing the terminator`） | `run-probe.ps1` **纯 ASCII** |
| 5 | 本机 PATH 上没有 `pwsh`；`.cmd` 回退到 Windows PowerShell 5.1 | 5.1 在 `param()` 默认值里取不到 `$PSScriptRoot` → `ProbeDir` 为空 → `Join-Path` 抛错 | 脚本体内解析 `$ProbeDir`，且不用 PS7 专有语法 |
| 6 | 沙箱下引擎写 `user://logs` 被拒 | 证据里插入 `Could not create directory: 'user://logs'` 等 ERROR | 运行器把 `APPDATA`（Windows）/ `XDG_DATA_HOME`（*nix）重定向到探针目录；副作用是**不污染开发者真实的 Godot 数据目录** |
| 7 | 根证书读取失败 | stderr 出现 `Failed to read the root certificate store` | **无法回避**，属本机环境噪音；判定时不得当成发现，也不要放进证据行 |

引擎查找顺序：`-Engine` → `GODOT_BIN` → 常见目录下最新的 `Godot_v*`（优先 console 变体）。找不到就响亮失败，**不猜版本、不下载、不换成别的引擎**。

## 铁律

- 探针**不做判定**：只给观测值。「成立 / 不成立」的推理写在裁决单里。
- 探针**一次只验一条**：混验多条时失败无法归因，相关条目只能记「证据不足」。
- 探针**不改被审工程**，也不把被审工程的私有依赖带进来。
- 跑不起来、引擎找不到、输出被截断 → 如实写「未验证」并说明卡在哪一步，不得推测结果。