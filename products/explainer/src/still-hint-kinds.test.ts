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
