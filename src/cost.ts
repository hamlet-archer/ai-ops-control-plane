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
  // Sonnet 4.x — $3/$15 per 1M
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
  // Haiku 4.x — $1/$5 per 1M
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
 * Compute USD cost from an Anthropic `messages.create` response's `usage`.
 *
 * Returns 0 for unknown models (and emits a `console.warn`). Callers can
 * still record the run; the row's `cost_usd` is just 0 until the price
 * table grows a row for that model.
 */
export function costFromUsage(model: string, usage: AnthropicUsage): number {
  const price = lookupPrice(model);
  if (!price) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ai-ops-control-plane] costFromUsage: unknown model "${model}" — returning 0; add a row to PRICE_TABLE in src/cost.ts`,
    );
    return 0;
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
