import { describe, expect, it } from "vitest";
import { describeMetric } from "@titan-design/code-graph";
import { EXIT } from "@titan-design/rpc-protocol";
import { answer, file, memorySource, metric, snapshotInfo, symbol, type MemorySnapshot } from "./memory-source.js";
import { HIERARCHY_ROW_CAP } from "./query/contract-nodes.js";
import type { CommandResult } from "./query/contract.js";
import type { CatalogueEntry } from "./query/model.js";
import { createQueryResolver } from "./query/resolver.js";

type Hierarchy = CommandResult<"hierarchy.get">;
type NodeGet = CommandResult<"node.get">;

const SCORE: CatalogueEntry = {
  name: "score", unit: "ratio", appliesTo: ["file"], rollup: "mean", direction: "lower-worse",
  absent: "exclude", source: "coverage", description: "A mean-rolled test metric.",
};

const current: MemorySnapshot = {
  info: snapshotInfo(3, "main"),
  nodes: [
    file("src/a.ts"), file("src/b.ts"), file("src/bare.ts"), file("src/sub/c.ts"), file("src/sub/c.test.ts", "test"),
    symbol("src/sub/c.ts", "Klass", 1, 20), symbol("src/sub/c.ts", "method", 4, 8), symbol("src/sub/c.ts", "inner", 5, 6),
    symbol("src/a.ts", "outer", 1, 9), symbol("src/a.ts", "outer.<anonymous>.cb"), symbol("src/a.ts", "Config"), symbol("src/a.ts", "Config.defaults"),
    symbol("src/b.ts", "zeta", 1, 3), symbol("src/b.ts", "alpha", 5, 9),
  ],
  metrics: [
    metric("src/a.ts", "loc", 10), metric("src/b.ts", "loc", 4), metric("src/sub/c.ts", "loc", 30), metric("src/sub/c.test.ts", "loc", 7),
    metric("src/a.ts", "score", 0.2), metric("src/b.ts", "score", 0.6), metric("src/sub/c.ts", "score", 0.9),
    metric("src/a.ts", "cognitive_max", 5), metric("src/sub/c.ts", "cognitive_max", 12),
    metric("src/a.ts", "churn_30d_commits", 3),
  ],
  describe: (name) => (name === "score" ? SCORE : describeMetric(name)),
};
const prior: MemorySnapshot = { info: snapshotInfo(2, "feature", "0.13.0"), nodes: [file("src/a.ts")], metrics: [metric("src/a.ts", "loc", 8)] };
const oldest: MemorySnapshot = { info: snapshotInfo(1, "main"), nodes: [], metrics: [] };
const resolve = createQueryResolver(memorySource([current, prior, oldest]));
const get = answer(resolve);

const row = (result: Hierarchy, id: string) => result.nodes.find((n) => n.id === id)!;

