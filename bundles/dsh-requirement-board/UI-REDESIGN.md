# 需求看板 UI 重设计规格（UI-REDESIGN.md）

本文是 `req_81f4b92934`（重设计需求看板全部 UI 视觉）方案设计节点的交付物：把概念稿
`kanban-redesign.html` 的视觉语言映射到面板当前可用的平台 token 与面板局部变量上，逐区给出落点，
并登记未采用项与实测偏差。**实现事实以本文第 3、4 节的落点为准**；概念稿是唯一视觉基准，
平台 `--dsw-*` token 是唯一取值来源（概念稿没有对应 token 的部分见 2.2 局部变量登记表）。

概念稿留档：`.artifacts/requirement-board/reference/kanban-redesign.html`（sha256 `138d625a…1134`）、
参考渲染 `reference/kanban-redesign-render.png`（1440×2400，336220 B）。

> **时效提示（2026-10-18）**：§9 记录 v2 密度改造，更新了顶栏高度、KPI 带、卡片与详情头部几何；
> 与 §2.3 / §4 的旧基线冲突时，以 §9 为准。

## 1. 边界与前提

- **不改**：`host/**`、存储 schema、工具面与 skill 语义、流程推进/门禁/队列语义、既有 HTTP 与 API 约定、需求数据。
- **不引**：外部字体或任何网络资源。概念稿 `<link>` 的 Google Fonts（Space Grotesk / Noto Sans SC / JetBrains Mono）一律不采用，改用本机与平台自带字体（见 2.4）。
- **视觉范围**：面板内所有可见区块，含对话框、抽屉、空态、加载骨架、错误与提示（见第 3 节逐区对照）。
- 面板必须同时支持平台亮/暗主题（`requiresLightAndDark: true`），概念稿只给了暗色；亮色臂见 2.2。

## 2. Token 映射表

### 2.1 概念 token → 平台 token

右侧“实测值”取自 2026-10-09 在 `http://127.0.0.1:3080` 真浏览器里对**当前面板**的
`getComputedStyle` 读数（`screenshots/before-readings.json`），即暗色主题下平台 token 的真实解析值。

| 概念 token | 概念值 | 落地 | 实测值（暗色） | 说明 |
|---|---|---|---|---|
| `--bg-0` | `#101012` | `var(--dsw-alias-bg-base)` | `#151517` | 面板根/最底表面 |
| `--bg-1` | `#161619` | `var(--dsw-alias-bg-layer-1)` | `#232324` | 卡片、面板、元信息格 |
| `--bg-2` | `#1d1d21` | `var(--dsw-alias-bg-layer-2)` | `#2c2c2e` | 内嵌块、门禁行、筛选 chips |
| `--bg-3` | `#242429` | `var(--dsw-alias-bg-layer-3)` | `#353638` | 悬停/选中态 |
| `--line` | `#28282e` | `var(--dsw-alias-border-l2)` | `#ffffff1f` | 常规描边 |
| `--line-soft` | `#202025` | `var(--dsw-alias-border-l1)` | `#ffffff0f` | 弱分隔线、网格缝隙 |
| `--text-1` | `#f2f0eb` | `var(--dsw-alias-label-primary)` | `#f9fafb` | 主文本 |
| `--text-2` | `#a9a69e` | `var(--dsw-alias-label-secondary)` | `#cfd3d6` | 次文本 |
| `--text-3` | `#6e6b63` | `var(--dsw-alias-label-tertiary)` | `#adb2b8` | 弱文本、标签、说明 |
| `--accent` | `#f06423` | `--rb-accent`（局部） | — | 平台无橙色 token，见 2.2 |
| `--accent-hover` | `#ff7733` | `--rb-accent-strong`（局部） | — | |
| `--accent-soft` | `rgba(240,100,35,.12)` | `--rb-accent-soft`（局部） | — | |
| `--accent-line` | `rgba(240,100,35,.35)` | `--rb-accent-line`（局部） | — | |
| `--ok` | `#4cb578` | `var(--dsw-alias-state-success-primary)` | `#22c55e` | |
| `--warn` | `#e5a13c` | `var(--dsw-alias-state-warn-primary)` | `#f59e0b` | |
| `--danger` | `#e5534b` | `var(--dsw-alias-state-error-primary)` | `#f25a5a` | |
| `--info` | `#5aa2e8` | `var(--dsw-alias-state-business-primary)` | `#7aaaff` | 引用/关联件链接色 |
| `--violet` | `#9b8cf2` | `--rb-violet`（局部） | — | 预留/排队语义，平台无紫色 token |
| `--r-sm` `6px` | 圆角 | `var(--dsw-radius-sm)` | `8px` | 见 5.1 偏差 D1 |
| `--r-md` `10px` | 圆角 | `var(--dsw-radius-md)` | `12px` | 同上 |
| `--r-lg` `14px` | 圆角 | `var(--dsw-radius-lg)` | `16px` | 同上 |
| `--ease` | `cubic-bezier(.22,1,.36,1)` | `var(--ds-ease-out)` | — | 仅用于 ≤.2s 的颜色/位移过渡 |
| 12% 淡色底（`--ok-soft`/`--warn-soft`/`--danger-soft`/`--info-soft`…） | 各 12% | `color-mix(in srgb, <对应 state alias> 12%, transparent)` | 解析为 `rgba(...)` | 不复制色相：淡色随主题 token 派生，只有无 token 的 accent/violet 才用局部变量 |

