# @deepseek-ai/dsh-host-toolbox

Remote host endpoint for the browser developer toolbox: text translation (free
API + configured model) and UUID generation. The browser surface is
`@deepseek-ai/dsh-client-ui-toolbox`; this package is its data plane.

## Registration

Provides the `toolbox` Typert Remote namespace (`translate`, `uuid`), which the
client calls through `ctx.remote.toolbox.*`. The free-API engine reads the
`web` fetch service; the model engine reads `llm` and `agentDefaultModel`.

## Model Experience

- **translation·free** — a GET to a public translation endpoint, split on
  URL-encoded length. No model tokens consumed.
- **translation·model** — one auxiliary model call through the configured
  default model, capped at 4096 output tokens. Consumes model tokens.

Wire types are client-safe (plain JSON) and emitted by Typert into `./remote`.

## Known Limitations and Deferred Work

- Free translation relies on an unofficial public endpoint; availability is not
  guaranteed. The model engine is the fallback the UI steers to.
- The `web` fetch provider caps URLs at 2048; longer passages are split and
  re-joined, which can reorder sentence boundaries across the join.
