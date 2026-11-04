import { describe, expect, it } from "vitest";
import { runPure, SimPurityError } from "./pure-run.js";
import { fixedGeometric, hiddenSourceModels, newDateModel, statefulModel } from "./sim-fixtures.test-helpers.js";

describe("runPure", () => {
  it("refuses a model that builds a Date from the clock, and restores Date after", () => {
    const original = Date;

    const run = () => runPure(newDateModel, { p: 1 }, "7");

    expect(run).toThrow(SimPurityError);
    expect(run).toThrow(/new Date\(\)/);
    expect(Date).toBe(original);
    expect(new Date(0).getTime()).toBe(0);
  });

  it.each(hiddenSourceModels)("refuses a model that calls %s", (call, model) => {
    const run = () => runPure(model, { p: 1 }, "7");

    expect(run).toThrow(SimPurityError);
    expect(run).toThrow(call);
  });

  it("restores every trapped source after a refused run", () => {
    const sources = () => [crypto.getRandomValues, crypto.randomUUID, process.hrtime, process.hrtime.bigint, performance.now];
    const originals = sources();

    for (const [, model] of hiddenSourceModels) expect(() => runPure(model, { p: 1 }, "7")).toThrow(SimPurityError);

    expect(sources()).toEqual(originals);
    expect(Object.hasOwn(crypto, "getRandomValues")).toBe(false);
  });

  it("refuses a model whose output differs between two runs on the same seed", () => {
    const run = () => runPure(statefulModel(), { p: 1 }, "7");

    expect(run).toThrow(SimPurityError);
    expect(run).toThrow(/different output on two runs/);
  });

  it("returns the run of a pure model unchanged", () => {
    const run = runPure(fixedGeometric, { p: 0.25 }, "7");

    expect(run.stats["mean-tries"]).toEqual({ value: 4, se: 0 });
  });
});