### 2.2 面板局部变量登记表

除下表中的声明外，面板 CSS **不得出现任何字面色值**；所有颜色只能经 `var(--dsw-*)` 或本表变量获取。
局部变量只在 `.rb-root` 上声明一次，供面板内全部后代继承。

| 局部变量 | 暗色（概念稿原值） | 亮色臂 | 为什么必须是局部变量 |
|---|---|---|---|
| `--rb-accent` | `#f06423` | `#c2410c` | 平台品牌色是**单色**：`--dsw-alias-brand-primary` 实测 `#f9fafb`（亮色为黑），没有橙色强调 token；概念稿的视觉身份正是这个橙 |
| `--rb-accent-strong` | `#ff7733` | `#9a3412` | 悬停态，同上 |
| `--rb-accent-soft` | `rgba(240,100,35,.12)` | `rgba(194,65,12,.10)` | 选中 chips / 序号块底色；平台无 alpha 橙 |
| `--rb-accent-line` | `rgba(240,100,35,.35)` | `rgba(194,65,12,.35)` | 选中 chips 描边 |
| `--rb-accent-fill` | `#f06423` | `#c2410c` | 橙底白字按钮的填充；默认＝概念稿原值，见偏差 D3 的一键改用值 |
| `--rb-violet` | `#9b8cf2` | `#6d5bd0` | 「预留/排队/阻塞等待」语义色，平台无紫 |
| `--rb-violet-soft` | `rgba(155,140,242,.12)` | `rgba(109,91,208,.12)` | 预留横幅底色 |

亮色臂选择器为 `body:not([data-ds-dark-theme]) .rb-root`（平台用该属性标记暗色；实测暗色下属性存在且为空串）。
亮色臂取值的理由：`#f06423` 对白底对比度实测 3.20:1，不满足正文 AA；`#c2410c` 对白底 5.18:1。暗色下
`#f06423` 对 `--dsw-alias-bg-base` `#151517` 实测 5.76:1，满足 AA，故暗色保留概念稿原值。

### 2.3 字号与几何标尺

| 用途 | 概念稿 | 落地 |
|---|---|---|
| 面板正文 | 13px | 13px |
| 顶栏标题 | 16px/600 | 16px/600 |
| 详情标题 | 19px/600 | 19px/600 |
| KPI 数值 | 26px/600 + `tabular-nums` | 26px/500 + `tabular-nums`（字重受平台字体可用字重限制，见 2.4） |
| KPI 标签 | 12px/500 | 12px/500 |
| 环形内百分比 | 14px/700 | 14px/600（同上） |
| KPI 副指标条 / 筛选标签 | 12px | 12px |
| 分节标题 | 13px/600 + 3×13px 橙条 + 10px 英文小字（`.06em`，大写） | 同（英文小字改用平台数字字体） |
| 元信息格 | 标签 11px、值 12.5px/500 | 同 |
| 门禁行 | 12.5px，行内 `gk` 110px | 同 |
| 徽标 / 状态 chip | 11px/600，高 22px | 同 |
| 顶栏高度 | 64px | 64px（面板现状已一致） |
| KPI 带 | `300px repeat(5,1fr) 220px`，gap 10，块内 14/16 | 同（≤1240px 换行成 flex 带，hero 与告警块各占整行） |
| 主分栏 | `330px 1fr`，gap 16 | 同（现状左栏 309px → 330px） |
| 视图切换 | 外框 padding 3px、gap 2、圆角 9px；按钮高 28px、padding 0 16px、圆角 6px | 同（圆角走平台 `radius-sm`） |
| 筛选 chips | 高 26px、padding 0 11px、圆角 999px | 同 |
| 详情内边距 | `22px 26px 26px` | 同 |
| 元信息网格 | `repeat(4,1fr)`，gap 1px 缝隙线 | 同（≤1240px → 2 列，≤900px → 1 列） |
| 空态 | 虚线框 + 34px 图标块 + 13px 标题 | 同 |

### 2.4 字体策略与实测

概念稿用三套外链字体，本机不可用（且禁外链）。用探针 `rollout/probe-fonts.mjs` 在真浏览器里
逐族实测（16px 下量 “1111111111 / 0000000000 / x / H / 需求看板”，找不到的族与虚构族宽度完全一致即判为回退）：

| 概念字体 | 落地字体 | 实测可用性 | 实测数字步进（16px） |
|---|---|---|---|
| `--font-ui`：Noto Sans SC / PingFang SC / 微软雅黑 | `var(--dsw-font-family)`（本机解析为 `Segoe UI` + CJK 回退） | 可用（面板实测 `Segoe UI` 生效） | 8.625px/位，且 1 与 0 等宽（本身近等宽） |
| `--font-num`：Space Grotesk | `var(--dsw-font-family-brand)`＝`Montserrat`（平台自带 woff2，按需加载） | **可用但需触发加载**：`document.fonts` 里已注册 300/400/500 三个 @font-face，未使用前 `check()` 为 false，一旦使用即加载（实测 10 位数字宽度由回退值 93.828 变为 57.766） | 默认比例数字（`1`×10=57.766，`0`×10=105.922）；加 `font-variant-numeric: tabular-nums` 后两者都＝112，即**完全等宽，步进 11.2px** |
| `--font-mono`：JetBrains Mono | `var(--ds-font-family-code)`（本机解析为 `Consolas`） | 可用 | 8.797px/位，天然等宽 |

