import { describe, expect, it } from "vitest";
import type { ScriptBeat } from "./script-schema.js";
import {
  connectorShareRow,
  cueActionRow,
  hookFormulaRow,
  resolvedVarietyRows,
  scriptVarietyRows,
  type ResolvedVarietyBeat,
  type VarietyRow,
} from "./variety-lints.js";

type Beat = Pick<ScriptBeat, "id" | "spoken" | "visual">;
type Visual = Partial<ScriptBeat["visual"]>;

const beat = (id: string, spoken: string, visual: Visual = {}): Beat => ({
  id,
  spoken,
  visual: { assertion: "A synthetic claim", job: "map", edge_sources: [], cues: [], chips: [], labels: [], ...visual } as ScriptBeat["visual"],
});

const ids = (n: number, from = 1): string[] => Array.from({ length: n }, (_, i) => `b${String(i + from).padStart(2, "0")}`);
const cue = (action: "V6" | "V9" | "V11", atCue: string) => ({ action, target: "card", atCue });

const resolved = (id: string, name: string, extra: Partial<ResolvedVarietyBeat> = {}): ResolvedVarietyBeat => ({
  id, beat: "list-beat", component: { name }, framing: "full", layer: "template", key: { job: "map" }, ...extra,
});

const LIMITS = { componentMaxShare: 0.3, templateMaxShare: 0.7, minFramings: 3 };
const FRAMINGS = ["full", "focus", "split", "stack"] as const;
const COMPONENTS = ["ListBeat", "StatBeat", "CompareBeat", "CodeBeat"];

/** Twenty beats cycling four components, four framings and a custom layer every third beat: varied on every row. */
const varied = (): ResolvedVarietyBeat[] =>
  ids(20).map((id, i) => resolved(id, COMPONENTS[i % 4]!, { framing: FRAMINGS[(i + 1) % 4]!, layer: i % 3 === 0 ? "custom" : "template" }));

const row = (rows: readonly VarietyRow[], id: string): VarietyRow => rows.find((candidate) => candidate.id === id)!;

describe("script variety lints", () => {
  it("warns on the stock crib-from hook, naming the first beat", () => {
    const stock = [beat("b01", "So what can parcel-desk crib from the ledger service?"), beat("b02", "The desk checks every label.")];

    const verdict = hookFormulaRow(stock);

    expect(verdict).toMatchObject({ pass: false, beats: ["b01"] });
    expect(verdict.hint).toContain("b01");
  });

  it("passes a hook of the video's own", () => {
    expect(hookFormulaRow([beat("b01", "A courier printed a label for a parcel that never existed.")]).pass).toBe(true);
    expect(hookFormulaRow([beat("b01", "What can a courier learn from one refused label?")]).pass).toBe(true);
  });

  it("passes when 30 % of beats open on a connector", () => {
    const beats = ids(10).map((id, i) => beat(id, i < 3 ? "So the desk waits." : "The desk waits."));

    expect(connectorShareRow(beats)).toMatchObject({ pass: true, value: 0.3, beats: [] });
  });

  it("warns when 31 % of beats open on a connector, naming them", () => {
    const beats = ids(100).map((id, i) => beat(id, i < 31 ? ["So,", "But", "Then", "And", "Now"][i % 5]! + " the desk waits." : "The desk waits."));

    const verdict = connectorShareRow(beats);

    expect(verdict.pass).toBe(false);
    expect(verdict.beats).toEqual(ids(31));
    expect(verdict.hint).toContain("b01, b02");
  });

  it("warns when every cue uses one action, naming the cued beats", () => {
    const beats = [beat("b01", "The desk reads a label.", { cues: [cue("V11", "desk")] }), beat("b02", "The ledger answers.", { cues: [cue("V11", "ledger")] }), beat("b03", "Nothing moves.")];

    const verdict = cueActionRow(beats);

    expect(verdict).toMatchObject({ pass: false, value: 1, beats: ["b01", "b02"] });
    expect(verdict.hint).toContain("V11");
    expect(verdict.hint).toContain("b01, b02");
  });

  it("passes cues of two actions, and counts a map op as an action", () => {
    const twoCues = [beat("b01", "The desk reads a label.", { cues: [cue("V11", "desk")] }), beat("b02", "The ledger answers.", { cues: [cue("V6", "ledger")] })];
    const withMap = [beat("b01", "The desk reads a label.", { cues: [cue("V11", "desk")] }), beat("b02", "The ledger answers.", { map_state: { level: "L1", reveal: [{ id: "ledger", atCue: "ledger" }] } } as Visual)];

    expect(cueActionRow(twoCues).pass).toBe(true);
    expect(cueActionRow(withMap).pass).toBe(true);
  });

  it("emits a framing-run row only when a beat authors its framing, and warns on two in a row", () => {
    const unframed = [beat("b01", "The desk waits."), beat("b02", "The desk waits.")];
    const framed = [beat("b01", "The desk waits.", { framing: "split" }), beat("b02", "The desk waits.", { framing: "split" }), beat("b03", "The desk waits.", { framing: "full" })];

    const rows = scriptVarietyRows(framed);

    expect(scriptVarietyRows(unframed).map((r) => r.id)).not.toContain("variety:framing-run");
    expect(row(rows, "variety:framing-run")).toMatchObject({ pass: false, value: 2, beats: ["b01", "b02"] });
  });

  it("does not run framings across a beat that authors none", () => {
    const gapped = [beat("b01", "The desk waits.", { framing: "split" }), beat("b02", "The desk waits."), beat("b03", "The desk waits.", { framing: "split" })];

    expect(row(scriptVarietyRows(gapped), "variety:framing-run").pass).toBe(true);
  });
});

