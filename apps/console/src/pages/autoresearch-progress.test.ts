import { describe, expect, it } from "vitest";
import type { ArLadder, ArOutcome, ArRunView } from "../../server/autoresearch-view.js";
import { AR_RUN_FIXTURE } from "../../server/twin/autoresearch.js";
import { bandFor, runProgress } from "./autoresearch-progress.js";

const NOISE = AR_RUN_FIXTURE.target.metric.noise;

function decided(id: string, minute: number, outcome: ArOutcome, scores: readonly number[]): ArLadder {
  const template = AR_RUN_FIXTURE.rounds[0]!.ladders[0]!;
  return {
    ...template,
    idea: { ...template.idea, id },
    completed: [{ stepId: `ar-release:1/${id}`, completedAt: new Date(Date.UTC(2026, 9, 20, 12, minute)).toISOString() }],
    evals: scores.map((score, index) => ({ ...template.evals[0]!, repeat: `r${index + 1}`, metrics: { score } })),
    outcome,
  };
}

function runWith(...ladders: ArLadder[]): ArRunView {
  const [first] = AR_RUN_FIXTURE.rounds;
  return { ...AR_RUN_FIXTURE, baseline: { ...AR_RUN_FIXTURE.baseline, b0: 234 }, rounds: [{ ...first!, ladders }] };
}

const kept = (sigma = 0.6): ArOutcome => ({ verdict: "kept", reason: "beyond-band", rungReached: "L3", sigma });
const rejected: ArOutcome = { verdict: "rejected", reason: "clearly-worse", rungReached: "L2", sigma: 0.6 };

describe("autoresearch best-so-far", () => {
  it("steps only on kept points and draws a rejected point without moving the line", () => {
    const run = runWith(decided("i-a", 1, rejected, [229, 229.5, 230]), decided("i-b", 2, kept(), [232, 232.4, 232.2]), decided("i-c", 3, rejected, [228]));

    const { points, samples } = runProgress(run);

    expect(points.map((point) => [point.id, point.primary])).toEqual([["i-a", 229.5], ["i-b", 232.2], ["i-c", 228]]);
    expect(samples.map((sample) => sample.best)).toEqual([234, 234, 232.2, 232.2]);
  });

  it("orders points by when each idea was decided, not by round order", () => {
    const run = runWith(decided("i-late", 9, kept(), [231]), decided("i-early", 1, kept(), [233]));

    const { samples } = runProgress(run);

    expect(samples.map((sample) => sample.best)).toEqual([234, 233, 231]);
  });

  it("plots an L0 stop with no primary and leaves best-so-far alone", () => {
    const l0: ArOutcome = { verdict: "kept", reason: "beyond-band", rungReached: "L0" };

    const { points, samples } = runProgress(runWith(decided("i-l0", 1, l0, [])));

    expect(points[0]?.primary).toBeNull();
    expect(samples.map((sample) => sample.best)).toEqual([234, 234]);
  });

  it("keeps only the baseline sample for a run with no decision yet", () => {
    const { points, samples, lockedAt } = runProgress(runWith());

    expect(points).toEqual([]);
    expect(samples).toEqual([{ order: 0, at: AR_RUN_FIXTURE.startedAt, best: 234, band: { halfWidth: NOISE.defaultBandPp, locked: false } }]);
    expect(lockedAt).toBeUndefined();
  });
});

describe("autoresearch σ band", () => {
  it("uses the unlocked default while σ is small and has no pair count", () => {
    expect(bandFor(NOISE, { sigma: 0.5 })).toEqual({ halfWidth: 1.5, locked: false });
  });

  it("widens the unlocked band past the default when 2σ_est is larger", () => {
    expect(bandFor(NOISE, { sigma: 1, pairs: 4 })).toEqual({ halfWidth: 2, locked: false });
  });

  it("uses bandSigmas times the locked σ from the fifth pair on, narrower than the default", () => {
    expect(bandFor(NOISE, { sigma: 0.5, pairs: 5 })).toEqual({ halfWidth: 1, locked: true });
  });

  it("marks the first decision judged against a locked σ", () => {
    const four = { ...kept(0.5), against: { sigma: 0.5, pairs: 4 } };
    const five = { ...rejected, against: { sigma: 0.4, pairs: 5 } };

    const { samples, lockedAt } = runProgress(runWith(decided("i-a", 1, four, [233]), decided("i-b", 2, five, [235])));

    expect(samples.map((sample) => sample.band)).toEqual([
      { halfWidth: 1.5, locked: false },
      { halfWidth: 1.5, locked: false },
      { halfWidth: 0.8, locked: true },
    ]);
    expect(lockedAt?.order).toBe(2);
  });

  it("stays locked when a later outcome carries no noise record", () => {
    const five = { ...kept(0.5), against: { sigma: 0.5, pairs: 5 } };

    const { samples } = runProgress(runWith(decided("i-a", 1, five, [233]), decided("i-b", 2, rejected, [235])));

    expect(samples.at(-1)?.band).toEqual({ halfWidth: 1, locked: true });
  });
});