实测观感差异（登记为偏差 D2）：
- Montserrat 等宽数字步进 11.2px，比 `Segoe UI` 的 8.625px **宽 30%**，比 `Consolas` 的 8.797px 宽 27%；
  因此 KPI 数值在同样字号下比现状更宽，`26px` 的最长读数（如 `3498`）约 45px，仍在瓦片宽度内。
- Montserrat 只随平台打包 300/400/500，**没有 600/700**。概念稿的 `600`（KPI 数值、环形百分比）会触发合成加粗，
  故按 500 落地；这是为了不出现伪粗体，登记为偏差 D2。
- CJK 字形在三套栈里都是 16px 全宽（实测 `需求看板`＝64px），即中文观感不随字体选择改变，只有拉丁字形与数字步进变。
- 数字一律带 `font-variant-numeric: tabular-nums`，保证指标列在数值变化时不抖动。

## 3. 逐区对照（概念区块 × 面板实际区域 × 落点）

| # | 概念区块 | 面板实际区域（组件） | 落点 |
|---|---|---|---|
| 1 | `.topbar`：logo + 标题 + 副标题 + live 圆点 + spacer + 按钮组 + 主按钮 | `BoardPage` 顶栏（标题/共享状态/刷新/角色管理/流程模板管理/新建需求） | `.rb-header`（高 64、gap 12、内边距 0 18px）、`.rb-logo`、`.rb-heading`、`.rb-live`、`.rb-header > button`（幽灵）、`.rb-btn-primary` |
| 2 | `.viewtabs` + `.segmented` | 视图切换（看板·队列·要我拍板）与提示文字 | `.rb-views`、`.rb-segmented`、`Pill` 传 `className:'rb-seg'`、`.rb-view-hint` |
| 3 | `.kpi-band`：hero 环 + 5 指标块 + 告警块；`.kpi-sub` 副指标条 | `StatsStrip`（现 18 个小方块） | `.rb-stats`（grid）、`.rb-stat--hero`、`.rb-ring`、`.rb-stat--alert`、`.rb-stat`、`.rb-stat-label`、`.rb-stat-value`、`.rb-submetrics` |
| 4 | `.filters` + `.chip` / `.chip--on` / `.clear` | `BoardPage` 筛选区（角色 chips 与清除） | `.rb-filters`、`.rb-chip`（`Pill` 传 `className:'rb-chip'`）、`.rb-chip-on`、`.rb-clear` |
| 5 | `.main`（左 330 队列 + 右详情） | `.rb-body` 两栏 | `.rb-body`（grid `330px 1fr` gap 16）、`.rb-list`、`.rb-detail` |
| 6 | `.panel` + `.panel-head` + `.count` + `.queue-note` + `.session-id` + `.queue-item` + `.tag` + `.mini` + `.side-group`/`.def-row` | 左侧队列面板与资格口径（`renderQueue()`：会话分组、队列行、资格说明、队列口径） | `.rb-panel`、`.rb-panel-head`、`.rb-count`、`.rb-queue-note`、`.rb-session-id`、`.rb-queue-item`、`.rb-tag`、`.rb-mini`、`.rb-side-group`、`.rb-def-row` |
| 7 | 需求卡片列表（概念稿左栏条目形态） | 看板视图左栏需求列表（`.rb-card`） | `.rb-card`（标题 + 元信息行 + 锁信息）、`.rb-card-selected` 选中（橙色描边 + `bg-layer-2`）、`.rb-skeleton*` 加载骨架 |
| 8 | `.detail-top` + `.badges` + `.detail-title` + `.detail-actions` + `.act` / `.act--danger` | 详情头部（标题 + 10 个徽标 + 编辑/重开/解除阻塞/恢复-归档/删除） | `.rb-detail`、`.rb-detail-top`、`.rb-title`、`.rb-badge-group`、`.rb-detail-actions`、`.rb-act`、`.rb-act-danger` |
| 9 | `.state-chips` / `.stag`（ok/mut/vio） | 详情内联事实行（优先级/生效优先级/负责人/模板/类型/会话/提出者/更新/revision）与资格徽标 | `.rb-state-chips`、`.rb-stag`、`.rb-stag-ok`、`.rb-stag-mut`、`.rb-stag-vio`、`.rb-ink-success`、`.rb-ink-info` |
| 10 | `.reserve-banner` | 预留/委托提示横幅 | `.rb-reserve`（紫底 + 等宽 session 片段） |
| 11 | `.meta-grid` + `.meta-cell`（.k/.v/.mono/.hi） | 详情元信息网格 | `.rb-meta-grid`、`.rb-meta-cell`、`.rb-meta-k`、`.rb-meta-v`、`.rb-meta-v-mono`、`.rb-meta-v-hi` |
| 12 | `.sec` + `h3::before` 橙条 + `.en` 英文小字 + `.sec-body`/`code`/`.numlist` | 分节：需求正文、图片、验收与门禁、执行单元、流程、节点流转、流转历史、锁、委托 | `.rb-section`、`.rb-section-title`（`::before` 橙条 + `.rb-en`）、`.rb-section-body`、`.rb-code`、`.rb-numlist` |
| 13 | `details.fold`（折叠分节 + caret 旋转） | 同上各分节（采用折叠机制，默认全展开，见 4.7） | `details.rb-fold`、`summary.rb-fold-summary`、`.rb-caret`、`.rb-fold-body` |
| 14 | `.gate` / `.gate-row` / `.gk` / `.gv` / `.req-link` / `.gate-row.blocking` | 门禁区（父需求/子需求/阻挡谁/被谁阻挡）与锁/委托键值对 | `.rb-gate`、`.rb-gate-row`、`.rb-gk`、`.rb-gv`、`.rb-req-link`、`.rb-gate-blocking` |
| 15 | `.empty`（虚线 + 图标块 + 标题 + 说明） | 执行单元空态、列表空态、队列空态、抽屉空态 | `.rb-empty`、`.rb-empty-ico`、`.rb-empty-t`、`.rb-empty-d` |
| 16 | 对话框（概念稿未给独立样式，沿用同一套卡片/分节/按钮语言） | 新建/编辑需求、归档、删除、强制推进、迁移模板 | `.rb-dialog*`、`.rb-field`、`.rb-field-label`、`.rb-section-title`、`.rb-btn-primary`/`.rb-btn-danger`、`.rb-notice*` |
| 17 | 图片块（概念稿 `.sec-body` 内联图） | 「添加图片」区块与已存图片 | `.rb-images`、`.rb-image-row`、`.rb-image-tile*`、`.rb-image-thumb`、`.rb-image-hint`、`.rb-file-input` |
| 18 | 角色管理/模板管理（同语言的管理面） | `RolesDialog`、`TemplateDrawer`、`MigrateTemplateDialog` | `.rb-role-list/-row/-head/-name`、`.rb-duties`、`.rb-drawer*`、`.rb-template-row*`、`.rb-version-row`、`.rb-node-card*`、`.rb-impact-*`、`.rb-table` |
| 19 | `.notice`/提示与错误（概念稿 `.sec-body` 与徽标语义） | 认证失败/数据过期/同步缺口/错误/提示横幅、Toast | `.rb-notice`、`.rb-notice-auth`、`.rb-notice-stale`、`.rb-notice-error`、`.rb-notice-hint`、`.rb-notice-sync`、`.rb-notice-force` |
| 20 | `.foot` 页脚标 | 面板底部（仅保留最少的会话/版本信息，见偏差 D4） | `.rb-foot` |
| 21 | 响应式断点 | 面板窄屏（1240px / 900px） | `.rb-stats` 换行 flex 带、`.rb-body` 单列、`.rb-meta-grid` 2 列 / 1 列、hero 与告警块整行 |

