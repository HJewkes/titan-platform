import { describe, expect, it } from "vitest";
import { groupProgressStills, type FrameItem } from "./progress-stills-heuristic.js";

const everyKey = (): boolean => true;
const shape = (items: FrameItem[]): (string | string[])[] => items.map((item) => (item.kind === "frame" ? item.key : item.sequence.steps.map((step) => step.key)));

describe("guessing a motion's stills from -p<n> keys", () => {
  it("folds a count and a reel motion into two sequences of three, each in progress order", () => {
    const keys = ["count-p1", "count-p0", "count-p0_5", "reel-p0_5", "reel-p0", "reel-p1"];

    const items = groupProgressStills(keys, everyKey);

    expect(shape(items)).toEqual([
      ["count-p0", "count-p0_5", "count-p1"],
      ["reel-p0", "reel-p0_5", "reel-p1"],
    ]);
    const [count] = items;
    expect(count?.kind === "sequence" && count.sequence.steps.map(({ progress, label }) => [progress, label])).toEqual([
      [0, "0"],
      [0.5, "0.5"],
      [1, "1"],
    ]);
  });

  it("keeps a lone still a single frame", () => {
    expect(groupProgressStills(["x-p0", "y"], everyKey)).toEqual([
      { kind: "frame", key: "x-p0" },
      { kind: "frame", key: "y" },
    ]);
  });

  it("never groups keys whose suffix is not a number", () => {
    const keys = ["tab-pa", "tab-pb", "tab-p", "tab-p1_", "tab-p_5"];

    expect(shape(groupProgressStills(keys, everyKey))).toEqual(keys);
  });

  it("draws the sequence where its first still stood, between the frames around it", () => {
    expect(shape(groupProgressStills(["intro", "dial-p1", "outro", "dial-p0"], everyKey))).toEqual(["intro", ["dial-p0", "dial-p1"], "outro"]);
  });

  it("guesses only from image variants, leaving a story keyed like a still on its own", () => {
    const images = new Set(["dial-p0", "dial-p1"]);

    expect(shape(groupProgressStills(["dial-p0", "dial-p0_5", "dial-p1"], (key) => images.has(key)))).toEqual([["dial-p0", "dial-p1"], "dial-p0_5"]);
  });
});
