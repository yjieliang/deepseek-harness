# Agent Note: Knowledge-base engine convergence and tool package

Status: implemented

English | [中文](2026-08-15-kb-engine-convergence-tool-package.zh.md)

## Problem

The knowledge base had two independent engine implementations. `packages/host/kb` shipped the typed, tested `KbEngine` behind the `KbGateway` Remote service, while the `knowledge-base` agent preset carried an import-free ~700-line copy (`kb.plugin.mjs`) because the user-preset module resolver cannot import harness packages. The copies drifted in seven observable ways: `01-inbox` status derivation, the configurable archive directory, the `images.json` format (preset wrote an array, the host read an object), a duplicated `updated:` frontmatter key in `kb_update`, pinned ordering, `index.json` double-writers racing, and refresh behavior. The `expectVersion` optimistic lock was also a no-op in both copies — the guard compared against the freshly-statted version instead of the client's observed version, so the `conflict` flag could never fire.

## Decision

Converge on the host engine and reshape the tool layer into the harness's first-class package form, following the `fs` seam (Service Definition / Provider / Consumer) pattern.

- **The gateway is the service.** `KbGateway` is already a `TypertRemoteService` (a Cordis `Service` registered as `ctx.kb`), so no second service class was introduced — a separate `KbLibrary extends Service` would collide on the `kb` key. The engine stays internal to `@deepseek-ai/dsh-host-kb`; both the browser panel (via the `kb` Remote namespace) and the tools (via `ctx.kb`) share one instance.
- **Tool-facing capabilities are plain methods, not Remote.** `searchFiltered` (field filters beyond the panel wire), `links` (outlinks + backlinks), and `images` (image registry rebuild + orphans) were added to the gateway without `@Remote` decorators, keeping the Typert wire and its generated artifacts frozen. The engine gained the matching logic.
- **A first-class consumer package.** New `@deepseek-ai/dsh-tool-kb` (`packages/host/tool-kb`) registers the 15 `kb_*` tools with schemastery `Config` (`searchTopK`, `batchConfirmN`, `archiveDays`, `clipMaxBodyChars`), the knowledge-base prompt section, and the composite orchestrations (archive, organize, import, export, clip) composing `ctx.kb` primitives. It injects `kb` as a hard dependency, like `tool-fs` injects `fs`; `web` stays optional for `kb_clip` degradation.
- **The preset shrinks to composition.** The `knowledge-base` preset's `agent.cordis.yml` now references `@deepseek-ai/dsh-tool-kb` as a row; `kb.plugin.mjs` was deleted. `@deepseek-ai/dsh-tool-kb` is declared in the base bundle (`packages/bundle/base/package.json`) so preset rows resolve like `dsh-tool-bash`.

Folded-in correctness fixes: the optimistic lock now guards with the client's `expectVersion` and surfaces `FS_STALE_VERSION` as `{ conflict: true }`; the image registry is unified to the object format (`path → { name, referenced }`) that `imageTarget`, `resolve`, and the rebuild all read; `backlinksOf` matches links by title, stem, or path (the `[[文档名]]` semantics); `kb_search` field syntax (`tag:`/`path:`/`status:`/`title:`) lands in the engine's filtered search with the tool layer parsing prefixes.

## Alternatives considered

### Keep both implementations and sync them by hand

Rejected: the drift is inherent to two copies of one engine; a sync discipline would still fail on the next feature that touches only one copy.

### A second `KbLibrary extends Service` class beside the gateway

Rejected: `TypertRemoteService` already extends `Service` and registers the `kb` key, so a second service class would collide at mount; the gateway's public method surface is the service contract.

### Promote the tool capabilities to `@Remote` methods

Rejected for this change: adding Remote methods changes the generated Typert artifacts and the wire surface for the panel; the tool-only methods stay plain and can be promoted when a GUI consumer needs them (documented as a known limitation).

## Consequences

- One engine implementation remains; the preset contains no index, disk, status, or tool-implementation code.
- The panel wire contract is unchanged (`kb.list`/`search`/… and `/dsh-kb`); the client package `ui-kb` is untouched.
- The `knowledge-base` preset's tools now require `@deepseek-ai/dsh-host-kb` in the host composition; a deployment without it leaves `tool-kb` waiting (fail-loud, matching the hard-inject convention).
- `kb_update` conflicts now surface as a thrown `kb: 版本冲突` error; the engine returns `{ conflict: true }` through `ctx.kb.saveDoc`.

## Testing

- Engine tests (`packages/host/kb/tests/core.spec.ts`) cover the field filters on ranked hits, links, the image registry rebuild with orphans, and the optimistic-lock conflict (stale version refuses and leaves content and index untouched; matching version writes through). The `MemoryFs` fake now honors `replaceIfVersion` so the conflict path is exercised.
- Tool tests (`packages/host/tool-kb/tests/tools.spec.ts`) mount the real gateway over the memory fs and cover registration (15 tools + prompt), field-syntax search, add/get, the stale-version conflict through the tool, links, archive preview and threshold gate, import threshold gate, clip degradation, and tags/stats/images.
