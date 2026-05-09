"""Dedupe key — mirror src/dedupe.ts. Same SHA256 hex output for the same parts."""

from __future__ import annotations

import hashlib


def compute_dedupe_key(parts: list[str]) -> str:
    """Sender-scoped dedupe key. SHA256 hex of the parts joined by ':'.

    Convention from CLAUDE.md + ARCHITECTURE.md §6.6:
        compute_dedupe_key(["comms-adviser", staff_id, channel, thread_ref])
    The first part should be the sender agent id so two agents can't
    collide on the same natural key.
    """
    if not parts:
        raise ValueError("compute_dedupe_key: parts must be non-empty")
    return hashlib.sha256(":".join(parts).encode("utf-8")).hexdigest()
