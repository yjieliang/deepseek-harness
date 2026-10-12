# 发布就绪报告（模板）

## 怎么用

- **写给谁**：本专家自己（用于在 `/gate-check` 之前自评一次），以及评审团的验收席位（按配额与门禁拍板）、技术席位（性能与红线）、玩家/用户本人（规则真相源与 ADR 验收）。
- **填完存哪**：默认存 `production/qa/release-readiness-{{date}}.md`；项目若已有发布目录约定，可存 `production/releases/`。需要 CCGS 门控形态时另跑 `/gate-check`（它的报告落 `production/gate-checks/`，**需人同意**后写入）。
- **填的纪律**：① 每个阈值与字面量都要带来源；② 判定字面量逐字照抄，不改写、不翻译、不改大小写；③ 缺证据、缺工具、分母为 0 一律写 `NOT ASSESSED` 并点名缺什么，**不得因为「计划里写了」记 `PASS`**；④ **本报告不写 `project.stage`**，也不写 `production/stage.txt`——那是 `/gate-check` 在 `PASS` 且用户确认后的动作；⑤ 换算成评审团口径的结论是**建议**，不是裁决。
- 完整规程见 `references/03-release-readiness.md`。

---

## 一、档位头

```
{{贴 tools/ccgs-config.mjs 的完整输出块（每行 key: value (source)）}}
```

| 项 | 值 |
|---|---|
| 目标阶段（本项目坐标） | {{M0 / M0b / M1 / M2 / M3 / M4 / M5 / M6 / M7}} |
| 目标阶段（CCGS 坐标） | {{Technical Setup / Pre-Production / Production / Production（后期）/ Polish / Release}} |
| 阶段名来源 | {{`project.yaml → project.stage` / `production/stage.txt` / 两处皆无 ⇒ 已向人确认，确认人：{{人}}}} |
| 报告日期 / 填表人 | {{date}} / {{填表人}} |

> ⚠️ 阶段不得推定：`project.yaml` 无 `project.stage`、`production/stage.txt` 亦不存在时，**先向人确认**目标阶段再往下填。

## 二、第 0 层 · 本项目 DoD（5 条，逐字）

| # | 条款（逐字） | 判定规程 | 本次判定 | 证据路径 |
|---|---|---|---|---|
| ① | headless 测试全绿 | 跑 `project.yaml → commands.test`；退出码 `0` 才算绿；跑不了或零测试不得记绿 | {{PASS / FAIL / NOT ASSESSED}} | {{日志或报告路径}} |
| ② | `tools/validate_data.py` 全绿 | **先核文件是否存在**；不存在即 `NOT ASSESSED` | {{…}} | {{路径或「文件不存在」}} |
| ③ | 有证据（JSON 报告或截图） | 逐条核 A 级证据是否在盘 | {{…}} | {{路径}} |
| ④ | 无「待定规则分支」（未裁决的规则必须显式报黄，不允许静默取默认值） | 扫 `[TL]` / `[假设]` / `[PLACEHOLDER` / `## Open Questions`，逐条点名 | {{…}} | {{清单路径}} |
| ⑤ | 每条新增规则函数头部带 `# 来源：docs/<文件> §<节>` | 逐函数检查来源行；无代码即 `NOT ASSESSED` | {{…}} | {{清单路径}} |

| 第 0 层汇总裁定 | {{通过 / 不通过}} |
|---|---|
| 若不通过：结论上限 | `CONDITIONAL`（个别条目缺证据）或 `NOT ASSESSED`（整层无法评估） |

## 三、计划点名但磁盘上不存在的可执行物

| 可执行物 | 点在哪 | 磁盘实况（{{date}} 清点） | 判定 |
|---|---|---|---|
| `tools/validate_data.py` | DoD ②、M0 0.2 / 0.5、计划 §10 第 5 行 | {{存在 / 不存在}} | {{NOT ASSESSED}} |
| `tools/monte_carlo.py` | M1 1.9 | {{存在 / 不存在}} | {{NOT ASSESSED}} |
| `art_validate.py` | M7 验收 | {{存在 / 不存在}} | {{NOT ASSESSED}} |
| `tests/` 与 `addons/gdUnit4/` | `commands.test`、M1 硬标准 1 | {{存在 / 不存在}} | {{NOT ASSESSED}} |

