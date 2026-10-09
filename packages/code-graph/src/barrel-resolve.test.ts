import { describe, it, expect } from "vitest";
import { resolveBarrelEdges } from "./barrel-resolve.js";
import type { GraphEdge, GraphNode } from "./types.js";

function file(id: string): GraphNode {
  return { id, kind: "file", name: id };
}
function barrel(id: string): GraphNode {
  return { id, kind: "file", name: id, role: "barrel" };
}
function symbol(id: string): GraphNode {
  return { id, kind: "symbol", name: id };
}
function edge(srcId: string, dstId: string, weight: number, kind: GraphEdge["kind"] = "imports"): GraphEdge {
  return { srcId, dstId, kind, attrs: { weight } };
}
/** Total resolved inbound weight per destination. */
function inboundWeights(edges: GraphEdge[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of edges) {
    const w = (e.attrs as { weight: number }).weight;
    m.set(e.dstId, (m.get(e.dstId) ?? 0) + w);
  }
  return m;
}

describe("resolveBarrelEdges", () => {
  it("returns edges unchanged when there are no barrels", () => {
    const edges = [edge("a", "b", 5)];
    expect(resolveBarrelEdges([file("a"), file("b")], edges)).toEqual(edges);
  });

  it("splits an inbound barrel edge across re-export targets by their weight, conserving total", () => {
    const nodes = [file("f"), barrel("index.ts"), file("t1"), file("t2")];
    const edges = [
      edge("f", "index.ts", 10),
      edge("index.ts", "t1", 3, "re-exports"),
      edge("index.ts", "t2", 1, "re-exports"),
    ];
    const w = inboundWeights(resolveBarrelEdges(nodes, edges));
    // 10 split 3:1 → 7.5 / 2.5, and the barrel receives nothing.
    expect(w.get("t1")).toBeCloseTo(7.5);
    expect(w.get("t2")).toBeCloseTo(2.5);
    expect(w.get("index.ts")).toBeUndefined();
    // Conservation: the importer's original weight is neither lost nor inflated.
    expect((w.get("t1") ?? 0) + (w.get("t2") ?? 0)).toBeCloseTo(10);
  });

  it("drops the barrel's own outbound plumbing edges", () => {
    const nodes = [file("f"), barrel("index.ts"), file("t1")];
    const resolved = resolveBarrelEdges(nodes, [
      edge("f", "index.ts", 4),
      edge("index.ts", "t1", 2, "re-exports"),
    ]);
    expect(resolved.every((e) => e.srcId !== "index.ts")).toBe(true);
  });

  it("resolves through a barrel chain to the real leaf file", () => {
    const nodes = [file("f"), barrel("a/index.ts"), barrel("b/index.ts"), file("leaf")];
    const w = inboundWeights(resolveBarrelEdges(nodes, [
      edge("f", "a/index.ts", 4),
      edge("a/index.ts", "b/index.ts", 2, "re-exports"),
      edge("b/index.ts", "leaf", 5, "re-exports"),
    ]));
    expect(w.get("leaf")).toBeCloseTo(4);
    expect(w.get("a/index.ts")).toBeUndefined();
    expect(w.get("b/index.ts")).toBeUndefined();
  });

  it("keeps a dead-end barrel (nothing to forward) as its own target", () => {
    const nodes = [file("f"), barrel("index.ts")];
    const w = inboundWeights(resolveBarrelEdges(nodes, [edge("f", "index.ts", 3)]));
    expect(w.get("index.ts")).toBe(3);
  });

  it("does not loop on a re-export cycle between barrels", () => {
    const nodes = [file("f"), barrel("a/index.ts"), barrel("b/index.ts")];
    const resolved = resolveBarrelEdges(nodes, [
      edge("f", "a/index.ts", 6),
      edge("a/index.ts", "b/index.ts", 1, "re-exports"),
      edge("b/index.ts", "a/index.ts", 1, "re-exports"),
    ]);
    // Terminates; the cycle resolves to a barrel-as-itself endpoint (no crash).
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("keeps a references edge from a barrel source as real usage (C-68)", () => {
    // A composition root the role classifier labels `barrel` but which actually
    // consumes a symbol via a destructured dynamic import. Its `references` edge
    // is usage, not re-export plumbing, so it must survive and credit the symbol
    // — while its module `imports` plumbing is still dropped.
    const nodes = [barrel("index.ts"), file("cmd.ts"), symbol("cmd.ts#runX")];
    const resolved = resolveBarrelEdges(nodes, [
      edge("index.ts", "cmd.ts", 1, "imports"),
      edge("index.ts", "cmd.ts#runX", 1, "references"),
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      srcId: "index.ts",
      dstId: "cmd.ts#runX",
      kind: "references",
    });
  });

  it("drops a resolved edge that circles back to the importer", () => {
    const nodes = [file("f"), barrel("index.ts")];
    // Barrel re-exports the importer itself → the F→F self-edge is dropped.
    const resolved = resolveBarrelEdges(nodes, [
      edge("f", "index.ts", 4),
      edge("index.ts", "f", 4, "re-exports"),
    ]);
    expect(resolved.every((e) => e.dstId !== e.srcId)).toBe(true);
  });

  describe("characterization", () => {
    it("emits edges in input order, passing non-barrel edges through and expanding barrel edges in target order", () => {
      const nodes = [file("x"), file("y"), file("f"), file("g"), barrel("index.ts"), file("t1"), file("t2")];
      const resolved = resolveBarrelEdges(nodes, [
        edge("x", "y", 2),
        edge("f", "index.ts", 10),
        edge("index.ts", "t1", 3, "re-exports"),
        edge("index.ts", "t2", 1, "re-exports"),
        edge("g", "t1", 1),
      ]);
      expect(resolved).toEqual([
        edge("x", "y", 2),
        edge("f", "t1", 7.5),
        edge("f", "t2", 2.5),
        edge("g", "t1", 1),
      ]);
    });

    it("treats an unweighted inbound edge as weight 1 and keeps its kind and other attrs", () => {
      const nodes = [file("f"), barrel("index.ts"), file("t")];
      const resolved = resolveBarrelEdges(nodes, [
        { srcId: "f", dstId: "index.ts", kind: "references" },
        { srcId: "index.ts", dstId: "t", kind: "re-exports" },
      ]);
      expect(resolved).toEqual([{ srcId: "f", dstId: "t", kind: "references", attrs: { weight: 1 } }]);
    });

    it("folds the shares of two paths to the same leaf into one edge", () => {
      const nodes = [file("f"), barrel("top"), barrel("l"), barrel("r"), file("leaf")];
      const resolved = resolveBarrelEdges(nodes, [
        edge("f", "top", 4),
        edge("top", "l", 1, "re-exports"),
        edge("top", "r", 1, "re-exports"),
        edge("l", "leaf", 1, "re-exports"),
        edge("r", "leaf", 1, "re-exports"),
      ]);
      expect(resolved).toEqual([edge("f", "leaf", 4)]);
    });

    it("resolves a barrel re-export cycle to the entry barrel itself", () => {
      const nodes = [file("f"), barrel("a"), barrel("b")];
      const resolved = resolveBarrelEdges(nodes, [
        edge("f", "a", 6),
        edge("a", "b", 1, "re-exports"),
        edge("b", "a", 1, "re-exports"),
      ]);
      expect(resolved).toEqual([edge("f", "a", 6)]);
    });

    it("excludes a barrel's references edges from its forwarding split", () => {
      const nodes = [file("f"), barrel("index.ts"), file("t1"), file("t2"), symbol("t2#s")];
      const resolved = resolveBarrelEdges(nodes, [
        edge("f", "index.ts", 2),
        edge("index.ts", "t1", 1, "re-exports"),
        edge("index.ts", "t2#s", 9, "references"),
      ]);
      expect(resolved).toEqual([edge("f", "t1", 2), edge("index.ts", "t2#s", 9, "references")]);
    });

    it("drops only the self-edge when a barrel re-exports both the importer and another file", () => {
      const nodes = [file("f"), barrel("index.ts"), file("t")];
      const resolved = resolveBarrelEdges(nodes, [
        edge("f", "index.ts", 4),
        edge("index.ts", "f", 1, "re-exports"),
        edge("index.ts", "t", 1, "re-exports"),
      ]);
      expect(resolved).toEqual([edge("f", "t", 2)]);
    });
  });
});
