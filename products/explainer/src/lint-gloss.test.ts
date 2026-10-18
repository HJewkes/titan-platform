import { describe, expect, it } from "vitest";
import { explainRoutes } from "./lint-gloss.js";
import { buildPaceBeats, type PaceSourceBeat } from "./pace-items.js";
import { v4Durations, v4FullScript } from "./spike-fixtures.test-helpers.js";
import { fromSpikeScript } from "./spike-script.js";
import { readTiming } from "./timing.js";

interface Spec {
  spoken: string;
  chapter?: string;
  cues?: string[];
}

const source = (id: string, { spoken, chapter = "ch1", cues = [] }: Spec): PaceSourceBeat => ({
  id,
  chapter,
  fn: "WHAT",
  spoken,
  plannedS: 10,
  mapBeside: false,
  cues: cues.map((target) => ({ target })),
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

  // Script-method's ten, less r10-6b-q10-q11 (a judged false positive it caught only through its "Ten:" cut) and
  // plus r9-3-middle (a ch9 rung list whose items each get one clause). Any threshold change moves this list.
  it("routes all four judged-true beats and differs from script-method's ten by two", () => {
    const routes = explainRoutes(v4().beats);

    expect(routes.map((r) => r.beat)).toEqual([
      "r1-5-seams",
      "r1-7-promise",
      "r2-1-jobs",
      "r3-7-simple",
      "r4-1-plan",
      "r7-3-caps",
      "r7-4b-score",
      "r9-3-middle",
      "r10-7-followups",
      "r10-7b-research",
    ]);
    expect(routes.find((r) => r.beat === "r10-7b-research")?.items).toEqual(["R-A engines", "R-B build memo", "R-C waits + claims", "R-D engine audit"]);
  });
});
