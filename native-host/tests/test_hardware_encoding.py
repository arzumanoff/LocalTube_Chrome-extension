from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hardware_encoding  # noqa: E402


class HardwareEncodingTests(unittest.TestCase):
    def setUp(self) -> None:
        hardware_encoding.clear_encoder_cache()

    def tearDown(self) -> None:
        hardware_encoding.clear_encoder_cache()

    def test_parses_only_video_encoder_names(self) -> None:
        output = """
 Encoders:
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder
 V..... h264_amf             AMD AMF H.264 Encoder
 V..... h264_qsv             H.264 / AVC / MPEG-4 AVC
 A..... aac                  AAC
"""
        self.assertEqual(
            hardware_encoding.parse_encoder_names(output),
            {"h264_nvenc", "h264_amf", "h264_qsv"},
        )

    def test_prefers_discrete_gpu_profiles_before_intel(self) -> None:
        available = {"h264_nvenc", "h264_amf", "h264_qsv", "libx264"}
        attempts: list[str] = []

        def smoke(_ffmpeg: str, profile: hardware_encoding.EncoderProfile) -> bool:
            attempts.append(profile.key)
            return profile.key == "amd-amf"

        with patch.object(hardware_encoding, "discover_encoder_names", return_value=available), patch.object(
            hardware_encoding, "smoke_test_profile", side_effect=smoke
        ):
            selected = hardware_encoding.select_encoder("ffmpeg.exe")

        self.assertEqual(selected.key, "amd-amf")
        self.assertEqual(attempts, ["nvidia-nvenc", "amd-amf"])
        self.assertTrue(selected.hardware)

    def test_skips_advertised_encoder_when_driver_probe_fails(self) -> None:
        available = {"h264_nvenc", "h264_qsv", "libx264"}

        def smoke(_ffmpeg: str, profile: hardware_encoding.EncoderProfile) -> bool:
            return profile.key == "intel-qsv"

        with patch.object(hardware_encoding, "discover_encoder_names", return_value=available), patch.object(
            hardware_encoding, "smoke_test_profile", side_effect=smoke
        ):
            selected = hardware_encoding.select_encoder("ffmpeg.exe")

        self.assertEqual(selected.key, "intel-qsv")

    def test_falls_back_to_software_when_no_hardware_encoder_starts(self) -> None:
        with patch.object(
            hardware_encoding,
            "discover_encoder_names",
            return_value={"h264_nvenc", "h264_amf", "h264_qsv", "libx264"},
        ), patch.object(hardware_encoding, "smoke_test_profile", return_value=False):
            selected = hardware_encoding.select_encoder("ffmpeg.exe")

        self.assertEqual(selected.key, "software-x264")
        self.assertFalse(selected.hardware)
        self.assertIn("libx264", selected.args)

    def test_caches_successful_detection_for_the_process(self) -> None:
        with patch.object(
            hardware_encoding,
            "discover_encoder_names",
            return_value={"h264_amf", "libx264"},
        ) as discover, patch.object(hardware_encoding, "smoke_test_profile", return_value=True) as smoke:
            first = hardware_encoding.select_encoder("C:/engine/ffmpeg.exe")
            second = hardware_encoding.select_encoder("C:/engine/ffmpeg.exe")

        self.assertIs(first, second)
        discover.assert_called_once()
        smoke.assert_called_once()

    def test_smoke_uses_exact_profile_arguments(self) -> None:
        completed = Mock(returncode=0)
        profile = hardware_encoding.profile_by_key("amd-amf")
        with patch("hardware_encoding.subprocess.run", return_value=completed) as runner:
            self.assertTrue(hardware_encoding.smoke_test_profile("ffmpeg.exe", profile))
        command = runner.call_args.args[0]
        self.assertIn("h264_amf", command)
        self.assertIn("-frames:v", command)
        self.assertEqual(command[-2:], ["null", "-"])


if __name__ == "__main__":
    unittest.main()
