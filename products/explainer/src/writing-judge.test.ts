import { describe, expect, it } from "vitest";
import type { JudgeHarness } from "./eval-harness.js";
import { runWritingJudge, type JudgedPolicy } from "./writing-judge.js";
import { beatsOf, CANARY_LINE, CONFIG, fakeHarness, FILLER, judgedRow as row, mark, RUBRICS, term, termName, termQuotes } from "./writing-judge-fixtures.test-helpers.js";

// The test's own policy, so a recalibration of doctrine/writing-gate.json cannot move these tests.
const POLICY: JudgedPolicy = {
  minWords: 150,
  judged: {
    "hallmark-marks": { severity: "error", warnAbove: 20, errorAbove: 28 },
    "words-per-term": { severity: "warning", floor: 60, allowTerms: 1 },
    "terms-first-400": { severity: "report-only", window: 400 },
  },
};
const judge = (beats: { id: string; spoken: string }[], harness: () => JudgeHarness, policy: JudgedPolicy = POLICY) =>
  runWritingJudge({ beats, config: CONFIG, harnessFor: harness, policy, rubrics: RUBRICS });

describe("writing judge marks", () => {
  it("drop and count a mark whose quote is not in the piece", async () => {
    const result = await judge(beatsOf(20), fakeHarness([mark(CANARY_LINE), mark(FILLER), mark("The kettle sings a song of steam.")]));

    expect(result.dropped.marks).toBe(1);
    expect(row(result, "writing:hallmark-marks").value).toBeCloseTo(1000 / 200);
  });

  it("count one passage once however many items mark it, and leave the canary out of the rate", async () => {
    const result = await judge(beatsOf(20), fakeHarness([mark(CANARY_LINE), mark(FILLER), mark(FILLER, "staccato_drama")]));

    expect(result.canary_marks).toBe(1);
    expect(row(result, "writing:hallmark-marks").value).toBeCloseTo(1000 / 200);
  });

  it("fail as an error past 28 passages per 1,000 words and warn past 20, naming the beats", async () => {
    const error = await judge(beatsOf(20, 6), fakeHarness([mark(CANARY_LINE), ...termQuotes(6)]));
    const warning = await judge(beatsOf(20, 5), fakeHarness([mark(CANARY_LINE), ...termQuotes(5)]));
    const clean = await judge(beatsOf(20, 4), fakeHarness([mark(CANARY_LINE), ...termQuotes(4)]));

    expect(row(error, "writing:hallmark-marks")).toMatchObject({ value: 30, severity: "error", pass: false, beats: ["b1"] });
    expect(row(warning, "writing:hallmark-marks")).toMatchObject({ value: 25, severity: "warning", pass: false });
    expect(row(clean, "writing:hallmark-marks")).toMatchObject({ value: 20, pass: true });
  });
});

describe("writing judge trust", () => {
  it("is untrusted when the canary is unmarked, which leaves both judged rows unmeasured and failing", async () => {
    const result = await judge(beatsOf(20), fakeHarness([mark(FILLER)]));

    expect(result.trusted).toBe(false);
    expect(row(result, "writing:hallmark-marks")).toMatchObject({ value: null, pass: false });
    expect(row(result, "writing:words-per-term")).toMatchObject({ value: null, pass: false });
  });

  it("maps a failed call to unmeasured rows that fail, never to a pass", async () => {
    const result = await judge(beatsOf(20), fakeHarness("fail"));

    expect(result.failures).toEqual(["auth_misconfigured: not logged in"]);
    expect(row(result, "writing:hallmark-marks")).toMatchObject({ value: null, severity: "error", pass: false });
    expect(row(result, "writing:words-per-term")).toMatchObject({ value: null, severity: "warning", pass: false });
  });
});

describe("writing:words-per-term", () => {
  const canary = [mark(CANARY_LINE)];

  it("passes 1,200 words with 10 terms the piece says, however many terms it does not say", async () => {
    const extracted = [...Array.from({ length: 10 }, (_, i) => term(termName(i))), ...Array.from({ length: 15 }, (_, i) => term(`absent${termName(i)}`))];
    const result = await judge(beatsOf(120, 10), fakeHarness(canary, extracted));

    expect(result.dropped.terms).toBe(15);
    expect(row(result, "writing:words-per-term")).toMatchObject({ value: 120, pass: true });
  });

  it("fails 1,200 words with 25 terms, 48 words per term", async () => {
    const result = await judge(beatsOf(120, 25), fakeHarness(canary, Array.from({ length: 25 }, (_, i) => term(termName(i)))));

    expect(row(result, "writing:words-per-term")).toMatchObject({ value: 48, pass: false, severity: "warning" });
  });

  it("always allows one term, even in a text shorter than the floor", async () => {
    const result = await judge(beatsOf(5, 1), fakeHarness(canary, [term(termName(0))]), { ...POLICY, minWords: 10 });

    expect(row(result, "writing:words-per-term")).toMatchObject({ value: 50, pass: true });
  });

  it("reports the terms in the first 400 words without failing", async () => {
    const late = beatsOf(120, 1).map((beat, i) => (i === 5 ? { ...beat, spoken: `The ${termName(1)} hums. ${beat.spoken}` } : beat));
    const result = await judge(late, fakeHarness(canary, [term(termName(0)), term(termName(1))]));

    expect(row(result, "writing:terms-first-400")).toMatchObject({ value: 1, severity: "report-only", pass: true });
  });
});
