import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dailyScript, dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { runL0 } from "./eval-l0.js";
import { repairHint } from "./l0-repair-hints.js";
import { pictureChange, timingProfile } from "./qa/timing-gates.js";
import { loadRuleRegistry } from "./rules.js";
import { parseSpine } from "./spine-schema.js";
import { failingErrors, failureList, repairPrompt } from "./workflow/script-draft.js";

const LONG_LANE =
  "The router lane rewrote its matcher this morning, tested it against the old path on every dock, merged it before lunch, kept the old path behind a switch for one more day, and then asked the cache lane to warm its store before the evening rush begins.";
const LONG_REFLECTION =
  "What slows the floor down is the shared review queue, where every lane waits its turn, and the drafts that sit idle until another lane lands first; small lanes ship faster than one big queue, and today showed it again, so tomorrow each lane reviews its own work before noon.";
const cue = (target: string, atCue: string) => ({ action: "V6" as const, target, atCue });
const LINT = { spine: parseSpine(readFileSync(new URL("../fixtures/spike/pipeline-explainer/spine.md", import.meta.url), "utf8")), g2p: { tokens: () => [] } };

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

describe("Q-D17 on a claim-card, a kind that takes no cue", () => {
  const longClaim = (patch: Parameters<typeof dailyWith>[1] = {}) => dailyWith("reflection-2", { plannedS: 20, spoken: LONG_REFLECTION, ...patch });

  it("a cue-less 20 s claim-card fails Q-D17 and its hint reaches the L0 repair prompt", () => {
    const script = longClaim();
    const failing = failingErrors(runL0(script)).filter((row) => row.check_id === "Q-D17");

    const prompt = repairPrompt("", script, failureList(failing, loadRuleRegistry(), script, LINT));

    expect(failing[0]?.detail_beats).toEqual(["reflection-2"]);
    expect(prompt).toContain("- Q-D17: No planned stretch of a beat without a cue runs past the profile's pacing.pictureChangeFailS");
    expect(prompt).toMatch(/Found: beats with a planned stretch of more than 8 s and no cue: reflection-2 \(1\d(\.\d)? s, 0 cues\)/);
  });

  it("a held claim-card still fails Q-D17, as qa's picture-change fails a held cue-less beat", () => {
    const script = longClaim({ heldS: 4 });
    const still = { id: "reflection-2", startS: 0, durationS: 20, cues: [] };
    const qaInput = { timeline: { beats: [still] }, words: new Map(), held: new Set(["reflection-2"]), diffs: [], fps: 30, probed: [], profile: timingProfile() };

    const row = l0Row(script, "Q-D17");
    const gate = pictureChange(qaInput);

    expect(gate.pass).toBe(false);
    expect(row.detail_beats).toEqual(["reflection-2"]);
  });

  it("counts no cue on a claim-card, which the emphasis gate would refuse and qa would never see move", () => {
    const script = longClaim({ visual: { cues: [cue("claim", "turn"), cue("claim", "first"), cue("claim", "big"), cue("claim", "tomorrow")] } });

    const row = l0Row(script, "Q-D17");

    expect(row.detail_beats).toContain("reflection-2");
  });

  it("the repair hint offers a move the claim-card kind can take", () => {
    const script = longClaim({ heldS: 4 });

    const hint = repairHint(l0Row(script, "Q-D17"), script);

    expect(hint).toContain("reflection-2 is a claim-card, which takes no cue, and heldS does not excuse its stretch");
    expect(hint).toMatch(/split it into [23] claim-card beats of at most 8 s of words each, or draw it as a list whose rows each land on a cue/);
  });

  it("passes each claim-card of the split its hint asks for, at most 8 s of words", () => {
    const script = longClaim({ plannedS: 8, spoken: "Small lanes ship faster than one big queue, and today showed it again." });

    const row = l0Row(script, "Q-D17");

    expect(row.detail_beats).not.toContain("reflection-2");
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
