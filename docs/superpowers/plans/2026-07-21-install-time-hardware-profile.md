# Install-Time Hardware Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and persist the working H.264 encoder during Windows Native Host installation so normal downloads use the saved profile without probing hardware again.

**Architecture:** Add a focused profile-storage module for schema validation, SHA-256 fingerprinting, atomic writes, and stale-state handling. Expose a Native Host maintenance CLI that performs the existing real FFmpeg encoder smoke tests and writes the profile. Runtime transcoding loads the verified profile directly, uses one `libx264` fallback only for an encoder-initialization failure, and re-detects after that fallback succeeds.

**Tech Stack:** Python 3.12, FFmpeg/FFprobe, PyInstaller, PowerShell, Windows Native Messaging, unittest, GitHub Actions.

## Global Constraints

- Windows + Chrome only for this MVP.
- Profile path: `%LOCALAPPDATA%\LocalTubeEngine\hardware-profile.json`.
- Supported keys: `nvidia-nvenc`, `amd-amf`, `intel-qsv`, `software-x264`.
- Priority: NVIDIA NVENC → AMD AMF → Intel Quick Sync → libx264.
- Normal downloads must not probe hardware when a verified profile with the current FFmpeg fingerprint exists.
- Cancellation must not invalidate the profile.
- Ready MP4 and stream-copy merge behavior must remain unchanged.
- No hardware decoding, HEVC/AV1 output, or user-facing codec settings.

---

### Task 1: Persistent Hardware Profile Storage

**Files:**
- Create: `native-host/hardware_profile.py`
- Create: `native-host/tests/test_hardware_profile.py`

**Interfaces:**
- Produces: `profile_path(ffmpeg: str) -> Path`, `ffmpeg_fingerprint(ffmpeg: str) -> str`, `write_profile_atomic(path: Path, payload: dict) -> None`, `load_verified_profile(path: Path, ffmpeg: str) -> dict | None`, `mark_profile_stale(path: Path) -> None`.

- [ ] Write tests for valid schema, malformed JSON, unsupported keys, fingerprint mismatch, atomic replacement, and stale marking.
- [ ] Run `python -m unittest discover -s native-host/tests -p 'test_*.py' -v` and verify the new tests fail before implementation.
- [ ] Implement schema version 1 with exact allowed keys and `sha256:<lowercase hash>` fingerprinting.
- [ ] Run the host tests and verify they pass.
- [ ] Commit with `feat: add persistent hardware profile storage`.

### Task 2: Installation-Time Detection CLI

**Files:**
- Modify: `native-host/hardware_encoding.py`
- Modify: `native-host/bootstrap.py`
- Create: `native-host/tests/test_hardware_cli.py`

**Interfaces:**
- Produces: `detect_and_store(ffmpeg: str, destination: Path) -> dict` and CLI `media-engine-host.exe --detect-hardware`.
- CLI writes a compact JSON result to stdout and returns non-zero on failure.

- [ ] Write failing tests proving detection persists the selected profile and the CLI path does not enter Native Messaging mode.
- [ ] Run the targeted tests and verify failure.
- [ ] Implement `detect_and_store` using real encoder smoke tests in the approved priority order.
- [ ] Add bootstrap argument handling before binary Native Messaging stdio configuration.
- [ ] Run all host tests and verify success.
- [ ] Commit with `feat: add install-time hardware detection command`.

### Task 3: Runtime Uses Persisted Profile

**Files:**
- Modify: `native-host/runtime_fixes.py`
- Modify: `native-host/tests/test_hardware_encoding.py`
- Create: `native-host/tests/test_runtime_hardware_profile.py`

**Interfaces:**
- Consumes: `load_verified_profile`, `detect_and_store`, `mark_profile_stale`, `profile_by_key`.
- Runtime emits `encoder`, `encoderLabel`, and `hardware` from the persisted profile.

- [ ] Write failing tests proving a valid profile avoids `discover_encoder_names` and `smoke_test_profile`.
- [ ] Write failing tests proving cancellation and unrelated FFmpeg errors do not stale the profile.
- [ ] Write failing tests proving encoder-initialization failure stales the profile, retries exactly once with `libx264`, and performs one re-detection after successful fallback.
- [ ] Implement direct profile loading and encoder-initialization classification.
- [ ] Remove normal per-download hardware iteration.
- [ ] Run all host tests and verify success.
- [ ] Commit with `fix: use persisted encoder profile at runtime`.

### Task 4: Installer and Maintenance Launcher

**Files:**
- Modify: `native-host/install_host.ps1`
- Create: `native-host/REDETECT_HARDWARE.cmd`
- Create: `native-host/redetect_hardware.ps1`
- Modify: `native-host/TEST_PACKAGE_README.txt`

**Interfaces:**
- Installer runs installed `media-engine-host.exe --detect-hardware` after copying all binaries.
- Maintenance launcher runs the same command without administrator rights.

- [ ] Update installer to fail if detection fails or the profile is absent.
- [ ] Parse the CLI JSON and print the selected encoder label.
- [ ] Add double-click maintenance launcher and PowerShell wrapper.
- [ ] Document the installed profile and re-detection action.
- [ ] Commit with `feat: detect hardware during engine installation`.

### Task 5: Windows Package and CI Verification

**Files:**
- Modify: `.github/workflows/windows-host.yml`
- Modify: `manifest.json`
- Modify: `native-host/host.py`

**Interfaces:**
- Package includes `REDETECT_HARDWARE.cmd` and `redetect_hardware.ps1`.
- Windows CI verifies profile creation, reuse without detection, maintenance re-detection, Native Messaging ping, and uninstall.

- [ ] Bump extension to `0.2.4` and Host to `0.1.4`.
- [ ] Add deterministic CI installation detection using `MEDIA_ENGINE_VIDEO_ENCODER=software` on the GPU-less runner.
- [ ] Assert `hardware-profile.json` exists and contains `software-x264` with the installed FFmpeg fingerprint.
- [ ] Run a transcode and prove no detector call occurs during runtime.
- [ ] Run maintenance re-detection and validate the replacement profile.
- [ ] Include both maintenance files in the package.
- [ ] Run `npm ci`, `npm test`, `npm run test:host`, and `npm run check`.
- [ ] Run the full Windows workflow and require every step to pass.
- [ ] Download the resulting artifact and verify its SHA-256.
- [ ] Commit with `test: verify install-time hardware profile on Windows`.
