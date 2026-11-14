import { describe, expect, it } from "vitest";
import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import { runWritingJudge, type JudgedPolicy, type WritingJudgeConfig, type WritingRubrics } from "./writing-judge.js";

const CONFIG: WritingJudgeConfig = { provider: "claude-print", model: "judge-model", extractor_model: "extractor-model", max_budget_usd: 0.5, wall_time_s: 60 };
const RUBRICS: WritingRubrics = {
  judge: "JUDGE\n{{checklist}}\n{{piece}}",
  checklist: JSON.stringify([{ id: "naming_refrain", question: "Q1" }, { id: "staccato_drama", question: "Q2" }]),
  extract: "EXTRACT\n{{piece}}",
};
const POLICY: JudgedPolicy = {
  minWords: 150,
  judged: {
    "hallmark-marks": { severity: "error", warnAbove: 13.3, errorAbove: 20 },
    "words-per-term": { severity: "error", floor: 60, allowTerms: 1 },
    "terms-first-400": { severity: "report-only", window: 400 },
  },
};
const CANARY_LINE = "That is called the cassette.";
const FILLER = "The pump sends warm water through the copper pipe today.";

type Mark = { id: string; quote: string; why: string };
type Term = { term: string; first_mention: string; definition: string | null; motivation: string | null; used_after: boolean };

const reply = <T,>(call: JudgeCall<T>, output: unknown): JudgeReply<T> => ({ ok: true, output: call.schema.parse(output), usd: 0.1, tokensIn: 10, tokensOut: 5 });

/** Answers the judge call with `marks` and the extractor call with `terms`; either may be a failed call. */
function fakeHarness(marks: Mark[] | "fail", terms: Term[] | "fail" = []): () => JudgeHarness {
  const answer = <T,>(call: JudgeCall<T>): JudgeReply<T> => {
    const output = call.prompt.startsWith("JUDGE") ? marks : terms;
    if (output === "fail") return { ok: false, reason: "auth_misconfigured: not logged in", usd: 0, tokensIn: 0, tokensOut: 0 };
    return reply(call, call.prompt.startsWith("JUDGE") ? { marks: output } : { terms: output });
  };
  return () => async <T,>(call: JudgeCall<T>) => answer(call);
}

const mark = (quote: string, id = "naming_refrain"): Mark => ({ id, quote, why: "nothing lost" });
const term = (name: string): Term => ({ term: name, first_mention: `The ${name} moves.`, definition: null, motivation: null, used_after: true });
const termName = (i: number): string => `valve${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;

/** `sentences` ten-word sentences, ten per beat; the first `termCount` each name one invented term. */
function beatsOf(sentences: number, termCount = 0): { id: string; spoken: string }[] {
  const lines = Array.from({ length: sentences }, (_, i) => (i < termCount ? `The ${termName(i)} sends warm water through the copper pipe today.` : FILLER));
  return Array.from({ length: Math.ceil(sentences / 10) }, (_, b) => ({ id: `b${b + 1}`, spoken: lines.slice(b * 10, b * 10 + 10).join(" ") }));
}

const judge = (beats: { id: string; spoken: string }[], harness: () => JudgeHarness, policy: JudgedPolicy = POLICY) =>
  runWritingJudge({ beats, config: CONFIG, harnessFor: harness, policy, rubrics: RUBRICS });
const row = (result: Awaited<ReturnType<typeof judge>>, id: string) => result.rows.find((r) => r.id === id)!;

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

  it("fail as an error past 20 passages per 1,000 words and warn past 13.3, naming the beats", async () => {
    const quotes = (n: number) => Array.from({ length: n }, (_, i) => mark(`The ${termName(i)} sends warm water`));
    const error = await judge(beatsOf(20, 5), fakeHarness([mark(CANARY_LINE), ...quotes(5)]));
    const warning = await judge(beatsOf(20, 3), fakeHarness([mark(CANARY_LINE), ...quotes(3)]));

    expect(row(error, "writing:hallmark-marks")).toMatchObject({ value: 25, severity: "error", pass: false, beats: ["b1"] });
    expect(row(warning, "writing:hallmark-marks")).toMatchObject({ value: 15, severity: "warning", pass: false });
  });
});

describe("writing judge trust", () => {
  it("is untrusted when the canary is unmarked, which leaves both gated rows unmeasured and failing", async () => {
    const result = await judge(beatsOf(20), fakeHarness([mark(FILLER)]));

    expect(result.trusted).toBe(false);
    expect(row(result, "writing:hallmark-marks")).toMatchObject({ value: null, pass: false });
    expect(row(result, "writing:words-per-term")).toMatchObject({ value: null, pass: false });
  });

  it("maps a failed call to unmeasured rows that fail, never to a pass", async () => {
    const result = await judge(beatsOf(20), fakeHarness("fail"));

    expect(result.failures).toEqual(["auth_misconfigured: not logged in"]);
    expect(row(result, "writing:hallmark-marks")).toMatchObject({ value: null, severity: "error", pass: false });
    expect(row(result, "writing:words-per-term")).toMatchObject({ value: null, severity: "error", pass: false });
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

    expect(row(result, "writing:words-per-term")).toMatchObject({ value: 48, pass: false, severity: "error" });
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
