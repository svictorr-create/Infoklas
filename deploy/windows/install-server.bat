@echo off
rem InfoKlas - install/update the server on this Windows PC.
rem Double-click this file (it asks for administrator rights itself).
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
chcp 65001 >nul
rem Files from a downloaded ZIP are marked "from the Internet": unblock them, then run without signature checks.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Recurse -LiteralPath '%~dp0..\..' | Unblock-File"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-server.ps1" %*
echo.
pause
