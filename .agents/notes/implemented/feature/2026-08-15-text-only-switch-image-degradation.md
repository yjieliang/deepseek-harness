# Agent Note: Text-only model switches degrade session images to placeholder text

Status: implemented

English | [中文](2026-08-15-text-only-switch-image-degradation.zh.md)

## Problem

The [multimodal image-input decision](2026-07-22-web-multimodal-image-input-and-durable-attachments.md) pinned an image-bearing session to image-capable models: `session.selectModel` rejected a text-only target while any image remained pending publication or present in the session's current derived history, and both shipping adapters failed the request with `UNSUPPORTED_CONTENT` when an image reached a text-only wire route. One pasted screenshot was enough to lock a session out of `deepseek-v4-flash` forever; the only escapes were a new session, a fork before the image, or compacting the image away first.

The refusal was deliberate — the [drop-image note](../../implemented/simplification/2026-07-04-drop-image-content-block.md) sanctioned loud rejection as the only acceptable non-support posture, against the one indefensible state: silently dropping or flattening an image. But the refusal conflated sending with switching. A text-only model genuinely cannot accept *new* image input, yet it can still serve the conversation's *text* history — the images it cannot see can be named as omitted rather than make the whole session unusable.

## Decision

An image-bearing session can switch to a text-only model. Text-only wire routes degrade every `ImageBlock` to a shared, stable placeholder string instead of failing the request.

- `IMAGE_OMITTED_PLACEHOLDER` and `degradeImages` live in `dsh-llm`'s `content.ts` beside `contentHasImage`, the one recursive image walk every image policy shares. Degradation replaces each image block with the placeholder text, recursing into nested tool-result content identically; unknown declaration-merged blocks pass through untouched. The string is model-visible, pinned verbatim by adapter tests, and reconstructable from the session log as a deterministic function of logged content.
- The DeepSeek chat-completions serializer degrades once per message before any text-flattening path, so user text, assistant text, and tool results all emit the placeholder. The pi-ai adapter degrades the request when the resolved model's modalities omit `image`; an image-capable pi-ai route still resolves durable bytes through the attachment service, and a missing attachment service there still fails `UNSUPPORTED_CONTENT`.
- `session.selectModel` no longer refuses a text-only target over image content. The response flags `imagesDegraded: true` when the admitted target declares no image input while pending or derived images remain, and the composer seat announces the degradation in a transient warning toast, because the transcript keeps rendering images the model no longer sees.
- The prompt-time admission boundary is unchanged: a *new* image prompt to a text-only model still fails before persistence with `attachment-error`, `read_image` still requires a routed model that declares image input, and the per-agent serial boundary from the [atomic admission decision](../bug-fix/2026-07-29-atomic-web-image-admission.md) still orders image admission against selection — it now computes an exact flag instead of a refusal.

This is not the silent drop the vocabulary policy rejects. The substitution is a stable string the model can see and name, the user is told at switch time, and the divergence is one-directional: the UI renders logged images while the model receives text.

## Alternatives considered

### Keep refusing the switch

The refusal protected against a failure that degradation prevents more precisely. Its cost was total: an image-bearing session lost access to every text-only model, and the sanctioned escapes (new session, fork, compaction) all discard conversation context the user wants to keep.

### Admit the switch but keep failing at request time

Strictly worse than refusing: the selection would land, then every later turn would fail `UNSUPPORTED_CONTENT` on the same history. If selection admits a route, the adapter must be able to serve the session's durable content.

### Strip images silently during serialization

This is the rejected silent-drop shape: information vanishes between the user's transcript and the model's input with no trace for either side. The placeholder keeps the omission explicit to the model; the toast keeps it explicit to the user.

### Compact the images away automatically on switch

A switch-triggered compaction is a heavy, lossy side effect for a navigation gesture, and it does not even guarantee the outcome: the retained post-checkpoint tail can still contain images, so the refusal would survive the compaction that was meant to lift it.

## Consequences

- User-visible transcript and model-visible input diverge deliberately: the UI renders logged images while a text-only model receives placeholders. The switch-time toast names this once per degraded selection; nothing later repeats it, so a user who missed the toast may expect visual understanding the model does not have.
- A text-only compaction route can now summarize an image-bearing surface: the summarization call degrades the same images, so compaction completes where it previously failed, but the checkpoint loses visual detail the summary model never saw.
- The `/model` popup entry applies a degraded switch without surfacing the warning; the composer seat is the surface that announces it.
- Changing the placeholder string is a model-visible change pinned by adapter tests in two packages.

## Testing

- `dsh-llm` content tests pin degradation (top-level image, nested tool-result recursion, unknown-block passthrough). DeepSeek serializer tests and a pi-ai adapter test pin the placeholder on the wire, including nested tool results; the pi-ai suite keeps the attachment-service failure for image-capable routes.
- The apiproxy suite covers admission with the flag over durable and pending images, the unflagged image-capable target, and the unflagged image-free switch. Client specs cover the degradation toast on an accepted switch and the unchanged rejection toast on a failed one.
- The keyless assembled lane (`apps/web/tests/model-image-degradation.snapshot.ts`) pins the product surface end to end: over the fixture history session carrying its image pair, an image-capable switch shows no notice while the text-only switch is admitted with the exact degradation toast. Its fixture transport mirrors the host's `imagesDegraded` flag over a fixture-local modality table.
