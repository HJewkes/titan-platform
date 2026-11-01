import { describe, expect, it } from "vitest";
import { guardBeat, type BeatRewrite } from "./rewrite-guard.js";
import { ScriptSchema, type ScriptBeat } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

// A number the screen shows must stay spoken, as qa's narration-facts holds it, so the rewrite may not move one to a label.
const ORIGINAL =
  "The desk server checks each scan. It retries 3 times. Then it writes 12 rows to the ledger. The ledger keeps them.";

function shown(labels: string[], spoken = ORIGINAL): ScriptBeat {
  const [beat] = ScriptSchema.parse(scriptWith({ spoken, visual: { assertion: "The desk server writes the ledger", job: "map", labels } })).beats;
  if (!beat) throw new Error("fixture has no beat");
  return beat;
}

const joined: BeatRewrite = {
  spoken: "The desk server checks each scan and retries 3 times, then it writes the rows to the ledger, which keeps them.",
  labelsAdded: [],
};

const rules = (before: ScriptBeat, after: BeatRewrite) => guardBeat(before, after).map((r) => r.rule);

describe("a number the line stops saying (TP-4475)", () => {
  it("rejects the number moved onto an appended label", () => {
    const after = { ...joined, labelsAdded: ["12 rows written"] };

    const rejected = guardBeat(shown([]), after);

    expect(rejected).toEqual([{ rule: "number-lost", detail: '"12" is on screen in "12 rows written" and the line no longer says it' }]);
  });

  it("rejects the number cut from the line while the beat's own label still shows it", () => {
    expect(rules(shown(["12 rows written"]), joined)).toEqual(["number-lost"]);
  });

  it("rejects a spelled number cut from the line while its digits stay on screen", () => {
    const before = shown(["4 retries"], "The desk server checks each scan. It retries four times. The ledger keeps them all.");
    const after = { spoken: "The desk server checks each scan and retries, and the ledger keeps them all.", labelsAdded: [] };
    expect(rules(before, after)).toContain("number-lost");
  });

  it("accepts the number kept on the line while the screen shows it", () => {
    const after = { spoken: "The desk server checks each scan and retries 3 times, then it writes 12 rows to the ledger, which keeps them.", labelsAdded: [] };
    expect(guardBeat(shown(["12 rows written"]), after)).toEqual([]);
  });

  it("does not count a number the original already showed without saying it", () => {
    expect(rules(shown(["40 docks"]), joined)).not.toContain("number-lost");
  });

  it("rejects an appended label showing a number the line never said", () => {
    expect(rules(shown([]), { spoken: ORIGINAL, labelsAdded: ["120 rows written"] })).toContain("number-lost");
  });
});