## 4. 组件规格（实现要点）

4.1 **顶栏**：30×30 圆角 logo（橙→深橙渐变，白色 `需` 字）+ `16px/600` 标题 + `12px` 副标题（左含 6px 绿色 live 圆点，
带 2.4s `pulse` 呼吸，`prefers-reduced-motion: reduce` 下停止）+ `flex:1` 间隔 + 次级按钮（高 32、`bg-layer-2`、
`border-l2`、`13px/500`）+ 主按钮（橙底白字、`600`、橙色投影）。
4.2 **视图切换**：分段控件外框（`bg-layer-1`、`border-l1`、圆角 `radius-sm`、内 padding 3px、gap 2px），
按钮 `28px` 高、`13px/500`、`text-3`，选中＝`bg-layer-3` + `text-1` + 内描边 + 投影。
4.3 **KPI 带**：`300px repeat(5,1fr) 220px`；hero＝56px SVG 圆环（底环 `border-l2`、进度环橙、`stroke-linecap:round`）
+ 环内 14px 橙百分比 + 右侧“已完成/总数”分数；5 个指标块＝12px 弱标签 + 26px 数字（数字字体 + `tabular-nums`）；
告警块＝琥珀描边 + 顶部渐变底 + 琥珀标签/数值 + “需要处理”小字（**只读读数**：无对应筛选，故不做成控件，`cursor:default`，见 D10）；
副指标条＝一行可换行的 `12px` 弱文本，数字用数字字体 `500`。
**数据来源不变**：仍然全部来自既有 `stats`（见第 6 节取舍）。
4.4 **筛选 chips**：`26px` 高胶囊，默认 `bg-layer-1` + `border-l2` + `text-2`，选中＝`accent-soft` 底 + `accent-line` 描边 + 橙字，
右侧计数用数字字体；「清除全部」右对齐、无边框，悬停变橙。**只改呈现，不新增筛选语义**（复用现有 `setFilter`）。
4.5 **左栏**：`330px`，面板卡（`bg-layer-1`、`border-l1`、圆角 `radius-lg`、`overflow:hidden`），面板头含标题 + 数量胶囊；
队列口径说明块＝`bg-layer-2` + 2px 紫色左边条；会话 id 块＝等宽 11px；队列条目＝`bg-layer-2` + `border-l2` + 圆角 `radius-md`。
4.6 **详情**：内边距 `22px 26px 26px`；标题 19px/600；动作按钮 28px（危险态红描边/红底淡色）；徽标胶囊 22px/11px/600。
4.7 **分节与折叠**：分节标题＝3×13px 橙条 + `13px/600` 中文 + `10px` 大写英文小字；分节内容包在
`<details class="rb-fold" open>` 中（**默认全部展开**，折叠机制可用但初始不隐藏任何内容，避免功能缺失），
`summary` 右侧 caret 在展开时旋转 90°。
4.8 **元信息网格**：`repeat(4,1fr)` + `1px` 缝隙线（用容器 `bg=border-l1` + 单元 `bg-layer-1` 实现 1px 分隔），
标签 11px 弱、值 12.5px/500；`revision`、`session id` 等用等宽 11px；生效优先级高于自身优先级时值变琥珀。
4.9 **门禁**：行为独立卡片（`bg-layer-2` + 圆角），左侧 110px 弱标签 + 值；被阻挡的当前门禁行加红色描边与顶部红色渐变，
标签转红；需求引用渲染为等宽蓝色小胶囊。
4.10 **执行单元空态**：虚线框 + 34px 图标块 + 单行文案（`executionsEmpty`）+ 观测版本说明；与「加载中骨架」
（骨架行 + 屏读专用 `role="status"` 文案，见 D11）、「错误提示」三态互斥且都覆盖。
4.11 **对话框/抽屉**：沿用平台 `Modal` 的遮罩与框架，面板只提供卡内语言（分节标题、字段标签 11px 弱、按钮沿用顶栏按钮规格）；
模板抽屉保持两栏（列表 264px + 详情）。
4.12 **亮色臂**：所有面板局部变量在 `body:not([data-ds-dark-theme])` 下切换到亮色取值；其余一切经平台 alias，自动随主题。

