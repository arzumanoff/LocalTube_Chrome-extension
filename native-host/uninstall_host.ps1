$ErrorActionPreference = "Stop"
$HostName = "com.arzumanoff.media_engine"
$InstallDir = Join-Path $env:LOCALAPPDATA "ArzumanoffMediaEngine"
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

if (Test-Path $RegistryPath) {
  Remove-Item $RegistryPath -Recurse -Force
}
if (Test-Path $InstallDir) {
  Remove-Item $InstallDir -Recurse -Force
}
Write-Host "Native Host removed."
