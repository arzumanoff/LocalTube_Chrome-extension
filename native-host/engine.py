from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

ProgressCallback = Callable[[dict[str, Any]], None]
QUALITY_RE = re.compile(r"^h(?P<height>\d{2,5})-f(?P<fps>\d{1,3})$")


class EngineError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def is_supported_url(value: str) -> bool:
    if not isinstance(value, str) or not value or len(value) > 4096:
        return False
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    host = (parsed.hostname or "").lower()
    if host == "youtu.be":
        return bool(parsed.path.strip("/"))
    if host not in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}:
        return False
    if parsed.path == "/watch":
        return bool(parse_qs(parsed.query).get("v", [""])[0])
    return parsed.path.startswith("/shorts/") and bool(parsed.path.split("/")[2:3])


def _codec_starts(value: Any, prefixes: tuple[str, ...]) -> bool:
    codec = str(value or "").lower()
    return codec != "none" and codec.startswith(prefixes)


def _fps_bucket(value: Any) -> int:
    try:
        fps = int(round(float(value or 0)))
    except (TypeError, ValueError):
        fps = 0
    return fps if fps > 30 else 30


def _valid_video_format(item: dict[str, Any]) -> bool:
    try:
        height = int(item.get("height") or 0)
    except (TypeError, ValueError):
        return False
    if height <= 0 or str(item.get("vcodec") or "none") == "none":
        return False
    if str(item.get("ext") or "").lower() == "mhtml":
        return False
    if str(item.get("protocol") or "").lower() == "mhtml":
        return False
    note = f"{item.get('format_note') or ''} {item.get('format') or ''}".lower()
    return "storyboard" not in note


def build_qualities(formats: list[dict[str, Any]]) -> list[dict[str, Any]]:
    safe_formats = [item for item in formats if isinstance(item, dict)]
    video_formats = [item for item in safe_formats if _valid_video_format(item)]
    has_aac_audio = any(
        str(item.get("acodec") or "none") != "none"
        and _codec_starts(item.get("acodec"), ("mp4a", "aac"))
        for item in safe_formats
    )

    grouped: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for item in video_formats:
        height = int(item.get("height") or 0)
        fps = _fps_bucket(item.get("fps"))
        grouped.setdefault((height, fps), []).append(item)

    qualities: list[dict[str, Any]] = []
    for (height, fps), group in grouped.items():
        has_progressive = any(str(item.get("acodec") or "none") != "none" for item in group)
        has_h264 = any(_codec_starts(item.get("vcodec"), ("avc1", "h264")) for item in group)
        label = f"{height}p{fps}" if fps > 30 else f"{height}p"
        qualities.append({
            "id": f"h{height}-f{fps}",
            "height": height,
            "fps": fps,
            "label": label,
            "requiresMerge": not has_progressive,
            "requiresTranscode": not (has_h264 and has_aac_audio),
        })

    qualities.sort(key=lambda item: (-item["height"], -item["fps"], item["id"]))
    return qualities


def parse_quality_id(quality_id: str) -> tuple[int, int]:
    match = QUALITY_RE.fullmatch(str(quality_id or ""))
    if not match:
        raise EngineError("INVALID_QUALITY", "Некорректное качество.")
    height = int(match.group("height"))
    fps = int(match.group("fps"))
    if not 100 <= height <= 10000 or not 1 <= fps <= 240:
        raise EngineError("INVALID_QUALITY", "Некорректное качество.")
    return height, fps


def build_format_selector(quality_id: str) -> str:
    height, fps = parse_quality_id(quality_id)
    fps_filter = "[fps<=30]" if fps <= 30 else f"[fps>={max(31, fps - 1)}][fps<={fps}]"
    base = f"[height={height}]{fps_filter}"
    return "/".join([
        f"bestvideo{base}[vcodec^=avc1]+bestaudio[acodec^=mp4a]",
        f"bestvideo{base}[vcodec^=h264]+bestaudio[acodec^=mp4a]",
        f"bestvideo{base}+bestaudio",
        f"best{base}",
    ])


def _import_yt_dlp():
    try:
        import yt_dlp  # type: ignore
        return yt_dlp
    except ImportError as exc:
        raise EngineError("YTDLP_NOT_INSTALLED", "Компонент yt-dlp не установлен.") from exc


