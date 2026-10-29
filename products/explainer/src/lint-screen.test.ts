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
    expect(hint).toContain('stats-1 shows "47" (in "47 in review")');
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
});

describe("Q-D15 words on screen", () => {
  const SENTENCES = ["router · The router lane wants every match to finish faster", "cache · The cache lane wants its store warm before the rush", "label · Fewer reprints"];

  it("a beat over 20 on-screen words fails", () => {
    const script = dailyWith("goals-1", { visual: { labels: SENTENCES } });

    const row = l0Row(script, "Q-D15");
    const hint = repairHint(row, script);

    expect(row).toMatchObject({ severity: "error", pass: false });
    expect(row.detail_beats).toContain("goals-1");
    expect(hint).toMatch(/goals-1 \(\d+ words\)/);
    expect(hint).toContain("key words");
  });

  it("passes once the rows are key words", () => {
    const script = dailyWith("goals-1", { visual: { labels: ["router · Faster matches", "cache · Warm store", "label · Fewer reprints"] } });

    const row = l0Row(script, "Q-D15");

    expect(row.detail_beats).not.toContain("goals-1");
  });
});

describe("Q-D16 labels that echo the narration", () => {
  it("a label repeating five spoken words fails", () => {
    const script = dailyWith("lanes-1", { visual: { labels: ["router · rewrote its matcher and merged it", "router · Old path behind a switch"] } });

    const row = l0Row(script, "Q-D16");
    const hint = repairHint(row, script);

    expect(row.detail_beats).toContain("lanes-1");
    expect(hint).toContain('lanes-1 "router · rewrote its matcher and merged it"');
    expect(hint).toContain("key words, not the sentence");
  });

  it("passes a label of four shared words", () => {
    const script = dailyWith("lanes-1", { visual: { labels: ["router · rewrote its matcher", "router · Old path behind a switch"] } });

    const row = l0Row(script, "Q-D16");

    expect(row.detail_beats).not.toContain("lanes-1");
  });
});
