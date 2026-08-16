# Agent Note: User-habit memory system

Status: implemented

[English](2026-08-15-user-habit-memory-system.md) | 中文

## Problem

会话之间没有任何东西记住用户要求 Agent 持续遵守的事情。一次性的请求(「以后都用中文回复」「偏好 kebab-case」)只在说出它的那次对话里被遵守,而且没有一个受守卫、可查看的地方让用户事后看到或撤回已记录的内容。任何长期记忆都会注入提示词,所以模型写下的恶意或密钥内容会直接进入下一次请求——写入路径需要一个强制点,而不是靠文档约定。

## Decision

`habits/` 包族承载两层的用户习惯记忆系统:

- **服务接缝**(`dsh-user-habits`):`ctx.habits` 提供 `write`/`remove`/`list`,同主题确定性合并(更新时版本号递增,值未变时报 `duplicate`),`user-habits/committed` 事件,以及共享守卫(`guardHabitValue`)。守卫按来源分层:`agent-proposed` 命中注入/密钥模式的内容永远硬拒;`user` 来源只有在显式 `userConfirmed` 覆盖时才放行,并被标记 `guardConfirmed`;隐形字符永远剥离;单条字符预算永远拒绝。
- **存储**(`dsh-habits-settings`):`global` 层存于用户设置命名空间 `user-habits`,并按 token-meter 固定密度启发式渲染预算内的常驻提示词段(`user-habits`,order 50)。命名空间注册 `validate`,在设置边界重跑同一套规则:主题格式与预算是硬规则,内容守卫失败只对携带 `guardConfirmed` 的条目放行——人在设置页不能绕过守卫,已确认的覆盖也不会在再次校验时被误杀。
- **模型工具**(`dsh-tool-memory`):`memory_add` / `memory_list` / `memory_remove` / `memory_propose`。`layer: 'project'` 的添加被拒绝并指向工作区 `USER.md`;用户来源写入被守卫拒绝时先弹确认,确认后带 `userConfirmed` 重试;`memory_propose` 先做守卫预检(被拒的建议从不展示),再问一次确认问题,并应用进程内去重 TTL。
- **命令**(`dsh-command-memory`):`/memory add|list|remove`,守卫确认流程与工具一致。
- **项目层**(L2):工作区 `USER.md` 的 `## topic` 小节经 `agent-instructions` 注入链注入(`USER.md` 加入候选文件);`## 用户习惯` 小节由 agent-instructions 显式渲染。
- **设置界面**(`dsh-client-ui-memory`):设置面板的「记忆」页经 `settings.describe` + `settings.replace`(带 `expectedRevision`)列出、添加、编辑、删除全局条目。此处的写入维护同样的簿记(版本递增、`updatedAt`、`source: 'user'`)。守卫拒绝时先展示宿主消息,并提供一次「仍然保存」以落库 `guardConfirmed`;预算拒绝永远不可覆盖。页面监听 `settings/document-updated` 自动重读,工具写入的条目实时出现。

## Guard semantics (pinned)

做出决定的那个操作就是执行强制的那个操作:`HabitService.write` 在持久化前守卫,设置命名空间 `validate` 在 wire 边界守卫,`memory_propose` 在建议展示前预检。`agent-proposed` 永不覆盖。只有显式的人类确认才把用户来源条目翻转为 `guardConfirmed`——这是后续校验放行内容守卫的唯一标记;预算与主题规则对它仍然生效。校验器按相位区分(`load` 与 `write`,`dsh-settings` 契约):主题格式与预算在两个相位都硬拒,内容守卫只在写入相位执行——因此 `guardConfirmed` 出现之前写入的存量条目可以加载,并在启动时一次性迁移打上该标记,而不是拒绝整个插件。

## Alternatives considered

### 为什么不用外部记忆 Provider(Mem0、Letta、Zep、LangMem…)?

对当前主流开源记忆系统的调研表明,它们都用第二个存储、新的 wire 协议和自有注入循环来换取 harness 自身的接缝。habits 接缝保持单一存储(用户设置)、单一注入路径(系统提示词段)以及 harness 自有的守卫/预算机制;模型写下的文本不交给任何外部系统。

### 为什么不让设置页绕过校验直接写命名空间?

设置 wire 会成为守卫旁路的第二条写入路径——正是守卫要关闭的那个洞。命名空间 `validate` 对每次写入都执行,两条路径(工具与设置页)收敛到同一套规则;`guardConfirmed` 标记让人类确认过的条目在两条路径下都合法。

### 为什么不做成模型可见的设置工具而是做成设置页?

模型可见的工具每敲一键都要序列化整个命名空间,也无法呈现守卫的确认流程;设置页把编辑留在 UI 域,与模型可见面(`memory_*`)分离。

## Consequences

- 接缝、工具与页面共享一个权威存储;常驻段、`memory_list` 与设置页投影同一批条目。
- 用户撰写的疑似恶意内容只有经显式确认才能入库,且该事实持久化(`guardConfirmed`),后续编辑不会静默再次拒绝它。
- 设置页经 `settings.describe` 读取,该接口仅限回环;局域网浏览器看到的是页面的错误态,这是所有设置界面共享的约束。
- 暂缓项:跨会话持久建议去重、程序化 L2 文件后端、`memory_list` 中的预算占用展示。

## Testing

`packages/habits` 套件覆盖守卫矩阵、确定性合并、提交事件与命名空间校验器;`packages/client/ui-memory` 覆盖控制器(wire 解析、revision 冲突、一次性覆盖)与页面可见行为。两侧聚合均通过类型检查;`test:gui` 与 `verify-package-invariants`(229 个伴生包)通过。
