@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall_host.ps1"
if errorlevel 1 (
  echo.
  echo Не удалось удалить локальный движок.
  pause
  exit /b 1
)
echo.
echo Локальный движок удалён.
pause
