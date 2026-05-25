"""Shared types — mirror src/types.ts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

BlastRadius = Literal["internal", "domain-write", "external-write", "money-irreversible"]
AgentStatus = Literal["active", "retired", "planned"]
TriggeredBy = Literal["cron", "handoff", "slack_event", "manual"]
# Canonical run-lifecycle vocabulary. Four values, no aliases. Mirrors
# src/types.ts. `failed` was the prior name for what is now `error`;
# ai-ops-meta `scripts/runner-heartbeat.sh` normalizes legacy aliases
# at write-time as a one-shot safety net.
RunStatus = Literal["running", "done", "error", "timeout"]
Severity = Literal["debug", "info", "warn", "error", "critical"]
HandoffStatus = Literal["pending", "in_progress", "done", "failed", "rejected"]
ValidatorMode = Literal["warn", "enforce"]

_RUN_STATUS_SET = frozenset(("running", "done", "error", "timeout"))


def is_run_status(s: str) -> bool:
    """Return True iff `s` is one of the canonical RunStatus values."""
    return s in _RUN_STATUS_SET


class Logger(Protocol):
    def debug(self, event: str, fields: dict[str, Any] | None = None) -> None: ...
    def info(self, event: str, fields: dict[str, Any] | None = None) -> None: ...
    def warn(self, event: str, fields: dict[str, Any] | None = None) -> None: ...
    def error(self, event: str, fields: dict[str, Any] | None = None) -> None: ...


@dataclass(frozen=True)
class AgentRow:
    id: str
    name: str
    status: AgentStatus
    blast_radius: BlastRadius
    notion_page_id: str | None = None
    repo_url: str | None = None


@dataclass(frozen=True)
class DomainRow:
    id: str
    owner_agent_id: str | None = None
    notion_page_id: str | None = None


@dataclass(frozen=True)
class ContractRow:
    id: str
    status: Literal["draft", "active", "deprecated", "retired"]
    schema_json: str
    notion_page_id: str | None = None


@dataclass(frozen=True)
class Handoff:
    id: int
    intent: str
    sender_id: str
    receiver_id: str
    payload: Any
    dedupe_key: str
    trace_id: str
    status: HandoffStatus
    attempt_count: int
    created_at: str
    picked_up_at: str | None


@dataclass(frozen=True)
class SendHandoffResult:
    id: int
    deduped: bool
