export class ControlPlaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** validate(intent, payload) failed against the contract schema. */
export class ContractViolationError extends ControlPlaneError {
  constructor(
    public readonly intent: string,
    public readonly violations: readonly string[],
  ) {
    super(`contract violation: ${intent} — ${violations.join("; ")}`);
  }
}

/** Sender wrote a handoff for a receiver that doesn't accept the intent. */
export class DomainRuleError extends ControlPlaneError {
  constructor(
    public readonly receiver: string,
    public readonly intent: string,
  ) {
    super(`receiver ${receiver} does not accept intent ${intent}`);
  }
}

/** SQLite-or-disk hiccup. Observability methods log and swallow; mutation methods re-raise. */
export class StorageError extends ControlPlaneError {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Boot-time guard: agent_id supplied to open() isn't in the agents table. */
export class UnknownAgentError extends ControlPlaneError {
  constructor(public readonly agentId: string) {
    super(`unknown agent: ${agentId}. Boot the lib with a registered agent id.`);
  }
}
