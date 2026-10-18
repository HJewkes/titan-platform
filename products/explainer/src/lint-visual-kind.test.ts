import { describe, expect, it } from "vitest";
import { l0HardPass, L0_CHECKS, runL0 } from "./eval-l0.js";
import { goodScript } from "./lint-fixtures.test-helpers.js";
import { VISUAL_GAP_CHECK_ID, visualKindCheck } from "./lint-visual-kind.js";
import type { ScriptV1 } from "./script-schema.js";

function withKinds(kinds: Record<string, string>): ScriptV1 {
  const script = goodScript();
  return { ...script, beats: script.beats.map((beat) => (kinds[beat.id] ? { ...beat, kind: kinds[beat.id] } : beat)) };
}

const gapRow = (script: ScriptV1) => runL0(script).find((row) => row.check_id === VISUAL_GAP_CHECK_ID);

describe("visual:gap-kind", () => {
  it("warns on a beat whose kind is a gap type, without failing the script", () => {
    const script = withKinds({ b2: "sankey" });

    const rows = runL0(script, undefined, [visualKindCheck]);

    expect(gapRow(script)).toMatchObject({ severity: "warning", pass: false, value: 1, detail_beats: ["b2"] });
    expect(l0HardPass(rows)).toBe(true);
  });

  it("passes a built type and a kind that is only a render hint", () => {
    expect(gapRow(withKinds({ b2: "bar", b3: "chapter-open" }))).toMatchObject({ pass: true, detail_beats: [] });
  });

  it("runs with the other L0 checks", () => {
    expect(L0_CHECKS).toContain(visualKindCheck);
  });
});
