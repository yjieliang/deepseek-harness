# Habits

用户习惯记忆能力家族:契约接缝、settings 后端提供方,以及模型/人类消费方。

| 包 | 角色 | `ctx` 键 |
|---|---|---|
| [`user-habits/`](user-habits/README.md) | 服务定义:`HabitService` 契约、写入守卫、确定性合并、`user-habits/committed` 事件 | `ctx.habits` |
| [`habits-settings/`](habits-settings/README.md) | 服务提供方:settings 命名空间 `user-habits`(global 层)+ 带预算常驻提示段 | — |
| [`tool-memory/`](tool-memory/README.md) | 消费方:面向模型的 `memory_add` / `memory_list` / `memory_remove` + 引导段 | — |
| [`command-memory/`](command-memory/README.md) | 消费方:人类 `/memory` 命令 | — |

设计记录:`kb/30-工作文档/2026-08-15-用户习惯记忆系统设计方案.md`。
