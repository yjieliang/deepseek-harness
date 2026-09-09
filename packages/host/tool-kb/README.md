# @deepseek-ai/dsh-tool-kb

English | [中文](README.zh.md)

The **model-facing knowledge-base tools** — `kb_search`, `kb_add`, `kb_get`, `kb_update`, `kb_move`, `kb_rename`, `kb_delete`, `kb_links`, `kb_tags`, `kb_stats`, `kb_archive`, `kb_organize`, `kb_images`, `kb_import`, `kb_export`, `kb_clip` — for the `kb/` workspace root. This is the agent-plane consumer of the knowledge-base capability: it owns the tool names, JSON schemas, field-syntax parsing (`tag:`/`path:`/`status:`/`title:`), bulk-operation gates, the prompt section, and the composite orchestrations (archive, organize, import, export, clip). Every read and write goes through `ctx.kb` — the [`@deepseek-ai/dsh-host-kb`](../kb) gateway service — so the browser panel and the agent tools share one engine, one index, and one write path.

```ts ignore-check
// Default deployment: the host knowledge-base feature, then the tools.
await ctx.plugin(KbGateway, { archiveDir: '90-归档' }) // @deepseek-ai/dsh-host-kb
await ctx.plugin(ToolKb)                                // this package
```

The tools require `ctx.kb` (a hard `inject`), so a composition mounting this package must also mount `@deepseek-ai/dsh-host-kb` in the host plane. `web` stays optional (`ctx.get`): `kb_clip` degrades to URL-and-title when no web service is mounted.

## Config

All keys are optional; the defaults are the shipped values.

| Key | Default | Meaning |
|---|---|---|
| `searchTopK` | `10` | Default result cap for `kb_search` when the call omits `topK`. |
| `batchConfirmN` | `5` | Bulk operations (`kb_archive` non-preview, `kb_import`) at or above this many documents refuse without a prior preview. |
| `archiveDays` | `90` | Default age threshold for `kb_archive` when the call omits `days`. |
| `clipMaxBodyChars` | `20000` | Maximum characters of a clipped page body kept by `kb_clip`. |

## Tools

| Tool | Arguments | Behavior |
|---|---|---|
| `kb_search` | `query`, `topK?` | Keyword search over title/aliases/tags/summary/body with BM25 ranking; `tag:`/`path:`/`status:`/`title:` prefixes filter the hits. The tool description directs the agent to expand a colloquial query into 2–4 candidate keywords before searching, to raise recall. |
| `kb_add` | `title`, `content?`, `directory?`, `tags?`, `source?`, `summary?` | Create a dated document (default `00-inbox`) with generated frontmatter. |
| `kb_get` | `path` | Full read: body, frontmatter, backlinks, version token. |
| `kb_update` | `path`, `content?`, `summary?`, `tags?`, `expectVersion?` | Patch body or metadata with an optimistic lock; a stale lock fails with a conflict error. |
| `kb_move` | `path`, `targetDirectory` | Move to another directory (moving changes the derived status). |
| `kb_rename` | `path`, `name` | Rename within the current directory: changes the filename and the frontmatter title, keeping the rest of the metadata. |
| `kb_delete` | `path` | Move into `.trash` (recoverable; never a direct delete). |
| `kb_links` | `path` | Outlinks and backlinks of one document. |
| `kb_tags` | — | Tag index with document counts. |
| `kb_stats` | — | Totals, per-status counts, directories, archive directory. |
| `kb_archive` | `days?`, `dryRun?` | Preview (default) or move stale documents to the archive directory; past `batchConfirmN` execution requires a prior preview. |
| `kb_organize` | — | Rule-based backlog/duplicate/stale report (no LLM cost). |
| `kb_images` | — | Rebuild `_meta/images.json` (unified object format) and list orphaned images. |
| `kb_import` | `files`, `directory?` | Batch create; past `batchConfirmN` refuses. |
| `kb_export` | `path?` | Dump one or every document's full text. |
| `kb_clip` | `url`, `title?`, `tags?` | Fetch a page body into the inbox through `ctx.web`; degrades to URL-and-title when the fetch is unavailable. |

