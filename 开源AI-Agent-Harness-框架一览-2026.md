# 开源 AI Agent Harness / 智能体框架 项目一览（2026）

来源：
- [Atlan — Top AI Agent Harness Tools and Frameworks 2026: Complete Guide](https://atlan.com/know/best-ai-agent-harness-tools-2026/)（已通读全文）
- [FutureAGI — Comparing Open-Source AI Agent Frameworks in 2026](https://futureagi.com/blog/oss-agent-frameworks-2026/)（未能通读，置信度见文末）

---

## 一、Atlan 文章（11 个工具 + 1 个自推销项）

### 1. 编排框架（Orchestration Frameworks）

| 项目 | 链接 | 定位 / 关键特性 | 文章要点（适用场景 / 对比） |
|---|---|---|---|
| **LangGraph** | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)（文内: langchain.com/langgraph） | 基于图的（graph-based）多智能体编排框架，通过条件边、checkpoint、流式输出提供对 agent 状态的显式控制 | 文内基准任务成功率 87%（本清单最高）；适合需要精细状态控制的**生产级有状态多智能体流程**；与 LangSmith 深度集成做可观测性；学习曲线陡，简单流程配置啰嗦。MIT；LangSmith 云端付费 |
| **CrewAI** | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI)（文内: crewai.com） | 基于角色的多智能体框架，「agents as employees」，原生 MCP/A2A 支持 | 45,900+ 星、平均 1.8s 延迟（文内称主流框架中最快）——**从零到可运行多智能体原型最快**；CrewAI Studio 无代码构建；缺点：并发日志难调试、状态控制粒度不如 LangGraph。OSS 核心 + ~$99/月 AOP |
| **AutoGen / AG2（微软）** | [microsoft/autogen](https://github.com/microsoft/autogen)（文内: microsoft.github.io/autogen） | 对话式多智能体框架，Docker 原生沙箱化代码执行 | **代码沙箱执行、迭代调试、多轮 agent 辩论/精化**；54,000+ 星（本清单最高）；已知失败模式「两个 agent 无限循环」需人工介入；上下文需手动裁剪。MIT |
| **LangChain deepagents** | [langchain-ai/langchain](https://github.com/langchain-ai/langchain)（文内: langchain.com/deep-agents） | LangChain 生态的全栈 agent harness：write_todos 规划、文件系统上下文卸载、子代理派生、自动摘要压缩 | 面向**复杂长时程（long-horizon）多步骤任务**；2026-03 的 0.2 版，100% 开源；较新（2025 底发布）；压缩/摘要可能静默丢失数据溯源。MIT |
| **Microsoft Semantic Kernel** | [microsoft/semantic-kernel](https://github.com/microsoft/semantic-kernel) | 企业级编排框架，C#/Python/Java 多语言 SDK，原生集成 Azure OpenAI、Copilot Studio、Microsoft Graph | **.NET / 微软技术栈企业**首选；编译期类型安全（compile-time validation）；27,000+ 星；强绑定微软平台、开源生态较小。MIT；Azure 服务费用另计 |
| **Mastra** | [mastra-ai/mastra](https://github.com/mastra-ai/mastra)（文内: mastra.ai） | TypeScript 优先框架，核心卖点是「观察式记忆」（后台 Observer/Reflector agent 持续把对话压缩为结构化观察） | **TypeScript/Node.js 团队**、需要自动维护上下文质量者；19,000+ 星、30 万+ 周 npm 下载；2026-03 发布企业级 RBAC；原生 MCP；仅 TS，记忆机制有后台开销。OSS 核心 + 企业版（价格未公开） |

### 2. 开源 Harness 运行时（Open-Source Harness Runtimes）

| 项目 | 链接 | 定位 / 关键特性 | 文章要点（适用场景 / 对比） |
|---|---|---|---|
| **OpenHarness（HKUDS，港大数据系统组）** | [HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness) | CLI 优先的开源 agent 运行时，43+ 内置工具、流式工具调用、MEMORY.md 持久化、多级权限、后台任务管理 | 面向**研究者/想透视生产 harness 内部机制的人**；9,100 星（文内）；v0.1.x 早期版、无可视化界面。MIT。注意：与下面的 OpenHarness.ai 是完全不同的两个项目 |
| **OpenHarness.ai（MaxGfeller）** | [MaxGfeller/open-harness](https://github.com/MaxGfeller/open-harness)（文内: openharness.ai） | harness 互操作 SDK：一次编写 agent 代码，跨 Anthropic SDK、Goose、LangChain、Letta、Claude Code 部署 | 面向**规避框架锁定（lock-in）、多运行时环境**的团队；带适配器一致性测试；只解决可移植性，不含编排/记忆/可观测性，社区小。MIT |

### 3. RAG / 文档密集工作流

| 项目 | 链接 | 定位 / 关键特性 | 文章要点（适用场景 / 对比） |
|---|---|---|---|
| **Haystack（deepset）** | [deepset-ai/haystack](https://github.com/deepset-ai/haystack)（文内: haystack.deepset.ai） | 面向 Python 团队的生产级 RAG/文档工作流框架，pipeline 架构，160+ 文档存储集成 | **文档/检索/RAG 密集型**工作流默认选择；23,000+ 星；多模态检索；对非文档类动态推理流程偏笨重。Apache 2.0 |

### 4. 可观测性 / 监控（Observability）

| 项目 | 链接 | 定位 / 关键特性 | 文章要点（适用场景 / 对比） |
|---|---|---|---|
| **AgentOps** | [AgentOps-AI/agentops](https://github.com/AgentOps-AI/agentops)（文内: agentops.ai） | 部署后会话监控：session 回放、LLM 成本/延迟/工具使用、跨 400+ LLM、多智能体交互追踪 | **生产部署后的监控与成本追踪**；约 12% 性能开销；常与 LangGraph 栈搭配；注意「25x 微调成本下降」需独立验证。免费层 + 付费 |
| **Langfuse** | [langfuse/langfuse](https://github.com/langfuse/langfuse)（文内: langfuse.com） | 开源 LLM 可观测性平台：tracing、prompt 管理、评估流水线、团队协作，可自托管 | **自托管 LLMOps / 规避可观测数据厂商锁定**；月 600 万+ SDK 安装（文内为开源 LLMOps 主导）；约 15% 性能开销；只评估模型输出、不评估输入数据质量。MIT；云端方案可选 |

### 5. Atlan 自身（不是 harness 工具，是「受治理数据底座」）

| 项目 | 链接 | 定位 / 关键特性 | 文章要点 |
|---|---|---|---|
| **Atlan** | [atlan.com](https://atlan.com) | 企业级数据治理/上下文底座：active metadata、数据契约（data contracts）、血缘、资产认证，并提供 MCP server | 文章主张：上述所有框架都不验证「喂给 agent 的数据」，Atlan 补齐这一层（文章立场即其产品推销；Gartner 2026 D&A 治理 Leader）。企业 SaaS，非开源 |

---

## 二、FutureAGI 文章（未通读，置信度见文末）

> 原文站点（futureagi.com）在本会话网络环境下无法读取，archive.org 亦被限流，未能核实该文正文的逐项描述。下列为主流开源 agent framework 的**合理推断覆盖**，链接/定位为项目层面的公开事实（含 FutureAGI 站内相关条目作为佐证），**是否确实出现在该文中请以原文为准**。

| 项目 | 链接 | 定位 / 关键特性（公开事实） | FutureAGI 站内相关条目（佐证该站覆盖这些框架） |
|---|---|---|---|
| **LangGraph** | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | 图式有状态多智能体编排（LangChain 生态） | [What is LangGraph?](https://futureagi.com/blog/what-is-langgraph-2026/) |
| **CrewAI** | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | 基于角色的多智能体协作框架 | [CrewAI 词条](https://futureagi.com/glossary/crewai/) |
| **AutoGen / Microsoft Agent Framework** | [microsoft/autogen](https://github.com/microsoft/autogen) | 对话式多智能体（含 Semantic Kernel 整合的 MAF 路线） | [What is the Microsoft Agent Framework?](https://futureagi.com/blog/what-is-microsoft-agent-framework-2026/) |
| **OpenAI Agents SDK** | [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | 轻量 agent loop + handoffs 的官方 SDK | [What is the OpenAI Agents SDK?](https://futureagi.com/blog/what-is-openai-agents-sdk-2026/) |
| **Google ADK** | [google/adk-python](https://github.com/google/adk-python) | Google 官方 Agent Development Kit（A2A、Google 栈） | [Evaluating Google ADK Agents](https://futureagi.com/blog/evaluating-google-adk-agents-2026/) |
| **Smolagents（Hugging Face）** | [huggingface/smolagents](https://github.com/huggingface/smolagents) | 极简、代码优先的轻量 agent 框架 | [SmolAgents 词条](https://futureagi.com/glossary/smolagents/) |
| **Pydantic AI** | [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai) | 以类型安全/结构化输出为核心（Pydantic 作者） | 站点内容覆盖此类框架（间接） |
| **LlamaIndex** | [run-llama/llama_index](https://github.com/run-llama/llama_index) | 数据/RAG 中心的多智能体工作流框架 | 站点内容覆盖此类框架（间接） |
| **Claude Agent SDK** | [anthropics/claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python) | Anthropic 官方 agent loop SDK（Claude Code 同源） | [What is the Claude Agent SDK?](https://futureagi.com/blog/what-is-claude-agent-sdk-2026/) |
| **Agno** | [agno-agi/agno](https://github.com/agno-agi/agno) | 轻量多智能体框架（前 Phidata） | [What Is Agno?](https://futureagi.com/glossary/agno/) |

---

## 置信度说明

- **已确认通读全文**：Atlan 一篇（经其 S3 静态镜像 `atlan.com.s3-website.ap-south-1.amazonaws.com` 抓取到完整正文），上表所有描述、星数、延迟、许可、适用场景均出自该文原文。
- **置信度较低**：FutureAGI 一篇未能读取正文（站点直连被网络沙箱拦截、archive.org 限流、jina reader/缓存代理均不可用）。其上表内容为「该站点对主流框架的既有覆盖 + 公开项目事实」的推断组合，**无法逐条确认是否出现在该文、更无法复述其对比数据**；若需精确清单与对比指标，请直接打开原文核对。
- 另外提示：Atlan 文内部分数字（如 LangGraph 87% 任务成功率、CrewAI 1.8s 延迟、OpenHarness 9,100 星等）为其自引基准或市场数据，本项目一览仅按原文转述，未逐一独立复核。
