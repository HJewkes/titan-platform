import { describe, expect, it } from "vitest";
import { L0_CHECKS, l0HardPass, runL0 } from "./eval-l0.js";
import { chapterPace, paceCheck, paceRows } from "./lint-pace.js";
import { buildPaceBeats, type PaceSourceBeat } from "./pace-items.js";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { fromSpikeScript } from "./spike-script.js";
import { v4Durations, v4Script } from "./spike-fixtures.test-helpers.js";
import { readTiming, type ScriptTiming } from "./timing.js";

interface Spec {
  items: number;
  plannedS?: number;
  chapter?: string;
  fn?: string;
  spoken?: string;
  cards?: string[];
}

const source = (id: string, { items, plannedS = 12, chapter = "ch1", fn = "WHAT", spoken = "word ".repeat(40), cards = [] }: Spec): PaceSourceBeat => ({
  id,
  chapter,
  fn,
  spoken,
  plannedS,
  mapBeside: false,
  cues: Array.from({ length: items }, (_, i) => ({ target: `job:${id} item ${i}` })),
  titles: [],
  reveals: [],
  pins: [],
  cards: cards.map((label) => ({ label })),
  terms: [],
});

const heard = (entries: Record<string, number>): ScriptTiming => new Map(Object.entries(entries).map(([id, durationS]) => [id, { durationS }]));

const rows = (specs: Record<string, Spec>, timing?: ScriptTiming) =>
  new Map(paceRows(buildPaceBeats(Object.entries(specs).map(([id, spec]) => source(id, spec)), timing)).map((r) => [r.check_id, r]));

const failing = (specs: Record<string, Spec>, check: string, timing?: ScriptTiming) => rows(specs, timing).get(check)?.detail_beats;

describe("Q-E7 (M1) new items a beat", () => {
  // Mutation: `>` to `>=` fails the four-item beat.
  it("passes 4 new items and fails 5, as an error", () => {
    const result = rows({ four: { items: 4 }, five: { items: 5 } }).get("Q-E7");

    expect(result).toMatchObject({ severity: "error", pass: false, value: 1, detail_beats: ["five"] });
  });
});

