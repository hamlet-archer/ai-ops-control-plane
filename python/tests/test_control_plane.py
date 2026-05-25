"""Mirrors tests/control-plane.test.ts. Same coverage, same dedupe + boot guards.

Plus one cross-edition test: a TypeScript-style row inserted from Python
must be readable by Python (and, by symmetry, the TS edition — verified
out-of-band; this file just asserts schema parity from the Python side).
"""

from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

import pytest

from ai_ops_control_plane import (
    AgentRow,
    DomainRuleError,
    EmitArgs,
    OpenOpts,
    PollHandoffsArgs,
    SendHandoffArgs,
    StartRunArgs,
    UnknownAgentError,
    compute_dedupe_key,
    new_trace_id,
    open_control_plane,
)

TEST_AGENT = AgentRow(
    id="test-agent",
    name="Test Agent",
    status="active",
    blast_radius="internal",
)

PEER_AGENT = AgentRow(
    id="peer-agent",
    name="Peer Agent",
    status="active",
    blast_radius="internal",
)


@pytest.fixture
def tmp_db():
    with tempfile.TemporaryDirectory() as tmp:
        yield str(Path(tmp) / "ops.db")


@pytest.fixture
async def cp(tmp_db):
    cp = await open_control_plane(
        OpenOpts(
            agent_id=TEST_AGENT.id,
            db_path=tmp_db,
            validator_mode="warn",
            bootstrap={"agents": [TEST_AGENT, PEER_AGENT]},
        )
    )
    yield cp
    await cp.close()


def _inspect(db_path: str) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)


async def test_start_run_bump_items_end_writes_runs_row(cp, tmp_db):
    run = await cp.start_run(StartRunArgs(triggered_by="manual"))
    assert run.trace_id
    run.bump_items(3)
    run.bump_handoffs(1)
    run.add_cost(0.0042)
    await run.end(status="done", summary="all good")

    row = _inspect(tmp_db).execute(
        "SELECT status, items_processed, handoffs_emitted, cost_usd, summary FROM runs WHERE trace_id = ?",
        (run.trace_id,),
    ).fetchone()
    assert row[0] == "done"
    assert row[1] == 3
    assert row[2] == 1
    assert abs(row[3] - 0.0042) < 1e-6
    assert row[4] == "all good"


async def test_emit_writes_event_row_tied_by_trace_id(cp, tmp_db):
    run = await cp.start_run(StartRunArgs(triggered_by="cron"))
    await cp.emit(EmitArgs(run=run, kind="test.fired", severity="info", payload={"foo": "bar"}))
    await run.end(status="done")

    row = _inspect(tmp_db).execute(
        "SELECT kind, severity, payload_json, trace_id FROM events WHERE trace_id = ?",
        (run.trace_id,),
    ).fetchone()
    assert row[0] == "test.fired"
    assert row[1] == "info"
    import json
    assert json.loads(row[2]) == {"foo": "bar"}
    assert row[3] == run.trace_id


async def test_send_handoff_dedupe_blocks_duplicate(cp):
    trace_id = new_trace_id()
    dedupe_key = compute_dedupe_key([TEST_AGENT.id, "task-1", "v1"])
    r1 = await cp.send_handoff(
        SendHandoffArgs(
            intent="tasks.create_task.v2",
            receiver=PEER_AGENT.id,
            payload={"title": "Hello"},
            dedupe_key=dedupe_key,
            trace_id=trace_id,
        )
    )
    r2 = await cp.send_handoff(
        SendHandoffArgs(
            intent="tasks.create_task.v2",
            receiver=PEER_AGENT.id,
            payload={"title": "Hello"},
            dedupe_key=dedupe_key,
            trace_id=trace_id,
        )
    )
    assert r1.deduped is False
    assert r2.deduped is True
    assert r1.id == r2.id


