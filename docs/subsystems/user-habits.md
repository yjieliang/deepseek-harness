# User habits

English | [中文](user-habits.zh.md)

The user-habit memory system stores what a person asks the agent to keep doing across sessions. Entries live in two layers — `global` in the `user-habits` settings namespace, `project` in the workspace `USER.md` — with one guarded write path, one budgeted prompt-injection section, and one settings page that lists and edits global entries. The package family and its composition live in [`packages/habits`](../../packages/habits/README.md); the browser surface lives in [`@deepseek-ai/dsh-client-ui-memory`](../../packages/client/ui-memory/README.md); the design decision is the [user-habit memory system Agent Note](../../.agents/notes/implemented/feature/2026-08-15-user-habit-memory-system.md).

## Data model

A [`HabitEntry`](../../packages/habits/user-habits/src/types.ts) is the committed record: a branded `HabitId` (`layer:topic`), the ownership `HabitLayer` (`global` | `project`), the stable kebab-case `topic`, the normalized value, the final `source` (`user` or `agent-proposed`), a `version` bumped by every write to that id, `updatedAt`, and `guardConfirmed` present only when a human confirmed content the guard would otherwise refuse. `HabitWriteRequest` names layer, topic, raw value, and source; `HabitWriteOutcome` returns the committed entry, the `add`/`update` operation, and the replaced entry on update.

## Guard and storage

`guardHabitValue` normalizes (invisible characters are stripped) and validates: the per-entry character budget (`maxEntryChars`, default 200) always rejects; injection/secret patterns reject `agent-proposed` content hard, while `user` content passes only with an explicit `userConfirmed` override that records `guardConfirmed`. The settings namespace `validate` re-runs the same rules at the wire boundary — topic shape and budget in both phases, the content guard only on writes — so the settings page cannot bypass the guard, and stored entries written before `guardConfirmed` existed load and are migrated to it once.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxhabits--habitservice-abstract-seam"></a>

### `ctx.habits` — `HabitService` (abstract seam)

The habits contract service (`ctx.habits`). Providers extend this class and implement the three storage hooks; consumers (tools, commands, prompt sections) depend on the concrete class only through this contract.

```ts cordis-catalog
/**
 * List committed entries in stable id order, optionally filtered to one layer.
 * @param layer - optional ownership layer filter.
 * @returns a fresh frozen array over the provider's current state.
 */
list(layer?: HabitLayer): readonly HabitEntry[]

/**
 * Validate, consolidate, persist, and commit one habit write. The guard
 * hard-rejects hostile agent-proposed values and rejects user-authored
 * hostile-looking values unless a human confirmed the warning; the budget
 * always holds. Deterministic consolidation replaces the same-topic entry
 * instead of appending a sibling, and an unchanged value is rejected as a
 * duplicate.
 * @param request - layer, topic, raw value, and final author.
 * @param options - optional `userConfirmed` override after a human saw the guard warning.
 * @returns the committed entry, the operation, and the replaced entry on update.
 */
async write(request: HabitWriteRequest, options?: { userConfirmed?: boolean }): Promise<HabitWriteOutcome>

/**
 * Persist a removal and commit it. The removed entry's id leaves the store
 * before the `user-habits/committed` remove event fires.
 * @param id - exact entry id (content-addressed `layer:topic`).
 * @returns the removed entry.
 */
async remove(id: HabitId): Promise<HabitEntry>
```

Source: [`packages/habits/user-habits/src/index.ts:57`](../../packages/habits/user-habits/src/index.ts)

<a id="user-habits-events"></a>

### `user-habits/*` events

<a id="user-habitscommitted--emit"></a>

#### `user-habits/committed` — emit

One durable habit mutation settled: the exact committed entry and the operation it entered by. Emitted strictly after the provider persisted the change, so the store state already reflects the entry when listeners run — consumers read the authoritative data stream, never the payload alone.

```ts cordis-catalog
/**
 * One durable habit mutation settled: the exact committed entry and the
 * operation it entered by. Emitted strictly after the provider persisted
 * the change, so the store state already reflects the entry when listeners
 * run — consumers read the authoritative data stream, never the payload
 * alone.
 * @param entry - the committed entry (a remove carries the removed value).
 * @param op - how the entry changed.
 * @mode emit
 */
'user-habits/committed'(entry: HabitEntry, op: HabitOp): void
```

Source: [`packages/habits/user-habits/src/types.ts:77`](../../packages/habits/user-habits/src/types.ts)
<!-- END GENERATED cordis-surface -->
