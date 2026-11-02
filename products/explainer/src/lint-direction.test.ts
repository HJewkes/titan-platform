import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { repairHint } from "./l0-repair-hints.js";

const LONG_LINE = "Read the whole digest tonight and then pick the next lane for the floor";
const SOURCE = [{ kind: "computed" as const, text: "floor queue this week" }];

describe("Q-D20 heading and label words, as qa's G9 reads them", () => {
  it("an outro or button line past 10 words fails and names the line", () => {
    const script = dailyWith("ask-1", { visual: { labels: [LONG_LINE, "Open digest"] } });

    const row = l0Row(script, "Q-D20");
    const hint = repairHint(row, script);

    expect(row).toMatchObject({ severity: "error", pass: false, detail_beats: ["ask-1"] });
    expect(hint).toContain(`ask-1 (as button): heading "${LONG_LINE}"`);
  });

  it("passes once the line is its key words", () => {
    const script = dailyWith("ask-1", { visual: { labels: ["Read the digest tonight", "Open digest"] } });

    const row = l0Row(script, "Q-D20");

    expect(row.detail_beats).not.toContain("ask-1");
  });

  it("fails a chrome headline past 10 words", () => {
    const script = dailyWith("goals-1", { visual: { assertion: "Every lane on the floor wants something different from the week ahead of it" } });

    const row = l0Row(script, "Q-D20");

    expect(row.detail_beats).toEqual(["goals-1"]);
  });

  it("fails a bar label past 3 words", () => {
    const script = dailyWith("ships-2", { visual: { labels: ["the old matcher path: 40", "new match: 12", "slow tail: 3"] } });

    const row = l0Row(script, "Q-D20");
    const hint = repairHint(row, script);

    expect(row.detail_beats).toEqual(["ships-2"]);
    expect(hint).toContain('label "the old matcher path"');
  });

  it("leaves a claim card's claim alone, since the page draws it a word to a span", () => {
    const script = dailyWith("reflection-2", { visual: { labels: ["Small lanes ship faster than one big queue on every day of the week"] } });

    const row = l0Row(script, "Q-D20");

    expect(row.detail_beats).not.toContain("reflection-2");
  });
});

describe("Q-D21 first motion, as qa's G7 reads it", () => {
  it("a headline-free beat with no source chip opens still past 0.2 s", () => {
    const script = dailyWith("ask-1", {});

    const row = l0Row(script, "Q-D21");
    const hint = repairHint(row, script);

    expect(row).toMatchObject({ severity: "error", pass: false });
    expect(row.detail_beats).toContain("ask-1");
    expect(hint).toContain("ask-1 (as button, first moves at 0.3 s)");
    expect(hint).toContain("chip");
  });

  it("passes once the beat cites its source in a chip, as its hint asks", () => {
    const script = dailyWith("ask-1", { visual: { chips: SOURCE } });

    const row = l0Row(script, "Q-D21");

    expect(row.detail_beats).not.toContain("ask-1");
  });

  it("opens still only on the headline-free beats with no chip, never on a beat that draws a headline", () => {
    const script = dailyWith("goals-1", {});

    const row = l0Row(script, "Q-D21");

    expect([...row.detail_beats].sort()).toEqual(["ask-1", "reflection-2"]);
  });

  it("leaves out a beat on a custom layer", () => {
    const script = dailyWith("ask-1", { visual: { beat: "kanban-flow", layer: "custom", chips: [] } });

    const row = l0Row(script, "Q-D21");

    expect(row.detail_beats).not.toContain("ask-1");
  });
});
