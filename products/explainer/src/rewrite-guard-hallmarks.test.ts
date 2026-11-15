import { describe, expect, it } from "vitest";
import { guardBeat } from "./rewrite-guard.js";
import { ScriptSchema, type ScriptBeat } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const ORIGINAL = "The desk server checks each scan. Then it writes the rows to the ledger. The ledger keeps them.";

function beatWith(spoken = ORIGINAL): ScriptBeat {
  const [beat] = ScriptSchema.parse(scriptWith({ spoken })).beats;
  if (!beat) throw new Error("fixture has no beat");
  return beat;
}

const rulesFor = (before: string, after: string): string[] =>
  guardBeat(beatWith(before), { spoken: after, labelsAdded: [] }).map((r) => r.rule);

describe("guardBeat hallmark-added", () => {
  it.each([
    ["a label-first line", "The desk server checks each scan. The fix is the ledger. The ledger keeps them."],
    ["a naming refrain", "The desk server checks each scan. That is called the vent note. The ledger keeps them."],
    ["a teaser", "By the end of this, you'll be able to read the ledger. The desk server checks each scan. The ledger keeps them."],
  ])("refuses a rewrite that adds %s", (_, after) => {
    expect(rulesFor(ORIGINAL, after)).toContain("hallmark-added");
  });

  it("passes a rewrite that keeps a label-first line the original already had", () => {
    const before = "The desk server checks each scan. The fix is the ledger. The ledger keeps them.";
    const after = "The desk server checks each scan and the fix is the ledger. The ledger keeps them.";
    const same = "The desk server checks every scan. The fix is the ledger. The ledger keeps them.";

    expect(rulesFor(before, same)).not.toContain("hallmark-added");
    expect(rulesFor(before, after)).not.toContain("hallmark-added");
  });

  it("passes a rewrite with no hallmark", () => {
    expect(rulesFor(ORIGINAL, "The desk server checks each scan. It writes the rows to the ledger. The ledger keeps them.")).not.toContain("hallmark-added");
  });
});
