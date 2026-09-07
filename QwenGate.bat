@echo off
REM ═════════════════════════════════════════════════════════════════════
REM  QWEN GATE — One-Click Launcher (double-click this file)
REM  Place on your Desktop. Opens the Qwen Gate Control Panel.
REM ═════════════════════════════════════════════════════════════════════

cd /d "%~dp0"
powershell.exe -ExecutionPolicy Bypass -NoExit -Command "& '%~dp0qwen-control.ps1'"