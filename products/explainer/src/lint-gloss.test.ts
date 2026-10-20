import { describe, expect, it } from "vitest";
import { explainRoutes } from "./lint-gloss.js";
import { buildPaceBeats, type PaceSourceBeat } from "./pace-items.js";
import { v4Durations, v4FullScript } from "./spike-fixtures.test-helpers.js";
import { fromSpikeScript } from "./spike-script.js";
import { readTiming } from "./timing.js";

interface Spec {
  spoken: string;
  chapter?: string;
  cues?: (string | [target: string, atCue: string])[];
}

const cueOf = (cue: string | [string, string]) => (typeof cue === "string" ? { target: cue } : { target: cue[0], atCue: cue[1] });

const source = (id: string, { spoken, chapter = "ch1", cues = [] }: Spec): PaceSourceBeat => ({
  id,
  chapter,
  fn: "WHAT",
  spoken,
  plannedS: 10,
  mapBeside: false,
  cues: cues.map(cueOf),
  titles: [],
  reveals: [],
  pins: [],
  cards: [],
  terms: [],
});

const beatsOf = (specs: Record<string, Spec>) => buildPaceBeats(Object.entries(specs).map(([id, spec]) => source(id, spec)));

const JOBS = ["job:choose", "job:make", "job:prove"];

describe("M3-pre: beats that name their items without explaining them", () => {
  it("routes a three-item beat that only names its items, with every label", () => {
    const beats = beatsOf({ b1: { spoken: "Choose, make and prove.", cues: JOBS } });

    expect(explainRoutes(beats)).toEqual([{ beat: "b1", items: ["choose", "make", "prove"] }]);
  });

  it("does not route the same items when each is followed by a gloss clause of four words", () => {
    const spoken = "Choose picks the next ready task. Make writes tested code changes. Prove runs every required check today.";
    const beats = beatsOf({ b1: { spoken, cues: JOBS } });

    expect(explainRoutes(beats)).toEqual([]);
  });

  // Mutation: scoring each item against the whole spoken text finds the trailing clause's words and routes nothing.
  it("reads an item's gloss from its own clause, not from the rest of the line", () => {
    const spoken = "Choose, make and prove, then the release train ships reviewed builds nightly.";
    const beats = beatsOf({ b1: { spoken, cues: JOBS } });

    expect(explainRoutes(beats).map((r) => r.beat)).toEqual(["b1"]);
  });

  // Mutation: reading later beats across chapters clears b1 in the next-chapter case too.
  it("counts an item spoken again later in the same chapter as explained, but not one spoken in the next chapter", () => {
    const named = { spoken: "Choose, make and prove.", cues: JOBS };
    const later = "You choose a task, make the change and prove it.";

    const sameChapter = beatsOf({ b1: named, b2: { spoken: later } });
    const nextChapter = beatsOf({ b1: named, b2: { spoken: later, chapter: "ch2" } });

    expect(explainRoutes(sameChapter)).toEqual([]);
    expect(explainRoutes(nextChapter).map((r) => r.beat)).toEqual(["b1"]);
  });

  // Mutation: dropping the half rule routes b1 on its mean gloss alone.
  it("does not route a beat where fewer than half its items are named only", () => {
    const beats = beatsOf({
      b1: { spoken: "Choose, make, prove and land.", cues: [...JOBS, "job:land"] },
      b2: { spoken: "You choose, make and prove each change." },
    });

    expect(explainRoutes(beats)).toEqual([]);
  });

  // Mutation: a floor of two new items routes b1.
  it("never routes a beat with only two new items", () => {
    const beats = beatsOf({ b1: { spoken: "Choose and make.", cues: ["job:choose", "job:make"] } });

    expect(explainRoutes(beats)).toEqual([]);
  });

  // Mutation: reading each item's clause from its label, not its cue, finds "pool rules replace the weighted score".
  it("reads an item's gloss from the clause its own cue word is spoken in", () => {
    const spoken = "Ten: pool rules replace the weighted score. Eleven: researchers study patterns first. Both defaults hold.";
    const cues: Spec["cues"] = [["open:Q10 pool rules", "Ten"], ["open:Q11 research fan-out", "Eleven"], ["open:defaults hold", "defaults"]];

    expect(explainRoutes(beatsOf({ b1: { spoken, cues } }))).toEqual([{ beat: "b1", items: ["Q10 pool rules", "Q11 research fan-out", "defaults hold"] }]);
  });

  // Mutation: taking a shared cue's clause as each item's own scores every follow-up with "settle the technical forks".
  it("reads items that share one cue word from the clause naming each, not from the shared clause", () => {
    const spoken = "Eight follow-ups settle the technical forks, from queue age to landing.";
    const cues: Spec["cues"] = [["card:queue age", "Eight"], ["card:roster", "Eight"], ["card:landing", "Eight"]];

    expect(explainRoutes(beatsOf({ b1: { spoken, cues } })).map((r) => r.beat)).toEqual(["b1"]);
  });

  // Mutation: dropping number words as stopwords leaves each rung clause with at most one gloss word and routes b1.
  it("counts a spoken number the label does not show as a gloss word", () => {
    const spoken = "Four wakes fixers, five shadows the adversary, six requires contracts.";
    const cues: Spec["cues"] = [["rung:M4|fixer wakes", "wakes"], ["rung:M5|adversary shadow", "adversary"], ["rung:M6|plan contract", "contracts"]];

    expect(explainRoutes(beatsOf({ b1: { spoken, cues } }))).toEqual([]);
  });

  // Mutation: counting "five" in "five-hour" as a gloss of the "5-hour" label lifts the mean gloss to one and clears b1.
  it("does not count a spoken number that restates a digit on the label", () => {
    const spoken = "Hard stops: the five-hour ceiling, the seven-day reserve, the three-strike rule.";
    const cues: Spec["cues"] = [["row:5-hour ceiling", "five-hour"], ["row:7-day reserve", "seven-day"], ["row:3-strike rule", "three-strike"]];

    expect(explainRoutes(beatsOf({ b1: { spoken, cues } })).map((r) => r.beat)).toEqual(["b1"]);
  });

  it("leaves out an item whose label has no content words, so it cannot lift a beat to three items", () => {
    const beats = beatsOf({ b1: { spoken: "Why, make and prove.", cues: ["job:why", "job:make", "job:prove"] } });

    expect(explainRoutes(beats)).toEqual([]);
  });
});

describe("M3-pre on the full v4 script", () => {
  const v4 = () => fromSpikeScript(v4FullScript(), readTiming(v4Durations()));

  it("reads all 75 beats with heard durations", () => {
    const { beats } = v4();

    expect(beats).toHaveLength(75);
    expect(beats.every((b) => b.timed)).toBe(true);
  });

  // The L0 golden: script-method's ten, r10-6b-q10-q11 (routed through its "Ten:" cue clause) included and
  // r9-3-middle (whose rung numbers each add a gloss word) left out. Any threshold change moves this list.
  it("routes exactly script-method's ten beats", () => {
    const routes = explainRoutes(v4().beats);

    expect(routes.map((r) => r.beat)).toEqual([
      "r1-5-seams",
      "r1-7-promise",
      "r2-1-jobs",
      "r3-7-simple",
      "r4-1-plan",
      "r7-3-caps",
      "r7-4b-score",
      "r10-6b-q10-q11",
      "r10-7-followups",
      "r10-7b-research",
    ]);
    expect(routes.find((r) => r.beat === "r10-7b-research")?.items).toEqual(["R-A engines", "R-B build memo", "R-C waits + claims", "R-D engine audit"]);
  });
});
