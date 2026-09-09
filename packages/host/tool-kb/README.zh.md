# @deepseek-ai/dsh-tool-kb

[English](README.md) | 中文

知识库的**模型面向工具**——`kb_search`、`kb_add`、`kb_get`、`kb_update`、`kb_move`、`kb_rename`、`kb_delete`、`kb_links`、`kb_tags`、`kb_stats`、`kb_archive`、`kb_organize`、`kb_images`、`kb_import`、`kb_export`、`kb_clip`，作用于 `kb/` 工作区根目录。这是知识库能力的 agent 平面消费方：它拥有工具名、JSON schema、字段语法解析（`tag:`/`path:`/`status:`/`title:`）、批量操作闸门、提示词段与复合编排（归档、整理、导入、导出、剪藏）。所有读写都经 `ctx.kb`（[`@deepseek-ai/dsh-host-kb`](../kb) 网关服务）完成，浏览器面板与 agent 工具共享同一引擎、同一索引、同一写路径。

```ts ignore-check
// Default deployment: the host knowledge-base feature, then the tools.
await ctx.plugin(KbGateway, { archiveDir: '90-归档' }) // @deepseek-ai/dsh-host-kb
await ctx.plugin(ToolKb)                                // this package
```

工具硬依赖 `ctx.kb`（`inject` 声明），因此挂载本包的组合必须同时在 host 平面挂载 `@deepseek-ai/dsh-host-kb`。`web` 保持可选（`ctx.get`）：未挂 web 服务时 `kb_clip` 降级为仅存 URL+标题。

## Config

所有键均可选；默认值为出厂值。

| 键 | 默认 | 含义 |
|---|---|---|
| `searchTopK` | `10` | `kb_search` 未传 `topK` 时的默认结果上限。 |
| `batchConfirmN` | `5` | `kb_archive`（非预览）与 `kb_import` 达到该篇数时拒绝执行，须先预览。 |
| `archiveDays` | `90` | `kb_archive` 未传 `days` 时的默认天数阈值。 |
| `clipMaxBodyChars` | `20000` | `kb_clip` 保留的抓取正文最大字符数。 |

## Tools

| 工具 | 参数 | 行为 |
|---|---|---|
| `kb_search` | `query`, `topK?` | 标题/别名/标签/摘要/正文关键词检索（BM25 排序）；`tag:`/`path:`/`status:`/`title:` 前缀过滤命中。 |
| `kb_add` | `title`, `content?`, `directory?`, `tags?`, `source?`, `summary?` | 新建带日期与 frontmatter 的文档（默认 `00-inbox`）。 |
| `kb_get` | `path` | 全文读取：正文、frontmatter、反链、版本令牌。 |
| `kb_update` | `path`, `content?`, `summary?`, `tags?`, `expectVersion?` | 乐观锁补丁更新；过期版本以冲突错误拒绝。 |
| `kb_move` | `path`, `targetDirectory` | 移动到其他目录（移动即改推导状态）。 |
| `kb_rename` | `path`, `name` | 在当前目录内重命名：改文件名与 frontmatter 标题，保留其余元数据。 |
| `kb_delete` | `path` | 移入 `.trash`（可恢复，绝不直接删除）。 |
| `kb_links` | `path` | 一篇文档的出链与反链。 |
| `kb_tags` | — | 带文档数的标签索引。 |
| `kb_stats` | — | 总数、按状态计数、目录、归档目录。 |
| `kb_archive` | `days?`, `dryRun?` | 预览（默认）或把过期文档移入归档目录；超过 `batchConfirmN` 执行前须先预览。 |
| `kb_organize` | — | 规则版积压/重复/过期报告（无 LLM 成本）。 |
| `kb_images` | — | 重建 `_meta/images.json`（统一对象格式）并列出孤儿图片。 |
| `kb_import` | `files`, `directory?` | 批量新建；超过 `batchConfirmN` 拒绝。 |
| `kb_export` | `path?` | 导出单篇或全部文档全文。 |
| `kb_clip` | `url`, `title?`, `tags?` | 经 `ctx.web` 抓取页面正文入收集箱；抓取不可用时降级为仅存 URL+标题。 |

成功结果即引擎的 JSON 规范值（`{ hits, total }`、`{ path }`、`{ path, content, meta, backlinks, version }`、`{ tags }`……），以 JSON 文本块渲染。字段名沿用引擎的 wire 词汇。

## Model Experience

### System prompt

#### 模型所见

