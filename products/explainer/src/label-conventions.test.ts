import { describe, expect, it } from "vitest";
import { labelConventionFaults, labelConventionsVerdict, LABEL_HINT } from "./label-conventions.js";
import { budgetSection } from "./script-budget.js";

/** A one-beat daily draft: the chapter, the beat spec it names and its labels. */
const daily = (chapter: string, beat: string, labels: string[], profile = "daily-overview"): Parameters<typeof labelConventionFaults>[0] => ({ profile, beats: [{ id: "b1", chapter, visual: { beat, labels } }] });

describe("the daily's label conventions in the script prompt", () => {
  // Mutation: dropping labelRules from budgetSection (or the labels from the yaml) leaves the model unaware of all four.
  it("carries the lane chip, compare, arch-map and chart conventions", () => {
    const section = budgetSection([], "daily-overview");

    expect(section).toContain('"<lane> · <text>"');
    expect(section).toContain('"before: <text>" and one "after: <text>"');
    expect(section).toContain("2-5 short package or stage names in flow order");
    expect(section).toContain('three or more "name: number" labels; a date name (YYYY-MM-DD) draws a 7-day graph');
  });

  it("carries no label rules for a profile whose blocks name none", () => {
    expect(budgetSection([], "pr-overview")).not.toContain("by the chapter's convention");
  });
});

describe("the label-conventions check", () => {
  // Mutation: requiring only one side of the compare (some -> an always-true test) passes this beat.
  it("warns on a ships compare with only a before label, with the repair hint", () => {
    const draft = daily("ships", "compare", ["before: slow scan", "faster scan"]);

    const verdict = labelConventionsVerdict(draft);

    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain("b1 (compare) lacks");
    expect(verdict.detail).toContain(LABEL_HINT);
  });

  it("passes the conventional labels of each view", () => {
    const ok = [
      daily("lanes", "list", ["ops · cleared the queue"]),
      daily("ships", "compare", ["before: slow", "after: fast"]),
      daily("ships", "arch-map", ["intake", "ledger", "dock"]),
      daily("stats", "chart", ["2026-01-01: 3", "2026-01-02: 5", "2026-01-03: 4"]),
    ];

    expect(ok.flatMap(labelConventionFaults)).toEqual([]);
  });

  it("flags a lanes list row without a lane, a chart with two numbers and an arch-map of six", () => {
    const faults = [
      daily("lanes", "list", ["cleared the queue"]),
      daily("stats", "chart", ["a: 1", "b: 2", "c"]),
      daily("ships", "arch-map", ["a", "b", "c", "d", "e", "f"]),
    ].map((draft) => labelConventionFaults(draft).length);

    expect(faults).toEqual([2, 2, 2]);
  });

  it("ignores other chapters and other profiles", () => {
    expect(labelConventionFaults(daily("ask", "list", ["plain"]))).toEqual([]);
    expect(labelConventionFaults(daily("lanes", "list", ["plain"], "pr-overview"))).toEqual([]);
  });
});
