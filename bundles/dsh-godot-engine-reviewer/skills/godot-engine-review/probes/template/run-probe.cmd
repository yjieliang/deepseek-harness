@echo off
rem Godot probe launcher (Windows shell wrapper).
rem
rem This machine's PowerShell execution policy is Restricted, so a bare
rem `pwsh -File run-probe.ps1` is refused (measured 2026-10-09); start it with Bypass.
rem Arguments are forwarded verbatim.
rem
rem ASCII-only on purpose: cmd.exe parses .cmd in the OEM code page, and UTF-8 Chinese
rem comments here turn into commands that cmd tries to run (measured 2026-10-09).

set "PS=pwsh"
where pwsh >nul 2>nul || set "PS=powershell"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-probe.ps1" %*
exit /b %ERRORLEVEL%