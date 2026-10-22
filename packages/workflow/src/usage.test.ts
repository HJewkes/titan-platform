import type { UsageMeasurement } from "@titan-design/agent-protocol";
import { describe, expect, it } from "vitest";
import { addUsage, usageFromMeasurements } from "./usage.js";

function measurement(responseId: string, cost: UsageMeasurement["cost"]): UsageMeasurement {
  return {
    kind: "delta",
    responseId,
    model: "m",
    tokens: { input: 100, output: 10, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: null },
    cost,
    source: "test",
  };
}

describe("usageFromMeasurements", () => {
  it("keeps the priced cost and marks the sum costUnknown when one measurement is unpriced", () => {
    const usage = usageFromMeasurements([measurement("r1", { usd: 0.5, kind: "reported" }), measurement("r2", null)]);

    expect(usage).toEqual({ costUsd: 0.5, inputTokens: 200, outputTokens: 20, costUnknown: true });
  });

  it("leaves costUnknown off when every measurement is priced", () => {
    const usage = usageFromMeasurements([measurement("r1", { usd: 0.5, kind: "reported" }), measurement("r2", { usd: 0.25, kind: "estimate" })]);

    expect(usage).toEqual({ costUsd: 0.75, inputTokens: 200, outputTokens: 20 });
  });
});

describe("usageFromMeasurements cache reads", () => {
  it("carries cached input as cacheReadTokens and leaves it absent when unreported", () => {
    const cached = (id: string) => ({ ...measurement(id, { usd: 0.1, kind: "reported" }), tokens: { ...measurement(id, null).tokens, cachedInput: 300 } });

    expect(usageFromMeasurements([cached("r1"), cached("r2")])).toMatchObject({ cacheReadTokens: 600 });
    expect(usageFromMeasurements([measurement("r2", { usd: 0.1, kind: "reported" })])).not.toHaveProperty("cacheReadTokens");
  });
});

describe("addUsage", () => {
  it("sums cache reads and 5m and 1h writes, and keeps the model when both sides agree", () => {
    const a = { costUsd: 1, cacheReadTokens: 100, cacheWrite5mTokens: 1, cacheWrite1hTokens: 10, model: "m" };
    const b = { costUsd: 1, cacheReadTokens: 50, cacheWrite5mTokens: 2, cacheWrite1hTokens: 20, model: "m" };

    expect(addUsage(a, b)).toEqual({ costUsd: 2, cacheReadTokens: 150, cacheWrite5mTokens: 3, cacheWrite1hTokens: 30, model: "m" });
  });

  it("leaves cache fields absent when neither side has them, and drops a model the sides disagree on", () => {
    expect(addUsage({ costUsd: 1 }, { costUsd: 2 })).toEqual({ costUsd: 3 });
    expect(addUsage({ costUsd: 1, model: "a" }, { costUsd: 1, model: "b" })).toEqual({ costUsd: 2 });
  });

  it("carries costUnknown from either side into the sum", () => {
    expect(addUsage({ costUsd: 1 }, { costUsd: 0, costUnknown: true })).toEqual({ costUsd: 1, costUnknown: true });
    expect(addUsage({ costUsd: 0, costUnknown: true }, { costUsd: 1 })).toEqual({ costUsd: 1, costUnknown: true });
  });
});
