# Agent Note: User-habit memory system

Status: implemented

English | [中文](2026-08-15-user-habit-memory-system.zh.md)

## Problem

Nothing between sessions remembers what a person asked the agent to keep doing. One-off requests ("always reply in Chinese", "prefer kebab-case") were honored only inside the conversation that stated them, and there was no guarded, inspectable place where the person could later see or retract what had been recorded. Any long-term memory also injects into the prompt, so hostile or secret content a model wrote down would ride straight into the next request — the write path needed an enforcement point, not documentation.

## Decision

A `habits/` package family owns a two-layer user-habit memory system:

- **Service seam** (`dsh-user-habits`): `ctx.habits` with `write`/`remove`/`list`, a deterministic same-topic consolidation (update bumps the version, unchanged value is `duplicate`), a `user-habits/committed` event, and the shared guard (`guardHabitValue`). The guard is source-layered: `agent-proposed` content that trips the injection/secret patterns is hard-rejected always; `user` content may be admitted only with an explicit `userConfirmed` override, which marks the entry `guardConfirmed`; invisible characters are always stripped; the per-entry character budget always rejects.
- **Storage** (`dsh-habits-settings`): the `global` layer lives in the user-settings namespace `user-habits`, plus the budgeted resident prompt section (`user-habits`, order 50) rendered under the token-meter's fixed-density heuristic. The namespace registers a `validate` that re-runs the same rules at the settings boundary: topic shape and budget are hard, content-guard failures pass only for entries carrying `guardConfirmed` — a person editing settings cannot bypass the guard, and a confirmed override survives re-validation.
- **Model tools** (`dsh-tool-memory`): `memory_add` / `memory_list` / `memory_remove` / `memory_propose`. Additions with `layer: 'project'` are refused with a pointer to the workspace `USER.md`; guard rejections on user-source writes ask the person to confirm before retrying with `userConfirmed`; `memory_propose` pre-checks the guard (a rejected suggestion is never shown), asks a single confirm question, and applies a process-local dedup TTL.
- **Command** (`dsh-command-memory`): `/memory add|list|remove` with the same guard-confirm flow.
- **Project layer** (L2): workspace `USER.md` with `## topic` sections rides the `agent-instructions` injection chain (`USER.md` added to the candidates); `## 用户习惯` injection of `USER.md`-carried sections is explicit.
- **Settings surface** (`dsh-client-ui-memory`): the settings panel's `memory` section lists, adds, edits, and removes global entries through `settings.describe` + `settings.replace` with `expectedRevision`. Writes made there maintain the same bookkeeping (version bump, `updatedAt`, `source: 'user'`). A guard refusal shows the host's message once and offers a single "save anyway" that persists `guardConfirmed`; a budget refusal is never overridable. The section re-reads on `settings/document-updated`, so tool-written entries appear live.

## Guard semantics (pinned)

The operation that decides is the operation that enforces: `HabitService.write` guards before persist, the settings namespace `validate` guards at the wire boundary, and `memory_propose` pre-checks before a suggestion is ever shown. `agent-proposed` never overrides. Only an explicit human confirmation flips a user-source entry to `guardConfirmed`, which is the one flag that later validation lets past the content guard — budget and topic rules still apply to it. The validator is phase-aware (`load` vs `write`, a `dsh-settings` contract): topic shape and budget are hard in both phases, while the content guard runs on writes only, so entries stored before `guardConfirmed` existed load and are migrated to the flag once at boot instead of refusing the whole plugin.

## Alternatives considered

### Why not an external memory provider (Mem0, Letta, Zep, LangMem…)?

The research pass over current open-source memory systems showed they all trade the harness's own seams for a second store, a new wire protocol, and their own injection loop. The habits seam keeps one store (user settings), one injection path (system-prompt sections), and the harness's guard/budget machinery; nothing external is trusted with model-written text.

### Why not edit the settings namespace from the UI without a validator?

The settings wire would have been a second write path around the guard — the exact bypass the guard exists to close. The namespace `validate` runs on every write, so both paths (tool and settings page) converge on the same rules; the `guardConfirmed` flag is what keeps a human-confirmed entry legal across both.

### Why not build a settings-UI tool instead of a section?

A model-visible tool would have to serialize the whole namespace on every keystroke and could not show the guard's confirmation flow; the settings section keeps editing in the UI domain and the model-visible surface (`memory_*`) separate.

## Consequences

- The seam, tools, and page share one authoritative store; the resident section, `memory_list`, and the settings page all project the same entries.
- User-authored hostile-looking content is storable only with an explicit confirmation, and that fact is durable (`guardConfirmed`), so later edits do not silently re-reject it.
- The settings page reads through `settings.describe`, which is loopback-only; a LAN browser sees the section's error state, the same constraint every settings surface shares.
- Deferred: cross-session persistent proposal dedup, a programmatic L2 file backend, and budget-occupancy display in `memory_list`.

## Testing

`packages/habits` suites cover the guard matrix, deterministic consolidation, the commit event, and the namespace validator; `packages/client/ui-memory` covers the controller (wire parsing, revision conflicts, one-shot override) and the section's visible behavior. Both aggregates typecheck; `test:gui` and `verify-package-invariants` (229 companions) pass.
