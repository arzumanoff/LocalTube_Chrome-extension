from __future__ import annotations

import json
import struct
import sys
import threading
from typing import Any, BinaryIO

MAX_MESSAGE_BYTES = 1024 * 1024


class ProtocolError(RuntimeError):
    pass


def read_message(stream: BinaryIO | None = None) -> dict[str, Any] | None:
    source = stream or sys.stdin.buffer
    header = source.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ProtocolError("incomplete native messaging header")
    (length,) = struct.unpack("<I", header)
    if length <= 0 or length > MAX_MESSAGE_BYTES:
        raise ProtocolError(f"invalid native messaging payload length: {length}")
    payload = source.read(length)
    if len(payload) != length:
        raise ProtocolError("incomplete native messaging payload")
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("invalid native messaging JSON") from exc
    if not isinstance(value, dict):
        raise ProtocolError("native messaging payload must be an object")
    return value


class MessageWriter:
    def __init__(self, stream: BinaryIO | None = None) -> None:
        self._stream = stream or sys.stdout.buffer
        self._lock = threading.Lock()

    def write(self, message: dict[str, Any]) -> None:
        data = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) > MAX_MESSAGE_BYTES:
            raise ProtocolError("native messaging response exceeds 1 MiB")
        packet = struct.pack("<I", len(data)) + data
        with self._lock:
            self._stream.write(packet)
            self._stream.flush()
