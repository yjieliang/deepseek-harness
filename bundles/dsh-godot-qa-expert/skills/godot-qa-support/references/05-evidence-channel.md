# 探针证据通道

> **何时读**：要取证、要跑探针、要读 `probe/out/*.log`、要判断一条断言能不能算「有证据」时。
> **口径来源**：本项目 `probe/` 目录实测（2026-10-09 本机 Windows + Godot 4.7.2-stable）、`production/开发计划-分阶段-v1.md` 的 M0-S1 §8 与 M0b §2、`dsh-godot-engine-reviewer` 的 `references/evidence-protocol.md` 四级制。
> **不覆盖**：引擎侧行为的裁定（归引擎审查专家），也不覆盖探针的判据内容（那由各探针计划写死后不得修改）。

## 一、证据分级

| 级 | 内容 | 用法 |
|---|---|---|
| A | `probe/out/*.log` 原始日志、`production/reports/*.json`、截图、headless 退出码 | 唯一能支撑「成立」的证据 |
| B | `project.yaml`、`control-manifest.md`、`docs/architecture/adr-*.md`、阶段计划与探针计划文档 | 支撑「按设计如此」的判断 |
| C | 外部资料（Godot 官方文档须标访问日期与小节） | 支撑机制解释，不支撑本项目结论 |
| D | 推测 | 必须附证伪方法，且在报告里单独列 |

## 二、探针通道（逐字命令）

```powershell
D:/Godot/Godot_v4.7.2-stable_win64_console.exe --headless --path probe `
  --script res://<name>.gd --log-file D:/Godot/projects/dndGame/probe/out/<name>.log
```

- `probe/` 是自带 `project.godot` 与 `.gdignore` 的独立证据工程；脚本为 `p0_env.gd` … `p5_replan.gd`。
- 既有日志：`probe/out/p0.log`、`p1_cell_shape.log`、`p2.log`、`p3.log`、`p4.log`、`p5_replan.log`。
- 读取用 `Get-Content -Raw -Encoding utf8`。

## 三、本机实测陷阱（每条都踩过）

| 陷阱 | 表现 | 正确做法 |
|---|---|---|
| 用 GUI 版 exe | stdout 不落调用方，看起来什么都没输出 | 用 `..._win64_console.exe`，并始终加 `--log-file` |
| 把 Godot 进程接进 PowerShell 管道 | 沙箱下拿不到输出，或得到 0 字节文件 | 绝不管道；让 Godot 自己写日志文件，再读文件 |
| `Get-Content` 默认编码 | UTF-8 被按 GBK 解码，中文与符号变乱码 | 一律 `-Encoding utf8` |
| `.cmd` 与 `.ps1` 包装脚本 | `.cmd` 按 OEM 代码页解析、`.ps1` 按 ANSI，中文注释会破坏脚本 | 包装脚本保持纯 ASCII |
| `user://` 写入 | `APPDATA` / `XDG_DATA_HOME` 无权限导致日志写入被拒 | 把这两个环境变量重定向到探针目录 |
| 根证书报错 | `ERROR: Failed to read the root certificate store.` | 已知环境噪音，不得当成发现写进报告 |
| PowerShell 数行数 | 与 `read` 工具看到的行数不一致 | 观察值以 `read` 工具为准 |

## 四、退出码判据（本项目未规定）

现状：`p0`–`p4` 脚本以裸 `quit()` 结束，**退出码判据在项目文档里没有定义**；只有 `p5_replan.gd` 打印 PASS/FAIL。因此今天没有任何一条命令能给出「通过/失败」的机器可判信号，冒烟与门禁都无法把探针挂上去。

补法（新增统一入口，**不改既有 `p0`–`p5` 与既有日志**）：

| 约定 | 值 |
|---|---|
| 通过 | 退出码 `0` |
| 失败 | 非 `0` |
| 失败即短路 | 首个失败项立即结束并保留现场证据 |
| 总超时 | 有超时保护，超时即判失败并说明卡在哪一步 |
| 与判定一致 | 脚本打印的 PASS/FAIL 必须与退出码一致，不一致时以退出码为准并报告矛盾 |

「一条命令 + 明确退出码」是启动冒烟进闸的前置条件；在它补齐之前，启动冒烟只能记 `NOT ASSESSED` 并说明原因。

## 五、产物落点

| 内容 | 位置 |
|---|---|
| 探针原始日志 | `probe/out/<name>.log`（只增不改） |
| 量化报告 | `production/reports/*.json` |
| 冒烟报告 | `production/qa/smoke-[date].md` |
| 证据索引 | `production/qa/evidence/`；逐项证据写 `production/qa/evidence/[项-slug]-evidence.md` |

报告里引用证据一律给**路径 + 关键片段**，不给「我跑过了」这类无法复核的结论。
