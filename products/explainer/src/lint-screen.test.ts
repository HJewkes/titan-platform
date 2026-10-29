import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { repairHint } from "./l0-repair-hints.js";

const STATS_SPOKEN = "Nine merges landed today, twelve lanes reported, and the review queue holds five pull requests.";

describe("Q-D14 on-screen numbers are spoken", () => {
  it("a label number the beat never speaks fails and names the number", () => {
    const script = dailyWith("stats-1", { visual: { labels: ["9 merges", "12 lanes", "47 in review"] } });

    const row = l0Row(script, "Q-D14");
    const hint = repairHint(row, script);

    expect(row).toMatchObject({ severity: "error", pass: false, detail_beats: ["stats-1"] });
    expect(hint).toContain('stats-1 shows "47" (in "47")');
    expect(hint).toContain("say it or drop it");
  });

  it("passes once the beat says the number its hint names", () => {
    const script = dailyWith("stats-1", { visual: { labels: ["9 merges", "12 lanes", "47 in review"] }, spoken: STATS_SPOKEN.replace("five", "forty-seven") });

    const row = l0Row(script, "Q-D14");

    expect(row.pass).toBe(true);
  });

  it("a stat chip's numbers count as shown", () => {
    const script = dailyWith("stats-1", { visual: { chips: [{ kind: "computed", text: "$3.20 over 9 merges" }] } });

    const row = l0Row(script, "Q-D14");
    const hint = repairHint(row, script);

    expect(row.detail_beats).toEqual(["stats-1"]);
    expect(hint).toContain('"$3.20"');
    expect(hint).not.toContain('"9"');
  });

  it("holds a chart to its largest bar, as qa does, so an unspoken small bar passes", () => {
    const script = dailyWith("ships-2", { visual: { labels: ["old match: 40", "new match: 12", "slow tail: 3"] } });

    const row = l0Row(script, "Q-D14");

    expect(row.pass).toBe(true);
  });

  it("counts every number of a chart the fill draws as a list, as qa reads its rows", () => {
    const script = dailyWith("ships-2", { visual: { labels: ["north: 3", "south: 9", "east is busy 12 trucks"] }, spoken: "The east dock is the busy one, at twelve trucks." });

    const row = l0Row(script, "Q-D14");
    const hint = repairHint(row, script);

    expect(row.detail_beats).toEqual(["ships-2"]);
    expect(hint).toContain('"3" (in "north: 3")');
    expect(hint).toContain('"9" (in "south: 9")');
  });

  it("counts every point of a line chart, which the page draws as plain values, not bars", () => {
    const script = dailyWith("ships-2", { visual: { labels: ["2026-10-01: 4", "2026-10-02: 7", "2026-10-03: 12"] }, spoken: "Deploys climbed to twelve a day." });

    const row = l0Row(script, "Q-D14");
    const hint = repairHint(row, script);

    expect(row.detail_beats).toEqual(["ships-2"]);
    expect(hint).toContain('"4" (in "4")');
    expect(hint).toContain('"7" (in "7")');
  });

  it("reads the chapter label a fact-flash beat draws as its heading", () => {
    const base = dailyWith("reflection-2", { visual: { beat: "fact-flash", labels: ["Small lanes ship faster"] } });
    const script = { ...base, chapters: base.chapters.map((chapter) => (chapter.id === "reflection" ? { ...chapter, label: "3 lanes stalled" } : chapter)) };

    const row = l0Row(script, "Q-D14");
    const hint = repairHint(row, script);

    expect(row.detail_beats).toContain("reflection-2");
    expect(hint).toContain('reflection-2 shows "3" (in "3 lanes stalled")');
  });
});

describe("Q-D16 labels that echo the narration", () => {
  it("a label repeating five spoken words fails", () => {
    const script = dailyWith("lanes-1", { visual: { labels: ["router · rewrote its matcher and merged it", "router · Old path behind a switch"] } });

    const row = l0Row(script, "Q-D16");
    const hint = repairHint(row, script);

    expect(row.detail_beats).toContain("lanes-1");
    expect(hint).toContain('lanes-1 "rewrote its matcher and merged it"');
    expect(hint).toContain("key words, not the sentence");
  });

  it("passes a label of four shared words", () => {
    const script = dailyWith("lanes-1", { visual: { labels: ["router · rewrote its matcher", "router · Old path behind a switch"] } });

    const row = l0Row(script, "Q-D16");

    expect(row.detail_beats).not.toContain("lanes-1");
  });
});
