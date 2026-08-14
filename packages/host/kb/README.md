# @deepseek-ai/dsh-host-kb

Knowledge-base host feature for the `kb/` workspace root. One `kb` Remote namespace over the Typert gateway serving the browser knowledge-base panel, plus the `/dsh-kb` image route for document images.

The engine builds a lazy in-memory index of every `*.md` under `kb/` (2-gram inverted search over title/aliases/tags/summary/body), parses flat frontmatter, derives each document's status from its directory (`00-inbox/` → inbox, `90-归档/` → archived, else filed), maintains `kb/_meta/index.json` after every mutation, and moves deletions into a recoverable `.trash`. Paths stay library-relative and are sandbox-checked through the `fs` service's `contains`.

The model-facing `kb_*` TOOLS are deliberately NOT registered here: they belong to the per-session agent preset (`knowledge-base`), so agents opt into them per session while the panel and the image route stay process-global.

## Remote surface

`kb.list` / `kb.search` / `kb.get` / `kb.dirs` / `kb.stats` / `kb.tags` / `kb.saveDoc` / `kb.createDoc` / `kb.moveDoc` / `kb.deleteDoc` / `kb.trash` / `kb.restoreDoc` / `kb.purgeDoc` / `kb.resolveLink` — request and result vocabulary in `./types`.

## Model Experience

This package makes no model calls. It reads and writes files under the workspace `kb/` root only, and serves image bytes over `/dsh-kb` (20 MiB cap per file).

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **Index duplication with the preset** — the `knowledge-base` agent preset ships its own import-free copy of the engine for the model-facing tools; the two implementations can drift until the preset can depend on this package.
- **No full-text ranking** — search is 2-gram AND intersection with recency sort; no TF-IDF or fuzzy matching.
- **`.trash` is a plain directory** — trashed files are recoverable via the Remote but not automatically cleaned; `purgeDoc` clears them explicitly.
