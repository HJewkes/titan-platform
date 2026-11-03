import type { ProbedMoment } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { layerTextHint, voicedBeat } from "../build/layer-text.js";
import { LAYER_DIFF_FPS, LAYER_TIMING_RULES, layerDiffTimes, layerTimingRows, QA_TIMING_GATE_COVER, shareAfterPrevious } from "./layer-timing.js";
import type { QaBeat } from "./qa-timeline.js";
import { staticWindow, TIMING_GATES, timingProfile, type TimingInput } from "./timing-gates.js";

// Synthetic: an invented parcel desk whose last cue falls near the end of its narration.
const MOVED = 0.5;
const BEAT = "b-desk";
const framesOf = (durationS: number) => Math.ceil(durationS * LAYER_DIFF_FPS);
/** Still frames with a change at each of `changes`, in seconds. */
const diffsWith = (durationS: number, changes: readonly number[]) => {
  const diffs = new Array<number>(framesOf(durationS)).fill(0);
  for (const t of changes) diffs[Math.round(t * LAYER_DIFF_FPS)] = MOVED;
  return diffs;
};
const layerBeat = (durationS: number, cueAtS: readonly number[]): QaBeat => ({ id: BEAT, kind: "custom", layer: "custom", startS: 0, durationS, cues: cueAtS.map((atS, i) => ({ name: `word${i}`, atS })) });
const SPEECH = { durationS: 16, words: [{ word: "Parcels", startS: 0.4 }, { word: "wait", startS: 12.5 }] };

const input = (over: Partial<TimingInput>): TimingInput => ({
  timeline: { beats: [layerBeat(16, [2, 6, 10, 14])] }, words: new Map([[BEAT, SPEECH]]), held: new Set(), diffs: [], fps: LAYER_DIFF_FPS, probed: [], profile: timingProfile(), ...over,
});
/** A beat that moves every 2 s, so only what a case changes can fail. */
const LIVELY = diffsWith(16, [2, 4, 6, 8, 10, 12, 14]);
const text = (element: string, shown: string, cls = "", tag = "div") => ({ text: shown, px: 48, tag, cls, element, lines: [], clips: [] });
const probedAt = (t: number, texts: ProbedMoment["texts"]): ProbedMoment => ({ beat: BEAT, t, texts, boxes: [] });

describe("qa's timing gates on a custom layer", () => {
  // catches: a build check that never runs static-window, so a layer still after its last cue reaches qa (TP-4611)
  it("names a 3.4 s silent stretch after the last cue and tells the rebuild to change the picture inside it", () => {
    // Arrange
    const still = input({ timeline: { beats: [layerBeat(16, [2, 6, 10, 12.5])] }, diffs: diffsWith(16, [2, 4, 6, 8, 10, 12.5]) });

    // Act
    const rows = layerTimingRows(BEAT, still);

    // Assert
    expect(rows).toEqual([{ beat: BEAT, element: "frame", rule: "static-window", text: "still for 3.4 s, from 12.6 s to 16.0 s of the beat", atS: 12.6 }]);
    expect(layerTextHint(rows)).toContain("static-window on frame \"still for 3.4 s, from 12.6 s to 16.0 s of the beat\" (change the picture inside this still stretch");
  });

  it("passes the same beat with a change a second and a half after its last cue", () => {
    // Arrange
    const moved = input({ timeline: { beats: [layerBeat(16, [2, 6, 10, 12.5])] }, diffs: diffsWith(16, [2, 4, 6, 8, 10, 12.5, 14]) });

    // Act
    const rows = layerTimingRows(BEAT, moved);

    // Assert
    expect(rows).toEqual([]);
  });

  // catches: a build check that holds a layer stricter than qa, so a frame qa excuses costs a rebuild (vc-6)
  it("excuses a still stretch after the last cue under speech, as qa does", () => {
    // Arrange
    const spoken = new Map([[BEAT, { durationS: 16, words: [{ word: "Parcels", startS: 0.4 }, { word: "wait", startS: 14 }] }]]);
    const still = input({ timeline: { beats: [layerBeat(16, [2, 6, 9, 12])] }, words: spoken, diffs: diffsWith(16, [2, 4, 6, 8, 9, 12]) });

    // Act
    const rows = layerTimingRows(BEAT, still);

    // Assert
    expect(staticWindow(still).pass).toBe(true);
    expect(rows).toEqual([]);
  });

  // catches: a settled allowance that also reaches a layer still waiting on a cue
  it("refuses a 4 s still stretch before the last cue even under speech", () => {
    // Arrange
    const spoken = new Map([[BEAT, { durationS: 16, words: [{ word: "Parcels", startS: 0.4 }, { word: "wait", startS: 15 }] }]]);
    const waiting = input({ timeline: { beats: [layerBeat(16, [2, 4, 7, 10, 14])] }, words: spoken, diffs: diffsWith(16, [2, 4, 7, 10, 14]) });

    // Act
    const rows = layerTimingRows(BEAT, waiting);

    // Assert
    expect(rows.map(({ rule, atS }) => [rule, atS])).toEqual([["static-window", 10.1]]);
  });

  it("excuses a declared held beat, as qa does", () => {
    // Arrange
    const held = input({ timeline: { beats: [layerBeat(16, [2, 8])] }, held: new Set([BEAT]), diffs: diffsWith(16, [2, 8]) });

    // Act
    const rows = layerTimingRows(BEAT, held).filter((row) => row.rule === "static-window");

    // Assert
    expect(rows).toEqual([]);
  });

  it("excuses the reading hold of a text the narration does not say, as qa does", () => {
    // Arrange
    const label = text("span#note", "Sorted overnight by the late desk crew");
    const read = input({ diffs: diffsWith(16, [2, 4, 6, 8, 10, 12.5]), probed: [probedAt(12, []), probedAt(12.5, [label]), probedAt(15.9, [label])] });

    // Act
    const rows = layerTimingRows(BEAT, read);

    // Assert
    expect(rows).toEqual([]);
  });

  // catches: a build check that leaves picture-change to qa, so a long stretch between cues costs a render
  it("flags a stretch between cue-driven changes past qa's fail line", () => {
    // Arrange
    const sparse = input({ timeline: { beats: [layerBeat(16, [3.5])] }, diffs: diffsWith(16, [2, 3.5, 5, 7, 9, 11, 13, 15]) });

    // Act
    const rows = layerTimingRows(BEAT, sparse);

    // Assert
    expect(rows.map(({ rule, text: shown }) => [rule, shown])).toEqual([["picture-change", "12.5 s between cue-driven changes, ≤ 8 s (warn above 5 s)"]]);
  });

  // catches: a build check that leaves reading-hold to qa, so a text gone before it can be read costs a render
  it("flags an unspoken text that leaves before it can be read", () => {
    // Arrange
    const flash = text("span#note", "Sorted overnight by the late desk crew");
    const brief = input({ diffs: LIVELY, probed: [probedAt(3, [flash]), probedAt(3.5, [flash]), probedAt(4, [])] });

    // Act
    const rows = layerTimingRows(BEAT, brief);

    // Assert
    expect(rows).toEqual([{ beat: BEAT, element: "span#note", rule: "reading-hold", text: "Sorted overnight by the late desk crew", atS: 3 }]);
  });

  // catches: a build check that leaves G9 to qa, so a sentence as a label costs a render
  it("flags a label past three words", () => {
    // Arrange
    const label = text("span.ex-label", "Parcels waiting at desk", "ex-label");
    const wordy = input({ diffs: LIVELY, words: new Map([[BEAT, { durationS: 16, words: "Parcels waiting at desk".split(" ").map((word) => ({ word, startS: 1 })) }]]), probed: [probedAt(1, [label])] });

    // Act
    const rows = layerTimingRows(BEAT, wordy);

    // Assert
    expect(rows).toEqual([{ beat: BEAT, element: "span.ex-label", rule: "G9", text: "Parcels waiting at desk", atS: 0 }]);
  });
});

