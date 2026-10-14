import { describe, it, expect } from "vitest";
import type { GraphNode } from "@titan-design/code-graph";
import { computeCompoundLayout } from "./compound-layout.js";
import { routeOf } from "./route.js";
import type { GraphInput, GroupOf, LaidOutGroup, LaidOutNode, LayoutResult } from "./types.js";

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

function boxOf(n: LaidOutNode | LaidOutGroup): { x0: number; x1: number; y0: number; y1: number } {
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
function pointInBox(p: { x: number; y: number }, n: LaidOutNode | LaidOutGroup): boolean {
  const b = boxOf(n);
  return p.x >= b.x0 - 1 && p.x <= b.x1 + 1 && p.y >= b.y0 - 1 && p.y <= b.y1 + 1;
}

// Inside the box, but within 1px of one of its four sides.
function pointOnBorder(p: { x: number; y: number }, n: LaidOutGroup): boolean {
  const b = boxOf(n);
  const nearSide = [p.x - b.x0, b.x1 - p.x, p.y - b.y0, b.y1 - p.y].some((d) => Math.abs(d) <= 1);
  return pointInBox(p, n) && nearSide;
}

function contains(outer: LaidOutGroup, inner: LaidOutNode | LaidOutGroup): boolean {
  const [o, i] = [boxOf(outer), boxOf(inner)];
  return o.x0 <= i.x0 && i.x1 <= o.x1 && o.y0 <= i.y0 && i.y1 <= o.y1;
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

// Two packages, each with two subdirectories, plus the aggregate edges a map draws at
// the package and directory levels, declared between group ids.
const withAggregates: GraphInput = {
  snapshotId: 1,
  nodes: ["a/x/one.ts", "a/x/two.ts", "a/y/three.ts", "b/z/four.ts", "b/w/five.ts"].map(file),
  edges: [
    { srcId: "a/x/one.ts", dstId: "a/x/two.ts", kind: "imports" },
    { srcId: "a/x/one.ts", dstId: "a/y/three.ts", kind: "imports" },
    { srcId: "a/x/two.ts", dstId: "b/z/four.ts", kind: "imports" },
    { srcId: "a/y/three.ts", dstId: "b/w/five.ts", kind: "imports" },
    { srcId: "pkg:a", dstId: "pkg:b", kind: "imports" },
    { srcId: "pkg:a/x", dstId: "pkg:a/y", kind: "imports" },
    { srcId: "pkg:a/x", dstId: "pkg:b/z", kind: "imports" },
    { srcId: "pkg:a/y", dstId: "pkg:b/w", kind: "imports" },
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

  it("returns a box for every group that contains its children's boxes", async () => {
    const layout = await computeCompoundLayout(withAggregates, null, bySubdir);
    const groups = new Map(layout.groups.map((g) => [g.id, g]));

    expect([...groups.keys()]).toEqual(["pkg:a", "pkg:a/x", "pkg:a/y", "pkg:b", "pkg:b/w", "pkg:b/z"]);
    for (const n of layout.nodes) {
      for (const gid of bySubdir(n)) expect(contains(groups.get(gid)!, n), `${gid} holds ${n.id}`).toBe(true);
    }
    for (const g of layout.groups) {
      const parent = groups.get(g.id.split("/")[0]!);
      if (parent !== groups.get(g.id)) expect(contains(parent!, g), `${parent!.id} holds ${g.id}`).toBe(true);
    }
  });

  it("routes an edge between groups from the source group's border to the target's", async () => {
    const layout = await computeCompoundLayout(withAggregates, null, bySubdir);
    const groups = new Map(layout.groups.map((g) => [g.id, g]));

    const aggregates = layout.edges.filter((e) => groups.has(e.srcId));
    expect(aggregates).toHaveLength(4);
    for (const e of aggregates) {
      const route = routeOf(e) ?? [];
      const label = `edge ${e.srcId}->${e.dstId}`;
      expect(route.length, `${label} routed`).toBeGreaterThanOrEqual(2);
      expect(pointOnBorder(route[0]!, groups.get(e.srcId)!), `${label} starts on its source`).toBe(true);
      expect(pointOnBorder(route.at(-1)!, groups.get(e.dstId)!), `${label} ends on its target`).toBe(true);
    }
  });

  it("still routes every file edge to its node borders alongside the group edges", async () => {
    const layout = await computeCompoundLayout(withAggregates, null, bySubdir);
    const groupIds = new Set(layout.groups.map((g) => g.id));

    expectRoutesOnNodeBorders({ ...layout, edges: layout.edges.filter((e) => !groupIds.has(e.srcId)) });
  });

  it("returns an empty layout for an empty graph", async () => {
    const layout = await computeCompoundLayout(
      { snapshotId: 1, nodes: [], edges: [] },
      null,
      byPackage,
    );
    expect(layout.nodes).toEqual([]);
    expect(layout.groups).toEqual([]);
  });
});
