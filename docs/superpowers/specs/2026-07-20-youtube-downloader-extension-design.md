# YouTube Downloader Chrome Extension — Design Specification

**Date:** 20 July 2026  
**Status:** UI and architecture approved  
**Target:** Google Chrome on Windows, Manifest V3  
**Figma:** `https://www.figma.com/design/ic3VrfiyAClvARmzU14vU8`

## 1. Product goal

Create a browser-only Chrome extension that adds a **Download** button below YouTube videos and can download:

- regular videos;
- YouTube Shorts;
- selected items from playlists;
- completed live streams;
- active live streams from the beginning when DVR history is available.

The extension must not require a separate Windows application. All downloading, temporary storage, remuxing, transcoding, queue management and final saving happen inside Chrome.

## 2. Confirmed user requirements

### 2.1 Single video and Shorts

- Add a **Download** button below the player.
- Show available target qualities.
- Save the final file as `.mp4`.
- Use H.264 video and AAC audio.
- Open a system save dialog before processing starts.
- If the chosen resolution is unavailable, use the nearest lower resolution.

### 2.2 Playlists

- Show playlist items with thumbnail, title, duration, position and checkbox.
- Allow selecting or deselecting individual items.
- Include **Select all**, **Clear selection** and title search.
- Apply one quality profile to all selected items.
- Use the nearest lower available resolution for each item.
- Ask for a destination folder once.
- Create a subfolder named after the playlist.
- Save files in playlist order, for example:

```text
Playlist name/
  001 — First video.mp4
  002 — Second video.mp4
  003 — Third video.mp4
```

- Run two or three downloads in parallel.
- Run no more than one expensive transcode at a time.

### 2.3 Active live streams

- Start from the beginning when the YouTube DVR manifest still exposes the earlier segments.
- Otherwise start from the earliest segment still available.
- Provide **Stop and save now**.
- Finalize all downloaded segments into a playable MP4.
- Preserve recoverable temporary segments if Chrome closes unexpectedly.

## 3. Product boundaries

The extension works only with media that the current Chrome session is permitted to play. It must not:

- bypass DRM;
- bypass payment, membership, geographic or account access controls;
- defeat private-video permissions;
- download media that is not exposed to the user’s active playback session;
- execute remotely hosted code.

The user remains responsible for copyright compliance and YouTube’s terms.

## 4. Feasibility and explicit limitations

The browser-only requirement is technically possible, but it has unavoidable constraints:

1. `ffmpeg.wasm` has a documented 2 GB input-file limit per WebAssembly operation.
2. WebAssembly transcoding is substantially slower than native FFmpeg and can use considerable CPU and memory.
3. Long 4K/8K videos and long live streams therefore require segmented processing and incremental disk output.
4. Even with segmentation, arbitrary very large files cannot be guaranteed on every PC. Available disk quota, RAM, codec support and Chrome stability remain hard environmental limits.
5. MP4 with H.264/AAC maximizes compatibility, but very high-resolution H.264 files may still be unsupported on older TVs.

The UI must communicate these conditions before starting a large job and show estimated temporary disk usage.

## 5. Architecture

```text
YouTube page
  └─ Content Script + Shadow DOM UI
       ├─ Download button
       ├─ Quality dialog
       ├─ Playlist selector
       └─ Job progress panel

Page bridge in MAIN world
  └─ Reads player metadata and exposed streaming manifests

Manifest V3 Service Worker
  ├─ Job orchestration
  ├─ Persistent state machine
  ├─ Queue scheduling
  ├─ Retry policy
  └─ Messaging between extension contexts

Extension processing page
  ├─ User-gesture file and directory pickers
  ├─ Offscreen document lifecycle
  └─ Processing status bridge

Dedicated Workers
  ├─ Manifest parser
  ├─ Segment downloader
  ├─ OPFS writer
  ├─ WebCodecs media pipeline
  └─ ffmpeg.wasm fallback pipeline

Storage
  ├─ IndexedDB: jobs, settings, handles and resumable state
  ├─ OPFS: temporary media segments and intermediate outputs
  └─ User-selected folder/file: finalized MP4 output
```

## 6. Extension components

### 6.1 Content script

Responsibilities:

- detect YouTube single-page navigation;
- mount the button below the active player;
- avoid duplicate mounting;
- open extension-owned UI in a Shadow DOM root;
- update the UI when the active video changes;
- communicate through typed messages only.

It must not contain downloading or media-processing logic.

### 6.2 Page bridge

A small script runs in the page’s main JavaScript world to collect data that is not visible in the isolated content-script world.

Output is reduced to a strict serializable model:

- video ID;
- title, channel and duration;
- live/Short/playlist flags;
- playlist entries;
- available streaming manifests and format metadata;
- captions or unrelated page state are excluded from the initial scope.

No `eval`, dynamic remote imports or remote executable code are permitted.

### 6.3 Service worker

The Manifest V3 service worker is an event-driven coordinator, not a long-running processor.

It:

- creates jobs;
- writes every state transition to IndexedDB;
- schedules up to three active network downloads;
- limits expensive transcoding to one job;
- recreates required workers or offscreen contexts after suspension;
- resumes incomplete jobs from persisted checkpoints;
- reports progress to all open extension views.

