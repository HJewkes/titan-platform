import { describe, expect, it } from "vitest";
import { fillSolo } from "./fill-fixtures.test-helpers.js";

const SPOKEN = "Before one queue, after two lanes; before hand checks, after ledger checks.";
const cue = (target: string, atCue: string) => ({ action: "V6", target, atCue });
const compare = { beat: "compare", labels: ["before: One queue", "after: Two lanes", "before: Hand checks", "after: Ledger checks"] };

describe("template fill: compare beats", () => {
  it("pairs the k-th before with the k-th after under Before and After", () => {
    // Arrange / Act
    const found = fillSolo(compare, SPOKEN);

    // Assert
    expect(found.slots).toEqual({
      leftTitle: "Before",
      rightTitle: "After",
      rows: [
        { id: "rows-1", left: "One queue", right: "Two lanes" },
        { id: "rows-2", left: "Hand checks", right: "Ledger checks" },
      ],
    });
  });

  it("lands each side of a row on its own label's cue word", () => {
    // Arrange
    const visual = { ...compare, cues: [cue("rows-1", "Before"), cue("rows-2", "two"), cue("rows-3", "hand"), cue("rows-4", "ledger")] };

    // Act
    const found = fillSolo(visual, SPOKEN);

    // Assert
    expect(found.reveals).toEqual([
      { target: "rows-1", part: "left", atCue: "Before" },
      { target: "rows-1", part: "right", atCue: "two" },
      { target: "rows-2", part: "left", atCue: "hand" },
      { target: "rows-2", part: "right", atCue: "ledger" },
    ]);
  });

  it("falls back to a list when every label is on one side", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "compare", labels: ["before: One queue", "before: Hand checks"] }, SPOKEN);

    // Assert
    expect(found.fallback).toEqual({ from: "compare", reason: expect.stringContaining("both") });
    expect(found.spec).toBe("list");
  });

  it("falls back to a list when the sides have different counts", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "compare", labels: ["before: One queue", "after: Two lanes", "before: Hand checks"] }, SPOKEN);

    // Assert
    expect(found.fallback?.reason).toContain("2 before and 1 after");
  });
});

describe("template fill: misconception beats", () => {
  it("reads the belief and the reality from the first two labels, prefixes dropped", () => {
    // Arrange / Act
    const found = fillSolo({ beat: "misconception", labels: ["myth: The desk guesses", "fact: The desk waits"] });

    // Assert
    expect(found.slots).toEqual({ belief: "The desk guesses", reality: "The desk waits" });
  });
});
