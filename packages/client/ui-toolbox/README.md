# @deepseek-ai/dsh-client-ui-toolbox

Web developer toolbox for the DeepSeek Harness GUI: a native sidebar footer
action above Settings that toggles a floating panel with eight tabbed widgets.

- **Sidebar trigger** — `sidebar.footer.action` entry: a full-width card above
  Settings in the wide column (🧰 icon + label) and icon-only on the 56px rail.
- **Panel** — `shell.overlay` entry with ten tabs: JSON format / minify /
  validate, time (timestamp ↔ date) conversion, regex matching with capture
  groups, Base64 encode / decode, URL encode / decode, text translation (free
  API + configured model), line diff with add / delete highlighting, UUID
  generation (v1 + v4), byte unit conversion (decimal & binary), and cron
  expression validation / description / next-run times.

The trigger and the panel share one `ToolboxUiController` open-state store
through the injected `hooks` compartment, so toggling from either side
converges the other. All copy is localized (zh/en); all colors are DSH theme
tokens. Translation and UUID go through the `toolbox` Remote namespace
(`@deepseek-ai/dsh-host-toolbox`); the remaining widgets compute in the browser.

## Model Experience

- **translation·free** — a GET to a public translation endpoint through
  `ctx.remote.toolbox.translate` with engine `api`. No model tokens consumed.
- **translation·model** — one auxiliary model call through the configured
  default model, capped at 4096 output tokens. Consumes model tokens; the UI
  steers large or high-quality needs here.
- All other widgets are pure client-side computation with no model effect.

#### KV Cache effect

None on the client surface; the host gateway owns any cache effect from a model
translation call.

## Known Limitations and Deferred Work

- **Free translation availability** — the public endpoint is unofficial and not
  guaranteed; the model engine is the fallback the UI steers to.
- **Diff is line-level only** — no word-level or character-level refinement.
- No persistent panel position or last-used tab across sessions.
