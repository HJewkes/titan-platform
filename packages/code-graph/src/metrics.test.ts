import { describe, it, expect } from "vitest";
import { computeMetrics } from "./metrics.js";
import type { GraphEdge, GraphNode } from "./types.js";

function file(id: string): GraphNode {
  return { id, kind: "file", name: id };
}

function imports(srcId: string, dstId: string): GraphEdge {
  return { srcId, dstId, kind: "imports" };
}

function findMetric(
  metrics: ReturnType<typeof computeMetrics>,
  nodeId: string,
  name: string,
): number | null | undefined {
  return metrics.find((m) => m.nodeId === nodeId && m.name === name)?.value;
}

describe("computeMetrics", () => {
  it("emits fan_in=0 and fan_out=0 for an isolated node, and skips instability", () => {
    const metrics = computeMetrics([file("a")], []);
    expect(findMetric(metrics, "a", "fan_in")).toBe(0);
    expect(findMetric(metrics, "a", "fan_out")).toBe(0);
    expect(findMetric(metrics, "a", "instability")).toBeUndefined();
  });

  it("counts a→b as fan_out=1 on a, fan_in=1 on b", () => {
    const metrics = computeMetrics(
      [file("a"), file("b")],
      [imports("a", "b")],
    );
    expect(findMetric(metrics, "a", "fan_in")).toBe(0);
    expect(findMetric(metrics, "a", "fan_out")).toBe(1);
    expect(findMetric(metrics, "b", "fan_in")).toBe(1);
    expect(findMetric(metrics, "b", "fan_out")).toBe(0);
  });

  it("computes instability = fan_out / (fan_in + fan_out)", () => {
    const metrics = computeMetrics(
      [file("a"), file("b"), file("c")],
      [imports("a", "b"), imports("a", "c"), imports("c", "b")],
    );
    // a: fan_in=0, fan_out=2 → I = 2/2 = 1.0 (max unstable)
    expect(findMetric(metrics, "a", "instability")).toBe(1);
    // c: fan_in=1, fan_out=1 → I = 0.5
    expect(findMetric(metrics, "c", "instability")).toBe(0.5);
    // b: fan_in=2, fan_out=0 → I = 0 (max stable)
    expect(findMetric(metrics, "b", "instability")).toBe(0);
  });

  it("counts every edge regardless of kind", () => {
    const metrics = computeMetrics(
      [file("a"), file("b")],
      [
        { srcId: "a", dstId: "b", kind: "imports" },
        { srcId: "a", dstId: "b", kind: "re-exports" },
      ],
    );
    expect(findMetric(metrics, "a", "fan_out")).toBe(2);
    expect(findMetric(metrics, "b", "fan_in")).toBe(2);
  });

  it("ignores edges that reference nodes not in the node set", () => {
    const metrics = computeMetrics([file("a")], [imports("a", "phantom")]);
    expect(findMetric(metrics, "a", "fan_out")).toBe(1);
    expect(metrics.some((m) => m.nodeId === "phantom")).toBe(false);
  });

  it("utilization equals fan_in when edges are unweighted", () => {
    const metrics = computeMetrics(
      [file("a"), file("b"), file("c")],
      [imports("a", "c"), imports("b", "c")],
    );
    expect(findMetric(metrics, "c", "fan_in")).toBe(2);
    expect(findMetric(metrics, "c", "utilization")).toBe(2);
  });

  it("utilization sums inbound edge weights, so heavy use outranks bare imports", () => {
    const metrics = computeMetrics(
      [file("hot"), file("cold"), file("x"), file("y")],
      [
        { srcId: "x", dstId: "hot", kind: "imports", attrs: { weight: 30 } },
        { srcId: "y", dstId: "cold", kind: "imports", attrs: { weight: 1 } },
        { srcId: "x", dstId: "cold", kind: "imports", attrs: { weight: 1 } },
      ],
    );
    // hot: one importer using it 30× → utilization 30, fan_in 1
    expect(findMetric(metrics, "hot", "fan_in")).toBe(1);
    expect(findMetric(metrics, "hot", "utilization")).toBe(30);
    // cold: two importers naming it once each → utilization 2, fan_in 2
    expect(findMetric(metrics, "cold", "fan_in")).toBe(2);
    expect(findMetric(metrics, "cold", "utilization")).toBe(2);
  });

  it("credits utilization through a barrel to the real target, not the index hub", () => {
    const nodes: GraphNode[] = [
      { id: "f", kind: "file", name: "f" },
      { id: "index.ts", kind: "file", name: "index.ts", role: "barrel" },
      { id: "real.ts", kind: "file", name: "real.ts" },
    ];
    const metrics = computeMetrics(nodes, [
      { srcId: "f", dstId: "index.ts", kind: "imports", attrs: { weight: 12 } },
      { srcId: "index.ts", dstId: "real.ts", kind: "re-exports", attrs: { weight: 3 } },
    ]);
    // The barrel keeps its raw fan_in (f imports it) but utilization flows through.
    expect(findMetric(metrics, "index.ts", "fan_in")).toBe(1);
    expect(findMetric(metrics, "index.ts", "utilization")).toBe(0);
    expect(findMetric(metrics, "real.ts", "utilization")).toBe(12);
  });

  it("floors each inbound edge at weight 1 for missing/invalid weights", () => {
    const metrics = computeMetrics(
      [file("a"), file("b")],
      [{ srcId: "a", dstId: "b", kind: "imports", attrs: { weight: 0 } }],
    );
    expect(findMetric(metrics, "b", "utilization")).toBe(1);
  });

  it("accrues per-symbol utilization from inbound references edges (C-53)", () => {
    const nodes: GraphNode[] = [
      { id: "a.ts", kind: "file", name: "a.ts" },
      { id: "a.ts#hot", kind: "symbol", name: "hot", parentId: "a.ts" },
      { id: "a.ts#cold", kind: "symbol", name: "cold", parentId: "a.ts" },
      { id: "b.ts", kind: "file", name: "b.ts" },
      { id: "c.ts", kind: "file", name: "c.ts" },
    ];
    const metrics = computeMetrics(nodes, [
      { srcId: "b.ts", dstId: "a.ts#hot", kind: "references", attrs: { weight: 7 } },
      { srcId: "c.ts", dstId: "a.ts#hot", kind: "references", attrs: { weight: 3 } },
      { srcId: "b.ts", dstId: "a.ts#cold", kind: "references", attrs: { weight: 1 } },
    ]);
    // The heavily-referenced export outranks the barely-used one at symbol grain.
    expect(findMetric(metrics, "a.ts#hot", "utilization")).toBe(10);
    expect(findMetric(metrics, "a.ts#cold", "utilization")).toBe(1);
    // Symbols carry only utilization — not the module-structural degree metrics.
    expect(findMetric(metrics, "a.ts#hot", "fan_in")).toBeUndefined();
    expect(findMetric(metrics, "a.ts#hot", "fan_out")).toBeUndefined();
    // references edges must not inflate the referencing file's structural fan_out.
    expect(findMetric(metrics, "b.ts", "fan_out")).toBe(0);
  });

  it("tags fan_in/fan_out with unit='count' and instability with unit='ratio'", () => {
    const metrics = computeMetrics(
      [file("a"), file("b")],
      [imports("a", "b")],
    );
    const fanIn = metrics.find((m) => m.nodeId === "a" && m.name === "fan_in")!;
    const inst = metrics.find((m) => m.nodeId === "a" && m.name === "instability")!;
    expect(fanIn.unit).toBe("count");
    expect(inst.unit).toBe("ratio");
  });
});
