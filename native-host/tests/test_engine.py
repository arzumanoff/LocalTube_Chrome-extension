from __future__ import annotations

import io
import json
import struct
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from runtime_fixes import (  # noqa: E402
    _clean_progress_text,
    _parse_ffmpeg_time,
    _remove_file_safely,
    _stop_process,
    apply,
)

apply()

from engine import (  # noqa: E402
    EngineError,
    build_format_selector,
    build_qualities,
    is_supported_url,
    parse_quality_id,
    source_processing_mode,
)
import host  # noqa: E402
from host import sanitize_suggested_filename  # noqa: E402
from protocol import MessageWriter, ProtocolError, read_message  # noqa: E402


class EngineTests(unittest.TestCase):
    def test_supported_urls(self) -> None:
        self.assertTrue(is_supported_url("https://www.youtube.com/watch?v=abc"))
        self.assertTrue(is_supported_url("https://youtu.be/abc"))
        self.assertFalse(is_supported_url("https://example.com/watch?v=abc"))
        self.assertFalse(is_supported_url("http://www.youtube.com/watch?v=abc"))

    def test_builds_real_quality_list_without_upscale(self) -> None:
        formats = [
            {"format_id": "18", "height": 360, "fps": 30, "vcodec": "avc1.42001E", "acodec": "mp4a.40.2", "ext": "mp4"},
            {"format_id": "135", "height": 480, "fps": 30, "vcodec": "avc1.4d401f", "acodec": "none", "ext": "mp4"},
            {"format_id": "137", "height": 1080, "fps": 30, "vcodec": "avc1.640028", "acodec": "none", "ext": "mp4"},
            {"format_id": "299", "height": 1080, "fps": 60, "vcodec": "avc1.64002a", "acodec": "none", "ext": "mp4"},
            {"format_id": "140", "height": None, "fps": None, "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a"},
            {"format_id": "sb0", "height": 90, "fps": 1, "vcodec": "mhtml", "acodec": "none", "ext": "mhtml", "format_note": "storyboard"},
        ]
        qualities = build_qualities(formats)
        self.assertEqual([item["label"] for item in qualities], ["1080p60", "1080p", "480p", "360p"])
        self.assertFalse(any(item["height"] == 2160 for item in qualities))
        self.assertTrue(qualities[0]["requiresMerge"])
        self.assertFalse(qualities[0]["requiresTranscode"])
        self.assertFalse(qualities[-1]["requiresMerge"])
        self.assertFalse(qualities[-1]["requiresTranscode"])

    def test_prefers_clean_adaptive_pair_over_bad_progressive_file(self) -> None:
        formats = [
            {"height": 360, "fps": 30, "vcodec": "vp9", "acodec": "opus", "ext": "webm"},
            {"height": 360, "fps": 30, "vcodec": "avc1.42001E", "acodec": "none", "ext": "mp4"},
            {"height": None, "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a"},
        ]
        quality = build_qualities(formats)[0]
        self.assertTrue(quality["requiresMerge"])
        self.assertFalse(quality["requiresTranscode"])

    def test_marks_non_h264_quality_for_transcode(self) -> None:
        formats = [
            {"height": 2160, "fps": 60, "vcodec": "av01.0.13M.08", "acodec": "none", "ext": "mp4"},
            {"height": None, "vcodec": "none", "acodec": "opus", "ext": "webm"},
        ]
        quality = build_qualities(formats)[0]
        self.assertEqual(quality["label"], "2160p60")
        self.assertTrue(quality["requiresTranscode"])

    def test_exact_selector_prefers_ready_progressive_mp4(self) -> None:
        selector = build_format_selector("h360-f30")
        choices = selector.split("/")
        self.assertTrue(choices[0].startswith("best[height=360][fps<=30]"))
        self.assertIn("[vcodec^=avc1]", choices[0])
        self.assertIn("[acodec^=mp4a]", choices[0])
        self.assertIn("bestvideo", selector)

    def test_exact_selector_never_requests_higher_height(self) -> None:
        selector = build_format_selector("h1080-f60")
        self.assertIn("[height=1080]", selector)
        self.assertNotIn("height<=", selector)
        self.assertNotIn("2160", selector)
        self.assertIn("[fps>=59][fps<=60]", selector)

    def test_ready_mp4_skips_ffmpeg(self) -> None:
        info = {"videoCodec": "h264", "audioCodec": "aac"}
        self.assertEqual(source_processing_mode(Path("source.mp4"), info), "ready")
        self.assertEqual(source_processing_mode(Path("source.mkv"), info), "remux")
        self.assertEqual(
            source_processing_mode(Path("source.webm"), {"videoCodec": "vp9", "audioCodec": "opus"}),
            "transcode",
        )

    def test_ffmpeg_progress_accepts_microsecond_keys(self) -> None:
        self.assertEqual(_parse_ffmpeg_time("out_time_us", "5000000"), 5.0)
        self.assertEqual(_parse_ffmpeg_time("out_time_ms", "2500000"), 2.5)
        self.assertIsNone(_parse_ffmpeg_time("frame", "25"))
        self.assertIsNone(_parse_ffmpeg_time("out_time_us", "broken"))

    def test_progress_text_removes_ansi_and_controls(self) -> None:
        self.assertEqual(_clean_progress_text("\x1b[0;32m10.55MiB/s\x1b[0m\r"), "10.55MiB/s")

    def test_stop_process_waits_then_kills_if_needed(self) -> None:
        process = MagicMock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("ffmpeg", 0.01), 0]
        _stop_process(process, timeout=0.01)
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)

    def test_safe_remove_does_not_raise_when_windows_file_is_temporarily_locked(self) -> None:
        path = MagicMock(spec=Path)
        path.exists.return_value = True
        path.unlink.side_effect = PermissionError(32, "locked")
        with patch("runtime_fixes.time.sleep"):
            self.assertFalse(_remove_file_safely(path, attempts=2, delay=0))
        self.assertEqual(path.unlink.call_count, 2)

    def test_busy_response_exposes_active_job_for_cancellation(self) -> None:
        job = host.JobState(job_id="job-existing", stage="merging", percent=42)
        with host.jobs_lock:
            host.jobs[job.job_id] = job
        try:
            with patch.object(host, "response") as mocked_response:
                host.handle_download(
                    "request-1",
                    {
                        "url": "https://www.youtube.com/watch?v=abc",
                        "qualityId": "h1080-f30",
                        "suggestedFilename": "Demo.mp4",
                    },
                )
            mocked_response.assert_called_once_with(
                "request-1",
                ok=False,
                errorCode="BUSY",
                message="Сейчас уже выполняется другое скачивание.",
                jobId="job-existing",
                stage="merging",
                percent=42,
            )
        finally:
            with host.jobs_lock:
                host.jobs.clear()

    def test_parse_quality_rejects_invalid_value(self) -> None:
        self.assertEqual(parse_quality_id("h720-f30"), (720, 30))
        with self.assertRaises(EngineError):
            parse_quality_id("best")

    def test_filename_sanitization(self) -> None:
        self.assertEqual(sanitize_suggested_filename('A:B?C.mp4'), 'A_B_C.mp4')
        self.assertEqual(sanitize_suggested_filename('CON.mp4'), '_CON.mp4')
        self.assertEqual(sanitize_suggested_filename('../video.webm'), 'video.mp4')


class ProtocolTests(unittest.TestCase):
    def test_round_trip(self) -> None:
        output = io.BytesIO()
        MessageWriter(output).write({"ok": True, "title": "Тест"})
        output.seek(0)
        self.assertEqual(read_message(output), {"ok": True, "title": "Тест"})

    def test_rejects_oversized_header(self) -> None:
        stream = io.BytesIO(struct.pack("<I", 2 * 1024 * 1024))
        with self.assertRaises(ProtocolError):
            read_message(stream)

    def test_writer_uses_little_endian_length_prefix(self) -> None:
        output = io.BytesIO()
        MessageWriter(output).write({"x": 1})
        raw = output.getvalue()
        length = struct.unpack("<I", raw[:4])[0]
        self.assertEqual(length, len(raw[4:]))
        self.assertEqual(json.loads(raw[4:].decode("utf-8")), {"x": 1})


if __name__ == "__main__":
    unittest.main()
