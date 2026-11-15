import { describe, expect, it } from "vitest";
import { runL0 } from "./eval-l0.js";
import { repairHint } from "./l0-repair-hints.js";
import { goodScript } from "./lint-fixtures.test-helpers.js";
import { whyCheck } from "./lint-why.js";
import type { ScriptV1 } from "./script-schema.js";

const q4 = (script: ScriptV1) => runL0(script, undefined, [whyCheck]).find((row) => row.check_id === "Q-W4")!;
const withBeat = (script: ScriptV1, id: string, patch: Record<string, unknown>): ScriptV1 => ({
  ...script,
  beats: script.beats.map((beat) => (beat.id === id ? { ...beat, ...patch } : beat)),
});

describe("the Q-W4 hint", () => {
  // Mutation: dropping the quoted text, or naming a different beat, leaves the author guessing what to say.
  it("quotes the unspoken user_value text and the beat to say it in, and that edit passes the check", () => {
    const script = withBeat(goodScript(), "b9", { spoken: "This view skips customs holds." });
    const row = q4(script);

    const hint = repairHint(row, script);
    const edited = withBeat(script, "b9", { spoken: "This view skips customs holds, so you never reprint a label." });

    expect(row.pass).toBe(false);
    expect(hint).toContain('"you never reprint a label"');
    expect(hint).toContain("b9");
    expect(q4(edited).pass).toBe(true);
  });
});
