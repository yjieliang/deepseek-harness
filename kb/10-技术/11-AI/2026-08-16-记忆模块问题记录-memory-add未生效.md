---
title: 记忆模块问题记录:/memory add 未生效(习惯库为空)
aliases: [memory 未生效, 记忆没生效, 用户习惯未写入, 中文回复习惯]
tags: [记忆, user-habits, 排查, 问题记录, DSH]
summary: 排查「默认用中文回复」记忆未生效问题:live habits 服务运行中但 entries 为空,/memory add 未真正写入习惯库;分析可能的根因(命令未注册/preset 装载)与证据。
created: 2026-08-16
updated: 2026-08-16
---

# 记忆模块问题记录:/memory add 未生效(习惯库为空)

> 记录时间:2026-08-16。本问题发生于 DSH Web GUI 会话中,供开发记忆模块(用户习惯记忆 `/memory` / `memory_add`)的会话读取。
> 本问题属「用户习惯记忆系统」落地中的实际故障;设计与调研参考 [[2026-08-15-用户习惯记忆系统设计方案]] 与 [[2026-08-15-agent记忆开源项目调研-用户记忆与外部Memory-Provider]]。

## 1. 现象

用户希望让 agent「默认用中文回复」,先后两种做法:

1. 在会话里直接说「以后回复都用中文」—— agent 只是在对话里口头应承,并未写入任何记忆。
2. 在会话里提交 `/memory add 默认用中文回复` —— 原以为会写入用户习惯库,但实际未生效。

随后 `/memory list` 显示 **没有已记录习惯**。

## 2. 权威结论(live 运行时确认)

用临时动态 Cordis 插件直接读取**当前运行中的** `habits` 服务(`ctx.habits.list()`):

```json
{
  "serviceMounted": true,
  "entries": []
}
```

- `habits` 服务确实挂载着(host 平面)。
- 但习惯库为空 —— **`/memory add 默认用中文回复` 并没有真正写入任何习惯条目**。

磁盘证据一致:`$DSH_HOME/settings.yaml`(即 `C:\Users\Administrator\.dsh\settings.yaml`)中没有 `user-habits` 命名空间。而 `habits-settings` 提供者(`@deepseek-ai/dsh-habits-settings`)的 `persistWrite` 会同步把每条写入到 `user-habits` 设置命名空间,并由 settings-file 提供者落盘到 `settings.yaml`。

## 3. 证据链

| # | 证据 | 位置 |
|---|---|---|
| 1 | `settings.yaml` 无 `user-habits` 段,即使等待写入稳定窗口后复查也仍无 | `$DSH_HOME/settings.yaml` |
| 2 | live `habits.list()` 返回空数组 | 临时探针插件读出 |
| 3 | 早期 `D:\AI\DeepSeek` 会话记录中,agent 明确说过「没有 `/memory` 命令,也没有记忆存储系统」;说明当时的 agent 上记忆功能整套未装载 | 会话日志 `.dsh/sessions/--D-AI-DeepSeek--/*.jsonl.zstd` |
| 4 | `/memory` 命令 `recordInput:false`,不写入会话记录,无法从 transcript 追溯其执行/报错日志 | `@deepseek-ai/dsh-command-memory` 源码 |
| 5 | 用户设置 `agent-presets.default: cordis`,而 `/memory` 与 `memory_add/memory_list/memory_remove` 由 `knowledge-base` preset 挂载 | `$DSH_HOME/settings.yaml` + `.agent-presets/knowledge-base/agent.cordis.yml` |

## 4. 根因分析(最可能)

**当前会话很可能不是跑在带记忆工具的 `knowledge-base` pre-set 上**,而是默认 `cordis` pre-set。因此:

- `/memory` 斜杠命令(`@deepseek-ai/dsh-command-memory`)没有被注册。
- 用户敲 `/memory add 默认用中文回复` 时,它没有触发命令分发,而只是被当成一条普通文本交给模型,agent 口头回应,从未走到习惯库写入路径。

`habits` 服务在 host 平面由 `cordis.patch.yml` 的 `habits-settings` 插入并存在(live 探针确认挂载),但**工具与命令在 agent preset 层才注册** —— 服务在、命令/工具不在,正是 key 所在。

## 5. 对开发记忆模块的启示 / 建议

1. **命令与工具的可发现性**:用户无法 / 不确定 `/memory` 是否存在。建议在有 `/memory`/`memory_add` 的 pre-set 里,给系统提示一份「记忆工具使用说明」,并让 agent 在用户表达「以后都……」「记住……」时主动调用 `memory_add` 而非口头应承。
2. **写入与提示闭环**:即便写入成功,当前会话若未装载 `habits-settings` 的 resident 提示段(「用户习惯」),agent 也不会真正「默认中文回复」。需保证「写入 → 注入系统提示 → 模型遵守」整条链路同属一个 pre-set。
3. **默认 pre-set 与记忆功能分离**:`agent-presets.default: cordis` 与 `knowledge-base`(带记忆)分离,易造成「用户以为开了记忆,实际没开」。可考虑把记忆工具/命令做成独立可组合的能力,或把默认 pre-set 切到带记忆的那个。
4. **`/memory` 命令不可追溯**:`recordInput:false` 虽避免污染 session,但也让「命令是否执行、是否报错」无从排查。建议增加一个记录点或返回可观测的上次写入结果。

