import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const mapVisual = (map_state: Record<string, unknown>) => ({
  visual: { assertion: "One server sits between every scanner and the ledger", job: "map", map_state },
});

const issues = (input: unknown): string[] => {
  const result = ScriptSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe("script/v1", () => {
  it("parses a minimal script and fills the optional lists", () => {
    const script = ScriptSchema.parse(scriptWith());

    expect(script.beats[0]?.visual).toMatchObject({ cues: [], chips: [], labels: [], edge_sources: [] });
  });

  it("rejects a beat function outside the list", () => {
    expect(ScriptSchema.safeParse(scriptWith({ function: "TEASER" })).success).toBe(false);
  });

  it("rejects a map cue the beat never speaks", () => {
    const script = scriptWith(mapVisual({ level: "containers", focus: { ids: ["S2"], atCue: "router" } }));

    expect(issues(script)).toContain('cue "router" is not spoken in c2-1-stations');
  });

  it("accepts a cue that names a later use of a word", () => {
    const script = scriptWith({
      spoken: "A scan goes in, and a second scan comes out.",
      ...mapVisual({ level: "containers", reveal: [{ id: "S1", atCue: "scan#2" }] }),
    });

    expect(issues(script)).toEqual([]);
  });

  it("accepts a cue on a word the beat declares a reading for", () => {
    // Catches: resolving cues against the raw line, where the word sits inside "[minute](=time)".
    const cues = [{ action: "V9", target: "ledger-row", atCue: "minute" }];
    const script = scriptWith({ spoken: "The ledger takes one scan a [minute](=time).", visual: { assertion: "The ledger keeps every scan", job: "numbers", cues } });

    expect(issues(script)).toEqual([]);
  });

  it("rejects an off-map cue whose nth use is past the beat's words", () => {
    const cues = [{ action: "V9", target: "ledger-row", atCue: "ledger#2" }];
    const script = scriptWith({ visual: { assertion: "The ledger keeps every scan", job: "numbers", cues } });

    expect(issues(script)).toContain('cue "ledger#2" is not spoken in c2-1-stations');
  });

  it("accepts TODO placeholders for required authored fields so lints can report them", () => {
    const script = scriptWith({ visual: { assertion: "TODO: assertion", job: "TODO: job" } });

    expect(ScriptSchema.safeParse(script).success).toBe(true);
  });

  it("rejects a beat in a chapter the script does not declare", () => {
    expect(issues(scriptWith({ chapter: "ch9" }))).toContain("unknown chapter ch9");
  });

  it("rejects thesis refs that name no beat", () => {
    const base = scriptWith();
    const script = { ...base, video: { ...base.video, thesis_refs: ["c2-1-stations", "c2-1-stations", "c9-9-missing"] } };

    expect(issues(script)).toContain("unknown beat c9-9-missing");
  });

  it("rejects a code excerpt longer than ten lines", () => {
    const code = { file: "src/desk.ts", lines: [10, 20] };
    const script = scriptWith({ visual: { assertion: "The desk checks each scan", job: "code-proof", code } });

    expect(ScriptSchema.safeParse(script).success).toBe(false);
  });

  it("rejects a map_state field the map track does not define", () => {
    const script = scriptWith(mapVisual({ level: "containers", zoom_level: 2 }));

    expect(ScriptSchema.safeParse(script).success).toBe(false);
  });

  it("admits the spike's optional keys", () => {
    const base = scriptWith({ visual: { assertion: "One server sits between every scanner and the ledger", job: "map", render: "MapBeat", map_state: { map: "old", level: "containers", old: { pins: [{ anchor: "desk", text: "one desk", atCue: "scan" }] } } } });
    const script = { ...base, beats: [{ ...base.beats[0], band: "diagram", origin: "v2" }], maps: { old: { nodes: [{ id: "desk", label: "Desk", nodeBox: [1, 2] }] } }, map: { nodes: [] }, shared_nodes: ["desk"] };

    expect(issues(script)).toEqual([]);
  });

  // Mutation: restoring `.max(2)` on `invariants` makes this parse fail.
  it("parses more than two invariants; the cap is an L0 warning", () => {
    const base = scriptWith();
    const script = { ...base, video: { ...base.video, invariants: ["One holds.", "Two holds.", "Three holds."] } };

    expect(issues(script)).toEqual([]);
  });
});

describe("script/v1 profile fields", () => {
  const visual = (extra: Record<string, unknown>) => scriptWith({ visual: { assertion: "Every scan meets the desk", job: "map", ...extra } });
  const top = (extra: Record<string, unknown>) => ({ ...scriptWith(), ...extra });

  it("parses the layer, framing, anchors, scene, an emphasis span, the structure and a signature layer", () => {
    const cues = [{ action: "V9", target: "desk-server", atCue: "scan", untilCue: "ledger" }];
    const script = top({ ...visual({ layer: "custom", framing: "split", anchors: ["A1", "F6"], scene: "desk-floor", cues }), structure: "design-journey", signature_layer: { kind: "sim", source: ["F1"] } });

    expect(issues(script)).toEqual([]);
  });

  it("parses a legacy script with none of them, so no check requires a signature layer", () => {
    const script = ScriptSchema.parse(scriptWith());

    expect(script).not.toHaveProperty("signature_layer");
    expect(script.beats[0]?.visual).not.toHaveProperty("layer");
  });

  // Mutation: each case passes when its field accepts any string or an empty list.
  it.each([
    ["a layer outside template and custom", visual({ layer: "overlay" })],
    ["a framing outside the list", visual({ framing: "wide" })],
    ["an anchor off the 6x6 grid", visual({ anchors: ["G1"] })],
    ["an empty anchor list", visual({ anchors: [] })],
    ["a structure that is not a kebab-case name", top({ structure: "Design Journey" })],
    ["a signature layer with no source", top({ signature_layer: { kind: "sim", source: [] } })],
  ])("rejects %s", (_name, script) => {
    expect(ScriptSchema.safeParse(script).success).toBe(false);
  });

  // Mutation: leaving untilCue out of beatCues lets an unspoken span end through.
  it("rejects an emphasis span that ends on a word the beat never speaks", () => {
    const script = visual({ cues: [{ action: "V9", target: "desk-server", atCue: "scan", untilCue: "router" }] });

    expect(issues(script)).toContain('cue "router" is not spoken in c2-1-stations');
  });

  it("puts the new fields in the JSON Schema the script stage sends", () => {
    const schema = JSON.stringify(z.toJSONSchema(ScriptSchema, { io: "input", unrepresentable: "any" }));

    for (const field of ["layer", "framing", "anchors", "scene", "untilCue", "structure", "signature_layer"]) expect(schema).toContain(`"${field}"`);
  });
});
