from __future__ import annotations

import os
import re
import subprocess
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable

import engine
import hardware_encoding

ProgressCallback = Callable[[dict[str, Any]], None]
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_APPLIED = False
_ORIGINAL_RUN_DOWNLOAD = engine.run_download


def _clean_progress_text(value: Any) -> str:
    text = ANSI_ESCAPE_RE.sub("", str(value or ""))
    text = CONTROL_RE.sub("", text).replace("\r", "").replace("\n", " ")
    return " ".join(text.split()).strip()


def _parse_ffmpeg_time(key: str, value: str) -> float | None:
    if key not in {"out_time_us", "out_time_ms"}:
        return None
    try:
        # FFmpeg reports both keys in microseconds despite the historical
        # out_time_ms name.
        return max(0.0, int(value) / 1_000_000)
    except (TypeError, ValueError):
        return None


def _stop_process(process: Any, timeout: float = 5.0) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
    except OSError:
        pass
    try:
        process.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        process.kill()
    except OSError:
        pass
    try:
        process.wait(timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        pass


def _remove_file_safely(path: Path, attempts: int = 20, delay: float = 0.1) -> bool:
    for attempt in range(max(1, attempts)):
        try:
            if not path.exists():
                return True
            path.unlink(missing_ok=True)
            return True
        except (PermissionError, OSError):
            if attempt + 1 < max(1, attempts):
                time.sleep(max(0.0, delay))
    return not path.exists()


def _build_transcode_args(profile: hardware_encoding.EncoderProfile) -> list[str]:
    if profile.hardware:
        return ["-vf", "format=nv12", *profile.args, "-profile:v", "high"]
    return [*profile.args, "-pix_fmt", "yuv420p", "-profile:v", "high"]


def _run_ffmpeg_once(
    *,
    ffmpeg: str,
    source: Path,
    target: Path,
    duration: float,
    copy_streams: bool,
    profile: hardware_encoding.EncoderProfile | None,
    job_id: str,
    cancel_event: Any,
    process_holder: dict[str, Any],
    emit: ProgressCallback,
) -> None:
    command = [
        ffmpeg,
        "-y",
        "-loglevel", "error",
        "-i", str(source),
        "-map", "0:v:0",
        "-map", "0:a:0",
    ]
    if copy_streams:
        command += ["-c", "copy"]
        stage = "merging"
        encoder_label = "Без перекодирования"
        hardware = False
    else:
        assert profile is not None
        command += _build_transcode_args(profile)
        command += ["-c:a", "aac", "-b:a", "192k"]
        stage = "converting"
        encoder_label = profile.label
        hardware = profile.hardware
    command += ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(target)]

    emit({
        "event": "progress",
        "jobId": job_id,
        "stage": stage,
        "percent": 0,
        "encoder": profile.key if profile is not None else "stream-copy",
        "encoderLabel": encoder_label,
        "hardware": hardware,
    })
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    process_holder["process"] = process
    output_tail: deque[str] = deque(maxlen=80)
    speed_factor = 0.0

    try:
        assert process.stdout is not None
        for line in process.stdout:
            stripped = _clean_progress_text(line)
            if stripped:
                output_tail.append(stripped)
            key, _, value = stripped.partition("=")

            if key == "speed":
                cleaned_speed = value.rstrip("x").strip()
                try:
                    speed_factor = max(0.0, float(cleaned_speed))
                except ValueError:
                    speed_factor = 0.0
                continue

            seconds = _parse_ffmpeg_time(key, value)
            if seconds is not None and duration > 0:
                percent = min(99.0, max(0.0, seconds / duration * 100))
                eta = None
                if speed_factor > 0:
                    eta = max(0, round((duration - seconds) / speed_factor))
                emit({
                    "event": "progress",
                    "jobId": job_id,
                    "stage": stage,
                    "percent": percent,
                    "speed": f"{speed_factor:.2f}x" if speed_factor > 0 else "",
                    "eta": eta,
                    "encoder": profile.key if profile is not None else "stream-copy",
                    "encoderLabel": encoder_label,
                    "hardware": hardware,
                })

            if cancel_event.is_set():
                _stop_process(process)
                raise engine.EngineError("DOWNLOAD_CANCELLED", "Скачивание отменено.")

        return_code = process.wait()
        if cancel_event.is_set():
            raise engine.EngineError("DOWNLOAD_CANCELLED", "Скачивание отменено.")
        if return_code != 0:
            details = "\n".join(output_tail)[-1500:]
            raise engine.EngineError("FFMPEG_FAILED", details or "FFmpeg завершился с ошибкой.")
    finally:
        _stop_process(process)
        if process.stdout is not None:
            try:
                process.stdout.close()
            except OSError:
                pass
        process_holder.pop("process", None)


