import { describe, expect, it } from "vitest";
import { answer, edge, file, memorySource, metric, snapshotInfo, symbol, type MemorySnapshot } from "./memory-source.js";
import type { CommandResult } from "./query/contract.js";
import { createQueryResolver } from "./query/resolver.js";

type NodeGet = CommandResult<"node.get">;

const ALL_LENSES = ["exports", "score", "centrality", "coupling", "tests"];

// b and c import a; c imports b; the test and the generated client import a; lonely.ts imports nothing and nothing imports it.
const SNAPSHOT: MemorySnapshot = {
  info: snapshotInfo(1),
  nodes: [
    file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/lonely.ts"), file("src/a.test.ts", "test"), file("src/client.gen.ts", "generated"),
    symbol("src/a.ts", "grade"), { ...symbol("src/a.ts", "helper"), attrs: { exported: false } },
  ],
  edges: [
    edge("src/b.ts", "src/a.ts"), edge("src/c.ts", "src/a.ts"), edge("src/c.ts", "src/b.ts"),
    edge("src/a.test.ts", "src/a.ts"), edge("src/client.gen.ts", "src/a.ts"),
    edge("src/b.ts", "src/a.ts#grade", "references"), edge("src/c.ts", "src/a.ts#grade", "references"),
  ],
  metrics: [
    metric("src/a.ts", "churn_30d", 10), metric("src/a.ts", "cognitive_max", 7),
    metric("src/b.ts", "churn_30d", 4), metric("src/b.ts", "cognitive_max", 5),
    metric("src/a.ts#grade", "utilization", 2), metric("src/a.ts#grade", "symbol_cognitive", 7),
    metric("src/a.ts#helper", "utilization", 0), metric("src/a.ts#helper", "symbol_cognitive", 3),
    metric("src/a.ts", "linked_test_count", 1),
  ],
};

const get = answer(createQueryResolver(memorySource([SNAPSHOT])));
const node = (args: object): NodeGet => get<NodeGet>("node.get", args);
const lens = <K extends keyof NonNullable<NodeGet["lenses"]>>(id: string, name: K, args: object = {}) =>
  node({ id, lenses: [name], ...args }).lenses![name];

describe("node.get lenses", () => {
  it("returns exactly the plain node.get result when no lens is asked for", () => {
    const plain = node({ id: "src/a.ts" });
    const { lenses, ...withoutLenses } = node({ id: "src/a.ts", lenses: ALL_LENSES });

    expect(Object.keys(plain)).toEqual(["snapshotId", "node", "ancestors", "childCounts", "metrics"]);
    expect(node({ id: "src/a.ts", lenses: [] })).toEqual(plain);
    expect(withoutLenses).toEqual(plain);
    expect(Object.keys(lenses!)).toEqual(ALL_LENSES);
  });

  it("lists a file's exports and internal helpers with utilization, consumers, and their own complexity", () => {
    expect(lens("src/a.ts", "exports")).toEqual([
      { name: "grade", utilization: 2, cognitive: 7, consumers: 2, exported: true },
      { name: "helper", utilization: 0, cognitive: 3, consumers: 0, exported: false },
    ]);
  });

  it("breaks a file's hotspot score into its factors and ranks it among scored files", () => {
    expect(lens("src/a.ts", "score")).toEqual({ grain: "file", window: "30d", score: 70, churn: 10, complexity: 7, recency: 1, rank: 1, ranked: 2 });
    expect(lens("src/c.ts", "score")).toEqual({ grain: "file", window: "30d", score: 0, rank: null, ranked: 2 });
    expect(lens("src/a.ts", "score", { window: "90d" })).toMatchObject({ score: 0, rank: null, ranked: 0 });
  });

  it("scores a symbol at the symbol grain, with its utilization", () => {
    expect(lens("src/a.ts#grade", "score")).toEqual({
      grain: "symbol", window: "30d", score: 140, churn: 10, complexity: 7, recency: 1, utilization: 2, rank: 1, ranked: 1,
    });
  });

  it("ranks every file by centrality, down to the last one, and leaves out generated code", () => {
    const of = 5;

    expect(lens("src/a.ts", "centrality")).toMatchObject({ rank: 1, of });
    const last = lens("src/lonely.ts", "centrality")!;
    expect(last).toMatchObject({ rank: of, of });
    expect(last.score).toBeGreaterThan(0);
    expect(lens("src/client.gen.ts", "centrality")).toEqual({ score: null, rank: null, of });
  });

  it("reports coupled partners as not measured rather than inventing any", () => {
    expect(lens("src/a.ts", "coupling")).toEqual({ measured: false, partners: [] });
  });

  it("links tests by path convention and carries the indexer's count", () => {
    expect(lens("src/a.ts", "tests")).toEqual({
      tests: [{ id: "src/a.test.ts", kind: "file", name: "a.test.ts", path: "src/a.test.ts" }],
      indexedCount: 1,
      coEditMeasured: false,
    });
    expect(lens("src/b.ts", "tests")).toEqual({ tests: [], indexedCount: 0, coEditMeasured: false });
  });

  it("answers null for a lens that does not describe the node's kind", () => {
    const onSymbol = node({ id: "src/a.ts#grade", lenses: ALL_LENSES }).lenses!;
    const onDirectory = node({ id: "src/", lenses: ALL_LENSES }).lenses!;

    expect(Object.entries(onSymbol).filter(([, v]) => v !== null).map(([k]) => k)).toEqual(["score"]);
    expect(Object.values(onDirectory).every((v) => v === null)).toBe(true);
  });
});
