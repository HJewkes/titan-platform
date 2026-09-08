import { describe, expect, it } from "vitest";
import { cosineSimilarity, dot, fromFloat32Buffer, normalize, toFloat32Buffer } from "./vector.js";

describe("vector helpers", () => {
  it("computes dot, cosine, and normalization", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([2, 0], [5, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(normalize([0, 0])).toEqual([0, 0]);
    expect(() => dot([1], [1, 2])).toThrow(/length mismatch/);
  });

  it("round-trips through float32 bytes with float32 precision", () => {
    const v = [0.1, -0.25, 3.5, 1e-3];
    const back = fromFloat32Buffer(toFloat32Buffer(v));
    expect(back).toHaveLength(4);
    back.forEach((x, i) => expect(x).toBeCloseTo(v[i]!, 6));
    expect(toFloat32Buffer(v).byteLength).toBe(16);
  });

  it("reads a float32 buffer that is a slice of a larger allocation", () => {
    const bytes = Buffer.concat([Buffer.alloc(3), toFloat32Buffer([1, 2])]);
    expect(fromFloat32Buffer(bytes.subarray(3))).toEqual([1, 2]);
  });
});
