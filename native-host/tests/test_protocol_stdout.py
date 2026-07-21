from __future__ import annotations

import json
import struct
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class NativeStdoutIsolationTests(unittest.TestCase):
    def test_accidental_print_does_not_corrupt_native_message(self) -> None:
        script = textwrap.dedent(
            f"""
            import sys
            sys.path.insert(0, {str(ROOT)!r})
            from protocol import MessageWriter, reserve_native_stdout

            protocol_stream = reserve_native_stdout()
            writer = MessageWriter(protocol_stream)
            print('library noise on stdout', flush=True)
            writer.write({{'ok': True, 'stage': 'downloading'}})
            """
        )
        completed = subprocess.run(
            [sys.executable, "-c", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", errors="replace"))
        self.assertGreaterEqual(len(completed.stdout), 4)
        (length,) = struct.unpack("<I", completed.stdout[:4])
        payload = completed.stdout[4:]
        self.assertEqual(len(payload), length)
        self.assertEqual(json.loads(payload.decode("utf-8")), {"ok": True, "stage": "downloading"})
        self.assertIn(b"library noise on stdout", completed.stderr)


if __name__ == "__main__":
    unittest.main()
