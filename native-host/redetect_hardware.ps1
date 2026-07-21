$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "ArzumanoffMediaEngine"
$HostExe = Join-Path $InstallDir "media-engine-host.exe"
$ProfilePath = Join-Path $InstallDir "hardware-profile.json"
$LogPath = Join-Path $InstallDir "logs\hardware-detection.log"

if (-not (Test-Path $HostExe)) {
  throw "Local engine is not installed: $HostExe"
}

$DetectionText = (& $HostExe --detect-hardware 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Hardware detection failed: $DetectionText"
}
try {
  $Profile = $DetectionText | ConvertFrom-Json
} catch {
  throw "Hardware detection returned invalid data: $DetectionText"
}
if (-not (Test-Path $ProfilePath)) {
  throw "Hardware profile was not created: $ProfilePath"
}
if (-not (Test-Path $LogPath)) {
  throw "Hardware detection log was not created: $LogPath"
}
if (-not $Profile.displayName -or $Profile.status -ne "verified") {
  throw "Hardware profile is incomplete or unverified."
}

Write-Host ""
Write-Host "Hardware detection completed." -ForegroundColor Green
Write-Host "Video encoder: $($Profile.displayName)" -ForegroundColor Cyan
Write-Host "Profile: $ProfilePath"
Write-Host "Hardware log: $LogPath"
