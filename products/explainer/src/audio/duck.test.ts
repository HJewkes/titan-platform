import { describe, expect, it } from "vitest";
import { DEFAULT_DUCK, duckGainDb, speechIntervals } from "./duck.js";

const beat = (startS: number, spans: [number, number][]) => ({ startS, words: spans.map(([start, end]) => ({ start, end })) });

describe("speechIntervals", () => {
  it("merges two words 0.2 s apart and widens the run by attack and release", () => {
    const out = speechIntervals([beat(10, [[0, 0.5], [0.7, 1.2]])]);
    expect(out).toHaveLength(1);
    expect(out[0]!.startS).toBeCloseTo(10 - 0.12, 9);
    expect(out[0]!.endS).toBeCloseTo(11.2 + 0.4, 9);
  });

  it("keeps two words 0.5 s apart as separate runs on the absolute clock", () => {
    const out = speechIntervals([beat(10, [[0, 0.5]]), beat(20, [[0, 0.5]])]);
    expect(out).toHaveLength(2);
    expect(out[1]!.startS).toBeCloseTo(20 - 0.12, 9);
  });

  it("merges runs whose widened spans overlap", () => {
    const out = speechIntervals([beat(0, [[1, 1.5], [1.9, 2.4]])]);
    expect(out).toHaveLength(1);
  });

  it("never starts a run before zero", () => {
    expect(speechIntervals([beat(0, [[0, 0.3]])])[0]!.startS).toBe(0);
  });
});

describe("duckGainDb", () => {
  const intervals = speechIntervals([beat(10, [[0, 2]])]);

  it("is exactly underDb mid-speech", () => {
    expect(duckGainDb(intervals, 11, DEFAULT_DUCK)).toBe(DEFAULT_DUCK.underDb);
  });

  it("is exactly gapDb mid-gap", () => {
    expect(duckGainDb(intervals, 5, DEFAULT_DUCK)).toBe(DEFAULT_DUCK.gapDb);
  });

  it("ramps linearly halfway down over the attack", () => {
    const mid = (DEFAULT_DUCK.gapDb + DEFAULT_DUCK.underDb) / 2;
    expect(duckGainDb(intervals, 10 - 0.12 + 0.06, DEFAULT_DUCK)).toBeCloseTo(mid, 9);
  });

  it("ramps linearly halfway back up over the release", () => {
    const mid = (DEFAULT_DUCK.gapDb + DEFAULT_DUCK.underDb) / 2;
    expect(duckGainDb(intervals, 12 + 0.4 - 0.2, DEFAULT_DUCK)).toBeCloseTo(mid, 9);
  });
});
