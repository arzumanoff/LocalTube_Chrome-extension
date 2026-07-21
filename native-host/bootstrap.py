from __future__ import annotations

import os
import sys
from pathlib import Path


def runtime_directory() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def configure_runtime_environment() -> Path:
    """Prepare the process before importing the Native Host.

    Chrome starts a Windows Native Messaging Host in the executable's folder,
    but PATH may not contain that folder. Prepending it lets yt-dlp discover the
    bundled FFmpeg, FFprobe and Deno binaries. Windows stdin/stdout are switched
    to binary mode so the 4-byte Native Messaging framing is not corrupted.
    """
    directory = runtime_directory()
    current_path = os.environ.get("PATH", "")
    entries = [entry for entry in current_path.split(os.pathsep) if entry]
    if str(directory).lower() not in {entry.lower() for entry in entries}:
        os.environ["PATH"] = str(directory) + (os.pathsep + current_path if current_path else "")

    if os.name == "nt":
        import msvcrt

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    return directory


def main() -> int:
    configure_runtime_environment()

    # Apply narrowly scoped fixes before host.py imports engine functions.
    from runtime_fixes import apply

    apply()
    from host import main as host_main

    return host_main()


if __name__ == "__main__":
    raise SystemExit(main())