本插件注册作用域内的每个请求都会收到知识库引导段：它告知库位于 `$DSH_HOME/kb`（工作区之外），**默认不要检索**，且仅当用户明确表达引用意图（提到知识库、点名某篇笔记、给出 `@kb:path` 或 `[[标题]]` 引用、明确要求查找）时才调用 `kb_*` 工具。段落位于 order 100——在 file-reference 段的 `@` 语法规则之后——其【引用语法】一段是模型对 `@` 语法的最终裁决，把 `@kb:` 从工作区文件规则中剥离。

##### 知识库引导段

```markdown
知识库(Knowledge Base)位于 $DSH_HOME/kb(不在工作区路径内,不要用 read 文件工具打开),提供 kb_search / kb_get / kb_add / kb_update / kb_move / kb_rename / kb_delete / kb_links / kb_tags / kb_stats / kb_archive / kb_organize / kb_images / kb_import / kb_export / kb_clip 共 16 个工具。

【按需检索】默认不要主动检索知识库。只有当用户明确表达参考知识库意图时才调用 kb_* 工具:
- 用户消息包含「知识库」「kb」「笔记」「根据XX文档」「我记得知识库里有」等明确指向词汇;
- 用户消息含 @kb:path 引用(用 kb_get 按路径读取)或 [[标题]] wiki 链接(用 kb_search 按标题定位,再 kb_get 读取);
- 用户明确要求「查知识库/查笔记/找那篇」。

【引用语法】@ 开头的路径默认是工作区文件,用 read 读取;但 @kb: 开头的引用(含 @kb:"带空格的路径")是 $DSH_HOME/kb 下的知识库文档,必须用 kb_get 按路径读取,不要用 read。

普通对话、工作区文件操作不要触发 kb_search。
```

#### Token 影响

插件激活期间每次请求的固定引导成本。

#### KV Cache 影响

插件作用域与段落文本不变时前缀稳定。

### Tool schemas

#### 模型所见

模型看到 16 个 `kb_*` 工具的[生成 schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-kb)。`kb_search` 的 schema 公布 `tag:/path:/status:/title:` 前缀；`kb_archive` 与 `kb_import` 公布批量确认行为。

#### Token 影响

该工具视图每次请求的固定 schema 成本。

#### KV Cache 影响

可见工具定义与顺序不变时前缀稳定。

### Tool results

#### 模型所见

每个工具返回引擎规范 JSON 的文本块：`kb_search` → `{ hits, total }`，`kb_add`/`kb_clip` → `{ path, ... }`，`kb_get` → `{ path, content, meta, backlinks, version }`，`kb_links` → `{ path, outLinks, backlinks }`，`kb_move`/`kb_rename` → `{ from, to }`，`kb_archive` → `{ dryRun, candidates, count }`，`kb_organize` → `{ report }`，`kb_images` → `{ total, images, orphans }`，`kb_import` → `{ imported, count }`，`kb_export` → `{ files, count }`。

#### Token 影响

结果大小受引擎上限约束（`searchTopK`、导出正文、剪藏正文上限）；参数与结果在压缩前反复重发。

#### KV Cache 影响

仅追加；新可见内容跟在可复用请求前缀之后，不使既有 KV-cache 条目失效。

### Tool errors

#### 模型所见

失败归一为 `Error: <message>`。本包稳定消息包括 `kb: 标题不能为空`、`kb: 缺少 path`、`kb: 缺少 path 或 name`、`kb: 新名称不能为空`、`kb: 仅支持 http/https URL`、`kb: 版本冲突,请重新读取后再更新`，以及批量闸门 `kb: 批量归档 <n> 篇超过确认阈值 <m>,请先用 dry-run 预览确认` / `kb: 批量导入 <n> 篇超过确认阈值 <m>,请分批导入`；引擎错误原样透传。

#### Token 影响

仅失败调用新增这些保留 token。

#### KV Cache 影响

仅追加；新可见内容跟在可复用请求前缀之后，不使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **依赖 host 知识库功能**——工具是 `ctx.kb` 的硬消费方；未挂 `@deepseek-ai/dsh-host-kb` 的部署中本包保持等待而非独立可用。
- **检索为关键词级**——引擎的 BM25 2-gram 打分容忍单字符笔误，但无语义检索；语义检索属知识库 Phase 3 的本地 embedding 规划。
- **批量确认为工具层闸门**——`kb_archive`/`kb_import` 以 `batchConfirmN` 做「先预览」拒绝；无交互式确认对话框。
- **`kb_clip` 保留原始页面正文**——无 Markdown 转换或可读性抽取；超长正文按 `clipMaxBodyChars` 截断。
