# Godot probe runner (Windows).
#
#   cmd /c run-probe.cmd                              # recommended: bypasses the .ps1 policy
#   cmd /c run-probe.cmd -ProbeDir D:\probes\p1
#   $env:GODOT_BIN = 'D:\Godot\Godot_v4.7.2-stable_win64_console.exe'; pwsh -File run-probe.ps1
#
# Engine lookup order: -Engine argument -> $env:GODOT_BIN -> newest Godot_v* under common
# directories (console variant preferred). Fails loud when nothing is found; never guesses,
# never downloads, never silently substitutes another engine.
#
# Do NOT capture engine output with PowerShell redirection (`2>&1`, `>`, Tee-Object): under
# this machine's sandbox a native process's output through a pipe is swallowed (measured
# 2026-10-09: file redirection produced 0 bytes). To land a file use
# `cmd /c "... > out.txt 2>&1"`, and read it back with `Get-Content -Raw -Encoding utf8`
# (the default GBK decode turns UTF-8 Chinese into mojibake). The probe itself already writes
# its evidence to probe-output.txt next to probe.gd.
#
# This file is ASCII-only on purpose: cmd.exe parses .cmd in the OEM code page, and
# powershell.exe parses BOM-less UTF-8 .ps1 as ANSI. Non-ASCII comments here break both
# (measured 2026-10-09).

[CmdletBinding()]
param(
  [string]$ProbeDir,
  [string]$Engine
)

$ErrorActionPreference = 'Stop'

# Resolve the script directory inside the body, never in a param() default: Windows
# PowerShell 5.1 leaves $PSScriptRoot empty during parameter binding (measured 2026-10-09).
# This machine has no `pwsh` on PATH, so the .cmd wrapper really does run 5.1.
if (-not $ProbeDir) { $ProbeDir = $PSScriptRoot }
if (-not $ProbeDir) { $ProbeDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Find-Engine {
  $roots = @(
    "$env:LOCALAPPDATA\Programs",
    "$env:USERPROFILE\scoop\apps",
    'C:\Godot',
    'D:\Godot',
    'D:\godot'
  ) | Where-Object { Test-Path $_ }
  $found = foreach ($root in $roots) {
    Get-ChildItem -Path $root -Recurse -Depth 2 -File -Filter 'Godot_v*' -ErrorAction SilentlyContinue
  }
  $found = $found | Where-Object { $_.Extension -in @('.exe', '') }
  if (-not $found) { return $null }
  # Console variants first (cleaner stdout), then highest version string.
  return ($found | Sort-Object -Property @{ Expression = { $_.Name -notlike '*console*' } }, @{ Expression = { $_.Name }; Descending = $true } | Select-Object -First 1).FullName
}

if (-not $Engine) { $Engine = $env:GODOT_BIN }
if (-not $Engine) { $Engine = Find-Engine }
if (-not $Engine -or -not (Test-Path $Engine)) {
  Write-Error "Godot engine not found. Set GODOT_BIN or pass -Engine <absolute path>."
}

if (-not (Test-Path (Join-Path $ProbeDir 'probe.gd'))) {
  Write-Error "No probe.gd in probe directory: $ProbeDir"
}

Write-Output "PROBE/engine_bin=$Engine"
& $Engine --version
Write-Output "PROBE/probe_dir=$ProbeDir"

# Keep the probe out of the developer's real Godot data: point the engine's user:// at the
# probe directory. Without this, `user://logs` is denied by this machine's sandbox and prints
# ERROR lines into the evidence (measured 2026-10-09). Side benefit: probing never writes to
# %APPDATA%\Godot.
$userDir = Join-Path $ProbeDir '_appdata'
New-Item -ItemType Directory -Force -Path $userDir | Out-Null
$env:APPDATA = $userDir
Write-Output "PROBE/appdata_override=$userDir"
Write-Output '---- engine output (bare invocation, no shell pipe) ----'

& $Engine --headless --path $ProbeDir --script res://probe.gd
$code = $LASTEXITCODE
Write-Output "---- end (exit $code) ----"
exit $code