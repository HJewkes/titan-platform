import { describe, expect, it } from "vitest";
import { toIdea } from "./queue.js";
import type { Outcome } from "./schemas.js";
import { betaDraw, reward, seededRandom, select } from "./select.js";
import { proposal } from "./test-support/fake-ports.js";

const QUEUE = ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => toIdea(proposal(name), { round: 1, lineageOf: new Map() }));

const outcome = (lineage: string, extra: Partial<Outcome>): Outcome => ({
  ideaId: lineage, lineage, cell: "accept-gate:x", verdict: "rejected", reason: "not-better", rungReached: "L3", runs: [], ...extra,
});

describe("Thompson selection", () => {
  it("picks the same ideas with the same draws when a round is replayed", () => {
    const options = { runId: "run-1", round: 2, k: 4 };

    const first = select(QUEUE, [], options);
    const replay = select(QUEUE, [], options);

    expect(replay).toEqual(first);
    expect(first.picks).toHaveLength(4);
    expect(select(QUEUE, [], { ...options, round: 3 }).draws).not.toEqual(first.draws);
  });

  it("favours a lineage with a kept idea over ones with nothing to show", () => {
    const history = Array.from({ length: 12 }, () => outcome(QUEUE[0]!.lineage, { verdict: "kept" }));
    const losers = QUEUE.slice(1).flatMap((idea) => Array.from({ length: 12 }, () => outcome(idea.lineage, { rungReached: "L0" })));

    const picked = Array.from({ length: 20 }, (_, round) => select(QUEUE, [...history, ...losers], { runId: "run-1", round, k: 1 }).picks[0]!.id);

    expect(picked.filter((id) => id === QUEUE[0]!.id).length).toBeGreaterThanOrEqual(18);
  });

  it("maps outcomes to rewards from kept down to an L0 stop", () => {
    expect(reward(outcome("x", { verdict: "kept" }))).toBe(1);
    expect(reward(outcome("x", { reason: "confirm-lost" }))).toBe(0.6);
    expect(reward(outcome("x", { rungReached: "L2" }))).toBe(0.1);
    expect(reward(outcome("x", { rungReached: "L0" }))).toBe(0);
  });

  it("draws Beta values inside (0, 1) with the right mean", () => {
    const random = seededRandom("beta");
    const draws = Array.from({ length: 4000 }, () => betaDraw({ alpha: 2, beta: 6 }, random));

    expect(draws.every((value) => value > 0 && value < 1)).toBe(true);
    expect(draws.reduce((sum, value) => sum + value, 0) / draws.length).toBeCloseTo(0.25, 1);
  });
});
