import { describe, expect, it } from "vitest";
import { mergeTemplate, tokenSimilarity } from "./similarity.js";
import { DrainTree } from "./tree.js";

describe("tokenSimilarity and mergeTemplate", () => {
  it("scores identical, disjoint, wildcarded, and partial sequences", () => {
    expect(tokenSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    expect(tokenSimilarity(["a", "b", "c"], ["x", "y", "z"])).toBe(0);
    expect(tokenSimilarity(["<*>", "b", "c"], ["anything", "b", "c"])).toBe(1);
    expect(tokenSimilarity(["a", "b", "c", "d"], ["a", "x", "c", "y"])).toBe(0.5);
    expect(tokenSimilarity([], [])).toBe(1);
    expect(() => tokenSimilarity(["a"], ["a", "b"])).toThrow();
  });

  it("generalizes disagreeing positions and never tightens a wildcard", () => {
    expect(mergeTemplate(["a", "b"], ["a", "x"])).toEqual(["a", "<*>"]);
    expect(mergeTemplate(["<*>", "b"], ["anything", "b"])).toEqual(["<*>", "b"]);
    expect(() => mergeTemplate(["a"], ["a", "b"])).toThrow();
  });
});

describe("DrainTree", () => {
  it("creates a cluster for the first line and joins an identical line without generalizing", () => {
    const tree = new DrainTree();
    const line = ["error", "TS1234:", "Cannot", "find", "module", "a.ts"];
    const first = tree.insert([...line]);
    const second = tree.insert([...line]);
    expect(first.isNew).toBe(true);
    expect(second).toMatchObject({ isNew: false, templateChanged: false });
    expect(second.cluster.clusterId).toBe(first.cluster.clusterId);
    expect(second.cluster.size).toBe(2);
    expect(tree.clusterCount).toBe(1);
  });

  it("generalizes a differing position on join and never re-tightens it", () => {
    const tree = new DrainTree({ simTh: 0.5 });
    tree.insert(["error", "TS1234:", "a.ts"]);
    const second = tree.insert(["error", "TS1234:", "b.ts"]);
    expect(second.templateChanged).toBe(true);
    expect(tree.insert(["error", "TS1234:", "a.ts"]).cluster.tokens).toEqual(["error", "TS1234:", "<*>"]);
  });

  it("separates different token counts and dissimilar same-length lines", () => {
    const tree = new DrainTree({ simTh: 0.6 });
    tree.insert(["a", "b"]);
    tree.insert(["a", "b", "c"]);
    tree.insert(["error", "TS1234:", "Cannot", "find", "module", "a.ts"]);
    expect(tree.insert(["FAIL", "suite", "timeout", "after", "30000", "ms"]).isNew).toBe(true);
    expect(tree.clusterCount).toBe(4);
  });

  it("routes high-cardinality first tokens through the wildcard overflow branch", () => {
    const tree = new DrainTree({ maxChildren: 2, simTh: 0.99 });
    for (const t of ["alpha", "bravo", "charlie", "delta"]) tree.insert([t, "x"]);
    expect(tree.clusterCount).toBe(4);
  });

  it("evicts the least-supported cluster at capacity, breaking ties by recency", () => {
    const tree = new DrainTree({ maxClusters: 2, simTh: 0.99 });
    tree.insert(["one"]);
    tree.insert(["one"]);
    tree.insert(["two"]);
    tree.insert(["three"]);
    expect(tree.insert(["one"]).isNew).toBe(false);
    expect(tree.insert(["two"]).isNew).toBe(true);
    expect(tree.clusterCount).toBeLessThanOrEqual(2);
  });

  it("keeps the same survivors at capacity regardless of insertion order", () => {
    const survivors = (lines: string[]): string[] => {
      const tree = new DrainTree({ maxClusters: 3, simTh: 0.99 });
      for (const line of lines) tree.insert([line]);
      return tree.toSnapshot().clusters.map((c) => c.tokens[0]!).sort();
    };
    const grouped = ["a", "a", "a", "a", "b", "b", "b", "c", "c", "d"];
    expect(survivors(grouped)).toEqual(["a", "b", "c"]);
    expect(survivors([...grouped].reverse())).toEqual(survivors(grouped));
  });

  it("restores a snapshot with generalized tokens and original ids intact", () => {
    const tree = new DrainTree({ simTh: 0.5 });
    tree.insert(["error", "TS1234:", "a.ts"]);
    tree.insert(["error", "TS1234:", "b.ts"]);
    const restored = DrainTree.fromSnapshot(tree.toSnapshot(), { simTh: 0.5 });
    const result = restored.insert(["error", "TS1234:", "c.ts"]);
    expect(result.isNew).toBe(false);
    expect(result.cluster.clusterId).toBe(1);
    expect(result.cluster.tokens).toEqual(["error", "TS1234:", "<*>"]);
    expect(restored.insert(["fresh", "shape", "here"]).cluster.clusterId).toBe(2);
  });
});