## 5. 未采用项与偏差登记

| # | 项 | 处理 | 原因（含实测） |
|---|---|---|---|
| D1 | 概念圆角 `6/10/14px` | 采用平台 `8/12/16px` | 面板与终端、会话等平台面板同处一个外壳，圆角必须与外壳一致；差 2px，肉眼几乎不可辨 |
| D2 | 概念数字字体 Space Grotesk 600/700 | 平台自带 `Montserrat` 500 | 禁外链字体；Montserrat 是平台唯一自带几何无衬线，实测可用且 `tabular-nums` 完全等宽（11.2px/位，比 Segoe UI 宽 30%），但只打包 300/400/500，600 会伪粗体 |
| D3 | 概念稿 `.btn--primary` 橙底白字（`#f06423` + `#fff`） | 保留；登记 `--rb-accent-fill` 为一键改用值 | 实测白字/橙底 3.20:1，低于 AA 正文 4.5:1；因“概念稿为唯一视觉基准”保留原值，同时把改用值（`#c2410c`，5.18:1）登记为独立变量，改一个变量即可满足 AA |
| D4 | 概念稿页脚标 `.foot`（左右两组元信息） | 只保留一行最小信息 | 面板已有顶栏共享状态与统计，重复信息无价值；且概念稿页脚内容是演示数据 |
| D5 | 概念稿的手机断点内容（隐藏次要按钮、隐藏副标题） | 仅采用布局退化（KPI 4 列、单列、元信息 2 列、次要按钮隐藏） | 面板只在 Web 外壳内呈现，按外壳宽度退化即可，不做移动端专门设计 |
| D6 | 概念稿演示数据与文案（如「像素君」「ADR-0007」） | 不采用 | 面板文案由 `locale` 词典拥有，数据来自看板快照 |
| D7 | 概念稿的 `<link>` 外链字体与任何网络资源 | 不采用 | 需求硬性禁止网络资源；字体策略见 2.4 |
| D8 | 概念 `--bg-*` 绝对值 | 采用平台 alias（`#151517/#232324/…`） | 面板根表面若自定值，会与同屏其它面板不一致；层级关系（4 级递增）与概念稿一致 |
| D9 | 概念带是固定 7 列 | 宽态同（`300px repeat(5,minmax(0,1fr)) 220px`）；≤1240px 改换行 flex 带 | 面板列宽由外壳决定，1160px 实测 7 列正好放下（hero 330/块 109/告警 220 外框），更窄时固定列会挤坏读数 |
| D10 | 概念告警块带“去处理 ›”动作 | 只做读数（`cursor:default`，文案“需要处理”） | 看板没有“只看停滞”筛选，做成按钮会给出不存在的操作 |
| D11 | 概念无加载态 | 骨架行 + 屏读专用 `role="status"` 文案 | 骨架对屏读器不可读；保留一条 `sr-only` 状态文案，既有断言与可访问性都不丢 |
| D12 | 概念分节始终展开 | 每个分节都是 `<details class="rb-fold" open>` | 长详情需要可折叠；初始全部展开，不隐藏任何内容（见 4.7） |
| D13 | 概念分节只有中文标题 | 中文标题 + 英文小字标识 | 英文是**分节标识**（`sec*` 键，两种语言同词），不是待翻译文案；登记原因写在词典注释里 |
| D14 | 概念未画对话框内部 | 对话框框架/分节标题/字段标签/表格/图片块用新语言，平台 `Button` 保留自身皮肤 | 按钮皮肤属于平台原语，重绘会与外壳其它面板的按钮不一致 |

