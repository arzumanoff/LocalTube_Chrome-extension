param(
  [string]$ExtensionId = "cahgieplmdniiggmdiledlbjdbclbhjd"
)

$ErrorActionPreference = "Stop"
$HostName = "com.arzumanoff.media_engine"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceExe = Join-Path $Root "dist\media-engine-host.exe"
$InstallDir = Join-Path $env:LOCALAPPDATA "ArzumanoffMediaEngine"
$ManifestPath = Join-Path $InstallDir "native-host.json"
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

if (-not (Test-Path $SourceExe)) {
  throw "Host executable not found: $SourceExe. Run build_host.ps1 first."
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item $SourceExe (Join-Path $InstallDir "media-engine-host.exe") -Force

$ToolsDir = Join-Path $Root "tools"
foreach ($Tool in @("ffmpeg.exe", "ffprobe.exe", "deno.exe")) {
  $SourceTool = Join-Path $ToolsDir $Tool
  if (Test-Path $SourceTool) {
    Copy-Item $SourceTool (Join-Path $InstallDir $Tool) -Force
  }
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

Write-Host "Native Host installed."
Write-Host "Extension ID: $ExtensionId"
Write-Host "Manifest: $ManifestPath"
Write-Host "Reload the extension and refresh the YouTube tab."
