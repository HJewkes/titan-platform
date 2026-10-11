import type { UsageMeasurement } from "@titan-design/agent-protocol";
import { describe, expect, it } from "vitest";
import { priceCodexUsage, validateCodexPrices, type CodexPriceRow } from "./codex-prices.js";

const AT_2026_10_11 = Date.parse("2026-10-11T12:00:00Z");

function measurement(model: string | null): UsageMeasurement {
  return {
    kind: "snapshot",
    scope: "turn",
    scopeId: "execution:e1:turn",
    epoch: "e1",
    sequence: 0,
    model,
    tokens: { input: 1_000_000, cachedInput: 400_000, output: 200_000, cacheWriteInput: null, reasoningOutput: 50_000, total: 1_200_000 },
    cost: null,
    source: "codex-exec.turn.completed.usage",
  };
}

function row(overrides: Partial<CodexPriceRow> = {}): CodexPriceRow {
  return {
    model: "gpt-test",
    effectiveFrom: "2026-01-01",
    inputUsdPerMTok: 2,
    cachedInputUsdPerMTok: 0.5,
    outputUsdPerMTok: 10,
    ...overrides,
  };
}

describe("priceCodexUsage", () => {
  it("bills cached input at the cached rate and the rest of input at the full rate", () => {
    const [priced] = priceCodexUsage([measurement("gpt-test")], [row()], AT_2026_10_11);
    // 0.6M uncached * 2 + 0.4M cached * 0.5 + 0.2M output * 10
    expect(priced?.cost).toEqual({ usd: 3.4, kind: "estimate" });
  });

  it("uses the latest row in force at the run time, ignoring rows dated after it", () => {
    const prices = [
      row({ effectiveFrom: "2026-01-01", outputUsdPerMTok: 10 }),
      row({ effectiveFrom: "2026-11-01", outputUsdPerMTok: 100 }),
      row({ effectiveFrom: "2026-06-01", outputUsdPerMTok: 20 }),
    ];
    const [priced] = priceCodexUsage([measurement("gpt-test")], prices, AT_2026_10_11);
    expect(priced?.cost?.usd).toBeCloseTo(1.2 + 0.2 + 4, 10);
  });

  it("leaves cost null for an unpriced model, a null model, and a model priced only in the future", () => {
    const prices = [row(), row({ model: "gpt-later", effectiveFrom: "2027-01-01" })];
    const results = priceCodexUsage(
      [measurement("gpt-unknown"), measurement(null), measurement("gpt-later")],
      prices,
      AT_2026_10_11,
    );
    expect(results.map((m) => m.cost)).toEqual([null, null, null]);
  });

  it("leaves cost null when a token count it needs is missing", () => {
    const missing = { ...measurement("gpt-test"), tokens: { ...measurement("gpt-test").tokens, cachedInput: null } };
    expect(priceCodexUsage([missing], [row()], AT_2026_10_11)[0]?.cost).toBeNull();
  });
});

describe("validateCodexPrices", () => {
  it.each([
    ["a negative rate", [row({ outputUsdPerMTok: -1 })]],
    ["a non-finite rate", [row({ inputUsdPerMTok: Number.POSITIVE_INFINITY })]],
    ["a malformed date", [row({ effectiveFrom: "2026-1-1" })]],
    ["an impossible date", [row({ effectiveFrom: "2026-02-30" })]],
    ["duplicate model and date", [row(), row({ outputUsdPerMTok: 12 })]],
  ])("rejects %s", (_label, prices) => {
    expect(() => validateCodexPrices(prices)).toThrow(TypeError);
  });

  it("accepts the same model at different dates", () => {
    expect(() => validateCodexPrices([row(), row({ effectiveFrom: "2026-06-01" })])).not.toThrow();
  });
});
