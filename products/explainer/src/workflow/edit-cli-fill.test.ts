import { afterAll, afterEach, describe, expect, it } from "vitest";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { editHarness } from "./edit-cli.test-helpers.js";
import { dropSeeds, fakeScriptModel, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk, run on fakes end to end; no real script, run, render or note.
let fx: Fixture;
afterEach(() => fx.cleanup());
afterAll(dropSeeds);

const { baseRun, editFile, cli } = editHarness(() => fx, (next) => (fx = next));
const figures = [{ id: "scan-rate", value: 4, label: "Scans a minute" }];

describe("explainer edit check through the template fill", () => {
  it("refuses an edit whose filled slots leave an emphasis cue with no element to land on", async () => {
    // The base renders only if its cue lands on the figure its label derives, so the cue names the derived id.
    const cue = { action: "V6", target: "figures-1", atCue: "desk" };
    const visual = { assertion: "The desk refuses unknown parcels", job: "numbers", beat: "stat", labels: ["4 scans a minute"], cues: [cue] };
    const base = await baseRun({}, fakeScriptModel(choppy({ h1: { visual } }), { asWritten: true }));
    const renamed = [{ ...figures[0], id: "dock-rate" }];

    const kept = await cli(["check", editFile(base, { h1: { slots: { figures: [{ ...figures[0], id: "figures-1" }] } } })]);
    const { code, text } = await cli(["check", editFile(base, { h1: { slots: { figures: renamed } } }, "renamed.json")]);

    expect(kept.code).toBe(0);
    expect(code).toBe(1);
    expect(JSON.parse(text).problems).toEqual([
      'beats.h1.visual.slots.figures: drops element figures-1, which cue 0 (V6 at "desk") targets; keep its id or retarget the cue',
    ]);
  });

  it("refuses an edit that moves a fallback beat onto its chosen spec, where the cue's element does not exist", async () => {
    // No number in the label, so the base fills stat's list fallback and the cue lands on a list row.
    const cue = { action: "V6", target: "rows-1", atCue: "desk" };
    const visual = { assertion: "The desk refuses unknown parcels", job: "numbers", beat: "stat", labels: ["Scans a minute"], cues: [cue] };
    const base = await baseRun({}, fakeScriptModel(choppy({ h1: { visual } }), { asWritten: true }));

    const { code, text } = await cli(["check", editFile(base, { h1: { slots: { figures } } })]);

    expect(code).toBe(1);
    expect(JSON.parse(text).problems).toEqual(["beats.h1.visual.cues.0: no-element: rows-1 names no element of beat spec stat"]);
  });

  it("passes an edit on a base whose resolve cut a sim beat, filling only the beats it kept", async () => {
    const cue = (target: string) => ({ action: "V6", target, atCue: "desk" });
    // A sim beat with no slots pin and no visual.slots has nothing to sweep, so the base's resolve cuts it.
    const stat = { assertion: "The desk refuses unknown parcels", job: "numbers", beat: "stat", labels: ["4 scans a minute"], cues: [cue("figures-1")] };
    const sim = { assertion: "Retries settle near four tries", job: "numbers", beat: "sim", labels: ["Tries per parcel"], cues: [cue("readouts-1")] };
    const base = await baseRun({}, fakeScriptModel(choppy({ h1: { visual: stat }, h2: { visual: sim } }), { asWritten: true }));

    const { code, text } = await cli(["check", editFile(base, { h1: { slots: { figures: [{ ...figures[0], id: "figures-1" }] } } })]);

    expect(JSON.parse(text).problems).toEqual([]);
    expect(code).toBe(0);
  });
});
