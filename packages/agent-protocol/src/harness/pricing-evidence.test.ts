import { describe, expect, expectTypeOf, it } from "vitest";
import type { UsageMeasurement } from "../index.js";
import { priceRequest, type PriceRow } from "../pricing/index.js";
import type { HarnessPriceQuote, HarnessPricingContext, HarnessPricingPort } from "./index.js";

const at = Date.parse("2026-10-01T00:00:00Z");
const rows: readonly PriceRow[] = [{ modelPrefix: "fixture-model", effectiveFrom: "2026-01-01", input: 2, cacheRead: 0.2, cacheWrite5m: 3, cacheWrite1h: 8, output: 10 }];
const catalog = {
  id: "fixture-catalog", version: "1", provider: "fixture-provider", model: "fixture-model", effectiveFrom: "2026-01-01",
  matchingPolicy: { id: "fixture-id-boundary", version: "1" }, accountingPolicy: { id: "fixture-cache-ttl", version: "1" },
};
function measurement(): UsageMeasurement {
  return { kind: "delta", responseId: "fixture-response", model: "fixture-model", source: "fixture-current-record",
    tokens: { input: 1_000_000, output: 0, cachedInput: 0, cacheWriteInput: 1_000_000, reasoningOutput: null, total: 1_000_000 }, cost: null };
}
function fixture() {
  const calls: { value: UsageMeasurement; atMs: number; context: HarnessPricingContext | undefined }[] = [];
  const port: HarnessPricingPort<"fixture-fifth"> = {
    harness: "fixture-fifth",
    quote(value, atMs, context) {
      calls.push({ value, atMs, context });
      if (value.cost !== null) {
        if (value.cost.kind === "reported") return { status: "priced", cost: { ...value.cost, kind: "reported" }, basis: { kind: "reported", source: value.source } };
        return { status: "priced", cost: { ...value.cost, kind: "estimate" }, basis: { kind: "existing_estimate", source: value.source } };
      }
      const { input, output, cachedInput, cacheWriteInput } = value.tokens;
      if (value.model === null || input === null || output === null || cachedInput === null || cacheWriteInput === null || !Number.isFinite(new Date(atMs).getTime()))
        return { status: "unpriced", reason: "fixture pricing evidence unavailable" };
      const priced = priceRequest({
        inputTokens: Math.max(0, input - cachedInput - cacheWriteInput), cacheReadTokens: cachedInput,
        cacheCreationTokens: cacheWriteInput, cacheCreation5mTokens: context?.cacheWriteSplit?.ttl5m,
        cacheCreation1hTokens: context?.cacheWriteSplit?.ttl1h, outputTokens: output,
      }, value.model, new Date(atMs).toISOString(), rows);
      return priced.priced
        ? { status: "priced", cost: { usd: priced.costUsd, kind: "estimate" }, basis: { kind: "catalog", atMs, catalog } }
        : { status: "unpriced", reason: "fixture model has no catalog price" };
    },
  };
  return { port, calls };
}
function rejectMutation(context: HarnessPricingContext) {
  if (context.cacheWriteSplit) {
    // @ts-expect-error a known TTL split is readonly through the port input
    context.cacheWriteSplit.ttl1h = 0;
  }
  // @ts-expect-error pricing context cannot be replaced through the port input
  context.cacheWriteSplit = { ttl5m: 1, ttl1h: 0 };
}

describe("neutral pricing evidence", () => {
  it("carries known TTL evidence through an open adapter to the actual shared accounting engine", () => {
    const f = fixture(); const value = measurement(); const before = structuredClone(value);
    const contexts = [
      Object.freeze({ cacheWriteSplit: Object.freeze({ ttl5m: 1_000_000, ttl1h: 0 }) }),
      Object.freeze({ cacheWriteSplit: Object.freeze({ ttl5m: 0, ttl1h: 1_000_000 }) }),
      Object.freeze({ cacheWriteSplit: Object.freeze({ ttl5m: 400_000, ttl1h: 600_000 }) }),
    ];
    const quotes = contexts.map(context => f.port.quote(value, at, context));
    expect(quotes.map(result => result.status === "priced" ? result.cost.usd : null)).toEqual([3, 8, 6]);
    expect(f.calls).toEqual(contexts.map(context => ({ value, atMs: at, context })));
    expect(value).toEqual(before);
    expectTypeOf(f.port.harness).toEqualTypeOf<"fixture-fifth">();
  });
  it("preserves the existing total-only and zero-split fallback without inventing known one-hour writes", () => {
    const f = fixture();
    const quotes = [f.port.quote(measurement(), at), f.port.quote(measurement(), at, { cacheWriteSplit: { ttl5m: 0, ttl1h: 0 } })];
    expect(quotes.map(result => result.status === "priced" ? result.cost.usd : null)).toEqual([3, 3]);
    expect(f.calls[0]?.context).toBeUndefined();
  });
  it.each(["reported", "estimate"] as const)("retains preexisting %s cost before absent model/counters or invalid time", (kind) => {
    for (const usd of [0, 2.75]) {
      const value = { ...measurement(), model: null, cost: { usd, kind },
        tokens: { input: null, output: null, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: null } };
      const result = fixture().port.quote(value, Number.NaN);
      expect(result).toEqual({ status: "priced", cost: { usd, kind }, basis: { kind: kind === "reported" ? "reported" : "existing_estimate", source: "fixture-current-record" } });
      expect(result).not.toHaveProperty("basis.catalog");
      expect(value.cost).toEqual({ usd, kind });
    }
  });
  it("keeps the corresponding no-cost evidence explicitly unpriced", () => {
    const f = fixture(); const value = measurement();
    const results = [f.port.quote({ ...value, model: null }, at),
      f.port.quote({ ...value, tokens: { ...value.tokens, input: null } }, at),
      f.port.quote(value, Number.NaN), f.port.quote({ ...value, model: "fixture-unlisted" }, at)];
    for (const result of results) { expect(result.status).toBe("unpriced"); expect(result).not.toHaveProperty("cost"); }
  });
  it("keeps legacy two-argument implementations assignable", () => {
    const port: HarnessPricingPort<"fixture-legacy"> = { harness: "fixture-legacy", quote(_value, _atMs) { return { status: "unpriced", reason: "legacy fixture unavailable" }; } };
    expect(port.quote(measurement(), at)).toEqual({ status: "unpriced", reason: "legacy fixture unavailable" });
  });
  it("requires honest estimate evidence and readonly context without weakening catalog requirements", () => {
    // @ts-expect-error an existing estimate must retain estimate kind
    const reported: HarnessPriceQuote = { status: "priced", cost: { usd: 0, kind: "reported" }, basis: { kind: "existing_estimate", source: "fixture" } };
    // @ts-expect-error the current evidence source is required for an existing estimate
    const sourceless: HarnessPriceQuote = { status: "priced", cost: { usd: 0, kind: "estimate" }, basis: { kind: "existing_estimate" } };
    // @ts-expect-error a new catalog estimate still needs matching/accounting revision metadata
    const catalogless: HarnessPriceQuote = { status: "priced", cost: { usd: 1, kind: "estimate" }, basis: { kind: "catalog", atMs: at } };
    expect([reported, sourceless, catalogless, rejectMutation]).toHaveLength(4);
  });
});
