#!/usr/bin/env node
// Cross-edition parity smoke: TypeScript writes a Run + Event + Handoff
// to a temp ops.db; a Python child process reads them back and asserts
// the rows match. Acceptance criterion for Outcome 7 step 2 ("TS and
// Python clients can write to the same ops.db file from the same harness;
// rows are indistinguishable").

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  open,
  newTraceId,
  computeDedupeKey,
} from "../dist/index.js";

const TEST_AGENT = {
  id: "ts-writer",
  name: "TS Writer",
  status: "active",
  blastRadius: "internal",
  notionPageId: null,
  repoUrl: null,
};
const PEER_AGENT = {
  id: "py-reader",
  name: "Python Reader",
  status: "active",
  blastRadius: "internal",
  notionPageId: null,
  repoUrl: null,
};

const tmp = mkdtempSync(join(tmpdir(), "cross-edition-"));
const dbPath = join(tmp, "ops.db");

const cp = await open({
  agentId: TEST_AGENT.id,
  dbPath,
  validatorMode: "warn",
  bootstrap: { agents: [TEST_AGENT, PEER_AGENT] },
});

const run = await cp.startRun({ triggeredBy: "manual" });
run.bumpItems(7);
const traceId = run.traceId;
await cp.emit({ run, kind: "cross.edition.event", severity: "info", payload: { from: "ts" } });
await cp.sendHandoff({
  intent: "tasks.create_task.v2",
  receiver: PEER_AGENT.id,
  payload: { title: "from typescript" },
  dedupeKey: computeDedupeKey([TEST_AGENT.id, "cross-edition"]),
  traceId,
});
await run.end({ status: "done", summary: "ts wrote" });
await cp.close();

// Python reader script — uses sqlite3 stdlib only (no need for the lib).
const pyScript = join(tmp, "read.py");
writeFileSync(
  pyScript,
  `import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
run = db.execute("SELECT status, items_processed, summary FROM runs WHERE trace_id = ?", (sys.argv[2],)).fetchone()
event = db.execute("SELECT kind, severity, payload_json FROM events WHERE trace_id = ?", (sys.argv[2],)).fetchone()
handoff = db.execute("SELECT intent, receiver_id, payload_json FROM handoffs WHERE trace_id = ?", (sys.argv[2],)).fetchone()
assert run == ('done', 7, 'ts wrote'), f"run mismatch: {run}"
assert event[0] == 'cross.edition.event' and event[1] == 'info', f"event mismatch: {event}"
import json
assert json.loads(event[2]) == {"from": "ts"}, f"event payload mismatch: {event[2]}"
assert handoff[0] == 'tasks.create_task.v2' and handoff[1] == 'py-reader', f"handoff mismatch: {handoff}"
assert json.loads(handoff[2]) == {"title": "from typescript"}, f"handoff payload mismatch: {handoff[2]}"
print("cross-edition-smoke: TS writes → Python reads, all 3 row types verified")
`,
);

const result = spawnSync("python3", [pyScript, dbPath, traceId], {
  stdio: "inherit",
});
rmSync(tmp, { recursive: true, force: true });
process.exit(result.status ?? 1);
