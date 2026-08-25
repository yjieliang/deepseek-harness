# @deepseek-ai/dsh-host-kb

English | [中文](README.zh.md)

Knowledge-base host feature for the machine-global library root (default `$DSH_HOME/kb`, shared by every workspace). One `kb` Remote namespace over the Typert gateway serving the browser knowledge-base panel, plus the `/dsh-kb` image route for document images.

The engine builds a lazy in-memory index of every `*.md` under the library root (field-weighted BM25 search over title/aliases/tags/summary/body, with ranked partial-query hits and one-character typo tolerance), parses flat frontmatter, derives each document's status from its directory (`00-inbox/` or `01-inbox/` → inbox, the configured archive directory → archived, else filed), maintains `kb/_meta/index.json` after every mutation, and moves deletions into a recoverable `.trash`. Paths stay library-relative and are sandbox-checked through the `fs` service's `contains`.

The gateway is a Cordis service registered as `ctx.kb` (a `TypertRemoteService`), so both the browser panel and the model-facing tools share one engine instance. The model-facing `kb_*` TOOLS are deliberately NOT registered here: they live in the first-class consumer package [`@deepseek-ai/dsh-tool-kb`](../tool-kb), which per-session agent presets opt into, while the panel, the service, and the image route stay process-global. The tool-facing surface adds plain (non-Remote) methods on `ctx.kb`: `searchFiltered` (field filters beyond the panel wire), `links` (outlinks + backlinks), and `images` (image registry rebuild + orphans).

## Config

```yaml
- id: kb
  name: '@deepseek-ai/dsh-host-kb'
  config:
    root: $DSH_HOME/kb           # optional; absolute library root, shared by every workspace on this host
    archiveDir: 90-归档           # optional; directory whose documents derive status "archived"
    trashRetentionDays: 30       # optional; days a trashed document is kept before automatic purge; 0 disables
```

`root` defaults to `$DSH_HOME/kb` and accepts an absolute path or a path relative to the harness home. Because the library lives outside the workspace, the deployment must also admit that root under the `workspace-write` sandbox mode: the web-app bundle sets `sandbox-policy.writableRoots: [$DSH_HOME/kb]` beside this row's `root`, and a custom deployment moving the root must move both together.

`archiveDir` defaults to `90-归档` and must be a single non-reserved directory name (`00-inbox`/`01-inbox`/`_meta`/`templates`/`.trash` are refused at load). The engine creates the configured directory on first init, reports it through `kb.stats.archiveDir` (so the panel can offer archive moves), and derives every status from it, so existing documents re-classify immediately when the configuration changes.

`trashRetentionDays` defaults to `30` and must be a non-negative number. Deletion records an ISO timestamp in `kb/_meta/trash.json`; the gateway purges trashed documents whose timestamp is older than the retention window once at load and then every 24 hours (the purge also cascades to exclusively referenced images). Entries deleted before the registry existed have no timestamp and are never auto-purged. `0` disables the sweep entirely.

## Remote surface

`kb.list` / `kb.search` / `kb.get` / `kb.dirs` / `kb.stats` / `kb.tags` / `kb.saveDoc` / `kb.createDoc` / `kb.moveDoc` / `kb.renameDoc` / `kb.createDir` / `kb.renameDir` / `kb.deleteDoc` / `kb.trash` / `kb.restoreDoc` / `kb.purgeDoc` / `kb.refresh` / `kb.resolveLink` — request and result vocabulary in `./types`.

Hot update: the engine keeps a lazy in-memory index and only sees its own writes. `kb.refresh` rebuilds the index from disk (blank files are purged markers and stay out), and the panel calls it whenever it opens, so documents added by agents or by direct file edits appear without a restart.

Document ordering and pinning: `kb.list` returns pinned documents first, then most recently updated; the `pinned: true` frontmatter flag is written and cleared through `kb.saveDoc.pinned` and reported on every summary row.

Directory management: `kb.createDir` creates a library directory through a `.keep` marker and refuses reserved roots; `kb.renameDir` renames a directory and relocates every entry beneath it (documents, their images, and nested directories), re-indexing moved documents. Reserved roots and the archive directory cannot be renamed. `kb.renameDoc` renames a single document within its current directory (changing its filename and frontmatter title, keeping the rest of the metadata), minting a collision-free stem.

## Model Experience

Indirectly, through the `kb` Remote namespace and the `/dsh-kb` image route, this package is the panel's data plane and makes no model calls of its own; the model-facing `kb_*` tools live in [`@deepseek-ai/dsh-tool-kb`](../tool-kb) and own any model-visible effect.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Keyword-only retrieval** — search is a field-weighted BM25 2-gram scorer with ranked partial-query hits and one-character typo tolerance; there is no semantic retrieval (the library's Phase 3 plan covers local embeddings).
- **`.trash` is a plain directory** — trashed files are recoverable via the Remote; entries older than `trashRetentionDays` are purged automatically (on load and daily), and `purgeDoc` also blanks a file in place. The trash listing skips blank files, so a purged entry leaves the listing while its bytes stay on disk until the fs seam gains a delete primitive. Purging also blanks and unregisters images the document referenced, but only when no other document references them (by resolved registry path).
- **`renameDir` cannot move binary assets** — the text-only `fs` seam has no byte-write operation, so renaming a directory whose entries include binary files (e.g. images) fails loudly rather than half-relocating them; document-only directories rename cleanly.
- **No per-directory counts** — the directory tree renders without document counts until a per-directory count endpoint lands.
- **The tool-facing surface is plain methods, not Remote** — `searchFiltered`/`links`/`images` exist for `@deepseek-ai/dsh-tool-kb` but are not exported on the Typert wire; a future GUI consumer would promote them to `@Remote` and regenerate the typert artifacts.
