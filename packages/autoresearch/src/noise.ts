export interface NoiseSettings {
  bandSigmas: number;
  /** σ stops moving once this many pairs are in, so later heads are judged against a fixed band. */
  lockAfterPairs: number;
  /** Below this many pairs σ is not trusted and the band is the default. */
  minPairs: number;
  defaultBand: number;
}

/** Two runs of the same code on the same case. */
interface Pair {
  a: number;
  b: number;
}

export interface NoiseState {
  pairs: Pair[];
  locked?: number;
}

export const NO_NOISE: NoiseState = { pairs: [] };

/** Pooled within-pair sd, `sqrt(Σ d² / 2n)`: differences between code versions never inflate it. */
export function pooledSigma(pairs: readonly Pair[]): number | undefined {
  if (pairs.length === 0) return undefined;
  const sumSquares = pairs.reduce((sum, { a, b }) => sum + (a - b) ** 2, 0);
  return Math.sqrt(sumSquares / (2 * pairs.length));
}

export function addPair(state: NoiseState, pair: Pair, settings: NoiseSettings): NoiseState {
  if (state.locked !== undefined) return state;
  const pairs = [...state.pairs, pair];
  return pairs.length >= settings.lockAfterPairs ? { pairs, locked: pooledSigma(pairs)! } : { pairs };
}

export function sigmaOf(state: NoiseState): number | undefined {
  return state.locked ?? pooledSigma(state.pairs);
}

/** The keep band in primary-metric units: `bandSigmas`·σ once σ is trusted, never below the default until it locks. */
export function band(state: NoiseState, settings: NoiseSettings): number {
  if (state.locked !== undefined) return settings.bandSigmas * state.locked;
  const sigma = state.pairs.length >= settings.minPairs ? sigmaOf(state) : undefined;
  return Math.max(settings.bandSigmas * (sigma ?? 0), settings.defaultBand);
}
