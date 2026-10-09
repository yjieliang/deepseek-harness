# 角色与职能：生成快照

> **本文件是生成快照，不是第二份真相。** 真源是插件里的角色记录与各预设的角色声明；本文件只是某一时刻的投影，会随实现与配置变化而过期。按职能路由、判断某个角色能不能接某条任务时，以 `requirement_role` 给出的角色记录为准；对不上就重新生成本文件，不要在这里改结论。
>
> **生成时间**：2026-10-09 22:20（+08:00）。
> **生成依据**：profile 用户层 `~/.dsh/profiles/web/cordis.patch.yml` 与开发期覆盖层 `dev.overlay.yml` 里各 4 条角色重述（同一组）、`dsh-godot-engine-reviewer` bundle 自带的 1 条声明、预设注册表实况（11 个预设及其显示名，其中 4 个内置预设无显示名）、`host/roles.js` 的解析、投影与预设名册规则、`host/model.js` 的词表常量、`host/templates.js` 的模板定义。
> **再生成**：重读上述来源的当前版本，重建各表并更新生成时间；不要凭记忆补角色或职能。

## 1. 角色从哪来（解析链）

角色只有一条解析链，按优先级：

1. **预设声明**：预设的 isolate 组里有一条角色声明行（`roleId` / `roleName` / `duties`）→ 用声明，来源标 `preset`。
2. **预设 id 兜底**：预设没有声明 **且预设 id 本身就是合法角色 id** → 用该 id 当角色，来源标 `observed`，**职能为空**。这是内置预设零配置就有角色的代价：有角色 id，但按职能路由对它无效。（预设 id 是平台的自由字符串，形如 `Art Team` 的 id 不当角色，宿主会报一次 warn。）
3. **没有角色**：没有 agent、没有预设注册表、未绑定预设、或兜底 id 不合形 → 解析不出角色，**报"没有"而不是编一个**。

记录与覆盖规则：

- 会话创建时按上面的链建档一次；同角色 id 重复建档不会无谓写入。
- **面板手工编辑（来源 `manual`）与派发的临时角色（来源 `delegated`）优先**：预设声明不会覆盖手工值；只读的 `observed` 引用也不会覆盖声明。
- 模型可见的角色段 = **角色记录优先，回退到预设声明**；两者都没有职能时，段落直接写"未记录职能，无法按职能路由"。
- 未登记：**有在跑会话**解析到某个角色 id、**或**某条需求的 `role` 引用了它，而库里没有它的记录时，它列在**未登记**里（带在跑会话计数与未完成数）；需求侧另读 `roleUnregistered: true`。这不是"该角色存在且有职能"；写任务时选错了角色 id 会一直停在这里——按第 2 节生成时的表选，或先在面板登记。

## 2. 本机 11 个预设的角色声明（生成时）

| 预设 id | 预设显示名 | 角色 id | 来源 | 职能 |
|---|---|---|---|---|
| `standard` | （无，回落 id） | `standard` | `observed` 兜底 | **无**（缺职能） |
| `ptc` | （无，回落 id） | `ptc` | `observed` 兜底 | **无**（缺职能） |
| `minimal` | （无，回落 id） | `minimal` | `observed` 兜底 | **无**（缺职能） |
| `cordis` | （无，回落 id） | `cordis` | `observed` 兜底 | **无**（缺职能） |
| `godot-review-board` | Godot 项目评审团 | `godot-review-board` | `preset` 声明 | 代码与架构评审；量化基线核对；评审意见分级 |
| `godot-game-suite` | 银橙AI · Godot 引擎开发专家 | `godot-game-suite` | `preset` 声明 | GDScript 实现；场景与节点搭建；游戏系统集成 |
| `game-mechanics-designer` | 机枢 · 游戏机制与数值设计师 | `game-mechanics-designer` | `preset` 声明 | 核心玩法设计；数值体系搭建；经济体系搭建 |
| `ccgs-studio` | CCGS 工作室模式 | `ccgs-studio` | `observed` 兜底 | **无**（缺职能） |
| `godot-shader-developer` | 渲染达 · Godot 着色器开发者 | `godot-shader-developer` | `preset` 声明 | 着色器编写；渲染管线调优；材质与视觉效果实现 |
| `godot-game-script-engineer` | 节点通 · Godot 游戏脚本工程师 | `godot-game-script-engineer` | `observed` 兜底 | **无**（缺职能） |
| `godot-engine-reviewer` | 银橙AI · Godot 引擎审查专家 | `godot-engine-reviewer` | `preset` 声明 | 引擎侧结论裁定；反模式识别；版本与平台兼容核对；证据链核验 |

要点：

