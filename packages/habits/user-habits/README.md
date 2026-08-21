# @deepseek-ai/dsh-user-habits

English | [中文](README.zh.md)

User-habit memory seam for the DeepSeek Harness. This package is the **Service Definition**: the abstract `HabitService` contract, the write-time safety guard, deterministic topic consolidation, the branded `HabitId`, typed `HabitError`s, the `user-habits/committed` event, and the canonical resident-section renderer. Providers implement the three storage hooks; tools, commands, and prompt sections depend on the contract only.

Design record: `kb/30-工作文档/2026-08-15-用户习惯记忆系统设计方案.md` (user-habit memory system design).

## Contract

`HabitService` (`ctx.habits`) owns everything above storage:

- `list(layer?)` — committed entries in stable id order (id = content-addressed `layer:topic`).
- `write(request)` — guard → deterministic consolidation → persist → `user-habits/committed`. A same-layer same-topic write **updates** the entry (version bump) instead of appending a sibling; an unchanged value rejects with `duplicate`.
- `remove(id)` — persist the removal, then emit `user-habits/committed` with `op: 'remove'`; a missing id rejects with `not-found`.

Providers extend `HabitService` and implement `listAll`, `persistWrite`, `persistRemove`. The base class emits the commit event strictly after the provider persisted, so listeners read authoritative store state.

## Guard

`guardHabitValue(raw, maxEntryChars, source, userConfirmed?)` is the only enforcement point — every value passes it before persistence, from every caller. Rejections throw `HabitError` with a stable code:

| Code | Rule |
|---|---|
| `invalid-value` | empty after normalization |
| `guard-injection` | invisible control characters or prompt-injection patterns |
| `guard-secret` | credential keywords or opaque token shapes |
| `over-budget` | above the per-entry code-point budget |
| `invalid-topic` | topic outside `[a-z][a-z0-9_-]{0,31}` |
| `duplicate` | same-layer same-topic write of the unchanged value |
| `not-found` | remove of an absent id |

The guard is source-layered: normalization, invisible-character stripping, non-emptiness, and the budget always apply. The injection and secret patterns hard-reject `agent-proposed` content; a `user`-authored value passes them only with `userConfirmed: true` (a human saw the warning and confirmed). `guardHabitContent(raw)` pre-checks a candidate without the budget — proposers use it before asking a human.

Values normalize with NFKC and trim before validation. The budget counts Unicode code points, not UTF-16 units.

## Model Experience

None — this package registers no model-facing prompt, schema, tool, or message. Consumers own the model surface.

## Known Limitations and Deferred Work

- The guard's secret patterns are keyword- and shape-based heuristics: a long opaque token in a legitimate habit value is rejected, and an exotic credential phrasing may pass. Deployments needing stronger checks layer an external scanner at the provider boundary.
- Cross-layer merge (project overrides global) is a rendering concern owned by the resident-section consumer; this contract stores layers side by side.
- `maxEntryChars` bounds one entry only; a total resident budget is a provider/prompt-section concern.
- The `user-habits/committed` event is process-local (a Cordis event, not a session event): cross-process change push is not provided.
