import { countCalls } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphMetric, GraphNode } from "../types.js";
import { computeTestKindMetrics } from "./test-kinds.js";
import { countShared, fileTestReach, testsReaching, testsReachingMasked } from "./test-reach.js";

const ones = (n: number): Uint32Array => {
  const mask = new Uint32Array(Math.ceil(n / 32));
  for (let i = 0; i < n; i++) mask[i >>> 5]! |= 1 << (i & 31);
  return mask;
};

describe("testsReaching", () => {
  it("credits each test only to what its calls reach", () => {
    const callees = new Map([
      ["t1", ["a"]],
      ["t2", ["b"]],
      ["a", ["c"]],
    ]);

    const reaching = testsReaching(callees, ["t1", "t2"]);

    expect(countShared(reaching.get("c")!, ones(2))).toBe(1);
    expect(countShared(reaching.get("b")!, ones(2))).toBe(1);
    expect(reaching.has("d")).toBe(false);
  });

  it("lets every member of a call cycle see the tests that reach any member", () => {
    const callees = new Map([
      ["t1", ["a"]],
      ["t2", ["b"]],
      ["a", ["b"]],
      ["b", ["a", "c"]],
    ]);

    const reaching = testsReaching(callees, ["t1", "t2"]);

    for (const id of ["a", "b", "c"]) expect(countShared(reaching.get(id)!, ones(2)), id).toBe(2);
  });
});

const testFile = (id: string): GraphNode => ({ id, kind: "file", name: id, role: "test" });
const hop = (srcId: string, dstId: string, kind: GraphEdge["kind"] = "imports"): GraphEdge => ({ srcId, dstId, kind });
const reachCount = (reach: { reaching: Map<string, Uint32Array>; tests: string[] }, id: string): number =>
  reach.reaching.has(id) ? countShared(reach.reaching.get(id)!, ones(reach.tests.length)) : 0;

describe("fileTestReach", () => {
  it("leaves a module only imported through a vi.mock'd specifier unreached", () => {
    const edges = [hop("feed.test.ts", "feed.ts"), hop("feed.ts", "store.ts"), hop("store.ts", "disk.ts"), hop("feed.test.ts", "store.ts", "mocks")];

    const reach = fileTestReach([testFile("feed.test.ts")], edges);

    expect(reachCount(reach, "feed.ts")).toBe(1);
    expect(reachCount(reach, "store.ts")).toBe(0);
    expect(reachCount(reach, "disk.ts")).toBe(0);
    expect(reach.unmasked).toEqual([]);
  });

  it("still reaches a mocked module through another test's real import", () => {
    const edges = [hop("feed.test.ts", "feed.ts"), hop("feed.ts", "store.ts"), hop("feed.test.ts", "store.ts", "mocks"), hop("store.test.ts", "store.ts")];

    const reach = fileTestReach([testFile("feed.test.ts"), testFile("store.test.ts")], edges);

    expect(reachCount(reach, "store.ts")).toBe(1);
    expect(reachCount(reach, "feed.ts")).toBe(1);
  });

  it("keeps a module a test both mocks and loads through require() reached", () => {
    const required: GraphEdge = { srcId: "legacy.ts", dstId: "store.ts", kind: "imports", attrs: { require: true } };
    const edges = [hop("feed.test.ts", "legacy.ts"), required, hop("feed.test.ts", "store.ts", "mocks")];

    const reach = fileTestReach([testFile("feed.test.ts")], edges);

    expect(reachCount(reach, "store.ts")).toBe(1);
  });

  it("falls back to unmasked reach for a file over the mock cap, saying why", () => {
    const edges = [hop("feed.test.ts", "feed.ts"), hop("feed.ts", "store.ts"), hop("feed.test.ts", "store.ts", "mocks"), hop("feed.test.ts", "clock.ts", "mocks")];

    const reach = fileTestReach([testFile("feed.test.ts")], edges, 1);

    expect(reachCount(reach, "store.ts")).toBe(1);
    expect(reach.unmasked).toEqual([{ testId: "feed.test.ts", mocks: 2, reason: "2 mocks exceed the cap of 1; masking is off" }]);
  });
});

