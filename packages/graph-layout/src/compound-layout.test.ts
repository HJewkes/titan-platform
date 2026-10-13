import { describe, it, expect } from "vitest";
import type { GraphNode } from "@titan-design/code-graph";
import { computeCompoundLayout } from "./compound-layout.js";
import { routeOf } from "./route.js";
import type { GraphInput, GroupOf, LaidOutNode, LayoutResult } from "./types.js";

// Group a file under its package (`pkg:<first-segment>`) and, for the drill-down
// case, also its subdirectory — outermost first.
const byPackage: GroupOf = (n) => [`pkg:${n.id.split("/")[0]}`];
const bySubdir: GroupOf = (n) => {
  const [pkg, sub] = n.id.split("/");
  return sub ? [`pkg:${pkg}`, `pkg:${pkg}/${sub}`] : [`pkg:${pkg}`];
};

function file(id: string): GraphNode {
  return { id, kind: "file", name: id.split("/").pop() ?? id, role: "source" };
}

function boxOf(n: LaidOutNode): { x0: number; x1: number; y0: number; y1: number } {
  return {
    x0: n.x - n.width / 2,
    x1: n.x + n.width / 2,
    y0: n.y - n.height / 2,
    y1: n.y + n.height / 2,
  };
}

// A route endpoint sits on the node's border, so it must fall inside the node's
// absolute bounding box (within a 1px tolerance). This is the invariant that
// fails if an edge's per-edge LCA offset was applied wrong.
function pointInBox(p: { x: number; y: number }, n: LaidOutNode): boolean {
  const b = boxOf(n);
  return p.x >= b.x0 - 1 && p.x <= b.x1 + 1 && p.y >= b.y0 - 1 && p.y <= b.y1 + 1;
}

function expectRoutesOnNodeBorders(layout: LayoutResult): void {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  for (const e of layout.edges) {
    const route = routeOf(e) ?? [];
    const label = `edge ${e.srcId}->${e.dstId}`;
    expect(route.length, `${label} routed`).toBeGreaterThanOrEqual(2);
    const [start, end] = [route[0], route.at(-1)];
    const [src, dst] = [byId.get(e.srcId), byId.get(e.dstId)];
    expect(start && src && pointInBox(start, src), `${label} starts on its source`).toBe(true);
    expect(end && dst && pointInBox(end, dst), `${label} ends on its target`).toBe(true);
  }
}

const twoPackages: GraphInput = {
  snapshotId: 1,
  nodes: [
    file("a/one.ts"),
    file("a/two.ts"),
    file("b/three.ts"),
  ],
  edges: [
    { srcId: "a/one.ts", dstId: "a/two.ts", kind: "imports" }, // intra-package (LCA = pkg:a)
    { srcId: "a/one.ts", dstId: "b/three.ts", kind: "imports" }, // cross-package (LCA = root)
  ],
};

describe("computeCompoundLayout", () => {
  it("assigns every node a finite, distinct absolute position", async () => {
    const layout = await computeCompoundLayout(twoPackages, null, byPackage);
    const seen = new Set<string>();
    for (const n of layout.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      seen.add(`${n.x},${n.y}`);
    }
    expect(seen.size).toBe(twoPackages.nodes.length);
  });

  it("routes both intra- and cross-package edges to absolute node borders", async () => {
    // The intra-package edge is the one whose correctness proves the LCA
    // offset: its ELK route is reported in the pkg:a frame, not the root frame.
    expectRoutesOnNodeBorders(await computeCompoundLayout(twoPackages, null, byPackage));
  });

  it("nests files two levels deep (package → subdir) with correct routing", async () => {
    const nested: GraphInput = {
      snapshotId: 1,
      nodes: [
        file("a/x/one.ts"),
        file("a/x/two.ts"),
        file("a/y/three.ts"),
        file("b/z/four.ts"),
      ],
      // One edge per LCA depth: the pkg:a/x subdirectory, the pkg:a package, and the root.
      edges: [
        { srcId: "a/x/one.ts", dstId: "a/x/two.ts", kind: "imports" },
        { srcId: "a/x/one.ts", dstId: "a/y/three.ts", kind: "imports" },
        { srcId: "a/x/one.ts", dstId: "b/z/four.ts", kind: "imports" },
      ],
    };
    expectRoutesOnNodeBorders(await computeCompoundLayout(nested, null, bySubdir));
  });

  it("returns an empty layout for an empty graph", async () => {
    const layout = await computeCompoundLayout(
      { snapshotId: 1, nodes: [], edges: [] },
      null,
      byPackage,
    );
    expect(layout.nodes).toEqual([]);
  });
});
