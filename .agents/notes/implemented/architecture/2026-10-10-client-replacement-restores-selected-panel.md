# Agent Note: A replaced Client plugin keeps the reader's main panel selected

Status: implemented

English | [中文](2026-10-10-client-replacement-restores-selected-panel.zh.md)

## Problem

Replacing a Client entry's code tears the old code's registrations down and imports the new code in one sequence ([client plugin loading model](2026-07-23-client-plugin-loading-model.md)). A panel-owning plugin is therefore briefly absent from the keyed `main` slot, and until this decision the shell's layout store read that absence as a deselection: `retainMainPanels` moved the reader to the Conversation and nothing moved them back, so an open panel stayed closed until they reopened it by hand. Any rebuild of that plugin's bundle — a build watcher, another session's deployment sync — closed the panel of a reader who had not touched the UI.

Measured in this machine's GUI in a real browser: bumping only the mtime of an installed plugin's `client.js`, its bytes unchanged, removed the panel root within about 0.5s and it never returned within 40s, with no console or page error. The same gesture after this decision leaves the panel absent for about 25ms and restores it without user action.

## Decision

`LayoutState` in [`packages/client/ui-layout/src/client/stores.ts`](../../../../packages/client/ui-layout/src/client/stores.ts) carries `restorePanelId: MainPanelId | null` beside `panelInfo`. `retainMainPanels` performs two independent steps on every `main` registry change: when the selected key is absent it is remembered in `restorePanelId` and `activePanelId` becomes `null`; when the remembered key is present again it becomes `activePanelId` and the memory is cleared.

The memory is consumed once, so a panel removed for good leaves the reader on the Conversation. `selectPanel` clears it unconditionally, so an explicit choice — another panel, or the Conversation itself — outranks a panel that returns later. `PanelInfo` keeps its single field: `activePanelId` still always names a registered `main` key, and `LayoutController.selectPanel` still throws for an unregistered one.

Nothing here is time-based. The registry change is the exact signal for both halves of a replacement, so no grace window or fallback delay exists.

## Alternatives considered

**Keep `activePanelId` on the unregistered key and fall back while rendering.** The shell renders `main` by key and would then need registration knowledge in the render path, while `PanelInfo` would publish a selection that names nothing. The controller's check that a selected key is registered would stop meaning anything, and `restorePanelId` would move into the cross-plugin face.

**A grace timer before falling back.** It would restore the same visible behavior from a guess: a rebuild slower than the window would still lose the panel, and correctness would rest on a duration. The registry event already orders the two facts exactly, so the decision needs no timer.

**Preserve the selection inside the replacement path in `packages/client/modules` or `packages/client/hmr`.** Entry replacement is generic and serves every row; teaching it about one consumer's selection state would need the layout store, which another plugin owns, and would put layout vocabulary into the loading model. The layout store already observes both registry changes.

**Skip the teardown on a rebuild.** Out of scope and larger: it would keep registrations from replaced code alive. The [client plugin loading model](2026-07-23-client-plugin-loading-model.md) keeps that decision, including that a reload discards React state inside the replaced plugin — a restored panel comes back with fresh component state, not with its previous in-panel state.

## Consequences

A registration gap no longer costs the reader the panel, and a plugin that deliberately unregisters and later re-registers a selected panel also returns to the reader, because the store cannot tell that case from a replacement; only an explicit `selectPanel` overrides it. A panel whose plugin is removed without re-registering still falls back to the Conversation immediately.

`LayoutState` gains one internal field. The cross-plugin `PanelInfo` type does not change, so no plugin needs updating, and the restore lands in the same registry change that re-declares the key.

Verification: [`tests/layout-store.client.spec.ts`](../../../../packages/client/ui-layout/tests/layout-store.client.spec.ts) pins the four sequences (same key returns, still absent, explicit Conversation, explicit other panel), [`tests/apply.client.spec.ts`](../../../../packages/client/ui-layout/tests/apply.client.spec.ts) drives the real `main` slot registry through dispose and re-register, and `pnpm run test:gui` covers the package. Reverting `retainMainPanels` to its previous body turns the new store cases red and reproduces the loss in the browser probe; both runs are the counter-proof.