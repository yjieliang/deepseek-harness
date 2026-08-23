# @deepseek-ai/dsh-command-memory

English | [中文](README.zh.md)

Human-facing `/memory` slash command over the habits seam (`ctx.habits`): add, list, and remove. The command dispatches without a model turn and shares the exact write path of the model tools, so guard and consolidation enforcement is identical for humans. A guarded `add` (injection/secret patterns) asks a `仍然记住`/`算了` confirmation when a user-question channel exists and writes with the confirmed override.

## Model Experience

Indirectly, through the recorded `/memory` command execution in the session log; the command itself registers no prompt, schema, tool, or message.

#### KV Cache effect

The recorded command event is append-only and does not alter the prompt prefix.

## Known Limitations and Deferred Work

- `/memory add` always writes the `general` topic; topic selection per command is deferred until the model-facing `memory_add` topic syntax stabilizes.
- The command reports the entry count but not resident-budget occupancy (the ceiling is provider configuration the command cannot see).
- `replace` subcommand is deferred; updating a habit goes through `/memory add` with the same topic (contract consolidation updates instead of appending).
- Without a user-question provider (headless deployments), guarded content stays hard-rejected — the confirmation override is unavailable.
