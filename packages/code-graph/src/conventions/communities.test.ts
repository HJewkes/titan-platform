import { describe, it, expect } from "vitest";
import { detectCommunities } from "./communities.js";
import type { GraphEdge } from "../types.js";

const edge = (srcId: string, dstId: string): GraphEdge => ({
  srcId,
  dstId,
  kind: "imports",
});

/** Two triangles joined by one weak bridge. */
const FILES = ["a1", "a2", "a3", "b1", "b2", "b3"];
const TWO_CLUSTERS: GraphEdge[] = [
  edge("a1", "a2"),
  edge("a2", "a3"),
  edge("a3", "a1"),
  edge("b1", "b2"),
  edge("b2", "b3"),
  edge("b3", "b1"),
  edge("a1", "b1"),
];

function sortedMembers(communities: Map<string, string[]>): string[][] {
  return [...communities.values()]
    .map((m) => [...m].sort())
    .sort((a, b) => ((a[0] ?? "") < (b[0] ?? "") ? -1 : 1));
}

describe("detectCommunities", () => {
  it("finds the natural modularity partition", () => {
    const communities = detectCommunities(FILES, TWO_CLUSTERS);
    expect(sortedMembers(communities)).toEqual([
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
    ]);
  });

  it("coarsens past the natural stop down to targetCount", () => {
    const communities = detectCommunities(FILES, TWO_CLUSTERS, {
      targetCount: 1,
    });
    expect(sortedMembers(communities)).toEqual([[...FILES].sort()]);
  });

  it("cannot coarsen below the connected-component count", () => {
    const disconnected = TWO_CLUSTERS.filter(
      (e) => !(e.srcId === "a1" && e.dstId === "b1"),
    );
    const communities = detectCommunities(FILES, disconnected, {
      targetCount: 1,
    });
    expect(communities.size).toBe(2);
  });

  it("never grows a community past maxSize", () => {
    // A 6-clique wants to be one blob; the cap must split it.
    const clique: GraphEdge[] = [];
    for (let i = 0; i < FILES.length; i++) {
      for (let j = i + 1; j < FILES.length; j++) {
        clique.push(edge(FILES[i]!, FILES[j]!));
      }
    }
    const communities = detectCommunities(FILES, clique, { maxSize: 3 });
    const sizes = [...communities.values()].map((m) => m.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(6);
  });

  it("is deterministic across runs and input order", () => {
    const a = detectCommunities(FILES, TWO_CLUSTERS);
    const b = detectCommunities(
      [...FILES].reverse(),
      [...TWO_CLUSTERS].reverse(),
    );
    expect(sortedMembers(a)).toEqual(sortedMembers(b));
  });
});
