# NOTICE

## 本包内容

本包的 persona、技能文档、模板与检查脚本由 **银橙AI** 撰写，许可随本仓库。

## 上游知识来源与归属

本包的引擎版本条目与反模式线索**提取自**下列上游项目，按 MIT 许可使用：

| 项 | 值 |
|---|---|
| 项目 | `fetasty/godot-skills` — *Codex Godot Skills* |
| URL | https://github.com/fetasty/godot-skills |
| 取用树 | `main`，tree sha `d52b934` |
| 取用日期 | 2026-10-09 |
| 上游许可 | MIT License，Copyright (c) 2026 风酥糖 |
| 上游覆盖版本 | Godot 4.6（上游自我声明最后核对 2026-02-12） |
| 上游知识截止声明 | LLM Knowledge Cutoff = May 2025（约 Godot 4.3） |

**取用方式**：本包**未整体复制**上游文件。`skills/godot-engine-review/references/version-matrix.md` 与 `anti-patterns.md` 中的条目是提炼后的中文事实行，逐条标注来源文件与核对日期，供审查时当**线索**核对，而非当作已验结论。

若日后需要整篇 vendoring 上游文件，必须同时把上游 `LICENSE` 全文附入本包，并在上表补记文件级来源。

## 上游已知缺陷（引用时按线索处理）

| 缺陷 | 位置 | 影响 |
|---|---|---|
| GDExtension 示例 `.gdextension` 写 `compatibility_minimum = "4.2"`，与"面向 4.6、每次小版本需重编译"的正文自相矛盾 | 上游 `godot-gdextension/SKILL.md` | 示例可能未随版本更新 |
| 联网章节未给出 4.6 结论，只写"见官方迁移指南" | 上游 `godot/references/modules/networking.md` | 4.5→4.6 联网变更**未确认** |
| C# 章节通篇为肯定句，无任何"不确定/需查文档"标注 | 上游 `godot-csharp/SKILL.md` | 该章断言缺不确定性护栏，引用前需官方文档复核 |
| 音频章节"4.4–4.6 无重大破坏性变更"属作者判断，非官方引用 | 上游 `godot/references/modules/audio.md` | 按"推测"级来源处理 |