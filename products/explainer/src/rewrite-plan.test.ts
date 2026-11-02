import { describe, expect, it } from "vitest";
import { usePreCalibrationStatuses } from "./writing-statuses-fixtures.test-helpers.js";
import { runL0 } from "./eval-l0.js";
import { REGISTER_BANDS, registerCheck, spokenText } from "./lint-register.js";
import { MAX_VETTED_SENTENCE_WORDS } from "./lint-voice.js";
import { MAX_REWRITE_ROUNDS, planRegisterEdits, type BeatDirective } from "./rewrite-plan.js";
import type { ScriptV1 } from "./script-schema.js";
import { tour, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

// These tests pin the mechanics on fixtures; the shipped status table is data a recalibration changes (TP-4662).
usePreCalibrationStatuses();

// Short, number-free, list-free sentences about an invented parcel desk: the raw stuff of a choppy script.
const CHOPPY = [
  "The desk reads each scan first.",
  "It asks the ledger for a row.",
  "The row says where the parcel is.",
  "A missing row stops the label.",
  "The courier sees that refusal at once.",
  "Nothing prints before the ledger answers.",
];

// The tour's thesis_refs name h1, w4 and c1, so the first three beats carry those ids.
const ids = (n: number): string[] => ["h1", "w4", "c1", ...Array.from({ length: n - 3 }, (_, i) => `b${i}`)];
const script = (lines: readonly string[]): ScriptV1 =>
  tour(lines.map((spoken, i): BeatSpec => [ids(lines.length)[i]!, `ch${1 + (i % 4)}`, "WHAT", spoken]));

const choppyLines = (beats: number): string[] =>
  Array.from({ length: beats }, (_, i) => Array.from({ length: 2 + (i % 4) }, (_, j) => CHOPPY[(i + j) % CHOPPY.length]).join(" "));

const plan = (s: ScriptV1, round: 1 | 2 = 1) => planRegisterEdits(s, runL0(s, undefined, [registerCheck]), { round });
const failing = (s: ScriptV1): string[] => runL0(s, undefined, [registerCheck]).filter((r) => !r.pass).map((r) => r.check_id);
const lengths = (spoken: string): number[] => spokenText([spoken]).sentences.map((sentence) => spokenText([sentence]).words.length);
const directiveFor = (directives: readonly BeatDirective[], beat: string) => directives.find((d) => d.beat === beat);

function shapeAfter(s: ScriptV1, directives: readonly BeatDirective[]): { mean: number; cv: number } {
  const all = s.beats.flatMap((beat) => directiveFor(directives, beat.id)?.shape ?? lengths(beat.spoken));
  const mean = all.reduce((sum, n) => sum + n, 0) / all.length;
  const sd = Math.sqrt(all.reduce((sum, n) => sum + (n - mean) ** 2, 0) / all.length);
  return { mean, cv: sd / mean };
}

describe("planRegisterEdits: sentence shape", () => {
  const choppy = script(choppyLines(24));

  it("tells a short choppy beat to speak fewer sentences", () => {
    const { directives } = plan(choppy);
    const fourSentences = choppy.beats.find((beat) => lengths(beat.spoken).length === 5)!;

    expect(failing(choppy)).toEqual(expect.arrayContaining(["register:sentence-mean"]));
    expect(directiveFor(directives, fourSentences.id)?.shape?.length).toBeLessThan(5);
  });

  it("plans a shape that lands the script inside both sentence bands, under the vetted cap", () => {
    // Beats wordy enough for three sentences or more: a two-sentence beat under the 24-word plan cannot reach the CV floor.
    const spread = script(Array.from({ length: 24 }, (_, i) => Array.from({ length: 6 + (i % 7) }, (_, j) => CHOPPY[(i + j) % CHOPPY.length]).join(" ")));

    const { directives, projected } = plan(spread);
    const after = shapeAfter(spread, directives);

    expect(after.mean).toBeGreaterThanOrEqual(REGISTER_BANDS["sentence-mean"].min!);
    expect(after.cv).toBeGreaterThanOrEqual(REGISTER_BANDS["sentence-cv"].min!);
    expect(after.cv).toBeLessThanOrEqual(REGISTER_BANDS["sentence-cv"].max);
    expect(Math.max(...directives.flatMap((d) => d.shape ?? []))).toBeLessThanOrEqual(MAX_VETTED_SENTENCE_WORDS);
    expect(projected).toEqual(after);
  });

  it("plans no shape for a script already inside both sentence bands", () => {
    const long = "Then the desk asks the ledger for the parcel row and waits until the answer comes back before it prints anything.";
    const inBand = script(Array.from({ length: 12 }, () => `The desk reads it first. ${long}`));

    expect(failing(inBand)).not.toEqual(expect.arrayContaining(["register:sentence-mean"]));
    expect(failing(inBand)).not.toEqual(expect.arrayContaining(["register:sentence-cv"]));
    expect(plan(inBand)).toEqual({ round: 1, directives: [] });
  });
});

describe("planRegisterEdits: numbers and triads", () => {
  const CROWDED = "The desk held 12 parcels, sent 3 back and lost two.";
  const LIST = "It checks the scan, the row and the label.";
  // Crowded beats beyond the capped share, so the numbers-per-beat row fails and the planner acts.
  const MORE_CROWDED = Array.from({ length: 5 }, () => CROWDED);

  it("lists every number a crowded beat speaks, and the list of three it holds", () => {
    const s = script([CROWDED, LIST, ...MORE_CROWDED, ...choppyLines(15)]);
    const crowded = directiveFor(plan(s).directives, "h1");

    expect(crowded?.numbers).toEqual(["12", "3", "two"]);
    expect(crowded?.triads).toEqual(["held 12 parcels, sent 3 back and lost two."]);
    expect(directiveFor(plan(s).directives, "w4")?.triads).toEqual(["checks the scan, the row and the label."]);
  });

  it("directs no collapse of a list whose items the screen cues on, and still directs one with a single cued item", () => {
    const cuedOn = (...atCues: string[]) => ({ visual: { assertion: "The desk checks three things", job: "numbers", cues: atCues.map((atCue) => ({ action: "V11", target: `card:${atCue}`, atCue })) } });
    const s = tour([
      ["h1", "ch1", "WHAT", LIST, cuedOn("scan", "row", "label")],
      ["w4", "ch2", "WHAT", LIST, cuedOn("row")],
      ["c1", "ch3", "WHAT", LIST],
      ...script([...MORE_CROWDED, ...choppyLines(15)]).beats.map((beat, i): BeatSpec => [`m${i}`, beat.chapter, "WHAT", beat.spoken]),
    ]);

    const { directives } = plan(s);

    expect(failing(s)).toContain("register:triads");
    expect(directiveFor(directives, "h1")?.triads).toBeUndefined();
    expect(directiveFor(directives, "w4")?.triads).toEqual(["checks the scan, the row and the label."]);
    expect(directiveFor(directives, "c1")?.triads).toEqual(["checks the scan, the row and the label."]);
  });

  it("names a number range as one mention, so the directive never offers to cut one end", () => {
    const RANGE = "Merge-ups move thirty to thirty-five percent of heads on 2 queues.";
    const s = script([RANGE, ...MORE_CROWDED, ...choppyLines(15)]);

    expect(directiveFor(plan(s).directives, "h1")?.numbers).toEqual(["thirty to thirty-five percent", "2"]);
  });

  it("offers only the uncued number of a beat that cues on one of its numbers", () => {
    const cued = { visual: { assertion: "The desk held parcels", job: "numbers", cues: [{ action: "V11", target: "card:12", atCue: "12" }] } };
    const s = tour([
      ["h1", "ch1", "WHAT", CROWDED, cued],
      ["w4", "ch2", "WHAT", CROWDED],
      ["c1", "ch3", "WHAT", CROWDED],
      ...script([...MORE_CROWDED, ...choppyLines(15)]).beats.map((beat, i): BeatSpec => [`m${i}`, beat.chapter, "WHAT", beat.spoken]),
    ]);

    const { directives } = plan(s);

    expect(directiveFor(directives, "h1")?.numbers).toEqual(["3", "two"]);
    expect(directiveFor(directives, "w4")?.numbers).toEqual(["12", "3", "two"]);
  });

  it("leaves a beat that speaks one number alone", () => {
    const s = script(["The desk held 12 parcels overnight.", CROWDED, ...MORE_CROWDED, ...choppyLines(14)]);

    expect(directiveFor(plan(s).directives, "h1")?.numbers).toBeUndefined();
  });
});

describe("planRegisterEdits: over-represented phrases", () => {
  const CROWDED = "The desk held 12 parcels, sent 3 back and lost two.";
  const STOCK = "The desk stays calm. That matters.";

  it("names the phrases a directed beat speaks while the phrases row fails", () => {
    const s = script([`${CROWDED} ${STOCK}`, ...Array.from({ length: 5 }, () => CROWDED), ...choppyLines(15)]);

    expect(failing(s)).toContain("register:phrases");
    expect(directiveFor(plan(s).directives, "h1")?.phrases).toEqual(["stays", "matters"]);
  });

  it("directs each beat that speaks a stock phrase when the phrases row is the only one failing", () => {
    const s = script([STOCK, ...choppyLines(20)]);
    const phrasesOnly = runL0(s, undefined, [registerCheck]).filter((row) => row.check_id === "register:phrases");

    const { directives } = planRegisterEdits(s, phrasesOnly);

    expect(phrasesOnly).toMatchObject([{ pass: false }]);
    expect(directives).toEqual([{ beat: "h1", chapter: "ch1", phrases: ["stays", "matters"] }]);
  });

  it("directs no stock phrase in a script under 150 words, where the status table judges no row", () => {
    const s = script([STOCK, ...choppyLines(3)]);
    const failingPhrases = [{ ...runL0(s, undefined, [registerCheck]).find((row) => row.check_id === "register:phrases")!, pass: false }];

    const { directives } = planRegisterEdits(s, failingPhrases);

    expect(spokenText(s.beats.map((beat) => beat.spoken)).words.length).toBeLessThan(150);
    expect(directives).toEqual([]);
  });

  it("names no phrase once the phrases row passes", () => {
    const s = script([`${CROWDED} ${STOCK}`, ...Array.from({ length: 5 }, () => CROWDED), ...choppyLines(15)]);
    const passing = runL0(s, undefined, [registerCheck]).map((row) => (row.check_id === "register:phrases" ? { ...row, pass: true } : row));

    const directive = directiveFor(planRegisterEdits(s, passing).directives, "h1");

    expect(directive?.numbers).toBeDefined();
    expect(directive?.phrases).toBeUndefined();
  });
});

describe("planRegisterEdits: round 2", () => {
  const LIST = "It checks the scan, the row and the label.";

  it("directs the beats that still hold a triad or crowded numbers", () => {
    const moved = "The desk held 12 parcels and 3 of them moved.";
    const roundOneText = script([LIST, moved, moved, moved, moved, ...choppyLines(10)]);
    const { directives } = plan(roundOneText, 2);

    expect(directiveFor(directives, "h1")?.triads).toEqual(["checks the scan, the row and the label."]);
    expect(directiveFor(directives, "w4")?.numbers).toEqual(["12", "3"]);
  });

  describe("shape for beats still under the mean floor", () => {
    const long = "Then the desk asks the ledger for the parcel row and waits until the answer comes back before it prints anything.";
    const longBeat = `The desk reads it first. ${long}`;
    // One 24-word sentence is over the floor on its own, but a script-wide plan would still split it.
    const steady = "The desk asks the ledger for the parcel row and waits patiently until the answer comes back before it prints a label.";
    const mixed = script([...Array.from({ length: 6 }, () => steady), ...choppyLines(18)]);

    it("gives a choppy beat a shape line and a beat already long enough none", () => {
      const { directives, projected } = plan(mixed, 2);

      expect(failing(mixed)).toEqual(expect.arrayContaining(["register:sentence-mean"]));
      expect(directiveFor(directives, "b17")?.shape).toBeDefined();
      expect(["h1", "w4", "c1", "b0", "b1", "b2"].map((id) => directiveFor(directives, id))).toEqual(Array(6).fill(undefined));
      expect(projected).toBeDefined();
    });

    it("plans fewer sentences than the beat speaks now", () => {
      const { directives } = plan(mixed, 2);
      const beat = mixed.beats.find((b) => b.id === "b17")!;

      expect(directiveFor(directives, "b17")!.shape!.length).toBeLessThan(lengths(beat.spoken).length);
    });

    it("plans no shape once the shape rows pass", () => {
      const inBand = script(Array.from({ length: 12 }, () => longBeat));

      expect(plan(inBand, 2)).toEqual({ round: 2, directives: [] });
    });

    it("carries a previous round's refusal only on a beat it directs, each rule once", () => {
      const refused = new Map([
        ["b17", ["sentence-cap", "number-lost", "sentence-cap"] as const],
        ["h1", ["list-emptied"] as const],
      ]);

      const { directives } = planRegisterEdits(mixed, runL0(mixed, undefined, [registerCheck]), { round: 2, refused });

      expect(directiveFor(directives, "b17")?.refused).toEqual(["sentence-cap", "number-lost"]);
      expect(directiveFor(directives, "h1")).toBeUndefined();
      expect(directives.filter((d) => d.refused).map((d) => d.beat)).toEqual(["b17"]);
    });
  });

  it("refuses a round past the last", () => {
    const s = script(choppyLines(20));

    expect(() => planRegisterEdits(s, [], { round: MAX_REWRITE_ROUNDS + 1 })).toThrow(RangeError);
  });
});
