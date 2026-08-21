# @deepseek-ai/dsh-habits-settings

[English](README.md) | 中文

DeepSeek Harness habits seam 的 settings 后端 Service Provider。把 `global` 层习惯条目存入用户设置命名空间 `user-habits`（schema 校验、串行写入、`settings/updated` 事件流），并注册规范化的带预算常驻提示段，因此已确认的习惯在删除前会进入每次模型请求。

契约、守卫、合并与提交事件在 [`@deepseek-ai/dsh-user-habits`](../user-habits/README.md) 中；本包只实现存储钩子与常驻段。

## 配置

| 键 | 默认 | 含义 |
|---|---|---:|
| `maxEntryChars` | `200` | 单条字符预算，转发给契约守卫 |
| `residentTokenBudget` | `600` | 常驻提示段的硬 token 上限 |

命名空间以 `base: { entries: [] }` 注册，因此用户尚未存储任何内容时 section 即可解析。注册是本插件 fiber 上的效果：卸载提供方会一并移除命名空间与提示段。

## 常驻段

注册为 `user-habits` section，order `50`（部署 persona 之后、工具引导之前）。文本提供方按 token 预算渲染已提交的 `global` 条目：先渲染固定标题，再按 id 顺序渲染完整的 `- [{topic}] {value}` 行；条目要么整条包含，要么整条省略——绝不截断。被省略的条目产生可见通知 `部分用户习惯因超出注入预算未展示(N 条)。需要时用 memory_list 查看。`。片段计价使用 `dsh-token-meter` 的 `estimate.ts` 共享固定密度启发式（每 token 4 个码点 + 每片段开销）。

## 模型体验

### 模型看到什么

插件挂载且存在条目时，渲染后的 section 在每次装配中进入系统提示词：

```markdown
## 用户习惯

以下为该用户确认过的偏好。撰写回复时主动遵守;同主题条目以项目级为准。

- [lang] 回复语言:中文
```

### Token 影响

受 `residentTokenBudget` 约束（共享启发式下默认 600 tokens）；无条目时提示词中不出现该 section。

### KV Cache 影响

section 的名称、顺序与条目排序稳定，条目文本只在习惯提交时变化——在习惯写入前，提示词前缀在请求间保持可复用。

## 已知限制与暂缓事项

- 并发写入在 settings 命名空间内串行，但两个交错调用方的读-改-写仍可能丢掉其中一方的条目（`SettingsScope` 面没有 compare-and-set）。预期调用方（单个模型轮次）顺序写入；基于 CAS 的持久化是暂缓工作。
- token 预算直接使用固定密度启发式而非 `ctx.tokenMeter` 服务，以保持包在 headless 组合中可用；密度常量与 `token-meter` 的 `estimate.ts` 一致。
- 仅存储 `global` 层。`project` 层（工作区 `USER.md`）按设计记录由兄弟提供方实现。
- section 只渲染 `global` 条目；项目覆盖全局的合并是文件提供方的渲染职责。
