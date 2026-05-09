import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  open,
  newTraceId,
  computeDedupeKey,
  DomainRuleError,
  UnknownAgentError,
  type AgentRow,
  type ControlPlane,
} from "../src/index.js";

const TEST_AGENT: AgentRow = {
  id: "test-agent",
  name: "Test Agent",
  status: "active",
  blastRadius: "internal",
  notionPageId: null,
  repoUrl: null,
};

const PEER_AGENT: AgentRow = {
  id: "peer-agent",
  name: "Peer Agent",
  status: "active",
  blastRadius: "internal",
  notionPageId: null,
  repoUrl: null,
};

describe("ControlPlane v0.1", () => {
  let tmp: string;
  let dbPath: string;
  let cp: ControlPlane;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cp-test-"));
    dbPath = join(tmp, "ops.db");
    cp = await open({
      agentId: TEST_AGENT.id,
      dbPath,
      validatorMode: "warn",
      bootstrap: { agents: [TEST_AGENT, PEER_AGENT] },
    });
  });

  afterEach(async () => {
    await cp.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("startRun → bumpItems → end writes a Runs row with the right counters", async () => {
    const run = await cp.startRun({ triggeredBy: "manual" });
    expect(run.traceId).toBeTruthy();
    run.bumpItems(3);
    run.bumpHandoffs(1);
    run.addCost(0.0042);
    await run.end({ status: "done", summary: "all good" });

    const row = (await openInspect(dbPath))
      .prepare(`SELECT status, items_processed, handoffs_emitted, cost_usd, summary FROM runs WHERE trace_id = ?`)
      .get(run.traceId) as {
      status: string;
      items_processed: number;
      handoffs_emitted: number;
      cost_usd: number;
      summary: string;
    };
    expect(row.status).toBe("done");
    expect(row.items_processed).toBe(3);
    expect(row.handoffs_emitted).toBe(1);
    expect(row.cost_usd).toBeCloseTo(0.0042, 6);
    expect(row.summary).toBe("all good");
  });

  it("emit writes an Events row tied to the run by trace_id", async () => {
    const run = await cp.startRun({ triggeredBy: "cron" });
    await cp.emit({
      run,
      kind: "test.fired",
      severity: "info",
      payload: { foo: "bar" },
    });
    await run.end({ status: "done" });

    const row = (await openInspect(dbPath))
      .prepare(`SELECT kind, severity, payload_json, trace_id FROM events WHERE trace_id = ?`)
      .get(run.traceId) as { kind: string; severity: string; payload_json: string; trace_id: string };
    expect(row.kind).toBe("test.fired");
    expect(row.severity).toBe("info");
    expect(JSON.parse(row.payload_json)).toEqual({ foo: "bar" });
    expect(row.trace_id).toBe(run.traceId);
  });

  it("sendHandoff inserts a row and dedupe_key blocks duplicate inserts", async () => {
    const traceId = newTraceId();
    const dedupeKey = computeDedupeKey([TEST_AGENT.id, "task-1", "v1"]);
    const r1 = await cp.sendHandoff({
      intent: "tasks.create_task.v2",
      receiver: PEER_AGENT.id,
      payload: { title: "Hello" },
      dedupeKey,
      traceId,
    });
    const r2 = await cp.sendHandoff({
      intent: "tasks.create_task.v2",
      receiver: PEER_AGENT.id,
      payload: { title: "Hello" },
      dedupeKey,
      traceId,
    });
    expect(r1.deduped).toBe(false);
    expect(r2.deduped).toBe(true);
    expect(r2.id).toBe(r1.id);
  });

  it("pollHandoffs returns pending rows for the given receiver in id order", async () => {
    const traceId = newTraceId();
    await cp.sendHandoff({
      intent: "tasks.create_task.v2",
      receiver: PEER_AGENT.id,
      payload: { title: "first" },
      dedupeKey: computeDedupeKey([TEST_AGENT.id, "first"]),
      traceId,
    });
    await cp.sendHandoff({
      intent: "tasks.create_task.v2",
      receiver: PEER_AGENT.id,
      payload: { title: "second" },
      dedupeKey: computeDedupeKey([TEST_AGENT.id, "second"]),
      traceId,
    });

    const peerCp = await open({
      agentId: PEER_AGENT.id,
      dbPath,
      validatorMode: "warn",
    });
    const handoffs = await peerCp.pollHandoffs({ receiver: PEER_AGENT.id });
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0].payload).toEqual({ title: "first" });
    expect(handoffs[1].payload).toEqual({ title: "second" });
    expect(handoffs[0].traceId).toBe(traceId);
    await peerCp.close();
  });

  it("ackHandoff flips the row out of pending", async () => {
    const traceId = newTraceId();
    const sendResult = await cp.sendHandoff({
      intent: "tasks.create_task.v2",
      receiver: PEER_AGENT.id,
      payload: { title: "a" },
      dedupeKey: computeDedupeKey([TEST_AGENT.id, "a"]),
      traceId,
    });
    await cp.ackHandoff(sendResult.id, "done");
    const handoffs = await cp.pollHandoffs({ receiver: PEER_AGENT.id });
    expect(handoffs).toHaveLength(0);
  });

  it("sendHandoff to an unknown receiver throws DomainRuleError", async () => {
    await expect(
      cp.sendHandoff({
        intent: "tasks.create_task.v2",
        receiver: "ghost-agent",
        payload: {},
        dedupeKey: computeDedupeKey([TEST_AGENT.id, "ghost"]),
        traceId: newTraceId(),
      }),
    ).rejects.toBeInstanceOf(DomainRuleError);
  });

  it("end-to-end round trip writes runs + events + handoffs and the projector cursor sees them", async () => {
    const run = await cp.startRun({ triggeredBy: "handoff" });
    run.bumpItems(2);
    await cp.emit({ run, kind: "round.trip.start", severity: "info" });
    await cp.sendHandoff({
      intent: "tasks.create_task.v2",
      receiver: PEER_AGENT.id,
      payload: { title: "round-trip" },
      dedupeKey: computeDedupeKey([TEST_AGENT.id, "round-trip"]),
      traceId: run.traceId,
    });
    await cp.emit({ run, kind: "round.trip.end", severity: "info" });
    await run.end({ status: "done", summary: "ok" });

    const inspect = await openInspect(dbPath);
    const runRow = inspect.prepare(`SELECT * FROM runs WHERE trace_id = ?`).get(run.traceId) as Record<string, unknown>;
    const eventCount = inspect.prepare(`SELECT COUNT(*) AS c FROM events WHERE trace_id = ?`).get(run.traceId) as { c: number };
    const handoffRow = inspect.prepare(`SELECT * FROM handoffs WHERE trace_id = ?`).get(run.traceId) as Record<string, unknown>;
    const projectorRows = inspect.prepare(`SELECT id FROM events WHERE notion_page_id IS NULL`).all() as Array<{ id: number }>;

    expect(runRow.status).toBe("done");
    expect(eventCount.c).toBe(2);
    expect(handoffRow.intent).toBe("tasks.create_task.v2");
    expect(handoffRow.notion_page_id).toBeNull(); // projector hasn't run
    expect(projectorRows.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ControlPlane boot guards", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cp-boot-"));
    dbPath = join(tmp, "ops.db");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("first boot with empty agents table is allowed (escape hatch for first migration)", async () => {
    const cp = await open({ agentId: "anyone", dbPath });
    await cp.close();
  });

  it("second boot with the agents table populated and an unknown agentId throws UnknownAgentError", async () => {
    // First, populate.
    const cp1 = await open({
      agentId: TEST_AGENT.id,
      dbPath,
      bootstrap: { agents: [TEST_AGENT] },
    });
    await cp1.close();
    // Now try to boot as an unknown agent — should throw.
    await expect(open({ agentId: "ghost", dbPath })).rejects.toBeInstanceOf(
      UnknownAgentError,
    );
  });
});

describe("UUIDv7 trace id is monotonic in-process", () => {
  it("two consecutive newTraceId() calls sort lexically", () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(b > a).toBe(true);
  });

  it("100 consecutive newTraceId() calls are strictly increasing", () => {
    const ids = Array.from({ length: 100 }, () => newTraceId());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });
});

describe("computeDedupeKey", () => {
  it("returns a SHA256 hex string", () => {
    const k = computeDedupeKey(["a", "b", "c"]);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same parts", () => {
    expect(computeDedupeKey(["x", "y"])).toBe(computeDedupeKey(["x", "y"]));
  });

  it("differs for different parts", () => {
    expect(computeDedupeKey(["x", "y"])).not.toBe(computeDedupeKey(["y", "x"]));
  });

  it("throws on empty parts", () => {
    expect(() => computeDedupeKey([])).toThrow();
  });
});

// helper to inspect the SQLite file from a separate connection
async function openInspect(dbPath: string): Promise<import("better-sqlite3").Database> {
  const Database = (await import("better-sqlite3")).default;
  return new Database(dbPath, { readonly: true });
}
