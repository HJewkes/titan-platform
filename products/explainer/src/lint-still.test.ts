import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { runL0 } from "./eval-l0.js";
import { repairHint } from "./l0-repair-hints.js";
import { loadRuleRegistry } from "./rules.js";
import { parseSpine } from "./spine-schema.js";
import { failingErrors, failureList, repairPrompt } from "./workflow/script-draft.js";

const cue = (target: string, atCue: string) => ({ action: "V6" as const, target, atCue });
const LINT = { spine: parseSpine(readFileSync(new URL("../fixtures/spike/pipeline-explainer/spine.md", import.meta.url), "utf8")), g2p: { tokens: () => [] } };
const ROUTER = "The router lane rewrote its matcher and merged it before lunch, with the old path kept behind a switch.";
const ROUTER_ROWS = ["router · Matcher rewrite merged", "router · Merged before lunch", "router · Old path behind a switch"];

describe("Q-D22 planned still stretches, qa's static-window at script time", () => {
  it("a beat with a 5 s planned gap between revealing cues fails and names the gap", () => {
    const script = dailyWith("ships-2", {});

    const row = l0Row(script, "Q-D22");
    const hint = repairHint(row, script);

    expect(row).toMatchObject({ severity: "error", pass: false });
    expect(row.detail_beats).toContain("ships-2");
    expect(hint).toMatch(/stand still more than 3 s between reveals: .*ships-2 2\.1 s to 7\.3 s after "twelve" \(5\.2 s\)/);
  });

  it("passes once a revealing cue lands inside the stretch, as its hint asks", () => {
    const script = dailyWith("lanes-1", { spoken: ROUTER, visual: { labels: ROUTER_ROWS, cues: [cue("rows-1", "matcher"), cue("rows-2", "lunch"), cue("rows-3", "switch")] } });

    const row = l0Row(script, "Q-D22");

    expect(row.detail_beats).not.toContain("lanes-1");
  });

  it("a cue on a word no element reveals on does not close a gap", () => {
    const script = dailyWith("lanes-1", { spoken: ROUTER, visual: { cues: [cue("rows-1", "matcher"), cue("rows-1", "lunch"), cue("rows-2", "switch")] } });

    const row = l0Row(script, "Q-D22");
    const hint = repairHint(row, script);

    expect(row.detail_beats).toContain("lanes-1");
    expect(hint).toMatch(/lanes-1 [\d.]+ s to [\d.]+ s after "matcher"/);
  });

  it("a cue-less claim-card longer than 3.5 s fails unless held", () => {
    const loose = dailyWith("reflection-2", {});
    const held = dailyWith("reflection-2", { heldS: 3 });

    const failing = l0Row(loose, "Q-D22");
    const passing = l0Row(held, "Q-D22");

    expect(failing.detail_beats).toContain("reflection-2");
    expect(repairHint(failing, loose)).toContain("reflection-2 0 s to 5.5 s from the cut (5.5 s)");
    expect(repairHint(failing, loose)).toContain("reflection-2 is a claim-card, which reveals nothing on a cue");
    expect(passing.detail_beats).not.toContain("reflection-2");
  });

  it("a failing still stretch reaches the L0 repair prompt with its hint", () => {
    const script = dailyWith("ships-2", {});
    const failing = failingErrors(runL0(script)).filter((row) => row.check_id === "Q-D22");

    const prompt = repairPrompt("", script, failureList(failing, loadRuleRegistry(), script, LINT));

    expect(prompt).toContain("- Q-D22: No planned stretch of a beat between cues that reveal an element runs past the profile's pacing.staticMaxS, unless the beat is held");
    expect(prompt).toMatch(/Found: beats whose picture would stand still more than 3 s between reveals: .*ships-2/);
  });
});
