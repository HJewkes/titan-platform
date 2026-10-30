import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { screenTokens } from "./drawn-beats.js";
import { repairHint } from "./l0-repair-hints.js";
import type { ScriptV1 } from "./script-schema.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";
import { holdStillBeats, seedStillCues } from "./still-seed.js";

const cue = (target: string, atCue: string) => ({ action: "V6" as const, target, atCue });
const cuesOf = (script: ScriptV1, id: string) => script.beats.find((beat) => beat.id === id)!.visual.cues;
const beatOf = (script: ScriptV1, id: string) => script.beats.find((beat) => beat.id === id)!;

const SETTLED =
  "The router lane rewrote its matcher and merged it before lunch. Later the old path stayed behind a switch, and all afternoon the matcher kept answering every scan while the night shift watched the docks.";
const settledList = () => dailyWith("lanes-1", { spoken: SETTLED, visual: { cues: [cue("rows-1", "matcher"), cue("rows-2", "switch")] } });
const LONG_REFLECTION =
  "What slows the floor down is the shared review queue, where every lane waits its turn, and the drafts that sit idle until another lane lands first; small lanes ship faster than one big queue, and today showed it again, so tomorrow each lane reviews its own work before noon.";
// Synthetic: the closing ask speaks well past its few words on screen, so its picture stands still.
const LONG_ASK =
  "Read the digest tonight, then pick the next lane for tomorrow, and tell the floor lead which lane should go first so the morning shift knows where to start.";
// The claim's words are never spoken, so no word names it and only the hold is left.
const stillCard = (held: readonly string[], claim = "Waiting sets the pace") =>
  held.reduce((script, id) => dailyWith(id, { heldS: 3 }, script), dailyWith("reflection-2", { plannedS: 20, spoken: LONG_REFLECTION, visual: { labels: [claim] } }));

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

  // Regression (TP-4565): a short-labelled closing button stood still, and four repair rounds never held it.
  it("a lone still button is held by code", () => {
    const script = dailyWith("ask-1", { plannedS: 12, spoken: LONG_ASK });

    const { script: seeded, moves } = seedStillCues(script);

    expect(l0Row(script, "Q-D22").detail_beats).toContain("ask-1");
    expect(beatOf(seeded, "ask-1").heldS).toBe(3);
    expect(moves).toContainEqual({ beat: "ask-1", rule: "hold" });
    expect(l0Row(seeded, "Q-D22").detail_beats).not.toContain("ask-1");
    expect(l0Row(seeded, "Q-D18").pass).toBe(true);
  });

  it("a still button is not held past the held band", () => {
    const script = ["goals-1", "reflection-1"].reduce((held, id) => dailyWith(id, { heldS: 3 }, held), dailyWith("ask-1", { plannedS: 12, spoken: LONG_ASK }));

    const seeded = holdStillBeats(script);

    expect(beatOf(seeded, "ask-1").heldS).toBeUndefined();
    expect(l0Row(seeded, "Q-D18").pass).toBe(true);
  });

  it("a reply that leaves a button still is held by code too", () => {
    const reply = dailyWith("ask-1", { plannedS: 12, spoken: LONG_ASK });

    const held = holdStillBeats(reply);

    expect(beatOf(held, "ask-1").heldS).toBe(3);
  });

  // Regression: the uncued-item rule once cued a claim-card's claim, which lands on the first word with no cue of its own.
  it("a claim-card that stands still nowhere gets no cue", () => {
    const card = { plannedS: 5, spoken: "Waiting is the real cost: drafts sit idle behind the shared review queue.", visual: { beat: "claim-card", labels: ["Waiting costs the most"], cues: [] } };
    const script = dailyWith("reflection-1", card);

    const seeded = beatOf(seedStillCues(script).script, "reflection-1");

    expect(l0Row(script, "Q-D22").detail_beats).not.toContain("reflection-1");
    expect(seeded.visual.cues).toEqual([]);
  });

  it("a claim-card whose claim the voice names is cued on that word, not held", () => {
    const script = stillCard(["ask-1"], "Shared review queue");

    const card = beatOf(seedStillCues(script).script, "reflection-2");

    expect(card.visual.cues.map(({ target }) => target)).toContain("claim");
    expect(card.heldS).toBeUndefined();
  });
});

describe("Q-D22's hint gives the repair what to point at", () => {
  it("each stretch names the words spoken inside it and the beat's on-screen texts", () => {
    const script = dailyWith("ships-2", {});

    const hint = repairHint(l0Row(script, "Q-D22"), script) ?? "";

    expect(hint).toMatch(/ships-2 3\.6 s to 8\.3 s after "twelve" \(4\.7 s, saying "forty, and the slow tail is nearly gone\."\) with "old match", "new match", "slow tail", "40", "12", "3" on screen;/);
  });
});
