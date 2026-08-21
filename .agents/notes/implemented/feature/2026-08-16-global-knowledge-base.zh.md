# Agent Note: Global knowledge-base root

Status: implemented

[English](2026-08-16-global-knowledge-base.md) | 中文

## Problem

知识库原本限定在当前工作区(`<workspace>/kb`)，因此一个人的笔记在同一台机器的其他项目里都不可见。个人知识库按意图应当是机器级的，而不是按仓库划分；按工作区的形态还会把库拆散到每个克隆出来的检出目录里。

## Decision

库根现在改为机器全局：`@deepseek-ai/dsh-host-kb` 新增 `root` 配置(默认 `$DSH_HOME/kb`，绝对路径或相对 harness home 的路径)，引擎把每个库相对路径直接解析到该根下，而不是会话工作区下。因为根在工作区之外，沙箱接缝新增一项由部署声明的放行：`SandboxExecutionPolicy.writableRoots` 在 `workspace-write` 下额外放行一组规范化根(绝不拓宽 `read-only` 或 `danger-full-access`)，web-app bundle 在 `kb` 行的 `root` 旁把它设为 `$DSH_HOME/kb`。部署迁移库时必须同步移动这两处。

## Alternatives considered

### 为什么不做双层库(工作区 + 全局)?

分层会镜像习惯记忆的 L1/L2 划分，但用户要的是一个共享库，而且工具/面板词汇还没有层的概念；第二层会是投机性界面。单一全局根用最少的词汇满足了需求。

### 为什么不把根保留为工作区相对的配置值?

默认为工作区的可配置根保持了向后兼容，但用户明确选择只做全局，而按工作区的默认值会留下这次改动要消除的同样碎片化。

### 为什么不让 kb 引擎绕过沙箱?

引擎通过沙箱化的 `fs` 服务写入；绕过它会让一条模型可写的路径豁免于共享文件策略。通过 `writableRoots` 放行库根，既让每次写入都留在沙箱接缝上，又把「额外受控可写区」变成一等、可复用的策略概念。

## Consequences

- 库被本机所有工作区共享；新机器的空库由引擎在首次使用时物化。
- 既有工作区库不会自动移动——迁移是操作者的一次性拷贝。
- `writableRoots` 是通用沙箱能力，不是 kb 专属的后门；未来的机器级存储都能复用它。
- `read-only` 与 `danger-full-access` 不受新字段影响。

## Testing

`sandbox` roots 与 `sandbox-policy` resolve 测试覆盖额外根的派生与透传；`fs-sandbox` 经共享允许列表执行它；`host-kb` 引擎与工具套件在临时绝对根上运行。Windows ACL runner 集成测试仍受宿主环境门控。
