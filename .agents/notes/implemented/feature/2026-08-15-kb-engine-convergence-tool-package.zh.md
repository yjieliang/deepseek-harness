# Agent Note: 知识库引擎收敛与工具包

Status: implemented

[English](2026-08-15-kb-engine-convergence-tool-package.md) | 中文

## 问题

知识库存在两套独立引擎实现。`packages/host/kb` 在 `KbGateway` Remote 服务背后交付了带类型、带测试的 `KbEngine`；而 `knowledge-base` agent preset 因用户 preset 的模块解析器无法导入 harness 包，自带一份约 700 行的无导入副本（`kb.plugin.mjs`）。两份副本在七个方面可观察地漂移：`01-inbox` 状态推导、可配置归档目录、`images.json` 格式（preset 写数组、host 读对象）、`kb_update` 重复 `updated:` frontmatter 键、置顶排序、`index.json` 双写竞争、刷新行为。`expectVersion` 乐观锁在两份实现里也都是空转——守卫比较的是刚 stat 到的版本而非客户端观察到的版本，`conflict` 标志永远不触发。

## 决策

收敛到 host 引擎，并把工具层重塑为 harness 的一等包形态，遵循 `fs` seam（Service Definition / Provider / Consumer）范式。

- **网关即服务。** `KbGateway` 本身是 `TypertRemoteService`（以 `ctx.kb` 注册的 Cordis `Service`），因此未再引入第二个服务类——单独的 `KbLibrary extends Service` 会在 `kb` 键上冲突。引擎保持在 `@deepseek-ai/dsh-host-kb` 内部；浏览器面板（经 `kb` Remote 命名空间）与工具（经 `ctx.kb`）共享同一实例。
- **工具面能力是普通方法而非 Remote。** 在网关上新增了不带 `@Remote` 装饰器的 `searchFiltered`（超出面板 wire 的字段过滤）、`links`（出链+反链）与 `images`（图片注册表重建+孤儿检测），保持 Typert wire 与生成产物冻结。引擎获得对应逻辑。
- **一等消费方包。** 新增 `@deepseek-ai/dsh-tool-kb`（`packages/host/tool-kb`），以 schemastery `Config`（`searchTopK`、`batchConfirmN`、`archiveDays`、`clipMaxBodyChars`）注册 15 个 `kb_*` 工具、知识库提示词段，以及组合 `ctx.kb` 原语的复合编排（归档、整理、导入、导出、剪藏）。它像 `tool-fs` 注入 `fs` 一样把 `kb` 作为硬依赖注入；`web` 保持可选，供 `kb_clip` 降级。
- **preset 收缩为纯组合。** `knowledge-base` preset 的 `agent.cordis.yml` 现在以行引用 `@deepseek-ai/dsh-tool-kb`；`kb.plugin.mjs` 已删除。`@deepseek-ai/dsh-tool-kb` 声明在 base bundle（`packages/bundle/base/package.json`），preset 行因此像 `dsh-tool-bash` 一样可解析。

顺带修正：乐观锁现在用客户端的 `expectVersion` 守卫，并把 `FS_STALE_VERSION` 呈现为 `{ conflict: true }`；图片注册表统一为对象格式（`path → { name, referenced }`），`imageTarget`、`resolve` 与重建都读这一形状；`backlinksOf` 按标题、stem 或路径匹配链接（`[[文档名]]` 语义）；`kb_search` 字段语法（`tag:`/`path:`/`status:`/`title:`）落到引擎的过滤检索，工具层只做前缀解析。

## 备选方案

### 保留两份实现并手工同步

否决：漂移是单引擎双副本的固有属性；同步纪律在下一个只改一份副本的特性上仍然失败。

### 在网关之外另建 `KbLibrary extends Service`

否决：`TypertRemoteService` 已 `extends Service` 并注册 `kb` 键，第二个服务类会在挂载时冲突；网关的公开方法面就是服务契约。

### 把工具能力提升为 `@Remote` 方法

本次否决：新增 Remote 方法会改动生成的 Typert 产物与面板 wire；工具专用方法保持普通方法，未来 GUI 消费方需要时再提升（已记录为已知限制）。

## 后果

- 只剩一份引擎实现；preset 中不再有任何索引、磁盘、状态或工具实现代码。
- 面板 wire 契约不变（`kb.list`/`search`/……与 `/dsh-kb`）；`ui-kb` 客户端包未改动。
- `knowledge-base` preset 的工具现在依赖 host 组合中的 `@deepseek-ai/dsh-host-kb`；没有它的部署会让 `tool-kb` 保持等待（失败响亮，符合硬注入约定）。
- `kb_update` 冲突现在以抛出的 `kb: 版本冲突` 错误呈现；引擎经 `ctx.kb.saveDoc` 返回 `{ conflict: true }`。

## 测试

- 引擎测试（`packages/host/kb/tests/core.spec.ts`）覆盖排序命中上的字段过滤、链接、带孤儿的图片注册表重建、乐观锁冲突（过期版本拒绝且正文与索引不变；匹配版本写通）。`MemoryFs` 假实现现在遵守 `replaceIfVersion`，冲突路径得以被实际执行。
- 工具测试（`packages/host/tool-kb/tests/tools.spec.ts`）在内存 fs 上挂载真实网关，覆盖注册（15 工具+提示词段）、字段语法检索、新增/读取、经工具触发的过期版本冲突、链接、归档预览与阈值闸门、导入阈值闸门、剪藏降级，以及标签/统计/图片。