describe("the layer check and qa hold the same timing gates", () => {
  // catches: a gate added to qa's list that no one decided how the layer check meets
  it("accounts for every gate qa's stage fails on", () => {
    // Arrange
    const accounted = Object.keys(QA_TIMING_GATE_COVER);

    // Act
    const missing = TIMING_GATES.filter((gate) => !accounted.includes(gate));

    // Assert
    expect(missing).toEqual([]);
    expect(accounted.sort()).toEqual([...TIMING_GATES].sort());
  });

  // catches: a gate marked as run here that the check does not run
  it("runs every gate it says it runs", () => {
    // Arrange
    const claimed = Object.entries(QA_TIMING_GATE_COVER).flatMap(([gate, cover]) => (cover === "timing" ? [gate] : []));

    // Act
    const run = [...LAYER_TIMING_RULES].sort();

    // Assert
    expect(run).toEqual(claimed.sort());
  });
});

describe("the voice clock the layer check plays a beat on", () => {
  const LAST_LINE = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty ledger closes";
  const packet = { beat_id: BEAT, spoken: LAST_LINE, cues: [{ action: "V6" as const, target: "desk", atCue: "ledger" }], planned_s: 20, band: "story" as const };

  // catches: a check that plays the beat on the plan's seconds, where the stretch after the last cue is short by a second or more
  it("ends a beat the voice runs short at truing's length, not the plan's", () => {
    // Arrange
    const wordsPerMinute = 180;

    // Act
    const voiced = voicedBeat(packet, wordsPerMinute);

    // Assert
    expect(voiced.cues.ledger).toBeCloseTo(0.3 + 20 / 3, 6);
    expect(voiced.durationS).toBeCloseTo(9.233, 2);
  });

  it("keeps a held beat at its plan", () => {
    // Arrange
    const held = { ...packet, band: "held" as const };

    // Act
    const voiced = voicedBeat(held, 180);

    // Assert
    expect(voiced.durationS).toBe(20);
  });

  it("drops a cue the narration never speaks rather than guess its time", () => {
    // Arrange
    const unspoken = { ...packet, cues: [{ action: "V6" as const, target: "desk", atCue: "shelf" }] };

    // Act
    const voiced = voicedBeat(unspoken, 180);

    // Assert
    expect(voiced.cues).toEqual({});
  });
});

describe("the frames the layer's timing gates read", () => {
  it("reads ten evenly spaced frames a second and the change of each from the one before", () => {
    // Arrange
    const frame = (value: number) => new Uint8Array(320 * 180).fill(value);

    // Act
    const times = layerDiffTimes(0.3);
    const shares = shareAfterPrevious(times, (t) => frame(t < 0.2 ? 0 : 255));

    // Assert
    expect(times).toEqual([0, 0.1, 0.2]);
    expect(shares).toEqual([0, 0, 1]);
  });
});
