# @deepseek-ai/dsh-user-habits

[English](README.md) | 中文

DeepSeek Harness 的用户习惯记忆 seam。本包是 **Service Definition**：抽象 `HabitService` 契约、写入安全守卫、确定性主题合并、品牌化 `HabitId`、类型化 `HabitError`、`user-habits/committed` 事件，以及规范化的常驻段渲染器。提供方实现三个存储钩子；工具、命令与提示段只依赖契约。

设计记录：`kb/30-工作文档/2026-08-15-用户习惯记忆系统设计方案.md`（用户习惯记忆系统设计）。

## 契约

`HabitService`（`ctx.habits`）拥有存储之上的一切：

- `list(layer?)` —— 按稳定 id 排序的已提交条目（id = 内容寻址的 `layer:topic`）。
- `write(request)` —— 守卫 → 确定性合并 → 持久化 → `user-habits/committed`。同层同主题的写入**更新**条目（版本递增）而不是追加兄弟条目；值未变则报 `duplicate` 拒绝。
- `remove(id)` —— 持久化删除，再以 `op: 'remove'` 发出 `user-habits/committed`；id 不存在报 `not-found`。

提供方继承 `HabitService` 并实现 `listAll`、`persistWrite`、`persistRemove`。基类在提供方持久化成功后才发出提交事件，因此监听方读到的始终是权威存储状态。

## 守卫

`guardHabitValue(raw, maxEntryChars, source, userConfirmed?)` 是唯一执法点——所有调用方的每个值在持久化前都经过它。拒绝抛出带稳定错误码的 `HabitError`：

| 错误码 | 规则 |
|---|---|
| `invalid-value` | 归一化后为空 |
| `guard-injection` | 含隐形控制字符或提示注入模式 |
| `guard-secret` | 命中凭据关键词或不透明 token 形态 |
| `over-budget` | 超过单条字符预算 |
| `invalid-topic` | 主题超出 `[a-z][a-z0-9_-]{0,31}` |
| `duplicate` | 同层同主题写入未变值 |
| `not-found` | 删除不存在的 id |

守卫按来源分层：归一化、隐形字符剥离、非空与预算永远执行。注入与密钥模式对 `agent-proposed` 内容硬拒绝，`user` 来源的内容仅在 `userConfirmed: true`（人类看过警告并确认）时放行。`guardHabitContent(raw)` 预检候选（不含预算）——提议方在询问人类前使用。

值先做 NFKC 归一化与去首尾空白再校验。预算按 Unicode 码点计，而非 UTF-16 码元。

## 模型体验

无——本包不注册任何面向模型的提示词、schema、工具或消息。模型面由消费方拥有。

## 已知限制与暂缓事项

- 守卫的密钥模式是基于关键词与形态的启发式：合法习惯值中的长不透明 token 会被拒，而特殊写法的凭据可能漏过。需要更强检查的部署可在提供方边界叠加外部扫描器。
- 跨层合并（项目覆盖全局）是常驻段消费方的渲染职责；本契约将两层并排存储。
- `maxEntryChars` 只约束单条；总常驻预算是提供方/提示段的职责。
- `user-habits/committed` 是进程内事件（Cordis 事件，非会话事件）：不提供跨进程变更推送。
