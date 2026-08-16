# Agent Note: Settings surface for the harness home (DSH_HOME)

Status: implemented

[English](2026-08-16-settings-dsh-home.md) | 中文

## Problem

harness home(`~/.dsh`,或 `$DSH_HOME`)决定所有用户数据的位置,但改它只能编辑操作系统环境变量——一个按平台、按 shell 的手工活,没有任何设置界面,也无法在 harness 内部持久化。

## Decision

home 覆盖现在是一个持久化文件,而不是只靠环境变量:

- `@deepseek-ai/dsh-home-paths` 拥有一个 boot 覆盖文件(`~/.dsh-boot`,位于操作系统 home 下,因此天然不受 home 迁移影响):`readBootHome`/`writeBootHome` 读写一行绝对路径。`resolveDshHome` 优先级变为:显式配置路径、`$DSH_HOME`、boot 文件、`~/.dsh`(空白 env 或空白文件永不解析到 cwd)。
- host 域新增 `host.setDshHome({ path | null })`:写入或清除该文件,并回答下次启动会解析到哪;`host.describe` 上报解析后的 home 与其来源(`default`/`env`/`boot-file`)。当设置了 `DSH_HOME` 环境变量时,写入按无意义拒绝,响应说 `env`——变量仍然优先。
- 通用设置页新增仅限回环的 boot-home 行:解析后的 home 与来源、路径编辑器、保存与恢复默认,以及明确提示:改动只在重启后生效,已有数据不会自动迁移。

## Alternatives considered

### 为什么不写操作系统用户环境变量?

Windows 可行(HKCU\Environment),但 POSIX 需要按 shell 编辑 profile,而且每个启动器都只有在新登录后才能看到。harness 自有文件跨平台一致,且运行中的进程自己就能读取。

### 为什么不做只读展示加操作说明?

用户要的是配置,不是文档;只读行会把编辑推回 shell 提示符,还没有任何反馈。

### 为什么不做数据自动迁移到新 home?

跨任意 home 布局的迁移是一个独立且有风险的功能;行内明确说明数据留在原处,移动仍是操作者的显式步骤。

## Consequences

- home 覆盖持久化、可检查、跨平台,并且可在应用内编辑。
- 环境变量仍然压过文件——文档写明,存在时也向用户报告。
- 运行中的进程保持当前 home;只有下次启动解析新根,数据不会自行移动。
- UI 中写入仅限回环(与打开文档动作一致),`/api` 信任围栏与其他特权 host 调用一样保护该端点。

## Testing

`home-paths` 规格覆盖 boot 文件读写/清除与四路优先级;`rpc-schemas` 与 carrier/client 规格覆盖新的 host 域载荷;boot-home 行控制器规格覆盖 load/save/clear 与 env-wins 报告;apply 规格钉住仅限回环的注册。
