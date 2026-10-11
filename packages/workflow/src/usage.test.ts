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

describe("addUsage", () => {
  it("carries costUnknown from either side into the sum", () => {
    expect(addUsage({ costUsd: 1 }, { costUsd: 0, costUnknown: true })).toEqual({ costUsd: 1, costUnknown: true });
    expect(addUsage({ costUsd: 0, costUnknown: true }, { costUsd: 1 })).toEqual({ costUsd: 1, costUnknown: true });
  });
});
