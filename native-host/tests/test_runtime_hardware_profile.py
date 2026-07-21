from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import engine  # noqa: E402
import runtime_fixes  # noqa: E402


class RuntimeHardwareProfileTests(unittest.TestCase):
    def call_run(self) -> None:
        runtime_fixes._run_ffmpeg(
            source=Path("source.webm"),
            target=Path("target.mp4"),
            duration=60.0,
            copy_streams=False,
            job_id="job-test",
            cancel_event=threading.Event(),
            process_holder={},
            emit=lambda _payload: None,
        )

    def test_verified_profile_avoids_runtime_detection(self) -> None:
        payload = {"encoderKey": "amd-amf"}
        with patch.object(engine, "find_binary", return_value="ffmpeg.exe"), patch.object(
            runtime_fixes.hardware_profile, "profile_path", return_value=Path("hardware-profile.json")
        ), patch.object(
            runtime_fixes.hardware_profile, "load_verified_profile", return_value=payload
        ), patch.object(
            runtime_fixes.hardware_profile, "detect_and_store"
        ) as detect, patch.object(
            runtime_fixes, "_run_ffmpeg_once"
        ) as run_once:
            self.call_run()

        detect.assert_not_called()
        self.assertEqual(run_once.call_args.kwargs["profile"].key, "amd-amf")

    def test_missing_profile_is_detected_once_and_persisted(self) -> None:
        payload = {"encoderKey": "intel-qsv"}
        with patch.object(engine, "find_binary", return_value="ffmpeg.exe"), patch.object(
            runtime_fixes.hardware_profile, "profile_path", return_value=Path("hardware-profile.json")
        ), patch.object(
            runtime_fixes.hardware_profile, "load_verified_profile", return_value=None
        ), patch.object(
            runtime_fixes.hardware_profile, "detect_and_store", return_value=payload
        ) as detect, patch.object(runtime_fixes, "_run_ffmpeg_once"):
            self.call_run()

        detect.assert_called_once_with("ffmpeg.exe", Path("hardware-profile.json"))

    def test_cancellation_does_not_invalidate_profile(self) -> None:
        payload = {"encoderKey": "amd-amf"}
        with patch.object(engine, "find_binary", return_value="ffmpeg.exe"), patch.object(
            runtime_fixes.hardware_profile, "profile_path", return_value=Path("hardware-profile.json")
        ), patch.object(
            runtime_fixes.hardware_profile, "load_verified_profile", return_value=payload
        ), patch.object(
            runtime_fixes.hardware_profile, "mark_profile_stale"
        ) as stale, patch.object(
            runtime_fixes,
            "_run_ffmpeg_once",
            side_effect=engine.EngineError("DOWNLOAD_CANCELLED", "Скачивание отменено."),
        ):
            with self.assertRaises(engine.EngineError) as raised:
                self.call_run()

        self.assertEqual(raised.exception.code, "DOWNLOAD_CANCELLED")
        stale.assert_not_called()

    def test_unrelated_ffmpeg_failure_does_not_invalidate_profile(self) -> None:
        payload = {"encoderKey": "amd-amf"}
        with patch.object(engine, "find_binary", return_value="ffmpeg.exe"), patch.object(
            runtime_fixes.hardware_profile, "profile_path", return_value=Path("hardware-profile.json")
        ), patch.object(
            runtime_fixes.hardware_profile, "load_verified_profile", return_value=payload
        ), patch.object(
            runtime_fixes.hardware_profile, "mark_profile_stale"
        ) as stale, patch.object(
            runtime_fixes,
            "_run_ffmpeg_once",
            side_effect=engine.EngineError("FFMPEG_FAILED", "No space left on device"),
        ) as run_once:
            with self.assertRaises(engine.EngineError):
                self.call_run()

        self.assertEqual(run_once.call_count, 1)
        stale.assert_not_called()

    def test_encoder_initialization_failure_uses_one_software_fallback(self) -> None:
        payload = {"encoderKey": "amd-amf"}
        with patch.object(engine, "find_binary", return_value="ffmpeg.exe"), patch.object(
            runtime_fixes.hardware_profile, "profile_path", return_value=Path("hardware-profile.json")
        ), patch.object(
            runtime_fixes.hardware_profile, "load_verified_profile", return_value=payload
        ), patch.object(
            runtime_fixes.hardware_profile, "mark_profile_stale"
        ) as stale, patch.object(
            runtime_fixes.hardware_profile, "detect_and_store", return_value=payload
        ) as redetect, patch.object(
            runtime_fixes,
            "_run_ffmpeg_once",
            side_effect=[
                engine.EngineError(
                    "FFMPEG_FAILED",
                    "[h264_amf] AMF initialization failed: Error while opening encoder",
                ),
                None,
            ],
        ) as run_once:
            self.call_run()

        self.assertEqual(run_once.call_count, 2)
        first_profile = run_once.call_args_list[0].kwargs["profile"]
        second_profile = run_once.call_args_list[1].kwargs["profile"]
        self.assertEqual(first_profile.key, "amd-amf")
        self.assertEqual(second_profile.key, "software-x264")
        stale.assert_called_once_with(Path("hardware-profile.json"))
        redetect.assert_called_once_with("ffmpeg.exe", Path("hardware-profile.json"))


if __name__ == "__main__":
    unittest.main()
