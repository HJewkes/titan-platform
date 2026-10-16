import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createLogprobCapture, windowSegment, windowWords, type CapturedWindow } from "./token-logprobs.js";

// A toy vocabulary: ids 0-6 are text, 7 is EOT and 8 a special token past it. Ids 20 and 21 split one UTF-8
// character ("é", C3 A9) across two tokens, as byte-level BPE does; 30 is a repeated syllable.
const EOT = 7;
const VOCAB = 9;
const PIECES: Record<number, number[]> = {
  0: [...Buffer.from(" the")],
  1: [...Buffer.from(" zor")],
  2: [...Buffer.from("ptrix")],
  3: [...Buffer.from(",")],
  4: [...Buffer.from(" hum")],
  5: [...Buffer.from("med")],
  6: [...Buffer.from(".")],
  7: [...Buffer.from("<|endoftext|>")],
  8: [...Buffer.from("<|notimestamps|>")],
  20: [0x20, 0xc3],
  21: [0xa9],
  30: [...Buffer.from(" la")],
};
const decode = (ids: number[]) => new TextDecoder().decode(Uint8Array.from(ids.flatMap((id) => PIECES[id]!)));

const PROMPT = [8, 8];
const LN3 = Math.log(3);

/** A logits row with only the given entries live, so every softmax is derivable by hand. */
function row(live: Record<number, number>): Float32Array {
  const data = new Float32Array(VOCAB).fill(-Infinity);
  for (const [id, logit] of Object.entries(live)) data[Number(id)] = logit;
  return data;
}

type Processor = (ids: readonly (readonly number[])[], logits: { data: Float32Array }[]) => unknown;

/** One decode step through a processor list, run in order on the same logits as transformers.js does. */
function step(processors: Processor[], ids: number[], data: Float32Array): void {
  const logits = [{ data }];
  for (const processor of processors) processor([ids], logits);
}

const SPECIAL = new Set([EOT, 8]);
const tok = (id: number, p: number) => ({ id, logprob: Math.log(p), textLogprob: SPECIAL.has(id) ? null : Math.log(p) });

describe("createLogprobCapture", () => {
  it("resolves each step from the next call's last input id and the final step by argmax", () => {
    const capture = createLogprobCapture(EOT);
    step([capture.processor], PROMPT, row({ 0: LN3, 1: 0 }));
    step([capture.processor], [...PROMPT, 0], row({ 1: LN3, 4: 0 }));
    step([capture.processor], [...PROMPT, 0, 1], row({ 2: 0, 3: LN3 }));
    step([capture.processor], [...PROMPT, 0, 1, 2], row({ [EOT]: 0 }));

    const [window, ...rest] = capture.windows();

    expect(rest).toEqual([]);
    expect(window!.promptLength).toBe(2);
    expect(window!.tokens.map((t) => t.id)).toEqual([0, 1, 2, EOT]);
    const probabilities = window!.tokens.map((t) => Math.exp(t.logprob));
    // Float32 logits hold ln 3 to about 1e-8, so these are close rather than exact.
    [0.75, 0.75, 0.25].forEach((p, i) => expect(probabilities[i]).toBeCloseTo(p, 6));
    expect(window!.tokens[3]).toEqual({ id: EOT, logprob: 0, textLogprob: null });
  });

  it("scores the row after later processors have edited it in place", () => {
    const capture = createLogprobCapture(EOT);
    const forceId0: Processor = (_ids, logits) => logits[0]!.data.fill(-Infinity, 1);
    step([capture.processor, forceId0], PROMPT, row({ 0: 0, 1: LN3 }));
    step([capture.processor, forceId0], [...PROMPT, 0], row({ 0: 0 }));

    const [window] = capture.windows();

    expect(window!.tokens[0]).toEqual({ id: 0, logprob: 0, textLogprob: 0 });
  });

  it("opens a new window when the input does not grow", () => {
    const capture = createLogprobCapture(EOT);
    step([capture.processor], PROMPT, row({ 0: 0 }));
    step([capture.processor], [...PROMPT, 0], row({ [EOT]: 0 }));
    step([capture.processor], PROMPT, row({ 4: 0 }));
    step([capture.processor], [...PROMPT, 4], row({ 5: 0, 6: -1 }));

    const windows = capture.windows();

    expect(windows.map((w) => w.promptLength)).toEqual([2, 2]);
    expect(windows.map((w) => w.tokens.map((t) => t.id))).toEqual([
      [0, EOT],
      [4, 5],
    ]);
  });

  it("gives a higher text-vocab log-prob when mass sits on a special id", () => {
    const capture = createLogprobCapture(EOT);
    step([capture.processor], PROMPT, row({ 0: 0, 8: 0 }));

    const [token] = capture.windows()[0]!.tokens;

    expect(token!.textLogprob).toBe(0);
    expect(token!.logprob).toBeCloseTo(Math.log(0.5), 12);
    expect(token!.textLogprob!).toBeGreaterThan(token!.logprob);
  });

  it("returns the logits it was given, as a transformers.js processor must", () => {
    const capture = createLogprobCapture(EOT);
    const logits = [{ data: row({ 0: 0 }) }];

    expect(capture.processor([PROMPT], logits)).toBe(logits);
  });
});

