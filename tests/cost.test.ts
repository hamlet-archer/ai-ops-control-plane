import { describe, expect, it, vi } from "vitest";
import { costFromUsage, _PRICE_TABLE } from "../src/cost.js";

describe("costFromUsage", () => {
  it("computes Opus 4.7 input + output cost", () => {
    // 1M input @ $15 + 1M output @ $75 = $90
    const cost = costFromUsage("claude-opus-4-7", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(90, 6);
  });

  it("computes Sonnet 4.6 input + output cost", () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    const cost = costFromUsage("claude-sonnet-4-6", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18, 6);
  });

  it("computes Haiku 4.5 input + output cost", () => {
    // 1M input @ $1 + 1M output @ $5 = $6
    const cost = costFromUsage("claude-haiku-4-5", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6, 6);
  });

  it("strips trailing -YYYYMMDD date suffix when looking up the model", () => {
    const dated = costFromUsage("claude-haiku-4-5-20251001", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    const bare = costFromUsage("claude-haiku-4-5", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(dated).toBe(bare);
  });

  it("prices the production model string claude-sonnet-4-20250514 (Sonnet 4.0)", () => {
    // Every active agent's ANTHROPIC_MODEL resolves to this. The date-strip
    // yields `claude-sonnet-4`; without its row this returned 0 and kept
    // ops.db runs.cost_usd at 0 fleet-wide (architect-backlog §J7c.b.4).
    const cost = costFromUsage("claude-sonnet-4-20250514", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18, 6);
  });

  it("bills cache_creation at 1.25× input and cache_read at 0.10× input", () => {
    // Sonnet 4.6: cache_creation @ $3.75/M, cache_read @ $0.30/M
    const cost = costFromUsage("claude-sonnet-4-6", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3.75 + 0.3, 6);
  });

  it("computes a realistic small request cost (Sonnet 4.6)", () => {
    // 2000 input + 500 output + 800 cache_read tokens
    // = 2000/M*3 + 500/M*15 + 800/M*0.3 = 0.006 + 0.0075 + 0.00024 = 0.01374
    const cost = costFromUsage("claude-sonnet-4-6", {
      input_tokens: 2000,
      output_tokens: 500,
      cache_read_input_tokens: 800,
    });
    expect(cost).toBeCloseTo(0.01374, 6);
  });

  it("returns 0 and warns for an unknown model", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cost = costFromUsage("claude-something-future", {
      input_tokens: 1000,
      output_tokens: 1000,
    });
    expect(cost).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(
      'unknown model "claude-something-future"',
    );
    warnSpy.mockRestore();
  });

  it("treats missing cache fields as 0 (no NaN propagation)", () => {
    const cost = costFromUsage("claude-sonnet-4-6", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18, 6);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it("returns 0 for an all-zero usage payload (no false-positive cost)", () => {
    const cost = costFromUsage("claude-opus-4-7", {
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(cost).toBe(0);
  });

  it("PRICE_TABLE covers Opus 4.7, Sonnet 4.6, and Haiku 4.5 — the J7c-named models", () => {
    expect(_PRICE_TABLE["claude-opus-4-7"]).toBeDefined();
    expect(_PRICE_TABLE["claude-sonnet-4-6"]).toBeDefined();
    expect(_PRICE_TABLE["claude-haiku-4-5"]).toBeDefined();
    // Sonnet 4.0 — the string production agents actually pass.
    expect(_PRICE_TABLE["claude-sonnet-4"]).toBeDefined();
  });
});
