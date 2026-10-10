# 版本矩阵（Version Matrix）

> **上游覆盖到 Godot 4.6。** 来源：`fetasty/godot-skills`（MIT），tree sha `d52b934`，取用 2026-10-09，上游自我声明最后核对 2026-02-12。
> **上游知识截止声明**：LLM Knowledge Cutoff = May 2025（约覆盖到 Godot 4.3）；上游原文要求「4.4/4.5/4.6 的重大变化模型并不知道」，并给出官方来源（文档、迁移指南、CHANGELOG、release notes）。
> **本区使用规则**：本表是**线索表**。任何一条在裁决单里都要先落到 A 级（本机实测）或 B 级（官方文档当前版本 + 小节）。**与本机引擎版本不一致的条目一律标「未验证」。**

## 0. 风险分级（上游给的口径）

| 版本 | 上游时间 | 上游风险 | 主要内容 |
|---|---|---|---|
| 4.2→4.3 | 训练数据内 | LOW | 骨骼接口、`TileMapLayer` 取代 `TileMap`、导航区域属性移除、`AnimationMixer` 成基类 |
| 4.3→4.4 | 约 2025 年中 | MEDIUM（上游标注 **VERIFY**） | `FileAccess.store_*` 返回 bool、`draw_list_begin` 参数变更、着色器纹理类型 `Texture2D`→`Texture`、若干 API 加参 |
| 4.4→4.5 | 约 2025 年末 | HIGH（POST-CUTOFF） | GDScript 变参 `...`、`@abstract`、脚本回溯、Shader Baker、SMAA 1x、stencil、bent normal、AccessKit、`duplicate_deep()`、2D 导航服务器、FoldableContainer |
| 4.5→4.6 | 2026 年 1 月 | HIGH（POST-CUTOFF） | Jolt 成新项目 3D 物理默认、Glow 改到色调映射**前**、Windows 默认 D3D12、AgX 新控制、`Quaternion` 初始化改 identity、UI 双焦点、3D IK 恢复、编辑器主题与键位变更 |

## 1. 4.5 → 4.6（逐条）

| 变更 | 审查要点 | 状态 |
|---|---|---|
| 3D 物理默认引擎改 Jolt（新项目；旧项目保留原设置） | 「默认是 GodotPhysics」的旧结论全部作废；碰撞边界需重测 | 待本机核对 |
| `HingeJoint3D.damp` 仅在 GodotPhysics 可用 | Jolt 下被忽略并告警 | 待本机核对 |
| Glow 在色调映射**前**处理（原为之后） | 画面观感变化属**预期变更**，不是回归 | 待本机核对 |
| Windows 默认渲染后端改 D3D12（原 Vulkan） | 后端相关结论需声明后端；Vulkan 结论不能直接套用 | 待本机核对 |
| `Quaternion` 初始化为 identity（原 zero） | 未初始化四元数的行为变化，属技术性破坏 | 待本机核对 |
| UI 双焦点（鼠标/触摸焦点与键盘/手柄焦点分离） | 只测一种焦点路径的 UI 结论不成立 | 待本机核对 |
| 3D IK 恢复（CCDIK/FABRIK/Jacobian/Spline/TwoBoneIK，经 `SkeletonModifier3D`） | 旧 IK 用法与结论作废 | 待本机核对 |

## 2. 4.4 → 4.5

| 变更 | 审查要点 | 状态 |
|---|---|---|
| GDScript 变参 `func f(prefix: String, values: Variant...)` | 自写变参方案可简化 | 待本机核对 |
| `@abstract` 装饰类与方法 | 抽象基类的替代写法可替换 | 待本机核对 |
| 脚本回溯在 Release 也可用 | 「Release 拿不到堆栈」的结论作废 | 待本机核对 |
| Shader Baker（上游称某些 demo 启动快 20 倍） | 多变体着色器的启动卡顿优化 | 待本机核对（上游数字不可直接引用为收益） |
| `duplicate_deep()` | 嵌套资源深复制 | 待本机核对 |
| AccessKit 无障碍 | 无障碍结论需按版本区分 | 待本机核对 |

