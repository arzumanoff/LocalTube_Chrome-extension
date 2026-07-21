from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

PROFILE_FILENAME = "hardware-profile.json"
SCHEMA_VERSION = 1
ALLOWED_ENCODER_KEYS = {
    "nvidia-nvenc",
    "amd-amf",
    "intel-qsv",
    "software-x264",
}
ALLOWED_STATUSES = {"verified", "stale"}
FINGERPRINT_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def profile_path(ffmpeg: str | Path) -> Path:
    override = os.environ.get("MEDIA_ENGINE_HARDWARE_PROFILE", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path(ffmpeg).expanduser().resolve().parent / PROFILE_FILENAME


@lru_cache(maxsize=8)
def _fingerprint_cached(path_text: str, size: int, mtime_ns: int) -> str:
    del size, mtime_ns
    digest = hashlib.sha256()
    with Path(path_text).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def ffmpeg_fingerprint(ffmpeg: str | Path) -> str:
    path = Path(ffmpeg).expanduser().resolve()
    stat = path.stat()
    return _fingerprint_cached(str(path), stat.st_size, stat.st_mtime_ns)


def _validated_payload(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    if payload.get("schemaVersion") != SCHEMA_VERSION:
        return None
    encoder_key = payload.get("encoderKey")
    if encoder_key not in ALLOWED_ENCODER_KEYS:
        return None
    ffmpeg_encoder = payload.get("ffmpegEncoder")
    display_name = payload.get("displayName")
    hardware = payload.get("hardware")
    status = payload.get("status")
    tested_at = payload.get("testedAt")
    fingerprint = payload.get("ffmpegFingerprint")
    if not isinstance(ffmpeg_encoder, str) or not ffmpeg_encoder:
        return None
    if not isinstance(display_name, str) or not display_name:
        return None
    if not isinstance(hardware, bool):
        return None
    if status not in ALLOWED_STATUSES:
        return None
    if not isinstance(tested_at, str) or not tested_at:
        return None
    if not isinstance(fingerprint, str) or not FINGERPRINT_RE.fullmatch(fingerprint):
        return None
    return {
        "schemaVersion": SCHEMA_VERSION,
        "encoderKey": encoder_key,
        "ffmpegEncoder": ffmpeg_encoder,
        "displayName": display_name,
        "hardware": hardware,
        "status": status,
        "testedAt": tested_at,
        "ffmpegFingerprint": fingerprint,
    }


def read_profile(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return _validated_payload(payload)


def write_profile_atomic(path: Path, payload: dict[str, Any]) -> None:
    validated = _validated_payload(payload)
    if validated is None:
        raise ValueError("Invalid hardware profile payload.")
    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as stream:
            json.dump(validated, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            temporary_path = Path(stream.name)
        os.replace(temporary_path, path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def build_profile_payload(profile: Any, ffmpeg: str | Path) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "encoderKey": str(profile.key),
        "ffmpegEncoder": str(profile.codec),
        "displayName": str(profile.label),
        "hardware": bool(profile.hardware),
        "status": "verified",
        "testedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "ffmpegFingerprint": ffmpeg_fingerprint(ffmpeg),
    }


def load_verified_profile(path: Path, ffmpeg: str | Path) -> dict[str, Any] | None:
    payload = read_profile(path)
    if payload is None or payload.get("status") != "verified":
        return None
    try:
        current = ffmpeg_fingerprint(ffmpeg)
    except OSError:
        return None
    if payload.get("ffmpegFingerprint") != current:
        return None
    return payload


def mark_profile_stale(path: Path) -> None:
    payload = read_profile(path)
    if payload is None:
        return
    payload["status"] = "stale"
    write_profile_atomic(path, payload)


def detect_and_store(ffmpeg: str | Path, destination: Path | None = None) -> dict[str, Any]:
    from hardware_encoding import clear_encoder_cache, select_encoder

    ffmpeg_path = Path(ffmpeg).expanduser().resolve()
    clear_encoder_cache()
    selected = select_encoder(str(ffmpeg_path))
    payload = build_profile_payload(selected, ffmpeg_path)
    write_profile_atomic(destination or profile_path(ffmpeg_path), payload)
    return payload
