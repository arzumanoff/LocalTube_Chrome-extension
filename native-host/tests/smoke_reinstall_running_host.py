from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: smoke_reinstall_running_host.py <engine-dir> <installed-host>"
        )

    engine_dir = Path(sys.argv[1]).resolve()
    installed_host = Path(sys.argv[2]).resolve()
    installer = engine_dir / "install_host.ps1"
    if not installer.is_file():
        raise RuntimeError(f"installer not found: {installer}")
    if not installed_host.is_file():
        raise RuntimeError(f"installed host not found: {installed_host}")

    environment = os.environ.copy()
    process = subprocess.Popen(
        [str(installed_host)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    try:
        time.sleep(1.0)
        if process.poll() is not None:
            stderr = process.stderr.read().decode("utf-8", "replace") if process.stderr else ""
            raise RuntimeError(f"host exited before reinstall: {stderr}")

        completed = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(installer),
            ],
            cwd=engine_dir,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=120,
            check=False,
        )
        output = completed.stdout.decode("utf-8", "replace")
        if completed.returncode != 0:
            raise RuntimeError(
                f"reinstall failed with {completed.returncode}:\n{output}"
            )

        deadline = time.monotonic() + 10.0
        while process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.1)
        if process.poll() is None:
            raise RuntimeError("installer succeeded but old Native Host is still running")
        if not installed_host.is_file():
            raise RuntimeError("installed host disappeared after reinstall")

        print("reinstall with running Native Host passed")
        return 0
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()


if __name__ == "__main__":
    raise SystemExit(main())