## 6. 若要复现/验证

1. 确认当前 Web 会话使用的 pre-set(默认 `cordis` vs `knowledge-base`)。
2. 切到 `knowledge-base`(或含 `command-memory`+`tool-memory`)的会话,再提交 `/memory add 默认用中文回复`。
3. 用 `/memory list` 或临时探针读 `ctx.habits.list()` 验证是否写入;并复查 `settings.yaml` 是否出现 `user-habits`。

## 7. 处理结果(2026-08-16)

| 项 | 动作 | 状态 |
|---|---|---|
| 默认预设分离(根因) | `settings.yaml` 的 `agent-presets.default` 由 `cordis` 改为 `knowledge-base` | ✅ 已改,但实测发现 settings 用户层未被进程采纳 |
| 默认预设分离(根因·组合层修复) | 重启后新会话 header 仍为 `agentPreset: cordis`(无 selected 事件,非 GUI 显式选择),证明 settings 用户层未生效;改为在 `profiles/web/cordis.patch.yml` 覆盖 `agent-presets` 行 `config.default: knowledge-base`(组合层,启动必生效;dump-config 已验证) | ✅ 已修复 |
| 引导段缺失 | `@deepseek-ai/dsh-tool-memory` 引导段强化:用户表达「以后都…」「记住…」「我习惯…」时须调用 `memory_add`,不得口头应承;并说明同 topic 覆盖、删除先 list | ✅ 已改并重建 |
| 文档 pin 同步 | tool-memory README(中英)同步新引导文本 | ✅ 已改 |
| 待验证 | 重启后新会话(默认 knowledge-base)中 `/memory add` → `/memory list` 是否写入,`settings.yaml` 出现 `user-habits` 段 | ✅ 已实测闭环:记忆条目真实写入并回显,USER.md 注入生效,守卫二次确认弹窗按设计触发 |
| 遗留 | settings 用户层 default 未被采纳的具体环节(settings-file 加载/解析)待查 | ⏳ 暂缓(组合层修复已闭环,此调查非阻塞) |
| 已交付(后续) | L2 项目层(USER.md 注入链)、L3 半自动(memory_propose + 确认 + 去重)、守卫来源分层(agent 硬拒 / user 二次确认)、`/memory` 可观测性(recordInput 恢复默认) | ✅ 全部落地并实测 |
| 设置「记忆」页 | `@deepseek-ai/dsh-client-ui-memory`:列出/添加/编辑/删除全局习惯,`settings.replace` + `expectedRevision`,宿主 `validate` 兜底(预算硬拒、内容守卫一次拒绝后「仍然保存」落库 `guardConfirmed`) | ✅ 已交付(42 项测试、test:gui 全绿、4 个设置导航 golden 已刷新) |

修复后预期链路:重启 → 新会话(组合层默认 knowledge-base)→ 说「以后都用中文」→ agent 调 `memory_add` 写入 → `user-habits` 常驻段进入后续 system prompt → 跨会话中文回复。**该链路已实测成立(2026-08-16)。**

## 8. 重启失败:启动校验拒绝存量条目(2026-08-16)

**现象**:加上设置命名空间 `validate` 后重启 `pnpm dsh web`,启动即崩:`habit value matches a secret or credential pattern`,栈指向 `HabitsSettingsStore` 构造 → `settings.register` 的初始 resolve → `validate`。

**根因**:`settings` 域在注册时的初始 resolve(加载路径)与写入路径共用同一个 `validate` 回调;此前测试留下的密钥模式条目(经「仍然记住」确认写入)没有 `guardConfirmed` 字段(该字段是新加的),启动加载即被内容守卫拒绝,整个插件(乃至 DSH)加载失败。

**修复**:
1. `dsh-settings` 给 `validate` 回调增加 `phase` 参数(`'load'` = 注册初始 resolve 与 provider publish;`'write'` = update/replace/mutate),这是 owner 校验在两条路径上语义不同的真实区分。
2. `habits-settings` 的 `validate`:主题格式与预算两相硬拒;内容守卫只在 `'write'` 相执行。
3. 启动迁移:构造时(及 `settings/document-updated` 后)把「无 `guardConfirmed` 且内容违规」的存量条目一次性打上 `guardConfirmed: true` 写回——旧版本中违规内容进入用户层的唯一路径就是人类确认覆盖,所以该迁移是保真而非放宽。
4. `scripts/gen-cordis-catalog.ts` 补 `ctx.habits` 服务与 `user-habits/*` 事件作用域的 catalog 页映射(新页 `docs/subsystems/user-habits.md`)+ Habit 类型链接豁免。

**验证**:settings 域 phase 传递用例、habits 加载宽容/写入严格/启动迁移用例、type-equiv(含 `SettingsValidatePhase` 粘贴块)、gen-cordis-api 新鲜度、test:gui 281 文件全绿。重启后存量条目自动迁移,无需手工改 `settings.yaml`。
