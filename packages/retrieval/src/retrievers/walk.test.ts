import { EdgeTable, edgeTableDdl, openDatabase } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { expandGraph } from "./graph.js";
import { defaultHubDegree, walkGraph, type WalkGraph } from "./walk.js";

function adjacency(pairs: [string, string][]): WalkGraph {
  const links = new Map<string, string[]>();
  const link = (a: string, b: string) => links.set(a, [...(links.get(a) ?? []), b]);
  for (const [a, b] of pairs) {
    link(a, b);
    link(b, a);
  }
  return {
    neighbours: (id) => (links.get(id) ?? []).map((n) => ({ id: n, relation: "calls" })),
    degree: (id) => links.get(id)?.length ?? 0,
    degrees: () => [...links.values()].map((l) => l.length),
  };
}

/** A caller links to a hub; the hub links to the caller and `spokes` leaves, so its degree is spokes + 1. */
function star(spokes: number): [string, string][] {
  return [["caller", "hub"], ...Array.from({ length: spokes }, (_, i): [string, string] => ["hub", `leaf${i}`])];
}

const ids = (steps: { id: string }[]) => steps.map((s) => s.id);

describe("walkGraph hub cap", () => {
  it("returns a non-seed hub but never walks through it", () => {
    const steps = walkGraph(adjacency(star(59)), ["caller"], { hops: 2 });

    expect(steps).toEqual([{ id: "hub", hop: 1, via: "caller", relation: "calls" }]);
  });

  it("expands a hub that is itself a seed", () => {
    const steps = walkGraph(adjacency(star(59)), ["hub"], { hops: 1 });

    expect(ids(steps)).toEqual(["caller", ...Array.from({ length: 59 }, (_, i) => `leaf${i}`)]);
  });

  it("treats a node at exactly hubDegree as a hub and one below it as transit", () => {
    const graph = adjacency(star(9));

    expect(ids(walkGraph(graph, ["caller"], { hops: 2, hubDegree: 10 }))).toEqual(["hub"]);
    expect(walkGraph(graph, ["caller"], { hops: 2, hubDegree: 11 })).toHaveLength(10);
  });

  it("walks a 49-spoke hub (degree 50) only when the cap is lifted", () => {
    const graph = adjacency(star(49));

    expect(ids(walkGraph(graph, ["caller"], { hops: 2 }))).toEqual(["hub"]);
    expect(walkGraph(graph, ["caller"], { hops: 2, hubDegree: Infinity })).toHaveLength(50);
  });

  it("stops at maxNodes in hop then discovery order", () => {
    const steps = walkGraph(adjacency(star(5)), ["hub"], { maxNodes: 3 });

    expect(ids(steps)).toEqual(["caller", "leaf0", "leaf1"]);
    expect(walkGraph(adjacency(star(5)), ["hub"], { maxNodes: 0 })).toEqual([]);
  });
});

describe("defaultHubDegree", () => {
  it("floors at 50 for an empty or small graph", () => {
    expect(defaultHubDegree([])).toBe(50);
    expect(defaultHubDegree([1, 2, 3, 40])).toBe(50);
  });

  it("takes the p99 degree once it passes the floor", () => {
    const degrees = [...Array.from({ length: 98 }, () => 1), 80, 120];

    expect(defaultHubDegree(degrees)).toBe(120);
    expect(defaultHubDegree([...degrees, 1])).toBe(80);
  });
});

describe("expandGraph over the edge table", () => {
  function starEdges(spokes: number): EdgeTable {
    const db = openDatabase(":memory:");
    db.exec(edgeTableDdl());
    const edges = new EdgeTable(db);
    for (const [sourceRef, targetRef] of star(spokes)) edges.assert({ sourceRef, relation: "calls", targetRef });
    return edges;
  }

  it("stays uncapped without a hubDegree, as before the walk existed", () => {
    expect(expandGraph(starEdges(59), ["caller"], { hops: 2 })).toHaveLength(60);
  });

  it("caps the hub when asked, counting only the followed edges", () => {
    const edges = starEdges(59);

    expect(expandGraph(edges, ["caller"], { hops: 2, hubDegree: 60 }).map((h) => h.id)).toEqual(["hub"]);
    // Outbound only, the hub's edge from the caller no longer counts: degree 59, below the cap.
    expect(expandGraph(edges, ["caller"], { hops: 2, hubDegree: 60, direction: "out" })).toHaveLength(60);
  });
});
