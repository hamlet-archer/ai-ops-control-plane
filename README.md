# @hamlet-archer/ai-ops-control-plane

SQLite-backed control plane for the AI Ops fleet. Replaces Notion-as-bus
for runs, events, handoffs, and incidents. Each agent links this library
to write through to one shared `ops.db`; a projector daemon mirrors that
state to Notion for human-readable views.

**Source-of-truth design:** [`ai-ops-meta` `briefs/control-plane-design.md`](https://github.com/hamlet-archer/ai-ops-meta/blob/main/briefs/control-plane-design.md).

This is **v0.1** — schema + client API + tests. The Notion projector,
contract validation hookup, and per-agent migrations ship as separate
Outcome 7 backlog items in `ai-ops-meta`.

## Status

| Piece | State |
|---|---|
| SQL schema (runs/events/handoffs/incidents/agents/domains/contracts) | ✓ implemented |
| `ControlPlane` class — `startRun` / `emit` / `sendHandoff` / `pollHandoffs` / `ackHandoff` / `close` | ✓ implemented |
| `RunHandle` — `bumpItems` / `bumpHandoffs` / `bumpErrors` / `addCost` / `end` | ✓ implemented |
| UUIDv7 monotonic trace ids (`uuidv7@^1.0`) | ✓ implemented |
| `computeDedupeKey` (SHA256 hex of sender-scoped parts) | ✓ implemented |
| Boot-time agent existence guard (`UnknownAgentError`) | ✓ implemented (with first-boot escape hatch) |
| Bootstrap UPSERT for agents/domains/contracts from registry | ✓ implemented |
| Contract validation against `ai-ops-contracts` schemas | ⚠ stubbed — wires up when the package publishes (backlog step 9) |
| Receiver-accepts-intent enforcement | ⚠ stubbed — schema needs an `agents.accepted_intents` column (follow-on PR) |

## Install

```bash
npm install @hamlet-archer/ai-ops-control-plane
```

Native dependency: `better-sqlite3` builds against your local Node ABI.
Node 20+ required.

## Usage

```ts
import {
  open,
  newTraceId,
  computeDedupeKey,
} from "@hamlet-archer/ai-ops-control-plane";

const cp = await open({
  agentId: "task-doer",
  // dbPath defaults to:
  //   process.env.OPS_DB_PATH, then
  //   /var/lib/ai-ops/ops.db if it exists, then
  //   ~/.local/share/ai-ops/ops.db
  validatorMode: "warn", // 'enforce' (default) once schemas are wired
  bootstrap: {
    agents: [
      // Parsed from agent-registry.yaml at boot — production agents wire
      // this through their adapter; tests pass synthetic rows.
      { id: "task-doer", name: "Task Doer", status: "active",
        blastRadius: "external-write", notionPageId: null, repoUrl: null },
      { id: "chief-of-staff", name: "Chief of Staff", status: "active",
        blastRadius: "external-write", notionPageId: null, repoUrl: null },
    ],
  },
});

// One run per invocation.
const run = await cp.startRun({ triggeredBy: "cron" });
try {
  // ...do work...
  run.bumpItems(1);
  await cp.emit({
    run,
    kind: "task.classified",
    severity: "info",
    payload: { taskId: "abc" },
  });

  // Hand off to another agent.
  await cp.sendHandoff({
    intent: "tasks.append_note.v1",
    receiver: "chief-of-staff",
    payload: { taskId: "abc", note: "draft created" },
    dedupeKey: computeDedupeKey(["task-doer", "abc", "append-note"]),
    traceId: run.traceId,
  });
  run.bumpHandoffs(1);

  await run.end({ status: "done" });
} catch (err) {
  run.bumpErrors(1);
  await run.end({ status: "failed", errorSummary: String(err) });
} finally {
  await cp.close();
}
```

### Receiving handoffs (in-process dispatcher)

```ts
const cp = await open({ agentId: "chief-of-staff", /* ... */ });

setInterval(async () => {
  const batch = await cp.pollHandoffs({
    receiver: "chief-of-staff",
    intents: ["tasks.append_note.v1", "comms.draft_reply.v1"],
    limit: 10,
  });
  for (const handoff of batch) {
    try {
      await handle(handoff);
      await cp.ackHandoff(handoff.id, "done");
    } catch (err) {
      await cp.ackHandoff(handoff.id, "failed", String(err));
    }
  }
}, 1000);
```

## Error model

| Error | Raised by | Meaning |
|---|---|---|
| `ContractViolationError` | `sendHandoff` (enforce mode), `pollHandoffs` (always) | Payload doesn't match the schema registered for `intent`. Poison-pill on inbound. |
| `DomainRuleError` | `sendHandoff` | Receiver doesn't accept the intent (or doesn't exist in the agents table). |
| `StorageError` | `sendHandoff`, `pollHandoffs` | SQLite hiccup. `startRun` / `emit` / `ackHandoff` log + swallow instead. |
| `UnknownAgentError` | `open()` | `agentId` not in agents table after bootstrap. |

Observability methods (`startRun`, `emit`, `ackHandoff`) **never throw** —
they log via the supplied `Logger` and return. Mutation methods
(`sendHandoff`, `pollHandoffs`) propagate errors; the caller decides what
to do.

## SQLite path resolution

1. `dbPath` argument to `open()` if provided.
2. `OPS_DB_PATH` env var if set (used by tests + dev).
3. `/var/lib/ai-ops/ops.db` if it exists (production on `golden-ai-ops`).
4. `~/.local/share/ai-ops/ops.db` otherwise (auto-created with parent dir).

The lib opens the file with WAL mode + `foreign_keys = ON` and applies
the schema idempotently on every boot.

## Schema

See [`src/schema.sql`](src/schema.sql). The file is the source of truth;
the brief documents PK/FK choices and retention policy.

## Trace ids

`newTraceId()` returns a UUIDv7. The `uuidv7` package gives a per-process
monotonic counter — strictly increasing within a single process even
inside the same millisecond. **Always import from this module**, not
from another UUIDv7 implementation; mixing libraries within a process
breaks monotonicity (no shared counter).

## License

UNLICENSED — internal Hamlet Archer use. Will be reviewed before any public release.
