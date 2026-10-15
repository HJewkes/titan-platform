import { describe, expect, it } from "vitest";
import { argmaxFrames, ctcGreedyDecode, normalizeInput, type CtcLogits } from "./ctc.js";

const TOKENS = ["<pad>", "<s>", "</s>", "<unk>", "l", "ə", "aɪ"];
const [PAD, BOS, EOS, UNK, L, SCHWA, AI] = TOKENS.map((_, id) => id) as [number, number, number, number, number, number, number];

describe("ctcGreedyDecode", () => {
  it("collapses repeats, drops blanks and keeps a repeat split by a blank", () => {
    expect(ctcGreedyDecode([PAD, L, L, PAD, L, SCHWA, SCHWA, PAD], TOKENS)).toBe("l l ə");
  });

  it("drops the <s>, </s> and <unk> special tokens", () => {
    expect(ctcGreedyDecode([BOS, L, UNK, AI, EOS], TOKENS)).toBe("l aɪ");
  });

  it("gives an empty string for silence", () => {
    expect(ctcGreedyDecode([PAD, PAD, PAD], TOKENS)).toBe("");
  });

  it("rejects an id outside the vocab", () => {
    expect(() => ctcGreedyDecode([L, 99], TOKENS)).toThrow(RangeError);
  });
});

describe("argmaxFrames", () => {
  const logits = (rows: number[][]): CtcLogits => ({
    data: Float32Array.from(rows.flat()),
    frames: rows.length,
    vocabSize: rows[0]!.length,
    frameS: 0.02,
  });

  it("picks the highest-scoring token per frame", () => {
    expect(argmaxFrames(logits([[0, 3, 1], [5, -1, 2]]))).toEqual([1, 0]);
  });

  it("gives a tie to the lower id", () => {
    expect(argmaxFrames(logits([[1, 4, 4], [2, 2, 2]]))).toEqual([1, 0]);
  });
});

describe("normalizeInput", () => {
  it("gives zero mean and unit population variance", () => {
    const out = normalizeInput(Float32Array.from([1, 2, 3, 4]));
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    const variance = out.reduce((a, b) => a + (b - mean) ** 2, 0) / out.length;

    expect(mean).toBeCloseTo(0, 6);
    expect(variance).toBeCloseTo(1, 5);
    expect(out[0]).toBeCloseTo(-1.5 / Math.sqrt(1.25 + 1e-7), 6);
  });

  it("turns a constant signal into zeros instead of dividing by zero", () => {
    expect(Array.from(normalizeInput(new Float32Array(8).fill(0.3)))).toEqual(new Array(8).fill(0));
  });
});
