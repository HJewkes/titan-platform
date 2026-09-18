import { describe, it, expect } from "vitest";
import { computeRelevance } from "./relevance.js";
import type { GraphEdge, GraphNode } from "../types.js";

function file(id: string): GraphNode {
  return { id, kind: "file", name: id };
}

function imports(srcId: string, dstId: string): GraphEdge {
  return { srcId, dstId, kind: "imports" };
}

const NODES = ["a", "b", "c", "d", "far"].map(file);
// a → b → c → d chain; `far` is a disconnected island.
const EDGES = [imports("a", "b"), imports("b", "c"), imports("c", "d")];

function scoreOf(m: Map<string, number>, id: string): number {
  return m.get(id) ?? NaN;
}

describe("computeRelevance", () => {
  it("returns an empty map for an empty seed set (cold path)", () => {
    expect(computeRelevance(NODES, EDGES, []).size).toBe(0);
    expect(computeRelevance(NODES, EDGES, [""]).size).toBe(0);
  });

  it("scores near neighbours above distant ones (proximity decays with distance)", () => {
    const rel = computeRelevance(NODES, EDGES, ["b"]);
    // From b: a (caller, 1 hop) and c (dependency, 1 hop) both beat d (2 hops).
    expect(scoreOf(rel, "b")).toBeGreaterThan(scoreOf(rel, "a"));
    expect(scoreOf(rel, "a")).toBeGreaterThan(scoreOf(rel, "d"));
    expect(scoreOf(rel, "c")).toBeGreaterThan(scoreOf(rel, "d"));
  });

  it("reaches a caller as well as a dependency (symmetrized walk)", () => {
    // Seeding at c must give relevance to b (which imports, doesn't get imported-by, c)...
    const rel = computeRelevance(NODES, EDGES, ["c"]);
    // ...and the disconnected island stays at the teleport floor, below any connected node.
    expect(scoreOf(rel, "b")).toBeGreaterThan(scoreOf(rel, "far"));
    expect(scoreOf(rel, "d")).toBeGreaterThan(scoreOf(rel, "far"));
  });

  it("differs from global centrality — the seed shifts mass toward its own neighbourhood", () => {
    const seededA = computeRelevance(NODES, EDGES, ["a"]);
    const seededD = computeRelevance(NODES, EDGES, ["d"]);
    // Near the a-end, b (a's neighbour) outranks c; near the d-end it flips.
    expect(scoreOf(seededA, "b")).toBeGreaterThan(scoreOf(seededA, "c"));
    expect(scoreOf(seededD, "c")).toBeGreaterThan(scoreOf(seededD, "b"));
    // And the same node scores higher when the seed is closer to it.
    expect(scoreOf(seededA, "b")).toBeGreaterThan(scoreOf(seededD, "b"));
  });
});
