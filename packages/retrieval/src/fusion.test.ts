import { describe, expect, it } from "vitest";
import { applyDropoff, fuseByRRF } from "./fusion.js";

const list = (name: string, ids: string[]) => ({ name, hits: ids.map((id, i) => ({ id, rank: i + 1 })) });

describe("fuseByRRF", () => {
  it("ranks an id present in two lists above the top of a single list, with k = 60", () => {
    const fused = fuseByRRF([list("fts", ["a", "b", "c"]), list("vector", ["c", "d"])]);
    expect(fused[0]).toMatchObject({ id: "c", sources: ["fts", "vector"] });
    expect(fused[0]!.score).toBeCloseTo(1 / 63 + 1 / 61, 10);
    // b (fts rank 2) and d (vector rank 2) tie at 1/62; first-seen order wins.
    expect(fused.map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("applies per-retriever weights and a custom k", () => {
    const fused = fuseByRRF([list("fts", ["a"]), list("vector", ["b"])], { k: 10, weights: { vector: 3 } });
    expect(fused.map((r) => r.id)).toEqual(["b", "a"]);
    expect(fused[0]!.score).toBeCloseTo(3 / 11, 10);
  });

  it("carries payloads keyed by retriever and handles empty input", () => {
    const fused = fuseByRRF([{ name: "fts", hits: [{ id: "a", rank: 1, payload: { byteOffset: 7 } }] }]);
    expect(fused[0]!.payloads).toEqual({ fts: { byteOffset: 7 } });
    expect(fuseByRRF([])).toEqual([]);
  });
});

describe("applyDropoff", () => {
  it("cuts at the largest relative drop when it exceeds the threshold", () => {
    const results = [{ score: 1 }, { score: 0.95 }, { score: 0.4 }, { score: 0.38 }];
    expect(applyDropoff(results, 0.3)).toHaveLength(2);
    expect(applyDropoff(results, 0.9)).toHaveLength(4);
    expect(applyDropoff([{ score: 1 }], 0.1)).toHaveLength(1);
  });
});
