# Native download engine MVP — design

**Date:** 21 July 2026  
**Status:** approved for implementation  
**Scope:** Windows + Google Chrome + one ordinary YouTube video

## Product goal

A user opens a YouTube video, clicks **Download**, sees only the qualities that actually exist for that video, chooses one, confirms a Windows Save As dialog and receives a playable MP4.

The user must not interact with `yt-dlp`, FFmpeg, Python, format IDs or separate tracks.

## Decision

The browser-only media engine is discontinued. The active architecture is:

```text
YouTube page
→ Chrome content-script UI
→ MV3 service worker
→ Chrome Native Messaging
→ local Windows host
→ yt-dlp + FFmpeg/FFprobe
```

The extension does not receive signed media URLs. Native Host returns only metadata, quality choices, request acknowledgements and progress events.

## Why this architecture

The previous browser-only implementation depended on temporary YouTube media URLs and repeatedly failed on 403 responses, filename races and incomplete progressive formats. `yt-dlp` already maintains the changing extractor logic, and FFmpeg already handles separate tracks, remuxing and codec normalization.

## Extension responsibilities

- mount one Download button on `/watch` pages;
- send the current URL to Native Host;
- render the returned real quality list;
- collect the editable suggested filename;
- start and cancel one download;
- render progress and actionable errors;
- close stale UI on YouTube SPA navigation.

The extension must not:

- request or store signed `googlevideo` URLs;
- offer qualities absent from the probe result;
- perform nearest-lower fallback for a single video;
- upscale video;
- download or merge media in browser memory.

## Native Host responsibilities

- validate YouTube URLs;
- probe metadata through pinned `yt-dlp`;
- group real video formats by source height and frame-rate class;
- open the Windows Save As dialog;
- download the exact selected height;
- merge tracks;
- transcode to H.264/AAC only when required;
- verify final codecs and resolution with FFprobe;
- emit progress and accept cancellation;
- keep all temporary files local.

## Quality model

A quality is identified by source height and frame-rate class:

```json
{
  "id": "h1080-f60",
  "height": 1080,
  "fps": 60,
  "label": "1080p60",
  "requiresMerge": true,
  "requiresTranscode": false
}
```

Standard frame rates up to 30 fps are shown as `1080p`. Higher frame rates are shown explicitly, such as `1080p60`.

The UI may add a convenience alias `Best — 1080p60`, but that alias points to the first real quality; it is not a synthetic format.

## Native Messaging protocol

Host name:

```text
com.arzumanoff.media_engine
```

Requests:

- `ping`
- `probe`
- `download`
- `cancel`

Messages use Chrome's 4-byte little-endian length prefix followed by UTF-8 JSON. Host stdout contains protocol frames only; logs go to stderr.

## Security and privacy

- stable extension key and explicit `allowed_origins`;
- no wildcard Native Host access;
- HTTPS YouTube URLs only;
- no third-party server;
- no cookie export from the extension;
- no media URL persistence;
- strict request validation;
- final file verification before completion.

## Testing

Automated tests use local fixtures and pure data models. They do not download videos from YouTube.

A real manual smoke is run once after relevant code changes and covers:

1. low-resolution video with no fake high qualities;
2. real 1080p;
3. real 2160p;
4. edited filename;
5. Save As cancellation;
6. active-download cancellation.

The old repeated browser E2E command is replaced with a command that prints the manual checklist.

## Deferred

- public signed installer;
- automatic dependency updates;
- Shorts;
- playlists;
- live streams;
- website integration;
- Edge, Opera, Opera GX, Yandex Browser, Brave, Vivaldi and Firefox;
- multiple simultaneous downloads.
