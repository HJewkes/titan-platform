import { describe, expect, it } from "vitest";
import { addPair, band, NO_NOISE, pooledSigma, sigmaOf, type NoiseSettings } from "./noise.js";

const SETTINGS: NoiseSettings = { bandSigmas: 2, lockAfterPairs: 5, minPairs: 3, defaultBandPp: 1.5 };

describe("noise", () => {
  it("pools σ within pairs, so pairs from very different code versions do not inflate it", () => {
    const pairs = [{ a: 10, b: 10.4 }, { a: 0, b: -0.4 }, { a: -20, b: -20 }];

    expect(pooledSigma(pairs)).toBeCloseTo(Math.sqrt((0.16 + 0.16) / 6), 10);
  });

  it("locks σ at the fifth pair and ignores every pair after it", () => {
    let state = NO_NOISE;
    for (const a of [0, 5, 10, 15]) state = addPair(state, { a, b: a + 0.2 }, SETTINGS);
    expect(state.locked).toBeUndefined();

    state = addPair(state, { a: 20, b: 20.2 }, SETTINGS);
    const locked = sigmaOf(state);
    state = addPair(state, { a: 0, b: 9 }, SETTINGS);

    expect(locked).toBeCloseTo(Math.sqrt(0.04 / 2), 10);
    expect(sigmaOf(state)).toBe(locked);
    expect(state.pairs).toHaveLength(5);
  });

  it("keeps the default band until σ is trusted, then uses 2σ once it locks", () => {
    const narrow = [0, 1].reduce((state, a) => addPair(state, { a, b: a + 0.1 }, SETTINGS), NO_NOISE);
    const wide = [0, 1, 2].reduce((state, a) => addPair(state, { a, b: a + 2 }, SETTINGS), NO_NOISE);
    const locked = [0, 1, 2, 3, 4].reduce((state, a) => addPair(state, { a, b: a + 0.2 }, SETTINGS), NO_NOISE);

    expect(band(narrow, SETTINGS)).toBe(1.5);
    expect(band(wide, SETTINGS)).toBeCloseTo(2 * Math.sqrt(2), 10);
    expect(band(locked, SETTINGS)).toBeCloseTo(2 * Math.sqrt(0.02), 10);
  });
});
