/** Per-frame CTC logits, row-major: frame `t`, token `v` is `data[t * vocabSize + v]`. */
export interface CtcLogits {
  data: Float32Array;
  frames: number;
  vocabSize: number;
  /** Seconds per frame. Frame `t` covers the audio from about `t * frameS`. */
  frameS: number;
}

/** The token every CTC model here uses as its blank, `<pad>`. */
export const CTC_BLANK_ID = 0;

const NORM_EPS = 1e-7;

/**
 * `Wav2Vec2FeatureExtractor`'s zero-mean, unit-variance normalization: population variance, eps 1e-7, sums in
 * float64. A constant signal becomes zeros rather than a division by zero.
 */
export function normalizeInput(samples: Float32Array): Float32Array {
  if (samples.length === 0) return new Float32Array(0);
  let mean = 0;
  for (const v of samples) mean += v;
  mean /= samples.length;
  let variance = 0;
  for (const v of samples) variance += (v - mean) ** 2;
  variance /= samples.length;
  const scale = 1 / Math.sqrt(variance + NORM_EPS);
  return Float32Array.from(samples, (v) => (v - mean) * scale);
}

/** The best token per frame. A tie goes to the lower id, as `torch.argmax` gives. */
export function argmaxFrames(logits: CtcLogits): number[] {
  const { data, frames, vocabSize } = logits;
  const ids = new Array<number>(frames);
  for (let t = 0; t < frames; t++) {
    const row = t * vocabSize;
    let best = 0;
    for (let v = 1; v < vocabSize; v++) if (data[row + v]! > data[row + best]!) best = v;
    ids[t] = best;
  }
  return ids;
}

/**
 * Greedy CTC decode: collapse runs of one id, then drop the blank and every `<…>` special token, and join the
 * remaining tokens with a space. A blank between two equal ids keeps both.
 */
export function ctcGreedyDecode(ids: readonly number[], tokens: readonly string[]): string {
  const out: string[] = [];
  ids.forEach((id, t) => {
    if (id === ids[t - 1]) return;
    const token = tokens[id];
    if (token === undefined) throw new RangeError(`token id ${id} is outside the ${tokens.length}-token vocab`);
    if (id !== CTC_BLANK_ID && !token.startsWith("<")) out.push(token);
  });
  return out.join(" ");
}
