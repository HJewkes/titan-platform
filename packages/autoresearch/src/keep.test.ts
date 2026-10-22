import { describe, expect, it } from "vitest";
import { confirmRule, keepRule, median, type KeepSettings } from "./keep.js";
import { ArResultSchema, resultSchemaFor, type ArResult } from "./schemas.js";

const SETTINGS: KeepSettings = {
  primary: { name: "cc_total_delta_pct", direction: "min" },
  guards: { single_caller_delta: 1 },
  zeroTolerance: ["hidden_regressions"],
  allGate: true,
  noOp: "accepted_tasks",
};
const BAND = { width: 1, sigma: 0.5 };

interface Extra {
  all_gate?: boolean;
  hidden_regressions?: number;
  single_caller_delta?: number;
  accepted_tasks?: number;
}

const result = (cc: number, extra: Extra = {}): ArResult => ({
  schema: "ar-result/v2",
  case: "t-alpha",
  repeat: "r1",
  metrics: { cc_total_delta_pct: cc, single_caller_delta: extra.single_caller_delta ?? 0, accepted_tasks: extra.accepted_tasks ?? 5 },
  gates: { all_gate: extra.all_gate ?? true },
  violations: { hidden_regressions: extra.hidden_regressions ?? 0 },
  usd: 0,
  wall_s: 0,
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

    expect(keepRule(BEST, idea, BAND, SETTINGS)).toMatchObject({ decision: "reject", reason: "violation:hidden_regressions" });
  });

  it("never keeps an eval that accepted no runner task", () => {
    expect(keepRule(BEST, [result(-5), result(-5, { accepted_tasks: 0 }), result(-5)], BAND, SETTINGS).reason).toBe("no-op");
  });

  it("rejects a gain whose single-caller delta rises past the guard", () => {
    const idea = [-5, -5, -5].map((cc) => result(cc, { single_caller_delta: 2 }));

    expect(keepRule(BEST, idea, BAND, SETTINGS).reason).toBe("guard:single_caller_delta");
  });

  it("rejects a gain whose max-direction guard metric falls, and keeps one where it holds", () => {
    const settings: KeepSettings = { ...SETTINGS, guards: { accepted_tasks: { slack: 0, direction: "max" } }, noOp: undefined };
    const idea = (served: number) => [-5, -5, -5].map((cc) => result(cc, { accepted_tasks: served }));

    expect(keepRule(BEST, idea(4), BAND, settings).reason).toBe("guard:accepted_tasks");
    expect(keepRule(BEST, idea(6), BAND, settings).decision).toBe("accept");
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

describe("result schema for a target", () => {
  const parse = (metric: Partial<KeepSettings>, value: ArResult) =>
    resultSchemaFor({ ...SETTINGS, ...metric, noise: { bandSigmas: 2, lockAfterPairs: 5, minPairs: 3, defaultBand: 1.5 } }).safeParse(value);

  it("rejects an allGate target's result that carries no gates", () => {
    const parsed = parse({ allGate: true }, { ...result(0), gates: {} });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toContainEqual(["gates"]);
  });

  it("rejects a zero-tolerance target's result that omits that violation count", () => {
    const parsed = parse({ zeroTolerance: ["x"] }, result(0));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toContainEqual(["violations", "x"]);
  });

  it("keeps the scorer's rung, evaluator pin and artifact dir", () => {
    const line = { ...result(0), rung: "seed", evaluator_pin: "0123abc", artifact_dir: "runs/r1" };

    expect(ArResultSchema.parse(line)).toMatchObject({ rung: "seed", evaluator_pin: "0123abc", artifact_dir: "runs/r1" });
  });

  it("accepts a result that carries the gates and violations the target names", () => {
    expect(parse({}, result(0)).success).toBe(true);
  });
});
