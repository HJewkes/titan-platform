import { CTC_BLANK_ID, type CtcLogits } from "./ctc.js";

/** Where one target token sits in the frames: `[startFrame, endFrame)`, and the same span in seconds. */
export interface CtcTokenSpan {
  tokenId: number;
  startFrame: number;
  /** Exclusive. */
  endFrame: number;
  /** `startFrame * frameS`. */
  start: number;
  /** `endFrame * frameS`. */
  end: number;
}

interface Trellis {
  /** Each state's best score at the last frame. */
  last: Float64Array;
  /** Per frame and state, how many states back the best predecessor sits: 0 stay, 1 advance, 2 skip a blank. */
  back: Uint8Array;
}

/**
 * CTC Viterbi forced alignment: the single best path through `blank, y1, blank, y2, …, blank` that emits
 * `targetIds` in order, and each target's frame span on it. A repeated token needs a blank between its copies.
 *
 * This is a port of the E2 spike harness, and its frame convention is part of the contract: a span starts at
 * `startFrame * frameS` and ends at `(lastFrame + 1) * frameS`. The per-voice start offsets were fitted on exactly
 * this convention and these tie-breaks, so changing either shifts every calibrated start.
 */
export function ctcForcedAlign(
  logits: CtcLogits,
  targetIds: readonly number[],
  frameS = logits.frameS,
): CtcTokenSpan[] {
  validate(logits, targetIds, frameS);
  if (targetIds.length === 0) return [];
  const trellis = forward(logSoftmax(logits), logits, targetIds);
  return backtrack(trellis, logits.frames, targetIds).map(([first, last], k) => ({
    tokenId: targetIds[k]!,
    startFrame: first,
    endFrame: last + 1,
    start: first * frameS,
    end: (last + 1) * frameS,
  }));
}

function validate(logits: CtcLogits, targetIds: readonly number[], frameS: number): void {
  if (!(frameS > 0)) throw new RangeError(`ctcForcedAlign: frameS must be positive, got ${frameS}`);
  for (const id of targetIds) {
    if (!Number.isInteger(id) || id < 0 || id >= logits.vocabSize) {
      throw new RangeError(`ctcForcedAlign: target id ${id} is outside the ${logits.vocabSize}-token vocab`);
    }
    if (id === CTC_BLANK_ID) throw new RangeError("ctcForcedAlign: the blank cannot be a target");
  }
  const needed = minFrames(targetIds);
  if (logits.frames < needed) {
    throw new RangeError(
      `ctcForcedAlign: ${targetIds.length} targets needs at least ${needed} frames, got ${logits.frames}`,
    );
  }
}

/** One frame per target, plus one blank between each pair of equal adjacent targets. */
function minFrames(targetIds: readonly number[]): number {
  let repeats = 0;
  for (let k = 1; k < targetIds.length; k++) if (targetIds[k] === targetIds[k - 1]) repeats++;
  return targetIds.length + repeats;
}

/** Row-wise log-softmax with max subtraction; sums run in float64, results are stored as float32. */
function logSoftmax({ data, frames, vocabSize }: CtcLogits): Float32Array {
  const out = new Float32Array(frames * vocabSize);
  for (let t = 0; t < frames; t++) {
    const row = t * vocabSize;
    let max = -Infinity;
    let sum = 0;
    for (let v = 0; v < vocabSize; v++) max = Math.max(max, data[row + v]!);
    for (let v = 0; v < vocabSize; v++) sum += Math.exp(data[row + v]! - max);
    const lse = max + Math.log(sum);
    for (let v = 0; v < vocabSize; v++) out[row + v] = data[row + v]! - lse;
  }
  return out;
}

function forward(logp: Float32Array, { frames, vocabSize }: CtcLogits, y: readonly number[]): Trellis {
  const states = 2 * y.length + 1;
  const label = (s: number): number => (s % 2 === 0 ? CTC_BLANK_ID : y[(s - 1) >> 1]!);
  const back = new Uint8Array(frames * states);
  let prev = new Float64Array(states).fill(-Infinity);
  prev[0] = logp[label(0)]!;
  prev[1] = logp[label(1)]!;
  for (let t = 1; t < frames; t++) {
    const cur = new Float64Array(states);
    for (let s = 0; s < states; s++) {
      const step = bestStep(prev, s, y);
      cur[s] = prev[s - step]! + logp[t * vocabSize + label(s)]!;
      back[t * states + s] = step;
    }
    prev = cur;
  }
  return { last: prev, back };
}

/** Stay beats advance beats skip on a tie: each later option must score strictly higher to win. */
function bestStep(prev: Float64Array, s: number, y: readonly number[]): number {
  let best = prev[s]!;
  let step = 0;
  if (s >= 1 && prev[s - 1]! > best) {
    best = prev[s - 1]!;
    step = 1;
  }
  if (canSkipBlank(s, y) && prev[s - 2]! > best) step = 2;
  return step;
}

/** Only into a label state, and only when its label differs from the previous one. */
function canSkipBlank(s: number, y: readonly number[]): boolean {
  return s >= 3 && s % 2 === 1 && y[(s - 1) >> 1] !== y[(s - 3) >> 1];
}

/** The path ends in the trailing blank unless the last label scores strictly higher. */
function backtrack({ last, back }: Trellis, frames: number, y: readonly number[]): [number, number][] {
  const states = last.length;
  let s = last[states - 1]! >= last[states - 2]! ? states - 1 : states - 2;
  if (!Number.isFinite(last[s]!)) throw new Error("ctcForcedAlign: no alignment path has a finite score");
  const spans: [number, number][] = y.map(() => [Infinity, -Infinity]);
  for (let t = frames - 1; t >= 0; t--) {
    if (s % 2 === 1) {
      const span = spans[(s - 1) >> 1]!;
      span[0] = Math.min(span[0], t);
      span[1] = Math.max(span[1], t);
    }
    s -= back[t * states + s]!;
  }
  return spans;
}
