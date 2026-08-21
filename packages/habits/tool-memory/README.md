# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

Model-facing user-habit tools over the habits seam (`ctx.habits`): `memory_add`, `memory_list`, `memory_remove`, and `memory_propose`, plus the tool-guidance prompt section. Schemas, boundary validation, the user-confirmation flow, and the pinned model-visible result text live here; the guard, consolidation, and storage live in [`@deepseek-ai/dsh-user-habits`](../user-habits/README.md) and its provider, so every caller passes the same enforcement.

`memory_propose` is the semi-automatic path: the model proposes an observed habit with evidence, the guard pre-checks the candidate (agent-proposed content is hard-rejected before anyone is asked), a user question asks `要记住这条用户习惯吗?` with `[记住]`/`[忽略]`, and only an accepted proposal reaches the write path. Rejected proposals are remembered inside the dedup TTL window.

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `userQuestionAsk` | `true` | Whether `memory_propose` asks the user before writing |
| `proposalDedupTtlMs` | `604800000` (7d) | Window inside which an identical proposal is not re-asked |

## Model Experience

### What the model sees

One fixed guidance section (order `101`) plus four tool schemas:

```markdown
用户习惯(memory)工具:
- 当用户明确表达「以后都…」「记住…」「我习惯…」「我一直都是…」等偏好、规范或约定,要把它落成可跨会话生效的记忆时:调用 memory_add 记录,而不是只在对话里口头应承。
- 你观察到用户的稳定偏好但用户没有明确要求记录时,用 memory_propose 建议记录,经用户确认后再写。
- 已有同主题习惯时,memory_add 会覆盖旧值(同 topic 合并),无需先删除。
- 只有用户明确要求或确认的才写入;不要把未经确认的临时偏好自动写进长期习惯。
- 记忆内容如需修改或删除,用 memory_list 查看后再 memory_remove。
```

The confirmation question the user sees is itself model-visible pinned text: question `要记住这条用户习惯吗?`, options `记住`/`忽略`, detail `[{topic}] {value}\n依据:{evidence}\n想调整内容?选「忽略」后直接说要记住什么。`.

Tool results are plain pinned text, e.g. `已记住:[style] 简洁` / `(无已记录习惯)` / `已删除:[style] 简洁` / `已记录:[style] 简洁` / `未记录,已忽略该建议。`; guard rejections surface the contract's typed `HabitError` message.

### Token effect

One fixed concise guidance section per request while mounted; results are data-dependent and remain in logged tool history until compaction.

### KV Cache effect

Prefix-stable while the plugin and guidance text are unchanged.

## Known Limitations and Deferred Work

- Proposal dedup is process-local (plugin-fiber memory with TTL): it suppresses repeat asks inside one process but does not survive a restart. Persisted cross-session dedup is deferred.
- A free-text answer to the confirmation question is surfaced to the model as `用户补充:…` and treated as a rejection — the model should then use `memory_add` with the revised content.
- `memory_list` reports the entry count but not the resident-budget occupancy — the budget ceiling is provider configuration the tool cannot see; the resident section itself enforces the budget.
- The `project` layer (L2) is carried by the workspace `USER.md` file through the `agent-instructions` injection chain, not by this tool: `memory_add` rejects `layer: 'project'` and points at the file (`## topic` sections, human-editable). A programmatic project-layer backend is deferred.
- The `project` group in `memory_list` stays empty until a project-layer provider exists.
