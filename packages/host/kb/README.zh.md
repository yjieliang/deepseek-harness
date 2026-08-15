# @deepseek-ai/dsh-host-kb

[English](README.md) | 中文

`kb/` 工作区根目录的知识库宿主特性：一个经 Typert 网关面向浏览器知识库面板的 `kb` Remote 命名空间，外加文档图片的 `/dsh-kb` 图片路由。

引擎在 `kb/` 下维护一个惰性内存索引，覆盖所有 `*.md`（标题／别名／摘要／标签／正文的分字段加权 BM25 检索，支持部分命中排序召回与单字容错），解析扁平 frontmatter，从目录推导每篇文档的状态（`00-inbox/` 或 `01-inbox/` → inbox，配置的归档目录 → archived，其余 → filed），在每次变更后维护 `kb/_meta/index.json`，并把删除移入可恢复的 `.trash`。路径保持库相对并经由 `fs` 服务的 `contains` 做沙箱校验。

模型面向的 `kb_*` 工具刻意不在这里注册：它们属于每次会话的 agent（智能体）preset（`knowledge-base`），因此智能体按会话选择加入，而面板与图片路由保持进程全局。

## Config

```yaml
- id: kb
  name: '@deepseek-ai/dsh-host-kb'
  config:
    archiveDir: 90-归档           # optional; directory whose documents derive status "archived"
    trashRetentionDays: 30       # optional; days a trashed document is kept before automatic purge; 0 disables
```

`archiveDir` 默认 `90-归档`，必须是单个非保留目录名（`00-inbox`／`01-inbox`／`_meta`／`templates`／`.trash` 在加载时被拒绝）。引擎在首次初始化时创建配置的目录，经 `kb.stats.archiveDir` 上报它（面板因此能提供归档移动），并从它推导每个状态，所以配置变更时既有文档立即重新归类。

`trashRetentionDays` 默认 `30`，必须是非负数。删除会在 `kb/_meta/trash.json` 记录 ISO 时间戳；网关在加载时及此后每 24 小时清除时间戳超过保留窗口的回收站文档（清除也会级联到仅被其引用的图片）。早于注册表存在的条目没有时间戳，永不自动清除。`0` 完全关闭清扫。

## Remote surface

`kb.list` / `kb.search` / `kb.get` / `kb.dirs` / `kb.stats` / `kb.tags` / `kb.saveDoc` / `kb.createDoc` / `kb.moveDoc` / `kb.createDir` / `kb.renameDir` / `kb.deleteDoc` / `kb.trash` / `kb.restoreDoc` / `kb.purgeDoc` / `kb.refresh` / `kb.resolveLink` —— 请求与结果词汇见 `./types`。

热更新：引擎维护惰性内存索引，只感知自己的写入。`kb.refresh` 从磁盘重建索引（空文件是已清除标记，不进入索引），面板每次打开时都会调用它，因此 agent 新增或直接编辑的文件无需重启即可出现。

文档排序与置顶：`kb.list` 置顶优先、更新日期次之；`pinned: true` frontmatter 标记经 `kb.saveDoc.pinned` 写入与清除，并上报在每一行摘要上。

目录管理：`kb.createDir` 经 `.keep` 标记建目录并拒绝保留根；`kb.renameDir` 重命名目录并搬迁其下每个条目（文档、图片与嵌套目录），重建被移动文档的索引。保留根与归档目录不可重命名。

## 模型体验

间接地，经 `kb` Remote 命名空间与 `/dsh-kb` 图片路由，本包是面板的数据面，自身不做任何模型调用；模型面向的 `kb_*` 工具位于 knowledge-base agent preset，并拥有任何模型可见的效果。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- **与 preset 的索引重复** —— `knowledge-base` agent preset 自带一份引擎的无依赖导入副本，供模型面向的工具使用；两份实现可能漂移，直到 preset 可以依赖本包。
- **没有全文排序** —— 搜索是 2-gram AND 交集加新鲜度排序；没有 TF-IDF 或模糊匹配。
- **`.trash` 是普通目录** —— 回收站文档经 Remote 可恢复；超过 `trashRetentionDays` 的条目会被自动清除（加载时与每日），`purgeDoc` 也会就地置空文件。回收站列表跳过空文件，因此被清除的条目离开列表，但其字节留在磁盘上，直到 fs 接口获得 delete 原语。清除还会置空并注销文档引用的图片，但仅当没有其他文档（按解析后的注册表路径）引用它们时。
- **`renameDir` 不能移动二进制资源** —— 纯文本 `fs` 接口没有字节写入操作，因此重命名含二进制文件（如图片）的目录会响亮失败而不是半搬迁；纯文档目录可干净重命名。
- **没有按目录计数** —— 目录树在按目录计数端点落地前不渲染文档计数。
