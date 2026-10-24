import { describe, expect, it } from "vitest";
import { emphasisCues, spanWords, targetsForSpan } from "./emphasis-contract.js";
import { emphasisScript } from "./emphasis-fixtures.test-helpers.js";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const walk = () => emphasisScript().beats[0]!;
// "Open the total first, then close it with the return." voiced at 0.4 s a word.
const timings = walk().spoken.split(/\s+/).map((word, i) => ({ word, startS: i * 0.4 }));

describe("emphasis mapping contract", () => {
  it("maps each emphasis cue to its spoken word range and its element id", () => {
    expect(emphasisCues(walk())).toEqual([
      { beat: "b1-walk", cue: 0, words: [0, 2], target: "open" },
      { beat: "b1-walk", cue: 1, words: [5, 9], target: "close" },
    ]);
  });

  it("orders a cue range whose until word comes before its at word", () => {
    const beat = walk();
    beat.visual.cues = [{ action: "V9", target: "close", atCue: "return", untilCue: "close" }];

    expect(emphasisCues(beat)[0]!.words).toEqual([5, 9]);
  });

  it.each([
    ["a word inside one cue", [6, 6], ["close"]],
    ["words across both cues", [2, 5], ["open", "close"]],
    ["words between the cues", [3, 4], []],
  ] as const)("maps a word span over %s to the targets it covers", (_name, words, targets) => {
    expect(targetsForSpan(walk(), { words })).toEqual(targets);
  });

  it("maps a time span to targets through the beat's word timings", () => {
    expect(targetsForSpan(walk(), { seconds: [2.0, 2.4] }, timings)).toEqual(["close"]);
  });

  it("maps a time span that covers no spoken word to no target", () => {
    expect(spanWords({ seconds: [10, 12] }, timings)).toBeUndefined();
    expect(targetsForSpan(walk(), { seconds: [10, 12] }, timings)).toEqual([]);
  });

  it("refuses a time span without word timings", () => {
    expect(() => spanWords({ seconds: [0, 1] })).toThrow(/word timings/);
  });
});

describe("visual.beat", () => {
  const visual = (beat: string) => ({ assertion: "One server sits between every scanner and the ledger", job: "map", beat });

  it("names the beat spec whose target lists a cue resolves against", () => {
    expect(emphasisScript().beats.map((beat) => beat.visual.beat)).toEqual(["code-walk", "flow-map", undefined]);
  });

  it("refuses a beat spec name that is not kebab-case", () => {
    expect(ScriptSchema.safeParse(scriptWith({ visual: visual("Code Walk") })).success).toBe(false);
    expect(ScriptSchema.safeParse(scriptWith({ visual: visual("code-walk") })).success).toBe(true);
  });
});
