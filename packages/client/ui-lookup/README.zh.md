# @deepseek-ai/dsh-client-ui-lookup

[English](README.md) | 中文

Web 查词特性：在应用任意处选中一个词（会话是主要表面），选中末尾出现浮动操作条，打开带翻译、英语词典释义与百科介绍的结果卡片。模型生成的详细解释搭乘 api-remotes 挂载的 `lookupLlm` Remote 命名空间；免费词典源（MyMemory 翻译、Free Dictionary API、Wikipedia REST 摘要）由浏览器直接抓取，从不触及模型。

覆盖层在布局声明的 `shell.overlay` 全帧层注册一个入口，因此它经 slot 系统组合，无需改动 ui-conversation 或任何其他包。选择处理是文档级的（mouseup、Escape、滚动关闭），所有状态都是组件本地的，解释调用经调用方 ctx 上的注入面到达。

## 模型体验

间接地，经 `lookupLlm/explain` Remote，解释按钮触发一次模型请求，由 [`@deepseek-ai/dsh-host-lookup-llm`](../../host/lookup-llm/README.md) 拥有，包括其 token 成本与 prompt；浏览器侧词典抓取从不触及模型。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **免费源质量参差** —— MyMemory 与 Free Dictionary API 是未认证的免费端点；中文词覆盖薄，翻译可能照字面。模型解释是质量回退。
- **解释调用不入会话日志** —— 辅助 LLM 调用是用户发起的 UI 输出，不是模型可见的会话输入，因此不追加会话事件；需要完整审计链的部署可扩展端点以记录到当前会话。
- **按文件覆盖率低于 CI 门槛** —— 覆盖层的 DOM 密集分支需要更多 spec 才能让 `test:coverage` 变绿。
