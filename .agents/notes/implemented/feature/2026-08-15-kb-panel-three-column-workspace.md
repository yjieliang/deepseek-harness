# Agent Note: Knowledge-base panel three-column workspace

Status: implemented

English | [中文](2026-08-15-kb-panel-three-column-workspace.zh.md)

## Problem

The first knowledge-base panel ported the dynamic-plugin design one-to-one: a 1040×680 modal whose only classification axis was four raw status chips in the header. The backend already carried the richer vocabulary — per-status counts, a tag index with counts, directory filtering, document summaries, field-patch saves, and document moves — but the panel used none of it, so the library felt cramped and flat while the data model had enough structure for a real workspace.

## Decision

The panel is a near-fullscreen three-column workspace (8px breathing edge), with the classification axes moved into a navigation column and the reading pane given a document head and operable metadata.

- **Navigation column**: status smart folders (收集箱 / 已归类 / 已归档) with per-status counts from `kb.stats`, a directory tree (built client-side from the flat `kb.dirs` list) with inline create/rename through the new `kb.createDir` / `kb.renameDir`, a tag index with counts from `kb.tags`, and the trash as a sibling view.
- **List column**: document cards (title, two-line summary, tag chips, updated date) under pinned and date groups; every card carries a pin / move / delete menu. `kb.list` orders pinned first, then most recently updated, with the `pinned: true` frontmatter flag written through `kb.saveDoc.pinned`.
- **View column**: breadcrumbs and document actions merged into a single header row; the document title; an operable metadata bar limited to a "Move to" directory picker and tags (status is derived from the directory, so the redundant status dropdown is removed); split-source editing with Ctrl+S that fills the remaining column height; a clickable backlinks panel; and a trash mode that renders a read-only preview with restore / purge. Moving a document from the reading pane updates the selected path to the destination and switches the directory filter to the target directory so the moved document remains in context.
- **Visual and interaction language**: emoji glyphs are replaced with `dsh-client-ui-primitives` SVG icons; navigation, list, tree, card, and menu items receive hover backgrounds and `:focus-visible` rings through DSW theme tokens; active items add a left accent indicator; the search input shows an inline icon, a `Ctrl+K` shortcut hint, a clear button, and debounces queries at 300 ms; empty states show a centered icon and a primary action; the error bar uses the error-tertiary background and a warning icon; the trash purge action uses inline confirmation instead of a native `window.confirm`.
- **Configuration**: the archive directory moved from a hard-coded `90-归档` to a gateway `archiveDir` config (default `90-归档`), validated at load against the reserved roots; `kb.stats.archiveDir` exposes it so the panel can offer archive moves. Status derivation now honors it, and `01-inbox` joins `00-inbox` as an inbox root.
- **Directory management**: `kb.createDir` creates directories through a `.keep` marker (reserved roots refused); `kb.renameDir` renames a directory and recursively relocates every entry beneath it, re-indexing moved documents. The text-only fs seam has no byte-write operation, so a directory whose entries include binary assets fails the rename loudly rather than half-relocating them.
- **Trash retention**: deletion records an ISO timestamp in `kb/_meta/trash.json`; the gateway purges trashed documents older than the configurable `trashRetentionDays` (default 30, `0` disables) once at load and then daily, cascading to exclusively referenced images. Entries that predate the registry have no timestamp and are never auto-purged; `kb.trash` reports each entry's `deletedAt`.
- **Hot index refresh**: the engine keeps a lazy in-memory index and only sees its own writes; `kb.refresh` rebuilds it from disk (blank files are purged markers and stay out), the panel calls it on every open and via a header refresh button, and the knowledge-base agent preset rescans (throttled) before its index-based tools, so documents added by agents or by direct file edits appear without a restart.
- Two pre-existing engine bugs fixed with the rename work: `move` and `remove` left the old path in the in-memory index (moved/deleted documents kept appearing in `kb.list`).

## Alternatives considered

### Keep the modal and iterate chips in place

The smallest change, but the classification axes multiply (status, directory, tag) and a chip row scales poorly; the modal size also caps the reading experience the library's long documents need.

### Notion-style database views (table / gallery / board)

The data model is file-and-frontmatter rather than structured records, and the panel is a sidebar-adjacent surface, not a standalone app; three-column navigation matches the Obsidian/Bear pattern the library's markdown shape already follows.

### Automatic compaction of directories into status folders

Directory → status derivation already encodes the mapping; adding a status-editing layer on top would introduce a second source of truth for where a document lives.

## Consequences

- The panel diverges from the Web GUI's dialog vocabulary (it is the only near-fullscreen surface); Esc and the backdrop click still close it, and the sidebar trigger keeps the toggle symmetrical.
- Directory rename is a document-and-text-entry operation: binary assets under a renamed directory fail the call and the directory keeps its old name until the assets are removed.
- Directory-tree document counts and `[[link]]` navigation are still absent (no per-directory count endpoint; link resolution exists but the panel does not jump yet), and unsaved edits are still discarded when leaving a document.

## Testing

- Engine tests (`packages/host/kb/tests/core.spec.ts` over an in-memory fs fake) cover status derivation with a configured archive directory, pinned ordering and flag writes, directory create/rename (including nested relocation and index drops), and the moved/removed index fixes.
- Trash retention tests cover timestamp recording and reporting, the sweep purging expired entries with the image cascade, fresh and legacy entries surviving, retention `0`, and restore/purge unregistering the registry entry.
- Refresh tests cover externally added documents appearing, externally blanked documents dropping, externally edited content serving fresh, and the on-disk index rewrite; the panel spec covers refresh on open and via the header button.
- Panel component tests (`packages/client/ui-kb/tests/kb-panel.client.spec.tsx`) cover the three-column render, document open with backlinks, card-menu pinning, edit/save, the debounced search total, and the updated tag-input placeholder.
