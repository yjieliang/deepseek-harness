# kb-agent

English | [中文](README.zh.md)

Knowledge-base demo over the ACP automation tree: the host kb engine (`@deepseek-ai/dsh-host-kb`) and the model-facing `kb_*` tools (`@deepseek-ai/dsh-tool-kb`) mounted beside the standard agent stack, driving the machine-global markdown library at `$DSH_HOME/kb`.

- `cordis.yml` — live/record composition. It includes `../acp-agent/cordis.yml` and inserts the two kb rows; the library root keeps its default, so a live demo edits the machine's real library and `trashRetentionDays: 0` keeps the purge sweep timerless.
- `cordis.snapshot.yml` — keyless replay composition. One include patches the included tree directly (patches cannot target entries behind a nested include): the DeepSeek adapter is disabled, `llm-replay` and the spill pair are inserted, and the kb rows ride the same insert. The acp-agent config is restated verbatim with the model re-pinned to `deepseek-v4-flash`, matching the recorded corpus.

Snapshot scenarios seed documents through `workspace/.dsh/kb/…` (the harness copies the workspace to the run cwd and sets `DSH_HOME` to `cwd/.dsh`, which is the default library root) and exercise the read-only tools first — `kb_add`/`kb_import` stamp today's date into filenames and frontmatter, so their transcripts drift daily unless the recording is refreshed.

Run the live demo with the ACP demo bin pointed at this config (`DSH_SNAPSHOT=record` records with a real key; replay needs none). Snapshot scenarios and their fixtures land in `tests/` once recorded.
