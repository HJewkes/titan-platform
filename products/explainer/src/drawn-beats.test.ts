import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";

const SEVEN_ROWS = ["a · One", "b · Two", "c · Three", "d · Four", "e · Five", "f · Six", "g · Seven"];

describe("drawn-model rows on a script the template fill refuses", () => {
  it.each(["Q-D15", "Q-D20", "Q-D21"])("%s fails and names the refused beat instead of passing unchecked", (checkId) => {
    const script = dailyWith("side-quests-1", { visual: { labels: SEVEN_ROWS } });

    const row = l0Row(script, checkId);

    expect(row.pass).toBe(false);
    expect(row.detail_beats).toContain("side-quests-1");
  });

  it.each(["Q-D15", "Q-D20", "Q-D21"])("%s leaves a beat the fill accepts out of its findings", (checkId) => {
    const row = l0Row(dailyWith("side-quests-1", {}), checkId);

    expect(row.detail_beats).not.toContain("stats-1");
  });
});
