export type BlastRadius =
  | "internal"
  | "domain-write"
  | "external-write"
  | "money-irreversible";

export type AgentStatus = "active" | "retired" | "planned";

export type TriggeredBy = "cron" | "handoff" | "slack_event" | "manual";
// Canonical run-lifecycle vocabulary. Four values, no aliases. Downstream
// callers MUST import this type (or use `isRunStatus`) instead of writing
// loose strings — `runs.status` rollups across the fleet break the moment
// agents write 'ok'/'success'/'completed'/'failed' (the 2026-05-25 audit
// found 6+ "success-ish" variants in ops.db). `failed` was the prior
// name for what is now `error`; ai-ops-meta `scripts/runner-heartbeat.sh`
// normalizes the legacy aliases at write-time as a one-shot safety net.
export type RunStatus = "running" | "done" | "error" | "timeout";

const RUN_STATUS_SET: ReadonlySet<string> = new Set<string>([
  "running",
  "done",
  "error",
  "timeout",
]);

export function isRunStatus(s: string): s is RunStatus {
  return RUN_STATUS_SET.has(s);
}

export type Severity = "debug" | "info" | "warn" | "error" | "critical";

export type HandoffStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "rejected";

export type ValidatorMode = "warn" | "enforce";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface AgentRow {
  id: string;
  name: string;
  status: AgentStatus;
  blastRadius: BlastRadius;
  notionPageId: string | null;
  repoUrl: string | null;
  acceptedIntents?: readonly string[];
}

export interface DomainRow {
  id: string;
  ownerAgentId: string | null;
  notionPageId: string | null;
}

export interface ContractRow {
  id: string;
  status: "draft" | "active" | "deprecated" | "retired";
  schemaJson: string;
  notionPageId: string | null;
}

export interface Handoff {
  id: number;
  intent: string;
  senderId: string;
  receiverId: string;
  payload: unknown;
  dedupeKey: string;
  traceId: string;
  status: HandoffStatus;
  attemptCount: number;
  createdAt: string;
  pickedUpAt: string | null;
}

export interface SendHandoffResult {
  id: number;
  deduped: boolean;
}