async def test_poll_handoffs_returns_pending_in_id_order(cp, tmp_db):
    trace_id = new_trace_id()
    await cp.send_handoff(
        SendHandoffArgs(
            intent="tasks.create_task.v2",
            receiver=PEER_AGENT.id,
            payload={"title": "first"},
            dedupe_key=compute_dedupe_key([TEST_AGENT.id, "first"]),
            trace_id=trace_id,
        )
    )
    await cp.send_handoff(
        SendHandoffArgs(
            intent="tasks.create_task.v2",
            receiver=PEER_AGENT.id,
            payload={"title": "second"},
            dedupe_key=compute_dedupe_key([TEST_AGENT.id, "second"]),
            trace_id=trace_id,
        )
    )

    peer_cp = await open_control_plane(
        OpenOpts(agent_id=PEER_AGENT.id, db_path=tmp_db, validator_mode="warn")
    )
    handoffs = await peer_cp.poll_handoffs(PollHandoffsArgs(receiver=PEER_AGENT.id))
    assert len(handoffs) == 2
    assert handoffs[0].payload == {"title": "first"}
    assert handoffs[1].payload == {"title": "second"}
    assert handoffs[0].trace_id == trace_id
    await peer_cp.close()


async def test_ack_handoff_flips_out_of_pending(cp):
    trace_id = new_trace_id()
    res = await cp.send_handoff(
        SendHandoffArgs(
            intent="tasks.create_task.v2",
            receiver=PEER_AGENT.id,
            payload={"title": "a"},
            dedupe_key=compute_dedupe_key([TEST_AGENT.id, "a"]),
            trace_id=trace_id,
        )
    )
    await cp.ack_handoff(res.id, "done")
    handoffs = await cp.poll_handoffs(PollHandoffsArgs(receiver=PEER_AGENT.id))
    assert handoffs == []


async def test_send_handoff_to_unknown_receiver_raises_domain_rule_error(cp):
    with pytest.raises(DomainRuleError):
        await cp.send_handoff(
            SendHandoffArgs(
                intent="tasks.create_task.v2",
                receiver="ghost-agent",
                payload={},
                dedupe_key=compute_dedupe_key([TEST_AGENT.id, "ghost"]),
                trace_id=new_trace_id(),
            )
        )


async def test_first_boot_with_empty_agents_table_allowed(tmp_db):
    cp = await open_control_plane(OpenOpts(agent_id="anyone", db_path=tmp_db))
    await cp.close()


async def test_second_boot_unknown_agent_raises(tmp_db):
    cp1 = await open_control_plane(
        OpenOpts(
            agent_id=TEST_AGENT.id,
            db_path=tmp_db,
            bootstrap={"agents": [TEST_AGENT]},
        )
    )
    await cp1.close()
    with pytest.raises(UnknownAgentError):
        await open_control_plane(OpenOpts(agent_id="ghost", db_path=tmp_db))


async def test_uuidv7_two_consecutive_sort_lexically():
    a = new_trace_id()
    b = new_trace_id()
    assert b > a


async def test_uuidv7_100_consecutive_strictly_increasing():
    ids = [new_trace_id() for _ in range(100)]
    for i in range(1, len(ids)):
        assert ids[i] > ids[i - 1]


async def test_compute_dedupe_key_is_sha256_hex():
    k = compute_dedupe_key(["a", "b", "c"])
    assert len(k) == 64
    assert all(c in "0123456789abcdef" for c in k)


async def test_compute_dedupe_key_deterministic():
    assert compute_dedupe_key(["x", "y"]) == compute_dedupe_key(["x", "y"])


async def test_compute_dedupe_key_part_order_matters():
    assert compute_dedupe_key(["x", "y"]) != compute_dedupe_key(["y", "x"])


async def test_compute_dedupe_key_empty_raises():
    with pytest.raises(ValueError):
        compute_dedupe_key([])


