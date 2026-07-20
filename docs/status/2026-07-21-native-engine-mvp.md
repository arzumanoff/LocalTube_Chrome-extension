# Development status — native engine MVP

## Completed in this branch

- active manifest moved from the browser-only downloader to Native Messaging;
- stable development extension ID added;
- real-quality data model added;
- fixed resolution buttons and single-video fallback removed from the active UI;
- Python Native Host protocol added;
- yt-dlp probe/download engine added;
- FFmpeg remux/transcode and FFprobe validation added;
- Windows development build/install/uninstall scripts added;
- repeated real E2E replaced by a manual smoke checklist;
- JavaScript and Python unit tests added.

## Current limitation

This is a development installation. The user must build the host and provide FFmpeg, FFprobe and Deno. The public installer will bundle these later.

Only one ordinary `/watch` video and one active download are in scope. Shorts are deliberately deferred until this flow is stable.

## Next gate

Run automated checks, install the development host on Windows and complete one manual smoke set. Do not start playlists or multi-browser packaging until these checks pass.
