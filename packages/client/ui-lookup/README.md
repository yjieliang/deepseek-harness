# @deepseek-ai/dsh-client-ui-lookup

Web word-lookup feature: select a word anywhere in the app (the conversation is the primary surface), get a floating action bar at the selection end, and open a result card with translation, English dictionary meanings, and an encyclopedia introduction. The model-generated detailed explanation rides the `lookupLlm` Remote namespace mounted by api-remotes; the free dictionary sources (MyMemory translation, Free Dictionary API, Wikipedia REST summary) are fetched directly from the browser and never touch a model.

The overlay registers one entry in the layout-declared `shell.overlay` frame-wide layer, so it composes through the slot system with no changes to ui-conversation or any other package. Selection handling is document-level (mouseup, Escape, scroll-to-dismiss), all state is component-local, and the explanation call arrives through the inject face over the caller's ctx.

## Model Experience

Indirectly, through the `lookupLlm/explain` Remote, the explanation button triggers one model request that [`@deepseek-ai/dsh-host-lookup-llm`](../../host/lookup-llm/README.md) owns, including its token cost and prompt; the browser-side dictionary fetches never reach a model.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Free-source quality varies** — MyMemory and the Free Dictionary API are unauthenticated free endpoints; Chinese-word coverage is thin and translations can be literal. The model explanation is the quality fallback.
- **The explanation call is not session-logged** — the auxiliary LLM call is user-initiated UI output, not model-visible conversation input, so it appends no session events; a deployment that wants full audit trails can extend the endpoint to log to the current session.
- **Per-file coverage is below the CI gate** — the DOM-heavy branches of the overlay need additional specs before `test:coverage` is green.
