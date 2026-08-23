# @deepseek-ai/dsh-habits-settings

English | [中文](README.zh.md)

Settings-backed provider of the habits seam for the DeepSeek Harness. Stores `global` habit entries in the user-settings namespace `user-habits` (schema-validated, serialized writes, `settings/updated` event stream) and registers the canonical budgeted resident prompt section, so confirmed habits reach every model request until removed.

The contract, guard, consolidation, and commit event live in [`@deepseek-ai/dsh-user-habits`](../user-habits/README.md); this package implements only the storage hooks and the resident section.

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `maxEntryChars` | `200` | Per-entry character budget forwarded to the contract guard |
| `residentTokenBudget` | `600` | Hard token ceiling of the resident prompt section |

The namespace registers with `base: { entries: [] }`, so the section resolves before the user stored anything. Registration is an effect on this plugin's fiber: unloading the provider removes the namespace and the section together.

## Resident section

Registered as the `user-habits` section at order `50` (after the deployment persona, before tool guidance). The text provider renders committed `global` entries under the configured token budget: the fixed header first, then whole `- [{topic}] {value}` rows in id order; an entry is either included whole or omitted whole — never truncated. Omitted entries produce the visible notice `部分用户习惯因超出注入预算未展示(N 条)。需要时用 memory_list 查看。`. Fragment pricing uses the shared fixed-density heuristic of `dsh-token-meter`'s `estimate.ts` (4 code points per token plus per-fragment overhead).

## Model Experience

### Resident prompt section

#### What the model sees

The rendered section joins the system prompt on every assembly while the plugin is mounted and entries exist:

##### Rendered section

```markdown
## 用户习惯

以下为该用户确认过的偏好。撰写回复时主动遵守;同主题条目以项目级为准。

- [lang] 回复语言:中文
```

#### Token effect

Bounded by `residentTokenBudget` (default 600 tokens under the shared heuristic); the section is absent from the prompt when no entry exists.

#### KV Cache effect

The section's name, order, and entry ordering are stable, and entry text only changes when a habit is committed — so the prompt prefix stays reusable across requests until a habit write lands.

## Known Limitations and Deferred Work

- Concurrent writes serialize per settings namespace, but a read-modify-write across two interleaved callers can still drop one caller's entry (the settings section has no compare-and-set at the `SettingsScope` surface). Expected callers (a single model turn) write sequentially; CAS-based persistence is deferred work.
- The token budget uses the fixed-density heuristic directly rather than the `ctx.tokenMeter` service, keeping the package headless-composable; the density constant matches `token-meter`'s `estimate.ts`.
- Only the `global` layer is stored. The `project` layer (workspace `USER.md`) is a sibling provider per the design record.
- The section renders `global` entries only; project-overrides-global merging is the file provider's rendering concern.
