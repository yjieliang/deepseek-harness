# Agent Note: Archived Session Management

Status: implemented

## Problem

[`session-archive-global-set`](../../implemented/feature/2026-07-31-session-archive-global-set.md) 已经交付了 `workspace.archiveSession` 与注册表全局的 `archivedSessionIds` 集合，但从用户角度看归档是单向手势：没有界面显示*哪些*会话已被归档，也没有 RPC 能撤销归档。注册表 JSDoc 记录了这一意图——"未来的 unarchive 恢复其位置"——却一直未实现。唯一的恢复途径是手改 `workspace.json` 并重启宿主（运行中的宿主把 domain global 缓存在内存里）。

## Decision

新增「恢复归档」能力，配一个侧栏工作区浏览器里的类回收站"已归档"视图。真正新增的能力只有反向写入 `unarchiveSession`；展示层复用客户端已有的会话摘要。

**Host —— `unarchiveSession`**（`WorkspaceRegistry`，`@deepseek-ai/dsh-workspace`）：走与 archive/create/delete 相同的 `enqueueOperation` 链；从 `archivedSessionIds` 删除该 id 并经 `setState` 持久化。id 本就不在时按 no-op 解析（不写入、不发事件）。不做存在性复核——归档从不删除日志或记账 slot，所以重复查询只会传播 `sessionPersistence.list()` 故障或阻碍恢复一个日志被外部删除的会话。`dsh-host-apiproxy` 的 `domain/changed` global-put 分支本就对 `archivedSessionIds` 做 diff 并发出 `host/archived-sessions-changed`，因此该写入无需新事件管道。

**Wire —— `workspace.unarchiveSession`**：按全快照姿态镜像 `archiveSession`，落在 `api/workspace.ts`、`api/workspace.schema.ts`、`api/rpc-map.ts`、`fetch/handler.ts`、`fetch/client.ts` 与 `api-proxy.ts` 处理器。`workspace.unarchiveSession({ sessionId }) → { archivedSessionIds }` 应答完整更新集合；id 缺席即幂等 no-op，而非 `session-not-found` 拒绝（该错误码仅归档专用）。

**Client 运行时**（`packages/client/runtime`）：`WorkspaceRuntime.unarchiveSession` → `manager.unarchiveSession` 经 `installArchived` 安装返回集合，使 unary 回声、`host/archived-sessions-changed` 帧、重连基线三者一致更新 `WorkspaceListState.archivedSessionIds`。快照形状不变。

**Client UI**（`packages/client/ui-workspace`）：树下方一条弱化 footer 行——「已归档」，非空时附实时计数徽标——把 `listArea` 切进已归档视图（`ui-kb` 的 `showTrash` 模式）。`tree.ts` 的 `deriveArchived(list, archivedSessionIds, workspaces)` 按归档顺序把 id 投影为 `ArchivedNode { id, title, workspaceTitle, updatedAt }`；`ArchivedSessionItem` 渲染标题（摘要缺失时回退为 id）、所属工作区标题（未分组会话回退到本地化的 `group.ungrouped`）与「恢复」动作。恢复无对话框直接提交、失败以非致命 console 诊断呈现——与归档行动作完全一致。locale 新增 `archived.entry`、`archived.back`、`archived.empty`、`archived.restore`（zh + en）；计数为纯数字徽标。`deriveGroups`/`deriveFlat`/`deriveSearchResults` 继续按归档集合过滤而不变。

## Alternatives considered

**每 workspace 可展开的"已归档"分组。** 否决：已归档的未分组会话无处安放，正是[父 note](../../implemented/feature/2026-07-31-session-archive-global-set.md)里 per-workspace 集合形态卡住的地方；用户也选择了类回收站单一视图。

**「显示已归档」过滤开关，原地混排灰显行。** 否决：无法像专用列表那样提供审查面，且会重新挑起父 note 否决的 `SessionSummary` 打归档标的论争——展示仍需把 workspace 域集合 join 到会话摘要上，专用 `deriveArchived` 一次完成。

**新增 `workspace.listArchived` RPC 返回标题。** 否决：`sessions.list.byId` 已携带视图所需摘要；宿主读面只是重复 sessions 投影。

**unarchive 重新校验存在性。** 否决：归档从不丢弃日志或 slot，拒绝只会传播 `sessionPersistence.list()` 故障并阻碍恢复日志被手动删除的 id。

## Consequences

- **恢复无对话框且失败静默**，镜像归档按钮：最坏误触只是会话重现；被拒调用不改变列表并记录 `session unarchive rejected:`。
- **幽灵恢复**：日志在归档期间被外部删除的会话会恢复为标题回退到原始 id 的一行（不可打开，与任何 workspace 引用的缺失摘要同一空档）。接受——记账 slot 从未移除。
- **排序意外**：在"最近更新"模式下，恢复的会话重回账户并被既有提升策略按其时间戳重排；无新语义。
- **并发**：多标签 unarchive 的竞争与 archive 完全相同；全集合帧加 `installArchived` 的字节相等短路，让最后落盘状态一致胜出。
- **迁移耦合**：`unarchiveSession` 指向与在途 [`unary-apiproxy-remote-migration`](../../proposed/architecture/2026-08-10-unary-apiproxy-remote-migration.md) 相同的 remote 面；落地时须与 `archiveSession` 一起携带以避免 RPC 路径分裂。

## Testing

- 注册表：archive→unarchive 往返回到归档前集合、保留记账 slot、幂等、保留其余归档顺序、跨重启恢复（`workspace.spec.ts`）。
- Wire：`rpc-schemas.spec.ts` 固定请求/值；`api-proxy-workspace.spec.ts` 断言更新集合、`host/archived-sessions-changed` 帧、幂等重复不发出第二帧。
- Client 运行时：`workspaces-service.client.spec.ts` 断言 unary 回声安装集合而不扰动选择、Host 失败不动集合。
- UI：`tree.client.spec.ts` 固定 `deriveArchived` 的排序/工作区标签/幽灵回退；`workspace-browser.client.spec.tsx` 覆盖计数徽标、已归档列表 + 工作区标签、无对话框恢复、静默拒绝与空态。
- 浏览器 e2e：`workspace-management.e2e.ts` 在归档用例上追加了跨重载的恢复往返。

**工具链后续**：生成客户端 inspect catalog（`gen-cordis-inspect-catalog`）此前在一个预先存在的 analyzer bug 上崩溃——`packageExportName` 把 `checker.getSymbolAtLocation(sourceFile)`（对不在本 face program 里的跨 face 目标——例如从 client 重导出触达的 host 类型文件——返回 undefined）喂给 `checker.getExportsOfModule()`，TS 6.0.3 的 `getSymbolLinks` 解引用 `undefined.flags`。analyzer 现在返回三态（`{ name }` / `{ unresolved }` / `undefined`），跳过不可分析的跨 face 目标、回退为 external 引用而不是 fail 或崩溃，与 `collectExports` 的非模块 `continue` 同策略。`cordis-catalog.spec.ts` 新增了 client face 投影用例，本可拦住这次崩溃。客户端 catalog 现已列出 `ctx.workspaces.unarchiveSession`；宿主 catalog（`tool-cordis/src/api-catalog.ts`）已重新生成并包含注册表方法。
