# Media Downloader — Chrome extension

> Русская версия: [README.ru.md](README.ru.md)

Development repository for a public-facing video download product.

The current architecture is intentionally split into two parts:

```text
Chrome extension UI
        ↓ Native Messaging
local Windows engine
        ↓
yt-dlp + FFmpeg/FFprobe
```

The extension does not parse or download signed `googlevideo` streams itself. It sends the current YouTube URL to the local engine, receives the real available qualities, and shows only those qualities to the user.

## Current MVP

- button **«Скачать»** under ordinary YouTube videos;
- dynamic quality list from `yt-dlp`;
- no fixed 4K/1080p/720p list and no upscaling;
- separate labels such as `1080p` and `1080p60` when both really exist;
- editable output filename;
- native Windows **Save As** dialog;
- download, merge, H.264/AAC conversion when required;
- progress events and cancellation;
- stable development extension ID;
- one active download at a time.

Shorts, playlists, live streams, the public one-click installer, the website and other browsers are later stages.

## Repository layout

```text
manifest.json
src/
  native-background.js    Native Messaging coordinator
  native-content.js       YouTube button and dynamic dialog
  core/native.js          strict message and quality model
native-host/
  host.py                 Native Messaging process
  engine.py               yt-dlp and FFmpeg engine
  protocol.py             length-prefixed JSON protocol
  build_host.ps1          Windows development build
  install_host.ps1        current-user Chrome registration
  uninstall_host.ps1
tests/
  native.test.js
```

Legacy browser-only implementation files remain in Git history and may still exist in the repository, but the active manifest no longer loads them.

## JavaScript checks

Node.js 20 or newer:

```bash
npm ci
npm test
npm run check
```

## Native Host tests

```bash
npm run test:host
```

## Windows development installation

See [`native-host/README.md`](native-host/README.md).

This stage uses a development PowerShell installer. A signed public installer that bundles the engine and all dependencies will be implemented after the single-video flow is stable.

## Manual smoke test

```bash
npm run smoke:manual
```

The command prints the five required manual scenarios. It does not automatically open repeated Save As dialogs or download the same videos in a loop.

## Product rules

- show only resolutions that actually exist for the current video;
- never upscale a source;
- keep separate media tracks and codec details hidden from ordinary users;
- save the final file as MP4 with H.264 video and AAC audio;
- do not send URLs, cookies, titles or media data to a third-party server;
- do not bypass DRM, paid access, private-video permissions, geography or account restrictions.

Use the product only for media that you are authorized to save.
