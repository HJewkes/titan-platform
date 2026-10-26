import { describe, expect, it } from "vitest";
import { failedGates } from "../workflow/stage-checks.js";
import { qaStageHarness } from "./qa-stage.test-helpers.js";

const harness = qaStageHarness();

/** Two 4 s beats that keep moving, so every gate passes and only the media scan can report. */
const TWO_BEATS = {
  durationS: 8,
  beats: [
    { id: "b1", kind: "title", startS: 0, durationS: 4, slots: {} },
    { id: "b2", kind: "title", startS: 4, durationS: 4, slots: {} },
  ],
};

const SCAN = {
  black: [{ startS: 1, endS: 2 }],
  silence: [{ startS: 3, endS: 5.5 }],
  freeze: [{ startS: 4.5, endS: 7.5 }],
};

describe("qa stage media scan", () => {
  it("records each scanned stretch in qa.json with the beats it overlaps", async () => {
    const { report } = await harness.run({ mediaScan: SCAN }, { timeline: TWO_BEATS });

    expect(report.mediaScan).toEqual({
      black: [{ startS: 1, endS: 2, beats: ["b1"] }],
      silence: [{ startS: 3, endS: 5.5, beats: ["b1", "b2"] }],
      freeze: [{ startS: 4.5, endS: 7.5, beats: ["b2"] }],
    });
  });

  it.each([
    ["black-frames", "1 black stretch: 1.00-2.00 s [b1]"],
    ["silence-2s", "1 silence of 2 s or more: 3.00-5.50 s [b1,b2]"],
    ["frozen-frames", "1 frozen stretch: 4.50-7.50 s [b2]"],
  ])("reports %s naming the beats, and never fails the stage", async (name, detail) => {
    const { report, checks } = await harness.run({ mediaScan: SCAN }, { timeline: TWO_BEATS });

    expect(checks[name]).toEqual({ name, gate: false, pass: false, detail });
    expect(failedGates(Object.values(checks))).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it("passes the three media checks on a clean scan", async () => {
    const { checks } = await harness.run({}, { timeline: TWO_BEATS });

    expect(["black-frames", "silence-2s", "frozen-frames"].map((name) => checks[name]?.pass)).toEqual([true, true, true]);
  });
});
