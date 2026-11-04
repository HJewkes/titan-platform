import { describe, expect, it } from "vitest";
import { dailyWith } from "./daily-script.test-helpers.js";
import { runL0 } from "./eval-l0.js";
import type { ScriptV1 } from "./script-schema.js";
import { SPLIT_PIECE_RULES } from "./split-piece-rules.js";

const BEAT = "reflection-2";
const SPOKEN = "No gate on the floor waited on the lead, and the dock scanner is the slowest stage.";

const baseline = (): ScriptV1 => dailyWith(BEAT, { spoken: SPOKEN, plannedS: 12, visual: { assertion: "The scanner is slow", labels: ["Scanner"], chips: [] } });

// Every text a split piece's claim, chip and labels can break a rule with: echoed, numbered, long, and unsourced.
const hostile = (): ScriptV1 =>
  dailyWith(BEAT, {
    spoken: SPOKEN,
    plannedS: 12,
    visual: {
      assertion: `${SPOKEN} Also 4242 more words so this claim runs far past two lines of the band and the ten word cap`,
      labels: [SPOKEN, "A label of far more than three words and 7777"],
      chips: [{ kind: "verified", text: `${SPOKEN} 9191` }],
    },
  });

const rowsOf = (script: ScriptV1): Map<string, string> => new Map(runL0(script).map((row) => [row.check_id, JSON.stringify([row.pass, row.value, row.detail_beats])]));

describe("the split piece rules", () => {
  it("every lint rule that reads a split piece's chip has a clause in the split hint", () => {
    const before = rowsOf(baseline());
    const after = rowsOf(hostile());

    const reading = [...after].filter(([id, row]) => before.get(id) !== row).map(([id]) => id);

    expect(reading.length).toBeGreaterThan(0);
    expect(SPLIT_PIECE_RULES.map((rule) => rule.id)).toEqual(expect.arrayContaining(reading));
  });
});
