import { describe, expect, it } from "vitest";
import type { UsageMeasurement } from "../index.js";
import { createCodexPricingPort, priceCodexUsage } from "./codex-prices.js";
function measurement(): UsageMeasurement {
  return { kind: "snapshot", scope: "turn", scopeId: "synthetic-turn", epoch: "synthetic-epoch", sequence: 0,
    model: "synthetic-model", tokens: { input: 10, cachedInput: 4, output: 6, reasoningOutput: 2, cacheWriteInput: null, total: 16 },
    cost: null, source: "synthetic-observation" };
}
function options() {
  return { prices: [{ model: "synthetic-model", effectiveFrom: "1970-01-01", inputUsdPerMTok: 2,
    cachedInputUsdPerMTok: 0.5, outputUsdPerMTok: 8 }],
    catalog: { id: "caller-catalog", version: "fixture-v1", provider: "caller-provider",
      matchingPolicy: { id: "exact-model-date", version: "fixture-v1" },
      accountingPolicy: { id: "inclusive-tokens", version: "fixture-v1" } } };
}
describe("pure caller-bound Codex quote", () => {
  it("uses the shared inclusive arithmetic and actual dated row evidence", () => {
    const input = options();
    input.prices.push({ ...input.prices[0]!, effectiveFrom: "2026-01-01", outputUsdPerMTok: 16 });
    const port = createCodexPricingPort(input);
    const old = port.quote(measurement(), 100);
    const newerAt = Date.parse("2026-01-01T00:00:00Z");
    const newer = port.quote(measurement(), newerAt);
    expect(old).toMatchObject({ status: "priced", cost: { usd: 62 / 1_000_000, kind: "estimate" },
      basis: { kind: "catalog", atMs: 100, catalog: { id: "caller-catalog", effectiveFrom: "1970-01-01" } } });
    expect(newer).toMatchObject({ status: "priced", cost: { usd: 110 / 1_000_000, kind: "estimate" },
      basis: { kind: "catalog", atMs: newerAt, catalog: { effectiveFrom: "2026-01-01" } } });
    const cached = measurement(); cached.tokens.cachedInput = 20;
    expect(port.quote(cached, 100)).toMatchObject({ cost: { usd: 53 / 1_000_000 } });
  });
  it("copies rows and nested caller metadata instead of retaining mutable policy inputs", () => {
    const input = options(); const port = createCodexPricingPort(input);
    input.prices[0]!.outputUsdPerMTok = 999;
    input.catalog.version = "mutated"; input.catalog.matchingPolicy.version = "mutated";
    expect(port.quote(measurement(), 100)).toMatchObject({ cost: { usd: 62 / 1_000_000 },
      basis: { catalog: { version: "fixture-v1", matchingPolicy: { version: "fixture-v1" } } } });
    expect(Object.isFrozen(port)).toBe(true);
  });
  it("preserves valid known costs before catalog-only missing model/count/time checks", () => {
    const port = createCodexPricingPort(options());
    for (const kind of ["reported", "estimate"] as const) {
      const raw = measurement(); raw.model = null; raw.tokens.input = null; raw.cost = { usd: 0, kind };
      expect(port.quote(raw, Number.NaN)).toEqual({ status: "priced", cost: { usd: 0, kind },
        basis: { kind: kind === "reported" ? "reported" : "existing_estimate", source: raw.source } });
    }
  });
  it("rejects invalid known USD and runtime kind without changing the legacy function", () => {
    const port = createCodexPricingPort(options());
    for (const usd of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const raw = measurement(); raw.cost = { usd, kind: "reported" };
      expect(() => port.quote(raw, 100)).toThrow(TypeError);
      expect(priceCodexUsage([raw], options().prices, 100)[0]).toBe(raw);
    }
    const raw = measurement(); raw.cost = { usd: 1, kind: "reported" };
    Reflect.set(raw.cost, "kind", "invalid");
    expect(() => port.quote(raw, 100)).toThrow(TypeError);
  });
  it("keeps invalid new estimates unpriced and valid zero priced", () => {
    const port = createCodexPricingPort(options());
    for (const time of [Number.NaN, Number.POSITIVE_INFINITY]) expect(port.quote(measurement(), time).status).toBe("unpriced");
    for (const field of ["input", "cachedInput", "output"] as const) {
      for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        const raw = measurement(); raw.tokens[field] = value;
        expect(port.quote(raw, 100).status).toBe("unpriced");
      }
    }
    const raw = measurement(); raw.tokens.input = 0; raw.tokens.cachedInput = 0; raw.tokens.output = 0;
    expect(port.quote(raw, 100)).toMatchObject({ status: "priced", cost: { usd: 0, kind: "estimate" } });
    const overflow = measurement(); overflow.tokens.output = Number.MAX_VALUE;
    expect(port.quote(overflow, 100).status).toBe("unpriced");
    const nullModel = measurement(); nullModel.model = null;
    expect(port.quote(nullModel, 100).status).toBe("unpriced");
    const empty = options(); empty.prices = [];
    expect(createCodexPricingPort(empty).quote(measurement(), 100).status).toBe("unpriced");
    const unknown = measurement(); unknown.model = "unlisted";
    expect(port.quote(unknown, 100).status).toBe("unpriced");
    expect(port.quote(measurement(), -1).status).toBe("unpriced");
  });
});
