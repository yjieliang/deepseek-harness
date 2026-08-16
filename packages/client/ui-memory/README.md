# @deepseek-ai/dsh-client-ui-memory

English | [中文](README.zh.md)

Web memory surface plugin: its browser half registers the `memory` entry in the root-scoped `settings.section` slot — the settings page that lists, adds, edits, and removes global user habits. Its node half is empty on purpose: the `user-habits` settings namespace it edits is a host contract owned by `dsh-habits-settings`, and this plugin only surfaces it through the wire (`settings.describe` to read, `settings.replace` with `expectedRevision` to write).

A person's edits maintain the same bookkeeping the host `HabitService` owns — version bumps and `updatedAt` on change, `source: 'user'` for anything written here — because the browser has no access to the service. The host's namespace validation still runs on every write, so the guard cannot be bypassed from the UI: over-budget content always rejects, and content that trips the injection/secret guard rejects once, then offers a single "Save anyway" that persists `guardConfirmed` — the human confirmation the guard exists to require.

The section re-reads on the forwarded `settings/document-updated` event, so an entry written by the conversation's `memory_add` tool appears while the settings panel stays open.

## Model Experience

Indirectly, through `dsh-tool-memory`; that package owns the model-visible tool schema and structured result, and the host resident prompt section renders the same entries this page edits.

#### KV Cache effect

No direct invalidation; `dsh-user-habits` owns the injected section that changes.

## Known Limitations and Deferred Work

- **Reads ride `settings.describe`, which is loopback-only** — a browser connecting over a LAN sees the section's error state with a retry instead of the entries, the same constraint every settings surface shares.
- **Concurrent edits fail, they do not merge** — a write with a stale `expectedRevision` is refused by the host and the section re-reads; the user re-applies the edit.
