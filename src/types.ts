export type BlastRadius =
  | "internal"
  | "domain-write"
  | "external-write"
  | "money-irreversible";

export type AgentStatus = "active" | "retired" | "planned";

export type TriggeredBy = "cron" | "handoff" | "slack_event" | "manual";
export type RunStatus = "running" | "done" | "failed" | "timeout";

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