## 6. 副指标数据取舍（不改统计口径）

现有 `stats` 由 `host/flow.js` 提供，面板只做呈现重组：hero 环＝`completionRate`，
5 个主指标块＝`total`、`byStatus.active`、`byStatus.blocked`、`byStatus.done`、`blocked.length`，
告警块＝`stalled.length`（0 时呈中性态），副指标条＝`queued`、`criticalPath`、`reserved`、`pendingDelegations`、
`orphanedLocks`、`running`、`execSync.gaps`、`execSync.ignored`、`byKind`、`byRole`。
不新增、不删除任何统计字段，也不改 `computeStats`。

## 7. 验证与证据（全部在最终交付字节上跑过）

- `tests/client-smoke.mjs`：**389/389 通过**。新增 9 条视觉断言：
  1) 色：两套主题臂各声明一次 `--rb-accent`（`#f06423` / `#c2410c`）；
  2) 色：**除已登记局部变量外没有任何字面颜色**（扫描线程内所有不含 `--rb-` 的行）；
  3) 字号：`.rb-stat-value` 26px、`.rb-ring-pct` 14px、数字字体 `--rb-num`；
  4) 字号：`tabular-nums` 至少 3 处；5) 几何：KPI 带 7 列 `300px … 220px` 与窄屏换行臂；
  6) 几何：圆环 56×56；7) 几何：队列栏 330px；8) 几何：元信息网格 4 列；
  9) 结构：`rb-chip-on` 只落在生效中的筛选 chip 上。
- `tests/verification/panel-render.e2e.mjs`：真浏览器门 **56/56 通过**（临时 dev 实例 `127.0.0.1:3110`，不针对正在使用的 3080），
  新增 10 条**计算样式**断言：`--rb-accent` 实取 `rgb(240,100,35)`、主按钮底色等于该橙、KPI 带 7 格 1 行、
  网格列 `300px … 220px`、读数 `26px` + `tabular-nums`、圆环 56×56、队列 330px、元信息 4 列、
  分节可折叠（`cursor:pointer`）、告警块非控件（`cursor:default`）。
- `tests/verification/g-hygiene.mjs`：**6/6 通过**。
- **反证记录**：`.artifacts/requirement-board/COUNTER-PROOF.md`（改坏颜色 / 字号 / 几何各一条 →
  两个仪表各转红并列出具体断言 → 恢复后 389/389、56/56 转绿）。复现脚本 `rollout/counter-proof.mjs`。
- **截图与实测读数**：`screenshots/`。同一脚本、同一取景分别对改前与改后各拍 6 张：
  `01-top`（顶栏+KPI 带+筛选+两栏详情）、`02-detail`（两栏详情）、`03-dialog`（角色管理对话框）、
  `04-views`（队列视图）、`05-gates`（门禁表，当前挡路行红描边）、`06-executions`（执行单元虚线空态 + 执行锁 + 委托），
  另有 `before-readings.json` / `after-readings.json`（token、逐选择器几何/字体、字体探针、控制台错误）。
  关键实测差：统计块 **18 → 7**，块高 66.5 → 98.8，顶栏 64 → 65，左栏 309 → 330，`.rb-stat-value` 26px/Montserrat/`tabular-nums`，
  `.rb-card` 选中态描边 `rgba(240,100,35,.35)`，控制台错误 0。
- **发布态字节**：`client.js` 259746 B、sha256 `48C1D630…`；主机 boot 载荷 rev `47a37ecfbf1f`，
  `GET /plugins/??dsh-requirement-board/client.js&rev=47a37ecfbf1f` → 200、259824 B（服务端注入 78 B）、sha `36264f73…`；
  错误/空 rev → 404（哈希校验仍在生效）。

## 8. 不回归边界

认领/推进/门禁/排队/图片上传/模板管理的行为与语义、HTTP 与 API 约定、需求数据全部不变；
本设计只改 CSS 与渲染结构（新增包裹元素与类名），不新增/删除任何写操作，不改任何请求。

交付与同步（实测逐字节比对）：

| 文件 | dev 树 | 部署副本 | sha256（前 12 位） |
|---|---|---|---|
| `client.js` | 259746 B | 逐字节一致 | `48C1D63019D4` |
| `tests/client-smoke.mjs` | 153372 B | 逐字节一致 | `D7B311CA7BF8` |
| `tests/verification/panel-render.e2e.mjs` | 26526 B | 逐字节一致 | `C9BE57E0A862` |
| `locale/zh.json` / `locale/en.json` | 158 / 196 B | 逐字节一致 | `8D6975D36BA2` / `3BA26A4599ED` |

`locale/*.json` 未改动：面板产品文案本来就走 `client.js` 内的 `DICT`（`locale.register`），
`locale/*.json` 只放面板元数据；本次没有新增元数据键。