describe("resolved variety lints", () => {
  it("passes every row on a varied video", () => {
    const failing = resolvedVarietyRows(varied(), LIMITS).filter((r) => !r.pass);

    expect(failing).toEqual([]);
  });

  it("warns when 14 of 21 beats are one component, naming them", () => {
    const beats = ids(21).map((id, i) => resolved(id, i < 14 ? "ListBeat" : ["StatBeat", "CompareBeat", "CodeBeat"][i % 3]!));

    const verdict = row(resolvedVarietyRows(beats, LIMITS), "variety:top-component");

    expect(verdict).toMatchObject({ pass: false, value: 14 / 21, beats: ids(14) });
    expect(verdict.hint).toContain("ListBeat on 14 of 21 beats");
  });

  it("keys a nameless component by its beat spec", () => {
    const beats = ids(4).map((id) => resolved(id, "unused", { component: {}, beat: "crib-card" }));

    expect(row(resolvedVarietyRows(beats, LIMITS), "variety:top-component").hint).toContain("spec:crib-card");
  });

  it("warns on a run of three same components and passes a run of two", () => {
    const three = varied().map((b, i) => (i >= 4 && i <= 6 ? { ...b, component: { name: "ListBeat" } } : b));
    const two = varied().map((b, i) => (i >= 4 && i <= 5 ? { ...b, component: { name: "ListBeat" } } : b));

    const verdict = row(resolvedVarietyRows(three, LIMITS), "variety:component-run");

    expect(verdict).toMatchObject({ pass: false, value: 3, beats: ["b05", "b06", "b07"] });
    expect(row(resolvedVarietyRows(two, LIMITS), "variety:component-run").pass).toBe(true);
  });

  it("warns when template beats pass the profile's template share", () => {
    const beats = varied().map((b) => ({ ...b, layer: "template" as const }));

    const verdict = row(resolvedVarietyRows(beats, LIMITS), "variety:template-share");

    expect(verdict).toMatchObject({ pass: false, value: 1 });
    expect(verdict.beats).toEqual(ids(20));
  });

  it("warns on one framing in 20 beats, on both the run and minFramings", () => {
    const beats = varied().map((b) => ({ ...b, framing: "full" }));

    const rows = resolvedVarietyRows(beats, LIMITS);

    expect(row(rows, "variety:min-framings")).toMatchObject({ pass: false, value: 1, threshold: 3 });
    expect(row(rows, "variety:framing-run")).toMatchObject({ pass: false, value: 20 });
  });

  it("passes exactly the profile's minFramings", () => {
    const beats = varied().map((b, i) => ({ ...b, framing: ["full", "split", "focus"][i % 3]! }));

    expect(row(resolvedVarietyRows(beats, LIMITS), "variety:min-framings").pass).toBe(true);
  });

  it("counts cast-in-motion beats on a still layer as E-RESOLVE-STILL-MOTION", () => {
    const beats = varied().map((b, i) => (i < 2 ? { ...b, layer: "template" as const, key: { job: "cast-in-motion" } } : b));
    const moving = varied().map((b) => ({ ...b, layer: "custom" as const, key: { job: "cast-in-motion" } }));

    const verdict = row(resolvedVarietyRows(beats, LIMITS), "variety:cast-in-motion");

    expect(verdict).toMatchObject({ pass: false, value: 2, beats: ["b01", "b02"] });
    expect(verdict.hint).toBe("E-RESOLVE-STILL-MOTION on b01, b02");
    expect(row(resolvedVarietyRows(moving, LIMITS), "variety:cast-in-motion").pass).toBe(true);
  });
});
