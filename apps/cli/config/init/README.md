# Init templates

Machine-level initialization templates. On every boot, `apps/cli` walks this
tree and copies each file to the same relative path under the harness home
(`$DSH_HOME`) **only when the target does not exist** — existing files are
never overwritten, so user edits and stored data are safe. The step is
idempotent and runs before the plugin tree mounts, so a first boot's
`settings.yaml` baseline is what the settings provider reads.

- Template names are literal: `settings.yaml` here initializes
  `$DSH_HOME/settings.yaml`.
- `README.md` files are documentation and never copied.
- Adding a file here is the whole change needed for a new machine-level
  baseline; removing one only affects machines that never ran a boot with it.
- Secret values never belong here: templates declare structure and API-key
  environment names, and the keys themselves live in the environment.