describe("windowWords", () => {
  const window: CapturedWindow = {
    promptLength: 2,
    tokens: [tok(0, 0.9), tok(1, 0.6), tok(2, 0.4), tok(3, 0.1), tok(4, 0.8), tok(5, 0.6), tok(6, 0.2), tok(EOT, 0.9), tok(8, 0.5)],
  };

  it("joins sub-words, drops punctuation and special tokens, and averages token probabilities", () => {
    const words = windowWords(window, decode);

    expect(words.map((w) => w.text)).toEqual([" the", " zorptrix", " hummed"]);
    // The "," after "zorptrix" (p 0.1) stays out of its mean.
    [0.9, 0.5, 0.7].forEach((p, i) => expect(words[i]!.probability).toBeCloseTo(p, 12));
  });

  it("groups tokens that decode to U+FFFD alone until they decode cleanly", () => {
    const split: CapturedWindow = { promptLength: 2, tokens: [tok(0, 0.9), tok(20, 0.5), tok(21, 0.25)] };

    const words = windowWords(split, decode);

    expect(words.map((w) => w.text)).toEqual([" the", " é"]);
    expect(words[1]!.probability).toBe(0.375);
  });
});

describe("windowSegment", () => {
  it("divides the summed log-probs, EOT included, by the text-token count plus one", () => {
    const window: CapturedWindow = {
      promptLength: 2,
      tokens: [
        { id: 0, logprob: -0.5, textLogprob: -0.5 },
        { id: 1, logprob: -1, textLogprob: -1 },
        { id: 2, logprob: -0.25, textLogprob: -0.25 },
        { id: EOT, logprob: -0.25, textLogprob: null },
      ],
    };

    const segment = windowSegment(window, decode, { start: 0, end: 7.5 });

    expect(segment).toMatchObject({ text: "the zorptrix", start: 0, end: 7.5, avgLogprob: -0.5 });
  });

  it("reports the trimmed text's UTF-8 length over its deflated length", () => {
    const window: CapturedWindow = { promptLength: 2, tokens: [0, 1, 2, 4, 5, 6, EOT].map((id) => tok(id, 0.5)) };
    const bytes = Buffer.from("the zorptrix hummed.", "utf8");

    const segment = windowSegment(window, decode, { start: 0, end: 2 });

    expect(segment.text).toBe("the zorptrix hummed.");
    expect(segment.compressionRatio).toBe(bytes.length / deflateSync(bytes).length);
  });

  it("gives repetitive text a compression ratio past faster-whisper's 2.4 retry threshold", () => {
    const window: CapturedWindow = { promptLength: 2, tokens: Array.from({ length: 24 }, () => tok(30, 0.5)) };

    expect(windowSegment(window, decode, { start: 0, end: 5 }).compressionRatio).toBeGreaterThanOrEqual(2.4);
  });
});
