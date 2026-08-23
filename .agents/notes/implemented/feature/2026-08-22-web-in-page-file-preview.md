# Agent Note: In-page file preview in the details column

Status: implemented

English | [中文](2026-08-22-web-in-page-file-preview.zh.md)

## Problem

Clicking a file path in a web session asked the Host operating system to open it. On a loopback page the opener hands the path to a real desktop application, so the user left the harness to read the file, and on a remote or headless deployment the hand-off could not reach a desktop at all. The chat flow already *read* the file (a `read` tool card shows it; produced files are named at the turn tail), but there was no way to view an arbitrary path the conversation mentioned — the only affordance was "open in the OS".

## Decision

**A readable local file path opens as a preview inside the right details column, and only the unreadable remainder hands off to the OS.** The click path is unchanged at every source (`ProducedFiles` chips, inline file mentions, and `read`/`write`/`edit` tool-row path links all call the same injected `openFile`), so the behavior change is implemented once, at the conversation `openFile` handler:

1. Resolve the path against the session cwd.
2. Try `workspaces.readFile(path)`, a new unary Host RPC `host.readFile` that reads the file's text (bounded, NUL-probe binary detection, extension-derived language hint).
3. On success, write the path + language hint into the shared chat store's `previewFile` field and open the details column. The details panel renders a `ReadBlock` preview (line numbers, syntax highlight, expand) with a truncation notice when the file exceeds the byte cap, and an "open in system" hand-off.
4. On refusal (`file-read-failed`: directory, binary, missing, unreadable, over the cap — or the reader failing), fall back to `workspaces.openPath`, the previous OS hand-off; a refusal there keeps the existing in-page error dialog and retry.

**Rendered toggle.** A Markdown file's preview carries a source/rendered toggle: the source view is the `ReadBlock` line-numbered card, and the rendered view parses the same text through `MarkdownText` (GFM, tables, math, code). The toggle appears only for a `lang` hint that reads as Markdown (`md`/`markdown`/`mdx`), resets to source when the target path changes, and renders the same text the source view shows (including the truncated window when the file exceeded the cap). Wiki links stay literal and local relative images do not load on this generic surface — the knowledge-base panel owns double-link navigation and asset resolution.

**Security.** `host.readFile` is a privileged loopback-only unary RPC, pinned alongside `openPath` and `pickDirectory` in the connection `PRIVILEGED_METHODS` set. It carries a byte cap (default 256 KB) and fails a leading NUL window as binary rather than decoding garbage. It is deliberately loopback-only: remote Web clients keep the prior OS-open behavior (which also fails on a headless host) and cannot read arbitrary local files through the harness.

**State vs content.** The chat store persists only `previewFile: { path, lang }` — never the file text. The `readFile` response lives in component-local state inside `DetailsFilePreview`, keyed by a monotonic request id so a re-target mid-flight cannot show a stale read.

## Alternatives considered

- **Reuse the prior OS-open-only path** — that is the behavior being replaced; it leaves remote/headless clients unable to view, and forces every file through the Desktop.
- **Serve the file over HTTP from the harness** — rejected here for the same reason the [workspace file links](2026-07-31-web-workspace-file-links.md) note rejected it: serving beside `/api` is unsafe (no same-origin isolation), and serving separately is out of scope for a preview surface.
- **Keep the whole file in the persisted chat store** — rejected; the store writes whole-value JSON to `localStorage` (see `snapshot store` persistence), so a large preview would bloat and then silently disable persistence. Only the small path/lang pair persists.
- **Let the config drive the preview cap** — rejected; the cap is a product-surface constant, not a deployment-varying choice, so it stays a constant rather than a `Config` field.

## Consequences

Local file paths in the chat now preview in-page instead of launching the OS app; the OS hand-off remains as the fallback and as the explicit "open in system" action inside the preview. The `host.openPath` decision and its failure dialog ([tool-call file open in OS](2026-07-28-tool-call-file-open-in-os.md)) remain current for the unreadable remainder. The conversation width widened from 748 px to 920 px (`--dsh-chat-content-width`) as part of making a split left-conversation/right-preview layout comfortable.
