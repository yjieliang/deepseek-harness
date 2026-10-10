extends SceneTree

## 引擎探针骨架：**一次只验一条主张**。
##
## 运行（主路径，不经任何 shell 管道）：
##   cmd /c run-probe.cmd                # Windows（绕开 .ps1 执行策略）
##   sh run-probe.sh                     # Linux / macOS
## 或直接裸调用：
##   <godot> --headless --path <本目录> --script res://probe.gd
##
## 证据约定：
##   1) 所有证据行以 `PROBE/` 前缀打印，**只用 ASCII**——本机 pwsh 会用 GBK 解码 UTF-8，
##      中文一旦经过终端/重定向管道就会变乱码，破坏证据（2026-10-09 实测）。
##   2) 同时把同样的行写进 res://probe-output.txt，由**引擎自己**落盘（FileAccess 写 UTF-8），
##      这样取证不依赖 PowerShell 的重定向——本机沙箱下原生进程输出经管道会被吞掉
##      （文件重定向得 0 字节，2026-10-09 实测）。
##   3) 探针只给观测值；「成立 / 不成立」的推理写在裁决单里，不写在探针里。

var _lines: PackedStringArray = []

func _emit(line: String) -> void:
	_lines.append(line)
	print(line)

func _initialize() -> void:
	var info := Engine.get_version_info()
	_emit("PROBE/engine_version=" + str(info.get("string", "unknown")))
	_emit("PROBE/platform=" + OS.get_name())
	_emit("PROBE/renderer=" + str(ProjectSettings.get_setting("rendering/renderer/rendering_method", "unknown")))
	_case()
	_emit("PROBE/done")
	_write_dump()
	quit(0)

## 只改这个函数体：一条主张 = 一个探针。
## 至少打印：输入条件、观测值、重复次数。不要打印预期结论。
func _case() -> void:
	_emit("PROBE/claim=template-not-replaced")
	_emit("PROBE/observed=no-observation-yet")

## 引擎自己写证据文件：避免 shell 重定向与编码陷阱。
func _write_dump() -> void:
	var path := "res://probe-output.txt"
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		print("PROBE/dump=failed")
		return
	file.store_string("\n".join(_lines) + "\n")
	file.close()
	print("PROBE/dump=" + ProjectSettings.globalize_path(path))