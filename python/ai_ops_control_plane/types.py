"""Shared types — mirror src/types.ts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

BlastRadius = Literal["internal", "domain-write", "external-write", "money-irreversible"]
AgentStatus = Literal["active", "retired", "planned"]
TriggeredBy = Literal["cron", "handoff", "slack_event", "manual"]
RunStatus = Literal["running", "done", "failed", "timeout"]
Severity = Literal["debug", "info", "warn", "error", "critical"]
HandoffStatus = Literal["pending", "in_progress", "done", "failed", "rejected"]
ValidatorMode = Literal["warn", "enforce"]


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
