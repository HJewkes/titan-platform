import { describe, expect, it } from "vitest";
import type { Hallucination, PhoneSource, TailArtifact, WordVerdict } from "./phone-verdicts.js";
import type { HeardReading, HeardStatus } from "./reading-phones.js";
import type { WordDistance } from "./retake.js";
import {
  betterTake,
  classifyFaults,
  isFutile,
  outcome,
  type Classification,
  type Decision,
  type DefectFinding,
  type Fault,
  type FaultKind,
  type HeardTake,
  type RankedTake,
  type TakeFindings,
} from "./vet-decide.js";

// Constructed findings over the synthetic line "we need to get him here"; no value comes from a model.
const babble = (severity: number): Hallucination => ({ phones: "ʌbʌbʌ", length: 5, position: 0.5, severity });
const stray = (length: number): TailArtifact => ({ phones: "tʃə".slice(0, length), length, displaced: "", severity: 0.5 });
const verdict = (word: string, source: PhoneSource, distance = 0.5): WordVerdict => ({
  word,
  expectedPhones: "nid",
  actualPhones: "nʌd",
  distance,
  source,
});
const heard = (status: HeardStatus): HeardReading => ({
  word: "live",
  occurrence: 1,
  declared: "verb",
  heard: "adj",
  heardPhones: "laɪv",
  distance: 0.2,
  status,
});
const defect = (kind: DefectFinding["kind"], verdicts?: WordVerdict[]): DefectFinding => ({
  kind,
  expected: "need",
  heard: "knead",
  severity: 0.6,
  ...(verdicts && { verdicts }),
});
const findings = (over: Partial<TakeFindings>): TakeFindings => ({ hallucinations: [], tail: null, defects: [], heard: [], ...over });
const kinds = (c: Classification): FaultKind[] => c.faults.map((f) => f.kind);

describe("classifyFaults: the decision table, one row each", () => {
  // Stochastic faults are re-rolled; word and reading faults are the voice's pronunciation.
  // Mutation caught: classifying a whisper-adjudicated substitution as a word fault fails the whisper row.
  const rows: [row: string, over: Partial<TakeFindings>, faults: FaultKind[], dismissed: PhoneSource[]][] = [
    ["hallucination is a stochastic fault", { hallucinations: [babble(0.6)] }, ["hallucination"], []],
    ["a tail artifact is a stochastic fault", { tail: stray(2) }, ["tail"], []],
    ["an omission defect is a stochastic fault", { defects: [defect("omission")] }, ["omission"], []],
    ["a low_confidence defect is a stochastic fault", { defects: [defect("low_confidence")] }, ["low-confidence"], []],
    ["a substitution the phones garble (xtts) is a word fault", { defects: [defect("substitution", [verdict("need", "xtts")])] }, ["word"], []],
    ["an unadjudicated substitution (no recognizer) is a word fault", { defects: [defect("substitution")] }, ["word"], []],
    ["a declared reading heard fail is a reading fault", { heard: [heard("fail")] }, ["reading"], []],
    ["a substitution the phones clear (whisper) is dismissed", { defects: [defect("substitution", [verdict("need", "whisper", 0.1)])] }, [], ["whisper"]],
    ["an inconclusive substitution is dismissed", { defects: [defect("substitution", [verdict("need", "inconclusive")])] }, [], ["inconclusive"]],
    ["a heard reading ok or inconclusive is no fault", { heard: [heard("ok"), heard("inconclusive")] }, [], []],
  ];

  it.each(rows)("%s", (_row, over, faults, dismissed) => {
    const c = classifyFaults(findings(over));
    expect(kinds(c)).toEqual(faults);
    expect(c.dismissed.map((v) => v.source)).toEqual(dismissed);
  });

  it("names the garbled word and scores it at its phone distance", () => {
    const c = classifyFaults(findings({ defects: [defect("substitution", [verdict("need", "xtts", 0.71)])] }));
    expect(c.faults).toEqual([expect.objectContaining({ kind: "word", word: "need", severity: 0.71 })]);
  });

  it("judges each word of a multi-word substitution on its own verdict", () => {
    const c = classifyFaults(findings({ defects: [defect("substitution", [verdict("need", "xtts"), verdict("to", "whisper")])] }));
    expect(c.faults.map((f) => f.word)).toEqual(["need"]);
    expect(c.dismissed.map((v) => v.word)).toEqual(["to"]);
  });
});

const ranked = (over: Partial<RankedTake>): RankedTake => ({ hallucinations: [], tail: null, distances: new Map(), faults: [], ...over });
const wordFault = (word: string, severity: number): Fault => ({ kind: "word", word, severity, detail: "" });
const distances = (entries: Record<string, WordDistance>) => new Map(Object.entries(entries));