### 6.4 Processing page and offscreen document

File and directory pickers must be opened directly from a user click. The extension therefore asks for the output handle before the lengthy processing begins.

The offscreen document provides a hidden document context for operations unavailable to the service worker and hosts the worker-based media pipeline. Primary state remains in IndexedDB, so losing the offscreen document must not lose the job.

### 6.5 OPFS storage worker

A dedicated worker owns OPFS access and performs efficient sequential and random writes.

Temporary layout:

```text
/jobs/<job-id>/
  job.json
  manifests/
  source-video/
  source-audio/
  encoded-video/
  encoded-audio/
  mux/
  recovery.json
```

Responsibilities:

- append downloaded ranges or segments;
- checksum completed parts;
- expose resumable offsets;
- enforce per-job storage limits;
- clean temporary files only after final output is confirmed.

### 6.6 Media engine

The media engine is hybrid.

#### Fast path: stream copy or minimal conversion

When the selected YouTube streams already contain H.264 video and AAC audio:

- do not re-encode;
- remux into MP4;
- preserve the original video quality;
- write the final container incrementally.

When video is H.264 but audio is not AAC:

- copy video;
- transcode audio only.

#### Preferred transcode path: WebCodecs

When the current Chrome/Windows system reports supported H.264 and AAC encoder configurations:

- demux source chunks;
- decode only the tracks that require conversion;
- encode H.264/AAC using WebCodecs;
- feed encoded chunks to an incremental MP4 muxer;
- write directly to OPFS or the selected file stream.

This path avoids placing the entire file inside WebAssembly memory and may use platform acceleration.

#### Fallback path: bundled ffmpeg.wasm

Use a locally bundled multithread `ffmpeg.wasm` core when WebCodecs cannot process a source codec or operation.

Rules:

- never pass an input of 2 GB or more to a single invocation;
- split work at safe media boundaries;
- use identical encoding parameters for all output fragments;
- move each completed fragment out of the WebAssembly filesystem immediately;
- terminate and recreate the FFmpeg worker after a cancellation or unrecoverable error;
- provide a single-thread fallback when multithread prerequisites are unavailable.

All extension code and WASM assets ship inside the extension package.

## 7. Quality selection

Supported target profiles:

- 360p;
- 480p;
- 720p;
- 1080p;
- 1440p;
- 2160p (4K);
- 4320p (8K), when exposed;
- best available.

Selection algorithm:

1. Filter playable video formats to those at or below the requested height.
2. Select the highest height remaining.
3. Within the selected height, prefer the highest frame rate.
4. Then prefer the highest sensible bitrate.
5. Pair with the best available audio track.
6. Normalize the result to H.264/AAC MP4.
7. If nothing exists below the requested quality, report the video as unavailable instead of silently choosing a higher quality.

For playlists, this algorithm runs independently for every checked item while preserving the common target profile.

## 8. Download pipeline

### 8.1 Ordinary video

```text
User clicks Download
→ choose quality
→ open Save As picker
→ create persistent job
→ fetch and validate manifests
→ choose video/audio tracks
→ download in resumable chunks to OPFS
→ remux or transcode
→ write and finalize MP4
→ verify output
→ delete temporary data
```

### 8.2 Playlist

```text
User clicks Download playlist
→ load playlist entries
→ user checks desired items
→ choose one quality profile
→ select destination folder once
→ create sanitized playlist subfolder
→ enqueue selected jobs
→ run 2–3 network jobs concurrently
→ run 1 transcode concurrently
→ save numbered MP4 files
→ show final success/failure summary
```

### 8.3 Active live stream

```text
User starts recording
→ choose output destination
→ discover DASH/HLS live manifest
→ locate earliest DVR segment
→ fetch segments in sequence
→ periodically persist segment cursor
→ refresh manifest before expiry
→ user clicks Stop and save now, or stream ends
→ flush final segment
→ transcode/remux missing portions
→ finalize MP4 indexes and duration
→ verify output
```

Duplicate segment IDs must be ignored. Manifest discontinuities, ad boundaries and timestamp jumps must create explicit timeline checkpoints.

## 9. Queue model

Job states:

```text
created
waiting_for_output_permission
queued
resolving_formats
downloading
waiting_for_processing
processing
finalizing
completed
paused
cancelled
failed
recoverable
```

Scheduling rules:

- maximum three network-heavy jobs;
- reduce to two active downloads while a transcode is running;
- maximum one transcode;
- user can pause, resume, cancel and retry;
- retries use exponential backoff with jitter;
- HTTP 403 or expired URLs trigger manifest refresh before retry;
- a job never restarts from zero when verified segments already exist.

## 10. File-system behavior

### Individual media

Use `showSaveFilePicker()` with a sanitized suggested filename. The picker is opened immediately from the user’s click, before downloading or transcoding.

### Playlist

Use `showDirectoryPicker({ mode: "readwrite" })`. Create a sanitized child directory matching the playlist title. If the name already exists, reuse it and avoid silent overwrites.

Filename collision policy:

