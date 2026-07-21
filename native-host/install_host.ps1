param(
  [string]$ExtensionId = "cahgieplmdniiggmdiledlbjdbclbhjd"
)

$ErrorActionPreference = "Stop"
$HostName = "com.arzumanoff.media_engine"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceExe = Join-Path $Root "dist\media-engine-host.exe"
$ToolsDir = Join-Path $Root "tools"
$InstallDir = Join-Path $env:LOCALAPPDATA "ArzumanoffMediaEngine"
$ManifestPath = Join-Path $InstallDir "native-host.json"
$HardwareProfilePath = Join-Path $InstallDir "hardware-profile.json"
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$RequiredTools = @("ffmpeg.exe", "ffprobe.exe", "deno.exe")

if (-not (Test-Path $SourceExe)) {
  throw "Host executable not found: $SourceExe"
}

foreach ($Tool in $RequiredTools) {
  $SourceTool = Join-Path $ToolsDir $Tool
  if (-not (Test-Path $SourceTool)) {
    throw "Required component not found: $SourceTool"
  }
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item $SourceExe (Join-Path $InstallDir "media-engine-host.exe") -Force
foreach ($Tool in $RequiredTools) {
  Copy-Item (Join-Path $ToolsDir $Tool) (Join-Path $InstallDir $Tool) -Force
}

$HostExe = Join-Path $InstallDir "media-engine-host.exe"
$Manifest = [ordered]@{
  name = $HostName
  description = "Local media download engine"
  path = $HostExe
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$Json = $Manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($ManifestPath, $Json, (New-Object System.Text.UTF8Encoding($false)))

New-Item -Path $RegistryPath -Force | Out-Null
Set-Item -Path $RegistryPath -Value $ManifestPath

$DetectionText = (& $HostExe --detect-hardware 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Hardware detection failed: $DetectionText"
}
try {
  $HardwareProfile = $DetectionText | ConvertFrom-Json
} catch {
  throw "Hardware detection returned invalid data: $DetectionText"
}
if (-not (Test-Path $HardwareProfilePath)) {
  throw "Hardware profile was not created: $HardwareProfilePath"
}
if (-not $HardwareProfile.displayName -or $HardwareProfile.status -ne "verified") {
  throw "Hardware profile is incomplete or unverified."
}

Write-Host ""
Write-Host "Local download engine installed successfully." -ForegroundColor Green
Write-Host "Video encoder: $($HardwareProfile.displayName)" -ForegroundColor Cyan
Write-Host "Extension ID: $ExtensionId"
Write-Host "Install folder: $InstallDir"
Write-Host "Reload the extension and refresh the YouTube tab."
