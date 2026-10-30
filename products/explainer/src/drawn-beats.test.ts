import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { repairHint } from "./l0-repair-hints.js";
import { draftFillRefusals } from "./script-fill.js";

const SEVEN_ROWS = ["a · One", "b · Two", "c · Three", "d · Four", "e · Five", "f · Six", "g · Seven"];

describe("drawn-model rows on a script the template fill refuses", () => {
  it.each(["Q-D15", "Q-D20", "Q-D21"])("%s fails and names the refused beat instead of passing unchecked", (checkId) => {
    const script = dailyWith("side-quests-1", { visual: { labels: SEVEN_ROWS } });

    const row = l0Row(script, checkId);

    expect(row.pass).toBe(false);
    expect(row.detail_beats).toContain("side-quests-1");
  });

  it.each(["Q-D15", "Q-D20", "Q-D21"])("%s leaves out a beat whose only fault is a cue target, which the fill still draws", (checkId) => {
    const cues = [{ action: "V6" as const, target: "no-such-element", atCue: "merges" }];
    const script = dailyWith("stats-1", { visual: { cues } });
    expect(draftFillRefusals(script).map((fault) => fault.beat)).toEqual(["stats-1"]);

    const row = l0Row(script, checkId);

    expect(row.detail_beats).not.toContain("stats-1");
  });

  it.each(["Q-D15", "Q-D20", "Q-D21"])("%s hint sends a refused beat to its template-fill row", (checkId) => {
    const script = dailyWith("side-quests-1", { visual: { labels: SEVEN_ROWS } });

    const hint = repairHint(l0Row(script, checkId), script);

    expect(hint).toContain("side-quests-1 (the template fill refuses it: answer its template-fill row)");
  });
});
