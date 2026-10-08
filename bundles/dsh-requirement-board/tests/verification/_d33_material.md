# D33 material — route A (platform primitives) evidence

Facts only, no polished prose. Owner of the note is the Lead; this file is the input.

## 1. Route A slice list

Slice 1 (owner-run, not this session): dialog chrome → `Modal`. Outcome: every dialog renders
`role="dialog"` with `rb-dialog` / `rb-dialog-wide`; the panel gate was 7/7 at hand-off.

Slice 2 (this session): `rb-btn*` → `Button`. 44 call sites. Variants: primary 11, outline (danger)
9, ghost 24. Sizes: sm 26, default md 18. `type="button"` dropped (the primitive owns it);
`name` / `disabled` / `title` / `aria-*` / `key` preserved because tests and probes select by `name`.
3 `h('button')` sites were out of scope at the time: the flow node box, the `.rb-view` tab (converted
in slice 4), and the `.rb-card-title` card header (still a plain button, it is a card-wide click
target, not a control).
CSS: deleted `.rb-btn`, `:hover`, `[disabled]`, `.rb-btn-primary`, `.rb-btn-primary:hover`,
`.rb-btn-sm` (7 rules); kept one override, later rewritten to `.rb-btn-danger.rb-btn-danger` because
a single class only beat the primitive's `outline` variant by stylesheet order.
`font-weight:600` → `500` at 5 sites.
client-smoke: the loader shim returned `React` for **every** require, so every primitive was
`undefined` and `h(undefined, …)` degraded to a fragment — 277 checks were green without ever
rendering a primitive. Replaced with a `createPrimitives(React)` stand-in and a `clientRequire` that
serves only `react` and the primitives specifier. 1 assertion rewritten: the page no longer registers
a `document` keydown listener (Modal owns Escape), so `closing a dialog removes its key listener`
became `no page-level key listener is left behind: the Modal primitive owns Escape`.
Browser: gate 7/7 → 10/10 after adding the danger-contract pair; screenshots
`_ui_slice2-{board,queue,decisions,dialog-new-requirement,dialog-new-template,dialog-roles}.png`,
`_panel_render.png`.

