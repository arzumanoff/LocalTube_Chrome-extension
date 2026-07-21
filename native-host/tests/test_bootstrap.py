from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import bootstrap  # noqa: E402


class BootstrapTests(unittest.TestCase):
    def test_adds_runtime_directory_to_path(self) -> None:
        previous = os.environ.get("PATH")
        os.environ["PATH"] = ""
        try:
            directory = bootstrap.configure_runtime_path()
            self.assertEqual(os.environ["PATH"].split(os.pathsep)[0], str(directory))
        finally:
            if previous is None:
                os.environ.pop("PATH", None)
            else:
                os.environ["PATH"] = previous

    def test_detect_hardware_command_does_not_enter_native_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory_text:
            directory = Path(directory_text)
            ffmpeg = directory / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
            ffmpeg.write_bytes(b"fake")
            payload = {
                "schemaVersion": 1,
                "encoderKey": "software-x264",
                "ffmpegEncoder": "libx264",
                "displayName": "Процессор (libx264)",
                "hardware": False,
                "status": "verified",
                "testedAt": "2026-07-21T12:00:00Z",
                "ffmpegFingerprint": "sha256:" + "0" * 64,
            }
            output = io.StringIO()
            with patch("hardware_profile.detect_and_store", return_value=payload) as detect, patch.object(
                bootstrap, "configure_native_stdio"
            ) as native_stdio, redirect_stdout(output):
                result = bootstrap.run_maintenance_command(["--detect-hardware"], directory)

            self.assertEqual(result, 0)
            native_stdio.assert_not_called()
            detect.assert_called_once()
            self.assertIn('"encoderKey":"software-x264"', output.getvalue())

    def test_unknown_command_returns_nonzero_without_native_host(self) -> None:
        with patch.object(bootstrap, "configure_native_stdio") as native_stdio:
            result = bootstrap.main(["--unknown"])
        self.assertEqual(result, 2)
        native_stdio.assert_not_called()


if __name__ == "__main__":
    unittest.main()
