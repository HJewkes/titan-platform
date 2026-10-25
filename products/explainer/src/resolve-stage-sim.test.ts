import { describe, expect, it } from "vitest";
import { registry, stage } from "./resolve-sim-fixtures.test-helpers.js";
import { resolveConfig } from "./resolve-stage.js";
import { RESOLVE_ROWS } from "./resolve-tables.js";
import { SimTraceSchema } from "./sim/trace-schema.js";
import { SimTracesSchema } from "./sim/sim-resolve.js";
import { failedGates } from "./workflow/stage-checks.js";

describe("sim beats at resolve", () => {
  it("keeps a sim beat that reproduces its claim and freezes its trace into sim-traces", () => {
    const { resolved, store, artifacts, checks } = stage({ c3: "F-near" });

    const traces = SimTracesSchema.parse(JSON.parse(store.readText(artifacts["sim-traces"]!)));
    expect(resolved.beats.map((beat) => beat.id)).toContain("c3");
    expect(SimTraceSchema.parse(JSON.parse(store.readText(traces.traces.c3!))).model).toBe("toy");
    expect(checks.find((check) => check.name === "sim-check")).toMatchObject({ gate: false, pass: true });
  });

  it("cuts a sim beat that misses its claim and records the cut in resolved, the notes and sim-check", () => {
    const { resolved, outcome, checks } = stage({ c3: "F-far" });

    expect(resolved.beats.map((beat) => beat.id)).not.toContain("c3");
    expect(resolved.cut).toEqual([expect.objectContaining({ id: "c3", chapter: "ch4", code: "E-SIM-MISS" })]);
    expect(outcome.notes?.some((note) => note.startsWith("sim beat c3 cut (E-SIM-MISS)"))).toBe(true);
    expect(checks.find((check) => check.name === "sim-check")).toMatchObject({ pass: false, detail: expect.stringContaining("c3 (E-SIM-MISS)") });
  });

  it("holds a cut that leaves its chapter other beats, so sim-cut-orphan passes", () => {
    const { checks } = stage({ c3: "F-far" });

    expect(checks.find((check) => check.name === "sim-cut-orphan")).toMatchObject({ gate: true, pass: true });
  });

  it("fails the sim-cut-orphan gate when cuts empty a chapter", () => {
    const { checks } = stage({ c1: "F-far", c2: "F-far", c3: "F-far" });

    expect(failedGates(checks).map((check) => check.name)).toContain("sim-cut-orphan");
    expect(checks.find((check) => check.name === "sim-cut-orphan")?.detail).toContain("ch4");
  });

  it("re-keys the stage when a doctrine tolerance changes", () => {
    expect(resolveConfig(RESOLVE_ROWS, registry({ abs: 0.2 }).specs).doctrine).not.toBe(resolveConfig(RESOLVE_ROWS, registry({ abs: 0.25 }).specs).doctrine);
  });
});
