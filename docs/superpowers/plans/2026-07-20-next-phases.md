# Next phases after stable progressive MP4

Status: Phase 1 download path is proven with real MP4 files (ANDROID progressive + preflight).

## Phase 2 — separate video/audio

- Capture adaptive `video-only` + `audio-only` formats
- Stream into OPFS
- Mux without re-encode (MP4)
- Memory budget and cancel/resume

## Phase 3 — re-encode path

- VP9/AV1 → H.264
- Opus/other → AAC
- Prefer WebCodecs; fallback `ffmpeg.wasm`
- Long-video chunking

## Phase 4 — playlists

- Selected playlist items
- Shared quality preference
- Subfolder naming
- Queue of 2–3 concurrent jobs

## Phase 5 — livestreams

- Completed live VODs
- Active live DVR from start
- Stop-and-save-now

Do not start Phase 2 until progressive MP4 remains green on CI + manual smoke.
