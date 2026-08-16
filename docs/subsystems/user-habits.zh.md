# User habits

[English](user-habits.md) | 中文

用户习惯记忆系统存储用户要求 Agent 在会话之间持续遵守的事情。条目分两层——`global` 层存于 `user-habits` 设置命名空间,`project` 层存于工作区 `USER.md`——配有一条受守卫的写入路径、一段有预算的提示词注入段落,以及一个列出和编辑全局条目的设置页。包族与其组装见 [`packages/habits`](../../packages/habits/README.md);浏览器界面见 [`@deepseek-ai/dsh-client-ui-memory`](../../packages/client/ui-memory/README.md);设计决策见 [用户习惯记忆系统 Agent Note](../../.agents/notes/implemented/feature/2026-08-15-user-habit-memory-system.md)。

## Data model

[`HabitEntry`](../../packages/habits/user-habits/src/types.ts) 是提交后的记录:带品牌标记的 `HabitId`(`layer:topic`)、归属 `HabitLayer`(`global` | `project`)、稳定的 kebab-case `topic`、规范化后的值、最终 `source`(`user` 或 `agent-proposed`)、每次写入该 id 时递增的 `version`、`updatedAt`,以及仅当人类确认了守卫本会拒绝的内容时出现的 `guardConfirmed`。`HabitWriteRequest` 指明层、主题、原始值与来源;`HabitWriteOutcome` 返回提交后的条目、`add`/`update` 操作,以及更新时被替换的条目。

## Guard and storage

`guardHabitValue` 先规范化(剥离隐形字符)再校验:单条字符预算(`maxEntryChars`,默认 200)永远拒绝;注入/密钥模式对 `agent-proposed` 内容硬拒,而 `user` 内容只有经显式 `userConfirmed` 覆盖才放行并记录 `guardConfirmed`。设置命名空间的 `validate` 在 wire 边界重跑同一套规则——主题格式与预算在两个相位都生效,内容守卫只在写入相位生效——因此设置页无法绕过守卫,而 `guardConfirmed` 出现之前写入的存量条目可以加载,并会一次性迁移打上该标记。

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