describe("betterTake", () => {
  it("a take with lower hallucination severity wins whatever its tail", () => {
    const best = ranked({ hallucinations: [babble(0.8)] });
    const take = ranked({ hallucinations: [babble(0.5)], tail: stray(3) });
    expect(betterTake(best, take)).toBe(true);
    expect(betterTake(take, best)).toBe(false);
  });

  it("no hallucination beats any hallucination", () => {
    expect(betterTake(ranked({ hallucinations: [babble(0.5)] }), ranked({ tail: stray(3) }))).toBe(true);
  });

  it("at equal hallucination, a take that breaks a word never wins, however clean its tail", () => {
    const best = ranked({ tail: stray(3), distances: distances({ need: { distance: 0.1, faulty: false } }) });
    const take = ranked({ distances: distances({ need: { distance: 0.7, faulty: true } }), faults: [wordFault("need", 0.7)] });
    expect(betterTake(best, take)).toBe(false);
  });

  it("at equal hallucination and no broken word, a shorter tail wins", () => {
    expect(betterTake(ranked({ tail: stray(3) }), ranked({ tail: stray(1) }))).toBe(true);
  });

  it("at equal tail, the word distance must fall by more than the margin", () => {
    const best = ranked({ distances: distances({ need: { distance: 0.8, faulty: true } }), faults: [wordFault("need", 0.8)] });
    const lower = (d: number) =>
      ranked({ distances: distances({ need: { distance: d, faulty: true } }), faults: [wordFault("need", d)] });
    expect(betterTake(best, lower(0.7), 0.06)).toBe(true);
    expect(betterTake(best, lower(0.75), 0.06)).toBe(false);
  });

  // Mutation caught: ranking on severity alone with `<=` picks the later of two tied takes.
  it("a tie keeps the best, as keepTake does", () => {
    const tied = () => ranked({ hallucinations: [babble(0.6)] });
    expect(betterTake(tied(), tied(), 0.06)).toBe(false);
  });
});

describe("outcome", () => {
  const fault = (kind: FaultKind, word = "need", severity = 0.5): Fault => ({ kind, word, severity, detail: "" });
  const cases: [name: string, faults: Fault[], misaki: boolean, status: Decision["status"]][] = [
    ["no fault is accepted", [], true, "accepted"],
    ["a word fault needs an override", [fault("word")], false, "needs-override"],
    ["a reading fault on a misaki voice needs an override", [fault("reading", "live")], true, "needs-override"],
    ["a reading fault on a text voice needs a rewrite", [fault("reading", "live")], false, "needs-rewrite"],
    ["a word fault outranks a reading fault", [fault("reading", "live"), fault("word")], false, "needs-override"],
  ];

  it.each(cases)("%s", (_name, faults, misaki, status) => {
    expect(outcome({ faults }, misaki).status).toBe(status);
  });

  // D-T11-4, pending the owner: remove this test with the variant if the answer is no.
  it("stochastic faults alone give retakes-exhausted, carrying the faults", () => {
    const faults = [fault("hallucination"), fault("tail"), fault("omission"), fault("low-confidence")];
    expect(outcome({ faults }, true)).toEqual({ status: "retakes-exhausted", faults });
  });

  it("names the most severe word, with that word's faults as evidence", () => {
    const faults = [fault("word", "need", 0.6), fault("word", "here", 0.9), fault("tail")];
    expect(outcome({ faults }, true)).toEqual({ status: "needs-override", word: "here", evidence: [faults[1]] });
  });

  it("a rewrite names the reading's word as its span", () => {
    expect(outcome({ faults: [fault("reading", "live")] }, false)).toEqual({ status: "needs-rewrite", span: "live", reason: "reading" });
  });
});

describe("isFutile", () => {
  const take = (phones: string | undefined, text: string): HeardTake => ({ ...(phones !== undefined && { phones }), text });
  const cases: [name: string, prev: HeardTake, next: HeardTake, futile: boolean][] = [
    ["equal phones and equal text are futile", take("wi nid", "we need"), take("wi nid", "we need"), true],
    ["equal phones but different text are not", take("wi nid", "we need"), take("wi nid", "we knead"), false],
    ["equal text but different phones are not", take("wi nid", "we need"), take("wi nʌd", "we need"), false],
    ["no recognizer and equal text are futile", take(undefined, "we need"), take(undefined, "we need"), true],
  ];

  it.each(cases)("%s", (_name, prev, next, futile) => {
    expect(isFutile(prev, next)).toBe(futile);
  });
});