## 四、阶段硬标准逐条

| 阶段 | 条目（逐字验收/判据） | 来源 | 本次判定 | 证据路径 |
|---|---|---|---|---|
| M0 | 0.1 工程能被 Godot 打开且无报错；`engine.name/version` 与实际一致 | 计划 §1 | {{…}} | {{…}} |
| M0 | 0.2 `validate_data.py --arch` 能识别结构 | 计划 §1 | {{…}} | {{…}} |
| M0 | 0.3 每条冲突有明确裁决字面量 + 理由 + 代价 | 计划 §1 | {{…}} | {{…}} |
| M0 | 0.4 `d20` 优势/劣势/大成功/大失败各有断言；同 seed 重放一致 | 计划 §1 | {{…}} | {{…}} |
| M0 | 0.5 对 `docs/职业/` 的 10 张卡抽取数据后报绿（含 δ→六维复算） | 计划 §1 | {{…}} | {{…}} |
| M0 | 0.6 对两张锚点图跑出 CIELAB 色板与影调统计 | 计划 §1 | {{…}} | {{…}} |
| M0 | 0.7 不再出现「零文件通过」的假绿 | 计划 §1 | {{…}} | {{…}} |
| M0b | 硬判据 **P95 ≤ 2 ms**；分档 T1 ≤ 0.12 / T2 0.12–0.5 / T3 0.5–2 / T4 > 2 | `probe-plan-M0b-P6.md` §5 | {{…}} | {{探针日志}} |
| M1 | 1. `tests/rules_selftest.gd` 与 `tests/data_selftest.gd` headless 全绿 | 计划 §3 | {{…}} | {{…}} |
| M1 | 2. 10 张卡 δ→六维档位复算全部通过 | 计划 §3 | {{…}} | {{…}} |
| M1 | 3. 优势/劣势 9 格矩阵全绿 | 计划 §3 | {{…}} | {{…}} |
| M1 | 4. `production/reports/monte_carlo_M1.json` 落盘且对 SB +3 给出明确结论 | 计划 §3 | {{…}} | {{…}} |
| M1 | 5. `rules/` 与 `core/` 零 Node 依赖 | 计划 §3 | {{…}} | {{…}} |
| M2 | 固定 seed 跑完整 4v5 结果快照比对一致；反应窗口有专项测试；结束条件与总结算正确；1 张截图 | 计划 §4 | {{…}} | {{…}} |
| M3 | 三档消化可运行时切换并断言；失控 80/100 各跑一遍出日志；角色卡截图 1 张 | 计划 §5 | {{…}} | {{…}} |
| M4 | 角点测试报告落盘 JSON；判卷 2×2 四格全绿且「猜错零反馈」被断言；一条完整链路跑通；1 张截图 | 计划 §6 | {{…}} | {{…}} |
| M5 | 存档等价报告落盘；「读档刷骰无效」有专项测试；探索截图 1 张 | 计划 §7 | {{…}} | {{…}} |
| M6 | 全途径蒙特卡洛 + 数据校验全绿；6.6 逐卡回读审计对照表；6.7 `monte_carlo_M6.json` 与 M1 报告 diff | 计划 §0 / §8 | {{…}} | {{…}} |
| M7 | `art_validate.py` 全绿报告 + 5 张截图 + 生成台账完整（seed 与提示词可复现）+ 7 条美术门禁全绿 | 计划 §9 | {{…}} | {{…}} |

| 本阶段实体条目全 `PASS`？ | {{是 / 否}} |
|---|---|
| 张数口径（M7） | 权威来源 `design/美术资源规划-v1.md`：{{A1 = 47 · A3 = 19 · 总 = 165}} |

## 五、ADR 状态

| ADR | Status（逐字） | 验收人 / 日期 | 依赖是否 `Accepted` | 判定 |
|---|---|---|---|---|
| `adr-0001` … `adr-0006` | {{Accepted}} | {{用户本人 / 2026-10-07}} | {{…}} | {{…}} |
| `adr-0007` | {{Proposed / 未起草}} | {{—}} | {{…}} | {{…}} |

