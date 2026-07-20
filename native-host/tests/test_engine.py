from __future__ import annotations

import io
import json
import struct
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine import (  # noqa: E402
    EngineError,
    build_format_selector,
    build_qualities,
    is_supported_url,
    parse_quality_id,
)
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

    def test_marks_non_h264_quality_for_transcode(self) -> None:
        formats = [
            {"height": 2160, "fps": 60, "vcodec": "av01.0.13M.08", "acodec": "none", "ext": "mp4"},
            {"height": None, "vcodec": "none", "acodec": "opus", "ext": "webm"},
        ]
        quality = build_qualities(formats)[0]
        self.assertEqual(quality["label"], "2160p60")
        self.assertTrue(quality["requiresTranscode"])

    def test_exact_selector_never_requests_higher_height(self) -> None:
        selector = build_format_selector("h1080-f60")
        self.assertIn("[height=1080]", selector)
        self.assertNotIn("height<=", selector)
        self.assertNotIn("2160", selector)
        self.assertIn("[fps>=59][fps<=60]", selector)

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
