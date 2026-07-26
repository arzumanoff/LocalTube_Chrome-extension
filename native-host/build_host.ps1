param(
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Venv = Join-Path $Root ".venv"

if (-not (Test-Path $Venv)) {
  & $Python -m venv $Venv
}

$VenvPython = Join-Path $Venv "Scripts\python.exe"
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r (Join-Path $Root "requirements.txt")
& $VenvPython -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --name "media-engine-host" `
  --collect-all yt_dlp `
  --collect-all yt_dlp_ejs `
  --distpath (Join-Path $Root "dist") `
  --workpath (Join-Path $Root "build") `
  --specpath (Join-Path $Root "build") `
  (Join-Path $Root "bootstrap.py")

Write-Host "Built: $Root\dist\media-engine-host.exe"
