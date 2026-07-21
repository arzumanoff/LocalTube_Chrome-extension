from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import engine  # noqa: E402
from runtime_fixes import apply  # noqa: E402


def assert_output(path: Path) -> dict[str, object]:
    result = engine.inspect_media(path)
    if result["videoCodec"] != "h264" or result["audioCodec"] != "aac":
        raise AssertionError(f"unexpected codecs: {result}")
    if result["height"] != 360:
        raise AssertionError(f"unexpected height: {result}")
    return result


def main() -> int:
    if len(sys.argv) != 5:
        raise SystemExit(
            "usage: smoke_media_pipeline.py <source.mkv> <target.mp4> <ffmpeg> <ffprobe>"
        )

    source = Path(sys.argv[1]).resolve()
    remux_target = Path(sys.argv[2]).resolve()
    transcode_target = remux_target.with_name("transcoded.mp4")
    os.environ["MEDIA_ENGINE_FFMPEG"] = str(Path(sys.argv[3]).resolve())
    os.environ["MEDIA_ENGINE_FFPROBE"] = str(Path(sys.argv[4]).resolve())
    apply()

    source_info = engine.inspect_media(source)

    remux_events: list[dict[str, object]] = []
    engine._run_ffmpeg(
        source=source,
        target=remux_target,
        duration=source_info["duration"],
        copy_streams=True,
        job_id="smoke-remux",
        cancel_event=threading.Event(),
        process_holder={},
        emit=remux_events.append,
    )
    assert_output(remux_target)
    if not remux_events or remux_events[0].get("stage") != "merging":
        raise AssertionError(f"missing merging progress: {remux_events}")

    transcode_events: list[dict[str, object]] = []
    engine._run_ffmpeg(
        source=source,
        target=transcode_target,
        duration=source_info["duration"],
        copy_streams=False,
        job_id="smoke-transcode",
        cancel_event=threading.Event(),
        process_holder={},
        emit=transcode_events.append,
    )
    assert_output(transcode_target)
    converting = [event for event in transcode_events if event.get("stage") == "converting"]
    if not converting:
        raise AssertionError(f"missing converting progress: {transcode_events}")
    if not converting[-1].get("encoder"):
        raise AssertionError(f"encoder was not reported: {transcode_events}")

    print(
        "media pipeline smoke passed; encoder="
        + str(converting[-1].get("encoderLabel") or converting[-1].get("encoder"))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