def probe_video(url: str) -> dict[str, Any]:
    if not is_supported_url(url):
        raise EngineError("INVALID_VIDEO_URL", "Некорректная ссылка YouTube.")
    yt_dlp = _import_yt_dlp()
    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": False,
    }
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        raise EngineError("PROBE_FAILED", f"Не удалось получить данные ролика: {exc}") from exc

    if not isinstance(info, dict):
        raise EngineError("PROBE_FAILED", "yt-dlp не вернул данные ролика.")
    qualities = build_qualities(info.get("formats") or [])
    if not qualities:
        raise EngineError("NO_QUALITIES", "Доступные качества не найдены.")
    return {
        "videoId": str(info.get("id") or ""),
        "title": str(info.get("title") or info.get("id") or "Видео"),
        "channel": str(info.get("channel") or info.get("uploader") or ""),
        "duration": float(info.get("duration") or 0),
        "thumbnail": str(info.get("thumbnail") or ""),
        "qualities": qualities,
    }


def _runtime_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def find_binary(name: str) -> str:
    env_name = f"MEDIA_ENGINE_{name.upper()}"
    configured = os.environ.get(env_name)
    candidates = [
        Path(configured) if configured else None,
        _runtime_dir() / f"{name}.exe",
        _runtime_dir() / name,
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            return str(candidate)
    found = shutil.which(name)
    if found:
        return found
    raise EngineError(f"{name.upper()}_NOT_FOUND", f"Не найден {name}. Установите локальный движок повторно.")


def inspect_media(path: Path) -> dict[str, Any]:
    ffprobe = find_binary("ffprobe")
    completed = subprocess.run(
        [
            ffprobe,
            "-v", "error",
            "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height",
            "-of", "json",
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if completed.returncode != 0:
        raise EngineError("FFPROBE_FAILED", completed.stderr.strip() or "Не удалось проверить скачанный файл.")
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise EngineError("FFPROBE_FAILED", "FFprobe вернул некорректный результат.") from exc
    streams = data.get("streams") or []
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
    if not video or not audio:
        raise EngineError("MISSING_MEDIA_TRACK", "Итоговый файл должен содержать видео и звук.")
    return {
        "videoCodec": str(video.get("codec_name") or ""),
        "audioCodec": str(audio.get("codec_name") or ""),
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "duration": float((data.get("format") or {}).get("duration") or 0),
    }


def _select_downloaded_file(directory: Path) -> Path:
    ignored = {".part", ".ytdl", ".json"}
    candidates = [
        path for path in directory.iterdir()
        if path.is_file()
        and not any(path.name.endswith(suffix) for suffix in ignored)
        and not path.name.startswith("final-")
    ]
    if not candidates:
        raise EngineError("DOWNLOAD_OUTPUT_MISSING", "Скачанный файл не найден.")
    return max(candidates, key=lambda path: path.stat().st_size)


def _run_ffmpeg(
    source: Path,
    target: Path,
    duration: float,
    copy_streams: bool,
    job_id: str,
    cancel_event: threading.Event,
    process_holder: dict[str, Any],
    emit: ProgressCallback,
) -> None:
    ffmpeg = find_binary("ffmpeg")
    command = [
        ffmpeg,
        "-y",
        "-i", str(source),
        "-map", "0:v:0",
        "-map", "0:a:0",
    ]
    if copy_streams:
        command += ["-c", "copy"]
        stage = "merging"
    else:
        command += ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k"]
        stage = "converting"
    command += ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(target)]

    emit({"event": "progress", "jobId": job_id, "stage": stage, "percent": 0})
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    process_holder["process"] = process
    try:
        assert process.stdout is not None
        for line in process.stdout:
            if cancel_event.is_set():
                process.terminate()
                raise EngineError("DOWNLOAD_CANCELLED", "Скачивание отменено.")
            key, _, value = line.strip().partition("=")
            if key == "out_time_ms" and duration > 0:
                try:
                    seconds = int(value) / 1_000_000
                    percent = min(99.0, max(0.0, seconds / duration * 100))
                    emit({"event": "progress", "jobId": job_id, "stage": stage, "percent": percent})
                except ValueError:
                    pass
        stderr = process.stderr.read() if process.stderr else ""
        return_code = process.wait()
        if return_code != 0:
            raise EngineError("FFMPEG_FAILED", stderr.strip()[-1500:] or "FFmpeg завершился с ошибкой.")
    finally:
        process_holder.pop("process", None)


def run_download(
    *,
    url: str,
    quality_id: str,
    output_path: str,
    job_id: str,
    cancel_event: threading.Event,
    process_holder: dict[str, Any],
    emit: ProgressCallback,
) -> dict[str, Any]:
    if not is_supported_url(url):
        raise EngineError("INVALID_VIDEO_URL", "Некорректная ссылка YouTube.")
    height, _ = parse_quality_id(quality_id)
    yt_dlp = _import_yt_dlp()
    final_path = Path(output_path).expanduser().resolve()
    if final_path.suffix.lower() != ".mp4":
        final_path = final_path.with_suffix(".mp4")
    final_path.parent.mkdir(parents=True, exist_ok=True)

    temp_root = Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "ArzumanoffMediaEngine" / "temp"
    temp_root.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix=f"{job_id}-", dir=temp_root))
    partial_final = final_path.with_name(f".{final_path.stem}.{job_id}.partial.mp4")

    def progress_hook(data: dict[str, Any]) -> None:
        if cancel_event.is_set():
            raise yt_dlp.utils.DownloadError("cancelled")
        if data.get("status") != "downloading":
            return
        downloaded = float(data.get("downloaded_bytes") or 0)
        total = float(data.get("total_bytes") or data.get("total_bytes_estimate") or 0)
        percent = downloaded / total * 100 if total > 0 else 0
        emit({
            "event": "progress",
            "jobId": job_id,
            "stage": "downloading",
            "percent": max(0.0, min(99.0, percent)),
            "speed": data.get("_speed_str") or "",
            "eta": data.get("eta"),
        })

    def postprocessor_hook(data: dict[str, Any]) -> None:
        if str(data.get("status") or "") in {"started", "processing"}:
            emit({"event": "progress", "jobId": job_id, "stage": "merging", "percent": 0})

    options = {
        "format": build_format_selector(quality_id),
        "outtmpl": str(work_dir / "source.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "overwrites": True,
        "continuedl": True,
        "concurrent_fragment_downloads": 4,
        "merge_output_format": "mkv",
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [postprocessor_hook],
    }

    emit({"event": "progress", "jobId": job_id, "stage": "preparing", "percent": 0})
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
        if cancel_event.is_set():
            raise EngineError("DOWNLOAD_CANCELLED", "Скачивание отменено.")
        source = _select_downloaded_file(work_dir)
        source_info = inspect_media(source)
        if source_info["height"] != height:
            raise EngineError("RESOLUTION_MISMATCH", f"Получено {source_info['height']}p вместо выбранного {height}p.")
        copy_streams = source_info["videoCodec"] == "h264" and source_info["audioCodec"] == "aac"
        _run_ffmpeg(
            source,
            partial_final,
            float(source_info["duration"] or (info or {}).get("duration") or 0),
            copy_streams,
            job_id,
            cancel_event,
            process_holder,
            emit,
        )
        result_info = inspect_media(partial_final)
        if result_info["videoCodec"] != "h264" or result_info["audioCodec"] != "aac":
            raise EngineError("OUTPUT_CODEC_MISMATCH", "Итоговый файл должен содержать H.264 и AAC.")
        if result_info["height"] != height:
            raise EngineError("RESOLUTION_MISMATCH", "Разрешение изменилось во время обработки.")
        emit({"event": "progress", "jobId": job_id, "stage": "finalizing", "percent": 100})
        os.replace(partial_final, final_path)
        return {
            "path": str(final_path),
            "height": result_info["height"],
            "width": result_info["width"],
            "duration": result_info["duration"],
            "videoCodec": result_info["videoCodec"],
            "audioCodec": result_info["audioCodec"],
            "size": final_path.stat().st_size,
        }
    except EngineError:
        raise
    except Exception as exc:
        if cancel_event.is_set() or "cancelled" in str(exc).lower():
            raise EngineError("DOWNLOAD_CANCELLED", "Скачивание отменено.") from exc
        raise EngineError("DOWNLOAD_FAILED", f"Не удалось скачать видео: {exc}") from exc
    finally:
        process = process_holder.pop("process", None)
        if process and process.poll() is None:
            process.terminate()
        if partial_final.exists():
            partial_final.unlink(missing_ok=True)
        shutil.rmtree(work_dir, ignore_errors=True)
