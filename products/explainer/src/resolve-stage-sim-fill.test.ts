import { describe, expect, it } from "vitest";
import { stage } from "./resolve-sim-fixtures.test-helpers.js";
import { SimTracesSchema } from "./sim/sim-resolve.js";

// Synthetic: the parcel-desk script with the toy sims of resolve-sim-fixtures; no `slots` pin unless named.
describe("sim beats read the template fill's slots at resolve", () => {
  it("sweeps an unpinned sim beat on the slots the fill draws from its visual.slots", () => {
    const { resolved, store, artifacts, outcome } = stage({ c3: "F-near" }, { via: "visual" });

    const traces = SimTracesSchema.parse(JSON.parse(store.readText(artifacts["sim-traces"]!)));
    expect(artifacts.slots).toBeUndefined();
    expect(traces.verdicts).toEqual([expect.objectContaining({ beat: "c3", pass: true })]);
    expect(traces.traces.c3).toBeDefined();
    expect(resolved.beats.map((beat) => beat.id)).toContain("c3");
    expect(outcome.notes?.some((note) => note.includes("not swept"))).toBe(false);
  });

  it("cuts a sim beat with no pin and no visual.slots, naming why in sim-traces and the notes", () => {
    const { resolved, store, artifacts, outcome } = stage({ c3: "F-near" }, { via: "none" });

    const traces = SimTracesSchema.parse(JSON.parse(store.readText(artifacts["sim-traces"]!)));
    expect(resolved.cut).toEqual([expect.objectContaining({ id: "c3", chapter: "ch4", code: "E-SIM-NO-SLOTS" })]);
    expect(traces.verdicts).toEqual([
      expect.objectContaining({ beat: "c3", pass: false, code: "E-SIM-NO-SLOTS", detail: expect.stringContaining("sim derives no slots from a script") }),
    ]);
    expect(traces.traces.c3).toBeUndefined();
    expect(outcome.notes?.some((note) => note.startsWith("sim beat c3 cut (E-SIM-NO-SLOTS): beat c3 has no sim slots to sweep"))).toBe(true);
  });

  it("cuts an unpinned sim beat whose visual.slots leave the sim spec invalid", () => {
    const { resolved, store, artifacts } = stage({ c3: "F-near" }, { via: "none", patch: { slots: { seed: 7 } } });

    const traces = SimTracesSchema.parse(JSON.parse(store.readText(artifacts["sim-traces"]!)));
    expect(resolved.cut?.map((beat) => beat.id)).toEqual(["c3"]);
    expect(traces.verdicts).toEqual([expect.objectContaining({ beat: "c3", code: "E-SIM-NO-SLOTS", detail: expect.stringContaining("visual.slots leave sim invalid") })]);
  });
});
