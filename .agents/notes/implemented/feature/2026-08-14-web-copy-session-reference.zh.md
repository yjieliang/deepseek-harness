# Agent Note: Web 复制会话引用头部按钮与共享 mention 语法

Status: implemented

English | [中文](2026-08-14-web-copy-session-reference.zh.md)

## Problem

用户在某个会话里，需要一种方式把「本会话」的引用交给另一个会话。`@` 自动补全已经在 Host 侧为其他会话生成规范的 `@[label](dsh-session:…)` mention，但没有入口可以复制当前会话自身的引用；而且规范的 mention 编码器放在仅 Host 可用的模块里（基于 `Buffer`），浏览器客户端无法在不重新实现 base64url 的情况下自行生成 mention。

## Decision

- `src/uri.ts` 中浏览器安全的编码部分被拆到新的 `src/grammar.ts`，它不引入任何 Node 内建模块：`SESSION_REFERENCE_SCHEME`、`encodeSessionReferenceUri` 与 `formatSessionReferenceMention`。一个手写的、基于 `TextEncoder` 字节的无填充 base64url 编码器取代了 `Buffer.toString('base64url')`，并验证与其逐字节一致。`uri.ts` 保留仅 Host 使用的解码/解析路径（`Buffer`、`SessionId()`、`SessionReferenceError`），并重新导出 grammar 符号，因此包根部的导出入口不变。
- 包新增 `@deepseek-ai/dsh-session-reference/grammar` 子路径，对齐 `@deepseek-ai/dsh-file-reference/grammar`；由于 `session-reference` 是没有 `dsh.client` 清单的普通包，客户端把它作为私有副本打包。
- `ui-reference` 注册一个 id 为 `session-reference-copy` 的 `conversation.session.header.utilities` 列表条目，渲染 `SessionReferenceCopyAction`。按钮通过 `useSessions` 读取会话的持久标题，用共享 grammar 生成 mention（label = 标题，缺失时回退到 id），并通过 `writeClipboard` 写入剪贴板，带有一秒成功反馈（复制图标切换为对勾）。

## Alternatives considered

- **用 Host Remote 方法返回自身 mention** —— 编码保持在 Host 侧，但为一个纯字符串变换增加一次网络往返，并新增 typert Remote 面。`file-reference/grammar` 的先例已经确立了「客户端纯语法模块」这一模式。
- **在客户端重新实现 base64url** —— 在浏览器里重复规范编码，容易与 Host 的规范形式漂移。抽取共享 grammar 让 URI 字节保持单一权威。
- **复制裸的 `session-<n>` id** —— 裸 id 不会被 `parseSessionReferenceText` 识别，也没有人类可读的标签；规范的 mention 才是引用服务实际解析的形式，所以按钮复制它。

## Consequences

- 单一编码权威：浏览器与 Host 生成相同的 URI 字节。解码/解析仍为 Host 专用并使用 `Buffer`；磁盘与线上的 URI 格式不变。
- 会话头部新增一个右对齐的实用按钮；其文案并入现有的 `reference` 语言命名空间（`copy.aria`）。
- `ui-reference` 现在声明 `slots`、`ui-conversation`、`ui-primitives` 依赖以注册头部条目。

## Testing

- session-reference 测试断言手写编码器在 ASCII 与 Unicode id 上与 `Buffer.toString('base64url')` 逐字节一致。
- ui-reference 浏览器测试断言头部条目注册与注销；组件测试断言剪贴板写入、反馈防抖、标题/id 标签回退、被拒写入的重试，以及卸载时的定时器清理。
