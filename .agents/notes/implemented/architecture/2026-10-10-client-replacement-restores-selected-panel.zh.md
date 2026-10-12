# Agent Note: 客户端插件被替换后保留用户打开的 main 面板

Status: implemented

[English](2026-10-10-client-replacement-restores-selected-panel.md) | 中文

## Problem

替换客户端条目的代码会在同一次序列里拆掉旧代码的注册、再导入新代码（[客户端插件加载模型](2026-07-23-client-plugin-loading-model.zh.md)）。因此持有面板的插件会短暂地从 keyed `main` 槽上消失，而在本决策之前，框架的布局存储把这次缺席当成取消选中：`retainMainPanels` 把用户送回会话视图，且没有任何机制把他们送回来，于是打开着的面板一直关着，直到用户手动重开。该插件 bundle 的任何一次重建——构建 watcher、另一个会话的部署同步——都会关掉并未操作界面的用户的面板。

在本机 GUI 的真实浏览器中实测：只拨动已安装插件 `client.js` 的 mtime（字节未变），面板根节点在约 0.5s 内消失，且 40s 内不再回来，无 console 错误、无 pageerror。本决策之后同一操作只让面板缺席约 25ms，无需用户操作即恢复。

## Decision

[`packages/client/ui-layout/src/client/stores.ts`](../../../../packages/client/ui-layout/src/client/stores.ts) 的 `LayoutState` 在 `panelInfo` 之外携带 `restorePanelId: MainPanelId | null`。每次 `main` 注册表变化时，`retainMainPanels` 执行两个互相独立的步骤：选中的 key 缺席时把它记入 `restorePanelId`，并把 `activePanelId` 置 `null`；记住的 key 重新出现时把它设为 `activePanelId`，并清空这份记忆。

这份记忆只被消费一次，因此被彻底移除的面板会把用户留在会话视图。`selectPanel` 无条件清空它，所以显式选择——另一个面板、或会话视图本身——优先于之后才回来的面板。`PanelInfo` 仍只有一个字段：`activePanelId` 依然永远指向已注册的 `main` key，`LayoutController.selectPanel` 对未注册的 key 依然抛错。

这里没有任何基于时间的处理。注册表变化本身就是替换两个半程的精确信号，因此不存在宽限窗口或兜底延迟。

## Alternatives considered

**让 `activePanelId` 保留未注册的 key，改在渲染期回退。** 框架按 key 渲染 `main`，那样渲染路径就需要知道注册表状态，而 `PanelInfo` 会对外发布一个不指向任何东西的选中项。控制器「选中的 key 必须已注册」这一校验也就失去意义，`restorePanelId` 会被迫进入跨插件公开面。

**回退前先等一个宽限定时器。** 它用猜测换来看起来一样的行为：重建慢于该窗口就仍然会丢面板，正确性取决于一个时长。注册表事件已经把两件事的先后排准，所以本决策不需要定时器。

**在 `packages/client/modules` 或 `packages/client/hmr` 的替换路径里保住选中态。** 条目替换是通用的、服务每一行；让它了解某一个消费方的选中态就需要布局存储（它属于另一个插件），并把布局词汇塞进加载模型。布局存储本来就同时看得到两次注册表变化。

**重建时干脆不拆条目。** 这超出本次范围且代价更大：它会让被替换代码的注册继续存活。[客户端插件加载模型](2026-07-23-client-plugin-loading-model.zh.md) 保留该决策，其中包括重载会丢弃被替换插件内部的 React 状态——恢复的面板带回来的是全新的组件状态，而不是它此前的面板内状态。

## Consequences

注册空档不再让用户丢面板；故意先注销、稍后重新注册同一个选中面板的插件同样会回到用户面前，因为存储无法把这种情况与替换区分开，只有显式 `selectPanel` 能覆盖它。插件被移除且不再重新注册时，面板仍会立即回退到会话视图。

`LayoutState` 多了一个内部字段。跨插件的 `PanelInfo` 类型没有变化，因此没有插件需要改动，恢复动作发生在重新声明该 key 的同一次注册表变化里。

验证：[`tests/layout-store.client.spec.ts`](../../../../packages/client/ui-layout/tests/layout-store.client.spec.ts) 固定四种序列（同 key 回来、仍然缺席、显式回会话视图、显式选另一个面板），[`tests/apply.client.spec.ts`](../../../../packages/client/ui-layout/tests/apply.client.spec.ts) 用真实 `main` 槽注册表走一遍注销与重新注册，`pnpm run test:gui` 覆盖该包。把 `retainMainPanels` 还原成旧实现会让新的 store 用例变红，并在浏览器探测里复现面板丢失；两次运行即反证。