Slice 3 (this session): `rb-badge*` → `Tag`. 25 sites: 23 through a replacement table, 2 more found
only by that table's "must match exactly once" assertion (they were ternary classNames,
`className: claimableAnswer === true ? 'rb-badge-take' : ''`, which a manual class-name inventory
missed). Tone distribution after the owner's correction: outline 9, warning 6, info 6, success 4
(the running counter is success by the owner's ruling — "executing" is a healthy, active state),
danger 1, plus two inline maps: `STATUS_TONES` (active→info, blocked→danger, done→success,
archived→neutral) and `PRIORITY_TONES` (high/urgent→warning).
`Tag` accepts only `tone` / `className` / `children` — no rest. 9 badges carry a tooltip and were
wrapped in `<span title>`: RoleBadge, KindBadge, ReservedBadge, DelegatedBadge, GatedBadge,
BlocksBadge, CriticalBadge, claimable, advanceable. Per-site check of dropped rest props: the only
other prop at those sites was `key`, which React consumes before the component sees it, so nothing
but `title` needed the wrapper.
CSS: deleted 20 `.rb-badge*` rules; kept `.rb-badge-group` (an inline-flex layout container, not a
badge).
client-smoke, 5 groups, all re-anchored on `data-tone` / `title` instead of class names: added
`tags(page)` and `titledBadgeWithText(page, text)`, rewrote `badgeWithText`, replaced the two
`rb-badge-head` head-mark filters with `data-tone === 'info' && html === queueNext`, pointed the
eligibility tooltip assertion at the wrapper, and replaced the `/rb-badge-(gated|critical)/` check
with a semantic one (no wrapper titled `blockedByTitle…`, no Tag text containing `criticalTag`).
277/277. Browser: gate 10/10, probe 0 errors, `legacyBadgeClasses: []`, 8 live Tags in the roles
dialog; screenshots `_ui_slice3-*.png`.

Slice 4 (this session): view tabs → `Pill` (1), inline filter checkbox → `Checkbox` (1), connection
dot → `StateDot` (1), toast banner → `Toast` (1), plain text inputs → `Input` (15).
CSS: merged `.rb-input` out of the shared field rule and aligned the two elements that genuinely
stay native (`.rb-select`, `.rb-textarea`) to the Input primitive's frame — `.5px` `--dsw-alias-border-l4`
border, `--dsw-radius-md`, height 32, 14px/22px, `--dsw-alias-label-dimmed` placeholder,
`--dsw-alias-state-business-primary` focus border. Added `.rb-ink-success` / `.rb-ink-info` for the
two detail values that must read as coloured text, not as pills. Deleted `.rb-dot`, `.rb-dot-live`,
`.rb-check-inline`, `.rb-view`, `.rb-view-active`, and the five `.rb-toast*` rules (the last carried
the file's only literal colour, `rgba(0,0,0,.28)`); kept `.rb-views` (the tablist container).
client-smoke: rewrote the toast stand-in to mirror the real DOM (role="alert", the
`--dsh-toast-hold` inline custom property, the success glyph span) and re-anchored 4 checks on it;
the dismissal-button assertion became "an alert region that owns no dismissal control"; added one
check that a refusal carries the long hold. 278/278. Browser: gate 10/10, probe 0 errors,
`tabClass: _pill_1bqmh_1 _interactive_1bqmh_16`, `checkboxClass: _checkbox_1wz3s_1`,
`stateDotValue: done`, 2 of 3 inputs inside a `_wrap_` Input, `legacyControlClasses: []`.

## 2. Three same-type test-integrity failures

| | real contract | how the stand-in lied | proven consequence |
|---|---|---|---|
| D26 | a connection's state comes from the transport | fake connection returned the same success shape for every call | the suite could not distinguish a live transport from a dead one |
| D32 | a renderer's output is the rendered tree | fake renderer shared the wrong contract with the code under test | rendering regressions stayed green |
| slice 2 (this) | `Modal`/`Button`/`Tag`/… exist as components with their own DOM | the loader returned `React` for every module specifier, so all 8 primitives were `undefined` and degraded to fragments | 277 checks passed while nothing primitive was ever rendered; slice 1's "green" had the same hole |

Shared mechanism: a fake that keeps the *shape* of the real thing but not its behaviour makes every
assertion about that behaviour vacuously true. Countermeasure used here: the stand-in reproduces only
DOM the real component really emits (`type="button"`, `data-tone`, `data-state`, `role="dialog"`,
`role="alert"`, the `--dsh-toast-hold` custom property) and invents nothing (no `data-variant`, no
`data-size`), and style claims are asserted in the browser gate against real computed values.

## 3. Forced retention and semantic changes

- `Tag` has no `title` and no rest props → 9 tooltips moved to a wrapping `<span title>`.
- `Tag` tones changed one colour: nothing else. `-run` was green in the old CSS; the owner's mapping
  table listed it as `info`, this session applied `info`, and the owner corrected it back to
  `success` ("executing" is healthy/active). Final state: success.
- `Button` has no danger variant (only primary/ghost/outline/toolbar) → outlined variant plus a local
  token override, now `.rb-btn-danger.rb-btn-danger` (specificity, not stylesheet order; no ancestor
  selector, so it also holds inside the Modal's body portal). Asserted in the browser gate against
  `--dsw-alias-state-error-primary` (`rgb(236, 19, 19)` in both).
- Detail kv values (`claimableAnswer` / `advanceableAnswer`) were never badges — they carried a tone
  token without the base badge class, so the old rendering was coloured text. Migrated to plain
  `<span>` with `.rb-ink-success` / `.rb-ink-info`.
- `Toast` has no dismissal control and `tone` accepts only `'success'`. Consequences: the visible ×
  button is gone (the primitive fades itself and reports through `onDone`, so `dismissToast` survives
  as that callback); a refusal can no longer be red — it keeps the neutral icon seat and the long
  8000 ms hold; placement moved from bottom-centre (`.rb-toast`, fixed) to the primitive's
  top-centre. `dismiss` was removed from both locale blocks in `client.js`.
- `Checkbox` accepts no rest → the filter checkbox lost its `name` attribute. Grep confirmed no test
  or probe selected it by name.
- `StateDot` is 10px for solid states where the old dot was 7px; the platform default was kept.
- Kept as layout containers, not controls: `.rb-views`, `.rb-badge-group`.
- `.rb-select` / `.rb-textarea` stay native elements (no primitive exists for either) and are
  aligned to the Input frame with tokens only.

## 4. Traps this session hit that the plan did not anticipate

- A replacement table that requires "exactly one match" per site found 2 badge sites a manual
  class-name inventory had missed (ternary class names). Mechanical uniqueness assertions beat a
  human list; a blind regex would have rewritten one and silently skipped the other.
- The stylesheet lives inside a JS template literal: a backtick or `${` inside a CSS comment
  terminates the string and breaks the whole module (`SyntaxError: Unexpected identifier 'Button'`).
- `.rb-toast` positioned itself; the platform Toast portals to `body` and centres at the top, so any
  screenshot comparison of the banner's position is expected to differ.
- Test/probe JSON written without a trailing LF fails the hygiene gate ("N text files end with
  exactly one LF"); the probe scripts now append one.
- Playwright `getByRole('button', { name })` with `.first()` matched a hidden button and waited out
  the 30 s actionability timeout; `button:visible` plus the exact label («新建流程模板», not
  «新流程模板») fixed it.
- `.NET [System.IO.File]::ReadAllText` resolves relative paths against the process working directory,
  not PowerShell's location — the fix is an absolute path.
