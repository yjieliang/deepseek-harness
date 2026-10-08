# A3 independent verification — locks, soft reservations, and the two claimable readings

- **Task**: task-12 · V4：独立验证 A3（flake 压力证明 / 队列 / 自动放锁 / 可接手池两口径）
- **Verifier**: `composition-verifier` (not the author of the A3 implementation)
- **Author under review**: `storage-migration`
- **Subject**: `.artifacts/requirement-board` — the lock/queue/dispatch half of `ROLE-DISPATCH.md` (§5.2–§6, §9-A3)
- **Date**: 2026-10-04, 03:05–03:25 (+08:00)
- **Write scope used**: `.artifacts/requirement-board/tests/verification/**` only. **Not one line of the implementation was changed** (`host/**`, `index.js`, `client.js`, `locale/**`, the author's suites, `dev.overlay.yml`, `package.json`, `cordis.patch.yml` all untouched by me).

## 0. Verdict summary

| # | Attack direction | Verdict |
|---|---|---|
| 1 | flake per-class clock audit (`nowIso`/`Date.now`/`new Date`) | **证实** — every write chain reads the clock once and threads that instant; no intra-chain second read remains |
| 2 | 45-run stress loop (dispatch 20× + 5 suites ×5) | **证实** — 20/20 dispatch green, 0 failures in 45 runs except the peer's mid-loop suite rewrite (§5) |
| 3 | nine query params through a real handler + negative controls | **证实** — all nine really change the result set; pre-fix behaviour is red under `RB_A3_RED=1` |
| 4 | `claimable` two modes, three-way same source | **证实** — route ≡ formula ≡ prompt section ≡ command dispatcher |
| 5 | soft reservation "nothing happened" | **证实** — only queue-row writes, zero requirement-row writes, `lock === null` |
| 6 | queue-head hint / `details.queued` reachability | **证实** — the author's "unreachable except by fixture" admission is correct; the hint that *is* reachable does arrive |
| + | `complete` same-write release, `disposeSession` orphan intake | **证实** |
| + | old flake reproduction (mutation test) | **证实** — the two-read shape reproduces the class of failure; shipped version 0/200 |

Nothing in the author's A3 claims was falsified. Three findings are recorded in §7 as cross-task items for the Lead; none is an A3 defect.

## 1. Revisions under test (the tree moved while I verified)

The peer (`storage-migration`) was landing stage B in `host/**` and in the author's suites throughout this verification, so every result below is tied to a digest of `index.js` + `host/*.js` (`index-config-dispatch-domain-flow-http-model-roles-service-templates-tools`, truncated SHA256, 8 hex each):

| Revision | Digest | What moved |
|---|---|---|
| **R0** | `3602AB62-3F22818C-84E93142-E71D5D57-ADB8A852-35A896A5-D318E9A5-43A3D28E-33785851-3F71A501-00C6FBC0` | A3 as handed to me (recon baseline, 03:06) |
| **R1** | `3602AB62-3F22818C-84E93142-43717F12-ADB8A852-35A896A5-9DA09BD3-241702E4-77C05E54-3F71A501-00C6FBC0` | B lands `domain.js`, `model.js`, `roles.js`, `service.js` (03:11–03:15) |
| **R2** | `C5882B5A-3F22818C-84E93142-43717F12-ADB8A852-2574BCD8-9DA09BD3-AD36B81B-95B4F31A-3F71A501-6E11CEAF` | B lands `index.js`, `http.js`, `roles.js`, `service.js`, `tools.js`; one digest for all 45 loop-2 runs |
| **R2′** | `…-AD36B81B-E575F179-3F71A501-…` (`service.js` moved twice more) | peer edits during my final passes |

The 45-run loop recorded its digest **before and after every single run**: all 45 runs show `hash=stable` on R2 (raw log in `_a3_loop2.txt`). The final six-suite pass (§5) is bracketed by R2 and R2′.

## 2. Instruments I wrote (all independent of the author's suites)

| File | What it does | Result |
|---|---|---|
| `tests/verification/a3-chain.mjs` | Real `RequirementService` (json+sqlite) + **real `createBoardHandler` route** + the exported `claimable()`/`lockState()` applied by me to raw records. Sections: nine query params + controls [1], two claimable modes + prompt section [2], `complete` release [3]/[3b], queue soft reservation with `domain/changed` frame counting [4]/[4b], hint reachability [5], disposal orphans [6] | **90/90 json, 90/90 sqlite, exit 0** (`_a3_chain_json.txt`, `_a3_chain_sqlite.txt`) |
| `tests/verification/a3-clock.mjs` | Replaces `globalThis.Date` with a strictly advancing fake (+250 ms per read) and counts no-argument `Date` reads per public action; asserts every stamp a chain writes is that chain's one instant | **30/30 json, 30/30 sqlite, exit 0** |
| `tests/verification/a3-mutation.mjs` | Mutation test: same 200 claims against the shipped `service.js` and against a verification-only copy whose `renewedLock` reads the clock a second time | shipped **0/200** mismatches; mutated copy **20/200 (10.00 %)**, max skew 1 ms |

Run form (from the repository root):

```powershell
$env:TSX_TSCONFIG_PATH = 'C:\code\deepseek-harness\tsconfig.json'
node --import tsx/esm .artifacts/requirement-board/tests/verification/a3-chain.mjs
```

`RB_A3_BACKEND=sqlite` switches backend, `RB_A3_RED=1` asserts the **pre-fix** behaviour (so the run must go red).

## 3. Item 1 — flake per-class clock audit

### 3.1 Every clock read in `host/**`, with its conclusion

Full grep of `nowIso|Date.now|new Date(` over `host/**` (45 hits; `import` lines excluded). Conclusion per class:

| Site class | Sites | Conclusion |
|---|---|---|
| Definition | `model.js:100-102` (`nowIso = new Date().toISOString()`) | The single wall-clock source. No module captures a `Date` reference, which is why my fake clock works. |
| Public write methods, one read each | `service.js` `const at = nowIso()` at the head of `createRequirement`, `claim`, `release`, `queue`, `unqueue`, `disposeSession`, `updateRequirement`, `transitionRequirement`, `setChecklist`, `blockRequirement`, `unblockRequirement`, `setArchived`, `createTemplate`, `deleteTemplate`, plus B's new `#revokeDelegation`; `roles.js:138` `establish`, `roles.js:161` `put` | **One read per chain.** Every one of them passes `at` down; the call sites of `#mutateRequirement` all pass it, and the `at = nowIso()` default at `service.js:517` is never reached on a service write path. Confirmed mechanically in §3.3. |
| Helper defaults (only for callers that omit `at`) | `service.js:517` `#mutateRequirement`, `flow.js:109` `applyTransition`, `flow.js:227` `setChecklistEntry`, `templates.js:137` `normalizeTemplate`, `dispatch.js:75/106/163` `lockState`/`claimable`/`judgeClaim` | Defaults are read-only helpers; the service passes `at`/`now` explicitly. `judgeClaim` receives `now: at` from `claim`, so the lock decision and the stored stamps share one instant. |
| **Separate writes, one read per row** | `service.js:~450` `#releaseReservation` (reads its own `at` per removed row); `roles.js:329` sweep queue rewrite (`updatedAt: nowIso()` per rewritten row) | Each is its **own row write**, not part of the requirement commit. No equality between them and the requirement's `at` is expected or asserted. Measured: completing a requirement that has a live reservation costs **2 reads** (transition + queue cleanup) and the requirement record's stamps still all equal the transition's instant (§3.3). |
| Not a write chain | `domain.js:340/361` (legacy import/export document), `http.js:100` (SSE heartbeat), `model.js:203-204` (`new Date(from/to)` parsing caller-supplied instants), `service.js:1602` `options.now ?? nowIso()` (stats), `service.js:1633` `changesSince` window, `service.js:1661` `snapshot.generatedAt`, `flow.js:252` `computeStats({now})` | Read-only projections or non-stamp timers. `service.js:1602` is the one place a caller may inject `now`; `snapshot` reads once per call. |

### 3.2 Why the fake clock makes the old class of bug visible

`a3-clock.mjs` replaces `Date` before the service runs: each no-argument read advances 250 ms, so a chain that reads twice can no longer produce an equal value by landing in the same millisecond — the pre-fix race becomes a deterministic jump. Per-action read counts and stamp equality (raw: `30/30`):

```
[0] creating a requirement reads the clock once                    ok  (1)
[1] claim reads the clock once                                     ok  (1)
    claim stamps the lock, the record and the history with one instant   ok
    a repeated claim reads once and moves only the touch instant   ok  (lock.at preserved by design; touchedAt/updatedAt = renewal instant)
[1] update reads the clock once                                    ok  (1)  updatedAt == lock.touchedAt == at
[1] queue reads the clock once                                     ok  (1)  item.at == row.updatedAt == at
[1] an idempotent append reads nothing                             ok  (0)
[1] checklist / block / unblock / transition / reopen / archive / restore   ok  (1 each, every stamp == at)
[1] completing a requirement with a live reservation reads once per write, not once per stamp   ok (2)
[1] disposing a session reads the clock once                       ok  (1)
[1] delete reads no clock: it stamps nothing                       ok  (0)
[2] no stamp on the record is later than the lock instant it was claimed at   ok
```

`lock.at` is the *take* instant and deliberately survives a renewal; `touchedAt`/`updatedAt` carry the renewing chain's instant. That distinction is what the pre-fix code broke for a **fresh** claim (it re-stamped `touchedAt` from a second read after `newLock(..., at)`).

### 3.3 Mutation test: reproducing the old flake, quantified

Repository has no git history for `.artifacts/` (gitignored), so I reproduced the pre-fix shape in a **verification-only copy**: `tests/verification/_red-copy/` = a byte copy of `host/*.js` with `dispatch.js` `renewedLock` changed back to a second `nowIso()` (the copy has been deleted again; the recipe is: copy `host/*.js` into `tests/verification/_red-copy/`, change `return { ...lock, touchedAt: at }` to `touchedAt: nowIso()`, then run `a3-mutation.mjs` with `RB_A3_SERVICE=./_red-copy/service.js`).

```
service under test: ../../host/service.js on json, 200 claims on the real clock
  lock.touchedAt !== lock.at            : 0/200 (0.00%)
  lock.touchedAt !== updatedAt          : 0/200 (0.00%)
  lock.touchedAt !== history entry time : 0/200 (0.00%)
exit=0

service under test: ./_red-copy/service.js on json, 200 claims on the real clock
  lock.touchedAt !== lock.at            : 20/200 (10.00%), largest skew 1 ms
  lock.touchedAt !== updatedAt          : 20/200 (10.00%)
  lock.touchedAt !== history entry time : 20/200 (10.00%)
exit=0
```

So: one extra read inside one write chain reproduces the intermittent failure class at a measured **10 % per claim** on this machine (the author's suite failure rate was reported at 1/3–1/5; the per-claim probability depends on comparison count and timer granularity, the mechanism is the same), while the shipped version is **0/200**.

## 4. Items 3–5 — query params, two claimable modes, soft reservation, auto-release

Raw sections (json; sqlite identical): `_a3_chain_json.txt`.

### 4.1 Nine query parameters through the real route handler (`createBoardHandler`)

All assertions passed (17-row table; each row asserts the *exact* result set, not just a size change):

```
owner=ann → 3 rows; owner=nobody → 0; status=done → the done one; status=open → the rest;
priority=high/low; templateId=tpl-one vs tpl-standard; query=美术 → the two art titles; query=zzz → 0;
session=ses_B → the two joined; session=ses_nobody → 0;
me=ses_A without claimable → unfiltered (17 checks total, all ok)
claimable=true (panel pool) / claimable=true&me=ses_eng / claimable=true&me=ses_art  (ok)
an out-of-enum filter fails loud instead of being ignored                ok  (409 invalid-argument)
a non-boolean claimable fails loud instead of reading as false           ok  (409 invalid-argument)
limit caps the page and reports the filtered total                       ok
offset moves the page without changing the total                         ok
the command dispatcher agrees with the route handler                     ok
```

The `claimable=1` → `409 invalid-argument` row is worth naming: the wire accepts only `true`/`false`, so a client sending `1` gets a loud refusal rather than a silently unfiltered board.

**Red evidence (A2 `pick()` → `query()` fix).** With `RB_A3_RED=1` the script asserts the *pre-fix* behaviour (every parameter inert). The run goes red on exactly those two assertions:

```
  FAIL RED CONTROL: a filter is ignored (pre-fix behaviour) — got 0 of 5
  FAIL RED CONTROL: claimable is ignored for a session (pre-fix behaviour) — got req_787be8af3f,req_ce014dacc9,req_e6c4e7b78d
76/78 checks passed on the json backend (RED CONTROL run)
red exit=1
```

Also red-making: `a3-clock.mjs` `RB_A3_RED=1` asserts a two-read chain and fails on the shipped build (`30/32`, `exit=1`), printing the real lock `{at, touchedAt}` equal to each other — i.e. the RED output itself demonstrates the single read.

### 4.2 `claimable` two modes, three ways of computing it

Same source, three consumers compared on the same state (one requirement locked by another session, one reserved by another session, one done, one archived, one free and role-routed to `art`):

```
panel pool (no me) == formula over raw records                          ok  (panel: free role-routed requirement present)
session without the role: not present, and == formula                   ok
session with the role:    present, and == formula                       ok
the eng prompt offers no requirement it cannot take                     ok  (Claimable section empty)
the art prompt offers exactly the routed requirement                    ok
the prompt section agrees with the route and the formula                ok
the panel prompt has no session claimable section                       ok
a reservation by another session is outside every pool                  ok
the raw record of the reserved requirement carries no lock              ok
the archived, done and locked records are all outside the pool          ok
```

### 4.3 The queue is a soft reservation

```
the first append reserves the requirement                               ok
the append committed the item into a queue row                          ok
the append wrote no requirement row                                     ok
note one append produced 3 frames: queues/put, queues/put, (global)/put
appending twice is idempotent                                           ok
the idempotent append wrote nothing at all (0 frames)                   ok
the queue holds exactly the reserved items (5)                          ok
reserving wrote no requirement record (byte compare)                    ok
a reserved requirement carries no lock (lock === null)                  ok
the reserved requirement reports the reserving session                  ok
no queue action anywhere wrote a requirement row (0 requirement frames) ok
the queue refuses past its configured bound (queue-full)                ok
another session cannot claim a reserved requirement (conflict reserved) ok
the panel cannot reserve work for a session (session-required)          ok
unqueue drops the reservation; the freed requirement is then claimable  ok
a session cannot clear another session's reservation (panel-only)       ok
the panel clears any session's reservation                              ok
clearing what is not reserved writes nothing and succeeds               ok
disposing a session drops its queue row (releasedQueueItems === 3)      ok
its reservations are released with the row                              ok
two sessions queueing one requirement: exactly one wins (Promise.allSettled) ok
the loser is refused as reserved; exactly one row names it              ok
```

Observation (not a defect): one append costs **three** `domain/changed` frames — the queue row is created empty and then written with the item, plus the global revision record (whose frame carries `table: ""`). Anyone counting frames for "one user action = one frame" should know this; the *requirement* table receives zero frames.

### 4.4 `complete` releases the lock in the same write; archive/delete/release keep their semantics

```
claim installs the lock with one instant (at === touchedAt === updatedAt)   ok
a session already executing something else cannot claim another             ok  (session-busy)
completing finishes the requirement                                         ok
completion removed the lock in the same record                              ok  (lock === null)
the completion receipt names the queue head without taking it               ok  (queueHead.id, head lock still null)
the finished requirement released its own reservation only                  ok
the other requirement was not touched by the completion (bytes)             ok
completion wrote no separate release history entry                          ok  (history = create,claim,complete)
a finished requirement can no longer be claimed                             ok  (invalid-state)
reopening needs the lock like any other transition                          ok  (forbidden lock-required)
releasing a lock nobody holds writes nothing                                ok  (rev unchanged)
the panel reopens a finished requirement; claim then complete again         ok
completing an already-done requirement is refused                           ok  (invalid-transition)
archiving releases the reservation on that requirement                      ok
deleting releases the reservation and removes the record                    ok
a done requirement still takes the archive action                           ok
```

### 4.5 Item 6 — hint reachability (the author's own admission, judged)

`judgeClaim` attaches `queueHead` to the `session-busy` refusal (`dispatch.js:203-210`) and sets `queued = reservedBy === session` only in the "locked by someone else" branch (`dispatch.js:189-197`). I tested both public orderings and then the fixture:

```
claiming out of turn is refused as session-busy                             ok
the session-busy refusal names the caller's own queue head                  ok   ← reachable, arrives
a reservation blocks the other session before the lock is ever consulted    ok  (reserved)
a locked requirement cannot be queued either                                ok  (locked)
that refusal reports queued=false, so the reachable path never sets the flag ok
no public writer leaves a requirement both reserved by one session and locked by another ok
the fixture-only state is a locked refusal; queued=true and it points at unqueue      ok
```

**Verdict: the author's admission is correct.** Ordering 1 (reserve first) is stopped by `reserved` before the lock is consulted; ordering 2 (lock first) is stopped by the lock branch with `queued=false` because the caller's own queue does not name the requirement yet. `claim` is the only lock producer, so no public writer can create "reserved by me ∧ locked by another". The `queued=true` message is reachable only by writing the `queues`/`requirements` tables directly (which I did), and it behaves as documented. This is a defensive branch, not a hidden defect: the alternative it protects cannot arise, and it costs one comparison.

### 4.6 `disposeSession` orphans locks (never deletes them)

```
disposal reports the lock it orphaned (orphaned === 1)                      ok
the orphaned lock keeps its holder and take instant                          ok
disposal released the queue item it was reserving                            ok
the orphaned state allows a takeover in the table everyone reads             ok  (state orphaned, allows true)
the orphaned record is in the claimable pool for another session             ok
another session takes the orphan over at once                                ok  (orphaned flag cleared)
```

## 5. Item 2 — the 45-run stress loop (double the author's 20)

Loop 2, hash-tracked per run (`_a3_loop2.txt`, pasted in full — one digest for all 45 runs, `hash=stable` everywhere):

```
dispatch run 1 exit=0 hash=stable C5882B5A-3F22818C-84E93142-43717F12-ADB8A852-2574BCD8-9DA09BD3-AD36B81B-95B4F31A-3F71A501-6E11CEAF
dispatch run 2 exit=0 hash=stable (same digest)
… (runs 3–19 identical) …
dispatch run 20 exit=0 hash=stable (same digest)
queue run 1 exit=1 hash=stable (same digest)
queue run 2 exit=1 hash=stable (same digest)
queue run 3 exit=1 hash=stable (same digest)
queue run 4 exit=1 hash=stable (same digest)
queue run 5 exit=1 hash=stable (same digest)
roles run 1 exit=1 hash=stable (same digest)
roles run 2 exit=1 hash=stable (same digest)
roles run 3 exit=1 hash=stable (same digest)
roles run 4 exit=1 hash=stable (same digest)
roles run 5 exit=1 hash=stable (same digest)
domain run 1..5 exit=0 hash=stable (same digest)
smoke run 1..5 exit=0 hash=stable (same digest)
client-smoke run 1..5 exit=0 hash=stable (same digest)
```

Raw per-run lines are in `_a3_loop2.txt` (45 lines + `LOOP2 DONE`); the digest is identical in every line, verified by grouping. Failures were captured under `_a3_fail2_*.txt`.

**The queue/roles reds are the peer's mid-loop rewrite of the author's suites, not A3 defects.** Proof:

- the reds were recorded at **03:17:13** (queue) and **03:17:22** (roles);
- `tests/queue.mjs` was rewritten at **03:18:18** and `tests/roles.mjs` at **03:17:52** — inside my loop window;
- on direct re-run minutes later: **`queue.mjs` 252/252 exit 0**, **`roles.mjs` 220/220 exit 0** (`_a3_queue_now.txt`, `_a3_roles_now.txt`);
- the one queue failure was `queue.mjs:409` strictly comparing `disposeSession`'s receipt against an exact object literal: B had just added `settledDelegations` to that receipt (`service.js` return `{ session, releasedQueueItems, settledDelegations, orphaned }`), and the peer's rewrite added the field to the expected literal;
- roles run 1 was 214/220 and runs 2–5 were 216/220 — the difference is the test file changing between them, which my host-only digest could not see (lesson recorded in §7).

Final six-suite pass at one instant (R2 → R2′, `_a3_final_*.txt`) — **all green**:

```
queue          exit=0  252/252 checks passed
dispatch       exit=0  300/300 checks passed
roles          exit=0  220/220 checks passed
domain         exit=0   88/88 checks passed
smoke          exit=0   66/66 checks passed
client-smoke   exit=0  126/126 checks passed
```

Loop 1 (before I tracked digests, `_a3_loop.txt`) agrees for dispatch/domain/smoke/client-smoke and shows the same roles reds as R1.

## 6. Author claims — check by check

| Author's claim | My verdict | Evidence |
|---|---|---|
| `queue.mjs` 252/252 (12 cases × json+sqlite) | **证实** | direct re-run 252/252 on R2 (and 5/5 green earlier on R0/R1) |
| `dispatch.mjs` 300/300 (10 new cases through the real route handler) | **证实** (count and green); I did **not** audit each of its 300 assertions line by line | 20/20 loop runs green on R2, plus my own independent lock/queue/claimable table |
| `smoke` 66/66, `domain` 88/88, `client-smoke` 126/126 | **证实** | final pass + 5× loop each |
| `roles` 210/210 | **无法复现** | the 210-check file was red on R1 (peer's sweep had already landed; 204/210) and the peer then rewrote it to 220 checks, which is **220/220 green** on R2. Same "green", different contract — see §7 |
| flake root cause = one write chain read the clock once, `at` threaded into `#mutateRequirement` | **证实** | §3 (per-site audit, read counting on a fake advancing clock, mutation test) |
| 45 runs, 0 failures | **证实** (with the suite-rewrite caveat in §5) | 20/20 dispatch, domain/smoke/client-smoke 5/5, queue/roles green on re-run |
| `complete` releases the lock in the same write + releases that task's reservation + only hints the queue head | **证实** | §4.4 |
| `disposeSession` orphans locks | **证实** | §4.6 |
| queue is a soft reservation (no lock, no requirement write, no lease) | **证实** | §4.3 |
| `claimable` two modes | **证实** | §4.2 |
| A2 leftover `http.js` `pick()` always undefined → nine params inert; fixed to `query()` | **证实** | §4.1 + the RED control that fails for the pre-fix behaviour |

## 7. Findings for the Lead (none is an A3 defect; nothing was fixed by me)

1. **`queued=true` is a dead branch on every public path** (`dispatch.js:189-197`). The state it describes cannot be produced by `claim`/`queue`/`unqueue`/`disposeSession`; only a direct table write reaches it. It is harmless and defensive, but if the draft documents it as a caller-visible message, that message is unreachable — worth a note in the docs or a deletion decision by the author.
2. **B extends the `disposeSession` receipt with `settledDelegations`**, which breaks any A-era assertion that compares the receipt object exactly (it broke `queue.mjs:409` until the peer rewrote it). Cross-task: whoever lands last should sweep the A-era suites for exact-object comparisons of receipts.
3. **The author suite files changed under my loop** (`roles.mjs` 210→220 checks, `queue.mjs` expectation updated) while the host digest was constant; my digest tracked only `index.js` + `host/*.js`. Lesson for further verification on this tree: put `tests/*.mjs` into the digest too.
4. **One queue append emits three `domain/changed` frames** (empty row → row with item → global revision, the last with `table: ""`). Not a defect; relevant to anyone asserting "one action = one frame" or filtering SSE frames by table.
5. **Every suite run prints `ExperimentalWarning: SQLite is an experimental feature…` on stderr even on the json backend**, because `tests/harness.mjs` imports the SQLite backend at module load. Harmless, but a CI that treats any stderr as failure would trip on it.

## 8. What I did not verify, and why

- **Live HTTP on port 3104**: deliberately not run. `host/http.js:311` `registerBoardRoute` registers exactly `createBoardHandler(service)`, which is the object my route leg drives in process, so the live leg adds only TCP/cookie plumbing — already verified live in task-8 (channel 53/53, live 19/19) on the A3 revision. The composition root `index.js` was being rewritten by the peer at the time, so a boot failure could not have been attributed to A3; and I avoided the port `storage-migration` may use. No server was started, and **no HTTP request was ever sent to 3080** (nothing in my instruments opens a socket or calls `fetch`).
- **A drift-free pass on a frozen digest**: impossible while B lands; every result above is reported with its bracketing digest, and the 45-run loop is the one set that ran entirely on a single unchanged digest.
- **Each of the 300 `dispatch.mjs` assertions individually**: I ran them 20× and independently re-derived the decision table in my own instrument, but I did not read all 300 assertions line by line.
- **The author's 10 new dispatch cases specifically "through the real route handler"**: I verified the real handler's parameter plumbing exhaustively myself (§4.1); I did not confirm that the author's own 10 cases use the route handler rather than the service directly.

## 9. Boundary evidence

- `git status --short` shows only the pre-existing untracked entries (`.agents/skills/requirement-board-tasks/`, `.workbuddy/`, `_tmp_27116_*`, `_tmp_45252_*`); `git diff` is empty. `.artifacts/` is gitignored (`.gitignore:40`), so the plugin tree is untracked by design.
- Every file I wrote is under `.artifacts/requirement-board/tests/verification/`. The mutation copy `_red-copy/` was deleted after use; the recipe is in §3.3.
- My instruments contain no `homedir`/`.dsh` write, no port binding, and no outbound network call (grep over `a3-*.mjs`: only the phrase "no `~/.dsh` write" in a comment). Storage roots are `mkdtemp` under `%TEMP%`, each removed after use (no `a3-*` temp directory remained).
- **`~/.dsh/**` before/after hash comparison** (not content-only), taken around one instrument run: **7713 files before, 7713 after** (no file added or removed), and the only two files whose SHA256 changed are the live log of a running agent session — `.dsh\sessions\--C-code-deepseek-harness--\56001337-…\session.v4.jsonl.zstd` and `.dsh\storages\session_projcache\sessions\56001337-….json`. A harness session writes its own log as it works; the churn is the live session, not my instruments.
- No HTTP at all: no server was started on 3104 (deliberately, §8) and nothing in this task opened a socket, so **3080 never received a request**.
- No long-lived process was left behind (all runs are short-lived node processes; no background job of mine is still running).

## 10. Reproducing this report

```powershell
$env:TSX_TSCONFIG_PATH = 'C:\code\deepseek-harness\tsconfig.json'
$v = '.artifacts\requirement-board\tests\verification'
node --import tsx/esm $v\a3-chain.mjs                     # 90/90, exit 0
$env:RB_A3_BACKEND='sqlite'; node --import tsx/esm $v\a3-chain.mjs
$env:RB_A3_BACKEND='json';   node --import tsx/esm $v\a3-clock.mjs   # 30/30
node --import tsx/esm $v\a3-mutation.mjs                  # 0/200 mismatches
$env:RB_A3_RED='1'; node --import tsx/esm $v\a3-chain.mjs # must go red (76/78)
$env:RB_A3_RED='1'; node --import tsx/esm $v\a3-clock.mjs # must go red (30/32)
```

Raw logs kept beside this report: `_a3_chain_json.txt`, `_a3_chain_sqlite.txt`, `_a3_loop.txt`, `_a3_loop2.txt`, `_a3_queue_now.txt`, `_a3_roles_now.txt`, `_a3_roles_rerun.txt`, `_a3_final_*.txt`, `_a3_fail_roles_1.txt` (R1), `_a3_fail2_queue_1.txt`, `_a3_fail2_roles_1.txt` (R2, pre-rewrite).
