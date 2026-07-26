from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hardware_profile  # noqa: E402


class HardwareProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        hardware_profile._fingerprint_cached.cache_clear()
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ffmpeg = self.root / "ffmpeg.exe"
        self.ffmpeg.write_bytes(b"ffmpeg-build-one")
        self.path = self.root / "hardware-profile.json"
        self.profile = SimpleNamespace(
            key="amd-amf",
            codec="h264_amf",
            label="AMD AMF",
            hardware=True,
        )

    def tearDown(self) -> None:
        hardware_profile._fingerprint_cached.cache_clear()
        self.temp.cleanup()

    def payload(self) -> dict[str, object]:
        return hardware_profile.build_profile_payload(self.profile, self.ffmpeg)

    def test_round_trip_valid_verified_profile(self) -> None:
        hardware_profile.write_profile_atomic(self.path, self.payload())
        loaded = hardware_profile.load_verified_profile(self.path, self.ffmpeg)
        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["encoderKey"], "amd-amf")
        self.assertEqual(loaded["status"], "verified")

    def test_malformed_json_is_rejected(self) -> None:
        self.path.write_text("{not-json", encoding="utf-8")
        self.assertIsNone(hardware_profile.read_profile(self.path))
        self.assertIsNone(hardware_profile.load_verified_profile(self.path, self.ffmpeg))

    def test_unsupported_encoder_key_is_rejected(self) -> None:
        payload = self.payload()
        payload["encoderKey"] = "mystery-gpu"
        self.path.write_text(json.dumps(payload), encoding="utf-8")
        self.assertIsNone(hardware_profile.read_profile(self.path))
        with self.assertRaises(ValueError):
            hardware_profile.write_profile_atomic(self.path, payload)

    def test_ffmpeg_fingerprint_mismatch_invalidates_profile(self) -> None:
        hardware_profile.write_profile_atomic(self.path, self.payload())
        self.ffmpeg.write_bytes(b"ffmpeg-build-two")
        hardware_profile._fingerprint_cached.cache_clear()
        self.assertIsNone(hardware_profile.load_verified_profile(self.path, self.ffmpeg))

    def test_mark_stale_preserves_profile_but_disables_runtime_use(self) -> None:
        hardware_profile.write_profile_atomic(self.path, self.payload())
        hardware_profile.mark_profile_stale(self.path)
        stored = hardware_profile.read_profile(self.path)
        self.assertEqual(stored["status"], "stale")
        self.assertIsNone(hardware_profile.load_verified_profile(self.path, self.ffmpeg))

    def test_atomic_write_leaves_no_temporary_files(self) -> None:
        hardware_profile.write_profile_atomic(self.path, self.payload())
        self.assertTrue(self.path.exists())
        self.assertEqual(list(self.root.glob(".hardware-profile.json.*.tmp")), [])

    def test_fingerprint_format_is_sha256(self) -> None:
        fingerprint = hardware_profile.ffmpeg_fingerprint(self.ffmpeg)
        self.assertRegex(fingerprint, r"^sha256:[0-9a-f]{64}$")

    def test_detection_writes_detailed_log_next_to_profile(self) -> None:
        def select(_ffmpeg: str, diagnostic_lines: list[str] | None = None):
            assert diagnostic_lines is not None
            diagnostic_lines.extend([
                "encoder h264_nvenc: not advertised",
                "encoder h264_amf: failed; exitCode=1",
                "stderr: AMF failed to initialise",
                "selected: software-x264",
            ])
            return self.profile

        with patch("hardware_encoding.select_encoder", side_effect=select):
            hardware_profile.detect_and_store(self.ffmpeg, self.path)

        log_path = self.root / "logs" / "hardware-detection.log"
        self.assertTrue(log_path.is_file())
        text = log_path.read_text(encoding="utf-8")
        self.assertIn("h264_amf", text)
        self.assertIn("AMF failed to initialise", text)
        self.assertIn("selected: software-x264", text)
        self.assertIn("ffmpegFingerprint=sha256:", text)


if __name__ == "__main__":
    unittest.main()
