import { describe, it, expect } from "vitest";
import { computePageRank } from "./pagerank.js";
import type { GraphEdge, GraphNode } from "../types.js";

function file(id: string): GraphNode {
  return { id, kind: "file", name: id };
}

function imports(srcId: string, dstId: string): GraphEdge {
  return { srcId, dstId, kind: "imports" };
}

function scoreOf(
  rows: { nodeId: string; score: number }[],
  id: string,
): number {
  return rows.find((r) => r.nodeId === id)?.score ?? NaN;
}

describe("computePageRank", () => {
  it("returns empty result for empty input", () => {
    const result = computePageRank([], []);
    expect(result.rows).toEqual([]);
    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(0);
  });

  it("scores are non-negative and sum to ~1 under uniform teleport", () => {
    const result = computePageRank(
      [file("a"), file("b"), file("c"), file("d")],
      [imports("a", "b"), imports("b", "c"), imports("c", "b"), imports("d", "a")],
    );
    expect(result.converged).toBe(true);
    const total = result.rows.reduce((s, r) => s + r.score, 0);
    expect(total).toBeCloseTo(1, 6);
    for (const r of result.rows) expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it("ranks an in-hub above its callers and isolated nodes (uniform teleport)", () => {
    // a→b, c→b, d→b ; b has fan_in=3, others have 0.
    const result = computePageRank(
      [file("a"), file("b"), file("c"), file("d")],
      [imports("a", "b"), imports("c", "b"), imports("d", "b")],
    );
    expect(result.rows[0]!.nodeId).toBe("b");
    expect(scoreOf(result.rows, "b")).toBeGreaterThan(scoreOf(result.rows, "a"));
  });

  it("personalization concentrates rank near the seed", () => {
    // a→b→c→d, plus an isolated branch e→f. Seed = a.
    const nodes = ["a", "b", "c", "d", "e", "f"].map(file);
    const edges = [
      imports("a", "b"),
      imports("b", "c"),
      imports("c", "d"),
      imports("e", "f"),
    ];
    const result = computePageRank(nodes, edges, {
      personalization: new Map([["a", 1]]),
    });
    // Nodes reachable from a should outrank disconnected nodes (e, f).
    const reachable = ["a", "b", "c", "d"];
    const disjoint = ["e", "f"];
    for (const r of reachable) {
      for (const d of disjoint) {
        expect(scoreOf(result.rows, r)).toBeGreaterThan(scoreOf(result.rows, d));
      }
    }
  });

  it("different seeds change the ranking", () => {
    const nodes = ["a", "b", "c", "d"].map(file);
    const edges = [imports("a", "b"), imports("c", "d")];
    const fromA = computePageRank(nodes, edges, {
      personalization: new Map([["a", 1]]),
    });
    const fromC = computePageRank(nodes, edges, {
      personalization: new Map([["c", 1]]),
    });
    expect(scoreOf(fromA.rows, "b")).toBeGreaterThan(
      scoreOf(fromC.rows, "b"),
    );
    expect(scoreOf(fromC.rows, "d")).toBeGreaterThan(
      scoreOf(fromA.rows, "d"),
    );
  });

  it("falls back to uniform when personalization has no valid ids", () => {
    const nodes = ["a", "b"].map(file);
    const edges = [imports("a", "b")];
    const result = computePageRank(nodes, edges, {
      personalization: new Map([["phantom", 1]]),
    });
    const uniform = computePageRank(nodes, edges);
    expect(scoreOf(result.rows, "a")).toBeCloseTo(scoreOf(uniform.rows, "a"), 6);
    expect(scoreOf(result.rows, "b")).toBeCloseTo(scoreOf(uniform.rows, "b"), 6);
  });

  it("handles dangling nodes (no outgoing edges) without losing mass", () => {
    // a→b, c isolated, d→a. b and c are dangling.
    const nodes = ["a", "b", "c", "d"].map(file);
    const edges = [imports("a", "b"), imports("d", "a")];
    const result = computePageRank(nodes, edges);
    const total = result.rows.reduce((s, r) => s + r.score, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("ignores edges referencing unknown nodes", () => {
    const result = computePageRank(
      [file("a"), file("b")],
      [imports("a", "phantom"), imports("phantom", "b"), imports("a", "b")],
    );
    expect(result.converged).toBe(true);
    expect(result.rows.find((r) => r.nodeId === "phantom")).toBeUndefined();
  });

  it("edge kind weights affect ranking", () => {
    const nodes = ["a", "b", "c"].map(file);
    const edges: GraphEdge[] = [
      { srcId: "a", dstId: "b", kind: "imports" },
      { srcId: "a", dstId: "c", kind: "imports" },
    ];
    const equal = computePageRank(nodes, edges);
    // Up-weight the a→c edge — c should outrank b.
    const skewed = computePageRank(nodes, edges, {
      edgeWeights: { imports: 1.0 },
    });
    // (sanity) with equal weights, scores of b and c are equal.
    expect(scoreOf(equal.rows, "b")).toBeCloseTo(scoreOf(equal.rows, "c"), 6);

    const skewedEdges: GraphEdge[] = [
      { srcId: "a", dstId: "b", kind: "imports" },
      { srcId: "a", dstId: "c", kind: "calls" },
    ];
    const calls = computePageRank(nodes, skewedEdges);
    expect(scoreOf(calls.rows, "c")).toBeGreaterThan(scoreOf(calls.rows, "b"));
    expect(skewed.iterations).toBeGreaterThan(0);
  });

  it("rows are sorted descending by score with ties broken by nodeId", () => {
    // Three identical isolated nodes — uniform scores, deterministic id order.
    const result = computePageRank(["c", "a", "b"].map(file), []);
    expect(result.rows.map((r) => r.nodeId)).toEqual(["a", "b", "c"]);
  });
});
