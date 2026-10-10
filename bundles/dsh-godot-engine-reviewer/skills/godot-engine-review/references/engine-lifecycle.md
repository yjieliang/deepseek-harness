# 引擎底层机制（上）：对象、帧与生命周期

> **本文件是「要验的清单」，不是「已验的结论」。** 每一行都是审查时要追问、可用探针证伪的机制面；凡未在本机跑出 A 级证据的行，裁决单里不得当事实引用。
> 状态列：【规则类】= 语言/工程纪律，不需实测即可要求；【待实测】= 引擎行为，必须 A 级证据。
> 下集（资源、GDScript 运行时、线程、导出、GDExtension/C#）见 `engine-runtime.md`。

## 1. 对象与内存

| 机制 | 要追问的不变量 | 常见错解 | 探针怎么测 | 状态 |
|---|---|---|---|---|
| `Object` / `RefCounted` / `Node` | 谁需要手动 `free`、谁靠引用计数 | 对 `Node` 用引用计数思维、对 `RefCounted` 调 `free()` | 建节点/资源，断引用后打印 `Performance.get_monitor(OBJECT_COUNT)` | 待实测 |
| 孤儿节点 | 被 `remove_child` 但未释放的节点会积压 | 以为 `remove_child` 等于释放 | 循环 `remove_child` 不 `queue_free`，看 Orphan Nodes 监视器曲线 | 待实测 |
| `queue_free` 时机 | 释放发生在帧末，期间对象仍存活 | `queue_free` 后立刻访问属性、或以为已释放 | 打印 `is_queued_for_deletion()` 与下一帧的 `is_instance_valid()` | 待实测 |
| `free()` 与信号 | 直接 `free()` 可能让挂起连接悬空 | 在信号回调里 `free()` 自己 | 回调内 `free()` 后看是否报错/崩溃 | 待实测 |

## 2. 主循环、帧阶段与通知顺序

| 机制 | 要追问的不变量 | 常见错解 | 探针怎么测 | 状态 |
|---|---|---|---|---|
| 帧阶段 | idle 与 physics 是两条节奏，physics 有固定步长与插值 | 在 `_process` 里做物理/刚体设定 | 打印 `Engine.get_physics_frames()` 与 `Engine.get_process_frames()` 比值 | 待实测 |
| 通知顺序 | 进入树 → `_ready` → 逐帧 → 退出树 → 预删除的顺序与父子次序 | 以为子节点 `_ready` 早于父节点、或在 `_enter_tree` 里取子节点 | 父子各打日志，比对输出顺序 | 待实测 |
| `process_mode` / 暂停 | 暂停时哪些节点仍处理、`PROCESS_MODE_*` 的继承规则 | 用 `get_tree().paused` 后忘了谁还该跑 | 暂停后打印各节点是否收到 `_process` | 待实测 |
| 时间源 | `delta` 的语义在两处不同；`Time` 单例与 `OS` 旧 API | 用 `OS.get_ticks_msec()`、把 `delta` 当固定值 | 对比 `delta` 分布与 `Time.get_ticks_msec()` | 待实测 |

## 3. SceneTree、延迟调用与生命周期

| 机制 | 要追问的不变量 | 常见错解 | 探针怎么测 | 状态 |
|---|---|---|---|---|
| `call_deferred` / `set_deferred` | 延迟到帧末/空闲执行，用于物理回调中改物理状态 | 在物理回调里直接改会报错的属性 | 物理回调内直接改 vs `set_deferred` 各跑一次 | 待实测 |
| 场景实例化 | `instantiate` 后方可入树；`owner` 影响保存与打包 | 用旧 `instance()`、以为入树即设 `owner` | 实例化后打印 `owner` 再入树 | 待实测 |
| 场景切换 | 旧场景释放与新场景就绪的时序；跨场景数据的承载者 | 切场景时把数据挂在要被释放的节点上 | 切换前后打印 `is_instance_valid` | 待实测 |
| 生命周期与信号 | 节点可能比连接活得久，退出树时要断开 | 只在 `_ready` 连、不断开 | 释放发送者后看接收者是否报错 | 待实测 |

## 4. 信号与 Callable

| 机制 | 要追问的不变量 | 常见错解 | 探针怎么测 | 状态 |
|---|---|---|---|---|
| 连接 API | 现代写法是 `signal.connect(callable)` / `signal.emit()` | 字符串式 `connect("s", obj, "m")`、`emit_signal` | 两种写法各跑一次并看报错/警告 | 规则类 |
| 重复连接 | 同一 Callable 重复连接不会叠加；不同 Callable 会 | 在 `_process` 里 `connect`（每帧新增一个连接） | 每帧连接后打印 `get_connections()` 数量 | 待实测 |
| 连接标志 | 一次性、延迟、引用计数三种标志改变调用时机与生命周期 | 该用一次性却手动断开、该延迟却直接连 | 各标志跑一次比对调用帧号 | 待实测 |
| `await` 与释放 | `await` 挂起后发送者被释放时协程的行为 | 挂起后回来直接写回已释放对象 | 释放发送者后看协程是否恢复/报错 | 待实测 |
| 同步 vs 异步 | 信号是同步调用链，不是消息队列 | 用信号代替普通函数调用、指望它解耦调用时序 | 打印回调栈/帧号确认同步 | 待实测 |