import { describe, expect, it } from "vitest";
import type { SimModel } from "./model.js";
import { runSimPass, type SimPassInput } from "./sim-resolve.js";
import { toySpec } from "./sim-fixtures.test-helpers.js";

// Synthetic: below its doctrine min this model would never terminate; a step budget turns that into a throw so a regression fails instead of hanging.
const spinBelowMin: SimModel<{ p: number }> = {
  id: "spin",
  version: "1",
  simulate: ({ p }) => {
    for (let spent = 0; p < 0.05; spent++) if (spent > 1e6) throw new Error("runaway below min");
    return { steps: [{ i: 0, state: { p } }], stats: { "mean-tries": { value: 1 / p, se: 0 } } };
  },
};

const input = (slots: Record<string, unknown>): SimPassInput => ({
  beats: [{ id: "b1", spoken: "A synthetic beat.", visual: { beat: "sim" } as never }],
  filled: new Map([["b1", { slots: { model: "spin", seed: 1, params: {}, sweep: { param: "p", from: 0.5, to: 1, steps: 2 }, readouts: [{ id: "m", label: "Mean" }], ...slots } }]]),
  facts: undefined,
  registry: { models: { spin: spinBelowMin as SimModel }, specs: new Map([["spin", toySpec("spin")]]) },
  putTrace: () => "0".repeat(64),
});

describe("sweepBeat doctrine bounds", () => {
  it("refuses a sweep that starts below the min before the model runs, naming the param", () => {
    const { traces } = runSimPass(input({ sweep: { param: "p", from: 0, to: 0.5, steps: 2 } }));

    expect(traces.verdicts[0]).toMatchObject({ pass: false, code: "E-SIM-NO-RUN", detail: expect.stringMatching(/swept value p = 0 .*\[0\.05, 1\]/) });
  }, 2000);

  it("refuses a fixed param above its max", () => {
    const { traces } = runSimPass(input({ params: { n: 20000 } }));

    expect(traces.verdicts[0]).toMatchObject({ code: "E-SIM-NO-RUN", detail: expect.stringContaining("param n = 20000") });
  });

  it("still runs a sweep inside the bounds", () => {
    const { traces } = runSimPass(input({}));

    expect(traces.verdicts[0]?.code).not.toBe("E-SIM-NO-RUN");
    expect(traces.traces.b1).toBeDefined();
  });
});