def _run_ffmpeg(
    source: Path,
    target: Path,
    duration: float,
    copy_streams: bool,
    job_id: str,
    cancel_event: Any,
    process_holder: dict[str, Any],
    emit: ProgressCallback,
) -> None:
    ffmpeg = engine.find_binary("ffmpeg")
    if copy_streams:
        _run_ffmpeg_once(
            ffmpeg=ffmpeg,
            source=source,
            target=target,
            duration=duration,
            copy_streams=True,
            profile=None,
            job_id=job_id,
            cancel_event=cancel_event,
            process_holder=process_holder,
            emit=emit,
        )
        return

    selected = hardware_encoding.select_encoder(ffmpeg)
    software = hardware_encoding.profile_by_key("software-x264")
    attempts = [selected]
    if selected.hardware:
        attempts.append(software)

    last_error: engine.EngineError | None = None
    for index, profile in enumerate(attempts):
        _remove_file_safely(target)
        try:
            _run_ffmpeg_once(
                ffmpeg=ffmpeg,
                source=source,
                target=target,
                duration=duration,
                copy_streams=False,
                profile=profile,
                job_id=job_id,
                cancel_event=cancel_event,
                process_holder=process_holder,
                emit=emit,
            )
            return
        except engine.EngineError as exc:
            if exc.code == "DOWNLOAD_CANCELLED" or cancel_event.is_set():
                raise
            last_error = exc
            if index + 1 >= len(attempts):
                raise
            emit({
                "event": "progress",
                "jobId": job_id,
                "stage": "converting",
                "percent": 0,
                "encoder": software.key,
                "encoderLabel": f"{software.label} — резервный режим",
                "hardware": False,
            })

    if last_error is not None:
        raise last_error


def _run_download_with_fixes(*, emit: ProgressCallback, **kwargs: Any) -> dict[str, Any]:
    cancel_event = kwargs.get("cancel_event")
    output_path = str(kwargs.get("output_path") or "")
    job_id = str(kwargs.get("job_id") or "")

    def clean_emit(payload: dict[str, Any]) -> None:
        safe = dict(payload)
        if "speed" in safe:
            safe["speed"] = _clean_progress_text(safe.get("speed"))
        emit(safe)

    try:
        return _ORIGINAL_RUN_DOWNLOAD(emit=clean_emit, **kwargs)
    except PermissionError as exc:
        # A just-terminated FFmpeg process may keep the Windows file handle for
        # a fraction of a second. Never let cleanup replace the real cancel state.
        if output_path and job_id:
            final_path = Path(output_path).expanduser().resolve()
            partial = final_path.with_name(f".{final_path.stem}.{job_id}.partial.mp4")
            _remove_file_safely(partial)
        if cancel_event is not None and cancel_event.is_set():
            raise engine.EngineError("DOWNLOAD_CANCELLED", "Скачивание отменено.") from exc
        raise


def apply() -> None:
    global _APPLIED
    if _APPLIED:
        return
    engine._clean_progress_text = _clean_progress_text
    engine._parse_ffmpeg_time = _parse_ffmpeg_time
    engine._stop_process = _stop_process
    engine._remove_file_safely = _remove_file_safely
    engine._run_ffmpeg = _run_ffmpeg
    engine.run_download = _run_download_with_fixes
    _APPLIED = True
