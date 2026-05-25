"""Python port of @hamlet-archer/ai-ops-control-plane.

Mirrors the TypeScript edition's API and semantics. Same schema.sql,
same ops.db file (TS and Python clients can write to the same file
from the same harness — rows are indistinguishable).

See README.md and ai-ops-meta briefs/control-plane-design.md.
"""

from .control_plane import (
    ControlPlane,
    EmitArgs,
    OpenOpts,
    PollHandoffsArgs,
    RunHandle,
    SendHandoffArgs,
    StartRunArgs,
)
from .control_plane import (
    open as open_control_plane,
)
from .dedupe import compute_dedupe_key
from .errors import (
    ContractViolationError,
    ControlPlaneError,
    DomainRuleError,
    StorageError,
    UnknownAgentError,
)
from .trace import new_trace_id
from .types import (
    AgentRow,
    AgentStatus,
    BlastRadius,
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
    is_run_status,
)

__all__ = [
    "AgentRow",
    "AgentStatus",
    "BlastRadius",
    "ContractRow",
    "ContractViolationError",
    "ControlPlane",
    "ControlPlaneError",
    "DomainRow",
    "DomainRuleError",
    "EmitArgs",
    "Handoff",
    "HandoffStatus",
    "Logger",
    "OpenOpts",
    "PollHandoffsArgs",
    "RunHandle",
    "RunStatus",
    "SendHandoffArgs",
    "SendHandoffResult",
    "Severity",
    "StartRunArgs",
    "StorageError",
    "TriggeredBy",
    "UnknownAgentError",
    "ValidatorMode",
    "compute_dedupe_key",
    "is_run_status",
    "new_trace_id",
    "open_control_plane",
]

__version__ = "0.3.0"