## 3. 4.3 → 4.4（上游要求 VERIFY）

| 变更 | 审查要点 |
|---|---|
| `FileAccess.store_*` 系列由 void 改返回 bool（含 `store_buffer`/`store_line`/`store_var` 等十余个方法） | 忽略返回值的写入失败会被静默吞掉——**这是「严重」候选**：写盘失败无反馈 |
| `RenderingDevice.draw_list_begin` 删多参、加 `breadcrumb` | 自定义渲染代码需同步 |
| 着色器纹理类型 `Texture2D` → `Texture` | uniform 类型写 `Texture2D` 的着色器代码需核对 |
| `RegEx.compile` / `create_from_string` 加 `show_error` | — |
| `OS.execute_with_pipe` 加 `blocking`；`GraphEdit.connect_node` 加 `keep_alive`；`RichTextLabel.push_meta` 加 `tooltip` | — |

## 4. 4.2 → 4.3（训练数据内，LOW）

`TileMapLayer` 取代 `TileMap`；`NavigationRegion2D` 移除 `avoidance_layers` / `constrain_avoidance`；`Skeleton3D.add_bone` 返回 int32；`bone_pose_updated` → `skeleton_updated`；`AnimationMixer` 成基类。

## 5. 废弃写法对照（跨版本通用）

| 废弃 | 现行 | 来源 |
|---|---|---|
| `instance()` | `instantiate()` | C: `deprecated-apis.md` |
| `get_world()` | `get_world_3d()` | 同上 |
| `OS.get_ticks_msec()` | `Time.get_ticks_msec()` | 同上 |
| `VisibilityNotifier2D/3D` | `VisibleOnScreenNotifier2D/3D` | 同上 |
| `YSort` | `Node2D.y_sort_enabled` | 同上 |
| `Navigation2D/3D` | `NavigationServer2D/3D` | 同上 |
| `yield()` | `await` | C: `godot-gdscript/SKILL.md` |
| `playback_active` | `active` | C: `modules/animation.md` |
| `connect("s", obj, "m")` / `emit_signal` | `s.connect(callable)` / `s.emit()` | C: `godot-gdscript/SKILL.md` |

## 6. 4.7 未验证区

本包**不含** 4.7 的任何结论。本机存在 `4.7.2-stable` 引擎时，凡涉及 4.7 的判定必须：

1. 先查官方文档当前版本（B 级）——注意文档站可能已滚到新版本，需确认页面对应版本；
2. 再在本机 4.7.2 跑最小复现（A 级）；
3. 在裁决单的版本列写全小版本号，禁止写「4.x 均适用」。

已知需优先核对的面（从 4.6 风险延续，均未验证）：物理引擎默认值、渲染后端默认值、着色器纹理类型、Glow/后处理顺序、UI 焦点模型、`FileAccess` 返回类型语义、GDExtension ABI 兼容边界。

## 7. 上游已知缺陷（引用 C 级时必看）

| 缺陷 | 位置 | 处置 |
|---|---|---|
| GDExtension 示例钉 `compatibility_minimum = "4.2"`，与正文「面向 4.6 / 每次小版本重编译」自相矛盾 | `godot-gdextension/SKILL.md` | 示例按过期处理，用 B 级文档核对 |
| 联网章节未确认 4.6，只写「见官方迁移指南」 | `modules/networking.md` | 4.5→4.6 联网变更**未确认**，不得引用 |
| C# 章节通篇肯定句，无不确定性标注 | `godot-csharp/SKILL.md` | 每条引用前用 B 级复核 |
| 音频「4.4–4.6 无重大破坏」属作者判断 | `modules/audio.md` | 按推测级处理 |