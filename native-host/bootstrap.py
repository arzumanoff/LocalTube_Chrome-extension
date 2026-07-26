from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Sequence


def runtime_directory() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def configure_runtime_path() -> Path:
    directory = runtime_directory()
    current_path = os.environ.get("PATH", "")
    entries = [entry for entry in current_path.split(os.pathsep) if entry]
    if str(directory).lower() not in {entry.lower() for entry in entries}:
        os.environ["PATH"] = str(directory) + (os.pathsep + current_path if current_path else "")
    return directory


def configure_native_stdio() -> None:
    if os.name != "nt":
        return
    import msvcrt

    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def configure_runtime_environment() -> Path:
    """Prepare PATH and Native Messaging binary stdio."""
    directory = configure_runtime_path()
    configure_native_stdio()
    return directory


def _ffmpeg_path(directory: Path) -> Path:
    override = os.environ.get("MEDIA_ENGINE_FFMPEG", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    bundled = directory / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if bundled.exists():
        return bundled
    return Path("ffmpeg.exe" if os.name == "nt" else "ffmpeg")


def is_chrome_native_messaging_arg(arg: str) -> bool:
    return arg.startswith("chrome-extension://") or arg.startswith("--parent-window=")


def run_maintenance_command(args: Sequence[str], directory: Path) -> int | None:
    if list(args) != ["--detect-hardware"]:
        return None

    from hardware_profile import detect_and_store, profile_path

    ffmpeg = _ffmpeg_path(directory)
    destination = profile_path(ffmpeg)
    payload = detect_and_store(ffmpeg, destination)
    # Machine-readable maintenance output must be safe even when Windows starts
    # the console process with a legacy code page such as cp1252. JSON escapes
    # preserve the original Unicode value for PowerShell ConvertFrom-Json.
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), flush=True)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    directory = configure_runtime_path()

    cli_args = [arg for arg in args if not is_chrome_native_messaging_arg(arg)]

    maintenance_result = run_maintenance_command(cli_args, directory)
    if maintenance_result is not None:
        return maintenance_result
    if cli_args:
        print(f"Unknown command: {' '.join(cli_args)}", file=sys.stderr)
        return 2

    configure_native_stdio()

    # Apply narrowly scoped fixes before host.py imports engine functions.
    from runtime_fixes import apply

    apply()
    from host import main as host_main

    return host_main()


if __name__ == "__main__":
    raise SystemExit(main())
