# Agent Note: Settings surface for the harness home (DSH_HOME)

Status: implemented

English | [中文](2026-08-16-settings-dsh-home.zh.md)

## Problem

The harness home (`~/.dsh`, or `$DSH_HOME`) decides where every piece of user data lives, but changing it required editing an OS environment variable — a per-platform, per-shell chore with no settings surface and no way to persist it inside the harness itself.

## Decision

The home override is now a persisted file rather than an environment-only knob:

- `@deepseek-ai/dsh-home-paths` owns a boot-override file (`~/.dsh-boot`, under the OS home so it survives any home relocation by definition): `readBootHome`/`writeBootHome` read and write one absolute path line. `resolveDshHome` precedence becomes: explicit configured path, `$DSH_HOME`, the boot file, then `~/.dsh` (an empty env or blank file never resolves to the cwd).
- The host domain gains `host.setDshHome({ path | null })`, which writes or clears the file and answers what the NEXT boot resolves; `host.describe` reports the resolved home and its source (`default`/`env`/`boot-file`). When a `DSH_HOME` env var is set, the write is refused-as-pointless and the response says `env` — the variable still wins.
- The General settings page gains a loopback-only boot-home row: the resolved home with its source, a path editor, Save and Restore default, and the explicit hint that the change takes effect only after a restart and that existing data is not migrated.

## Alternatives considered

### Why not write the OS user environment variable?

Windows could (HKCU\Environment), but POSIX would need per-shell profile edits and every launcher would only see it after a fresh login. A harness-owned file is platform-consistent and readable by the running process itself.

### Why not a read-only display with instructions?

The person asked for configuration, not documentation; a read-only row would have deferred the edit to a shell prompt with no feedback.

### Why not auto-migrate data into the new home?

Migration across arbitrary home layouts is a distinct, risky feature; the row states the data stays put, and moving it remains an explicit operator step.

## Consequences

- The home override is durable and inspectable, cross-platform, and editable in-app.
- An environment variable still outranks the file — documented and reported to the user when present.
- The running process keeps its current home; only the next boot resolves the new root, and no data moves on its own.
- The write is loopback-only in the UI (like the open-document action), and the `/api` trust fence guards the endpoint like every other privileged host call.

## Testing

`home-paths` specs cover the boot file read/write/clear and the four-way precedence; `rpc-schemas` and the carrier/client specs cover the new host-domain payloads; the boot-home row controller spec covers load/save/clear and the env-wins report; the apply spec pins the loopback-only registration.
