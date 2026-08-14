# @deepseek-ai/dsh-host-lookup-llm

Model-generated word explanations for the web lookup overlay. One Remote endpoint over the Typert gateway: `lookupLlm/explain` translates a selected word (English to Chinese, Chinese to English by script detection) and returns a 2-4 sentence noun introduction plus an optional IPA phonetic and part-of-speech groups. The route comes from the `agentDefaultModel` service, so the explanation follows the deployment's default model.

The call is a one-shot auxiliary `llm.stream` (no session, no tools), framed as strict JSON output and validated field by field before returning.

## Model Experience

### Explanation request

#### What the model sees

One auxiliary explanation request per call: the selected word, its detected language direction (en→zh or zh→en by script), an optional short surrounding-text snippet, and a strict-JSON output instruction. The call carries no session history, no tools, and no prior turns.

#### Token effect

Every `explain` call costs one model request capped at 700 output tokens; the input is the small prompt above.

#### KV Cache effect

None; the call is a fresh single-turn request without history, so it reuses no conversation prefix.

## Known Limitations and Deferred Work

- **No session context** — the explanation is generated from the word plus a short surrounding-text snippet, not the full conversation; a context-aware variant can pass more of the transcript.
- **Default-model route only** — the endpoint follows `agentDefaultModel`; per-session route selection is not exposed.