describe("hierarchy.get over an in-memory model", () => {
  it("means a mean-rolled metric over the files that have it", () => {
    const result = get<Hierarchy>("hierarchy.get", { metrics: ["score"], depth: 3 });

    expect(row(result, "src/").values.score).toBeCloseTo((0.2 + 0.6 + 0.9) / 3);
    expect(row(result, "src/sub/").values.score).toBe(0.9);
  });

  it("reads a file with no metric rows as zero where absence means zero, and as unmeasured otherwise", () => {
    const result = get<Hierarchy>("hierarchy.get", { metrics: ["loc", "cognitive_max"] });

    expect(row(result, "src/bare.ts")).toMatchObject({ values: { loc: 0, cognitive_max: null }, missing: { cognitive_max: "not-measured" } });
    expect(row(result, "src/").values).toEqual({ loc: 51, cognitive_max: 12 });
  });

  it("says a metric is absent from the snapshot, or does not describe a symbol", () => {
    const result = get<Hierarchy>("hierarchy.get", { root: "src/a.ts", depth: 1, include_symbols: true, metrics: ["loc", "nonsense"] });

    expect(row(result, "src/a.ts#outer").missing).toEqual({ loc: "not-applicable", nonsense: "not-in-snapshot" });
  });

  it("drops excluded roles from the rows, the rollups, and the baseline", () => {
    const result = get<Hierarchy>("hierarchy.get", { depth: 3, exclude_roles: ["test"], baseline: 3 });

    expect(result.nodes.map((n) => n.id)).not.toContain("src/sub/c.test.ts");
    expect(row(result, "src/sub/")).toMatchObject({ values: { loc: 30 }, deltas: { loc: 0 } });
  });

  it("stops at files unless symbols are asked for", () => {
    const result = get<Hierarchy>("hierarchy.get", { depth: 8 });

    expect(result.nodes.filter((n) => n.kind === "symbol")).toEqual([]);
    expect(row(result, "src/b.ts").childCount).toBe(2);
  });

  it("hangs a bare-name symbol under the smallest span that encloses it", () => {
    const result = get<Hierarchy>("hierarchy.get", { depth: 8, include_symbols: true, metrics: [] });

    expect(row(result, "src/sub/c.ts#method").parentId).toBe("src/sub/c.ts#Klass");
    expect(row(result, "src/sub/c.ts#inner").parentId).toBe("src/sub/c.ts#method");
  });

  it("hangs a qualified symbol under its nearest existing scope, span or not", () => {
    const result = get<Hierarchy>("hierarchy.get", { depth: 8, include_symbols: true, metrics: [] });

    expect(row(result, "src/a.ts#Config.defaults").parentId).toBe("src/a.ts#Config");
    expect(row(result, "src/a.ts#outer.<anonymous>.cb").parentId).toBe("src/a.ts#outer");
  });

  it("orders symbols by line, not by name", () => {
    const result = get<Hierarchy>("hierarchy.get", { root: "src/b.ts", depth: 1, include_symbols: true, metrics: [] });

    expect(result.nodes.map((n) => n.id)).toEqual(["src/b.ts", "src/b.ts#zeta", "src/b.ts#alpha"]);
  });

  it("marks deltas against another index version as not comparable", () => {
    const result = get<Hierarchy>("hierarchy.get", { baseline: "feature", depth: 2 });

    expect(result).toMatchObject({ baselineSnapshotId: 2, comparable: false });
    expect(row(result, "src/a.ts").deltas).toEqual({ loc: 2 });
  });

  it("keeps the shallowest rows and says so when a directory is too big", () => {
    const files = Array.from({ length: HIERARCHY_ROW_CAP + 1000 }, (_, i) => file(`big/f${String(i).padStart(5, "0")}.ts`));
    const big = createQueryResolver(memorySource([{ info: snapshotInfo(1), nodes: files, metrics: [] }]));

    const result = answer(big)<Hierarchy>("hierarchy.get", { depth: 2 });

    expect(result.truncated).toBe(true);
    expect(result.nodes).toHaveLength(HIERARCHY_ROW_CAP);
    expect(result.nodes.slice(0, 3).map((n) => n.id)).toEqual(["", "big/", "big/f00000.ts"]);
    expect(JSON.stringify(result).length).toBeLessThan(2_000_000);
  });

  it("resolves a snapshot by digit string or ref, and answers NOINPUT for an unknown one or an unknown root", () => {
    expect(get<Hierarchy>("hierarchy.get", { snapshot: "2" }).snapshotId).toBe(2);
    expect(get<Hierarchy>("hierarchy.get", { snapshot: "feature" }).snapshotId).toBe(2);
    expect(get<Hierarchy>("hierarchy.get", { snapshot: "main" }).snapshotId).toBe(3);
    expect(resolve("hierarchy.get", { snapshot: "nope" })).toMatchObject({ ok: false, code: EXIT.NOINPUT });
    expect(resolve("hierarchy.get", { root: "src" })).toMatchObject({ ok: false, code: EXIT.NOINPUT, error: 'No node "src" in snapshot 3' });
  });
});

describe("node.get over an in-memory model", () => {
  it("rolls a symbol-only metric into its file and ranks it among files", () => {
    const withSymbols: MemorySnapshot = {
      info: snapshotInfo(1),
      nodes: [file("a.ts"), file("b.ts"), symbol("a.ts", "f", 1, 3), symbol("a.ts", "g", 4, 9), symbol("b.ts", "h", 1, 2)],
      metrics: [metric("a.ts#f", "symbol_cognitive", 2), metric("a.ts#g", "symbol_cognitive", 7), metric("b.ts#h", "symbol_cognitive", 1)],
    };
    const result = answer(createQueryResolver(memorySource([withSymbols])))<NodeGet>("node.get", { id: "a.ts" });

    expect(result.metrics).toEqual([
      { name: "symbol_cognitive", unit: "count", direction: "higher-worse", rollup: "max", value: 7, percentile: 100, siblingMedian: 4, siblingRank: 1, siblingCount: 2 },
    ]);
    expect(result.childCounts).toEqual({ symbol: 2 });
  });

  it("serves the repo root under the empty id", () => {
    const result = get<NodeGet>("node.get", { id: "", metrics: ["loc"] });

    expect(result).toMatchObject({ node: { id: "", kind: "repo" }, ancestors: [], childCounts: { directory: 1 } });
    expect(result.metrics[0]).toMatchObject({ value: 51, percentile: 100, siblingCount: 1 });
  });
});
