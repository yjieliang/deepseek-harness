# Habits

User-habit memory capability family: the contract seam, the settings-backed provider, and the model/human consumers.

| Package | Role | `ctx` key |
|---|---|---|
| [`user-habits/`](user-habits/README.md) | Service Definition: `HabitService` contract, write guard, deterministic consolidation, `user-habits/committed` event | `ctx.habits` |
| [`habits-settings/`](habits-settings/README.md) | Service Provider: settings namespace `user-habits` (global layer) + budgeted resident prompt section | — |
| [`tool-memory/`](tool-memory/README.md) | Consumer: model-facing `memory_add` / `memory_list` / `memory_remove` + guidance section | — |
| [`command-memory/`](command-memory/README.md) | Consumer: human-facing `/memory` command | — |

Design record: `kb/30-工作文档/2026-08-15-用户习惯记忆系统设计方案.md`.
