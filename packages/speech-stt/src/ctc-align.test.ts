import { describe, expect, it } from "vitest";
import type { CtcLogits } from "./ctc.js";
import { ctcForcedAlign, type CtcTokenSpan } from "./ctc-align.js";

const VOCAB = ["<pad>", "l", "ə", "b", "ɛ", "f"];
const [BLANK, L, SCHWA, B, EH] = [0, 1, 2, 3, 4] as const;
const LOW = -10;

function logits(rows: number[][], frameS = 0.02): CtcLogits {
  return { data: Float32Array.from(rows.flat()), frames: rows.length, vocabSize: VOCAB.length, frameS };
}

/** One row per frame: `LOW` everywhere except `0` on each listed id. */
function favour(...ids: number[]): number[] {
  return VOCAB.map((_, v) => (ids.includes(v) ? 0 : LOW));
}

const frameSpans = (spans: CtcTokenSpan[]) => spans.map((s) => [s.startFrame, s.endFrame]);

describe("ctcForcedAlign", () => {
  const bellPath = [BLANK, B, B, EH, BLANK, L, L, BLANK].map((id) => favour(id));

  it("gives exact frame boundaries for a known best path", () => {
    const spans = ctcForcedAlign(logits(bellPath), [B, EH, L]);

    expect(spans.map((s) => s.tokenId)).toEqual([B, EH, L]);
    expect(frameSpans(spans)).toEqual([[1, 3], [3, 4], [5, 7]]);
    expect(spans.map((s) => [s.start, s.end])).toEqual([[1 * 0.02, 3 * 0.02], [3 * 0.02, 4 * 0.02], [5 * 0.02, 7 * 0.02]]);
  });

  it("forces a blank between repeated tokens even where the token scores higher", () => {
    const allL = [0, 1, 2].map(() => VOCAB.map((_, v) => (v === L ? 0 : v === BLANK ? -20 : LOW)));

    expect(frameSpans(ctcForcedAlign(logits(allL), [L, L]))).toEqual([[0, 1], [2, 3]]);
  });

  it("rejects too few frames for a repeat and accepts the same count for distinct tokens", () => {
    const two = logits([favour(L), favour(SCHWA)]);

    expect(() => ctcForcedAlign(two, [L, L])).toThrow(/needs at least 3 frames, got 2/);
    expect(() => ctcForcedAlign(two, [L, L])).toThrow(RangeError);
    expect(frameSpans(ctcForcedAlign(two, [L, SCHWA]))).toEqual([[0, 1], [1, 2]]);
  });

  it("stays in a token rather than advancing into it when both score the same", () => {
    const rows = [favour(BLANK, B), favour(B), favour(BLANK)];

    expect(frameSpans(ctcForcedAlign(logits(rows), [B]))).toEqual([[0, 2]]);
  });

  it("advances through a blank rather than skipping it when both score the same", () => {
    const rows = [favour(B), favour(BLANK, B), favour(EH)];

    expect(frameSpans(ctcForcedAlign(logits(rows), [B, EH]))).toEqual([[0, 1], [2, 3]]);
  });

  it("ends in the trailing blank when it ties the last token", () => {
    const rows = [favour(B), favour(BLANK, B)];

    expect(frameSpans(ctcForcedAlign(logits(rows), [B]))).toEqual([[0, 1]]);
  });

  it("normalises raw logits, so a per-row constant changes nothing", () => {
    const shifted = bellPath.map((row, t) => row.map((x) => x + 3.5 * t - 7));

    expect(ctcForcedAlign(logits(shifted), [B, EH, L])).toEqual(ctcForcedAlign(logits(bellPath), [B, EH, L]));
  });

  it("returns nothing for an empty target", () => {
    expect(ctcForcedAlign(logits(bellPath), [])).toEqual([]);
  });

  it.each([BLANK, -1, VOCAB.length, 1.5])("rejects target id %s", (id) => {
    expect(() => ctcForcedAlign(logits(bellPath), [B, id])).toThrow(RangeError);
  });

  it("rejects a non-positive frameS", () => {
    expect(() => ctcForcedAlign(logits(bellPath), [B], 0)).toThrow(RangeError);
  });

  it("times spans with an explicit frameS instead of the logits' own", () => {
    const spans = ctcForcedAlign(logits(bellPath), [B, EH, L], 0.04);

    expect(frameSpans(spans)).toEqual([[1, 3], [3, 4], [5, 7]]);
    expect(spans.map((s) => [s.start, s.end])).toEqual([[1 * 0.04, 3 * 0.04], [3 * 0.04, 4 * 0.04], [5 * 0.04, 7 * 0.04]]);
  });

  it("throws when no path has a finite score", () => {
    const rows = [VOCAB.map((_, v) => (v === L ? -Infinity : 0))];

    expect(() => ctcForcedAlign(logits(rows), [L])).toThrow(/no alignment path/);
  });
});
