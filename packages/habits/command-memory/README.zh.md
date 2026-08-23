# @deepseek-ai/dsh-command-memory

[English](README.md) | 中文

habits seam（`ctx.habits`）上的人类斜杠命令 `/memory`：add、list、remove。命令不经模型轮次直接派发，与模型工具共享完全相同的写入路径，因此守卫与合并对人类和模型执行一致。被守卫拦截的 `add`（注入/密钥模式）在用户问题通道存在时会询问「仍然记住/算了」确认，确认后以 `userConfirmed` 覆盖写入。

## 模型体验

间接地，通过会话日志中记录的 `/memory` 命令执行；命令本身不注册任何提示词、schema、工具或消息。

#### KV Cache 影响

记录的命令事件为追加式，不改变提示词前缀。

## 已知限制与暂缓事项

- `/memory add` 始终写入 `general` 主题；命令级主题选择待面向模型 `memory_add` 的主题语法稳定后补上。
- 命令只报条目数，不报常驻预算占用（上限是提供方配置，命令看不到）。
- `replace` 子命令暂缓；更新习惯用同主题的 `/memory add`（契约合并会更新而非追加）。
- 没有用户问题提供方时（headless 部署），被守卫拦截的内容保持硬拒绝——确认覆盖不可用。
