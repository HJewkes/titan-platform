import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { repairHint } from "./l0-repair-hints.js";

// Synthetic: the closing ask speaks well past its few words on screen, so its picture stands still.
const LONG_ASK =
  "Read the digest tonight, then pick the next lane for tomorrow, and tell the floor lead which lane should go first so the morning shift knows where to start.";

// The button's clause is the hint's last, so it runs from its lead to the end.
const askClause = (hint: string): string => hint.slice(hint.indexOf("ask-1 is a"));

describe("the Q-D22 hint for a still closing button", () => {
  it("leads with a hold that adds no words and names the label and frame caps on every move that adds text", () => {
    const script = dailyWith("ask-1", { plannedS: 12, spoken: LONG_ASK });
    const row = l0Row(script, "Q-D22");

    const clause = askClause(repairHint(row, script) ?? "");

    expect(row.detail_beats).toContain("ask-1");
    expect(clause).toMatch(/^ask-1 is a button, which reveals nothing on a cue: first hold it with heldS, which adds no words; else show a line/);
    expect(clause).toContain(
      "show a line the voice does not read word for word (its reading time is not still time) within Q-D20 (a heading of at most 10 words and a label of at most 3) and Q-D15 (at most 20 words on screen at once)",
    );
    expect(clause).toContain("or draw it as a list whose rows each land on a cue, under the same Q-D20 and Q-D15 caps");
  });

  it("names the caps on adding an item to a cued kind", () => {
    const script = dailyWith("ask-1", { plannedS: 12, spoken: LONG_ASK });

    const hint = repairHint(l0Row(script, "Q-D22"), script) ?? "";

    expect(hint).toContain("so add the item within Q-D20 (a heading of at most 10 words and a label of at most 3) and Q-D15");
  });
});

describe("the Q-D22 hint for a still closing button with the held band full", () => {
  it("leads with a line the voice does not read, not a hold", () => {
    const still = dailyWith("ask-1", { plannedS: 12, spoken: LONG_ASK });
    const script = ["goals-1", "reflection-1"].reduce((held, id) => dailyWith(id, { heldS: 3 }, held), still);

    const clause = askClause(repairHint(l0Row(script, "Q-D22"), script) ?? "");

    expect(clause).toMatch(/^ask-1 is a button, which reveals nothing on a cue: the held band is full \(goals-1, reflection-1 of at most 2\), so it takes no hold; else show a line the voice does not read/);
  });
});

describe("the Q-D20 hint for a closing button", () => {
  // Regression (TP-4565): a repair shortened a button's label and left it still, since only Q-D22's hint said to hold it.
  it("names the hold, so a shorter label does not leave the button still", () => {
    const script = dailyWith("ask-1", { visual: { labels: ["Answer the call today: how do we get every lane into one shared queue?"] } });
    const row = l0Row(script, "Q-D20");

    const hint = repairHint(row, script) ?? "";

    expect(row.detail_beats).toContain("ask-1");
    expect(hint).toContain("ask-1 is a button, which reveals nothing on a cue, so a shorter label leaves it standing still: hold it with heldS as well");
    expect(hint).toContain("to pass Q-D22 (a piece that is not held stands still at most");
  });

  it("with the held band full, asks for words the voice does not read in place of a hold", () => {
    const labelled = dailyWith("ask-1", { visual: { labels: ["Answer the call today: how do we get every lane into one shared queue?"] } });
    const script = ["goals-1", "reflection-1"].reduce((held, id) => dailyWith(id, { heldS: 3 }, held), labelled);

    const hint = repairHint(l0Row(script, "Q-D20"), script) ?? "";

    expect(hint).toContain("ask-1 is a button, which reveals nothing on a cue, so a shorter label leaves it standing still, and the held band is full (goals-1, reflection-1 of at most 2)");
    expect(hint).toContain("write the short label in words the voice does not read word for word");
    expect(hint).not.toContain("hold it with heldS");
  });

  it("asks no hold of a button already held", () => {
    const script = dailyWith("ask-1", { heldS: 3, visual: { labels: ["Answer the call today: how do we get every lane into one shared queue?"] } });

    const hint = repairHint(l0Row(script, "Q-D20"), script) ?? "";

    expect(hint).not.toContain("heldS");
  });
});
