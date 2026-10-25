import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../beat-slots.js";
import { freezeSim } from "./freeze.js";
import type { SimModel } from "./model.js";
import { numberFacts, simCheck, type SimBeat, type SimSlots } from "./sim-check.js";
import { fairCoinRetry, fixedGeometric, TOY_DOCTRINE_SHA, toySpec } from "./sim-fixtures.test-helpers.js";
import type { SimModelSpec, SimTolerance } from "./sim-load.js";
import { sweepSim } from "./sweep.js";

// Synthetic toys only: fixed-geometric gives exactly 1 / p tries with no noise; fair-coin-retry is seeded Monte Carlo.
const FACT = "F-toy-mean";

function traceOf(model: SimModel, base: Record<string, number>, values: number[]) {
  return freezeSim(sweepSim(model, base, { param: "p", values }, 7), TOY_DOCTRINE_SHA).trace;
}

const specWith = (tolerance: SimTolerance, fittedFrom: string[] = []): SimModelSpec => ({
  ...toySpec("toy"),
  statistics: { "mean-tries": { tolerance, why: "Synthetic tolerance." } },
  fittedFrom,
});

const slots = (claim?: SimSlots["claim"]): SimSlots => ({
  model: "toy",
  seed: 7,
  params: {},
  sweep: { param: "p", from: 0.25, to: 0.5, steps: 2 },
  ...(claim ? { claim } : {}),
  readouts: [{ id: "mean", label: "Mean tries" }],
});

const beat = (claim?: SimSlots["claim"], spoken = "The tries fall as the coin gets fairer."): SimBeat => ({ id: "s1", spoken, slots: slots(claim) });
const claimAt = (at = 0.25) => ({ fact: FACT, statistic: "mean-tries", at });
const facts = (value: number) => new Map([[FACT, value]]);

describe("simCheck on a claim", () => {
  const exact = traceOf(fixedGeometric, { p: 0.5 }, [0.25, 0.5]);

  it("passes a claim the sim reproduces at the tolerance's edge", () => {
    const verdict = simCheck(exact, beat(claimAt()), facts(4.25), specWith({ abs: 0.25 }));

    expect(verdict).toMatchObject({ beat: "s1", pass: true, claim: 4.25, got: 4, tolerance: 0.25 });
  });

  it("fails E-SIM-MISS just outside the tolerance", () => {
    const verdict = simCheck(exact, beat(claimAt()), facts(4.2500001), specWith({ abs: 0.25 }));

    expect(verdict).toMatchObject({ pass: false, code: "E-SIM-MISS", got: 4 });
  });

  it("fails E-SIM-TOL-NOISE when the tolerance is under three standard errors", () => {
    const noisy = traceOf(fairCoinRetry, { p: 0.5, n: 200 }, [0.5]);
    const se = noisy.runs[0]!.stats["mean-tries"]!.se;

    const verdict = simCheck(noisy, beat(claimAt(0.5)), facts(2), specWith({ abs: 2 * se }));

    expect(verdict).toMatchObject({ pass: false, code: "E-SIM-TOL-NOISE" });
  });

  it.each([
    ["a rel tolerance of 0.12", { rel: 0.12 }],
    ["an abs tolerance above a tenth of the claim", { abs: 0.5 }],
  ])("fails E-SIM-TOL-LOOSE on %s", (_, tolerance) => {
    expect(simCheck(exact, beat(claimAt()), facts(4), specWith(tolerance))).toMatchObject({ pass: false, code: "E-SIM-TOL-LOOSE" });
  });

  it("fails E-SIM-CIRCULAR on a claim about a statistic the model was fitted to", () => {
    const verdict = simCheck(exact, beat(claimAt()), facts(4), specWith({ rel: 0.05 }, ["mean-tries"]));

    expect(verdict).toMatchObject({ pass: false, code: "E-SIM-CIRCULAR" });
  });

  it.each([
    ["no fact has the id", ""],
    ["the fact is a claim, not a number", `{"id":"${FACT}","kind":"claim","value":4}`],
  ])("fails E-SIM-NO-FACT when %s", (_, line) => {
    const verdict = simCheck(exact, beat(claimAt()), numberFacts(line), specWith({ rel: 0.05 }));

    expect(verdict).toMatchObject({ pass: false, code: "E-SIM-NO-FACT" });
  });

  it.each([
    ["the claim is at a point the sweep never ran", claimAt(0.3)],
    ["the claim names a statistic the doctrine does not declare", { fact: FACT, statistic: "toString", at: 0.25 }],
  ])("fails E-SIM-NO-RUN when %s", (_, claim) => {
    expect(simCheck(exact, beat(claim), facts(4), specWith({ rel: 0.05 }))).toMatchObject({ pass: false, code: "E-SIM-NO-RUN" });
  });
});

describe("simCheck on an illustrative sim", () => {
  const exact = traceOf(fixedGeometric, { p: 0.5 }, [0.25, 0.5]);

  it("passes unchecked when the narration states no number", () => {
    expect(simCheck(exact, beat(), facts(4), specWith({ rel: 0.05 }))).toMatchObject({ pass: true });
  });

  it.each([["in digits", "The sim lands at 1.6 tries."], ["spelled out", "The sim lands at four tries."]])("fails E-SIM-UNCHECKED-NUMBER on a number %s", (_, spoken) => {
    expect(simCheck(exact, beat(undefined, spoken), facts(4), specWith({ rel: 0.05 }))).toMatchObject({ pass: false, code: "E-SIM-UNCHECKED-NUMBER" });
  });
});

describe("the sim slot", () => {
  it("refuses a claim that carries its own claimed value", () => {
    expect(BEAT_SLOTS.sim.safeParse({ ...slots(), claim: { ...claimAt(), value: 4 } }).success).toBe(false);
  });

  it("refuses a claim that carries its own tolerance", () => {
    expect(BEAT_SLOTS.sim.safeParse({ ...slots(), claim: { ...claimAt(), tolerance: 0.5 } }).success).toBe(false);
  });
});
