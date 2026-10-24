import { describe, expect, it } from "vitest";
import { freezeSim, traceShaHolds } from "./freeze.js";
import { SimPurityError } from "./pure-run.js";
import { fairCoinRetry, mathRandomModel, TOY_DOCTRINE_SHA, wallClockModel } from "./sim-fixtures.test-helpers.js";
import { sweepSim } from "./sweep.js";
import { SimTraceSchema } from "./trace-schema.js";

const BASE = { p: 0.5, n: 400 };
const statsAt = (trace: ReturnType<typeof freezeSim>["trace"], p: number) => trace.runs.find((run) => run.at.p === p)?.stats;

describe("sweepSim and freezeSim", () => {
  it("gives byte-equal canonical JSON and the same sha for the same model, params and seed", () => {
    const axis = { param: "p", values: [0.3, 0.5] };

    const first = freezeSim(sweepSim(fairCoinRetry, BASE, axis, 7), TOY_DOCTRINE_SHA);
    const second = freezeSim(sweepSim(fairCoinRetry, BASE, axis, 7), TOY_DOCTRINE_SHA);

    expect(second.json).toBe(first.json);
    expect(second.sha).toBe(first.sha);
    expect(first.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives a different trace for a different seed", () => {
    const axis = { param: "p", values: [0.5] };

    const seven = freezeSim(sweepSim(fairCoinRetry, BASE, axis, 7), TOY_DOCTRINE_SHA);
    const eight = freezeSim(sweepSim(fairCoinRetry, BASE, axis, 8), TOY_DOCTRINE_SHA);

    expect(eight.sha).not.toBe(seven.sha);
    expect(statsAt(eight.trace, 0.5)).not.toEqual(statsAt(seven.trace, 0.5));
  });

  it("leaves the other points' runs unchanged when a sweep point is added", () => {
    const narrow = freezeSim(sweepSim(fairCoinRetry, BASE, { param: "p", values: [0.3, 0.5] }, 7), TOY_DOCTRINE_SHA);

    const wide = freezeSim(sweepSim(fairCoinRetry, BASE, { param: "p", values: [0.3, 0.4, 0.5] }, 7), TOY_DOCTRINE_SHA);

    expect(statsAt(wide.trace, 0.3)).toEqual(statsAt(narrow.trace, 0.3));
    expect(statsAt(wide.trace, 0.5)).toEqual(statsAt(narrow.trace, 0.5));
    expect(wide.trace.runs).toHaveLength(3);
  });

  it("runs one panel per facet value, each point on its own seed", () => {
    const axis = { param: "p", values: [0.3, 0.5] };

    const faceted = freezeSim(sweepSim(fairCoinRetry, BASE, axis, 7, { param: "n", values: [200, 400] }), TOY_DOCTRINE_SHA);

    expect(faceted.trace.runs.map((run) => run.at)).toEqual([
      { p: 0.3, n: 200 },
      { p: 0.5, n: 200 },
      { p: 0.3, n: 400 },
      { p: 0.5, n: 400 },
    ]);
    expect(faceted.trace.facet).toEqual({ param: "n", values: [200, 400] });
  });

  it("estimates the toy's closed-form mean within three standard errors", () => {
    const { trace } = freezeSim(sweepSim(fairCoinRetry, { p: 0.25, n: 2000 }, { param: "p", values: [0.25] }, "toy"), TOY_DOCTRINE_SHA);

    const stat = trace.runs[0]!.stats["mean-tries"]!;

    expect(Math.abs(stat.value - 4)).toBeLessThan(3 * stat.se);
  });

  it("refuses a model that calls Math.random, and restores Math.random after", () => {
    const original = Math.random;

    const run = () => sweepSim(mathRandomModel, { p: 1 }, { param: "p", values: [1] }, 7);

    expect(run).toThrow(SimPurityError);
    expect(run).toThrow(/Math\.random/);
    expect(Math.random).toBe(original);
  });

  it("refuses a model that reads Date.now, and restores Date.now after", () => {
    const original = Date.now;

    const run = () => sweepSim(wallClockModel, { p: 1 }, { param: "p", values: [1] }, 7);

    expect(run).toThrow(/Date\.now/);
    expect(Date.now).toBe(original);
  });

  it("refuses a sweep param that a plain object only inherits", () => {
    for (const param of ["toString", "constructor", "__proto__"]) {
      expect(() => sweepSim(fairCoinRetry, BASE, { param, values: [1] }, 7)).toThrow(new RegExp(`${param} is not a model param`));
    }
  });

  it("refuses a swept or faceted param the model does not take, and a facet on the swept param", () => {
    const axis = { param: "p", values: [0.5] };

    expect(() => sweepSim(fairCoinRetry, BASE, { param: "q", values: [0.5] }, 7)).toThrow(/q is not a model param/);
    expect(() => sweepSim(fairCoinRetry, BASE, axis, 7, { param: "p", values: [0.4] })).toThrow(/also the swept param/);
    expect(() => sweepSim(fairCoinRetry, BASE, { param: "p", values: [0.5, 0.5] }, 7)).toThrow(/repeats a value/);
  });

  it("round-trips a frozen trace through the schema with its sha intact", () => {
    const frozen = freezeSim(sweepSim(fairCoinRetry, BASE, { param: "p", values: [0.3, 0.5] }, 7), TOY_DOCTRINE_SHA);

    const reread = SimTraceSchema.parse(JSON.parse(frozen.json));

    expect(reread).toEqual(frozen.trace);
    expect(traceShaHolds(reread)).toBe(true);
    expect(traceShaHolds({ ...reread, seed: 8 })).toBe(false);
  });
});
