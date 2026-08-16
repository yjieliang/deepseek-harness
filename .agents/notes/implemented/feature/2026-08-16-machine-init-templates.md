# Agent Note: Machine-level init templates

Status: implemented

English | [中文](2026-08-16-machine-init-templates.zh.md)

## Problem

A fresh machine booting a profile got most machine-level state automatically — the profile directory, its manifest and `cordis.patch.yml`, the healed module fallback, an empty settings document — but any *content* for those files was either hard-coded boot logic or manual copying. There was no shipped, template-driven way for a deployment to say "a first boot's `$DSH_HOME` looks like this", so every new baseline file (a settings skeleton, a provider list without keys, a future machine-local document) would have needed its own bespoke boot step or a hand-copied home.

## Decision

`apps/cli` owns a machine-level initialization step: a shipped template tree at `apps/cli/config/init/` whose files map to the same relative paths under `$DSH_HOME`. `applyInitTemplates` walks the tree on every `runProfile` boot — before the plugin tree mounts, so a first boot's `settings.yaml` is what the settings provider reads — and copies a file only when its target does not exist. Existing files are never overwritten, the step is idempotent, `README.md` files document templates without being copied, and a missing template root warns and skips rather than failing the boot (initialization is additive; the app still runs, just without a fresh-machine baseline). The first shipped template is a `settings.yaml` baseline declaring the default model route and provider skeletons with API-key environment names — structure only, no secrets.

## Alternatives considered

### Why not a declarative manifest with a general provisioning engine?

A list of "create this directory, write that setting default" is the most complete shape, but today's needs are plain file materialization and nothing else; the engine would be speculative machinery without a consumer for its other verbs. The template tree keeps the same one-file-per-baseline ergonomics and can grow into a manifest later if a real need appears.

### Why not a plugin that runs after the tree mounts?

The first consumer — the settings document — is read by the settings provider when it mounts, so a post-mount plugin is too late to initialize it. Running inside `runProfile` before `boot` is the only place every machine-level file is in place before any reader.

### Why not sync/overwrite templates onto the home?

Overwriting would destroy user edits and stored data (the settings document above all). Copy-on-missing-only is the entire safety model; a deployment that wants to change a baseline for existing machines edits its own home or ships migration, never the init step.

## Consequences

- New machine-level baseline files are one template file away, and every existing machine keeps its home untouched.
- Secrets stay out of the repository by construction: templates carry structure and environment names.
- The step runs once per boot and writes nothing after the first, so it costs a single recursive read.
- A machine that already has a file is never migrated by this step — deliberate; upgrades that need to move existing files are separate migrations, like the habits `guardConfirmed` one.

## Testing

`apps/cli/tests/init-config.spec.ts` covers copy-on-missing, never-overwrite, idempotence, README exclusion, and the missing-root warn path against temp roots; the real harness home is never touched by tests.
