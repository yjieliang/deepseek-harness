# Agent Note: Archived Session Management

Status: implemented

English | [中文](2026-08-15-archived-session-management.zh.md)

## Problem

[`session-archive-global-set`](../../implemented/feature/2026-07-31-session-archive-global-set.md) shipped `workspace.archiveSession` and the registry-global `archivedSessionIds` set, but archiving was one-way from the user's point of view: no surface showed *which* sessions were archived and no RPC undid an archive. The registry JSDoc recorded the intent — "a future unarchive restores its position" — unrealized. The only recovery path was hand-editing `workspace.json` plus a host restart (the running host caches the domain global in memory).

## Decision

Add unarchive-to-restore with a trash-like "Archived" view in the sidebar workspace browser. The only new capability is the inverse write `unarchiveSession`; display reuses the session summaries the client already holds.

**Host — `unarchiveSession`** (`WorkspaceRegistry`, `@deepseek-ai/dsh-workspace`): rides the same `enqueueOperation` chain as archive/create/delete; removes the id from `archivedSessionIds` and persists via `setState`. An id already absent resolves as a no-op (no write, no event). It performs no existence re-check — archive never removes the log or the accounting slot, so a re-check could only propagate a `sessionPersistence.list()` fault or block restoring a session whose log was deleted externally. The `domain/changed` global-put branch in `dsh-host-apiproxy` already diffs `archivedSessionIds` and emits `host/archived-sessions-changed`, so the write needs no new event plumbing.

**Wire — `workspace.unarchiveSession`**: mirrors `archiveSession` with the full-snapshot posture across `api/workspace.ts`, `api/workspace.schema.ts`, `api/rpc-map.ts`, `fetch/handler.ts`, `fetch/client.ts`, and the `api-proxy.ts` handler. `workspace.unarchiveSession({ sessionId }) → { archivedSessionIds }` answers the full updated set; an absent id is the idempotent no-op, not a `session-not-found` rejection (that code is archive-only).

**Client runtime** (`packages/client/runtime`): `WorkspaceRuntime.unarchiveSession` → `manager.unarchiveSession` installs the returned set through `installArchived`, so the unary echo, the `host/archived-sessions-changed` frame, and the reconnect baseline all update `WorkspaceListState.archivedSessionIds` identically. The snapshot shape is unchanged.

**Client UI** (`packages/client/ui-workspace`): a muted footer row below the tree —「已归档」with a live count badge when non-empty — swaps `listArea` into the archived view (the `showTrash` pattern from `ui-kb`). `deriveArchived(list, archivedSessionIds, workspaces)` in `tree.ts` projects archived ids in archive order into `ArchivedNode { id, title, workspaceTitle, updatedAt }`; `ArchivedSessionItem` renders the title (falling back to the id when the summary is absent), the owning Workspace title (Ungrouped sessions fall back to the localized `group.ungrouped`), and a「恢复」action. Restore commits without a dialog and reports failures as non-fatal console diagnostics — the archive row action's exact posture. Locale adds `archived.entry`, `archived.back`, `archived.empty`, `archived.restore` (zh + en); the count is a plain numeric badge. `deriveGroups`/`deriveFlat`/`deriveSearchResults` keep filtering by the archive set unchanged.

## Alternatives considered

**Per-workspace expandable "Archived" group.** Rejected: archived Ungrouped sessions have no workspace to live under, the same hang the per-workspace-set form of the global set hit in the [parent note](../../implemented/feature/2026-07-31-session-archive-global-set.md); the user also chose the trash-like single view.

**A "show archived" filter toggle mixing grayed rows in place.** Rejected: it cannot offer a review surface the way a dedicated list can, and it re-litigates the parent note's rejection of an archived flag on `SessionSummary` — the display still joins the workspace-domain set against session summaries, which the dedicated `deriveArchived` does once.

**A `workspace.listArchived` RPC returning titles.** Rejected: `sessions.list.byId` already carries the summaries the view renders; a host read merely duplicates the sessions projection.

**Re-validate existence on unarchive.** Rejected: archive never drops the log or slot, so refusal would only propagate `sessionPersistence.list()` faults and block a legitimate restore of a manually-deleted-log id.

## Consequences

- **Restore is dialog-free and silent on failure**, mirroring the archive button: its worst misfire is a session reappearing; a rejected call leaves the list intact and logs `session unarchive rejected:`.
- **Ghost restore**: a session whose log was deleted externally while archived restores as a row whose title falls back to the raw id (unopenable, the same gap as any workspace-referenced missing summary). Accepted — the accounting slot was never removed.
- **Order surprise**: in "Last updated" mode a restored session re-enters the account and is re-ranked by the existing promotion policy from its timestamp; no new semantics.
- **Concurrency**: multi-tab unarchives race exactly as archives do; the full-set frame plus `installArchived`'s byte-equality short-circuit makes the last durable state win coherently.
- **Migration coupling**: `unarchiveSession` names the same remote surface as the in-flight [`unary-apiproxy-remote-migration`](../../proposed/architecture/2026-08-10-unary-apiproxy-remote-migration.md); when that lands it must carry `unarchiveSession` alongside `archiveSession` to avoid a split RPC path.

## Testing

- Registry: archive→unarchive round-trips to the pre-archive set, keeps the accounting slot, is idempotent, preserves remaining archive order, and restores across restarts (`workspace.spec.ts`).
- Wire: `rpc-schemas.spec.ts` pins the request/value; `api-proxy-workspace.spec.ts` asserts the updated set, the `host/archived-sessions-changed` frame, and the idempotent repeat emitting no second frame.
- Client runtime: `workspaces-service.client.spec.ts` asserts the unary echo installs the set without nudging the selection and a Host failure leaves the set untouched.
- UI: `tree.client.spec.ts` pins `deriveArchived` ordering/workspace-label/ghost fallback; `workspace-browser.client.spec.tsx` covers the count badge, the archived list + workspace label, restore-without-dialog, silent rejection, and the empty state.
- Browser e2e: `workspace-management.e2e.ts` extends the archive case with a restore round-trip across reload.

**Tooling follow-up**: generating the client inspect catalog (`gen-cordis-inspect-catalog`) previously crashed on a pre-existing analyzer bug — `packageExportName` fed `checker.getSymbolAtLocation(sourceFile)` (undefined for a cross-face target absent from the face's program, e.g. a host-type file reached from a client re-export) into `checker.getExportsOfModule()`, and TS 6.0.3's `getSymbolLinks` dereferenced `undefined.flags`. The analyzer now returns a tri-state (`{ name }` / `{ unresolved }` / `undefined`), skipping unanalyzable cross-face targets and falling back to an external reference instead of failing or crashing, mirroring `collectExports`' non-module `continue`. `cordis-catalog.spec.ts` gained a client-face projection test that would have caught the crash. The client catalog now lists `ctx.workspaces.unarchiveSession`; the host catalog (`tool-cordis/src/api-catalog.ts`) regenerated and includes the registry method.
