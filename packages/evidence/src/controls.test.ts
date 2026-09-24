import { describe, expect, it } from "vitest";
import { pickControls, placeControls, scoreControls } from "./controls.js";

const pool = Array.from({ length: 20 }, (_, i) => `control-${i}`);
const items = Array.from({ length: 10 }, (_, i) => `item-${i}`);

describe("pickControls and placeControls", () => {
  it("gives the same picks and positions for the same seed", () => {
    const first = pickControls(pool, "run-7", 4);
    expect(pickControls(pool, "run-7", 4)).toEqual(first);
    expect(placeControls(items, first, "run-7").positions).toEqual(placeControls(items, first, "run-7").positions);
  });

  it("gives different picks or positions for different seeds", () => {
    const seeds = ["a", "b", "c", "d"].map((seed) => JSON.stringify([pickControls(pool, seed, 4), placeControls(items, ["x"], seed).positions]));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it("picks distinct pool entries and caps n at the pool size", () => {
    expect(new Set(pickControls(pool, 1, 4)).size).toBe(4);
    expect(pickControls(pool.slice(0, 3), 1, 10)).toHaveLength(3);
  });

  it("keeps every item in order and reports where each control landed", () => {
    const { sequence, positions } = placeControls(items, ["x", "y"], "s");
    expect(sequence.filter((e) => e.kind === "item").map((e) => e.value)).toEqual(items);
    expect(positions.map((p) => sequence[p]?.value)).toEqual(["x", "y"]);
  });
});

describe("scoreControls", () => {
  const expected = [
    { id: "c1", label: "confirmed" },
    { id: "c2", label: "confirmed" },
    { id: "c3", label: "justified" },
    { id: "c4", label: "justified" },
  ];

  it("computes per-label precision and recall and counts missing answers", () => {
    const answered = [
      { id: "c1", label: "confirmed" },
      { id: "c3", label: "confirmed" },
      { id: "c4", label: "justified" },
      { id: "stray", label: "justified" },
    ];
    const score = scoreControls(expected, answered);
    expect(score).toMatchObject({ total: 4, correct: 2, missing: 1, accuracy: 0.5 });
    expect(score.perLabel.confirmed).toEqual({ expected: 2, answered: 2, correct: 1, precision: 0.5, recall: 0.5 });
    expect(score.perLabel.justified).toEqual({ expected: 2, answered: 1, correct: 1, precision: 1, recall: 0.5 });
  });

  it("reports null precision for a label nobody answered and null accuracy with no controls", () => {
    expect(scoreControls(expected, []).perLabel.confirmed?.precision).toBeNull();
    expect(scoreControls([], []).accuracy).toBeNull();
  });
});
