"""Error classes — mirror src/errors.ts."""

from __future__ import annotations


class ControlPlaneError(Exception):
    pass


class ContractViolationError(ControlPlaneError):
    """validate(intent, payload) failed against the contract schema."""

    def __init__(self, intent: str, violations: list[str]) -> None:
        self.intent = intent
        self.violations = violations
        super().__init__(f"contract violation: {intent} — {'; '.join(violations)}")


class DomainRuleError(ControlPlaneError):
    """Sender wrote a handoff for a receiver that doesn't accept the intent."""

    def __init__(self, receiver: str, intent: str) -> None:
        self.receiver = receiver
        self.intent = intent
        super().__init__(f"receiver {receiver} does not accept intent {intent}")


class StorageError(ControlPlaneError):
    """SQLite-or-disk hiccup. Observability methods log + swallow; mutation methods re-raise."""

    def __init__(self, message: str, cause: BaseException | None = None) -> None:
        self.cause = cause
        super().__init__(message)


class UnknownAgentError(ControlPlaneError):
    """Boot-time guard: agent_id supplied to open() isn't in the agents table."""

    def __init__(self, agent_id: str) -> None:
        self.agent_id = agent_id
        super().__init__(
            f"unknown agent: {agent_id}. Boot the lib with a registered agent id."
        )
