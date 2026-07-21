from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from runtime_fixes import _remove_file_safely, apply  # noqa: E402

apply()

from engine import EngineError, _run_ffmpeg, inspect_media  # noqa: E402


def main() -> int:
    if len(sys.argv) != 5:
        raise SystemExit(
            "usage: smoke_cancel_pipeline.py <source.mkv> <target.mp4> <ffmpeg> <ffprobe>"
        )

    source = Path(sys.argv[1]).resolve()
    target = Path(sys.argv[2]).resolve()
    os.environ["MEDIA_ENGINE_FFMPEG"] = str(Path(sys.argv[3]).resolve())
    os.environ["MEDIA_ENGINE_FFPROBE"] = str(Path(sys.argv[4]).resolve())

    source_info = inspect_media(source)
    cancel_event = threading.Event()
    process_holder: dict[str, object] = {}
    events: list[dict[str, object]] = []

    def cancel_like_host() -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            process = process_holder.get("process")
            if process is not None:
                cancel_event.set()
                try:
                    process.terminate()  # type: ignore[attr-defined]
                except OSError:
                    pass
                return
            time.sleep(0.01)
        raise AssertionError("FFmpeg process did not start")

    canceller = threading.Thread(target=cancel_like_host, daemon=True)
    canceller.start()
    try:
        _run_ffmpeg(
            source=source,
            target=target,
            duration=source_info["duration"],
            copy_streams=False,
            job_id="smoke-cancel",
            cancel_event=cancel_event,
            process_holder=process_holder,
            emit=events.append,
        )
    except EngineError as exc:
        if exc.code != "DOWNLOAD_CANCELLED":
            raise AssertionError(f"unexpected error: {exc.code}: {exc}") from exc
    else:
        raise AssertionError("cancelled FFmpeg unexpectedly completed")
    finally:
        canceller.join(timeout=10)

    if process_holder:
        raise AssertionError(f"process holder was not cleared: {process_holder}")
    if not _remove_file_safely(target, attempts=5, delay=0.1):
        raise AssertionError(f"cancelled output is still locked: {target}")
    if not any(event.get("stage") == "converting" for event in events):
        raise AssertionError(f"missing converting progress: {events}")

    print("media cancellation smoke passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
