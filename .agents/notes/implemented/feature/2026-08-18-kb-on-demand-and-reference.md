# Agent Note: Knowledge-base document reference and on-demand retrieval

Status: implemented

English | [中文](2026-08-18-kb-on-demand-and-reference.zh.md)

Related: the [detachable-domain note](2026-08-18-kb-detachable-reference-domain.md), which owns the contributed-source and prompt-ownership mechanism this decision ships through.

## Problem

The knowledge base lives at `$DSH_HOME/kb` (machine-wide, outside any workspace), so the Web `@` reference pipeline's `@file` source — whose discovery and grammar are workspace-bounded — could not point at a knowledge-base note. A user who wanted the agent to answer from a specific note had to hand it a full library-relative path or a keyword search, and a natural phrasing like `@10-技术/note.md` would be misread as a workspace file and opened with `read`, which cannot reach `$DSH_HOME/kb`. Separately, the knowledge-base prompt section pushed the agent to search the library on any mention of "知识库/知识管理/收藏/剪藏", so unrelated conversation could trigger a `kb_search` the turn never needed.

## Decision

The knowledge-base reference domain is its own `knowledge-base` trigger source: `@deepseek-ai/dsh-client-ui-kb` registers it through `ctx.inputTriggers` beside the file/session source of `@deepseek-ai/dsh-client-ui-reference`, so the composer still shows one combined `@` menu. The pipeline starts the `fileReferences/list`, `sessionReferenceResolver/candidates`, and `kb/list` Remote calls together for an unquoted token and renders the rows under file, session, and knowledge-base section headings. The kb source lists the library documents by title/path prefix against `ctx.remote.kb.list`, strips a leading `kb:` from the query so completion matches the document title/path rather than the literal namespace, and inserts an atomic `@kb:<path>` reference with a data glyph. Paths that cannot be safely represented (embedded quote, control characters) are dropped. Any candidate domain may fail independently without hiding rows from the others.

The model-facing side pairs this with two guidance changes. `dsh-tool-kb`'s knowledge-base prompt section states the library is at `$DSH_HOME/kb` (correcting the prior "workspace-root `kb/`" text that invited `read`) and gates retrieval: the agent is told **not** to search the library by default, and to invoke `kb_*` tools only when the user expresses an explicit reference-intent (mentions the knowledge base, names a specific note, uses an `@kb:path` or `[[title]]` reference, or asks to look something up). That section sits at order 100, after the file-reference section, and is the single authoritative ruling for `@kb:`-prefixed paths — knowledge-base references under `$DSH_HOME/kb`, read with `kb_get`, never `read`; `FILE_REFERENCE_PROMPT` states the plain workspace-file rule and carries no kb rule at all.

The reference appearance is registry-extensible rather than a closed union: ui-kb registers `{ kind: 'kb', tokenPrefixes: ['kb:'] }` through `ctx.referenceAppearances`, and the transcript renders `@kb:` chips with the knowledge-base glyph through the contributed chain-slot occupants.

`kb_search`'s tool description also directs the agent to expand a colloquial expression (e.g. "那篇讲用户习惯的") into 2–4 candidate keywords before searching, so a user's phrasing that omits the stored wording still recalls the document — this stays inside the on-demand gate and costs nothing when no search runs.

## Alternatives considered

**Route a knowledge-base candidate through `@file`.** Rejected because the `@file` grammar and `fileReferences` discovery are workspace-bounded; an `@kb:` path would surface as a workspace file and fail against `read`, and suppressing it in one grammar would leak into the shared token parser.

**Add a separate trigger (e.g. `#kb`) instead of widening `@`.** Rejected because users already reach for `@` for references, and a second trigger splits the reference mental model for a domain that belongs in the same menu.

**Search the library with `kb_search` (BM25) for the candidate list.** Rejected because BM25 matches on body content, so a bare filename prefix like `@kb:2026` would surface every document containing "2026" rather than the title prefix; `list` plus client title/path prefix filtering is the fit for input completion, and needs no new Remote contract (`kb.list` already exists).

**Leave the `@kb:` exception to `FILE_REFERENCE_PROMPT`.** Rejected: splitting one grammar across two prompt sections invites drift; the kb section's order-100 position makes it the single authoritative ruling for knowledge-base paths, and the file-reference section carries no kb rule.

## Verification

`packages/client/ui-kb`'s reference-source spec pins the kb domain: source registration, title/path prefix listing, `kb:` namespace stripping, quoted suppression, and the atomic `@kb:` insert with the contributed appearance; `ui-input-trigger`'s service spec pins the appearance registry. `ui-conversation` specs pin contributed-glyph routing and the no-occupant default. `tool-kb`'s registration spec pins the order-100 section text. The `examples/kb-agent` snapshot pins the assembled prompt and all 16 tool schemas keylessly. The pre-existing `chat-view` `/compact` no-history and `kb_rename` failures are unrelated and were confirmed on the pristine baseline.

## Consequences

Input-box completion now reaches the knowledge base through the same unified `@` menu, so a user can type `@` and pick a note the agent will read via `kb_get`. Cost drops for ordinary conversation because the agent is explicitly instructed not to search the library unless the user signals reference-intent; the trade-off is that a genuinely relevant search is skipped when the user's phrasing does not hit the trigger — mitigated by `@kb:`/`[[title]]` as strong triggers and the library-relative hinting in the prompt. The `@kb:` mention keeps the reference path-only (no content attach), so it stays auditable through `kb_get`. The contributed appearance is a mechanical registry extension; the kb glyph reuses an existing outline icon. A knowledge-base reference still requires the host `kb` service (the tools are a hard consumer), so a deployment without it simply has no kb candidates and no `kb_get`.
