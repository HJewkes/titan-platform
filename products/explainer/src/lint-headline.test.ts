import { describe, expect, it } from "vitest";
import { runL0 } from "./eval-l0.js";
import { HEADLINE_CHARS_PER_LINE, headlineCheck, headlineLines } from "./lint-headline.js";
import { GOOD_BEATS, tour, withBeat } from "./voice-flow-fixtures.test-helpers.js";

const THREE_LINES =
  "The parcel desk compares every incoming label against the shelf ledger before anything prints, then refuses the stale ones and tells the courier why at once";
const TWO_LINES = "The parcel desk compares every incoming label against the shelf ledger before anything prints at all";

const rowFor = (headline: string) => {
  const script = tour(withBeat("w2", { extra: { visual: { assertion: headline, job: "artifact-filling" } } }));
  return runL0(script, undefined, [headlineCheck]).find((row) => row.check_id === "Q-V13")!;
};

describe("Q-V13 headline length", () => {
  it("fails a headline that wraps to three lines and names its beat", () => {
    expect(headlineLines(THREE_LINES)).toBe(3);
    expect(rowFor(THREE_LINES)).toMatchObject({ severity: "error", pass: false, detail_beats: ["w2"] });
  });

  it("passes a headline that wraps to two lines", () => {
    expect(headlineLines(TWO_LINES)).toBe(2);
    expect(rowFor(TWO_LINES)).toMatchObject({ pass: true, detail_beats: [] });
  });

  it("passes a script whose headlines are all short", () => {
    const row = runL0(tour(GOOD_BEATS), undefined, [headlineCheck])[0]!;

    expect(row.pass).toBe(true);
  });

  it("counts a single word wider than a line across the lines it needs", () => {
    expect(headlineLines("x".repeat(HEADLINE_CHARS_PER_LINE * 2 + 1))).toBe(3);
  });
});
