# 反模式清单（Anti-Patterns）

> 依据列的 **C 级** = 上游 `fetasty/godot-skills@d52b934`（覆盖 4.6，上游核对 2026-02-12）。C 级是线索：判定前按 `evidence-protocol.md` 补 A 或 B 级证据。
> 「需实测」= 这条反模式的**代价**要用探针量化后才能写进裁决单的收益列，不能只凭清单下结论。

## 1. 节点访问与场景结构

| 反模式 | 正解 | 依据 | 严重度 | 需实测 |
|---|---|---|---|---|
| `get_node()` / `$Path` 出现在 `_process` 等热路径 | `@onready var x: T = %UniqueName` 或 `@export` 注入 | C：`references/deprecated-apis.md`（"path lookup every frame"） | 建议 | 是（量化每次查找开销） |
| 场景树过深、单场景包办多职责 | 一个场景一个职责；组合优于继承 | C：`godot/SKILL.md` | 建议 | 否 |
| 继承链超过 3 层（`Node` / `GodotObject` 之后） | 抽组件，向上只走信号 | C：`godot/SKILL.md`、`godot-csharp/SKILL.md` | 可选 | 否 |
| 编辑器里手连信号（代码里看不见） | 代码内连接，或在文档里登记 | C：`godot-gdscript/SKILL.md` | 可选 | 否 |
| Autoload 当工具函数垃圾桶、持有场景节点引用 | Autoload 只放设置/存档/事件总线/输入映射 | C：`godot/SKILL.md` | 建议 | 否 |

## 2. 帧循环与轮询

| 反模式 | 正解 | 依据 | 严重度 | 需实测 |
|---|---|---|---|---|
| 事件驱动可解决却每帧 `_process` 轮询 | `set_process(false)` / 信号 / Tween | C：`godot/SKILL.md` | 建议 | 是（量化轮询开销） |
| 关屏后仍在计算 | 可见性通知节点停算 | C：`godot/SKILL.md` | 建议 | 是 |
| 用 `_process` 做计时（音频、动画推进） | 用 `finished` 信号 / Tween / 计时器节点 | C：`modules/audio.md` | 建议 | 否 |
| 频繁实例化短命对象（子弹、伤害数字） | 对象池 | C：`godot/SKILL.md` | 建议 | 是（分配/GC 读数） |
| 大量同网格各自成节点 | `MultiMeshInstance` | C：`godot/SKILL.md` | 建议 | 是（draw call 读数） |

## 3. 协程与生命周期

| 反模式 | 正解 | 依据 | 严重度 | 需实测 |
|---|---|---|---|---|
| 用 `yield()`（Godot 3 语法） | `await` | C：`godot-gdscript/SKILL.md`（"Never use yield"） | 严重 | 否（写法错误） |
| `await` 恢复后直接写回可能已释放的对象 | 恢复后先 `is_instance_valid` | 本包 `engine-lifecycle.md` §4 | 严重 | 是（复现释放路径） |
| `queue_free()` 后立刻访问该对象 | 帧末释放；改为延迟处理 | 本包 `engine-lifecycle.md` §1 | 严重 | 是 |
| 只 `remove_child` 不释放 | 视需求 `queue_free()`；监视孤儿节点 | C：`godot/SKILL.md` | 建议 | 是（孤儿曲线） |
| 在 `_init` 里做需要入树才能做的事 | `_ready` | C：代码席位口径 + 本包 `engine-runtime.md` §4 | 建议 | 是 |

## 4. 信号

| 反模式 | 正解 | 依据 | 严重度 | 需实测 |
|---|---|---|---|---|
| 在 `_process` 里 `connect`（每帧新增连接＝泄漏） | 在 `_ready` 连接 | C：`godot/SKILL.md`（"massive leak"） | 严重 | 是（连接数曲线） |
| 字符串式 `connect` / `emit_signal` | `signal.connect(callable)` / `signal.emit()` | C：`godot-gdscript/SKILL.md` | 建议 | 否 |
| 接收方可能活得比发送方久却不断开 | `_exit_tree` 断开，或按连接标志管理 | C：`godot/SKILL.md` | 建议 | 是（释放后是否报错） |
| 用信号替代同步函数调用 | 同步通信用直接调用 | C：`godot/SKILL.md` | 可选 | 否 |
| 信号参数无类型标注（裸 Variant） | 参数全量标注类型 | C：`godot-gdscript/SKILL.md` | 可选 | 否 |

## 5. 资源与内存

| 反模式 | 正解 | 依据 | 严重度 | 需实测 |
|---|---|---|---|---|
| 热路径反复 `load()` 同一资源 | 启动期加载 + 缓存引用 | C：`godot/SKILL.md` | 建议 | 是 |
| 大资源主线程同步加载造成卡帧 | `ResourceLoader.load_threaded_request()` | C：`godot/SKILL.md` | 建议 | 是（帧时间） |
| 直接改共享 Resource 的属性 | 每实例 `duplicate()`；嵌套用深复制 | C：`godot/SKILL.md` | 严重（数据污染） | 是 |
| 自定义 Resource 无安全默认值 | `_init` 给默认值 | C：`godot/SKILL.md` | 建议 | 否 |
| 结构化数据全塞 `Dictionary` 而非 Resource | 用类型化 Resource | C：`godot/SKILL.md` | 可选 | 否 |

