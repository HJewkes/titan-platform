import { describe, expect, it } from "vitest";
import { choppy } from "./rewrite-fixtures.test-helpers.js";
import { visual } from "./resolve-fixtures.test-helpers.js";
import { resolveConfig, ResolvedSchema, runResolveStage } from "./resolve-stage.js";
import { RESOLVE_ROWS } from "./resolve-tables.js";
import { SimTraceSchema } from "./sim/trace-schema.js";
import { fixedGeometric, toySpec } from "./sim/sim-fixtures.test-helpers.js";
import type { SimTolerance } from "./sim/sim-load.js";
import { SimTracesSchema, type SimRegistry } from "./sim/sim-resolve.js";
import { sha256 } from "./workflow/artifacts.js";
import { failedGates, runStageChecks } from "./workflow/stage-checks.js";

// Synthetic: the parcel-desk script with toy sims; fixed-geometric gives exactly 1 / p tries, so p = 0.25 gives 4.
const json = (value: unknown): string => JSON.stringify(value);

function registry(tolerance: SimTolerance = { abs: 0.25 }): SimRegistry {
  const spec = { ...toySpec("toy"), statistics: { "mean-tries": { tolerance, why: "Synthetic tolerance." } } };
  return { models: { toy: { ...fixedGeometric, id: "toy" } }, specs: new Map([["toy", spec]]) };
}

const simSlots = (fact: string) => ({
  model: "toy",
  seed: 7,
  params: {},
  sweep: { param: "p", from: 0.25, to: 0.5, steps: 2 },
  claim: { fact, statistic: "mean-tries", at: 0.25 },
  readouts: [{ id: "mean", label: "Mean tries" }],
});

const FACTS = [
  { id: "F-near", kind: "number", text: "A synthetic mean of 4.1 tries.", value: 4.1 },
  { id: "F-far", kind: "number", text: "A synthetic mean of 6 tries.", value: 6 },
].map(json).join("\n");

/** The resolve stage over an in-memory store, with the named beats of the fixture script made sim beats claiming `facts`. */
function stage(claims: Record<string, string>, sims: SimRegistry = registry()) {
  const extra = Object.fromEntries(Object.keys(claims).map((id) => [id, { visual: visual({ beat: "sim" }) }]));
  const slots = Object.fromEntries(Object.entries(claims).map(([id, fact]) => [id, simSlots(fact)]));
  const texts = { script: json(choppy(extra)), slots: json(slots), facts: FACTS };
  const bySha = new Map(Object.values(texts).map((text) => [sha256(text), text]));
  const store = { readText: (sha: string) => bySha.get(sha)!, putText: (text: string) => (bySha.set(sha256(text), text), sha256(text)) };
  const inputs = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha256(text)]));
  const outcome = runResolveStage({ artifacts: inputs, store, from: { runId: "r", stage: "resolve" }, remainingUsd: 1 }, resolveConfig(RESOLVE_ROWS, sims.specs), sims);
  const artifacts = { ...inputs, ...outcome.outputs };
  const resolved = ResolvedSchema.parse(JSON.parse(store.readText(artifacts.resolved!)));
  const checks = runStageChecks("resolve", { artifacts, store, l0Checks: [] }).checks;
  return { outcome, store, resolved, checks, artifacts };
}

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
