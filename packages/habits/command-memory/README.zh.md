# @deepseek-ai/dsh-command-memory

habits 接缝(`ctx.habits`)上的人类斜杠命令 `/memory`:add、list、remove。命令不经模型轮次直接派发,与模型工具共享完全相同的写入路径,守卫与合并执法对人类与模型一致。守卫命中的 `add`(注入/密钥模式)在存在用户确认通道时弹「仍然记住/算了」确认,确认后以 userConfirmed 覆盖写入。

## Model Experience

无——命令是人类面向界面,不贡献任何面向模型的提示、schema、工具或消息。原始输入会被记录(`recordInput` 默认 true),每次命令执行都能在会话日志中追溯。

## 已知边界与暂缓工作

- `/memory add` 始终写入 `general` 主题;命令级主题选择待面向模型 `memory_add` 的主题语法稳定后补上。
- 命令只报条目数、不报常驻预算占用(上限是提供方配置,命令看不到)。
- `replace` 子命令暂缓;更新习惯用同主题的 `/memory add`(契约合并会更新而非追加)。
- 没有用户确认提供方时(headless 部署),守卫命中的内容保持硬拒——确认覆盖不可用。