| 状态读取方式 | 6/6 份 ADR 无 `## Status` 标题，状态写在 `> **Status**: …` 引用行 ⇒ 只认实际读到的引用行；读不到记 `NOT ASSESSED` |
|---|---|
| 验收权 | `Accepted` 只在用户本人（`/architecture-decision accept`）；本专家不得代验收 |
| 依赖图 | {{0001, 0003 → 0002 → 0004 → 0005 → 0006（无环）}} |

## 六、红线清单核对（`docs/architecture/control-manifest.md`）

| 核对项 | 事实（逐字） | 判定 |
|---|---|---|
| `Manifest Version` | {{2026-10-08.1}} | {{…}} |
| 规则总数 | Foundation 31 / 16 / 4；Core 16 / 10 / 2；Feature 6 / 4 / 0；Presentation 6 / 0 / 0 | {{…}} |
| `TD-MANIFEST` | **`NOT ASSESSED`** —— 导演门控未执行，**这不是批准** | {{…}} |
| 溯源缺口 | 两条 Core Forbidden（`allow_partial_path` 禁用 · 单位占据不得写进 `set_point_solid`）来源指向一次尚未完成的 ADR-0005 修订 | {{不计入已溯源通过计数}} |
| 平台口径 | 移动端阈值判 `N/A`（PC only）——口径，不是待办 | {{…}} |
| 空层 | Feature / Presentation 的空白为如实记录；Presentation 性能护栏不得凭记忆补写 | {{…}} |

## 七、评审闭环

| 核对项 | 事实（逐字） | 本次状态 |
|---|---|---|
| 首轮结论 | `MAJOR REVISION NEEDED`（驳回）；`F·S1` → `Needs Revision` | {{…}} |
| 计数 | §2 共 45 行（Blocker 5 · Major 32 · Minor/Nit 8 聚合行）；§6 未闭环 17 项 | {{…}} |
| 未闭环 5 条 | `#1` · `#13` · `#14` · `#21` · `#33` | {{逐条状态}} |
| 决定第 2 轮的关键 | `#1` 与 `#33`：ADR 落地前不得判闭环，`F·S1` 不能排期 | {{…}} |
| 前置链 | P-6 读数 → ADR-0007 → `F·S1` 第 2 轮复评 | {{…}} |
| 复评规则 | 只审 §6 的 17 项 ＋ §6.1 的 2 项；上限 3 轮；同一席位连续 2 轮仍有未闭环 Blocker ⇒ 锁定驳回并升级项目级决策 | {{…}} |

| 未闭环 Blocker 数 | {{N}}（≥1 ⇒ 结论不得为 `READY`） |
|---|---|
| 第 2 轮复评是否已跑 | {{是 / 否}} ⇒ {{未跑时该层记 `NOT ASSESSED`}} |

## 八、性能预算按阶段取值

阶段值权威来源：评审团 `references/baseline.md` §3.2（P95 帧时间第 74 行 · 场景切换第 77 行 · 峰值内存第 78 行）；项目写入值另见 `project.yaml → performance`。

| 指标 | 原型 | Alpha | Beta·RC | 项目写入值 | 本次实测 | 判定 |
|---|---|---|---|---|---|---|
| P95 帧时间 | ≤ 25 ms | ≤ 20 ms | ≤ 16.6 ms | {{16.6 ms（Beta·RC 目标）}} | {{实测}} | {{…}} |
| 单次寻路 P95 | ≤ 2 ms | ≤ 2 ms | ≤ 2 ms | {{2 ms（项目红线）}} | {{实测}} | {{…}} |
| 场景加载 | — | ≤ 3 s | ≤ 2 s | {{2 s}} | {{实测}} | {{…}} |
| 峰值内存（PC） | — | 3 GB（基线 PC 列） | 基线 2.5 GB ⇒ 本档取更严的 2.5 GB 判（项目登记 3 GB） | {{3072 MB}} | {{实测}} | {{…}} |
| 稳态内存 | — | — | — | {{≤ 1024 MB}} | {{实测}} | {{…}} |
| Draw calls | — | — | — | {{≤ 512（助手提案值）}} | {{实测}} | {{…}} |
| 移动端列 | `N/A` | `N/A` | `N/A` | — | — | `N/A` |
| 基线已登记、项目未配置项 | {{1% Low FPS / 冷启动 / 8 小时孤儿节点增长 / 崩溃率 / 包体}} |  |  | {{无对应键}} | {{实测或缺}} | {{NOT ASSESSED}} |

