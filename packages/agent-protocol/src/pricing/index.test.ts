import { describe, expect, it } from "vitest";
import type { UsageMeasurement } from "../index.js";
import { priceCodexUsage, type CodexPriceRow } from "./index.js";

const row: CodexPriceRow = { model: "synthetic-model", effectiveFrom: "2026-01-01", inputUsdPerMTok: 2, cachedInputUsdPerMTok: 0.5, outputUsdPerMTok: 10 };
const at = Date.parse("2026-10-01T00:00:00Z");
const measurement = (): UsageMeasurement => ({
  kind: "delta", responseId: "synthetic-response", model: row.model, source: "synthetic-fixture",
  tokens: { input: 1_000_000, cachedInput: 400_000, output: 200_000, cacheWriteInput: null, reasoningOutput: 50_000, total: 1_200_000 },
  cost: null,
});

describe("shared pricing evidence", () => {
  it.each(["input", "cachedInput", "output"] as const)("leaves a missing %s counter unpriced", (field) => {
    const value = measurement(); value.tokens[field] = null;
    expect(priceCodexUsage([value], [row], at)[0]).toBe(value);
    expect(value.cost).toBeNull();
  });
  it.each(["reported", "estimate"] as const)("preserves existing %s zero instead of repricing", (kind) => {
    const value = { ...measurement(), model: "unknown", cost: { usd: 0, kind } };
    expect(priceCodexUsage([value], [row], at)[0]).toBe(value);
  });
  it("does not charge reasoning output a second time", () => {
    const first = measurement(), second = measurement(); second.tokens.reasoningOutput = 200_000;
    expect(priceCodexUsage([first], [row], at)[0]?.cost).toEqual({ usd: 3.4, kind: "estimate" });
    expect(priceCodexUsage([second], [row], at)[0]?.cost).toEqual({ usd: 3.4, kind: "estimate" });
  });
  it("bounds the cached subset by the already inclusive input total", () => {
    const value = measurement(); value.tokens.cachedInput = 2_000_000;
    expect(priceCodexUsage([value], [row], at)[0]?.cost).toEqual({ usd: 2.5, kind: "estimate" });
  });
  it("leaves input records, token evidence and catalog rates unchanged", () => {
    const value = measurement(); const before = structuredClone(value); const catalog = [structuredClone(row)];
    const quoted = priceCodexUsage([value], catalog, at);
    expect(quoted[0]?.cost).toEqual({ usd: 3.4, kind: "estimate" });
    expect(value).toEqual(before); expect(catalog).toEqual([row]);
  });
});