async def test_round_trip_writes_runs_events_handoffs(cp, tmp_db):
    run = await cp.start_run(StartRunArgs(triggered_by="handoff"))
    run.bump_items(2)
    await cp.emit(EmitArgs(run=run, kind="round.trip.start", severity="info"))
    await cp.send_handoff(
        SendHandoffArgs(
            intent="tasks.create_task.v2",
            receiver=PEER_AGENT.id,
            payload={"title": "round-trip"},
            dedupe_key=compute_dedupe_key([TEST_AGENT.id, "round-trip"]),
            trace_id=run.trace_id,
        )
    )
    await cp.emit(EmitArgs(run=run, kind="round.trip.end", severity="info"))
    await run.end(status="done", summary="ok")

    inspect = _inspect(tmp_db)
    run_row = inspect.execute("SELECT status FROM runs WHERE trace_id = ?", (run.trace_id,)).fetchone()
    event_count = inspect.execute("SELECT COUNT(*) FROM events WHERE trace_id = ?", (run.trace_id,)).fetchone()[0]
    handoff_row = inspect.execute(
        "SELECT intent, notion_page_id FROM handoffs WHERE trace_id = ?", (run.trace_id,)
    ).fetchone()
    projector_unprojected = inspect.execute("SELECT COUNT(*) FROM events WHERE notion_page_id IS NULL").fetchone()[0]

    assert run_row[0] == "done"
    assert event_count == 2
    assert handoff_row[0] == "tasks.create_task.v2"
    assert handoff_row[1] is None  # projector hasn't run
    assert projector_unprojected >= 2


async def test_run_end_rethrows_on_update_failure(tmp_db):
    """N11: models the ai-comms-adviser `draft-replies.ts:80-83` shape —
    a consumer closes ops.db inside its own finally before with_run can
    write the final UPDATE. Pre-N11 this was warn-and-swallow leaving
    runs stuck at status='running'. Post-N11 it raises so the consumer's
    finally chain surfaces it through journald."""
    cp = await open_control_plane(
        OpenOpts(
            agent_id=TEST_AGENT.id,
            db_path=tmp_db,
            bootstrap={"agents": [TEST_AGENT]},
        )
    )
    run = await cp.start_run(StartRunArgs(triggered_by="manual"))
    # Simulate the bug: close the underlying handle before run.end() runs
    # its UPDATE. The .end() call must raise so a finally chain can surface it.
    await cp.close()
    with pytest.raises(sqlite3.ProgrammingError):
        await run.end(status="done")


async def test_subprocess_close_then_fresh_reader_sees_status_done(tmp_db):
    """N11: without `wal_checkpoint(TRUNCATE)` before close(), a process
    that exits immediately after close() can leave the final UPDATE only
    in the WAL — a separate reader sees status='running' until lazy
    replay. Spawn a Python child, end + close + exit, then read from
    the parent and assert status='done'."""
    import subprocess
    import sys
    import textwrap

    script = textwrap.dedent(
        f"""
        import asyncio, sys
        from ai_ops_control_plane import (
            AgentRow, OpenOpts, StartRunArgs, open_control_plane,
        )

        async def main():
            cp = await open_control_plane(
                OpenOpts(
                    agent_id="child-agent",
                    db_path={tmp_db!r},
                    bootstrap={{"agents": [AgentRow(
                        id="child-agent", name="Child",
                        status="active", blast_radius="internal",
                    )]}},
                )
            )
            run = await cp.start_run(StartRunArgs(triggered_by="manual"))
            print(run.trace_id)
            await run.end(status="done", summary="child done")
            await cp.close()

        asyncio.run(main())
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"child failed: {result.stderr}"
    trace_id = result.stdout.strip().splitlines()[-1]
    assert trace_id, f"no trace_id printed: {result.stdout!r}"

    # Fresh reader, separate connection, after the child has exited.
    # Without the wal_checkpoint fix in close(), this would see 'running'.
    row = _inspect(tmp_db).execute(
        "SELECT status FROM runs WHERE trace_id = ?", (trace_id,)
    ).fetchone()
    assert row is not None
    assert row[0] == "done"


async def test_schema_parity_with_typescript_edition(tmp_db):
    """The Python edition writes the same schema as the TS edition. A TS
    client opening this file would read the same tables/columns. We don't
    spawn TS here (CI does that separately), but we assert the schema
    matches what src/schema.sql declares."""
    cp = await open_control_plane(OpenOpts(agent_id="ignored", db_path=tmp_db))
    await cp.close()
    inspect = _inspect(tmp_db)
    tables = {
        r[0]
        for r in inspect.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    }
    expected = {
        "agents",
        "contracts",
        "domains",
        "events",
        "handoffs",
        "incidents",
        "runs",
        "schema_version",
    }
    assert expected.issubset(tables)
