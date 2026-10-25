import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../eval-store.js";
import { freezeSim } from "../freeze.js";
import { SIM_MODELS } from "../model.js";
import { runPure } from "../pure-run.js";
import { simCheck, type SimBeat } from "../sim-check.js";
import { loadSims, simDoctrineSha } from "../sim-load.js";
import { sweepSim } from "../sweep.js";
import { fitLaterRoundPass, reviewRounds } from "./review-rounds.js";

// Invented (p1, q) points only: no published review numbers appear in this file.
const PRS = 20000;
const meanOf = (p1: number, q: number): number => 1 + (1 - p1) / q;
const share5plusOf = (p1: number, q: number): number => (1 - p1) * (1 - q) ** 3;

describe("the review-rounds model against its closed form", () => {
  it.each([
    [0.4, 0.3],
    [0.55, 0.45],
    [0.85, 0.6],
  ])("puts mean reviews and the 5+ share within 3 se of the closed form at p1=%s, q=%s", (p1, q) => {
    const params = { p1, q, prs: PRS };

    const { stats } = runPure(reviewRounds, params, "closed-form");

    const mean = stats["mean-reviews"]!;
    const tail = stats["share-5plus"]!;
    expect(Math.abs(mean.value - meanOf(p1, q))).toBeLessThanOrEqual(3 * mean.se);
    expect(Math.abs(tail.value - share5plusOf(p1, q))).toBeLessThanOrEqual(3 * tail.se);
  });

  it("gives byte-equal output for one seed and different output for another", () => {
    const params = { p1: 0.45, q: 0.35, prs: 2000 };

    const [first, again, other] = ["s-1", "s-1", "s-2"].map((seed) => canonicalJson(runPure(reviewRounds, params, seed)));

    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });
});

describe("the review-rounds doctrine", () => {
  const spec = loadSims().get("review-rounds")!;
  const p1 = 0.42;
  const facts = new Map([
    ["F-synthetic-tail", share5plusOf(p1, 0.33)],
    ["F-synthetic-mean", meanOf(p1, 0.33)],
  ]);
  const fitted = fitLaterRoundPass(p1, facts.get("F-synthetic-tail")!);
  const trace = freezeSim(sweepSim(SIM_MODELS["review-rounds"]!, { p1, q: fitted, prs: PRS }, { param: "p1", values: [p1, 0.6] }, 3), simDoctrineSha(spec)).trace;
  const beat = (fact: string, statistic: string): SimBeat => ({
    id: "s-rounds",
    spoken: "Later rounds carry the rest.",
    slots: { model: "review-rounds", seed: 3, params: { q: fitted }, sweep: { param: "p1", from: p1, to: 0.6, steps: 2 }, claim: { fact, statistic, at: p1 }, readouts: [{ id: "mean", label: "Mean reviews" }] },
  });

  it("accepts a mean predicted from q fitted to the 5+ tail", () => {
    const verdict = simCheck(trace, beat("F-synthetic-mean", "mean-reviews"), facts, spec);

    expect(verdict).toMatchObject({ pass: true, claim: meanOf(p1, 0.33) });
  });

  it("refuses a claim on the 5+ tail that fitted q as E-SIM-CIRCULAR", () => {
    const verdict = simCheck(trace, beat("F-synthetic-tail", "share-5plus"), facts, spec);

    expect(verdict).toMatchObject({ pass: false, code: "E-SIM-CIRCULAR" });
  });
});
