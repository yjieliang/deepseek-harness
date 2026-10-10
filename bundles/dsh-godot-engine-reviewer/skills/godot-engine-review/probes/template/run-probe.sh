#!/bin/sh
# 引擎探针运行器（Linux / macOS）。把引擎版本、平台与原始输出一起当证据。
#
#   sh run-probe.sh                 # 跑本目录的 probe.gd
#   GODOT_BIN=/opt/godot/godot sh run-probe.sh
#
# 引擎查找顺序：GODOT_BIN → PATH 上的 godot / godot4 / Godot。
# 找不到就响亮失败，不猜、不下载。

set -eu

probe_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
engine=${GODOT_BIN:-}

if [ -z "$engine" ]; then
  for candidate in godot godot4 Godot; do
    if command -v "$candidate" >/dev/null 2>&1; then
      engine=$(command -v "$candidate")
      break
    fi
  done
fi

if [ -z "$engine" ]; then
  echo "找不到 Godot 引擎。请设置 GODOT_BIN 指向可执行文件。" >&2
  exit 127
fi

if [ ! -f "$probe_dir/probe.gd" ]; then
  echo "探针目录里没有 probe.gd：$probe_dir" >&2
  exit 2
fi

echo "PROBE/engine_bin=$engine"
echo "PROBE/engine_version_check=$("$engine" --version 2>&1 || true)"
echo "PROBE/probe_dir=$probe_dir"

# 让引擎的 user:// 落在探针目录里：既不污染开发者真实的 Godot 数据目录，也避免
# 写入被拒时往证据里插错误行（Windows 侧 run-probe.ps1 做同样的事，2026-10-09 实测）。
user_dir="$probe_dir/_data"
mkdir -p "$user_dir"
XDG_DATA_HOME="$user_dir"
export XDG_DATA_HOME
echo "PROBE/xdg_data_home_override=$user_dir"
echo '---- engine output ----'

set +e
"$engine" --headless --path "$probe_dir" --script res://probe.gd 2>&1
code=$?
set -e
echo "---- end (exit $code) ----"
exit "$code"