@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0redetect_hardware.ps1"
if errorlevel 1 (
  echo.
  echo Не удалось повторно определить оборудование.
  echo Сделайте снимок этого окна и отправьте его разработчику.
  pause
  exit /b 1
)
echo.
echo Проверка оборудования завершена.
pause
