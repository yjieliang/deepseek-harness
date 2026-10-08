# Requirement board REAL-composition channel

Non-unit test channel for the `dsh-requirement-board` Host plugin, required by
[`packages/AGENTS.md`](../../../../packages/AGENTS.md): a product-visible plugin
must boot a test-only `cordis.yml` through the Loader and the app/process, mock
only external or nondeterministic inputs, and assert model-visible, durable, or
user-visible output. Hand-built `ctx.plugin(...)` suites do not satisfy it.

## Run

From the checkout root (about 60–80 s: five child boots, each boot ≈10 s):

```sh
node --import tsx/esm .artifacts/requirement-board/tests/loader.mjs
```

`--import tsx/esm` resolves the driver's workspace imports through the
repository tsconfig `paths` map, because this artifact directory is not a pnpm
workspace member — the same source-launch contract the shipped packages use.

`tests/loader.mjs` is the only supported entry. It owns one temporary directory
per scenario through `@deepseek-ai/dsh-loader-smoke`, spawns
`tests/composition/driver.mjs` per scenario, and asserts the driver's
`report.json`.

The driver also runs standalone, printing the same cases for its own scenario
and exiting non-zero when a hard case fails:

```sh
RB_BOARD_STORAGE_ROOT=/tmp/rb-storage node --import tsx/esm \
  .artifacts/requirement-board/tests/composition/driver.mjs \
  .artifacts/requirement-board/tests/composition/cordis.yml happy
```

The runner sets `RB_BOARD_COMPOSITION_CHILD=1` for its children, so they always
exit zero: the runner keeps the verdict, and it needs the recorded report even
when a case fails.

## Files

| Path | Role |
| --- | --- |
| `cordis.yml` | The test-only composition: real `dsh-system-prompt`, real `dsh-tools`, the real storage stack (`dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`), the `webServer` stub, the two session/preset stubs, one preset realm carrying the real `role.js`, and the board plugin loaded from `../../index.js`. |
| `stub-web-server.mjs` | Substituted service: provides `webServer`, records route registrations, and returns the same disposer a real server returns. Binds no port. |
| `stub-agent-registry.mjs` | Substituted service: provides `agents` over the roster in `RB_BOARD_STUB_AGENTS`, so the role chain runs without creating a session. |
| `stub-preset-registry.mjs` | Substituted service: provides `agentPresets` and reads the declaration through the realm-scoped `ctx.get('requirementBoardRole')`, the arrangement a real preset group has. |
| `throwing-agent-listener.mjs` | The negative control: a plugin that lets an error escape a `agent/created` listener. |
| `cases.mjs` | The assertion cases, shared by the runner and the driver so their two views cannot drift. Also owns the stage-A1 flag. |
| `driver.mjs` | Boots one config through `boot()`, records observations in `report.json`, injects the scenario faults, and prints its scenario's cases. |
| `../loader.mjs` | The runner: scenario worlds, child-process isolation, aggregate assertions, and the exit code. |

Relative entry names resolve beside the config file, because app-boot sets the
Loader base URL to the config directory. Bare names would not resolve here: the
artifact directory has no `node_modules`, and the repository root only exposes a
subset of the workspace packages.

## The role chain

The preset-side role declaration is a real Loader row, and the two services the
board reads it through are process-owned inputs, so the composition substitutes
only those:

- `stub-agent-registry.mjs` provides `agents` from `RB_BOARD_STUB_AGENTS`; the
  runner seeds `sess-art` (preset `art`), `sess-standard` (preset `standard`) and
  `sess-ghost` (preset `ghost-preset`), and the driver dispatches the real
  `agent/created` event for whichever of them the case needs. No session is
  created.
- `cordis:group` with `isolate: { requirementBoardRole: true }` holds two rows:
  the real `../../role.js` declaring `{ roleId: art, roleName: Art Director,
  duties: [...] }`, and `stub-preset-registry.mjs`, whose `serviceFor` reads that
  declaration through the realm-scoped `ctx.get('requirementBoardRole')` while
  publishing `agentPresets` process-wide. That is the arrangement a real preset
  group has: provider and consumer share one realm, and the registry itself stays
  visible to the root. `packages/preset/agent-preset-registry/README.md` states
  the rule; an unisolated declaration publishes process-wide and the registry
  reports the preset as broken.

The `role-resolution` scenario asserts the entire chain through public surfaces:
the real tool table's `requirement_role` schema, the real
`ctx.systemPrompt.assemble({ scope })` text, the tool's own `list` result, and the
board domain's `domain/changed` frames.

## The storage route

The board requires `tools` and `storageDomain`; `systemPrompt` and `webServer`
stay optional. The composition therefore mounts the platform stack the shipped
profile mounts, and the board's data form is a domain, not a file path:

- `dsh-storage` provides the hub, `dsh-storage-json` registers the backend named
  `json`, and `dsh-storage-domain` provides `storageDomain` with
  `routes.requirement_board = json`.
