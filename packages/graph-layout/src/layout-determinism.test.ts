import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { GraphEdge, GraphNode } from "@titan-design/code-graph";
import { computeCompoundLayout } from "./compound-layout.js";
import { computeLayout } from "./layout.js";
import { routeOf } from "./route.js";
import type { CompoundLayoutResult, GraphInput, GroupOf, LayoutResult } from "./types.js";

function file(id: string): GraphNode {
  return { id, kind: "file", name: id.split("/").pop() ?? id };
}
function edge(srcId: string, dstId: string): GraphEdge {
  return { srcId, dstId, kind: "imports" };
}

// A fan-out whose layer order ELK can only settle by tie-breaking on input order.
const fanOut: GraphInput = {
  snapshotId: 1,
  nodes: ["a/hub.ts", "a/one.ts", "a/two.ts", "b/three.ts", "b/four.ts", "c/five.ts", "c/six.ts"].map(file),
  edges: [
    edge("a/hub.ts", "a/one.ts"),
    edge("a/hub.ts", "a/two.ts"),
    edge("a/hub.ts", "b/three.ts"),
    edge("a/hub.ts", "b/four.ts"),
    edge("a/hub.ts", "c/five.ts"),
    edge("b/three.ts", "c/six.ts"),
    edge("a/two.ts", "c/six.ts"),
  ],
};

const byPackage: GroupOf = (n) => [`pkg:${n.id.split("/")[0]}`];

// Fixed-seed shuffle (mulberry32), so a failure reproduces.
function shuffled<T>(items: T[], seed: number): T[] {
  let s = seed;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function reordered(input: GraphInput, seed: number): GraphInput {
  return { ...input, nodes: shuffled(input.nodes, seed), edges: shuffled(input.edges, seed + 1) };
}

// Keyed by id, so the comparison is about coordinates, not about the order the result lists them in.
function geometry(result: LayoutResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const n of result.nodes) out[n.id] = [n.x, n.y, n.width, n.height];
  for (const e of result.edges) out[`${e.srcId}->${e.dstId}`] = routeOf(e);
  return out;
}

// Every coordinate a map would store, nodes, group boxes and routes alike, as one digest.
function layoutSha(result: CompoundLayoutResult): string {
  const groups = result.groups.map((g) => [g.id, g.x, g.y, g.width, g.height]);
  const payload = JSON.stringify({ geometry: geometry(result), groups });
  return createHash("sha256").update(payload).digest("hex");
}

// The fan-out plus the package-level edges between its group boxes.
const fanOutWithAggregates: GraphInput = {
  ...fanOut,
  edges: [...fanOut.edges, edge("pkg:a", "pkg:b"), edge("pkg:a", "pkg:c"), edge("pkg:b", "pkg:c")],
};

const seeds = [1, 2, 3, 4, 5, 6, 7, 8];

describe("layout determinism", () => {
  it("gives the flat layout the same geometry for every input order", async () => {
    const baseline = geometry(await computeLayout(fanOut));
    for (const seed of seeds) {
      expect(geometry(await computeLayout(reordered(fanOut, seed))), `seed ${seed}`).toEqual(baseline);
    }
  });

  it("gives the compound layout the same geometry for every input order", async () => {
    const baseline = geometry(await computeCompoundLayout(fanOut, null, byPackage));
    for (const seed of seeds) {
      const result = await computeCompoundLayout(reordered(fanOut, seed), null, byPackage);
      expect(geometry(result), `seed ${seed}`).toEqual(baseline);
    }
  });

  it("gives the compound layout with group edges the same sha for every input order", async () => {
    const baseline = await computeCompoundLayout(fanOutWithAggregates, null, byPackage);
    expect(baseline.edges.filter((e) => routeOf(e)).length).toBe(fanOutWithAggregates.edges.length);
    for (const seed of seeds) {
      const result = await computeCompoundLayout(reordered(fanOutWithAggregates, seed), null, byPackage);
      expect(layoutSha(result), `seed ${seed}`).toBe(layoutSha(baseline));
    }
  });

  it("returns nodes and edges in id order whatever order they arrived in", async () => {
    const result = await computeLayout(reordered(fanOut, 3));
    const ids = result.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
    const pairs = result.edges.map((e) => `${e.srcId} ${e.dstId}`);
    expect(pairs).toEqual([...pairs].sort());
  });

  it("rounds every node centre and route point to 0.5 px", async () => {
    const result = await computeCompoundLayout(fanOut, null, byPackage);
    const onHalfGrid = (v: number): boolean => Number.isInteger(v * 2);
    for (const n of result.nodes) expect(onHalfGrid(n.x) && onHalfGrid(n.y), n.id).toBe(true);
    for (const e of result.edges) {
      const route = routeOf(e) ?? [];
      expect(route.length, `${e.srcId}->${e.dstId} routed`).toBeGreaterThan(0);
      expect(route.every((p) => onHalfGrid(p.x) && onHalfGrid(p.y)), `${e.srcId}->${e.dstId}`).toBe(true);
    }
  });
});
