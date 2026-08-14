# @deepseek-ai/dsh-host-kb

Knowledge-base host feature for the `kb/` workspace root. One `kb` Remote namespace over the Typert gateway serving the browser knowledge-base panel, plus the `/dsh-kb` image route for document images.

The engine builds a lazy in-memory index of every `*.md` under `kb/` (2-gram inverted search over title/aliases/tags/summary/body), parses flat frontmatter, derives each document's status from its directory (`00-inbox/` or `01-inbox/` → inbox, the configured archive directory → archived, else filed), maintains `kb/_meta/index.json` after every mutation, and moves deletions into a recoverable `.trash`. Paths stay library-relative and are sandbox-checked through the `fs` service's `contains`.

The model-facing `kb_*` TOOLS are deliberately NOT registered here: they belong to the per-session agent preset (`knowledge-base`), so agents opt into them per session while the panel and the image route stay process-global.

## Config

```yaml
- id: kb
  name: '@deepseek-ai/dsh-host-kb'
  config:
    archiveDir: 90-归档   # optional; directory whose documents derive status "archived"
```

`archiveDir` defaults to `90-归档` and must be a single non-reserved directory name (`00-inbox`/`01-inbox`/`_meta`/`templates`/`.trash` are refused at load). The engine creates the configured directory on first init, reports it through `kb.stats.archiveDir` (so the panel can offer archive moves), and derives every status from it, so existing documents re-classify immediately when the configuration changes.

## Remote surface

`kb.list` / `kb.search` / `kb.get` / `kb.dirs` / `kb.stats` / `kb.tags` / `kb.saveDoc` / `kb.createDoc` / `kb.moveDoc` / `kb.createDir` / `kb.renameDir` / `kb.deleteDoc` / `kb.trash` / `kb.restoreDoc` / `kb.purgeDoc` / `kb.resolveLink` — request and result vocabulary in `./types`.

Document ordering and pinning: `kb.list` returns pinned documents first, then most recently updated; the `pinned: true` frontmatter flag is written and cleared through `kb.saveDoc.pinned` and reported on every summary row.

Directory management: `kb.createDir` creates a library directory through a `.keep` marker and refuses reserved roots; `kb.renameDir` renames a directory and relocates every entry beneath it (documents, their images, and nested directories), re-indexing moved documents. Reserved roots and the archive directory cannot be renamed.

## Model Experience

Indirectly, through the `kb` Remote namespace and the `/dsh-kb` image route, this package is the panel's data plane and makes no model calls of its own; the model-facing `kb_*` tools live in the knowledge-base agent preset and own any model-visible effect.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Index duplication with the preset** — the `knowledge-base` agent preset ships its own import-free copy of the engine for the model-facing tools; the two implementations can drift until the preset can depend on this package.
- **No full-text ranking** — search is 2-gram AND intersection with recency sort; no TF-IDF or fuzzy matching.
- **`.trash` is a plain directory** — trashed files are recoverable via the Remote but not automatically cleaned; `purgeDoc` blanks a file in place and the trash listing skips blank files, so a purged entry leaves the listing while its bytes stay on disk until the fs seam gains a delete primitive.
- **`renameDir` cannot move binary assets** — the text-only `fs` seam has no byte-write operation, so renaming a directory whose entries include binary files (e.g. images) fails loudly rather than half-relocating them; document-only directories rename cleanly.
- **No per-directory counts** — the directory tree renders without document counts until a per-directory count endpoint lands.
