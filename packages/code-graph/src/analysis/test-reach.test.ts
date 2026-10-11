import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphMetric } from "../types.js";
import { computeTestKindMetrics } from "./test-kinds.js";
import { countShared, testsReaching } from "./test-reach.js";

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

describe("computeTestKindMetrics at scale", () => {
  it("counts 3k tests over a 20k-function call chain in well under the 19 s a closure per test took", () => {
    const graph = syntheticGraph(20_000, 3_000);

    const started = performance.now();
    const rows = computeTestKindMetrics(graph);
    const elapsed = performance.now() - started;

    const last = rows.find((r) => r.nodeId === "src/m.py#f19999" && r.name === "symbol_tests_exact_output");
    expect(last?.value).toBe(3_000);
    expect(rows.find((r) => r.nodeId === "src/m.py#f0" && r.name === "symbol_kind_pure")?.value).toBe(1);
    expect(elapsed).toBeLessThan(3_000);
  });
});