Canonical successes are the engine's JSON results (`{ hits, total }`, `{ path }`, `{ path, content, meta, backlinks, version }`, `{ tags }`, …), rendered as a JSON text block. Field names follow the engine's wire vocabulary.

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope receives the knowledge-base guidance section. It tells the agent where the library lives (`$DSH_HOME/kb`, outside the workspace), to **not** search it by default, and to invoke `kb_*` tools only when the user explicitly signals a reference-intent (mentions the knowledge base, names a specific note, uses an `@kb:path` or `[[title]]` reference, or asks to look something up). The section sits at order 100 — after the file-reference section's `@`-grammar rule — so its 【引用语法】 paragraph is the model's latest word carving `@kb:` out of the workspace-file rule.

##### Knowledge-base guidance

```markdown
知识库(Knowledge Base)位于 $DSH_HOME/kb(不在工作区路径内,不要用 read 文件工具打开),提供 kb_search / kb_get / kb_add / kb_update / kb_move / kb_rename / kb_delete / kb_links / kb_tags / kb_stats / kb_archive / kb_organize / kb_images / kb_import / kb_export / kb_clip 共 16 个工具。

【按需检索】默认不要主动检索知识库。只有当用户明确表达参考知识库意图时才调用 kb_* 工具:
- 用户消息包含「知识库」「kb」「笔记」「根据XX文档」「我记得知识库里有」等明确指向词汇;
- 用户消息含 @kb:path 引用(用 kb_get 按路径读取)或 [[标题]] wiki 链接(用 kb_search 按标题定位,再 kb_get 读取);
- 用户明确要求「查知识库/查笔记/找那篇」。

【引用语法】@ 开头的路径默认是工作区文件,用 read 读取;但 @kb: 开头的引用(含 @kb:"带空格的路径")是 $DSH_HOME/kb 下的知识库文档,必须用 kb_get 按路径读取,不要用 read。

普通对话、工作区文件操作不要触发 kb_search。
```

#### Token effect

Fixed guidance cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and section text are unchanged.

### Tool schemas

#### What the model sees

The model sees the [generated schemas for the 16 `kb_*` tools](../../../docs/tool-catalog.md#deepseek-aidsh-tool-kb). The `kb_search` schema advertises the `tag:/path:/status:/title:` prefixes; `kb_archive` and `kb_import` advertise the bulk-confirm behavior.

#### Token effect

Fixed schema cost on every request in that tool view.

#### KV Cache effect

Prefix-stable while the visible tool definitions and order are unchanged.

### Tool results

#### What the model sees

Each tool returns the engine's canonical JSON value rendered as a JSON text block: `kb_search` → `{ hits, total }`, `kb_add`/`kb_clip` → `{ path, ... }`, `kb_get` → `{ path, content, meta, backlinks, version }`, `kb_links` → `{ path, outLinks, backlinks }`, `kb_move`/`kb_rename` → `{ from, to }`, `kb_archive` → `{ dryRun, candidates, count }`, `kb_organize` → `{ report }`, `kb_images` → `{ total, images, orphans }`, `kb_import` → `{ imported, count }`, `kb_export` → `{ files, count }`.

#### Token effect

Result sizes are bounded by the engine's caps (`searchTopK`, the export body, the clip body limit); arguments and results are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Failures are normalized as `Error: <message>`. This package's stable messages include `kb: 标题不能为空`, `kb: 缺少 path`, `kb: 缺少 path 或 name`, `kb: 新名称不能为空`, `kb: 仅支持 http/https URL`, `kb: 版本冲突,请重新读取后再更新`, and the bulk gates `kb: 批量归档 <n> 篇超过确认阈值 <m>,请先用 dry-run 预览确认` / `kb: 批量导入 <n> 篇超过确认阈值 <m>,请分批导入`; engine errors pass through verbatim.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Requires the host knowledge-base feature** — the tools are a hard consumer of `ctx.kb`; a deployment without `@deepseek-ai/dsh-host-kb` leaves this package waiting rather than working standalone.
- **Search ranking is keyword-based** — the engine's BM25 2-gram scorer tolerates one-character typos but has no semantic retrieval; the library's Phase 3 plan covers local embeddings.
- **Batch confirmation is tool-layer only** — `kb_archive`/`kb_import` gate on `batchConfirmN` with a preview-first error; there is no interactive confirmation dialog.
- **`kb_clip` keeps the raw page body** — no markdown conversion or readability extraction; oversized bodies are truncated at `clipMaxBodyChars`.
