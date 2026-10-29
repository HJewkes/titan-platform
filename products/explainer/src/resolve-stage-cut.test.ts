import { describe, expect, it } from "vitest";
import { stage } from "./resolve-sim-fixtures.test-helpers.js";
import { failedGates } from "./workflow/stage-checks.js";

describe("resolve checks over a cut sim beat", () => {
  it("cuts a failing sim whose slots come from visual.slots, and every resolve gate still passes", () => {
    const { resolved, checks } = stage({ c3: "F-far" }, { via: "visual" });

    expect(resolved.cut?.map((beat) => beat.id)).toEqual(["c3"]);
    expect(checks.find((check) => check.name === "slot-overrides")).toMatchObject({ gate: true, pass: true });
    expect(failedGates(checks)).toEqual([]);
  });

  it("holds a kept sim beat's visual.slots to the sim beat spec", () => {
    const { resolved, checks } = stage({ c3: "F-near" }, { via: "visual" });

    expect(resolved.beats.map((beat) => beat.id)).toContain("c3");
    expect(checks.find((check) => check.name === "slot-overrides")).toMatchObject({ pass: true, detail: "1 beats carry overrides, all accepted" });
  });

  it("leaves a cut beat's emphasis cues out of the emphasis-target gate", () => {
    const cues = [{ action: "V6", target: "no-such-readout", atCue: "courier" }];

    const { checks } = stage({ c3: "F-far" }, { patch: { cues } });

    expect(checks.find((check) => check.name === "emphasis-target")).toMatchObject({ gate: true, pass: true, detail: "0 of 0 emphasis cues fail" });
  });

  it("still holds a kept sim beat's emphasis cues to its elements", () => {
    const cues = [{ action: "V6", target: "no-such-readout", atCue: "courier" }];

    const { checks } = stage({ c3: "F-near" }, { patch: { cues } });

    expect(failedGates(checks).map((check) => check.name)).toEqual(["emphasis-target"]);
  });
});
