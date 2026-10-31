import { describe, expect, it } from "vitest";
import { guardBeat, termsToKeep } from "./rewrite-guard.js";
import { renderRewritePrompt } from "./rewrite-prompt.js";
import { ScriptSchema, type ScriptBeat, type ScriptV1 } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";

const TICKET = "task/TP-7001/opened";
const PULL = "pr/acme/depot#6420/merged";

/** A beat as the pass holds it: spelled before the guard sees it, the fact id declared where a name would be. */
function spelledBeat(spoken: string, new_terms: string[]): ScriptBeat {
  const script: ScriptV1 = ScriptSchema.parse(scriptWith({ spoken, new_terms }));
  const [beat] = script.beats;
  if (!beat) throw new Error("fixture has no beat");
  return spellSpokenNumbers(beat);
}

const rulesFor = (before: ScriptBeat, rewritten: string): string[] => {
  const spoken = spellSpokenNumbers({ spoken: rewritten, visual: before.visual }).spoken;
  return guardBeat(before, { spoken, labelsAdded: [] }).map((rejection) => rejection.rule);
};

describe("a term declared as a fact id", () => {
  const before = spelledBeat("You could lose the whole dock queue today. One open ticket, TP-7001, shows the dock server can wait forever.", [TICKET]);

  it("accepts a rewrite that keeps saying the ticket's number", () => {
    const rewritten = "You could lose the whole dock queue today. An open ticket, TP-7001, shows the dock server can wait forever.";

    const rules = rulesFor(before, rewritten);

    expect(rules).toEqual([]);
  });

  it("rejects a rewrite that loses the ticket's number", () => {
    const rewritten = "You could lose the whole dock queue today. An open ticket shows the dock server can wait forever.";

    const rules = rulesFor(before, rewritten);

    expect(rules).toContain("new-term");
  });

  it("does not hold a rewrite to a fact id the original never said", () => {
    const silent = spelledBeat("The dock server checks each scan and keeps every row it wrote to the ledger.", [TICKET]);
    const rewritten = "The dock server checks each scan and keeps all the rows it wrote to the ledger.";

    const rules = rulesFor(silent, rewritten);

    expect(rules).toEqual([]);
  });

  it("rejects the fact id pasted into the line, even with its number still in it", () => {
    const rewritten = "You could lose the whole dock queue today. An open ticket, task/TP-7001/opened, shows the dock server can wait forever.";

    const rules = rulesFor(before, rewritten);

    expect(rules).toContain("fact-id");
  });
});

describe("a term written with its digits", () => {
  it("still counts as spoken once the original and the rewrite are spelled", () => {
    const before = spelledBeat("So the landing that counts is PR 6420, and it switched the dock order on for every run.", ["PR 6420"]);

    const rules = rulesFor(before, "So the landing to read is PR 6420, and it switched the dock order on for every run.");

    expect(rules).toEqual([]);
  });

  it("is lost when the rewrite says a different number", () => {
    const before = spelledBeat("So the landing that counts is PR 6420, and it switched the dock order on for every run.", ["PR 6420"]);

    const rules = rulesFor(before, "So the landing to read is PR 6421, and it switched the dock order on for every run.");

    expect(rules).toContain("new-term");
  });
});

describe("a number respelled by the rewrite", () => {
  const before = spelledBeat("So pull requests 6420 and 6421 belong together on the dock board this week.", []);

  it("does not count the old spelling's words as dropped content terms", () => {
    const after = { spoken: "So pull request sixty-four twenty and pull request sixty-four twenty-one belong together on the dock board this week.", labelsAdded: [] };

    const rejections = guardBeat(before, after);

    expect(rejections.map((rejection) => rejection.rule)).not.toContain("terms");
  });

  it("still counts real words dropped beside a number", () => {
    const wordy = spelledBeat("The dock server sends 6420 receipts to the ledger before the morning courier collects them.", []);
    const after = { spoken: "The server sends 6420 receipts.", labelsAdded: [] };

    const rejections = guardBeat(wordy, after);

    expect(rejections.map((rejection) => rejection.rule)).toContain("terms");
  });
});

describe("the terms the prompt asks a rewrite to keep", () => {
  it("names a fact id's item as the line says it, never the id", () => {
    const beat = spelledBeat("Then ticket TP-7001 and the desk server stay open.", [TICKET, "desk server", PULL]);

    const terms = termsToKeep(beat);

    expect(terms).toEqual(["seventy oh one", "desk server"]);
  });

  it("puts no fact id in the rendered prompt", () => {
    const beat = spelledBeat("Then ticket TP-7001 stays open.", [TICKET]);
    const chapter = { id: beat.chapter, label: "Blocker", question: "Why does the queue wait?" };

    const prompt = renderRewritePrompt(chapter, [beat], { round: 1, directives: [{ beat: beat.id, chapter: beat.chapter, numbers: ["seventy oh one"] }] });

    expect(prompt).toContain("Terms to keep: seventy oh one");
    expect(prompt).not.toContain(TICKET);
  });
});