| `performance.enforce` | {{warn（默认）/ block / off}} |
|---|---|
| 键名核对 | {{权威拼写已核（`04-参考/效果映射索引.md` 第 95/96/120 行）；项目键是否已改为 `target_framerate` / `memory_ceiling_mb`}} |
| 是否误把 16.6 ms 卡到原型阶段 | {{否}} |

## 九、逐门产物清单（框架语料替代）

| 项 | 结论 | 证据 |
|---|---|---|
| `/gate-check` 的 `references/gate-*.md`（6 份） | {{未交付 ⇒ 用替代物}} | {{…}} |
| `/gate-check` 的 `CONTRACT.md` | {{未交付}} | {{…}} |
| 替代物 `06-导演门控.md`（65,792 字节，28/28 门控） | {{已读到 / 语料不可用}} | {{绝对路径}} |
| 语料解析 | {{`$CCGS_ESSENCE_DIR` → `D:\AI\test\ccgs-essence` → `NOT ASSESSED — framework corpus unresolved`}} | {{实际命中项}} |

## 十、判定与换算建议

| 项 | 值 |
|---|---|
| 输出判定（逐字，取第一条命中） | {{`NOT READY` / `NOT ASSESSED` / `CONDITIONAL` / `READY`}} |
| 命中的理由 | {{…}} |
| 换算建议（**建议，不是裁决**） | {{`READY` ↔ 通过 / `CONDITIONAL` ↔ 有条件通过 / `NOT READY` 或 `FAIL` ↔ 驳回}} |
| 阻塞项清单 | {{逐条：条目 · 为什么 · 谁承接}} |
| 有条件项清单 | {{逐条：缺口 · 绕行 · 谁接受风险}} |
| 未评估项清单（须点名是哪一项、为什么） | {{逐条}} |

| 本专家不做的三件事 | ① 不写 `project.stage` / `production/stage.txt`；② 不代替用户验收 `Accepted` ADR；③ 不出评审结论与放行终裁 |
|---|---|
| 终裁归属 | 评审团验收席位汇总 → 主理人终裁；规则真相源与红线归用户本人 |

## 十一、发布阶段前置事实（尚未到 Release 时照填）

| 项 | 事实 | 结论 |
|---|---|---|
| `/team-release` | 阶段非 `Release` ⇒ 在第一个阶段前停下、不派生任何代理；提示 `The release readiness gate has not passed (project.stage: [stage]) — run /gate-check release first.` | {{会直接停}} |
| `/release-checklist` | 读 `platform.cert_tier`；**未设置 ≠ `none`** | {{未设置 ⇒ `### Certification: NOT ASSESSED — cert tier unknown`}} |
| `/launch-checklist` | 四值 `none \| itch \| steam \| console`；未设置时标 `NOT ASSESSED — cert tier unknown` | {{…}} |
| `project.yaml → platform` 块 | {{存在 / 不存在}} | {{…}} |

## 十二、证据归档与复核

| 内容 | 路径 |
|---|---|
| 本报告 | {{production/qa/release-readiness-{{date}}.md}} |
| 逐项证据 | {{production/qa/evidence/[项-slug]-evidence.md}} |
| 原始日志（A 级） | {{probe/out/<name>.log}} |
| 量化报告（A 级） | {{production/reports/*.json}} |

| 证据分级 | A 原始日志/JSON/截图/退出码 · B 项目文档 · C 外部资料（标访问日期与小节）· D 推测（附证伪方法，单列） |
|---|---|
| 复核人 / 复核日期 | {{复核人}} / {{date}} |
| 复核结论 | {{一致 / 有出入（逐条列出）}} |
