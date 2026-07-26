@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_host.ps1"
if errorlevel 1 (
  echo.
  echo Не удалось установить локальный движок.
  echo Сделайте снимок этого окна и отправьте его разработчику.
  pause
  exit /b 1
)
echo.
echo Установка завершена. Обновите расширение и страницу YouTube.
pause
