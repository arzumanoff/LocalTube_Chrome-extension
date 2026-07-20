from __future__ import annotations

import re
import sys
import threading
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from engine import EngineError, is_supported_url, probe_video, run_download
from protocol import MessageWriter, ProtocolError, read_message

HOST_VERSION = "0.1.0"
INVALID_WINDOWS_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED_WINDOWS_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


@dataclass
class JobState:
    job_id: str
    cancel_event: threading.Event = field(default_factory=threading.Event)
    process_holder: dict[str, Any] = field(default_factory=dict)
    thread: threading.Thread | None = None


writer = MessageWriter()
jobs: dict[str, JobState] = {}
jobs_lock = threading.Lock()


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def response(request_id: str, **payload: Any) -> None:
    writer.write({"requestId": request_id, **payload})


def emit(payload: dict[str, Any]) -> None:
    writer.write(payload)


def sanitize_suggested_filename(value: Any) -> str:
    name = Path(str(value or "video.mp4")).name
    name = INVALID_WINDOWS_CHARS.sub("_", name).strip().rstrip(". ")
    stem = Path(name).stem.strip().rstrip(". ") or "video"
    suffix = Path(name).suffix.lower()
    if stem.upper() in RESERVED_WINDOWS_NAMES:
        stem = f"_{stem}"
    stem = stem[:180].rstrip(". ") or "video"
    return f"{stem}.mp4" if suffix != ".mp4" else f"{stem}.mp4"


def choose_output_file(suggested_filename: str) -> str | None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as exc:
        raise EngineError("SAVE_DIALOG_UNAVAILABLE", "Системное окно сохранения недоступно.") from exc

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.asksaveasfilename(
            parent=root,
            title="Сохранить видео",
            initialfile=sanitize_suggested_filename(suggested_filename),
            defaultextension=".mp4",
            filetypes=[("MP4 video", "*.mp4")],
            confirmoverwrite=True,
        )
        return str(selected) if selected else None
    finally:
        root.destroy()


def finish_job(job_id: str) -> None:
    with jobs_lock:
        jobs.pop(job_id, None)


def download_worker(job: JobState, url: str, quality_id: str, output_path: str) -> None:
    try:
        result = run_download(
            url=url,
            quality_id=quality_id,
            output_path=output_path,
            job_id=job.job_id,
            cancel_event=job.cancel_event,
            process_holder=job.process_holder,
            emit=emit,
        )
        emit({
            "event": "progress",
            "jobId": job.job_id,
            "stage": "completed",
            "percent": 100,
            "filename": Path(result["path"]).name,
            "height": result["height"],
            "width": result["width"],
            "videoCodec": result["videoCodec"],
            "audioCodec": result["audioCodec"],
            "size": result["size"],
        })
    except EngineError as exc:
        stage = "cancelled" if exc.code == "DOWNLOAD_CANCELLED" else "failed"
        emit({
            "event": "progress",
            "jobId": job.job_id,
            "stage": stage,
            "errorCode": exc.code,
            "message": str(exc),
        })
    except Exception as exc:
        log(traceback.format_exc())
        emit({
            "event": "progress",
            "jobId": job.job_id,
            "stage": "failed",
            "errorCode": "UNEXPECTED_HOST_ERROR",
            "message": f"Внутренняя ошибка локального движка: {exc}",
        })
    finally:
        finish_job(job.job_id)


def handle_ping(request_id: str) -> None:
    response(request_id, ok=True, version=HOST_VERSION)


def handle_probe(request_id: str, message: dict[str, Any]) -> None:
    url = str(message.get("url") or "")
    if not is_supported_url(url):
        response(request_id, ok=False, errorCode="INVALID_VIDEO_URL", message="Некорректная ссылка YouTube.")
        return
    try:
        data = probe_video(url)
        response(request_id, ok=True, **data)
    except EngineError as exc:
        response(request_id, ok=False, errorCode=exc.code, message=str(exc))
    except Exception as exc:
        log(traceback.format_exc())
        response(request_id, ok=False, errorCode="PROBE_FAILED", message=f"Не удалось получить данные ролика: {exc}")


def handle_download(request_id: str, message: dict[str, Any]) -> None:
    url = str(message.get("url") or "")
    quality_id = str(message.get("qualityId") or "")
    suggested_filename = sanitize_suggested_filename(message.get("suggestedFilename"))
    if not is_supported_url(url):
        response(request_id, ok=False, errorCode="INVALID_VIDEO_URL", message="Некорректная ссылка YouTube.")
        return

    with jobs_lock:
        if jobs:
            response(request_id, ok=False, errorCode="BUSY", message="Сейчас уже выполняется другое скачивание.")
            return

    try:
        output_path = choose_output_file(suggested_filename)
    except EngineError as exc:
        response(request_id, ok=False, errorCode=exc.code, message=str(exc))
        return
    except Exception as exc:
        log(traceback.format_exc())
        response(request_id, ok=False, errorCode="SAVE_DIALOG_FAILED", message=f"Не удалось открыть окно сохранения: {exc}")
        return

    if not output_path:
        response(
            request_id,
            ok=False,
            cancelled=True,
            errorCode="SAVE_DIALOG_CANCELLED",
            message="Сохранение отменено.",
        )
        return

    job_id = f"job-{uuid.uuid4().hex}"
    job = JobState(job_id=job_id)
    thread = threading.Thread(
        target=download_worker,
        args=(job, url, quality_id, output_path),
        name=f"download-{job_id}",
        daemon=True,
    )
    job.thread = thread
    with jobs_lock:
        jobs[job_id] = job
    response(request_id, ok=True, jobId=job_id, stage="preparing")
    thread.start()


def handle_cancel(request_id: str, message: dict[str, Any]) -> None:
    job_id = str(message.get("jobId") or "")
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        response(request_id, ok=False, errorCode="JOB_NOT_FOUND", message="Задание не найдено.")
        return
    job.cancel_event.set()
    process = job.process_holder.get("process")
    if process is not None and process.poll() is None:
        try:
            process.terminate()
        except OSError:
            pass
    response(request_id, ok=True, jobId=job_id, stage="cancelled")


def handle_message(message: dict[str, Any]) -> None:
    request_id = str(message.get("requestId") or "")
    action = str(message.get("action") or "")
    if not request_id:
        return
    if action == "ping":
        handle_ping(request_id)
    elif action == "probe":
        handle_probe(request_id, message)
    elif action == "download":
        handle_download(request_id, message)
    elif action == "cancel":
        handle_cancel(request_id, message)
    else:
        response(request_id, ok=False, errorCode="UNKNOWN_ACTION", message="Неизвестная команда локального движка.")


def main() -> int:
    log(f"media engine host {HOST_VERSION} started")
    while True:
        try:
            message = read_message()
            if message is None:
                return 0
            handle_message(message)
        except ProtocolError as exc:
            log(f"protocol error: {exc}")
            return 2
        except Exception:
            log(traceback.format_exc())
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