## 6. 类型与语言纪律

| 反模式 | 正解 | 依据 | 严重度 | 需实测 |
|---|---|---|---|---|
| 变量/参数/返回值无类型标注 | 全量静态类型；`@onready` 也标注 | C：`godot-gdscript/SKILL.md`（"Mandatory"） | 建议 | 是（性能影响需量化，别空口说） |
| 集合不用 typed `Array[T]` | 标注元素类型 | C：`godot/SKILL.md` | 可选 | 是 |
| 热路径用字符串比较 / `Array.find()` 大表查找 | `StringName` / `Dictionary` | C：`godot/SKILL.md` | 建议 | 是 |
| `@tool` 脚本无编辑器防护 | `Engine.is_editor_hint()` 防护 | 本包 `engine-runtime.md` §2 | 建议 | 否 |

## 7. 线程与并发

| 反模式 | 正解 | 依据 | 严重度 | 需实测 |
|---|---|---|---|---|
| **后台线程访问场景树** | 后台算 → 主线程应用；线程安全调用走 `call_deferred` | C：`godot-gdextension/SKILL.md`（"NEVER"） | 严重 | 是（构造越界用例复现） |
| 主线程等线程池任务 | 真并行需让主线程继续跑 | 本包 `engine-runtime.md` §3 | 建议 | 是 |
| 用了引擎对象却没保证跨线程安全 | 明确对象归属，必要时加锁 | 本包 `engine-runtime.md` §3 | 严重 | 是 |

## 8. 版本与导出

| 反模式 | 正解 | 依据 | 严重度 | 需实测 |
|---|---|---|---|---|
| 用 4.3 之前的记忆写新版本（默认物理引擎、渲染后端、纹理类型等） | 查 `version-matrix.md` + 本机核对 | C：`references/VERSION.md`、`breaking-changes.md` | 严重 | **是（必修）** |
| 导出模板与引擎小版本不一致 | 同版本导出模板 | C/规则 | 严重 | 是 |
| GDExtension 跨小版本不重编译 | 升引擎即重编译 | C：`godot-gdextension/SKILL.md` | 严重 | 是 |
| 手改 `.godot/` 或导入缓存并纳入版本管理 | 生成物不入版本管理 | 规则 | 建议 | 否 |
| `uid://` 与路径引用混用、手改 `.uid` | 由编辑器管理引用 | C：`modules/rendering.md` 同族条目 | 建议 | 是 |

## 9. C# 与 GDExtension

| 反模式 | 正解 | 依据 | 严重度 | 需实测 |
|---|---|---|---|---|
| 节点类缺 `partial`（源生成器**静默失败**） | `public partial class X : Node` | C：`godot-csharp/SKILL.md` | 严重 | 否（编译期即可判定） |
| 用 `Task.Delay()` 等待 | `await ToSignal(GetTree().CreateTimer(...), ...)` | C：`godot-csharp/SKILL.md` | 严重 | 否 |
| 非泛型 `GetNode()`、字符串式 `GodotObject.Call()` | `GetNode<T>()` + 类型化接口 | C：`godot-csharp/SKILL.md` | 建议 | 否 |
| 忘 `_ExitTree()` 退订 / 长生命周期 lambda 捕获 `this` | 退订；避免捕获 | C：`godot-csharp/SKILL.md` | 建议 | 是（对象数读数） |
| 内部数据用 `Godot.Collections.*` | 用 `List<T>` | C：`godot-csharp/SKILL.md` | 可选 | 是（封送开销） |
| 紧循环频繁进出原生边界 | 数据导向批处理、预分配缓冲 | C：`godot-gdextension/SKILL.md` | 建议 | 是 |
| 忘记注册类/方法、对引擎对象用裸指针 | 注册 + 引擎引用包装 | C：`godot-gdextension/SKILL.md` | 严重 | 是 |

## 10. 渲染与着色器（交界处，主体归"渲染达"）

| 反模式 | 正解 | 依据 | 严重度 |
|---|---|---|---|
| 透明材质不设 `render_priority`；逐像素动态分支、循环内采纹理 | 显式排序；`mix()`/`step()`、移出循环 | C：`godot-shader/SKILL.md` | 建议 |
| opaque 用 `discard` 做裁剪（移动端） | Alpha Scissor | C：`godot-shader/SKILL.md` | 建议 |
| 用 `Compatibility` 却依赖 compute / 深度纹理；手写 viewport 链代替 `Compositor` | 按渲染器分档降级；用引擎后处理通道 | C：`godot-shader/SKILL.md`、`modules/rendering.md` | 严重 |

> 渲染预算类裁定（帧时间分配、特效锁级）属评审团技术席位辖区；本角色只提供证据与交界风险，不替代其裁定。