**同步时机说明**：本机只有一条实时解析路径（`profiles/web/node_modules/dsh-requirement-board`
→ `~/.dsh/bundles/dsh-requirement-board`），任何真浏览器证据都必然运行在已发布字节上。
因此 `client.js` 在方案设计节点就同步到部署副本，使 3110 临时实例能拍改后截图、3080 也能在刷新后看到新设计；
逐字节一致性自此保持到收尾。开发树专属脚本（`rollout/**`、规格文档、数据库）未推送到部署副本；
部署副本内的 `host/**`、`probes/**`、`skills/**`、其余 `tests/**` 与本次改动无关，保持原样。

## 9. v2 密度改造（2026-10-18）

**来源**：用户提供的设计样板 `requirement-board-v2.html`（工作区文件，未进仓库）。它相对上一版样板的
六条设计决策，按下面的口径落到真面板；面板原有的 KPI 子读数、筛选折叠、进度视图、执行单元、决策题面
等功能全部保留，样板本身不进入产品。

### 9.1 采纳的决策与最终几何

| # | 样板决策 | 面板落点 | 最终值 |
|---|---|---|---|
| 1 | 指标带替代磁贴卡 | `.rb-stats` / `.rb-stat` | 一条带边框与 1px 分隔线的带；列模板与 ≤1240px 换行臂不变 |
| 2 | 顶栏收紧 | `.rb-header` | 高 56px（原 64）、内边距 0 16px、标题 15px、副标题 11px、按钮 28px |
| 3 | 卡片减负 | `.rb-card`、`.rb-card-title-row` | 3px 状态色条（`data-status`/`data-kind`）、节点进度在标题行右侧、简述 1 行、meta 11px |
| 4 | 详情分区 | `.rb-detail-id` / `.rb-detail-top` | 两行吸顶（ID+复制 ID 一行、标题+徽标+操作一行），正文在 `.rb-detail` 内滚动 |
| 5 | 键盘习惯 | `BoardPage` + `handleBoardKey` | `j`/`k`/`↑`/`↓` 移动选中并滚动到可见；`/` 展开筛选并聚焦搜索；`Esc` 清空搜索；输入框与弹窗内不劫持 |
| 6 | 单一强调色 | 沿用面板既有 `--rb-accent` | 橙为主强调；紫只保留给决策/角色语义 |
| 7 | 统一动效 | 沿用 `--ds-ease-out` | 新增元素过渡 150–180ms，只做状态反馈 |

细节几何：视图行内边距 10 16px、分段控件高 26px；筛选行 10 16px、chips 24px、输入 28px；
列表宽 360px（原 330）、间距 6px；详情内边距 0 26px 26px、标题 17px、操作按钮 26px。
所有颜色仍走 `--dsw-*`，没有新增/改写颜色 token。

### 9.2 未采纳的两条（与理由）

1. **暖调中性色 / 浅色默认**：不采纳。面板的颜色全部解析到平台 `--dsw-*`（§2.1，DESIGN.md 的 token 约定），
   面板级暖调会与外壳脱节，且要重做亮/暗两臂对比度与像素基线。真要暖调，正确路径是平台主题/全局 token 变更。
2. **搜索上移视图行**：不采纳。搜索是筛选区（状态/优先级/角色/会话/项目/执行/分组）的一员，单独上移会
   割裂折叠结构；样板此条想兑现的「随时找到搜索」由 `/` 快捷键覆盖。

### 9.3 KPI 带点选过滤（收窄范围）

只给**能映射到既有筛选**的读数加点击，点击写入的是筛选区同一个 filter（chip 即回执），不新增状态：

| 可点 | 写入 |
|---|---|
| 进行中 / 阻塞 / 已完成 | `status=active|blocked|done`，再点回到 `open` |
| 决策数（子读数） | `kind=decision`，再点回到 `''` |
| 完成率、总数、阻塞项计数、停滞、队列/预留、执行同步 | 只读 |

理由：`snapshot()` 的 `stats` 按**全板**计算（`host/service.js` 的 `stats()` 不带筛选参数），点选不会让读数
被自己过滤变小；而「停滞」「队列」没有对应筛选，按 D10 的既有裁决不做成假按钮。

### 9.4 与 §4 的偏差登记

- `.rb-detail-id .rb-btn.rb-btn` 把边框置为 transparent：ID 旁的复制是内联工具，1px 描边在 11px 行高里会把它读成主按钮；
  该偏差只作用于这一处（`.rb-detail-id` 子树），§13.1 的「每个 Button 1px 描边」在其他站点保持不变。
- KPI 带的可点读数是 `<button class="rb-stat …">`，不是平台 `Button` 原语：它沿用磁贴的排版（边框来自指标带容器），
  因此没有 `rb-btn` 标记，也不参与 §13 的描边几何记账。

### 9.5 验证与文档时效

- `client-smoke` **550/550**（新增键盘 9 条、KPI 点选 5 条）、`loader` 53/53、`smoke` 106/106；`g-hygiene` 4/5
  （唯一 FAIL 是既有 `tests/options.mjs` 缺行尾 LF，与本次改动无关）。
