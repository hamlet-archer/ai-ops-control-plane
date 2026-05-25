"""ControlPlane — mirror src/control-plane.ts.

Same SQLite file, same schema, same wire-level semantics. The Python
edition wraps stdlib sqlite3 (sync) in `async def` methods to mirror the
TypeScript Promise-shaped API. SQLite calls are microsecond-scale at
this load, so wrapping in asyncio.to_thread() is unnecessary.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .dedupe import compute_dedupe_key as _compute_dedupe_key  # noqa: F401
from .errors import (
    ContractViolationError,
    DomainRuleError,
    StorageError,
    UnknownAgentError,
)
from .trace import new_trace_id
from .types import (
    AgentRow,
    ContractRow,
    DomainRow,
    Handoff,
    HandoffStatus,
    Logger,
    RunStatus,
    SendHandoffResult,
    Severity,
    TriggeredBy,
    ValidatorMode,
)

SCHEMA_VERSION = 1
DEFAULT_PROD_PATH = "/var/lib/ai-ops/ops.db"

_DEFAULT_LOG = logging.getLogger("ai_ops_control_plane")


def _resolve_db_path(override: str | None) -> str:
    if override:
        return override
    env = os.environ.get("OPS_DB_PATH")
    if env:
        return env
    if Path(DEFAULT_PROD_PATH).exists():
        return DEFAULT_PROD_PATH
    return str(Path.home() / ".local" / "share" / "ai-ops" / "ops.db")


def _load_schema_sql() -> str:
    # Hatch ships ../src/schema.sql as ai_ops_control_plane/_schema.sql in
    # the wheel; in dev we read from the sibling src/ directly.
    here = Path(__file__).resolve().parent
    candidate = here / "_schema.sql"
    if candidate.exists():
        return candidate.read_text()
    dev_path = here.parent.parent / "src" / "schema.sql"
    return dev_path.read_text()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + (
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
    )


class _NoopLogger:
    def debug(self, _event: str, _fields: dict[str, Any] | None = None) -> None: ...
    def info(self, _event: str, _fields: dict[str, Any] | None = None) -> None: ...
    def warn(self, _event: str, _fields: dict[str, Any] | None = None) -> None: ...
    def error(self, _event: str, _fields: dict[str, Any] | None = None) -> None: ...


@dataclass
class StartRunArgs:
    triggered_by: TriggeredBy
    trace_id: str | None = None


@dataclass
class EmitArgs:
    kind: str
    severity: Severity
    run: RunHandle | None = None
    payload: Any = None
    occurred_at: datetime | None = None


@dataclass
class SendHandoffArgs:
    intent: str
    receiver: str
    payload: dict[str, Any]
    dedupe_key: str
    trace_id: str


@dataclass
class PollHandoffsArgs:
    receiver: str
    intents: list[str] | None = None
    limit: int = 10


@dataclass
class OpenOpts:
    agent_id: str
    db_path: str | None = None
    logger: Logger | None = None
    validator_mode: ValidatorMode = "enforce"
    bootstrap: dict[str, list[Any]] | None = None
    """Optional bootstrap UPSERT before the agent_id existence check.

    Shape: {"agents": [AgentRow, ...], "domains": [DomainRow, ...],
    "contracts": [ContractRow, ...]}. Production agents pass parsed
    agent-registry.yaml + contracts/. Tests pass synthetic rows."""


class RunHandle:
    def __init__(self, db: sqlite3.Connection, logger: Logger, trace_id: str) -> None:
        self._db = db
        self._logger = logger
        self.trace_id = trace_id
        self._items = 0
        self._handoffs = 0
        self._errors = 0
        self._cost = 0.0
        self._ended = False

    def bump_items(self, n: int = 1) -> None:
        self._items += n

    def bump_handoffs(self, n: int = 1) -> None:
        self._handoffs += n

    def bump_errors(self, n: int = 1) -> None:
        self._errors += n

    def add_cost(self, usd: float) -> None:
        self._cost += usd

    async def end(
        self,
        *,
        status: RunStatus,
        summary: str | None = None,
        error_summary: str | None = None,
    ) -> None:
        if status == "running":
            raise ValueError("end() status must be one of: done, error, timeout")
        if self._ended:
            return
        self._ended = True
        ended_at = _now_iso()
        try:
            self._db.execute(
                """UPDATE runs
                     SET ended_at = ?, status = ?, items_processed = ?, handoffs_emitted = ?,
                         errors = ?, cost_usd = ?, summary = ?, error_summary = ?,
                         duration_ms = (
                           CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
                         )
                   WHERE trace_id = ?""",
                (
                    ended_at,
                    status,
                    self._items,
                    self._handoffs,
                    self._errors,
                    round(self._cost, 6),
                    summary,
                    error_summary,
                    ended_at,
                    self.trace_id,
                ),
            )
            self._db.commit()
        except Exception as e:
            # N11: the prior `logger.warn` + swallow shape silently left
            # runs stuck at status='running' if the UPDATE failed for any
            # reason (db closed early by consumer, WAL contention, schema
            # drift). Log at ERROR with the cause and re-raise — callers
            # must handle. The consumer's `with_run` finally is the right
            # place to surface this through journald.
            self._logger.error(
                "runs_close_failed", {"trace_id": self.trace_id, "error": str(e)}
            )
            raise


class ControlPlane:
    def __init__(
        self,
        db: sqlite3.Connection,
        agent_id: str,
        logger: Logger,
        validator_mode: ValidatorMode,
    ) -> None:
        self._db = db
        self._agent_id = agent_id
        self._logger = logger
        self._validator_mode = validator_mode
        self._closed = False

    async def start_run(self, args: StartRunArgs) -> RunHandle:
        trace_id = args.trace_id or new_trace_id()
        started_at = _now_iso()
        try:
            self._db.execute(
                """INSERT INTO runs (trace_id, agent_id, triggered_by, status, started_at)
                   VALUES (?, ?, ?, 'running', ?)""",
                (trace_id, self._agent_id, args.triggered_by, started_at),
            )
            self._db.commit()
        except Exception as e:
            # openRun must never crash the caller — log + return a no-op handle.
            self._logger.warn(
                "runs_open_failed", {"trace_id": trace_id, "error": str(e)}
            )
        return RunHandle(self._db, self._logger, trace_id)

    async def emit(self, args: EmitArgs) -> None:
        occurred_at = (
            args.occurred_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[
                :-3
            ]
            + "Z"
            if args.occurred_at
            else _now_iso()
        )
        trace_id = args.run.trace_id if args.run else "orphan"
        self._logger.info(
            "event",
            {"trace_id": trace_id, "kind": args.kind, "severity": args.severity},
        )
        try:
            self._db.execute(
                """INSERT INTO events
                     (kind, agent_id, severity, payload_json, run_trace_id, trace_id, occurred_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    args.kind,
                    self._agent_id,
                    args.severity,
                    None if args.payload is None else json.dumps(args.payload),
                    args.run.trace_id if args.run else None,
                    trace_id,
                    occurred_at,
                ),
            )
            self._db.commit()
        except Exception as e:
            self._logger.warn(
                "event_emit_failed",
                {"trace_id": trace_id, "kind": args.kind, "error": str(e)},
            )

    async def send_handoff(self, args: SendHandoffArgs) -> SendHandoffResult:
        self._assert_receiver_accepts(args.receiver, args.intent)
        self._validate_or_throw(args.intent, args.payload)
        created_at = _now_iso()
        try:
            cur = self._db.execute(
                """INSERT INTO handoffs
                     (intent, sender_id, receiver_id, payload_json, dedupe_key, trace_id, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
                   ON CONFLICT(dedupe_key) DO NOTHING""",
                (
                    args.intent,
                    self._agent_id,
                    args.receiver,
                    json.dumps(args.payload),
                    args.dedupe_key,
                    args.trace_id,
                    created_at,
                ),
            )
            self._db.commit()
            if cur.rowcount == 0:
                row = self._db.execute(
                    "SELECT id FROM handoffs WHERE dedupe_key = ?",
                    (args.dedupe_key,),
                ).fetchone()
                if not row:
                    raise StorageError(
                        "dedupe_key conflict but row missing — schema corruption?"
                    )
                return SendHandoffResult(id=int(row[0]), deduped=True)
            return SendHandoffResult(id=int(cur.lastrowid or 0), deduped=False)
        except StorageError:
            raise
        except Exception as e:
            raise StorageError("send_handoff failed", e) from e

    async def poll_handoffs(self, args: PollHandoffsArgs) -> list[Handoff]:
        limit = args.limit
        intents = args.intents if args.intents else None
        try:
            if intents:
                placeholders = ",".join("?" * len(intents))
                rows = self._db.execute(
                    f"""SELECT id, intent, sender_id, receiver_id, payload_json, dedupe_key,
                              trace_id, status, attempt_count, created_at, picked_up_at
                       FROM handoffs
                       WHERE receiver_id = ? AND status = 'pending' AND intent IN ({placeholders})
                       ORDER BY id ASC
                       LIMIT ?""",
                    (args.receiver, *intents, limit),
                ).fetchall()
            else:
                rows = self._db.execute(
                    """SELECT id, intent, sender_id, receiver_id, payload_json, dedupe_key,
                              trace_id, status, attempt_count, created_at, picked_up_at
                       FROM handoffs
                       WHERE receiver_id = ? AND status = 'pending'
                       ORDER BY id ASC
                       LIMIT ?""",
                    (args.receiver, limit),
                ).fetchall()
        except Exception as e:
            raise StorageError("poll_handoffs failed", e) from e

        out: list[Handoff] = []
        for r in rows:
            payload = _safe_json(r[4])
            self._validate_or_throw(r[1], payload)
            out.append(
                Handoff(
                    id=int(r[0]),
                    intent=r[1],
                    sender_id=r[2],
                    receiver_id=r[3],
                    payload=payload,
                    dedupe_key=r[5],
                    trace_id=r[6],
                    status=r[7],
                    attempt_count=int(r[8]),
                    created_at=r[9],
                    picked_up_at=r[10],
                )
            )
        return out

    async def ack_handoff(
        self,
        handoff_id: int,
        status: HandoffStatus,
        error_summary: str | None = None,
    ) -> None:
        if status not in ("done", "failed", "rejected"):
            raise ValueError("ack_handoff status must be one of: done, failed, rejected")
        try:
            self._db.execute(
                """UPDATE handoffs
                     SET status = ?, completed_at = ?, error_summary = ?
                   WHERE id = ?""",
                (status, _now_iso(), error_summary, handoff_id),
            )
            self._db.commit()
        except Exception as e:
            self._logger.warn(
                "ack_handoff_failed", {"handoff_id": handoff_id, "error": str(e)}
            )

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            # Flush the WAL to the main DB file before close. Without
            # this, a process that exits immediately after close() can
            # leave durable writes only in the WAL — a separate reader
            # would see status='running' until lazy WAL replay. N11
            # root-causes 265 such orphans to this.
            self._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self._db.close()
        except Exception as e:
            self._logger.warn("close_failed", {"error": str(e)})

    # --- internals ---

    def _assert_receiver_accepts(self, receiver: str, intent: str) -> None:
        # v0.1: agents.accepted_intents not yet stored in DB. Receiver
        # existence check only. Same TODO as the TS edition.
        row = self._db.execute(
            "SELECT id FROM agents WHERE id = ?", (receiver,)
        ).fetchone()
        if not row:
            raise DomainRuleError(receiver, intent)

    def _validate_or_throw(self, intent: str, payload: Any) -> None:
        # v0.1: contracts table is empty until step 9 publishes
        # ai-ops-contracts. Until then, validation is a no-op.
        row = self._db.execute(
            "SELECT schema_json FROM contracts WHERE id = ?", (intent,)
        ).fetchone()
        if not row:
            return
        # Schema validation hookup deferred — would import jsonschema.
        del row, payload  # unused in stub
        if self._validator_mode == "enforce":
            raise ContractViolationError(
                intent, ["validator not yet wired (v0.1 stub)"]
            )


