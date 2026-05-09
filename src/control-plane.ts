import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { newTraceId } from "./trace.js";
import {
  ContractViolationError,
  DomainRuleError,
  StorageError,
  UnknownAgentError,
} from "./errors.js";
import type {
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
} from "./types.js";

const SCHEMA_VERSION = 1;

const DEFAULT_PROD_PATH = "/var/lib/ai-ops/ops.db";

function resolveDbPath(override?: string): string {
  if (override) return override;
  if (process.env.OPS_DB_PATH) return process.env.OPS_DB_PATH;
  if (existsSync(DEFAULT_PROD_PATH)) return DEFAULT_PROD_PATH;
  return join(homedir(), ".local", "share", "ai-ops", "ops.db");
}

function loadSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "schema.sql"), "utf8");
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface OpenOpts {
  readonly agentId: string;
  readonly dbPath?: string;
  readonly logger?: Logger;
  readonly validatorMode?: ValidatorMode;
  /**
   * Optional bootstrap UPSERT before the agentId existence check. Production
   * agents pass the parsed agent-registry.yaml + contracts/. Tests use this
   * to register a test agent inline.
   */
  readonly bootstrap?: {
    readonly agents?: readonly AgentRow[];
    readonly domains?: readonly DomainRow[];
    readonly contracts?: readonly ContractRow[];
  };
}

export interface RunHandle {
  readonly traceId: string;
  bumpItems(n?: number): void;
  bumpHandoffs(n?: number): void;
  bumpErrors(n?: number): void;
  addCost(usd: number): void;
  end(args: {
    readonly status: Exclude<RunStatus, "running">;
    readonly summary?: string;
    readonly errorSummary?: string;
  }): Promise<void>;
}

export interface StartRunArgs {
  readonly triggeredBy: TriggeredBy;
  readonly traceId?: string;
}

export interface EmitArgs {
  readonly run?: RunHandle;
  readonly kind: string;
  readonly severity: Severity;
  readonly payload?: unknown;
  readonly occurredAt?: Date;
}

export interface SendHandoffArgs {
  readonly intent: string;
  readonly receiver: string;
  readonly payload: object;
  readonly dedupeKey: string;
  readonly traceId: string;
}

export interface PollHandoffsArgs {
  readonly receiver: string;
  readonly intents?: readonly string[];
  readonly limit?: number;
}

export class ControlPlane {
  private readonly db: SqliteDatabase;
  private readonly agentId: string;
  private readonly logger: Logger;
  private readonly validatorMode: ValidatorMode;
  private closed = false;

  constructor(db: SqliteDatabase, opts: Required<Pick<OpenOpts, "agentId">> & {
    logger: Logger;
    validatorMode: ValidatorMode;
  }) {
    this.db = db;
    this.agentId = opts.agentId;
    this.logger = opts.logger;
    this.validatorMode = opts.validatorMode;
  }

