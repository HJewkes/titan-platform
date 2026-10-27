import { describe, expect, it } from "vitest";
import { toVtt } from "../render/captions.js";
import { captionReport } from "./caption-check.js";

/** Two beats of synthetic narration, three words a second, the second beat 4 s in. */
const SAID = [
  ["The", "parcel", "desk", "reads", "the", "row", "first."],
  ["Then", "the", "sorter", "moves", "it", "along."],
];
const WORDS = {
  beats: SAID.map((said, b) => ({ id: `b${b + 1}`, startS: b * 4, durationS: 4, words: said.map((word, i) => ({ word, start: 0.5 + i / 3, end: 0.8 + i / 3 })) })),
};

const vtt = (...cues: Array<[string, string, string]>): string =>
  `WEBVTT\n\n${cues.map(([start, end, text], i) => `${i + 1}\n${start} --> ${end}\n${text}\n`).join("\n")}`;

/** Both sentences as one cue each, timed to their first words. */
const SENTENCE_ONE: [string, string, string] = ["00:00:00.500", "00:00:03.000", "The parcel desk reads the row first."];
const SENTENCE_TWO: [string, string, string] = ["00:00:04.500", "00:00:07.000", "Then the sorter moves it along."];

const rules = (track: string | undefined) => captionReport(track, WORDS).findings.map((finding) => finding.rule);

describe("caption check", () => {
  it("passes the track the renderer writes from the same words", () => {
    const timed = WORDS.beats.flatMap((beat) => beat.words.map((w) => ({ text: w.word, startS: beat.startS + w.start, endS: beat.startS + w.end })));

    const report = captionReport(toVtt(timed), WORDS);

    expect(report).toEqual({ cues: 2, words: 13, findings: [] });
  });

  it("fails complete when the render made no VTT", () => {
    const report = captionReport(undefined, WORDS);

    expect(report.findings).toEqual([{ rule: "complete", cue: null, message: "no captions.vtt artifact" }]);
  });

  it("fails complete on a header-only VTT for narrated words", () => {
    const found = rules("WEBVTT\n");

    expect(found).toContain("complete");
  });

  it("fails complete on a file without the WEBVTT header", () => {
    const report = captionReport(vtt(SENTENCE_ONE, SENTENCE_TWO).replace("WEBVTT", "VTT"), WORDS);

    expect(report.findings).toEqual([{ rule: "complete", cue: null, message: "captions.vtt does not start with WEBVTT" }]);
  });

  it("fails complete on a cue whose timing line does not parse", () => {
    const report = captionReport(vtt(SENTENCE_ONE, ["00:04.5", "00:00:07.000", SENTENCE_TWO[2]]), WORDS);

    expect(report.findings[0]).toEqual({ rule: "complete", cue: 2, message: "cue 2 has no valid timing line" });
  });

  it("passes words when only case, punctuation and markup differ from words.json", () => {
    const found = rules(vtt(["00:00:00.500", "00:00:03.000", "<v Narrator>the PARCEL desk, reads the row first"], SENTENCE_TWO));

    expect(found).toEqual([]);
  });

  it("fails words on a dropped word, naming where the tracks part", () => {
    const report = captionReport(vtt(SENTENCE_ONE, ["00:00:04.500", "00:00:07.000", "Then the moves it along."]), WORDS);

    expect(report.findings).toEqual([{ rule: "words", cue: null, message: 'word 10: captions "moves", words.json "sorter" (12 vs 13 words)' }]);
  });

  it("fails words when the captions stop before the narration does", () => {
    const found = rules(vtt(SENTENCE_ONE));

    expect(found).toEqual(["words"]);
  });

  it("fails lines on a 43-character line and passes a 42-character one", () => {
    const at42 = "The parcel desk reads the row first. Then.";
    const span: [string, string] = ["00:00:00.500", "00:00:04.000"];

    const long = captionReport(vtt([...span, `${at42}x`]), { beats: [] }).findings.filter((finding) => finding.rule === "lines");
    const fits = captionReport(vtt([...span, at42]), { beats: [] }).findings.filter((finding) => finding.rule === "lines");

    expect(long).toEqual([{ rule: "lines", cue: 1, message: "cue 1: a 43-character line (at most 42)" }]);
    expect(fits).toEqual([]);
  });

  it("fails lines on a cue of three lines", () => {
    const report = captionReport(vtt(["00:00:00.500", "00:00:03.000", "The parcel desk\nreads the row\nfirst."], SENTENCE_TWO), WORDS);

    expect(report.findings).toEqual([{ rule: "lines", cue: 1, message: "cue 1: 3 lines (at most 2)" }]);
  });

  it("fails cps on a cue read faster than 20 characters a second", () => {
    const report = captionReport(vtt(["00:00:00.500", "00:00:02.000", SENTENCE_ONE[2]], SENTENCE_TWO), WORDS);

    expect(report.findings).toEqual([{ rule: "cps", cue: 1, message: "cue 1: 24.0 characters/s (at most 20)" }]);
  });

  it("fails onset on a cue 0.5 s after its first word and passes one 0.2 s before it", () => {
    const late = captionReport(vtt(SENTENCE_ONE, ["00:00:05.000", "00:00:07.000", SENTENCE_TWO[2]]), WORDS);
    const early = captionReport(vtt(SENTENCE_ONE, ["00:00:04.300", "00:00:07.000", SENTENCE_TWO[2]]), WORDS);

    expect(late.findings).toEqual([{ rule: "onset", cue: 2, message: "cue 2 starts 0.50 s from its first word (at most ±0.3)" }]);
    expect(early.findings).toEqual([]);
  });
});
