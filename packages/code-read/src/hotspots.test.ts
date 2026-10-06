import { describe, expect, it } from "vitest";
import { EXIT } from "@titan-design/rpc-protocol";
import { answer, file, memorySource, metric, snapshotInfo, symbol, type MemorySnapshot } from "./memory-source.js";
import type { CommandResult } from "./query/contract.js";
import type { ModelMetric, ModelNode } from "./query/model.js";
import { createQueryResolver } from "./query/resolver.js";

type List = CommandResult<"hotspots.list">;

const withUtil = (node: ModelNode, utilization: number, cognitive?: number): ModelMetric[] => [
  metric(node.id, "utilization", utilization),
  ...(cognitive === undefined ? [] : [metric(node.id, "symbol_cognitive", cognitive)]),
];

/** churn_30d, cognitive_max, and an optional recency_30d for one file. */
const hot = (id: string, churn: number, cognitive: number, recency?: number): ModelMetric[] => [
  metric(id, "churn_30d", churn),
  metric(id, "cognitive_max", cognitive),
  ...(recency === undefined ? [] : [metric(id, "recency_30d", recency)]),
];

const RUN = symbol("src/a.ts", "run");
const HELPER = symbol("src/a.ts", "helper");
const GO = symbol("src/b.ts", "go");
const GEN_SYMBOL = symbol("src/client.gen.ts", "call");
const NODES = [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/client.gen.ts", "generated"), RUN, HELPER, GO, GEN_SYMBOL];

// a: 10 × 5 × 1 = 50; b: 4 × 5 × 0.5 = 10; c: 3 × 2, no recency row so no discount, = 6. The generated file is left out.
const CURRENT: MemorySnapshot = {
  info: snapshotInfo(2),
  nodes: NODES,
  metrics: [
    ...hot("src/a.ts", 10, 5, 1),
    ...hot("src/b.ts", 4, 5, 0.5),
    ...hot("src/c.ts", 3, 2),
    ...hot("src/client.gen.ts", 100, 100),
    metric("src/a.ts", "churn_90d", 20),
    ...withUtil(RUN, 3, 4),
    ...withUtil(HELPER, 0, 9),
    ...withUtil(GO, 2),
    ...withUtil(GEN_SYMBOL, 5, 5),
  ],
};

// a scores the same 50, b scored 2 × 5 × 0.5 = 5, and c had no churn.
const BASELINE: MemorySnapshot = {
  info: snapshotInfo(1),
  nodes: NODES,
  metrics: [...hot("src/a.ts", 10, 5, 1), ...hot("src/b.ts", 2, 5, 0.5), metric("src/c.ts", "cognitive_max", 2)],
};

const resolve = createQueryResolver(memorySource([CURRENT, BASELINE]));
const list = (args: object): List => answer(resolve)<List>("hotspots.list", args);
const scores = (result: List): [string, number][] => result.rows.map((r) => [r.node.id, r.score]);

describe("hotspots.list at file grain", () => {
  it("ranks files by churn × complexity × recency and leaves out generated files", () => {
    const result = list({});

    expect(result.rows.map((r) => [r.node.id, r.churn, r.complexity, r.recency, r.score])).toEqual([
      ["src/a.ts", 10, 5, 1, 50],
      ["src/b.ts", 4, 5, 0.5, 10],
      ["src/c.ts", 3, 2, 1, 6],
    ]);
    expect(result.total).toBe(3);
  });

  it("keeps only rows scoring at least the cutoff, and counts only those", () => {
    const result = list({ cutoff: 10 });

    expect(scores(result)).toEqual([["src/a.ts", 50], ["src/b.ts", 10]]);
    expect(result.total).toBe(2);
  });

  it("pages with offset and limit while total counts every row", () => {
    expect(scores(list({ offset: 1, limit: 1 }))).toEqual([["src/b.ts", 10]]);
    expect(list({ limit: 0 })).toMatchObject({ rows: [], total: 3 });
  });

  it("reads churn from the window asked for", () => {
    expect(scores(list({ window: "90d" }))).toEqual([["src/a.ts", 100]]);
  });

  it("marks a row new or worsened against a baseline, and an unchanged one not at all", () => {
    const result = list({ baseline: 1 });

    expect(result).toMatchObject({ baselineSnapshotId: 1, comparable: true });
    expect(result.rows.map((r) => [r.node.id, r.baselineScore, r.mark])).toEqual([
      ["src/a.ts", 50, undefined],
      ["src/b.ts", 5, "worsened"],
      ["src/c.ts", null, "new"],
    ]);
  });

  it("leaves baseline fields off every row without a baseline", () => {
    expect(list({}).rows.every((r) => !("mark" in r) && !("baselineScore" in r))).toBe(true);
  });
});

describe("hotspots.list at symbol grain", () => {
  it("ranks symbols by utilization × complexity × file churn, falling back to the file's complexity", () => {
    const result = list({ grain: "symbol" });

    expect(result.rows.map((r) => [r.node.id, r.utilization, r.complexity, r.churn, r.score])).toEqual([
      ["src/a.ts#run", 3, 4, 10, 120],
      ["src/b.ts#go", 2, 5, 4, 40],
    ]);
    expect(result.rows.every((r) => r.recency === 1)).toBe(true);
  });
});

describe("hotspots.list arguments", () => {
  it("rejects a window not named as metrics name it", () => {
    expect(resolve("hotspots.list", { window: "30" })).toMatchObject({ ok: false, code: EXIT.DATAERR });
  });
});