```text
001 — Title.mp4
001 — Title (2).mp4
001 — Title (3).mp4
```

File and directory handles may be stored in IndexedDB. On a resumed browser session, the extension checks permission and asks the user to grant it again through an explicit click when required.

## 11. Naming and sanitization

Remove or replace Windows-invalid characters:

```text
< > : " / \\ | ? *
```

Also:

- trim trailing spaces and periods;
- avoid reserved Windows names such as `CON`, `PRN`, `AUX`, `NUL`, `COM1` and `LPT1`;
- limit the full filename length conservatively;
- preserve Unicode titles where valid;
- fall back to the video ID when the title becomes empty.

## 12. Progress and error reporting

The progress panel shows separate stages:

- preparing;
- downloading video;
- downloading audio;
- processing;
- saving;
- completed.

For playlists it additionally shows:

- completed count;
- queued count;
- active downloads;
- current transcode;
- failed items with a retry button.

Errors must be actionable, for example:

- no compatible format found;
- output permission denied;
- insufficient temporary disk space;
- browser codec unsupported;
- stream manifest expired;
- live DVR beginning unavailable;
- processing exceeded browser limits;
- video unavailable or private.

## 13. Recovery and cleanup

- Persist a checkpoint after each completed segment or range.
- On extension startup, scan IndexedDB for non-terminal jobs.
- Verify corresponding OPFS files before presenting recovery.
- Offer **Resume**, **Finalize available part** or **Delete temporary files**.
- Never delete recoverable active-live data automatically.
- Automatically clean completed-job temporary data after output verification.
- Provide a settings action to clear abandoned temporary files.

## 14. Security and privacy

- Host permissions are limited to required YouTube and media-delivery origins.
- No analytics or telemetry in the first release.
- No external server receives URLs, cookies, titles or media data.
- Authentication remains in Chrome; the extension does not export cookies.
- Messages use schemas and reject unknown fields.
- User-derived filenames are sanitized before file-system operations.
- All third-party packages and codec licenses are documented.
- Extension pages use a restrictive Content Security Policy and bundled assets.

## 15. Testing strategy

### Unit tests

- quality fallback selection;
- filename sanitization;
- playlist numbering;
- queue concurrency;
- state transitions;
- retry/backoff calculations;
- manifest segment deduplication;
- live timestamp continuity;
- recovery checkpoint validation.

### Integration tests

- regular progressive video;
- DASH video plus audio;
- VP9/AV1 to H.264 conversion;
- Opus to AAC conversion;
- Shorts navigation without full reload;
- mixed-quality playlist;
- unavailable/private playlist items;
- completed stream;
- active DVR stream and manual stop;
- interrupted download and resume;
- revoked output-folder permission;
- filename collisions.

### Browser performance tests

Test at minimum:

- 720p short video;
- 1080p one-hour video;
- 4K source requiring transcode;
- playlist of at least 20 items;
- multi-hour live recording;
- low free-disk condition;
- extension service-worker suspension during a job.

## 16. Delivery phases

### Phase 1 — foundation

- Manifest V3 project;
- YouTube SPA button;
- metadata extraction;
- individual video and Shorts;
- MP4 fast-path download;
- save picker;
- persistent jobs and progress UI.

### Phase 2 — adaptive media processing

- separate video/audio streams;
- OPFS temporary storage;
- H.264/AAC normalization;
- WebCodecs pipeline;
- ffmpeg.wasm fallback;
- pause, cancellation and recovery.

### Phase 3 — playlists

- playlist selector;
- one folder picker;
- subfolder creation;
- common quality profile;
- two-to-three-item queue;
- batch summary and retries.

### Phase 4 — live streams

- completed live archives;
- active DVR discovery;
- earliest available segment capture;
- persistent live cursor;
- **Stop and save now**;
- partial-finalization recovery.

### Phase 5 — hardening

- large-file performance tuning;
- robust parser updates;
- diagnostics export;
- full end-to-end regression suite;
- packaging and installation documentation.

## 17. Acceptance criteria

The product is accepted when:

1. The Download button reliably follows YouTube SPA navigation.
2. A regular video can be saved through one system save dialog as MP4/H.264/AAC.
3. Selected quality falls back only to the nearest lower resolution.
4. Shorts work with the same flow.
5. A playlist allows item-level checkboxes, one common quality and one folder selection.
6. The playlist creates a named subfolder and numbered files.
7. The queue respects two-to-three concurrent downloads and one transcode.
8. A completed live stream can be downloaded.
9. An active DVR stream starts from its earliest available segment and supports manual stop/finalize.
10. Interrupted jobs can resume without redownloading verified segments.
11. Temporary files remain recoverable after an unexpected Chrome shutdown.
12. No separate Windows helper, server-side processor or remotely hosted executable code is required.

## 18. Decisions deferred to implementation planning

These are engineering selections, not product ambiguities:

- exact TypeScript build tool;
- exact incremental MP4 demux/mux package after license and streaming review;
- exact custom ffmpeg.wasm build composition;
- chunk-duration and bitrate thresholds;
- codec profile/level parameters per resolution;
- test fixture strategy for YouTube manifests that change over time.
