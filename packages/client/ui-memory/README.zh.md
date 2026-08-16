# @deepseek-ai/dsh-client-ui-memory

[English](README.md) | 中文

Web 记忆界面插件：其浏览器半部分在根作用域的 `settings.section` 槽中注册 `memory` 条目 —— 即列出、添加、编辑和删除全局用户习惯的设置页。它的 Node 半部分刻意留空：页面编辑的 `user-habits` 设置命名空间属于宿主契约，由 `dsh-habits-settings` 拥有，本插件只通过 wire 呈现它（`settings.describe` 读取，`settings.replace` 加 `expectedRevision` 写入）。

用户手动编辑时维护与宿主 `HabitService` 相同的簿记 —— 内容变化时版本号递增并刷新 `updatedAt`，所有在此写入的条目 `source` 均为 `'user'` —— 因为浏览器无法访问该服务。宿主的命名空间校验在每次写入时仍然执行，因此守卫无法从 UI 绕过：超预算内容始终被拒绝；触发注入/密钥守卫的内容先被拒绝一次，然后提供一次「仍然保存」，落库时持久化 `guardConfirmed` —— 这正是守卫要求的人类确认。

页面监听转发的 `settings/document-updated` 事件自动重读，因此会话里 `memory_add` 工具写入的条目在设置面板保持打开时也会出现。

## Model Experience

间接经由 `dsh-tool-memory`；该包拥有模型可见的工具 schema 与结构化结果，而宿主常驻提示词段落渲染的正是本页编辑的同批条目。

#### KV Cache effect

无直接影响；`dsh-user-habits` 拥有会变化的注入段落。

## Known Limitations and Deferred Work

- **读取依赖仅限回环的 `settings.describe`** —— 经局域网连接的浏览器看到的是带重试按钮的错误态而非条目，这是所有设置界面共享的约束。
- **并发编辑会失败而非合并** —— 携带过期 `expectedRevision` 的写入被宿主拒绝后页面重读，由用户重新应用修改。
