# @deepseek-ai/dsh-client-ui-kb

Web knowledge-base feature for the DeepSeek Harness GUI: a native sidebar footer action above Settings that toggles a browse/edit overlay panel over the `kb` Remote namespace (`@deepseek-ai/dsh-host-kb`).

- **Sidebar trigger** — `sidebar.footer.action` entry: icon + label in the wide column, icon-only on the 56px rail, exactly where the shell renders "footer actions above Settings".
- **Overlay panel** — `shell.overlay` entry: search (2-gram AND), status chips, create, read/edit with Ctrl+S save, delete-to-trash, trash restore/purge. All copy is localized (zh/en); all colors are DSH theme tokens.

The trigger and the panel share one `KbUiController` open-state store through the injected `hooks` compartment, so toggling from either side converges the other.

## Model Experience

No model calls. All data comes from the `kb` Remote namespace (files under the workspace `kb/` root); images referenced by documents are served over `/dsh-kb`.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Design baseline** — this first version ports the dynamic-plugin panel 1:1; layout, icons, and interactions are expected to be iterated (the user owns the design direction).
- **No double-link navigation** — `[[links]]` render as plain text; in-panel link jumps are deferred.
