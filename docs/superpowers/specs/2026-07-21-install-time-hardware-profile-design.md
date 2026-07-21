# Install-Time Hardware Encoder Profile Design

## Status

Approved design for the Windows Native Host hardware-encoding flow.

## Goal

Detect the usable H.264 hardware encoder once during Native Host installation, persist the verified choice, and use that profile for later downloads without repeating GPU probes before each video.

## Scope

This design changes only how the Native Host selects an H.264 encoder for formats that require transcoding.

It does not change:

- yt-dlp probing;
- the exact-quality UI;
- no-upscale behavior;
- ready MP4 handling;
- stream-copy merging for compatible H.264/AAC sources;
- Save As;
- download progress and cancellation;
- browser support beyond the current Windows + Chrome MVP.

## Decision

Use **installation-time detection with failure-triggered revalidation**.

The installer performs a real FFmpeg smoke test for each supported hardware backend, chooses one working profile, and writes the result to a persistent configuration file. Normal downloads read that file and do not enumerate or probe hardware again.

A new hardware detection is allowed only when:

1. the engine is installed or updated;
2. the user explicitly requests hardware re-detection;
3. the persisted encoder fails during a real transcode;
4. the profile file is missing, unreadable, unsupported, or structurally invalid.

## Supported Profiles

The Windows package must support these H.264 profiles:

1. `h264_nvenc` — NVIDIA NVENC;
2. `h264_amf` — AMD AMF;
3. `h264_qsv` — Intel Quick Sync;
4. `libx264` — software fallback.

Default automatic priority:

```text
NVIDIA NVENC
→ AMD AMF
→ Intel Quick Sync
→ libx264
```

The priority affects only systems where multiple working encoders are present.

## Installation Flow

The installer must:

1. install or update the Native Host, FFmpeg, FFprobe, and Deno;
2. verify that bundled FFmpeg advertises `h264_nvenc`, `h264_amf`, `h264_qsv`, and `libx264`;
3. execute a short real encode test for each hardware profile in priority order;
4. stop after the first hardware profile that completes successfully;
5. use `libx264` when no hardware profile starts successfully;
6. persist the selected profile atomically;
7. report the selected mode in the installer result.

The test must validate the actual FFmpeg backend and installed graphics driver. Detecting a GPU name through WMI, Device Manager, vendor strings, or PCI IDs is not sufficient by itself.

Example installer result:

```text
Локальный движок установлен.
Аппаратное кодирование: AMD AMF.
```

## Persistent Profile

Path:

```text
%LOCALAPPDATA%\ArzumanoffMediaEngine\hardware-profile.json
```

Schema version 1:

```json
{
  "schemaVersion": 1,
  "encoderKey": "amd-amf",
  "ffmpegEncoder": "h264_amf",
  "displayName": "AMD AMF",
  "hardware": true,
  "status": "verified",
  "testedAt": "2026-07-21T12:00:00Z",
  "ffmpegFingerprint": "<stable FFmpeg build fingerprint>"
}
```

Allowed `encoderKey` values:

- `nvidia-nvenc`;
- `amd-amf`;
- `intel-qsv`;
- `software-x264`.

The file must be written through a temporary file followed by an atomic replacement so an interrupted installation cannot leave partial JSON.

## FFmpeg Fingerprint

The persisted profile must include a fingerprint derived from the bundled FFmpeg build used during detection.

At minimum, the fingerprint must change when the installed `ffmpeg.exe` changes. A SHA-256 hash of `ffmpeg.exe` is acceptable.

When the current FFmpeg fingerprint differs from the stored fingerprint, the profile is stale and must be regenerated during installation or before the next transcode.

## Runtime Flow

For a ready MP4:

```text
copy source to final temporary file
→ verify
→ atomically save
```

No encoder profile is read because no transcode is required.

For compatible separate H.264 video and AAC audio:

```text
stream-copy merge
→ verify
→ atomically save
```

No encoder profile is read because no video transcode is required.

For VP9, AV1, Opus, or another incompatible source:

```text
load hardware-profile.json
→ validate schema and fingerprint
→ use the stored encoder directly
→ transcode to H.264 + AAC
→ verify output
→ atomically save
```

There must be no normal per-download iteration through NVENC, AMF, and QSV.

## Failure Handling

