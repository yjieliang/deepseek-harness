# 用户习惯

[English](README.md) | 中文

用户习惯记忆能力家族：契约 seam、settings 后端提供方，以及模型/人类消费方。

| 包 | 角色 | ctx key |
|---|---|---|
| [`user-habits/`](user-habits/README.md) | Service Definition：`HabitService` 契约、写入守卫、确定性合并、`user-habits/committed` 事件 | `ctx.habits` |
| [`habits-settings/`](habits-settings/README.md) | Service Provider：settings 命名空间 `user-habits`（global 层）+ 带预算的常驻提示段 | — |
| [`tool-memory/`](tool-memory/README.md) | Consumer：面向模型的 `memory_add` / `memory_list` / `memory_remove` + 引导段 | — |
| [`command-memory/`](command-memory/README.md) | Consumer：人类 `/memory` 命令 | — |

设计记录：`kb/30-工作文档/2026-08-15-用户习惯记忆系统设计方案.md`。