  async startRun(args: StartRunArgs): Promise<RunHandle> {
    const traceId = args.traceId ?? newTraceId();
    const startedAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO runs (trace_id, agent_id, triggered_by, status, started_at)
           VALUES (?, ?, ?, 'running', ?)`,
        )
        .run(traceId, this.agentId, args.triggeredBy, startedAt);
    } catch (e) {
      // openRun must never crash the caller — log + return a no-op handle.
      this.logger.warn("runs_open_failed", {
        trace_id: traceId,
        error: errMsg(e),
      });
    }
    return new RunHandleImpl(this.db, this.logger, traceId);
  }

  async emit(args: EmitArgs): Promise<void> {
    const occurredAt = (args.occurredAt ?? new Date()).toISOString();
    const traceId = args.run?.traceId ?? "orphan";
    this.logger.info("event", {
      trace_id: traceId,
      kind: args.kind,
      severity: args.severity,
    });
    try {
      this.db
        .prepare(
          `INSERT INTO events
             (kind, agent_id, severity, payload_json, run_trace_id, trace_id, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.kind,
          this.agentId,
          args.severity,
          args.payload === undefined ? null : JSON.stringify(args.payload),
          args.run?.traceId ?? null,
          traceId,
          occurredAt,
        );
    } catch (e) {
      // Observability never crashes the caller (same rule as the legacy
      // observability.ts safeEmit pattern). Log and swallow.
      this.logger.warn("event_emit_failed", {
        trace_id: traceId,
        kind: args.kind,
        error: errMsg(e),
      });
    }
  }

  async sendHandoff(args: SendHandoffArgs): Promise<SendHandoffResult> {
    this.assertReceiverAccepts(args.receiver, args.intent);
    this.validateOrThrow(args.intent, args.payload);

    const createdAt = new Date().toISOString();
    let result: { id: number; deduped: boolean };
    try {
      const stmt = this.db.prepare(
        `INSERT INTO handoffs
           (intent, sender_id, receiver_id, payload_json, dedupe_key, trace_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(dedupe_key) DO NOTHING`,
      );
      const info = stmt.run(
        args.intent,
        this.agentId,
        args.receiver,
        JSON.stringify(args.payload),
        args.dedupeKey,
        args.traceId,
        createdAt,
      );
      if (info.changes === 0) {
        // Dedupe hit — fetch the existing row's id.
        const existing = this.db
          .prepare(`SELECT id FROM handoffs WHERE dedupe_key = ?`)
          .get(args.dedupeKey) as { id: number } | undefined;
        if (!existing) {
          throw new StorageError(
            `dedupe_key conflict but row missing — schema corruption?`,
          );
        }
        result = { id: existing.id, deduped: true };
      } else {
        result = { id: Number(info.lastInsertRowid), deduped: false };
      }
    } catch (e) {
      if (e instanceof StorageError) throw e;
      throw new StorageError(`sendHandoff failed`, e);
    }
    return result;
  }

  async pollHandoffs(args: PollHandoffsArgs): Promise<Handoff[]> {
    const limit = args.limit ?? 10;
    const intents = args.intents && args.intents.length > 0 ? args.intents : null;

    let rows: Array<{
      id: number;
      intent: string;
      sender_id: string;
      receiver_id: string;
      payload_json: string;
      dedupe_key: string;
      trace_id: string;
      status: HandoffStatus;
      attempt_count: number;
      created_at: string;
      picked_up_at: string | null;
    }>;

    try {
      if (intents) {
        const placeholders = intents.map(() => "?").join(",");
        rows = this.db
          .prepare(
            `SELECT id, intent, sender_id, receiver_id, payload_json, dedupe_key,
                    trace_id, status, attempt_count, created_at, picked_up_at
             FROM handoffs
             WHERE receiver_id = ? AND status = 'pending' AND intent IN (${placeholders})
             ORDER BY id ASC
             LIMIT ?`,
          )
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .all(args.receiver, ...(intents as readonly string[]), limit) as any;
      } else {
        rows = this.db
          .prepare(
            `SELECT id, intent, sender_id, receiver_id, payload_json, dedupe_key,
                    trace_id, status, attempt_count, created_at, picked_up_at
             FROM handoffs
             WHERE receiver_id = ? AND status = 'pending'
             ORDER BY id ASC
             LIMIT ?`,
          )
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .all(args.receiver, limit) as any;
      }
    } catch (e) {
      throw new StorageError(`pollHandoffs failed`, e);
    }

    return rows.map((row) => {
      const payload = safeJsonParse(row.payload_json);
      // Inbound validation per brief §2: pollHandoffs always re-raises on
      // contract violation (poison-pill protection). Only validates when a
      // schema is actually registered.
      this.validateOrThrow(row.intent, payload);
      return {
        id: row.id,
        intent: row.intent,
        senderId: row.sender_id,
        receiverId: row.receiver_id,
        payload,
        dedupeKey: row.dedupe_key,
        traceId: row.trace_id,
        status: row.status,
        attemptCount: row.attempt_count,
        createdAt: row.created_at,
        pickedUpAt: row.picked_up_at,
      };
    });
  }

  async ackHandoff(
    id: number,
    status: Exclude<HandoffStatus, "pending" | "in_progress">,
    errorSummary?: string,
  ): Promise<void> {
    try {
      this.db
        .prepare(
          `UPDATE handoffs
             SET status = ?, completed_at = ?, error_summary = ?
           WHERE id = ?`,
        )
        .run(status, new Date().toISOString(), errorSummary ?? null, id);
    } catch (e) {
      // Missed acks are recoverable via attempt_count exceeding maxAttempts
      // in the dispatcher; log and swallow per brief §2.
      this.logger.warn("ack_handoff_failed", {
        handoff_id: id,
        error: errMsg(e),
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (e) {
      this.logger.warn("close_failed", { error: errMsg(e) });
    }
  }

  // --- internals ---

  private assertReceiverAccepts(receiver: string, intent: string): void {
    // v0.1: agents.acceptedIntents not yet stored in DB (TODO: extend
    // schema in a follow-on PR once contract↔agent mapping is wired).
    // For now this guard short-circuits on missing receiver row but does
    // NOT enforce intent acceptance. DomainRuleError still wired for the
    // future API.
    const row = this.db
      .prepare(`SELECT id FROM agents WHERE id = ?`)
      .get(receiver);
    if (!row) {
      throw new DomainRuleError(receiver, intent);
    }
  }

  private validateOrThrow(intent: string, payload: unknown): void {
    // v0.1: contracts table is empty until step 8 publishes the
    // @hamlet-archer/ai-ops-contracts package and an adapter loads it
    // into bootstrap.contracts. Until then, validation is a no-op.
    const row = this.db
      .prepare(`SELECT schema_json FROM contracts WHERE id = ?`)
      .get(intent) as { schema_json: string } | undefined;
    if (!row) {
      // No schema registered — pass through silently.
      // (warn-event noise here would be relentless during bootstrap.)
      return;
    }
    // Schema validation hookup deferred — would require importing ajv.
    // Brief plan: contracts library exposes validate(intent, payload);
    // wire that here once the package is published.
    void row;
    void payload;
    if (this.validatorMode === "enforce") {
      // TODO: actual validation. v0.1 contracts table stays empty so this
      // branch is unreachable in practice.
      throw new ContractViolationError(intent, [
        "validator not yet wired (v0.1 stub)",
      ]);
    }
  }
}

class RunHandleImpl implements RunHandle {
  readonly traceId: string;
  private items = 0;
  private handoffs = 0;
  private errors = 0;
  private cost = 0;
  private ended = false;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly logger: Logger,
    traceId: string,
  ) {
    this.traceId = traceId;
  }

  bumpItems(n = 1): void {
    this.items += n;
  }
  bumpHandoffs(n = 1): void {
    this.handoffs += n;
  }
  bumpErrors(n = 1): void {
    this.errors += n;
  }
  addCost(usd: number): void {
    this.cost += usd;
  }

  async end(args: {
    readonly status: Exclude<RunStatus, "running">;
    readonly summary?: string;
    readonly errorSummary?: string;
  }): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const endedAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          `UPDATE runs
             SET ended_at = ?, status = ?, items_processed = ?, handoffs_emitted = ?,
                 errors = ?, cost_usd = ?, summary = ?, error_summary = ?,
                 duration_ms = (
                   CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
                 )
           WHERE trace_id = ?`,
        )
        .run(
          endedAt,
          args.status,
          this.items,
          this.handoffs,
          this.errors,
          Number(this.cost.toFixed(6)),
          args.summary ?? null,
          args.errorSummary ?? null,
          endedAt,
          this.traceId,
        );
    } catch (e) {
      this.logger.warn("runs_close_failed", {
        trace_id: this.traceId,
        error: errMsg(e),
      });
    }
  }
}

