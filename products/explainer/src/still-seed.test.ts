import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { screenTokens } from "./drawn-beats.js";
import { repairHint } from "./l0-repair-hints.js";
import type { ScriptV1 } from "./script-schema.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";
import { seedStillCues } from "./still-seed.js";

const cue = (target: string, atCue: string) => ({ action: "V6" as const, target, atCue });
const cuesOf = (script: ScriptV1, id: string) => script.beats.find((beat) => beat.id === id)!.visual.cues;
const beatOf = (script: ScriptV1, id: string) => script.beats.find((beat) => beat.id === id)!;

const SETTLED =
  "The router lane rewrote its matcher and merged it before lunch. Later the old path stayed behind a switch, and all afternoon the matcher kept answering every scan while the night shift watched the docks.";
const settledList = () => dailyWith("lanes-1", { spoken: SETTLED, visual: { cues: [cue("rows-1", "matcher"), cue("rows-2", "switch")] } });
const LONG_REFLECTION =
  "What slows the floor down is the shared review queue, where every lane waits its turn, and the drafts that sit idle until another lane lands first; small lanes ship faster than one big queue, and today showed it again, so tomorrow each lane reviews its own work before noon.";
const stillCard = (held: readonly string[]) =>
  held.reduce((script, id) => dailyWith(id, { heldS: 3 }, script), dailyWith("reflection-2", { plannedS: 20, spoken: LONG_REFLECTION }));

/** What each beat shows, in the forms a listener hears: the labels' words and their numbers spelled. */
function shownWords(script: ScriptV1, id: string): Set<string> {
  const beat = beatOf(script, id);
  const text = beat.visual.labels.join(" ");
  return new Set([...screenTokens(text), ...screenTokens(spellSpokenNumbers({ spoken: text, visual: beat.visual }).spoken)]);
}

describe("the $0 still seed: naming-only cues before the repair", () => {
  it("a stat figure's cue moves to its spoken value", () => {
    const script = dailyWith("stats-1", { visual: { cues: [cue("figures-1", "merges"), cue("figures-2", "reported"), cue("figures-3", "review")] } });

    const { script: seeded } = seedStillCues(script);

    expect(cuesOf(seeded, "stats-1")).toContainEqual(cue("figures-2", "twelve"));
    expect(cuesOf(seeded, "stats-1")).not.toContainEqual(cue("figures-2", "reported"));
  });

  it("a settled list gets a cue on the word naming a row", () => {
    const script = settledList();

    const { script: seeded, moves } = seedStillCues(script);

    expect(cuesOf(seeded, "lanes-1")).toContainEqual(cue("rows-1", "matcher#2"));
    expect(moves).toContainEqual({ beat: "lanes-1", rule: "point", target: "rows-1", atCue: "matcher#2" });
  });

  it("no cue lands on a word that names nothing on screen", () => {
    const script = settledList();

    const { moves } = seedStillCues(script);
    const cued = moves.filter((move) => move.atCue !== undefined);

    expect(cued.length).toBeGreaterThan(0);
    for (const { beat, atCue } of cued) expect(shownWords(script, beat), `${beat} on "${atCue}"`).toContain(atCue!.split("#")[0]);
  });

  it("a claim-card is held only while the held band has room", () => {
    const roomy = stillCard(["ask-1"]);
    const full = stillCard(["ask-1", "goals-1"]);

    const held = beatOf(seedStillCues(roomy).script, "reflection-2");
    const unheld = beatOf(seedStillCues(full).script, "reflection-2");

    expect(held.heldS).toBe(3);
    expect(unheld.heldS).toBeUndefined();
    expect(l0Row(seedStillCues(roomy).script, "Q-D22").detail_beats).not.toContain("reflection-2");
  });
});

describe("Q-D22's hint gives the repair what to point at", () => {
  it("each stretch names the words spoken inside it and the beat's on-screen texts", () => {
    const script = dailyWith("ships-2", {});

    const hint = repairHint(l0Row(script, "Q-D22"), script) ?? "";

    expect(hint).toMatch(/ships-2 3\.6 s to 8\.3 s after "twelve" \(4\.7 s, saying "forty, and the slow tail is nearly gone\."\) with "old match", "new match", "slow tail", "40", "12", "3" on screen;/);
  });
});
