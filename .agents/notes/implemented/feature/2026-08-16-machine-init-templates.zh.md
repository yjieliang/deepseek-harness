# Agent Note: Machine-level init templates

Status: implemented

[English](2026-08-16-machine-init-templates.md) | 中文

## Problem

新机器启动 profile 时,大部分机器级状态是自动的——profile 目录、其 manifest 与 `cordis.patch.yml`、修复好的模块 fallback、空的 settings 文档——但这些文件的**内容**要么硬编码在启动逻辑里,要么靠手工复制。仓库里没有一个由模板驱动的方式让部署声明「首次启动的 `$DSH_HOME` 长这样」,于是每个新的基线文件(settings 骨架、不含密钥的 provider 列表、未来的机器本地文档)都需要各自的启动步骤或手工复制一份 home。

## Decision

`apps/cli` 拥有一层机器级初始化:shipped 模板树位于 `apps/cli/config/init/`,其文件映射到 `$DSH_HOME` 下相同的相对路径。`applyInitTemplates` 在每次 `runProfile` 启动时遍历该树——在插件树挂载之前,因此首次启动的 `settings.yaml` 就是 settings provider 读到的内容——并且仅在目标不存在时复制文件。已有文件永不覆盖,步骤幂等,`README.md` 文件只作文档、不会被复制,模板根缺失时告警并跳过而非让启动失败(初始化是增量能力;应用照常运行,只是少了新机器的基线)。首个 shipped 模板是 `settings.yaml` 基线:声明默认模型路由与带 API key 环境变量名的 provider 骨架——只有结构,没有密钥。

## Alternatives considered

### 为什么不做声明式清单 + 通用 provisioning 引擎?

「创建这个目录、写那个设置默认值」的清单是最完整的形态,但当前的需求只是普通的文件物化,别无其他;引擎的其余动词没有消费方,属于投机性机制。模板树保持了同样的「一个基线一个文件」的体验,将来确有需求时再长成清单。

### 为什么不做成树挂载之后运行的插件?

第一个消费方——settings 文档——在 settings provider 挂载时就被读取,树挂载后的插件来不及初始化它。只有 `runProfile` 里 `boot` 之前的位置,能保证每个机器级文件在任何读取方之前就位。

### 为什么不同步/覆盖模板到 home?

覆盖会毁掉用户编辑与已存数据(首当其冲就是 settings 文档)。「仅缺失时复制」就是整个安全模型;想为已有机器改基线的部署,应编辑自己的 home 或提供迁移,而不是靠初始化步骤。

## Consequences

- 新的机器级基线文件只需一个模板文件;每台已有机器的 home 保持原样。
- 密钥在结构上就无法进入仓库:模板只携带结构与环境变量名。
- 该步骤每次启动只跑一次、首轮之后不再写,代价仅一次递归读取。
- 已有文件永远不会被该步骤迁移——这是刻意的;需要迁移已有文件的升级是独立迁移,如 habits 的 `guardConfirmed` 迁移。

## Testing

`apps/cli/tests/init-config.spec.ts` 在临时根上覆盖缺失即复制、永不覆盖、幂等、README 排除与模板根缺失告警路径;测试从不触碰真实的 harness home。
