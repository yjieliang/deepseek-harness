---
title: Agent 记忆开源项目调研:用户记忆与外部 Memory Provider
aliases: [记忆调研, memory provider 调研, 用户记忆调研]
tags: [记忆, agent, 调研, 开源项目]
summary: 调研 Mem0、Letta(MemGPT)、Zep/Graphiti、LangMem、Basic Memory、Memobase、Cognee、Memary、MCP Memory Server 等热门开源项目,聚焦用户记忆(user memory)与外部 memory provider 两个方向的设计模式,提炼可借鉴要点。
created: 2026-08-15
updated: 2026-08-15
---

# Agent 记忆开源项目调研:用户记忆与外部 Memory Provider

> 调研目的:为「用户习惯记忆系统」设计找参考,聚焦两个方向 —— **用户记忆**(如何记住一个用户的偏好/习惯)与**外部 Memory Provider**(记忆如何做成可插拔的外部服务)。
> 调研时间:2026-08-15。项目热度、版本与设计随时间变化,引用时以官方仓库为准。

---

## 1. 项目总览

| 项目 | 一句话定位 | 用户记忆 | 外部 Provider |
|---|---|---|---|
| [Mem0](https://github.com/mem0ai/mem0) | 最流行的 agent 记忆层 SDK/平台 | ✅ 核心能力(user/agent/run 维度隔离) | ✅ 核心能力(托管平台 + 20+ 向量/图库后端) |
| [Letta(MemGPT)](https://docs.letta.com/concepts/memgpt/) | 带记忆块的 agent 框架/服务器 | ✅ 人格/人类记忆块 | ✅ Letta Server 即外部记忆服务 |
| [Zep](https://github.com/getzep/zep) / [Graphiti](https://github.com/getzep/graphiti) | 时序知识图谱记忆引擎 | ✅ user/group 维度 | ✅ 记忆服务器 + SDK |
| [LangMem](https://github.com/langchain-ai/langmem) | LangChain 记忆 SDK | ✅ profiles(用户档案) | ✅ BaseStore 可插拔后端 |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | 本地 Markdown + 知识图谱记忆 | ⚠️ 项目级为主 | ❌ 本地优先 |
| [Memobase](https://github.com/memodb-io/memobase) | 用户档案型长期记忆 | ✅ 核心能力(profiles) | ✅ 服务化 |
| [Cognee](https://github.com/topoteretes/cognee) | 知识图谱 + 向量记忆引擎 | ⚠️ 数据级为主 | ✅ 多种后端 |
| [Memary](https://github.com/MemaryAI/MemaryAI) | 仿人脑分层记忆层 | ⚠️ 通用 | ❌ 以 Neo4j 为存储 |
| [MCP Memory Server](https://github.com/modelcontextprotocol/servers) | 官方知识图谱记忆 MCP 服务器 | ⚠️ 无隔离 | ✅ MCP 协议即外部化 |
| Claude Code memory([文档](https://code.claude.com/docs/en/memory)) | 文件式记忆(闭源但影响大) | ✅ CLAUDE.md 层级 | ❌ 文件约定 |

---

## 2. 用户记忆(user memory)设计模式

### 2.1 Mem0:三维度隔离 + LLM 提取管线

Mem0 是用户记忆设计最成熟的参考。核心 API:

```python
m.add("用户偏好 Python", user_id="alice")   # 按 user_id 隔离
m.search("技术栈", user_id="alice")          # 只召回该用户的记忆
```

**关键设计**:
- **记忆归属三维度**:`user_id`(用户)、`agent_id`(agent)、`run_id`(会话)—— 三个维度可组合隔离,天然对应"用户记忆/项目记忆/会话记忆"分层
- **写入管线**:LLM 先做**提取(extraction)**—— 从自由文本中抽取事实,再**去重合并(consolidation)**—— 与已有记忆做 LLM 比对,决定 add/update/delete/no-op,最后入库。这解决了"同一件事记了 5 遍"的问题
- **检索**:混合检索(向量 + 全文 + 图),带 metadata 过滤(按 user/agent/维度过滤)
- **记忆形态**:纯 fact 条目(fact 文本 + 元数据 + 时间戳),不是自由文档

**对我们的启发**:合并(consolidation)是用户记忆的必备环节 —— 用户记忆必须能"更新旧事实"而不是无限追加;这正是我们方案里 `replace` 子串操作 + 去重的理论来源。

### 2.2 LangMem:profiles + 四类记忆的显式分离

LangMem 把记忆**按内容类型**显式分四类([概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)):

- **semantic**(语义):事实与知识
- **episodic**(情景):过去经历的记录
- **procedural**(程序):技能与流程
- **profiles**(档案):**用户偏好、行为模式 —— 就是"用户记忆"**

**关键设计**:
- 记忆是**带类型标签的条目**,检索时可按类型过滤 —— 用户档案与项目知识不会混在一起
- 核心操作循环:**collect → consolidate → update → recall**,与 Mem0 同构(提取→合并→更新→召回)
- 存储解耦:**BaseStore** 抽象,可换 Postgres/SQLite/内存 —— 即"外部 provider"接口在 SDK 内的形态

**对我们的启发**:profiles 是"用户记忆"的成熟命名与建模;四类分离避免"把用户偏好当通用知识检索"。我们方案的 `topic` 字段(style/lang/commit)就是 profiles 的轻量版。

### 2.3 Memobase:纯用户档案定位

[Memobase](https://github.com/memodb-io/memobase) 的定位只有一句话:**User Profile-Based Long-Term Memory**。

**关键设计**:
- 数据模型 = **profiles + events 时间线**:每次对话事件 append 进时间线,profiles 是从事件流中**提炼出的用户画像**
- 用 profiles 的生成质量作为记忆好坏标准(LOCOMO 基准)—— 衡量标准是"记住了用户是谁",而不是"存了多少文档"
- 服务化部署,SDK 面向 chatbot 应用

**对我们的启发**:"用户记忆"可以完全独立于其他记忆存在,且它的价值度量是**画像质量**(回答时能否正确应用用户偏好),不是存储量。

### 2.4 Claude Code:文件即记忆的层级约定

虽然不是开源项目,但 CLAUDE.md 机制是文件式用户记忆的事实标准([官方文档](https://code.claude.com/docs/en/memory)):

- **层级**:`~/.claude/CLAUDE.md`(用户全局)→ 项目根 `CLAUDE.md` → 子目录 `CLAUDE.md`(就近生效)
- **形态**:纯 Markdown,人可直接编辑,`# 快捷引用` 语法按需加载片段
- **半自动**:import 机制、agent 可主动写入

**对我们的启发**:DSH 的 `AGENTS.md` 注入链已经实现了这套机制(dsh-agent-instructions 插件),我们的习惯记忆方案就是把它扩展到"用户习惯"语义 + 加上确认闸门。

### 2.5 Letta:人格块与人类块

Letta 的 memory blocks 里,**persona block**(agent 性格)与 **human block**(用户信息)是常驻上下文块([MemGPT 概念](https://docs.letta.com/concepts/memgpt/)):

- 块是**带标签的文本块**,可被 LLM 通过工具按需改写(memory edit)
- 常驻块 vs 归档块:core memory 永远在上下文,archival memory 按需检索
- 块可以被共享、版本化、作为"人格文件"分发

**对我们的启发**:用户记忆放"常驻块"、细节放"归档块"的二分,就是我们方案"常驻注入 vs 按需检索"的对应物。

---

## 3. 外部 Memory Provider 设计模式

### 3.1 模式 A:SDK + 可插拔存储后端(Mem0 / LangMem)

记忆逻辑(提取/合并/检索)留在 SDK 内,存储后端可插拔:

- Mem0 支持 20+ 后端:向量库(Qdrant/Pinecone/Chroma/Weaviate…)、图库(Neo4j/Memgraph/Neptune…)、[与 AWS ElastiCache/Neptune 的托管集成](https://mem0.ai/blog/build-persistent-memory-for-agentic-ai-applications-with-mem0-open-source-amazon-elasticache-for-valkey-and-amazon-neptune-analytics)
- 配置一个 `vector_store` + 可选 `graph_store` 即完成切换
- **provider 接口 = 存储抽象**:提取/合并逻辑不随后端变

### 3.2 模式 B:独立记忆服务器(Mem0 Platform / Letta Server / Zep)

记忆作为**独立部署的服务**,agent 通过 SDK/HTTP 调用:

- **Mem0 Platform**:托管记忆服务,带 [Strands(会话线程)](https://mem0.ai/blog/aws-and-mem0-partner-to-bring-persistent-memory-to-next-gen-ai-agents-with-strands) —— 多 agent 共享一个记忆后端
- **Letta Server**:agent 状态(含记忆块)常驻服务器,客户端无状态连接,支持 sleep-time compute(agent 下线后继续后台处理)
- **Zep**:记忆服务器形态,Zep 是产品,Graphiti 是内核引擎

**关键收益**:记忆与 agent 进程解耦 —— agent 重启记忆不丢;多个 agent 共享一个记忆源。

### 3.3 模式 C:知识图谱内核(Graphiti / Cognee / Basic Memory / MCP Memory)

用**图**组织记忆,而不是文档或纯向量:

**Graphiti(Zep 内核,[论文](https://ar5iv.labs.arxiv.org/html/2501.13956))**:
- **双时序(temporal)模型**:生物时间(现实世界时间)+ 会话时间(对话内相对时间),每个事实带有效期 —— 记忆会"过时"(bi-temporal)
- 事实 → 节点 + 边(实体/关系),持续增量合并
- 检索 = 语义向量 + 全文 + 图遍历混合

**Cognee([ECL 管线](https://www.zenml.io/llmops-database/building-ai-memory-layers-with-file-based-vector-storage-and-knowledge-graphs))**:
- ECL = **Extract-Cognify-Load**:提取 → 认知化(建图、聚类、向量化)→ 加载
- 文件/原始数据优先,图与向量是派生物;支持多种向量与图后端

**Basic Memory([仓库](https://github.com/basicmachines-co/basic-memory))**:
- **Markdown 笔记 + SQLite FTS + 知识图谱三元组**(entity-relation-observation)三层并存
- 本地优先、人可读优先 —— 与我们的 kb/ 设计同源
- 语义检索可插拔(OpenAI/本地 embedding)

**MCP Memory Server([官方参考实现](https://github.com/modelcontextprotocol/servers/tree/main/src/memory))**:
- 最小知识图谱:entities / relations / observations 三元组 + JSON 文件持久化
- 通过 **MCP 协议**暴露 —— 任何 MCP client 都能获得记忆能力,这是"外部 provider"的协议级标准化

**对我们的启发**:外部 provider 的关键不在"图还是向量",而在**协议边界** —— MCP 是当前事实标准,DSH 已有 `dsh-mcp-client`,外部记忆服务理论上可以经 MCP 接入,这正是架构图里"外部 Provider / Pluggable Semantic Memory"一层的落法。

### 3.4 模式 D:路由式分层记忆(Memary)

[Memary](https://github.com/MemaryAI/MemaryAI) 仿人脑把记忆分**工作记忆 + 情景记忆 + 语义记忆**三层,由一个 **routing agent** 决定新信息流向哪一层、检索时走哪层。

**对我们的启发**:分层本身各家都有,Memary 的特色是"路由"显式化 —— 信息流向由模型决策。我们方案的"常驻 vs 按需"二分可以看作路由的最简形态。

---

## 4. 横向对比

| 维度 | Mem0 | Letta | Zep/Graphiti | LangMem | Basic Memory | Memobase | Claude Code |
|---|---|---|---|---|---|---|---|
| 记忆单元 | fact 条目 | 记忆块 | 图谱事实(双时序) | 类型化条目 | md 笔记+三元组 | profile+事件流 | md 文件 |
| 用户隔离 | user_id | human block | user/group | profiles | 弱 | 核心 | 目录层级 |
| 写入去重 | LLM 合并 | 工具改写 | 增量合并 | consolidate | 人工/AI | 事件提炼 | 人工编辑 |
| 常驻 vs 检索 | 全检索 | core 常驻+archival 检索 | 全检索 | 全检索 | 全检索 | 注入画像 | 层级常驻+@引用 |
| 外部化 | 平台+多后端 | server | server | BaseStore | 本地 | server | 无 |
| 人可读/可编辑 | ❌ | 半 | ❌ | ❌ | ✅ | 半 | ✅ |
| 时序/过期 | ✅ 有 | ❌ | ✅ 双时序 | ❌ | ❌ | ✅ 时间线 | ❌ |

---

## 5. 对用户习惯记忆方案的印证与修正

结合调研,对我们已定的方案做三点印证、一点修正:

1. **印证「用户确认是唯一放行键」**:所有自动写入方案(Mem0 提取、LangMem collect)都面临"自动记忆污染 prompt"的问题,只有 Claude Code 的文件式 + 人工编辑和我们的半自动确认制把最终控制权留给用户。调研强化了这个选择。

2. **印证「consolidation 必须做」**:Mem0/LangMem 的提取→合并管线说明,"同一习惯记了 N 遍"是必须显式解决的问题。我们方案用 `replace` 子串操作 + 提议去重解决,调研后建议**再补一条:入库前与已有条目做相似度比对,重复时提示"更新已有条目"而非新增**(Mem0 的 update 分支)。

3. **印证「profiles 独立建模」**:LangMem/Memobase 都把用户档案作为独立记忆类型,不与项目知识混存。我们方案 L1(全局用户习惯)独立 namespace、topic 标签化的设计与之对齐。

4. **修正「外部 provider 的优先级」**:原方案把"外部语义记忆 provider"放在 kb Phase 3(远期)。调研显示 **MCP 已是外部记忆的事实标准协议**,而 DSH 已有 `dsh-mcp-client` —— 外部记忆接入的成本比预想低。建议把"MCP 记忆服务器接入"作为 Phase 2.5 的可选项:先接一个最小 MCP Memory Server 验证协议链路,再决定要不要自研语义后端。

---

## 6. 主要参考

- [Mem0 官方博客:AWS 持久记忆集成](https://mem0.ai/blog/build-persistent-memory-for-agentic-ai-applications-with-mem0-open-source-amazon-elasticache-for-valkey-and-amazon-neptune-analytics)
- [Mem0 × AWS Strands](https://mem0.ai/blog/aws-and-mem0-partner-to-bring-persistent-memory-to-next-gen-ai-agents-with-strands)
- [Letta/MemGPT 概念文档](https://docs.letta.com/concepts/memgpt/)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory(论文)](https://ar5iv.labs.arxiv.org/html/2501.13956)
- [LangMem 概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [LangMem SDK 发布博客](https://www.langchain.com/blog/langmem-sdk-launch)
- [Basic Memory 仓库](https://github.com/basicmachines-co/basic-memory)
- [Memobase 仓库](https://github.com/memodb-io/memobase)
- [Cognee(ZenML 分析)](https://www.zenml.io/llmops-database/building-ai-memory-layers-with-file-based-vector-storage-and-knowledge-graphs)
- [Memary 仓库](https://github.com/MemaryAI/MemaryAI)
- [MCP Memory Server 官方实现](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
- [Claude Code memory 文档](https://code.claude.com/docs/en/memory)

## 7. 关联文档

- [[用户习惯记忆系统设计方案]](30-工作文档)—— 本调研直接服务的设计方案
- [[RAG 核心概念]] —— 语义检索底层概念
