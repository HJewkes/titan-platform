import { describe, expect, it } from "vitest";
import { failedGates } from "../workflow/stage-checks.js";
import { FROM, qaStageHarness } from "./qa-stage.test-helpers.js";

const harness = qaStageHarness();

/** One beat saying "the parcel desk reads the row", a word every 0.3 s from 0.5 s. */
const WORDS = { beats: [{ id: "b1", startS: 0, durationS: 4, words: "the parcel desk reads the row".split(" ").map((word, i) => ({ word, start: 0.5 + i * 0.3, end: 0.7 + i * 0.3 })) }] };

const CAPTION_CHECKS = ["captions-complete", "captions-words", "captions-lines", "captions-cps", "captions-onset"];

async function captioned(vtt: string | undefined) {
  const put = (value: string, as: string) => harness.store().putText(value, as, FROM);
  const extra = () => ({ words: put(JSON.stringify(WORDS), "words"), ...(vtt === undefined ? {} : { vtt: put(vtt, "vtt") }) });
  return harness.run({}, { extra });
}

describe("qa stage captions", () => {
  it("passes every caption check on a track that matches words.json", async () => {
    const { checks } = await captioned("WEBVTT\n\n1\n00:00:00.500 --> 00:00:02.500\nThe parcel desk reads the row.\n");

    expect(CAPTION_CHECKS.map((name) => checks[name]?.pass)).toEqual([true, true, true, true, true]);
  });

  it("reports a render with no VTT under captions-complete, and never fails the stage", async () => {
    const { report, checks } = await captioned(undefined);

    expect(checks["captions-complete"]).toEqual({ name: "captions-complete", gate: false, pass: false, detail: "1 caption complete: no captions.vtt artifact" });
    expect(failedGates(Object.values(checks))).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it("reports a cue late against its first word under captions-onset, as a reported check", async () => {
    const { report, checks } = await captioned("WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nThe parcel desk reads the row.\n");

    expect(checks["captions-onset"]).toMatchObject({ gate: false, pass: false, detail: "1 caption onset: cue 1 starts 0.50 s from its first word (at most ±0.3)" });
    expect(report.captions?.findings.map((finding) => finding.rule)).toEqual(["onset"]);
  });
});
