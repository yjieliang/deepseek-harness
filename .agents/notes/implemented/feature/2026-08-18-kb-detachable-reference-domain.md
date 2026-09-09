# Agent Note: Knowledge-base reference domain becomes a contributed source

Status: implemented

English | [中文](2026-08-18-kb-detachable-reference-domain.zh.md)

Related: the [on-demand retrieval note](2026-08-18-kb-on-demand-and-reference.md), which owns the retrieval-gating decision this note implements the mechanism for; the [engine-convergence note](2026-08-15-kb-engine-convergence-tool-package.md) stands unchanged.

## Problem

The `@kb:` reference pipeline hardwired knowledge-base knowledge into packages that must outlive it: `ui-reference` carried a built-in kb candidate domain, `ui-input-trigger`'s frozen `appearance` union named `'kb'`, `ui-conversation` had a kb glyph case plus an `@kb:` prefix branch in the transcript scanner, and `dsh-file-reference`'s prompt carved `@kb:` out of the `@`-file rule. Removing the kb composition rows would have left kb branches behind, so the capability was not detachable.

## Decision

Invert every kb branch into an extension point and give the kb plugin the contributor role; the 16 tools, the panel, and the `@kb:` UX are unchanged.

- **The kb reference domain is its own trigger source.** `@deepseek-ai/dsh-client-ui-kb` registers a `knowledge-base` `InputTriggerSource` (order 1, after the file/session source) through `ctx.inputTriggers`, keeping the sectioned menu rendering identical. The source owns the title/path prefix listing, the `kb:` namespace strip, quoted suppression, and the atomic `@kb:` insert with the `kb` appearance.
- **Appearance kinds are merge-extensible, and contributed kinds register their plain-text prefixes.** `ReferenceInsert.appearance` widens to `ReferenceAppearance = 'session' | 'file' | 'folder' | (string & {})` with the documented default (an unknown kind renders without a domain glyph). The new `ctx.referenceAppearances` service (owned by `dsh-client-ui-input-trigger`, the contract owner) maps `@`-tokens to contributed kinds; ui-kb registers `{ kind: 'kb', tokenPrefixes: ['kb:'] }`.
- **Glyphs route through chain slots.** `ui-conversation` declares `conversation.input.refGlyph` and `conversation.chat.refGlyph` chain slots; its built-in catalog stays the owner fallback for the core kinds, and ui-kb registers the data-glyph occupant (`select: kind === 'kb'`) into both. The transcript scanner receives the kind mapping plus a slot-backed `renderGlyph` synthesized by ChatView from its own `renderSlotChain` prop — inject carries the `kindForToken` half only, because ReactNode content routes through slots.
- **The `@kb:` grammar carve-out moves into the kb section.** `dsh-tool-kb`'s prompt section sits at order 100, after the file-reference section's order-99 `@`-grammar rule, and its 【引用语法】 paragraph is the model's latest word; `FILE_REFERENCE_PROMPT` reverts to the plain workspace-file rule. One section owns the `@` grammar per domain instead of the core prompt naming kb tools.

## Alternatives considered

**Keep the combined source and add a candidates-provider interface.** Rejected: the input-trigger pipeline already registers independent sources per trigger; a second registry would duplicate `registerSource`'s disposal and menu-group semantics.

**A ReactNode-producing callback through inject for the glyph.** Rejected: client discipline routes ReactNode content through slots; the chain kind exists exactly for owner-less takeover, and the fallback stays with the declarer.

**Open `appearance` but hardcode the kb glyph in `ui-conversation`.** Rejected: it leaves kb residue in a package that must outlive the capability.

## Consequences

Detaching kb (dropping the kb rows from the composition) removes the candidates, the appearance mapping, the glyph occupants, and the prompt carve-out together, leaving no kb branches in `ui-reference`, `ui-input-trigger`, `ui-conversation`, or `dsh-file-reference`. Two new slot declarations and the `referenceAppearances` service are the reusable seats for the next reference domain. The kb version token stays a plain string: `types.ts` documents the wire vocabulary as client-safe plain JSON, and branding it would ripple through the generated typert artifacts for marginal type safety — revisited when those artifacts regenerate anyway.

## Testing

`ui-input-trigger` gains the appearance-registry spec; `ui-kb` gains the reference-source spec (registration, prefix listing, namespace strip, quoted suppression, failure folding, cap, atomic insert, occupant disposal); `ui-conversation` specs pin contributed-glyph routing through stub occupants and the no-occupant default; `ui-reference` specs drop the kb domain and keep file/session behavior. `tool-kb`'s registration spec pins the order-100 section. The `examples/kb-agent` snapshot suite is the keyless composition tier: the recorded `kb-search-turn` scenario boots the full tree against a fresh per-run library (the harness points `DSH_HOME` at the generated cwd) and its header pin owns the order-100 prompt text plus all 16 tool schemas. The scenario is search-only by constraint: `kb_get`'s version token embeds the fs stat identity (file index and timestamps), so a re-created seed document can never replay.
