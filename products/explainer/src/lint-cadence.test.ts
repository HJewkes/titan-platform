import { describe, expect, it } from "vitest";
import { dailyScript, dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { repairHint } from "./l0-repair-hints.js";

const LONG_LANE =
  "The router lane rewrote its matcher this morning, tested it against the old path on every dock, merged it before lunch, kept the old path behind a switch for one more day, and then asked the cache lane to warm its store before the evening rush begins.";
const cue = (target: string, atCue: string) => ({ action: "V6" as const, target, atCue });

describe("Q-D17 planned cue gaps", () => {
  it("a planned cue gap over 8 s fails", () => {
    const script = dailyWith("lanes-1", { spoken: LONG_LANE, visual: { cues: [cue("rows-1", "matcher")] } });

    const row = l0Row(script, "Q-D17");
    const hint = repairHint(row, script);

    expect(row).toMatchObject({ severity: "error", pass: false, detail_beats: ["lanes-1"] });
    expect(hint).toMatch(/more than 8 s and no cue: lanes-1 \(15(\.\d)? s, 1 cues\)/);
  });

  it("passes once a cue lands inside each long stretch, as its hint asks", () => {
    const cues = [cue("rows-1", "matcher"), cue("rows-1", "lunch"), cue("rows-2", "switch"), cue("rows-2", "store")];
    const script = dailyWith("lanes-1", { spoken: LONG_LANE, visual: { cues } });

    const row = l0Row(script, "Q-D17");

    expect(row.detail_beats).not.toContain("lanes-1");
  });
});

describe("Q-D18 held beats", () => {
  it("a script with no held beat fails against pacing.held 1-2", () => {
    const script = dailyScript();

    const row = l0Row(script, "Q-D18");
    const hint = repairHint(row, script);

    expect(row).toMatchObject({ severity: "error", pass: false, value: 0, threshold: 1 });
    expect(hint).toContain("0 beats are held, under the profile's 1-2; set heldS");
    expect(hint).toContain("reflection-2");
  });

  it("passes once one beat declares the hold its hint asks for", () => {
    const script = dailyWith("reflection-2", { heldS: 3 });

    const row = l0Row(script, "Q-D18");

    expect(row).toMatchObject({ pass: true, value: 1 });
  });

  it("fails three held beats and names them", () => {
    const script = ["reflection-1", "reflection-2", "stats-1"].reduce((held, id) => dailyWith(id, { heldS: 2 }, held), dailyScript());

    const row = l0Row(script, "Q-D18");

    expect(row).toMatchObject({ pass: false, value: 3, detail_beats: ["stats-1", "reflection-1", "reflection-2"] });
    expect(repairHint(row, script)).toContain("drop heldS from all but 2");
  });
});

describe("Q-D19 fill floor", () => {
  it("a body beat far under its word cap fails and names its words against the cap", () => {
    const script = dailyScript();

    const row = l0Row(script, "Q-D19");
    const hint = repairHint(row, script);

    expect(row.detail_beats).toContain("lanes-1");
    expect(row.detail_beats).not.toContain("ask-1");
    expect(hint).toContain("lanes-1 19/50 words (write at least 40)");
  });

  it("passes a beat written to the floor its hint names", () => {
    const script = dailyWith("lanes-1", { spoken: LONG_LANE });

    const row = l0Row(script, "Q-D19");

    expect(row.detail_beats).not.toContain("lanes-1");
  });

  it("leaves a held beat quiet", () => {
    const script = dailyWith("reflection-2", { heldS: 3 });

    const row = l0Row(script, "Q-D19");

    expect(row.detail_beats).not.toContain("reflection-2");
  });
});