- 本轮只改浏览器半边（`client.js` + `client-smoke` + `README.md`），宿主（`host/**`）零改动，不需要重启 `dsh web`。
- **§8 的字节哈希表是第一次重设计交付时的快照，本轮后已不代表当前字节**；当前证据以套件与 `g-hygiene` 为准，
  不再逐字节同步部署副本（本机部署副本由链接安装直接指向本目录）。
- §2.3 与 §4 的顶栏 64px、卡片 12px 内边距、详情 22px 内边距、KPI 磁贴等几何是**第一版基线**；与 §9 冲突时以 §9 为准。

## 10. v3 实施勘误（2026-10-19）

- **死 CSS 清理（C-4）**：删除 19 组无命名点规则——`rb-view-hint`（两臂）、`rb-bar`/`rb-bar-fill`、`rb-card-facts` 族、`rb-session-id`、`rb-tag`、`rb-mini`/`rb-mini-on`、`rb-side-group` 族、`rb-section-body`、`rb-code`、`rb-numlist` 族、`rb-state-chips`、`rb-stag` 全家族、`rb-reserve` 族、`rb-empty-d`、`.rb-ink-accent` 类、`rb-scroll`、`rb-foot`。`rb-count-chip`（工具条计数）与 `rb-def-row`（队列口径/决策流程定义行）在 v3 复活，**未删**。§3/§4 中这些类名的落点描述自此失效。
- **§3 类名勘误（审计 C12）**：`.rb-act`/`.rb-act-danger` 实为 `.rb-detail-actions button`/`.rb-btn-danger`；`.rb-queue-item` 实为 `.rb-queue-row`；`.rb-stat--hero` 实为 `.rb-stat-hero`。
- **控件几何**：v3 将搜索/触发器/select 统一为 32px 高、8px 圆角（V3-18），chips/toggles 保持 24px 胶囊族；§2.3 的「chips 26 / 输入 28」自此以 v3 为准。
- **V3-3 产品落点**：描述渲染为单个 `p.rb-prose` 纯文本，产品里没有代码块元素；行宽约束落在 `.rb-prose` 与 `.rb-history-row`（68ch）。原型里的 `.rb-code` 块样式是留给未来 markdown 渲染的提案。
- **V3-20**：产品本无 `rb-view-hint` 渲染点（死类已删）；「详情已开时不显示提示」由右栏孤儿行与决策横幅的移除满足。
- **筛选展开语义**：v2 的「有生效筛选即自动展开」改为**仅显式打开**（v3 起展开是覆盖式 popover，自动展开会盖住列表）；展开态不参与持久化自动恢复。

## 11. v4 修复（2026-10-21）：卡片被纵向压扁 · 窄臂元信息列

**现象**（用户截图）：看板列表里的需求卡只剩标题与一行摘要，meta chips 与日期行被卡片底边横向裁断；
列表看起来"没滚动"，文字"显示不全"。

**根因**：v2 为状态色条给 `.rb-card` 加了 `overflow:hidden`。卡片是 `.rb-list`（可滚动 flex 列）的
flex 条目；`overflow:hidden` 使它的自动最小高度变成 0，列表高度不足时默认 `flex-shrink:1` 把每条卡片
等比压扁——标题与摘要仍在，chips/日期被卡片自己的底边裁掉；又因为所有卡片正好被压到"放得下"，
列表的 `scrollHeight` 等于 `clientHeight`，连滚动条都不出现。窗口高度越小压得越狠（1440×900 下
内容高 124px 的卡片被压到 84px；1440×760 下压到 60px）。

**修复**：

- `.rb-list > .rb-card, .rb-list > .rb-group { flex:none; }` —— 卡片与分组 section 保持内容高度，
  列表列自己滚动。分组视图的 section 同样锁死，避免嵌套列表被二次压缩。
- 同轮修复窄臂元信息列：≤900px 的单列臂里 `rb-meta-cell-span2` 会撑出一列隐式轨道，
  `grid-template-columns:minmax(0,1fr)` 实际渲染成 610px + 143px 两列。加
  `.rb-meta-grid .rb-meta-cell-span2 { grid-column:span 1; }`（作用域选择器压过 v3 后置的 span2 规则）。

**不改**：列表列宽仍按 §9.1 的 360px；卡片摘要仍按 v2 密度设计的单行 clamp；其余视觉几何不变。
若后续要让列表更宽或摘要两行，应作为新的设计决策单独走样稿，而不是本次回归修复的副作用。

**验证**：

- `tests/client-smoke.mjs` **579/579**（新增 2 条：卡片行 `flex:none`、单列臂 span2 归零）。
- `tests/verification/panel-layout.e2e.mjs` **20/20**：seed 12 条需求后断言「列表溢出时滚动」且
  「没有卡片低于内容高度（自裁切）」；顺带修正了窄臂 meta 列数的断言语义（按轨道数计，不按空格
  split）与临时 home 目录清理在 Windows 上的偶发 EPERM。
- 修复后 1440×900 实测：列表 `clientHeight 525 / scrollHeight 771`，卡片渲染高 126 ≥ 内容高 124，
  title / summary / chips / 日期行全部可见。
