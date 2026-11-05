import { PRICE_TABLE_VERSION, priceRequest } from "@titan-design/agent-protocol/pricing";
import { describe, expect, it } from "vitest";
import { BASELINE_USD, foldCost, formatCostReport, type UsageEntry } from "./cost.js";

const ASOF = "2026-10-20T00:00:00Z";

const entries: UsageEntry[] = [
  { stage: "screen", model: "claude-haiku-5-5", inputTokens: 1_000_000, cacheWrite1hTokens: 2_000_000, cacheReadTokens: 3_000_000, outputTokens: 100_000 },
  { stage: "screen", model: "claude-haiku-5-5", inputTokens: 1_000_000 },
  { stage: "confirm", model: "claude-sonnet-5-5", inputTokens: 500_000, outputTokens: 50_000 },
];

describe("foldCost", () => {
  it("prices the fold at PRICE_TABLE rates by hand-computed USD", () => {
    const haiku = priceRequest({ inputTokens: 1_000_000, cacheCreation1hTokens: 2_000_000, cacheReadTokens: 3_000_000, outputTokens: 100_000 }, "claude-haiku-5-5", ASOF);
    const haikuIn = priceRequest({ inputTokens: 1_000_000 }, "claude-haiku-5-5", ASOF);
    const sonnet = priceRequest({ inputTokens: 500_000, outputTokens: 50_000 }, "claude-sonnet-5-5", ASOF);

    const report = foldCost(entries, { asOf: ASOF });

    expect(report.totalUsd).toBeCloseTo(haiku.costUsd + haikuIn.costUsd + sonnet.costUsd, 10);
    expect(report.totalUsd).toBeGreaterThan(0);
    const screen = report.lines.find((l) => l.stage === "screen")!;
    expect(screen.calls).toBe(2);
    expect(screen.inputTokens).toBe(2_000_000);
    expect(screen.cacheWrite1hTokens).toBe(2_000_000);
  });

  it("charges the 1h write rate, not the 5m rate", () => {
    const report = foldCost([{ stage: "s", model: "claude-haiku-5-5", cacheWrite1hTokens: 1_000_000 }], { asOf: ASOF });

    expect(report.totalUsd).toBeCloseTo(priceRequest({ cacheCreation1hTokens: 1_000_000 }, "claude-haiku-5-5", ASOF).costUsd, 10);
    expect(report.totalUsd).not.toBeCloseTo(priceRequest({ cacheCreation5mTokens: 1_000_000 }, "claude-haiku-5-5", ASOF).costUsd, 10);
  });

  it("leaves cache fields absent when no entry carried them", () => {
    const report = foldCost([{ stage: "s", model: "claude-haiku-5-5", inputTokens: 10 }], { asOf: ASOF });

    expect(report.lines[0]!.cacheReadTokens).toBeUndefined();
    expect(report.hasCacheTokens).toBe(false);
  });

  it("computes the ratio to the baseline", () => {
    const report = foldCost([{ stage: "s", model: "claude-sonnet-5-5", outputTokens: 1_000_000 }], { asOf: ASOF, baselineUsd: BASELINE_USD });

    expect(report.baselineRatio).toBeCloseTo(report.totalUsd / 19.1, 10);
  });

  it("flags an unpriced model and a CLI cost gap over 1%", () => {
    const report = foldCost(
      [
        { stage: "a", model: "mystery-1", inputTokens: 5 },
        { stage: "b", model: "claude-haiku-5-5", inputTokens: 1_000_000, cliCostUsd: 5 },
      ],
      { asOf: ASOF },
    );

    expect(report.unpricedModels).toEqual(["mystery-1"]);
    expect(report.cliGapExceeds1Pct).toBe(true);
  });
});

describe("formatCostReport", () => {
  it("shows cache columns, the price table version and the baseline ratio", () => {
    const text = formatCostReport(foldCost(entries, { asOf: ASOF, baselineUsd: 19.1 }));

    expect(text).toContain("cache read");
    expect(text).toContain("cache write 1h");
    expect(text).toContain(PRICE_TABLE_VERSION.toString());
    expect(text).toMatch(/of \$19\.10 baseline/);
  });

  it("omits cache columns when no entry carried them", () => {
    const text = formatCostReport(foldCost([{ stage: "s", model: "claude-haiku-5-5", inputTokens: 10 }], { asOf: ASOF }));

    expect(text).not.toContain("cache read");
  });
});
