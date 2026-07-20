from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bootstrap import configure_runtime_environment  # noqa: E402


class BootstrapTests(unittest.TestCase):
    def test_adds_runtime_directory_to_path(self) -> None:
        previous = os.environ.get("PATH")
        os.environ["PATH"] = ""
        try:
            directory = configure_runtime_environment()
            self.assertEqual(os.environ["PATH"].split(os.pathsep)[0], str(directory))
        finally:
            if previous is None:
                os.environ.pop("PATH", None)
            else:
                os.environ["PATH"] = previous


if __name__ == "__main__":
    unittest.main()