If the stored hardware encoder fails during a real transcode:

1. terminate and wait for FFmpeg;
2. remove the partial output safely;
3. mark the persisted profile `stale` or remove it atomically;
4. retry the current transcode once with `libx264`;
5. after the current job finishes, perform one hardware re-detection and persist the new verified profile;
6. do not loop through hardware backends repeatedly inside the same user download.

Cancellation is not an encoder failure and must not invalidate the hardware profile.

Input corruption, insufficient disk space, an inaccessible output path, invalid media, or a generic yt-dlp error must not invalidate the hardware profile unless FFmpeg specifically fails to initialize or use the selected video encoder.

## Explicit Re-Detection

The engine must expose one maintenance action:

```text
Проверить оборудование заново
```

For the MVP this may be implemented as an installer repair action or a dedicated command-line/helper entry point. It does not need to appear in the YouTube modal.

The action must:

1. run the same detection used by installation;
2. replace the profile atomically;
3. report the selected encoder.

## User Interface

During conversion, the extension may display the already-selected encoder reported by the Host:

```text
AMD AMF · 2.40x · Осталось: 180 с
```

This text is informational. The extension does not detect hardware and does not choose an encoder.

The browser UI must never expose FFmpeg command-line options or ask ordinary users to select NVENC, AMF, QSV, or libx264.

## Component Boundaries

### Installer detection component

Responsibilities:

- list supported profiles;
- run real encoder smoke tests;
- select according to priority;
- calculate FFmpeg fingerprint;
- write the persistent profile;
- return a human-readable installation result.

It must not perform YouTube downloads.

### Profile storage component

Responsibilities:

- validate schema;
- read the profile;
- write atomically;
- mark stale;
- compare FFmpeg fingerprints.

It must not invoke FFmpeg.

### Runtime encoder component

Responsibilities:

- translate a verified `encoderKey` into exact FFmpeg arguments;
- use the stored selection directly;
- identify encoder-initialization failure separately from unrelated FFmpeg failures;
- perform one software fallback when required.

It must not enumerate hardware during a healthy normal download.

### Extension UI

Responsibilities:

- display progress and the selected encoder label received from the Host.

It must not read the profile file or inspect Windows hardware.

## Testing

### Unit tests

Cover:

- profile JSON validation;
- allowed and rejected `encoderKey` values;
- atomic write behavior;
- missing and malformed profile handling;
- FFmpeg fingerprint mismatch;
- priority order;
- cancellation does not invalidate a profile;
- encoder initialization failure does invalidate a profile;
- unrelated download and filesystem failures do not invalidate a profile;
- software fallback occurs at most once;
- no runtime probe is called when a verified profile exists.

### Windows CI

The Windows workflow must:

1. verify the bundled FFmpeg advertises all four required encoders;
2. run installation detection in a deterministic test mode;
3. verify `hardware-profile.json` is created and valid;
4. run a transcode using the persisted software profile on the GPU-less runner;
5. prove no second detection occurs during that transcode;
6. simulate an encoder-initialization failure and verify one software fallback plus profile invalidation;
7. verify cancellation cleanup still releases the temporary file;
8. verify install, Native Messaging ping, and uninstall continue to pass.

Real NVENC, AMF, and Quick Sync execution must be verified on representative physical machines before public release because GitHub-hosted runners do not provide those GPUs.

## Acceptance Criteria

The feature is complete when:

- installation creates a valid `hardware-profile.json`;
- an RX 7600 system selects and stores `AMD AMF` when the installed driver supports it;
- a supported NVIDIA system stores `NVIDIA NVENC`;
- a supported Intel system stores `Intel Quick Sync`;
- a system with no usable hardware backend stores `software-x264`;
- normal downloads perform no hardware detection when the stored profile is valid;
- replacing `ffmpeg.exe` invalidates the old fingerprint;
- a real encoder initialization failure retries once through `libx264` and schedules one re-detection;
- cancellation does not invalidate the profile;
- the extension displays the encoder label supplied by the Host;
- ready MP4 and stream-copy merge paths remain unchanged.

## Non-Goals

This design does not add:

- hardware decoding;
- HEVC or AV1 output;
- user-selectable encoding presets;
- per-video encoder selection;
- benchmarking of all installed GPUs;
- background hardware polling;
- browser-side hardware detection.
