import { describe, expect, it } from "vitest";
import conformance from "../conformance/take-selection.json" with { type: "json" };
import { keepTake, KEEP_TAKE_MARGIN, type WordDistance } from "./retake.js";
import { betterTake, type RankedTake } from "./vet-decide.js";

interface TakeShape {
  hallucinations: number[];
  tail: number | null;
  words: Record<string, WordDistance>;
}

function ranked(shape: TakeShape): RankedTake {
  return {
    hallucinations: shape.hallucinations.map((severity) => ({ severity })),
    tail: shape.tail === null ? null : { length: shape.tail },
    distances: new Map(Object.entries(shape.words)),
    faults: Object.entries(shape.words)
      .filter(([, w]) => w.faulty)
      .map(([word, w]) => ({ kind: "word" as const, word, severity: w.distance, detail: "constructed" })),
  };
}

// Catches: the shared margin drifting from the code, which C2's pytest reads this file to check.
describe("conformance/take-selection.json", () => {
  it("declares the margin the code uses", () => {
    expect(conformance.margin).toBe(KEEP_TAKE_MARGIN);
  });

  it.each(conformance.keepTake)("keepTake: $name", (c) => {
    expect(c.margin).toBe(KEEP_TAKE_MARGIN);
    expect(keepTake(c.shipped, c.take)).toBe(c.kept);
  });

  it.each(conformance.betterTake)("betterTake: $name", (c) => {
    expect(c.margin).toBe(KEEP_TAKE_MARGIN);
    expect(betterTake(ranked(c.best), ranked(c.take))).toBe(c.wins);
  });
});
