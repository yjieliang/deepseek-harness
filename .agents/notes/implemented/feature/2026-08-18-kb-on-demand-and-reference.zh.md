# Agent Note: Knowledge-base document reference and on-demand retrieval

Status: implemented

[English](2026-08-18-kb-on-demand-and-reference.md) | 中文

相关：[可拆卸域笔记](2026-08-18-kb-detachable-reference-domain.md)持有本决策落地所用的贡献来源与提示词归属机制。

## Problem

知识库位于 `$DSH_HOME/kb`（机器级、在任何工作区之外），因此 Web `@` 引用管线里工作区受限的 `@file` source —— 其发现与语法都限定在工作区内 —— 无法指向一篇知识库笔记。用户想让 agent 依据某篇笔记回答时，只能手写完整的库内相对路径或靠关键词搜索；而像 `@10-技术/note.md` 这样的自然表述会被当作工作区文件、用 `read` 打开，而 `read` 到不了 `$DSH_HOME/kb`。另一方面，知识库提示词段会推动 agent 在用户提到「知识库／知识管理／收藏／剪藏」时就去搜索库，于是无关对话也可能触发本轮根本不需要的 `kb_search`。

## Decision

知识库引用域是独立的 `knowledge-base` 触发来源：`@deepseek-ai/dsh-client-ui-kb` 经 `ctx.inputTriggers` 在 `@deepseek-ai/dsh-client-ui-reference` 的文件／会话 source 旁注册它，因此输入框仍呈现一个合并的 `@` 菜单。管线对未加引号的 token 并发启动 `fileReferences/list`、`sessionReferenceResolver/candidates`、`kb/list` 三项 Remote 调用，并在文件、会话、知识库三个分组标题下渲染行。kb source 基于 `ctx.remote.kb.list` 按标题／路径前缀列出库内文档，从 query 里剥离开头的 `kb:`，使补全匹配文档标题／路径而非字面命名空间，并插入带数据图标的原子 `@kb:<path>` 引用。无法安全表示的路径（内嵌引号、控制字符）会被丢弃。任一候选域都可独立失败，不隐藏其他域返回的行。

模型侧与之配套做两处指引变更。`dsh-tool-kb` 的知识库提示词段现在明确库位于 `$DSH_HOME/kb`（纠正此前「工作区根目录 `kb/`」旧文本，那会诱导 `read`），并给检索加 gate：明确告诉 agent **默认不要**检索库，仅当用户表达明确引用意图（提到知识库、点名某篇笔记、使用 `@kb:path` 或 `[[title]]` 引用、或要求查某内容）时才调用 `kb_*` 工具。该段位于 order 100、在 file-reference 段之后，是 `@kb:` 前缀路径的唯一权威裁决——`$DSH_HOME/kb` 下的知识库引用须用 `kb_get` 而非 `read` 读取；`FILE_REFERENCE_PROMPT` 只陈述纯工作区文件规则，不含任何 kb 规则。

引用外观走注册表扩展而非封闭联合：ui-kb 经 `ctx.referenceAppearances` 注册 `{ kind: 'kb', tokenPrefixes: ['kb:'] }`，transcript 里 `@kb:` chip 经贡献的 chain slot 占位用知识库图标渲染。

`kb_search` 的工具描述也指示 agent 先把口语化表述（如「那篇讲用户习惯的」）展开为 2–4 个候选关键词再搜索，因此用户措辞若没包含存储用词，仍能召回文档 —— 这一步发生在按需 gate 之内，无搜索时零成本。

## Alternatives considered

**把知识库候选走 `@file`。** 否决：`@file` 语法与 `fileReferences` 发现都限定工作区；`@kb:` 路径会浮出为工作区文件、对 `read` 失败；在单个语法里抑制它又会泄漏进共享 token 解析器。

**另设触发（如 `#kb`）而非扩展 `@`。** 否决：用户引用时已习惯 `@`，另设第二触发会把本属同一菜单的域拆散引用心智。

**用 `kb_search`（BM25）做候选列表。** 否决：BM25 会匹配正文内容，所以像 `@kb:2026` 这样的裸文件名前缀会浮出所有含「2026」的文档而非标题前缀；输入补全的契合方案是 `list`＋客户端标题／路径前缀过滤，且无需新增 Remote 契约（`kb.list` 已存在）。

**把 `@kb:` 例外留给 `FILE_REFERENCE_PROMPT`。** 否决：把同一语法拆到两个提示词段会招致漂移；kb 段的 order-100 位置使它成为知识库路径的唯一权威裁决，file-reference 段不含任何 kb 规则。

## Verification

`packages/client/ui-kb` 的引用来源 spec 钉住 kb 域：来源注册、标题／路径前缀列举、`kb:` 命名空间剥离、quoted 抑制、以及带贡献外观的原子 `@kb:` 插入；`ui-input-trigger` 的服务 spec 钉住 appearance 注册表。`ui-conversation` 的 spec 钉住贡献图标路由与无占位默认。`tool-kb` 的注册 spec 钉住 order-100 段文本。`examples/kb-agent` 快照无密钥地钉住组装后的提示词与全部 16 个工具 schema。既有的 `chat-view` `/compact` 无历史与 `kb_rename` 失败与此无关，并在干净基线上已确认。

## Consequences

输入框补全现在通过统一的 `@` 菜单触及知识库，用户可以敲 `@` 选中一篇由 agent 用 `kb_get` 读取的笔记。普通对话成本下降，因为明确指示 agent 除非用户传达引用意图否则不检索库；代价是当用户措辞未命中触发词时，确实相关的搜索会被跳过 —— 由 `@kb:`/`[[title]]` 强触发与提示词里的库内相对路径提示缓解。`@kb:` 引用保持路径文本（不附内容），因此仍可经 `kb_get` 审计。贡献外观是注册表上的机械扩展；kb 图标复用现有 outline 图标。知识库引用仍依赖宿主 `kb` 服务（工具是硬消费方），没有它的部署只是没有 kb 候选与 `kb_get`。