- **The route key is the domain name `requirement_board`** (underscore). Domain
  and unit names must match `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`), so a
  hyphenated key would not match and would silently fall back to the default
  `backend` route instead of failing. The channel's routing-key evidence is the
  medium itself: the JSON `single` layout writes `<storage root>/requirement_board.json`,
  and the channel asserts that exact file, the hub's registered backend names,
  and `storageDomain.get('requirement_board')` being open.
- The board row's `config` no longer carries `dataDir`/`documentPath`; that
  choice belongs to the route. The composition keeps only the validated row
  options (`defaultTemplateId`, `stallAfterHours`, `promptContext`,
  `promptMaxItems`, `http`, `importLegacy: false`).

## Precedent

| Precedent | What this channel takes from it |
| --- | --- |
| `packages/shell/tool-pwsh/tests/loader.spec.ts` + `tests/fixtures/loader/{cordis.yml,driver.ts}` | Shape: a checked-in fixture composition plus a driver, launched through the Loader in a child process. |
| `packages/webhook/webhook-github/tests/loader-composition.spec.ts` | Substituting a process-owned service (`webServer`) with a local provider instead of the real one. |
| `packages/test-support/loader-smoke` | Process harness: isolated cwd, `DSH_HOME`/`DSH_AGENTS_HOME` inside that cwd, cleared proxy environment, timeout, and `inspect(cwd)` after a zero exit. |
| `packages/storage/storage-domain/src/index.ts` | The routing contract this channel configures: `backend` is the default, `routes` overrides per domain name, and an unregistered backend name fails the open with `backend-not-found`. |

## Guarantees

- **No network.** The composition mounts no provider and no MCP connection, and
  loader-smoke clears the proxy environment before spawning.
- **No HTTP listener.** `web-server-stub` records registrations; nothing binds.
- **No Harness-home writes.** The driver refuses to boot without
  `RB_BOARD_STORAGE_ROOT`, and the runner points it at a temporary directory it
  removes afterwards, so the JSON backend writes only inside that directory.
  loader-smoke also redirects `DSH_HOME` and `DSH_AGENTS_HOME` into the same
  isolated cwd.
- **No session.** The role chain runs on the seeded stub roster and a local
  `agent/created` dispatch; the composition starts no agent and writes nothing to
  a session store.
- **No source edits.** The channel reads `index.js`, `role.js` and the workspace
  packages; it writes only into the runner's temporary directory.

## Scenarios and cases

`happy` — the healthy composition (17 hard assertions):

1. boot resolves; the `requirement-board` entry activates through the Loader.
2. the real tool registry assembles `requirement_board` and `flow_template`.
3. the board tool creates a requirement, and the rendered result names it.
4. the requirement_board domain opened through the real storage stack (backend
   list `['json']`), and the unit file
   `<storage root>/requirement_board.json` carries the new requirement
   (durable, user-visible output).
5. the prompt context provider is evaluated and carries the live board, read
   back through real `ctx.systemPrompt.assemble()` (model-visible output).
6. the browser route registers as the `prefix` route `/api/requirement-board`
   with a handler.
7. disposing the tree unregisters both tools **and** removes the route
   registration — registry contributions prove disposal.
8. no warn or error is logged; the logger capture path is proven to work; the
   child wrote no unexpected stderr.

`throwing-store` — the 建档 write failure (11 hard assertions):

1. the fault reached the medium: a directory occupies the unit path after the
   domain opened, so the JSON backend's atomic rename over it fails (hard).
2. the failure reaches the tool as an error naming `requirement_board.json`, the
   board stays mounted, and a local `agent/created` serial dispatch does not
   reject (hard).
3. nothing warned before that dispatch (observed before the dispatch, not from
   the final logger contents).
4. **stage A1**: an `agent/created` dispatch of a resolvable agent survives the
   failing role write, and the contained failure logs exactly one warn naming the
   session it ignored (`requirement-board: registering the role of session
   "sess-art" failed and was ignored so the session is still created: …`).

`broken-storage` — the mount-time failure that must be loud
(`LEAD-DECISIONS.md` D11), all hard:

1. boot resolves under the Loader's optional-entry policy, with a file where the
   JSON backend's root must be.
2. the entry ends **failed** — not `active` with an empty tool table, and not
   `pending` — with the storage error
   (`EEXIST: file already exists, mkdir '<storage root>'`) carried in the entry's
   error and no half-open domain.
3. the failure is settled, not a silent wait: the mount probe reports
   `entryFailed: true`/`timedOut: false` with no polling.
4. the Loader reports it: stderr carries
   `warning: 1 entry did not activate` and
   `requirement-board (../../index.js): …EEXIST…`, and the Cordis logger records
   the same error.
5. nothing half-registered: neither the tools nor the route.

