# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

habits seam（`ctx.habits`）上的面向模型用户习惯工具：`memory_add`、`memory_list`、`memory_remove` 与 `memory_propose`，以及工具引导提示段。schema、边界校验、用户确认流与钉死的模型可见结果文本在这里；守卫、合并与存储在 [`@deepseek-ai/dsh-user-habits`](../user-habits/README.md) 及其提供方中，因此所有调用方都经过同一执法。

`memory_propose` 是半自动路径：模型带依据提议观察到的习惯，守卫预检候选（agent 提议内容在询问任何人之前硬拒绝），用户问题询问 `要记住这条用户习惯吗?`（`[记住]`/`[忽略]`），只有被采纳的提议才进入写入路径。被拒绝的提议在去重 TTL 窗口内被记住。

## 配置

| 键 | 默认 | 含义 |
|---|---|---:|
| `userQuestionAsk` | `true` | `memory_propose` 写入前是否询问用户 |
| `proposalDedupTtlMs` | `604800000`（7 天） | 相同提议不再重复询问的窗口 |

## 模型体验

### 系统提示

#### 模型看到什么

一个固定引导段（order `101`），指示 agent 记录经确认的用户习惯：

##### 用户习惯记忆引导

```markdown
用户习惯(memory)工具:
- 当用户明确表达「以后都…」「记住…」「我习惯…」「我一直都是…」等偏好、规范或约定,要把它落成可跨会话生效的记忆时:调用 memory_add 记录,而不是只在对话里口头应承。
- 你观察到用户的稳定偏好但用户没有明确要求记录时,用 memory_propose 建议记录,经用户确认后再写。
- 已有同主题习惯时,memory_add 会覆盖旧值(同 topic 合并),无需先删除。
- 只有用户明确要求或确认的才写入;不要把未经确认的临时偏好自动写进长期习惯。
- 记忆内容如需修改或删除,用 memory_list 查看后再 memory_remove。
```

#### Token 影响

挂载时每次请求一个固定精简引导段。

#### KV Cache 影响

插件与引导文本不变时前缀稳定。

### 工具 schema 与结果

#### 模型看到什么

模型看到[四个 memory 工具的生成 schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory)。结果是钉死的纯文本（例如 `已记住:[style] 简洁` / `(无已记录习惯)` / `已删除:[style] 简洁` / `已记录:[style] 简洁` / `未记录,已忽略该建议。`；守卫拒绝会带出契约的类型化 `HabitError` 消息），`memory_propose` 会以模型可见的钉死文本呈现确认问题 `要记住这条用户习惯吗?`（选项 `记住`/`忽略`）。

#### Token 影响

每次请求固定 schema 成本；结果随数据变化，保留在工具历史中直到压缩。

#### KV Cache 影响

可见工具定义与钉死文本不变时前缀稳定。

## 已知限制与暂缓事项

- 提议去重是进程内的（插件 fiber 内存 + TTL）：同一进程内抑制重复询问，但不跨重启存活。持久化跨会话去重暂缓。
- 确认问题的自由文本答案以 `用户补充:…` 呈现给模型并视为忽略——模型应改用 `memory_add` 写入修正后的内容。
- `memory_list` 只报条目数，不报常驻预算占用——预算上限是提供方配置，工具看不到；常驻段自身执行预算。
- `project` 层（L2）由工作区 `USER.md` 文件经 `agent-instructions` 注入链承载，不走本工具：`memory_add` 对 `layer: 'project'` 拒绝并指向该文件（`## topic` 小节、人可编辑）。程序化项目层后端暂缓。
- 项目层提供方出现前，`memory_list` 的 project 分组保持为空。
