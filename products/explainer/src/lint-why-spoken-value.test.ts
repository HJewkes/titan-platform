import { describe, expect, it } from "vitest";
import { deriveEvalView } from "./eval-view.js";
import { goodScript } from "./lint-fixtures.test-helpers.js";
import { whyCheck } from "./lint-why.js";
import type { ScriptV1 } from "./script-schema.js";

const q4 = (script: ScriptV1) => whyCheck({ script, view: deriveEvalView(script) }).find((row) => row.check_id === "Q-W4");
const withBeat = (script: ScriptV1, id: string, patch: Record<string, unknown>): ScriptV1 => ({
  ...script,
  beats: script.beats.map((beat) => (beat.id === id ? { ...beat, ...patch } : beat)),
});

describe("Q-W4 needs the user value spoken", () => {
  it("passes a chapter whose beat says its user_value text", () => {
    expect(q4(goodScript())).toMatchObject({ pass: true, detail_beats: [] });
  });

  it("fails a chapter whose beat cites user_value fact_ids but never says the text, naming that beat", () => {
    const script = withBeat(goodScript(), "b9", { spoken: "This view skips customs holds." });

    expect(q4(script)).toMatchObject({ pass: false, detail_beats: ["b9"] });
  });

  it("still fails a chapter with no user_value, naming its first body beat", () => {
    const script = withBeat(goodScript(), "b9", { user_value: undefined });

    expect(q4(script)).toMatchObject({ pass: false, detail_beats: ["b9"] });
  });
});
