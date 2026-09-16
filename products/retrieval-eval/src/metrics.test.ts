import { describe, expect, it } from "vitest";
import { aggregate, matchRanks, scorePair, type ScoredHit } from "./metrics.js";
import type { EvalPair } from "./pairs.js";

function pair(labels: EvalPair["labels"], id = "p1"): EvalPair {
  return { arm: "spawn", id, query: "q", labels, provenance: {} };
}

function hits(...specs: [string, number][]): ScoredHit[] {
  return specs.map(([id, chars]) => ({ id, chars }));
}

const THREE_LABELS = pair([
  { absolute: "/w/a.md", relative: "a.md", ref: "note:w/a.md" },
  { absolute: "/w/b.md", relative: "b.md", ref: "note:w/b.md" },
  { absolute: "/w/c.md" },
]);

describe("matchRanks", () => {
  it("reports 1-based ranks of hits that name a label", () => {
    const ranked = hits(["/w/x.md", 1], ["/w/a.md", 1], ["/w/c.md", 1]);
    expect(matchRanks(ranked, THREE_LABELS)).toEqual([2, 3]);
  });

  it("matches a ref-answering candidate against a path label", () => {
    const ranked: ScoredHit[] = [{ id: "note:w/a.md", chars: 10 }];
    expect(matchRanks(ranked, THREE_LABELS)).toEqual([1]);
  });

  it("matches through an alias when the id itself is unknown", () => {
    const ranked: ScoredHit[] = [{ id: "opaque-id", aliases: ["/w/b.md"], chars: 10 }];
    expect(matchRanks(ranked, THREE_LABELS)).toEqual([1]);
  });

  it("counts one label once even when two hits name it differently", () => {
    const ranked = hits(["/w/a.md", 1], ["note:w/a.md", 1]);
    expect(matchRanks(ranked, THREE_LABELS)).toEqual([1]);
  });

  it("is empty when nothing matches", () => {
    expect(matchRanks(hits(["/w/z.md", 1]), THREE_LABELS)).toEqual([]);
  });
});

describe("scorePair", () => {
  it("divides recall by the label count and precision by k", () => {
    const ranked = hits(["/w/a.md", 10], ["/w/z.md", 10], ["/w/b.md", 10]);
    const score = scorePair(ranked, THREE_LABELS, [5], 5);
    expect(score.relevant).toBe(3);
    expect(score.recallAt[5]).toBeCloseTo(2 / 3);
    expect(score.precisionAt[5]).toBeCloseTo(2 / 5);
  });

  it("caps recall at 1 when a pair has fewer labels than k", () => {
    const one = pair([{ absolute: "/w/a.md" }]);
    const score = scorePair(hits(["/w/a.md", 1]), one, [5], 5);
    expect(score.recallAt[5]).toBe(1);
  });

  it("counts only hits at or above k", () => {
    const ranked = hits(["/w/z.md", 1], ["/w/y.md", 1], ["/w/x.md", 1], ["/w/w.md", 1], ["/w/v.md", 1], ["/w/a.md", 1]);
    const score = scorePair(ranked, THREE_LABELS, [5, 10], 5);
    expect(score.recallAt[5]).toBe(0);
    expect(score.recallAt[10]).toBeCloseTo(1 / 3);
  });

  it("takes the reciprocal of the first matching rank", () => {
    const ranked = hits(["/w/z.md", 1], ["/w/y.md", 1], ["/w/a.md", 1]);
    expect(scorePair(ranked, THREE_LABELS, [5], 5).reciprocalRank).toBeCloseTo(1 / 3);
  });

  it("scores a miss at zero rather than dividing by zero", () => {
    const score = scorePair(hits(["/w/z.md", 1]), THREE_LABELS, [5], 5);
    expect(score.reciprocalRank).toBe(0);
    expect(score.recallAt[5]).toBe(0);
  });

  it("sums injected characters over the budget k only", () => {
    const ranked = hits(["a", 100], ["b", 100], ["c", 100], ["d", 100], ["e", 100], ["f", 100]);
    expect(scorePair(ranked, THREE_LABELS, [5], 5).injectedChars).toBe(500);
  });

  it("deduplicates labels that repeat an absolute path", () => {
    const repeated = pair([{ absolute: "/w/a.md" }, { absolute: "/w/a.md" }]);
    expect(scorePair(hits(["/w/a.md", 1]), repeated, [5], 5).recallAt[5]).toBe(1);
  });
});

describe("aggregate", () => {
  it("macro-averages so a many-label query does not dominate", () => {
    const perfect = scorePair(hits(["/w/a.md", 10]), pair([{ absolute: "/w/a.md" }], "p1"), [5], 5);
    const missed = scorePair(hits(["/w/z.md", 10]), THREE_LABELS, [5], 5);
    const summary = aggregate([perfect, missed], [5]);
    expect(summary.pairs).toBe(2);
    expect(summary.recallAt[5]).toBeCloseTo(0.5);
    expect(summary.mrr).toBeCloseTo(0.5);
    expect(summary.meanInjectedChars).toBe(10);
  });

  it("returns zeros rather than NaN for an empty run", () => {
    const summary = aggregate([], [5, 10]);
    expect(summary.pairs).toBe(0);
    expect(summary.recallAt[10]).toBe(0);
    expect(summary.mrr).toBe(0);
    expect(summary.meanInjectedChars).toBe(0);
  });
});
