import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { runL0 } from "./eval-l0.js";
import { repairHint } from "./l0-repair-hints.js";
import { scriptPacing } from "./lint-cadence.js";
import { stillBeats } from "./lint-still.js";
import { loadRuleRegistry } from "./rules.js";
import { parseSpine } from "./spine-schema.js";
import { failingErrors, failureList, repairPrompt } from "./workflow/script-draft.js";

const cue = (target: string, atCue: string) => ({ action: "V6" as const, target, atCue });
const LINT = { spine: parseSpine(readFileSync(new URL("../fixtures/spike/pipeline-explainer/spine.md", import.meta.url), "utf8")), g2p: { tokens: () => [] } };
const ROUTER = "The router lane rewrote its matcher and merged it before lunch, with the old path kept behind a switch.";
const ROUTER_ROWS = ["router · Matcher rewrite merged", "router · Merged before lunch", "router · Old path behind a switch"];
const LONG_LANE =
  "The router lane rewrote its matcher this morning, tested it against the old path on every dock, merged it before lunch, kept the old path behind a switch for one more day, and then asked the cache lane to warm its store before the evening rush begins.";
const LONG_REFLECTION =
  "What slows the floor down is the shared review queue, where every lane waits its turn, and the drafts that sit idle until another lane lands first; small lanes ship faster than one big queue, and today showed it again, so tomorrow each lane reviews its own work before noon.";
const claimCard = (plannedS: number, spoken: string, claim: string) => ({ plannedS, spoken, visual: { beat: "claim-card", labels: [claim], cues: [] } });

describe("Q-D22 planned still stretches, qa's static-window at script time", () => {
  it("a beat with a 5 s planned gap between revealing cues fails and names the gap", () => {
    const script = dailyWith("ships-2", {});

    const row = l0Row(script, "Q-D22");
    const hint = repairHint(row, script);

    expect(row).toMatchObject({ severity: "error", pass: false });
    expect(row.detail_beats).toContain("ships-2");
    expect(hint).toMatch(/stand still more than 3 s between reveals, outside the reading time of unspoken text: .*ships-2 3\.6 s to 8\.3 s after "twelve" \(4\.7 s\)/);
  });

  it("passes once a revealing cue lands inside the stretch, as its hint asks", () => {
    const script = dailyWith("lanes-1", { spoken: ROUTER, visual: { labels: ROUTER_ROWS, cues: [cue("rows-1", "matcher"), cue("rows-2", "lunch"), cue("rows-3", "switch")] } });

    const row = l0Row(script, "Q-D22");

    expect(row.detail_beats).not.toContain("lanes-1");
  });

  it("a cue on a word no element reveals on does not close a gap", () => {
    const echoes = ["against", "lunch", "switch", "asked"].map((word) => cue("rows-1", word));
    const script = dailyWith("lanes-1", { spoken: LONG_LANE, visual: { cues: [cue("rows-1", "matcher"), ...echoes, cue("rows-2", "store")] } });

    const row = l0Row(script, "Q-D22");
    const hint = repairHint(row, script);

    expect(row.detail_beats).toContain("lanes-1");
    expect(hint).toMatch(/lanes-1 [\d.]+ s to [\d.]+ s after "matcher"/);
  });

  it("a cue-less claim-card still past its reading hold fails unless held", () => {
    const loose = dailyWith("reflection-2", { plannedS: 20, spoken: LONG_REFLECTION });
    const held = dailyWith("reflection-2", { plannedS: 20, spoken: LONG_REFLECTION, heldS: 3 });

    const failing = l0Row(loose, "Q-D22");
    const passing = l0Row(held, "Q-D22");
    const hint = repairHint(failing, loose) ?? "";

    expect(failing.detail_beats).toContain("reflection-2");
    expect(hint).toMatch(/reflection-2 [\d.]+ s to [\d.]+ s after "What"/);
    expect(hint).toContain("reflection-2 is a claim-card, which reveals nothing on a cue: hold it, show a claim the voice does not read word for word");
    expect(hint).not.toContain("trim its words");
    expect(passing.detail_beats).not.toContain("reflection-2");
  });

  // Regression: Q-D22 once counted qa's reading holds as still time, so no unheld claim-card could pass it with Q-D19.
  it("three unheld claim-cards that pass the fill floor and the echo rule pass on the reading time of their unspoken text", () => {
    const cards = [
      ["ships-2", claimCard(5, "The matcher now answers in a fraction of the old time, tail gone.", "Matching got fast")],
      ["reflection-1", claimCard(5, "Waiting is the real cost: drafts sit idle behind the shared review queue.", "Waiting costs the most")],
      ["reflection-2", claimCard(5, "Small lanes ship faster than one big queue, and today showed it again.", "Small lanes win")],
    ] as const;
    const script = cards.reduce((built, [id, patch]) => dailyWith(id, patch, built), dailyWith("ships-1", {}));
    const ids = cards.map(([id]) => id);
    const failing = (check: string) => l0Row(script, check).detail_beats.filter((id) => (ids as readonly string[]).includes(id));

    const rows = ["Q-D16", "Q-D19", "Q-D22"].map(failing);

    expect(rows).toEqual([[], [], []]);
  });

  it("a failing still stretch reaches the L0 repair prompt with its hint", () => {
    const script = dailyWith("ships-2", {});
    const failing = failingErrors(runL0(script)).filter((row) => row.check_id === "Q-D22");

    const prompt = repairPrompt("", script, failureList(failing, loadRuleRegistry(), script, LINT));

    expect(prompt).toContain("- Q-D22: No planned still run of a beat, between cues that reveal an element and outside the reading hold of text it does not say, passes the profile's pacing.staticMaxS, unless the beat is held");
    expect(prompt).toMatch(/Found: beats whose picture would stand still more than 3 s between reveals, outside the reading time of unspoken text: .*ships-2/);
  });
});

// Every text here is spoken, so no reading hold covers a stretch and only the picture's own motion breaks it.
const SAID = "What did each lane move? The router lane merged its matcher rewrite and kept the old path behind a switch.";
const SAID_ROWS = ["router · Matcher rewrite merged", "router · Kept the old path", "router · Behind a switch"];
const saidLane = (cues: { action: "V6"; target: string; atCue: string }[]) =>
  dailyWith("lanes-1", { spoken: SAID, visual: { assertion: "The router lane merged its matcher", labels: SAID_ROWS, cues } });
const stillOf = (script: ReturnType<typeof dailyWith>, id: string) => stillBeats(script, scriptPacing(script)!).find(({ beat }) => beat.id === id)?.stretches ?? [];

describe("Q-D22 reads the picture qa sees: fill reveals, the settle and each kind's own motion", () => {
  it("a row the fill reveals on the first word closes the stretch from the cut", () => {
    const script = saidLane([cue("rows-2", "merged")]);

    const early = stillOf(script, "lanes-1").filter(({ fromS }) => fromS < 3);

    expect(early).toEqual([]);
  });

  it("a beat whose voice runs short of plan stands still through the settle", () => {
    const script = saidLane([cue("rows-2", "merged"), cue("rows-3", "kept")]);

    const found = stillOf(script, "lanes-1");

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ after: "kept" });
    expect(found[0]!.toS).toBeCloseTo(9, 0);
  });

  it("an outro's fade is motion", () => {
    const script = dailyWith("ask-1", { plannedS: 5.5 });

    const row = l0Row(script, "Q-D22");

    expect(row.detail_beats).not.toContain("ask-1");
  });
});

