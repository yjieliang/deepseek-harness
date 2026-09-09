# @deepseek-ai/dsh-client-ui-kb

English | [中文](README.zh.md)

Web knowledge-base feature for the DeepSeek Harness GUI: a native sidebar footer action above Settings that toggles a near-fullscreen three-column knowledge-base panel over the `kb` Remote namespace (`@deepseek-ai/dsh-host-kb`).

- **Sidebar trigger** — `sidebar.footer.action` entry: a full-width card above Settings in the wide column (icon + label + a live document-count badge) and icon-only on the 56px rail, exactly where the shell renders "footer actions above Settings". Footer actions stack vertically, so the trigger sits on its own row rather than beside sibling footer actions.
- **Panel** — `shell.overlay` entry with three columns. The left column navigates the library's classification axes — status smart folders (inbox / filed / archived) with per-status counts, a directory tree with inline create/rename, and a tag index with counts — plus the trash. The middle column lists documents as cards (summary snippet, tags, updated date) under pinned and date groups (today / yesterday / this week / earlier), each card with a pin / move / delete menu. The right column reads and edits one document: breadcrumbs, title, an operable metadata bar (status and directory moves through `kb.moveDoc`, tag chips through `kb.saveDoc`), split-source editing with Ctrl+S save, and a clickable backlinks panel. Trash mode swaps the right column for a read-only preview with restore / purge.
- **Search** — the header search box routes 2-gram AND queries through `kb.search` and reports the total match count; Esc clears it back to browsing.

The panel rebuilds the engine index from disk through `kb.refresh` every time it opens and via a header refresh button, so documents added by agents or by direct file edits appear without a restart.

The trigger and the panel share one `KbUiController` open-state store through the injected `hooks` compartment, so toggling from either side converges the other. All copy is localized (zh/en); all colors are DSH theme tokens.

## Model Experience

Indirectly, through the `kb` Remote namespace, every panel action reads or writes the machine-global library at `$DSH_HOME/kb` (outside any workspace) and never reaches the model; the model-facing `kb_*` tools live in [`@deepseek-ai/dsh-tool-kb`](../../host/tool-kb) and own any model-visible effect, while this package also contributes the knowledge-base domain of the unified `@` reference menu (the `knowledge-base` trigger source, the `@kb:` appearance registration, and the two `conversation.*.refGlyph` chain occupants).

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **No double-link navigation** — `[[links]]` render as plain text; in-panel link jumps are deferred.
- **No per-directory counts** — the directory tree renders without document counts until a per-directory count endpoint lands.
- **Flat directory pickers** — the create and move-to surfaces use a flat directory select rather than the tree; the nav tree itself is the tree view.
- **No unsaved-change interception** — leaving a document or closing the panel while editing discards the draft.
