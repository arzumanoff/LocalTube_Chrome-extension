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
$HardwareLogPath = Join-Path $InstallDir "logs\hardware-detection.log"
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$RequiredTools = @("ffmpeg.exe", "ffprobe.exe", "deno.exe")
$InstalledExecutables = @("media-engine-host.exe", "ffmpeg.exe", "ffprobe.exe", "deno.exe")

function Get-NormalizedPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Wait-FileUnlocked {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path $Path)) {
    return
  }

  for ($Attempt = 0; $Attempt -lt 100; $Attempt++) {
    $Stream = $null
    try {
      $Stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
      return
    } catch [System.IO.IOException] {
      if ($Attempt -eq 99) {
        throw "Installed component is still in use: $Path"
      }
      Start-Sleep -Milliseconds 100
    } finally {
      if ($null -ne $Stream) {
        $Stream.Dispose()
      }
    }
  }
}

function Stop-InstalledExecutable {
  param([Parameter(Mandatory = $true)][string]$ExecutablePath)

  if (-not (Test-Path $ExecutablePath)) {
    return
  }

  $TargetPath = Get-NormalizedPath $ExecutablePath
  $ProcessName = [System.IO.Path]::GetFileNameWithoutExtension($TargetPath)

  foreach ($Process in [System.Diagnostics.Process]::GetProcessesByName($ProcessName)) {
    try {
      $ActualPath = $null
      try {
        $ActualPath = $Process.MainModule.FileName
      } catch {
        continue
      }

      if (-not $ActualPath) {
        continue
      }
      if (-not [string]::Equals(
        (Get-NormalizedPath $ActualPath),
        $TargetPath,
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
        continue
      }

      Write-Host "Stopping running component: $([System.IO.Path]::GetFileName($TargetPath))"
      try {
        if (-not $Process.HasExited) {
          $Process.Kill()
          if (-not $Process.WaitForExit(10000)) {
            throw "Timed out while stopping process $($Process.Id): $TargetPath"
          }
        }
      } catch [System.InvalidOperationException] {
        # The process exited between inspection and termination.
      }
    } finally {
      $Process.Dispose()
    }
  }

  Wait-FileUnlocked $TargetPath
}

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
foreach ($Executable in $InstalledExecutables) {
  Stop-InstalledExecutable (Join-Path $InstallDir $Executable)
}

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
if (-not (Test-Path $HardwareLogPath)) {
  throw "Hardware detection log was not created: $HardwareLogPath"
}
if (-not $HardwareProfile.displayName -or $HardwareProfile.status -ne "verified") {
  throw "Hardware profile is incomplete or unverified."
}

Write-Host ""
Write-Host "Local download engine installed successfully." -ForegroundColor Green
Write-Host "Video encoder: $($HardwareProfile.displayName)" -ForegroundColor Cyan
Write-Host "Hardware log: $HardwareLogPath"
Write-Host "Extension ID: $ExtensionId"
Write-Host "Install folder: $InstallDir"
Write-Host "Reload the extension and refresh the YouTube tab."
