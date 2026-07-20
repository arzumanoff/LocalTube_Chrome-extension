from __future__ import annotations

import json
import struct
import subprocess
import sys
from pathlib import Path


def frame(message: dict[str, object]) -> bytes:
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(payload)) + payload


def parse_first_frame(output: bytes) -> dict[str, object]:
    if len(output) < 4:
        raise RuntimeError(f"host returned no complete frame: {output!r}")
    (size,) = struct.unpack("<I", output[:4])
    payload = output[4:4 + size]
    if len(payload) != size:
        raise RuntimeError(f"host returned truncated frame: expected {size}, got {len(payload)}")
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("host response must be an object")
    return value


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: smoke_built_host.py <host-executable>")
    executable = Path(sys.argv[1]).resolve()
    if not executable.is_file():
        raise RuntimeError(f"host executable not found: {executable}")

    request_id = "windows-build-smoke"
    completed = subprocess.run(
        [str(executable)],
        input=frame({"requestId": request_id, "action": "ping"}),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"host exited with {completed.returncode}; stderr={completed.stderr.decode('utf-8', 'replace')}"
        )
    response = parse_first_frame(completed.stdout)
    if response.get("requestId") != request_id or response.get("ok") is not True:
        raise RuntimeError(f"unexpected host response: {response!r}")
    print(f"Native Host ping passed: version={response.get('version')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
