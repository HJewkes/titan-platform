import { describe, expect, it } from "vitest";
import { v4Durations } from "./spike-fixtures.test-helpers.js";
import { readTiming } from "./timing.js";

describe("reading heard timings", () => {
  // Mutation: requiring `words` rejects the durations-only extract.
  it("reads all 75 heard durations of the v4 extract, 742.53 s in total", () => {
    const timing = readTiming(v4Durations());

    const total = [...timing.values()].reduce((sum, t) => sum + t.durationS, 0);
    expect(timing.size).toBe(75);
    expect(total).toBeCloseTo(742.53, 2);
    expect(timing.get("r2-1-jobs")).toEqual({ durationS: 8.466666666666667 });
  });

  // Mutation: keeping the file's `start` key leaves startS undefined, so no cue resolves.
  it("keeps each word's start from a full words.json as seconds from the beat start", () => {
    const timing = readTiming({
      pauseS: 0.25,
      beats: [{ id: "b1", kind: "hook", durationS: 2, words: [{ word: "Four", start: 0.3, end: 0.76 }] }],
    });

    expect(timing.get("b1")).toEqual({ durationS: 2, words: [{ word: "Four", startS: 0.3 }] });
  });
});
