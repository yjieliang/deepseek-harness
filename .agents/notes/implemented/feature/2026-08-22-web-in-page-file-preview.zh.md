# Agent Note: 详情栏内的页内文件预览

Status: implemented

[English](2026-08-22-web-in-page-file-preview.md) | 中文

## Problem

在 Web 会话里点击文件路径会请 Host 操作系统用默认应用打开它。在 loopback 页面上，打开器把路径交给真实的桌面应用，于是用户离开 harness 才能读文件；而在远程或 headless 部署上，这个交接根本无从到达桌面。会话流其实早已*读*过文件（`read` 工具卡片展示了它；产物行在轮次末尾命名了文件），但并没有办法查看对话提到的任意路径——唯一的操作是「在系统里打开」。

## Decision

**可读的本地文件路径在右侧详情栏内以预览方式打开，只有读不了的部分才交接给系统。** 点击路径在每个来源都保持不变（`ProducedFiles` chips、行内文件提及、以及 `read`/`write`/`edit` 工具行路径链接都调用同一注入的 `openFile`），因此行为变化只在会话 `openFile` 处理器里实现一次：

1. 按会话 cwd 解析路径。
2. 尝试 `workspaces.readFile(path)`，这是一个新的 unary Host RPC `host.readFile`，读取文件文本（有界、NUL 探测二进制、扩展名推断语言）。
3. 成功则把 path + 语言提示写入共享 chat store 的 `previewFile` 字段并打开详情栏。详情面板渲染 `ReadBlock` 预览（行号、语法高亮、展开），当文件超过字节上限时显示截断提示，并提供「在系统默认应用中打开」交接。
4. 被拒绝时（`file-read-failed`：目录、二进制、缺失、不可读、超限——或读取器本身失败），回退到 `workspaces.openPath`，即先前的系统交接；交接仍被拒绝时保留现有的页面内错误对话框与重试。

**渲染预览开关。** Markdown 文件的预览带有「源码 / 渲染预览」切换：源码视图是 `ReadBlock` 行号卡片，渲染视图则用 `MarkdownText` 解析同一份文本（GFM、表格、数学、代码）。该切换只在 `lang` 提示为 Markdown（`md`/`markdown`/`mdx`）时出现，目标路径改变时重置为源码，并渲染源码视图所展示的同一段文本（包括超限时截断的窗口）。wiki 链接在此通用界面保持字面、本地相对图片不加载——双链跳转与资源解析由知识库面板负责。

**安全。** `host.readFile` 是仅 loopback 的 privileged unary RPC，与 `openPath`、`pickDirectory` 一起固定在 connection 的 `PRIVILEGED_METHODS` 集合。它带字节上限（默认 256 KB），并在前导字节含 NUL 时判定为二进制而非解码出乱码。它刻意仅限 loopback：远程 Web 客户端保留先前「系统打开」行为（在 headless host 上同样失败），无法通过 harness 读取任意本地文件。

**状态 vs 内容。** chat store 只持久化 `previewFile: { path, lang }`，绝不持久化文件文本。`readFile` 的响应存放在 `DetailsFilePreview` 的组件本地状态中，用单调递增的请求 id 作 key，因此中途改目标不会展示过期读取。

## Alternatives considered

- **沿用只走系统打开的既有路径** —— 这正是被替换的行为；它让远程/headless 客户端无法查看，并强迫每个文件都经过桌面。
- **从 harness 经 HTTP 提供文件** —— 这里同样拒绝，理由与 [workspace file links](2026-07-31-web-workspace-file-links.md) 这条 note 一致：在 `/api` 旁提供文件不安全（无同源隔离），另开独立提供又超出了预览界面的范围。
- **把整份文件放进持久化的 chat store** —— 拒绝；store 把整值 JSON 写入 `localStorage`（见 `snapshot store` 持久化），大预览会撑爆并在随后静默关闭持久化。只有小的 path/lang 对才持久化。
- **由配置驱动预览上限** —— 拒绝；上限是产品界面常量，不是随部署变化的选项，因此保留为常量而非 `Config` 字段。

## Consequences

对话里的本地文件路径现在内联预览而不再启动系统应用；系统交接保留为回退，也作为预览内部的「在系统默认应用中打开」动作。`host.openPath` 的决策及其失败对话框（[tool-call file open in OS](2026-07-28-tool-call-file-open-in-os.md)）对读不了的部分仍然有效。为让「左会话 右预览」的分屏更舒适，会话列宽从 748 px 加宽到 920 px（`--dsh-chat-content-width`）。