# --- module-level entry point ---


async def open(opts: OpenOpts) -> ControlPlane:  # noqa: A001 — mirrors TS API
    db_path = _resolve_db_path(opts.db_path)
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    db = sqlite3.connect(db_path, isolation_level=None, check_same_thread=False)
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 5000")

    _apply_schema(db)
    if opts.bootstrap:
        _upsert_bootstrap(db, opts.bootstrap)

    exists = db.execute(
        "SELECT id FROM agents WHERE id = ?", (opts.agent_id,)
    ).fetchone()
    any_agent = db.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
    if not exists and any_agent > 0:
        raise UnknownAgentError(opts.agent_id)

    return ControlPlane(
        db=db,
        agent_id=opts.agent_id,
        logger=opts.logger or _NoopLogger(),
        validator_mode=opts.validator_mode,
    )


def _apply_schema(db: sqlite3.Connection) -> None:
    db.executescript(_load_schema_sql())
    row = db.execute(
        "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
    ).fetchone()
    if not row:
        db.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
            (SCHEMA_VERSION, _now_iso()),
        )
        db.commit()


def _upsert_bootstrap(db: sqlite3.Connection, b: dict[str, list[Any]]) -> None:
    now = _now_iso()
    for a in b.get("agents") or []:
        if not isinstance(a, AgentRow):
            raise TypeError(f"bootstrap.agents must contain AgentRow instances, got {type(a)}")
        db.execute(
            """INSERT INTO agents (id, name, status, blast_radius, notion_page_id, repo_url, synced_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 status = excluded.status,
                 blast_radius = excluded.blast_radius,
                 notion_page_id = excluded.notion_page_id,
                 repo_url = excluded.repo_url,
                 synced_at = excluded.synced_at""",
            (a.id, a.name, a.status, a.blast_radius, a.notion_page_id, a.repo_url, now),
        )
    for d in b.get("domains") or []:
        if not isinstance(d, DomainRow):
            raise TypeError(f"bootstrap.domains must contain DomainRow instances, got {type(d)}")
        db.execute(
            """INSERT INTO domains (id, owner_agent_id, notion_page_id, synced_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 owner_agent_id = excluded.owner_agent_id,
                 notion_page_id = excluded.notion_page_id,
                 synced_at = excluded.synced_at""",
            (d.id, d.owner_agent_id, d.notion_page_id, now),
        )
    for c in b.get("contracts") or []:
        if not isinstance(c, ContractRow):
            raise TypeError(f"bootstrap.contracts must contain ContractRow instances, got {type(c)}")
        db.execute(
            """INSERT INTO contracts (id, status, schema_json, notion_page_id, synced_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 status = excluded.status,
                 schema_json = excluded.schema_json,
                 notion_page_id = excluded.notion_page_id,
                 synced_at = excluded.synced_at""",
            (c.id, c.status, c.schema_json, c.notion_page_id, now),
        )
    db.commit()


def _safe_json(s: str) -> Any:
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return None