`role-resolution` — the end-to-end role chain, 14 hard assertions: boot and
activation; `requirement_role` in the real tool table; the declared preset's role
established through `agent/created` with its two declared duties; the declaration
invisible to the root realm; the real prompt assembly naming
`You are role "art" (Art Director)` with a duty; an undeclared preset falling back
to its preset id with `no duties recorded` and `dutiesMissing`; an id in use but
unrecorded reported in `list().unregistered` with one online holder and no stored
row; an identical second establishment producing **zero** `domain/changed` frames;
the global assembly carrying no role line; the tool schema exposing only
`action: ['list']`; a non-`list` action refused by the tool; and no warn or error
from the healthy chain.

`uncontained-listener` — the negative control. A throwing `agent/created`
listener must reject the serial dispatch with its own message, must leave the
board tool registered, and must leave the entry active. This is the case that
proves the channel detects an uncontained failure; if it ever passed as
contained, the containment assertions above would prove nothing.

## Stage gates

`A1_STORE_CONTAINMENT_LANDED` at the top of `cases.mjs` gates only the stage-A1
cases above; it is `true` as of 2026-10-04, when stage A1 landed, and both the
standalone driver and the runner now assert the containment hard. Flip it back to
`false` only if that stage is rolled back: the channel then returns to
`36/36 … (stage A1 containment checks are pending)` instead of failing.

The D11 cases are hard and carry no flag: awaiting the storage open inside the
plugin's `apply` is stage-0 behaviour, so a storage failure must already fail the
entry loudly.

## What the channel catches

The `broken-storage` scenario is the negative control for D11, and its two
shapes are what the channel tells apart:

| Storage configuration | Observed | Channel |
| --- | --- | --- |
| Root path cannot be created (this scenario) | entry `failed`, `EEXIST` with the path and the full `JsonStorageBackend.openUnit` → `DomainFacility.open` → `index.js` apply stack, `timedOut: false`, stderr `warning: 1 entry did not activate` + detail, logger error record | all green |
| Route names an unregistered backend | `storage-domain` never mounts; the board stays `pending (waiting for service: storageDomain)` for the whole 20 s probe, `timedOut: true`, no error, no logger record | 3 `FAIL`, exit 1 |

The second row is the deliberate break used to prove the channel can go red.
Reproduce it by changing `storage-domain.config.routes.requirement_board` to an
unregistered name (for example `missing-backend`) in `cordis.yml` and running the
standalone driver with scenario `broken-storage`:

```
  FAIL    the medium failure fails the entry instead of leaving it active — {"entry":{…,"state":"pending"},"mount":{"mounted":false,"waitedMs":20007,"timedOut":true,"entryState":"pending"}}
  FAIL    the failure is reported as a settled failure, not a silent wait — {"mounted":false,"waitedMs":20007,"timedOut":true,"entryState":"pending"}
  FAIL    the entry failure carries the storage error and no half-open domain — {"error":null,"domainOpen":false}
  ok      the Loader reports the activation failure with its detail
  ok      the failed activation registered nothing
exit=1
```

That is the Cordis shape worth knowing: a missing dependency is `pending`
(waiting for a service, named in the activation report), while a rejected
`apply` is `failed` with the original error. D11 requires the second shape, and
the channel asserts the distinction rather than only the absence of tools.

## Recorded lifecycle facts

- **Activation is awaited.** The board's `apply` awaits `storageDomain.open` and
  the bootstrap, so the Loader settles only after the board exists: a healthy
  boot reports `waitedMs: 0`, and a failing open fails the entry instead of
  leaving an active shell behind. This is the deliberate contrast with an
  activation that puts the same work inside a `ctx.effect` body: a rejection
  there is swallowed (`vendor/cordis/src/fiber.ts`, the `task?.catch()` that only
  re-logs if its own teardown fails), and the entry would stay `active` with no
  tools. The driver still polls the real tool table as a safety net and records
  the elapsed wait, so a future regression back to an un-awaited mount shows up
  as a recorded fact rather than a flake.
- **The write fault is injected after open, at the medium.** The JSON backend
  publishes each write through a random temp name, so no pre-boot poison can
  reach the write path without also breaking the open. The driver therefore
  replaces the unit file with a directory once the domain is open; the atomic
  rename over it fails on every platform while the in-memory board stays
  mounted.

## Observed output

Last run on 2026-10-04 02:2x, with stage A1 landed and the A1 gate flipped, the
runner printed `53/53 checks passed` and exited 0 after five child boots — 17
happy, 11 throwing-store, 7 broken-storage, 15 role-resolution (14 cases plus the
runner's stderr check) and 3 uncontained-listener. The same run was repeated
after the peer's `host/**` edits of 02:16–02:20 and stayed `53/53`; both hash sets
are recorded in `tests/verification/A1-verification.md`. The standalone
`broken-storage` driver printed 6 `ok` lines and exited 0; the deliberate route
break above printed 3 `FAIL` lines and exited 1.

Residual risks: the channel asserts the route registration, not an HTTP round
trip (no listener is bound by design); it does not cover the client plugin,
whose behaviour belongs to the client-side suite; the storage medium is the real
JSON backend but only its `single` layout is exercised; the storage root is
supplied by the runner rather than read from user settings; and the role chain's
session registry is a stub, so agent identity beyond `id`/`status`/`presetId` is
not modelled.