describe("Q-E8 (M2) seconds a new item", () => {
  // Mutation: reading plannedS when a heard duration exists passes both beats (each is planned at 20 s).
  it("fails 4 items heard in 7.9 s and passes 4 heard in 8.0 s, though both were planned at 20 s", () => {
    const specs = { short: { items: 4, plannedS: 20 }, enough: { items: 4, plannedS: 20 } };

    const result = rows(specs, heard({ short: 7.9, enough: 8.0 })).get("Q-E8");

    expect(result).toMatchObject({ severity: "warning", pass: false, detail_beats: ["short"] });
  });

  it("counts spoken words, 4 an item, when the beat was never heard", () => {
    const specs = { terse: { items: 4, spoken: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen" }, full: { items: 4, spoken: "word ".repeat(16) } };

    expect(failing(specs, "Q-E8")).toEqual(["terse"]);
  });

  it("exempts a PROMISE with 3 items plus a count, but not a PROMISE with 4 items", () => {
    const specs = {
      promise: { items: 3, fn: "PROMISE", cards: ["11 calls"] },
      crowded: { items: 4, fn: "PROMISE", cards: ["12 calls"] },
      plain: { items: 3, cards: ["13 calls"] },
    };

    const result = failing(specs, "Q-E8", heard({ promise: 5.9, crowded: 5.9, plain: 5.9 }));

    expect(result).toEqual(["crowded", "plain"]);
  });
});

describe("Q-E9 (M4) time to digest", () => {
  const twoDense = (gapS: number) => ({ first: { items: 5, plannedS: 10 }, filler: { items: 1, plannedS: gapS }, second: { items: 5, plannedS: 10 } });

  // Mutation: measuring from the first dense beat's start makes the gap 24.9 s and passes it.
  it("fails a dense beat 14.9 s after a dense beat's end, and passes one 15.0 s after", () => {
    expect(failing(twoDense(14.9), "Q-E9")).toEqual(["first", "second"]);
    expect(failing(twoDense(15), "Q-E9")).toEqual([]);
  });

  it("counts a beat dense when it fails Q-E8 alone", () => {
    const specs = { first: { items: 4 }, second: { items: 4 } };

    expect(failing(specs, "Q-E9", heard({ first: 6, second: 6 }))).toEqual(["first", "second"]);
  });
});

describe("Q-E10 (M7) new items a chapter minute", () => {
  it("passes 20 new items in a minute and fails 21, naming the chapter", () => {
    const minute = (chapter: string, last: number) =>
      Object.fromEntries([4, 4, 4, 4, last].map((items, i) => [`${chapter}-${i}`, { items, chapter }]));

    const result = rows({ ...minute("ch1", 4), ...minute("ch2", 5) }).get("Q-E10");

    expect(result).toMatchObject({ severity: "warning", pass: false, detail_beats: ["ch2"] });
  });
});

describe("the pace lints on the v4 spike script", () => {
  const beats = () => fromSpikeScript(v4Script(), readTiming(v4Durations())).beats;
  const flagged = () => new Map(paceRows(beats()).map((r) => [r.check_id, r.detail_beats]));

  it("reproduces the method review's M1, M2 and M4 sets for the beats the fixture holds", () => {
    const sets = flagged();

    expect(sets.get("Q-E7")).toEqual(["r2-1-jobs", "r2-2-inv", "r3-1-nouns"]);
    expect(sets.get("Q-E8")).toEqual(["r2-1-jobs", "r2-3-limits", "r3-1-nouns"]);
    expect(sets.get("Q-E9")).toEqual(["r2-1-jobs", "r2-2-inv", "r2-3-limits", "r3-1-nouns"]);
  });

  // ch3 holds only r3-1 and r3-3 in the fixture, so its rate is a subset artifact; ch2 is complete. The review
  // counted 19 new items in ch2 (29.1/min); the item track counts r2-4's chip as well, so 20 (30.7/min).
  it("flags ch2 by M7, plus ch3 from the fixture's partial chapter", () => {
    const ch2 = chapterPace(beats()).find((c) => c.chapter === "ch2");

    expect(flagged().get("Q-E10")).toEqual(["ch2", "ch3"]);
    expect(ch2?.newItems).toBe(20);
    expect(ch2?.perMinute).toBeCloseTo(30.66, 2);
  });
});

describe("paceCheck as an L0 check", () => {
  const script = () =>
    ScriptSchema.parse(
      scriptWith({
        visual: {
          assertion: "One server sits between every scanner and the ledger",
          job: "map",
          cues: ["every", "scan", "passes", "desk"].map((atCue) => ({ action: "V11", target: `row:${atCue}`, atCue })),
        },
      }),
    );

  it("is registered and reads the run's heard durations", () => {
    const ids = runL0(script()).map((r) => r.check_id);
    const rushed = runL0(script(), undefined, L0_CHECKS, heard({ "c2-1-stations": 7.9 })).find((r) => r.check_id === "Q-E8");

    expect(L0_CHECKS).toContain(paceCheck);
    expect(ids).toEqual(expect.arrayContaining(["Q-E7", "Q-E8", "Q-E9", "Q-E10"]));
    expect(rushed).toMatchObject({ pass: false, detail_beats: ["c2-1-stations"] });
    expect(l0HardPass(rushed ? [rushed] : [])).toBe(true);
  });

  const oneCue = (target: string) =>
    ScriptSchema.parse(
      scriptWith({ visual: { assertion: "One server sits between every scanner and the ledger", job: "map", cues: [{ action: "V11", target, atCue: "scan" }] } }),
    );

  const expectPaceFailedAndOthersReported = (results: ReturnType<typeof runL0>) => {
    const pace = results.filter((r) => ["Q-E7", "Q-E8", "Q-E9", "Q-E10"].includes(r.check_id));

    expect(results.map((r) => r.check_id)).toEqual(expect.arrayContaining(["Q-E1", "Q-F1"]));
    expect(pace).toHaveLength(4);
    expect(pace.every((r) => !r.pass && r.detail_beats.join() === "c2-1-stations")).toBe(true);
    expect(l0HardPass(results.filter((r) => r.check_id === "Q-E7"))).toBe(false);
  };

  // Regression: a plain target such as "scanner" made the item track throw, and the default run lost every check.
  it("fails the pace rows on a cue target with no known kind, and the other L0 checks still report", () => {
    expectPaceFailedAndOthersReported(runL0(oneCue("scanner")));
  });

  // Regression: a cue word missing from the heard words (a lexicon rewrite, an older take) threw the same way.
  it("fails the pace rows on a cue the words.json never heard, and the other L0 checks still report", () => {
    const timing = readTiming({ beats: [{ id: "c2-1-stations", durationS: 9, words: [{ word: "every", start: 0 }, { word: "desk", start: 1.2 }] }] });

    expectPaceFailedAndOthersReported(runL0(oneCue("row:scanner"), undefined, L0_CHECKS, timing));
  });
});
