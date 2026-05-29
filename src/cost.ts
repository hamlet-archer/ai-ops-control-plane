/**
 * Anthropic LLM cost helper.
 *
 * Maps `(model, usage)` to USD using a hard-coded per-million-tokens price
 * table for the Anthropic models the AI Ops fleet currently uses. Callers
 * (per-agent) pass the result to `RunHandle.addCost(...)` so ops.db
 * `runs.cost_usd` reflects real spend.
 *
 * Why hard-coded prices: Anthropic price changes are infrequent (~quarterly);
 * pulling prices from a remote service introduces fail paths in the LLM call
 * hot path. When prices change, bump this file and re-cut a control-plane
 * release.
 *
 * Cache pricing (per Anthropic docs, 5-minute TTL):
 *   cache_creation_input_tokens billed at 1.25 × base input price
 *   cache_read_input_tokens     billed at 0.10 × base input price
 *
 * Trace: ai-ops-meta architect-backlog.md §J7c.a.
 */

/** Subset of `Anthropic.Messages.Usage` the helper needs. */
export interface AnthropicUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

/** USD per 1M tokens for a single model's four billing channels. */
export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheCreationPerMTok: number;
  readonly cacheReadPerMTok: number;
}

const M = 1_000_000;

/**
 * Per-million-token USD prices for the Anthropic models the fleet uses.
 *
 * Sources: Anthropic published list price as of 2026-05-27. Keys are model
 * IDs as they appear in `messages.create({ model: ... })`. The `-YYYYMMDD`
 * date suffix (e.g. `claude-haiku-4-5-20251001`) is stripped before lookup,
 * so a single row covers the dated variants of the same model.
 */
const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  // Opus 4.x — $15/$75 per 1M
  // 4-8 is the current flagship. This row MUST exist before any agent or
  // subagent is pinned to Opus 4.8 (ai-ops-meta architect-backlog §Z2 / §Z7) —
  // otherwise costFromUsage now THROWS on it (the AP-2 fail-loud guard below)
  // rather than silently billing 0.
  "claude-opus-4-8": {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheCreationPerMTok: 18.75,
    cacheReadPerMTok: 1.5,
  },
  "claude-opus-4-7": {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheCreationPerMTok: 18.75,
    cacheReadPerMTok: 1.5,
  },
  "claude-opus-4-6": {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheCreationPerMTok: 18.75,
    cacheReadPerMTok: 1.5,
  },
  "claude-opus-4-5": {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheCreationPerMTok: 18.75,
    cacheReadPerMTok: 1.5,
  },
  // Sonnet 4.x — $3/$15 per 1M (tier has held flat across 4.0 → 4.6).
  // 4-7 pre-added at the current tier per §Z2 ("add the next Sonnet/Haiku rows
  // too") so a routine point-release upgrade doesn't trip the fail-loud guard;
  // confirm the price at that model's launch like any price change.
  "claude-sonnet-4-7": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheCreationPerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  },
  "claude-sonnet-4-6": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheCreationPerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  },
  "claude-sonnet-4-5": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheCreationPerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  },
  // Sonnet 4.0 — the model every active agent's `ANTHROPIC_MODEL` actually
  // resolves to today (`claude-sonnet-4-20250514`). Without this row the
  // date-strip yields the bare `claude-sonnet-4`, which had no entry, so
  // costFromUsage returned 0 and ops.db `runs.cost_usd` stayed 0 fleet-wide.
  "claude-sonnet-4": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheCreationPerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  },
  // Haiku 4.x — $1/$5 per 1M (tier has held flat across 4.5).
  // 4-6 pre-added at the current tier per §Z2; confirm at launch.
  "claude-haiku-4-6": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheCreationPerMTok: 1.25,
    cacheReadPerMTok: 0.1,
  },
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheCreationPerMTok: 1.25,
    cacheReadPerMTok: 0.1,
  },
};

function lookupPrice(model: string): ModelPrice | undefined {
  const direct = PRICE_TABLE[model];
  if (direct) return direct;
  // `claude-haiku-4-5-20251001` → `claude-haiku-4-5`
  const dateStripped = model.replace(/-\d{8}$/, "");
  return PRICE_TABLE[dateStripped];
}

/**
 * Thrown by {@link costFromUsage} when asked to price a model that has no
 * row in {@link PRICE_TABLE}.
 *
 * Z2 (2026-05-29): the prior behaviour was a silent `console.warn` + `return 0`
 * — the AP-2 "fail-soft return that masks a real failure" anti-pattern. It hid
 * the fleet-wide `cost_usd = 0` bug for days (a production model string simply
 * wasn't in the table; see J7c.b.4). An unpriced model is a real
 * misconfiguration — surface it loudly so it's fixed at deploy, not discovered
 * weeks later in a $0 spend report. Callers that genuinely want to tolerate it
 * can catch `UnknownModelError` and record the run with cost 0 explicitly.
 */
export class UnknownModelError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(
      `[ai-ops-control-plane] costFromUsage: unknown model "${model}" — add a row to PRICE_TABLE in src/cost.ts. Refusing to silently bill $0 (AP-2).`,
    );
    this.name = "UnknownModelError";
    this.model = model;
  }
}

/**
 * Compute USD cost from an Anthropic `messages.create` response's `usage`.
 *
 * Throws {@link UnknownModelError} for a model with no `PRICE_TABLE` row —
 * we refuse to silently return 0 and mask a pricing gap (AP-2). Add the row,
 * or catch the error at the call site if a 0-cost record is genuinely wanted.
 */
export function costFromUsage(model: string, usage: AnthropicUsage): number {
  const price = lookupPrice(model);
  if (!price) {
    throw new UnknownModelError(model);
  }
  const input = ((usage.input_tokens ?? 0) * price.inputPerMTok) / M;
  const output = ((usage.output_tokens ?? 0) * price.outputPerMTok) / M;
  const cacheWrite =
    ((usage.cache_creation_input_tokens ?? 0) * price.cacheCreationPerMTok) /
    M;
  const cacheRead =
    ((usage.cache_read_input_tokens ?? 0) * price.cacheReadPerMTok) / M;
  return input + output + cacheWrite + cacheRead;
}

/** Exposed for tests + downstream tooling (e.g. price-table diff scripts). */
export const _PRICE_TABLE = PRICE_TABLE;
