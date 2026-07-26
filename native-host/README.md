# Native media engine — Windows development build

This is the local Native Messaging engine used by the Chrome extension. It is a development installation, not the final public installer.

## Components

- Python Native Messaging host;
- `yt-dlp` for probing and downloading;
- FFmpeg/FFprobe for remuxing, conversion and output validation;
- Deno for the JavaScript challenges used by current YouTube extraction.

The extension never receives signed media URLs, cookies or separate track URLs. It receives only metadata, real quality choices and progress events.

## Build

Open PowerShell in this directory:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\build_host.ps1
```

Pinned development dependencies are recorded in `requirements.txt`.

## Tools

Place `ffmpeg.exe`, `ffprobe.exe` and `deno.exe` in `tools/`. The install script copies them next to the host executable. During development, FFmpeg/FFprobe may also be resolved from `PATH`.

## Install for the unpacked Chrome extension

The extension has a stable development ID:

```text
cahgieplmdniiggmdiledlbjdbclbhjd
```

Install the host for the current Windows user:

```powershell
.\install_host.ps1
```

The script writes:

```text
%LOCALAPPDATA%\LocalTubeEngine\
```

and registers:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.arzumanoff.media_engine
```

After installation, reload the unpacked extension and refresh the YouTube tab.

## Uninstall

```powershell
.\uninstall_host.ps1
```

## Protocol

Requests:

- `ping`
- `probe`
- `download`
- `cancel`

Long-running downloads send `progress` events over the same Native Messaging port. Only one active download is supported in this MVP.
