import { describe, expect, it } from "vitest";
import { confirmRule, keepRule, median, type KeepSettings } from "./keep.js";
import type { ArResult } from "./schemas.js";

const SETTINGS: KeepSettings = { direction: "min", singleCallerSlack: 1 };
const BAND = { width: 1, sigma: 0.5 };

const result = (cc: number, extra: Partial<ArResult> = {}): ArResult => ({
  schema: "ar-result/v1",
  seed: "t-alpha",
  repeat: "r1",
  all_gate: true,
  hidden_regressions: 0,
  cc_total_delta_pct: cc,
  single_caller_delta: 0,
  accepted_tasks: 5,
  usd: 0,
  ...extra,
});

const runs = (...values: number[]) => values.map((cc) => result(cc));
const BEST = runs(0, 0, 0);

describe("keep rule", () => {
  it("keeps a better idea only beyond the band: at exactly 2σ it asks for confirm runs instead", () => {
    expect(keepRule(BEST, runs(-1.25, -1.25, -1.25), BAND, SETTINGS)).toMatchObject({ decision: "accept", reason: "beyond-band" });
    expect(keepRule(BEST, runs(-1, -1, -1), BAND, SETTINGS)).toMatchObject({ decision: "confirm", delta: 1 });
  });

  it("rejects an idea no better than the best", () => {
    expect(keepRule(BEST, runs(0.5, 0.5, 0.5), BAND, SETTINGS).decision).toBe("reject");
  });

  it("rejects an idea with a hidden regression in any one run however large its gain", () => {
    const idea = [result(-5), result(-5), result(-5, { hidden_regressions: 1 })];

    expect(keepRule(BEST, idea, BAND, SETTINGS)).toMatchObject({ decision: "reject", reason: "hidden-regression" });
  });

  it("never keeps an eval that accepted no runner task", () => {
    expect(keepRule(BEST, [result(-5), result(-5, { accepted_tasks: 0 }), result(-5)], BAND, SETTINGS).reason).toBe("no-op");
  });

  it("rejects a gain whose single-caller delta rises past the guard", () => {
    const idea = runs(-5, -5, -5).map((run) => ({ ...run, single_caller_delta: 2 }));

    expect(keepRule(BEST, idea, BAND, SETTINGS).reason).toBe("single-caller");
  });

  it("accepts a strict all-gate gain within one σ of the best", () => {
    const best = [result(0, { all_gate: false }), result(0), result(0)];

    expect(keepRule(best, runs(0.4, 0.4, 0.4), BAND, SETTINGS)).toMatchObject({ decision: "accept", reason: "more-all-gate" });
  });

  it("confirms only when both confirm runs beat the best's median", () => {
    expect(confirmRule(BEST, runs(-0.5, -0.5), SETTINGS).decision).toBe("accept");
    expect(confirmRule(BEST, runs(-0.5, 0.1), SETTINGS)).toMatchObject({ decision: "reject", reason: "confirm-lost" });
  });

  it("takes the median of an even count as the mean of the middle two", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