- 声明里的角色 id **就是预设 id**：加声明只补职能，不改变任务该写哪个角色 id。
- **5 条声明的载体随运行方式而定**：`godot-review-board`、`godot-game-suite`、`game-mechanics-designer`、`godot-shader-developer` 这 4 条，在 profile 运行里由用户层 `~/.dsh/profiles/web/cordis.patch.yml` 重述该预设的 config 承载（阶段 R 已并入），在开发期运行里由覆盖层 `dev.overlay.yml` 承载同一组声明；`godot-engine-reviewer` 的声明随它自己的 bundle patch 走（`bundles/dsh-godot-engine-reviewer/presets/godot-engine-reviewer.patch.yml` 的 isolate 组）。**按 id 定向的补丁是 config 整体替换、不深合并**，所以在用户层重述一个预设要把它的整份 config 一并带上。
- `ccgs-studio` 与 `godot-game-script-engineer` **没有声明**（各自 bundle 里都没有角色行）→ 落到 `observed` 兜底：角色 id 能用，但没有职能。要让它们按职能路由，得先补声明或在面板登记。
- 预设顺序：内置 4 个为 1–4；`godot-review-board` 60、`godot-game-suite` 61、`game-mechanics-designer` 62、`ccgs-studio` 62（**与前者并列**）、`godot-shader-developer` 63、`godot-game-script-engineer` 64、`godot-engine-reviewer` 65。
- 内置 4 个**刻意不声明**——opt-in 不进 shipped defaults，代价就是缺职能。
- 声明必须放在 `isolate` 组里；直接声明会把服务发布到进程全局，该预设会被注册表判为 broken（实测报 `Preset services require isolate realms`）。
- "缺职能"是**降级不是报错**：`requirement_role`、面板与 prompt 都会说出来，从不静默。

## 3. 角色词表与保留值

| 项 | 值 |
|---|---|
| 角色 id 形状 | `^[a-z][a-z0-9_-]{0,31}$` |
| 显示名 | ≤ 40 字；留空时回落角色 id |
| 职能 | 最多 12 项，每项 ≤ 40 字 |
| `human` | **保留**：不能声明为 AI 角色（面板新建也拒），它属于人 |
| `tmp-` 前缀 | **保留**：只有派发能铸造 `tmp-<任务id>`；面板不能建，也不能删临时角色（删除归派发收尾） |
| 角色管理 | **仅面板**：新建 / 改名 / 改职能 / 删除都走面板；模型侧只有 `requirement_role` 的读动作 |

## 4. 读取面（模型与面板看到什么）

`requirement_role` 的读动作返回两块：

- **已登记角色**：id、显示名、职能、来源、`ephemeral`（是否临时角色）、临时角色的绑定会话与绑定任务、缺职能标记、在跑会话计数（在线 / 空闲 / 运行）、该角色名下未完成的需求数。
- **未登记**：在用但没有记录的 id，同样带缺职能标记、在跑会话计数与未完成数。

边界：

- 在跑会话计数来自进程内的 agent 注册表；注册表拿不到时**报 null 并带说明**，不编造 0。
- 缺职能 = 记录与预设声明都为空；它**不是**"这个角色什么都能做"。
- 面板的角色列表含编辑入口，临时角色行标出 `ephemeral` 与绑定；这是人管理角色的唯一入口。
- 面板的角色管理还带一块**预设对照区**（`role.list` 的 `presets`，模型侧看不到）：第 2 节的 11 个预设逐个列成一行，给出各自解析到的角色 id、是否已建档、有无活会话、启用诊断；没建档的预设行带**一键登记**（预填 id 与显示名，仍走面板 `put`）。名册读不到时它分开报"组合没挂预设注册表"与"读取失败"，不伪装成空名册——所以**"对照区里没有某预设"有两种含义**：真的没声明，或没读到；面板上分得清。

## 5. 标准流程模板的节点（现状）

内置模板 `tpl-standard`（标准研发流程：评审 → 设计 → 实现 → 验证 → 发布，version 1，builtin）的节点：

| 序 | 节点 id | 名称 | 前置节点 | 负责人 | 完成条件 |
|---|---|---|---|---|---|
| 0 | `review` | 需求评审 | — | 空 | 检查项：范围与验收标准已明确、相关方已确认 |
| 1 | `design` | 方案设计 | `review` | 空 | 人工确认，需写说明 |
| 2 | `build` | 开发实现 | `design` | 空 | 人工确认 |
| 3 | `verify` | 测试验证 | `build` | 空 | 检查项：用例执行完成、遗留缺陷已关闭 |
| 4 | `release` | 发布上线 | `verify` | 空 | 人工确认，需写说明 |

要点：

- 节点上的"负责人"是**自由文本**（≤120 字），**不等于角色 ID**；它现在**全部为空**，节点级负责人与角色路由是两件事。
- 节点前置（`dependsOn`）是**模板内**的先后关系，与跨任务的门禁（任务之间的"等谁"）不是一回事。

## 6. 本快照的边界

- **不列会话持有数**：角色记录在会话创建时建档，具体条目取决于哪些会话曾在线以及面板是否手工改过；本文件只列**稳定可复现的声明与解析规则**，不冒充某时刻的库内容。
- **任务侧的角色字段**（需求路由到角色、指名派发的绑定与临时角色）属派发面，见 [dispatch.md](dispatch.md)；**前置依赖 / 父需求**（门禁）与**执行状态**（执行单元自动同步）属任务执行面，见 [SKILL.md](../SKILL.md) 的第 9、10、8 条。
- 角色用于路由是"读 + 筛选"（可接筛选按角色过滤）；它**不是授权**，也不代表持有者在线。
