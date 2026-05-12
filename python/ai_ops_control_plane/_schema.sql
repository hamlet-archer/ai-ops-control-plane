-- ai-ops-control-plane schema v1
-- Source of truth: ai-ops-meta briefs/control-plane-design.md §1 "Schema — ops.db DDL"
-- Applied idempotently by ControlPlane.open(). Do not edit live DBs by hand.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,
  blast_radius    TEXT NOT NULL,
  notion_page_id  TEXT,
  repo_url        TEXT,
  synced_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  id              TEXT PRIMARY KEY,
  owner_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
  notion_page_id  TEXT,
  synced_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL,
  schema_json     TEXT NOT NULL,
  notion_page_id  TEXT,
  synced_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  trace_id            TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL REFERENCES agents(id),
  triggered_by        TEXT NOT NULL,
  status              TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  duration_ms         INTEGER,
  items_processed     INTEGER NOT NULL DEFAULT 0,
  handoffs_emitted    INTEGER NOT NULL DEFAULT 0,
  errors              INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL    NOT NULL DEFAULT 0,
  summary             TEXT,
  error_summary       TEXT,
  notion_page_id      TEXT
);
CREATE INDEX IF NOT EXISTS runs_agent_started_idx  ON runs (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_status_started_idx ON runs (status, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_projector_idx      ON runs (notion_page_id) WHERE notion_page_id IS NULL;

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  severity        TEXT NOT NULL,
  payload_json    TEXT,
  run_trace_id    TEXT REFERENCES runs(trace_id) ON DELETE SET NULL,
  trace_id        TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  notion_page_id  TEXT
);
CREATE INDEX IF NOT EXISTS events_trace_idx        ON events (trace_id, id);
CREATE INDEX IF NOT EXISTS events_agent_kind_idx   ON events (agent_id, kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_severity_idx     ON events (severity, occurred_at DESC) WHERE severity IN ('error','critical');
CREATE INDEX IF NOT EXISTS events_projector_idx    ON events (id) WHERE notion_page_id IS NULL;

CREATE TABLE IF NOT EXISTS handoffs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  intent          TEXT NOT NULL,
  sender_id       TEXT NOT NULL REFERENCES agents(id),
  receiver_id     TEXT NOT NULL REFERENCES agents(id),
  payload_json    TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL UNIQUE,
  trace_id        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  picked_up_at    TEXT,
  completed_at    TEXT,
  error_summary   TEXT,
  notion_page_id  TEXT
);
CREATE INDEX IF NOT EXISTS handoffs_receiver_pending_idx ON handoffs (receiver_id, status, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS handoffs_trace_idx            ON handoffs (trace_id);
CREATE INDEX IF NOT EXISTS handoffs_projector_idx        ON handoffs (id) WHERE notion_page_id IS NULL;

CREATE TABLE IF NOT EXISTS incidents (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  severity        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  agent_id        TEXT REFERENCES agents(id),
  root_cause      TEXT,
  resolution      TEXT,
  opened_at       TEXT NOT NULL,
  resolved_at     TEXT,
  notion_page_id  TEXT
);
CREATE INDEX IF NOT EXISTS incidents_open_idx ON incidents (status, opened_at DESC) WHERE status != 'resolved';
