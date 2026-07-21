from __future__ import annotations

import os
import re
import subprocess
import threading
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class EncoderProfile:
    key: str
    codec: str
    label: str
    hardware: bool
    args: tuple[str, ...]


_PROFILES: tuple[EncoderProfile, ...] = (
    EncoderProfile(
        key="nvidia-nvenc",
        codec="h264_nvenc",
        label="NVIDIA NVENC",
        hardware=True,
        args=(
            "-c:v", "h264_nvenc",
            "-preset", "p5",
            "-tune", "hq",
            "-rc", "vbr",
            "-cq", "20",
            "-b:v", "0",
        ),
    ),
    EncoderProfile(
        key="amd-amf",
        codec="h264_amf",
        label="AMD AMF",
        hardware=True,
        args=(
            "-c:v", "h264_amf",
            "-quality", "quality",
            "-rc", "cqp",
            "-qp_i", "20",
            "-qp_p", "22",
            "-qp_b", "24",
        ),
    ),
    EncoderProfile(
        key="intel-qsv",
        codec="h264_qsv",
        label="Intel Quick Sync",
        hardware=True,
        args=(
            "-c:v", "h264_qsv",
            "-preset", "medium",
            "-global_quality", "20",
        ),
    ),
)

_SOFTWARE_PROFILE = EncoderProfile(
    key="software-x264",
    codec="libx264",
    label="Процессор (libx264)",
    hardware=False,
    args=(
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "20",
    ),
)

_ENCODER_LINE_RE = re.compile(r"^\s*V[\.A-Z]{5}\s+([A-Za-z0-9_]+)\b", re.MULTILINE)
_CACHE: dict[tuple[str, str], EncoderProfile] = {}
_CACHE_LOCK = threading.Lock()


def profiles() -> tuple[EncoderProfile, ...]:
    return _PROFILES


def profile_by_key(key: str) -> EncoderProfile:
    for profile in (*_PROFILES, _SOFTWARE_PROFILE):
        if profile.key == key:
            return profile
    raise KeyError(key)


def clear_encoder_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


def parse_encoder_names(output: str) -> set[str]:
    return {match.group(1) for match in _ENCODER_LINE_RE.finditer(str(output or ""))}


def discover_encoder_names(ffmpeg: str) -> set[str]:
    try:
        completed = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        return set()
    return parse_encoder_names(completed.stdout)


def smoke_test_profile(ffmpeg: str, profile: EncoderProfile) -> bool:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", "color=c=black:s=128x72:r=30",
        "-frames:v", "1",
        "-an",
        "-pix_fmt", "nv12",
        *profile.args,
        "-f", "null",
        "-",
    ]
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


def _ordered_candidates(override: str, available: set[str]) -> Iterable[EncoderProfile]:
    normalized = override.strip().lower()
    if normalized and normalized not in {"auto", "default"}:
        aliases = {
            "nvidia": "nvidia-nvenc",
            "nvenc": "nvidia-nvenc",
            "h264_nvenc": "nvidia-nvenc",
            "amd": "amd-amf",
            "radeon": "amd-amf",
            "amf": "amd-amf",
            "h264_amf": "amd-amf",
            "intel": "intel-qsv",
            "qsv": "intel-qsv",
            "quicksync": "intel-qsv",
            "h264_qsv": "intel-qsv",
            "cpu": "software-x264",
            "software": "software-x264",
            "libx264": "software-x264",
        }
        requested_key = aliases.get(normalized, normalized)
        requested = profile_by_key(requested_key)
        if requested.hardware and requested.codec in available:
            yield requested
        elif not requested.hardware:
            yield requested
        return

    for profile in _PROFILES:
        if profile.codec in available:
            yield profile


def select_encoder(ffmpeg: str) -> EncoderProfile:
    override = os.environ.get("MEDIA_ENGINE_VIDEO_ENCODER", "auto")
    cache_key = (os.path.normcase(os.path.abspath(ffmpeg)), override.strip().lower())
    with _CACHE_LOCK:
        cached = _CACHE.get(cache_key)
    if cached is not None:
        return cached

    available = discover_encoder_names(ffmpeg)
    selected = _SOFTWARE_PROFILE
    for profile in _ordered_candidates(override, available):
        if not profile.hardware:
            selected = profile
            break
        if smoke_test_profile(ffmpeg, profile):
            selected = profile
            break

    with _CACHE_LOCK:
        _CACHE[cache_key] = selected
    return selected