describe("testsReachingMasked", () => {
  it("keeps a require() of a mocked path reached", () => {
    const callees = new Map([["t1", ["legacy", "feed"]], ["legacy", ["store"]], ["feed", ["store"]]]);

    const { reaching } = testsReachingMasked(callees, ["t1"], { mocked: new Map([["t1", ["store"]]]), requires: new Map([["legacy", new Set(["store"])]]) });

    expect(countShared(reaching.get("store")!, ones(1))).toBe(1);
  });

  it("masks one test's bit without touching the bits other tests flow into the same cycle", () => {
    const callees = new Map([["t1", ["a"]], ["t2", ["a"]], ["a", ["b"]], ["b", ["a", "m"]]]);

    const { reaching } = testsReachingMasked(callees, ["t1", "t2"], { mocked: new Map([["t2", ["m"]]]) });

    expect(countShared(reaching.get("m")!, ones(2))).toBe(1);
    for (const id of ["a", "b"]) expect(countShared(reaching.get(id)!, ones(2)), id).toBe(2);
  });
});

/** `functions` source functions in one call chain, and `tests` tests each calling into it at a different point. */
function syntheticGraph(functions: number, tests: number): { edges: GraphEdge[]; sourceMetrics: GraphMetric[] } {
  const fn = (i: number) => `src/m.py#f${i}`;
  const test = (i: number) => `tests/test_m.py#test_${i}`;
  const edges: GraphEdge[] = [];
  const sourceMetrics: GraphMetric[] = [];
  for (let i = 0; i < functions; i++) {
    if (i + 1 < functions) edges.push({ srcId: fn(i), dstId: fn(i + 1), kind: "calls", attrs: { sites: [{ args: [] }] } });
    for (const name of ["symbol_kind_parser", "symbol_kind_io", "symbol_output_signal", "symbol_state_writes"]) {
      sourceMetrics.push({ nodeId: fn(i), name, value: 0, unit: "count" });
    }
    sourceMetrics.push({ nodeId: fn(i), name: "symbol_unlisted_calls", value: i + 1 < functions ? 1 : 0, unit: "count" });
  }
  for (let t = 0; t < tests; t++) {
    edges.push({ srcId: test(t), dstId: fn((t * 7) % functions), kind: "calls", attrs: { sites: [{ args: [] }] } });
    sourceMetrics.push({ nodeId: test(t), name: "test_kind_exact_output", value: 1, unit: "count" });
    sourceMetrics.push({ nodeId: test(t), name: "test_kind_snapshot", value: 0, unit: "count" });
  }
  return { edges, sourceMetrics };
}

/**
 * Each `for...of` over an array and each map lookup: one pass over the graph makes them per node and edge (TP-4262).
 * This row took 727 012; flowing the bits once per test, as a closure per test did, takes about a hundred times that.
 */
const REACH_WORK = [[Array.prototype, Symbol.iterator], [Map.prototype, "get"]] as const;
const REACH_CALLS = 1_500_000;

describe("computeTestKindMetrics at scale", () => {
  it("counts 3k tests over a 20k-function call chain in one pass, not one closure per test", () => {
    const graph = syntheticGraph(20_000, 3_000);

    let rows: GraphMetric[] = [];
    const work = countCalls(REACH_WORK, () => (rows = computeTestKindMetrics(graph)), REACH_CALLS);

    expect(work).toBeLessThanOrEqual(REACH_CALLS);
    const last = rows.find((r) => r.nodeId === "src/m.py#f19999" && r.name === "symbol_tests_exact_output");
    expect(last?.value).toBe(3_000);
    expect(rows.find((r) => r.nodeId === "src/m.py#f0" && r.name === "symbol_kind_pure")?.value).toBe(1);
  });
});
