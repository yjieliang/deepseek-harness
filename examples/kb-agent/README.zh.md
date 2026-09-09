# kb-agent

[English](README.md) | 中文

ACP 自动化树之上的知识库演示：在标准 agent 栈旁挂载宿主 kb 引擎（`@deepseek-ai/dsh-host-kb`）与模型面向的 `kb_*` 工具（`@deepseek-ai/dsh-tool-kb`），驱动 `$DSH_HOME/kb` 的机器全局 Markdown 库。

- `cordis.yml` — 现场运行/录制组合。include `../acp-agent/cordis.yml` 并插入 kb 两行；库根保持默认值，现场演示直接编辑本机真实库，`trashRetentionDays: 0` 让清理清扫不产生定时器。
- `cordis.snapshot.yml` — 无 key 重放组合。一次 include 直接 patch 被包含树（patch 无法穿透嵌套 include）：禁用 DeepSeek 适配器、插入 `llm-replay` 与 spill 一对，kb 两行随同一次 insert 进入。acp-agent 配置整体重述并把模型钉回 `deepseek-v4-flash`，与录制语料一致。

快照场景经 `workspace/.dsh/kb/…` 播种文档（harness 把 workspace 复制到运行 cwd 并将 `DSH_HOME` 指向 `cwd/.dsh`，正是默认库根），优先覆盖只读工具——`kb_add`/`kb_import` 会把当日日期写进文件名与 frontmatter，不刷新录制则转录逐日漂移。

用 ACP demo bin 指向本配置即可运行现场演示（`DSH_SNAPSHOT=record` 需真实 key 录制；重放无需 key）。快照场景与其 fixtures 在录制后落入 `tests/`。
