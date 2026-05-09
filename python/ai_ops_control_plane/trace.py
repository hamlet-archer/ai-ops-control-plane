"""UUIDv7 trace id — mirror src/trace.ts.

Pinned to `uuid-utils` (Rust-backed, supports `uuid7()` with per-process
monotonic guarantee). Mixing UUIDv7 implementations within a process
breaks monotonicity (no shared counter). Always import from this module.
"""

from __future__ import annotations

from uuid_utils import uuid7


def new_trace_id() -> str:
    """Generate a new trace id (UUIDv7 string, dashed, per-process monotonic)."""
    return str(uuid7())
