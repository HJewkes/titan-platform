import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../eval-store.js";
import { freezeSim } from "../freeze.js";
import { SIM_MODELS } from "../model.js";
import { runPure } from "../pure-run.js";
import { simCheck, type SimBeat } from "../sim-check.js";
import { loadSims, simDoctrineSha } from "../sim-load.js";
import { runSimPass } from "../sim-resolve.js";
import { sweepSim } from "../sweep.js";
import { fitLaterRoundPass, MAX_REVIEW_PRS, MIN_LATER_PASS, reviewRounds } from "./review-rounds.js";

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

  it("declares bounds the model can run", () => {
    expect(spec.params.q!.min).toBeGreaterThanOrEqual(MIN_LATER_PASS);
    expect(spec.params.prs!.max).toBeLessThanOrEqual(MAX_REVIEW_PRS);
  });
});

describe("review-rounds params the model cannot run", () => {
  const slots = (params: Record<string, number>, sweep: { param: string; from: number; to: number }) => ({
    model: "review-rounds",
    seed: 3,
    params,
    sweep: { ...sweep, steps: 2 },
    readouts: [{ id: "mean", label: "Mean reviews" }],
  });
  const verdictOf = (filled: ReturnType<typeof slots>) =>
    runSimPass({
      beats: [{ id: "s-rounds", spoken: "Later rounds carry the rest.", visual: { beat: "sim" } }],
      filled: new Map([["s-rounds", { slots: filled }]]),
      facts: undefined,
      registry: { models: SIM_MODELS, specs: loadSims() },
      putTrace: () => "0".repeat(64),
    }).traces.verdicts[0];

  it.each([
    ["a sweep of q from 0, which would never end a PR", slots({}, { param: "q", from: 0, to: 0.5 }), /needs q/],
    ["a sweep of q from under its floor", slots({}, { param: "q", from: 0.01, to: 0.5 }), /needs q/],
    ["prs far above its max", slots({ prs: 1e9 }, { param: "p1", from: 0.3, to: 0.6 }), /needs a whole prs/],
  ])("cuts %s as E-SIM-NO-RUN", (_, filled, detail) => {
    expect(verdictOf(filled)).toMatchObject({ pass: false, code: "E-SIM-NO-RUN", detail: expect.stringMatching(detail) });
  });

  it.each([
    ["a share at 1 - p1, which needs q = 0", 0.4, 0.6],
    ["a share needing q under its floor", 0.4, 0.55],
    ["p1 = 1, where no PR reaches round 2", 1, 0.01],
  ])("refuses to fit q from %s", (_, p1, share) => {
    expect(() => fitLaterRoundPass(p1, share)).toThrow(RangeError);
  });
});
