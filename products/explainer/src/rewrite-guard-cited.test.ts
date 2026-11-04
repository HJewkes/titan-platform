import { describe, expect, it } from "vitest";
import { guardBeat } from "./rewrite-guard.js";
import { ScriptSchema, type ScriptBeat } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";

const PULL = "pr/acme/depot#6420/merged";
const TICKET = "task/TP-7001/opened";

/** A beat as the rewrite pass holds it, citing a pull request and a task: spelled before the guard sees it. */
function spelledBeat(spoken: string, assertion: string): ScriptBeat {
  const [beat] = ScriptSchema.parse(scriptWith({ spoken, fact_ids: [PULL, TICKET], visual: { assertion, job: "map" } })).beats;
  return spellSpokenNumbers(beat!);
}

const rulesFor = (before: ScriptBeat, rewritten: string): string[] => {
  const spoken = spellSpokenNumbers({ spoken: rewritten, visual: before.visual }).spoken;
  return guardBeat(before, { spoken, labelsAdded: [] }).map((rejection) => rejection.rule);
};

describe("a cited id the screen shows as a bare number", () => {
  it("may leave the line, since qa reads it as a citation", () => {
    const before = spelledBeat("Rule on 7001 first, since the dock server can wait forever on a run.", "Card 7001 holds the dock queue");

    const rules = rulesFor(before, "Rule on the stalled guard first, since the dock server can wait forever on a run.");

    expect(rules).toEqual([]);
  });

  it("may leave the line when the screen shows two of them", () => {
    const before = spelledBeat("Then 6420 moved the dock order onto one queue, as 7001 asked.", "Cards for 6420 and 7001 are linked as a pair");

    const rules = rulesFor(before, "Then the dock fix moved the dock order onto one queue, as the guard asked.");

    expect(rules).toEqual([]);
  });
});

describe("a real number the screen shows", () => {
  it("is still refused when it leaves the line, though it looks like an id", () => {
    const before = spelledBeat("The dock server scanned 2048 crates before the dock fix landed.", "The desk scanned 2048 crates");

    const rules = rulesFor(before, "The dock server scanned crates before the dock fix landed.");

    expect(rules).toContain("number-lost");
  });

  it("is still refused when it leaves the line beside a cited id that may go", () => {
    const before = spelledBeat("Then 6420 cut the dock wait to 85 seconds for every crate.", "Card 6420 cut the wait to 85 seconds");

    const rules = rulesFor(before, "Then the dock fix cut the dock wait for every crate.");

    expect(rules).toContain("number-lost");
  });
});
