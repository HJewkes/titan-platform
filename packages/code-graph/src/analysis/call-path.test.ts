import { describe, expect, it } from "vitest";
import { openCodeGraph } from "../store.js";
import type { EdgeKind, GraphEdge } from "../types.js";
import { findCallPath, projectCallPath, snapshotCallPath, type LevelEdge } from "./call-path.js";

const edge = (srcId: string, dstId: string, kind: EdgeKind = "calls"): GraphEdge => ({ srcId, dstId, kind });
const levelEdge = (source: string, target: string): LevelEdge => ({ id: `${source}->${target}`, source, target });
const packageOfFile = (id: string): string => `pkg:${id.slice(0, id.indexOf("/"))}`;

// Two equally short routes from a to d; the id-larger one (via c) is listed first.
const DIAMOND = [edge("a", "c"), edge("c", "d"), edge("a", "b"), edge("b", "d")];

describe("findCallPath", () => {
  it("returns the id-smallest of two equally short paths whatever the edge order", () => {
    expect(findCallPath(DIAMOND, "a", "d")).toEqual(["a", "b", "d"]);
    expect(findCallPath([...DIAMOND].reverse(), "a", "d")).toEqual(["a", "b", "d"]);
  });

  it("prefers a shorter path over an id-smaller longer one", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "z"), edge("a", "y"), edge("y", "z")];
    expect(findCallPath(edges, "a", "z")).toEqual(["a", "y", "z"]);
  });

  it("follows only the requested edge kinds", () => {
    const edges = [edge("a", "b", "imports"), edge("b", "c")];
    expect(findCallPath(edges, "a", "c")).toBeNull();
    expect(findCallPath(edges, "a", "c", { kinds: ["calls", "imports"] })).toEqual(["a", "b", "c"]);
  });

  it("returns null when the target is unreachable and survives a cycle", () => {
    expect(findCallPath([edge("a", "b"), edge("b", "a")], "a", "z")).toBeNull();
  });
});

describe("snapshotCallPath", () => {
  it("finds the tie-broken path over a fixture store's call edges", () => {
    const store = openCodeGraph(":memory:");
    const snapshotId = store.createSnapshot({ ref: "fixture", indexVersion: "0.0.0" });
    store.insertNodes(snapshotId, ["a", "b", "c", "d"].map((id) => ({ id, kind: "symbol" as const, name: id })));
    store.insertEdges(snapshotId, DIAMOND);
    expect(snapshotCallPath(store, snapshotId, "a", "d")).toEqual(["a", "b", "d"]);
    store.close();
  });
});

describe("projectCallPath", () => {
  const levelOne = [levelEdge("pkg:web", "pkg:api"), levelEdge("pkg:api", "pkg:store")];

  it("projects a file-level path to package hops with consecutive duplicates folded", () => {
    const path = ["web/app.ts", "web/client.ts", "api/routes.ts", "api/handler.ts", "store/db.ts"];
    expect(projectCallPath(path, packageOfFile, levelOne)).toEqual([
      { from: "pkg:web", to: "pkg:api", edgeId: "pkg:web->pkg:api" },
      { from: "pkg:api", to: "pkg:store", edgeId: "pkg:api->pkg:store" },
    ]);
  });

  it("keeps a revisit as a round trip rather than folding it away", () => {
    const path = ["shepherd/run.ts", "reviewer/review.ts", "shepherd/verdict.ts"];
    const edges = [levelEdge("pkg:shepherd", "pkg:reviewer"), levelEdge("pkg:reviewer", "pkg:shepherd")];
    expect(projectCallPath(path, packageOfFile, edges)).toEqual([
      { from: "pkg:shepherd", to: "pkg:reviewer", edgeId: "pkg:shepherd->pkg:reviewer" },
      { from: "pkg:reviewer", to: "pkg:shepherd", edgeId: "pkg:reviewer->pkg:shepherd" },
    ]);
  });

  it("returns no hops for a path that stays inside one box", () => {
    expect(projectCallPath(["web/a.ts", "web/b.ts"], packageOfFile, levelOne)).toEqual([]);
  });

  it("throws when a projected hop has no level edge to ride", () => {
    expect(() => projectCallPath(["web/a.ts", "store/db.ts"], packageOfFile, levelOne)).toThrow(
      "no level edge pkg:web -> pkg:store",
    );
  });
});
