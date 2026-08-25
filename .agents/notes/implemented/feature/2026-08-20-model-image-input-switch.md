# Agent Note: Model image-input switch in the Models settings page

Status: implemented

English | [中文](2026-08-20-model-image-input-switch.zh.md)

## Problem

A pi-ai gateway or hand-declared custom provider can serve vision models, but a model only accepts images when its profile entry names the `image` input modality. The Models settings page's model-list editor (the pi-ai and custom-provider family) exposed only `id`, `name`, `contextWindow`, and `maxTokens` per row, so enabling image input meant hand-editing `settings.yaml` — the one capability the config surface could not set.

## Decision

The pi-ai model-list editor (`ModelListEditor`) gains a per-row **image-input switch** inside the row's existing advanced disclosure, beside the capacity fields. Enabling writes `input: ['text', 'image']`; disabling writes `input: ['text']`. Both directions write the modality list explicitly, so turning the switch off always means "this model does not accept images" rather than silently inheriting a route-level `defaultInput` that permits them. A row that declares no `input` renders unchecked, because the card cannot see the inherited route default and never pretends to know it.

The switch writes through the existing draft → `settings.mutate` path-ops pipeline, so no wire, schema, or persistence surface changes: the value lands in the profile's `models` array exactly like a capacity edit, and the pi-ai adapter's existing `input` field validation and resolution apply unchanged. The row stays structurally open, so a modalitied row edited for a sibling field keeps its modalities.

The switch exists only in the pi-ai family's editor (`ModelListEditor`), not the direct DeepSeek catalog editor: the direct adapter uses the differently-named `inputModalities` field, ships text-only defaults, and its official API does not currently serve images ([direct DeepSeek vision input](2026-08-19-direct-deepseek-vision-input.md) covers the exact-model opt-in that does exist), so a switch there would offer a capability the official route cannot deliver.

## Alternatives considered

- **A three-state switch (inherit / on / off)** — rejected: the card cannot read the inherited value (route `defaultInput` and the installed catalog are host-side facts), so it could not render the inherit state truthfully; an unchecked switch that actually accepted images would be a lie.
- **A read-only capability badge** — rejected: the request is a management surface, and a badge would still force `settings.yaml` edits for the one change users asked to make here.
- **Adding the same switch to the direct DeepSeek editor** — rejected above: the field is named differently, the defaults are text-only, and the official API has no image endpoint to enable.
- **Clearing `input` on disable to inherit** — rejected: disabling must be a firm "no images for this model", and an unset field asks the next layer, which may be a route that permits them.

## Consequences

Vision models behind pi-ai gateways and custom providers can be enabled and disabled from the Models page without touching `settings.yaml`. An explicit `['text']` override beats a permissive route `defaultInput`, which is the point of a switch. Rows that never declare modalities behave exactly as before. The DeepSeek editor remains unchanged, and its field set stays confined to what the official route can actually serve.
