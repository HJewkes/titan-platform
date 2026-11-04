import { describe, expect, it } from "vitest";
import { guardBeat } from "./rewrite-guard.js";
import { ScriptSchema, type ScriptBeat } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";

const PULL = "pr/acme/depot#6420/merged";
const TICKET = "task/TP-7001/opened";

/** A beat as the rewrite pass holds it: spelled before the guard sees it. */
function spelledBeat(spoken: string, fields: Record<string, unknown> = {}): ScriptBeat {
  const [beat] = ScriptSchema.parse(scriptWith({ spoken, fact_ids: [PULL, TICKET], ...fields })).beats;
  return spellSpokenNumbers(beat!);
}

const rulesFor = (before: ScriptBeat, rewritten: string): string[] => {
  const spoken = spellSpokenNumbers({ spoken: rewritten, visual: before.visual }).spoken;
  return guardBeat(before, { spoken, labelsAdded: [] }).map((rejection) => rejection.rule);
};

describe("a rewrite that takes an id out of the line", () => {
  it("is accepted when a pull request id leaves with its lead words", () => {
    const before = spelledBeat("So the landing that counts is pull request 6420, which switched the dock order on.", { new_terms: [PULL] });

    const rules = rulesFor(before, "So the landing that counts is the dock fix, which switched the dock order on.");

    expect(rules).toEqual([]);
  });

  it("is accepted when a ticket id leaves, its TP lead included", () => {
    const before = spelledBeat("Rule on TP-7001 first, since the dock server can wait forever on a run.");

    const rules = rulesFor(before, "Rule on the stalled guard first, since the dock server can wait forever on a run.");

    expect(rules).toEqual([]);
  });

  it("is accepted when a script id the beat declares leaves", () => {
    const before = spelledBeat("Then M10 shrinks the charter before the dock server writes the rows.", { new_terms: ["M10"] });

    const rules = rulesFor(before, "Then the last step shrinks the charter before the dock server writes the rows.");

    expect(rules).toEqual([]);
  });

  it("is refused when it says an id the original did not", () => {
    const before = spelledBeat("Rule on the stalled guard first, since the dock server can wait forever on a run.");

    const rules = rulesFor(before, "Rule on TP-7001 first, since the dock server can wait forever on a run.");

    expect(rules).toContain("id-changed");
  });
});

describe("an id the screen shows", () => {
  it("may leave the line when the screen shows it with its lead, which qa reads as a citation", () => {
    const before = spelledBeat("Rule on TP-7001 first, since the dock server can wait forever on a run.", { visual: { assertion: "TP-7001 holds the dock queue", job: "map" } });

    const rules = rulesFor(before, "Rule on the stalled guard first, since the dock server can wait forever on a run.");

    expect(rules).toEqual([]);
  });
});

describe("a rewrite that cuts what is not an id", () => {
  it("is still refused when a number the screen shows leaves the line", () => {
    const before = spelledBeat("The dock server refused 3 scans before PR 6420 landed.", { visual: { assertion: "The desk refused 3 scans", job: "map" } });

    const rules = rulesFor(before, "The dock server refused scans before the dock fix landed.");

    expect(rules).toContain("number-lost");
  });

  it("is still refused when a declared term leaves the line", () => {
    const before = spelledBeat("The harbour crane holds every crate that PR 6420 routed to the dock.", { new_terms: ["harbour crane"] });

    const rules = rulesFor(before, "The yard holds every crate that the dock fix routed to the dock.");

    expect(rules).toContain("new-term");
  });
});
