import { describe, expect, it } from "vitest";
import { freezeSim } from "./freeze.js";
import { fixedGeometric, TOY_DOCTRINE_SHA } from "./sim-fixtures.test-helpers.js";
import { sweepSim } from "./sweep.js";
import { SimTraceSchema } from "./trace-schema.js";

const stepTrack = (count: number) => Array.from({ length: count }, (_, i) => ({ i, state: { open: 1 / (i + 1) } }));

const validTrace = () => freezeSim(sweepSim(fixedGeometric, { p: 0.5 }, { param: "p", values: [0.5] }, 1), TOY_DOCTRINE_SHA).trace;

const withRun = (run: Record<string, unknown>) => {
  const trace = validTrace();
  return { ...trace, runs: [{ ...trace.runs[0], ...run }] };
};

describe("explainer.sim-trace/v1", () => {
  it("accepts a run of 64 steps and rejects one of 65", () => {
    const atCap = withRun({ steps: stepTrack(64) });
    const overCap = withRun({ steps: stepTrack(65) });

    const accepted = SimTraceSchema.safeParse(atCap);
    const rejected = SimTraceSchema.safeParse(overCap);

    expect(accepted.success).toBe(true);
    expect(rejected.error?.issues.map((issue) => issue.path.join("."))).toEqual(["runs.0.steps"]);
  });

  it("rejects a run with no stats, and one with empty stats", () => {
    const missing = withRun({ stats: undefined });
    const empty = withRun({ stats: {} });

    expect(SimTraceSchema.safeParse(missing).error?.issues.map((issue) => issue.path.join("."))).toEqual(["runs.0.stats"]);
    expect(SimTraceSchema.safeParse(empty).error?.message).toMatch(/at least one statistic/);
  });

  it("rejects a negative standard error and a doctrine that is not a sha256", () => {
    const negative = withRun({ stats: { "mean-tries": { value: 2, se: -1 } } });
    const badDoctrine = { ...validTrace(), doctrine: "not-a-sha" };

    expect(SimTraceSchema.safeParse(negative).success).toBe(false);
    expect(SimTraceSchema.safeParse(badDoctrine).error?.message).toMatch(/sha256/);
  });

  it("makes sweepSim throw on a run the schema rejects", () => {
    const tooLong = { ...fixedGeometric, simulate: () => ({ steps: stepTrack(65), stats: { "mean-tries": { value: 2, se: 0 } } }) };

    const run = () => sweepSim(tooLong, { p: 0.5 }, { param: "p", values: [0.5] }, 1);

    expect(run).toThrow(/steps/);
  });
});