// --- module-level entry point ---

export async function open(opts: OpenOpts): Promise<ControlPlane> {
  const dbPath = resolveDbPath(opts.dbPath);
  ensureParentDir(dbPath);

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  applySchema(db);
  if (opts.bootstrap) {
    upsertBootstrap(db, opts.bootstrap);
  }

  const exists = db
    .prepare(`SELECT id FROM agents WHERE id = ?`)
    .get(opts.agentId);
  // v0.1 escape hatch: if the agents table is empty, allow boot (helps the
  // first migration onto the lib before any registry sync exists). Once a
  // single agent row is loaded, the strict check kicks in.
  const anyAgent = db.prepare(`SELECT COUNT(*) AS c FROM agents`).get() as { c: number };
  if (!exists && anyAgent.c > 0) {
    throw new UnknownAgentError(opts.agentId);
  }

  return new ControlPlane(db, {
    agentId: opts.agentId,
    logger: opts.logger ?? noopLogger,
    validatorMode: opts.validatorMode ?? "enforce",
  });
}

function ensureParentDir(p: string): void {
  const dir = dirname(p);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function applySchema(db: SqliteDatabase): void {
  db.exec(loadSchemaSql());
  const row = db
    .prepare(`SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`)
    .get() as { version: number } | undefined;
  if (!row) {
    db.prepare(
      `INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`,
    ).run(SCHEMA_VERSION, new Date().toISOString());
  }
}

function upsertBootstrap(
  db: SqliteDatabase,
  b: NonNullable<OpenOpts["bootstrap"]>,
): void {
  const now = new Date().toISOString();
  if (b.agents) {
    const stmt = db.prepare(
      `INSERT INTO agents (id, name, status, blast_radius, notion_page_id, repo_url, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         status = excluded.status,
         blast_radius = excluded.blast_radius,
         notion_page_id = excluded.notion_page_id,
         repo_url = excluded.repo_url,
         synced_at = excluded.synced_at`,
    );
    for (const a of b.agents) {
      stmt.run(a.id, a.name, a.status, a.blastRadius, a.notionPageId, a.repoUrl, now);
    }
  }
  if (b.domains) {
    const stmt = db.prepare(
      `INSERT INTO domains (id, owner_agent_id, notion_page_id, synced_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_agent_id = excluded.owner_agent_id,
         notion_page_id = excluded.notion_page_id,
         synced_at = excluded.synced_at`,
    );
    for (const d of b.domains) {
      stmt.run(d.id, d.ownerAgentId, d.notionPageId, now);
    }
  }
  if (b.contracts) {
    const stmt = db.prepare(
      `INSERT INTO contracts (id, status, schema_json, notion_page_id, synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         schema_json = excluded.schema_json,
         notion_page_id = excluded.notion_page_id,
         synced_at = excluded.synced_at`,
    );
    for (const c of b.contracts) {
      stmt.run(c.id, c.status, c.schemaJson, c.notionPageId, now);
    }
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
