import { describe, expect, it } from "vitest";
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
});
