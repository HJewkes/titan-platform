import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compilePatterns,
  computeDeepAst,
  computePartitionQuality,
  computeRecencyWindows,
  DEFAULT_CHURN_WINDOWS,
  invertBuckets,
  loadHistoryMetrics,
  matchesAny,
  openCodeGraph,
  patternToRegex,
  planPrune,
  resolveChurnWindows,
  resolveGitRef,
  runPrune,
  windowSuffix,
  type HistoryMetricsOptions,
  type LoadedHistory,
  type TopMetricRow,
} from "@titan-design/code-graph";
import { daysAgo, makeTestRepo, type TestRepo } from "./history/test-repo.js";

/**
 * The public surface the codewatch CLI consumes, exercised through the built package
 * root rather than through `src/`, so a name that is implemented but not exported fails
 * here instead of in the product repo.
 */

let repo: TestRepo;

beforeAll(async () => {
  repo = await makeTestRepo();
  await repo.write("src/a.ts", "export function run(n: number): string {\n  return `${n}`;\n}\n");
  repo.commit("init", { date: daysAgo(1) });
});

afterAll(async () => {
  await repo.cleanup();
});

describe("history adapter", () => {
  it("builds churn, ownership, and recency metrics from a git tree", () => {
    const options: HistoryMetricsOptions = { churnWindowDays: 30, churnWindows: [30] };
    const loaded: LoadedHistory | null = loadHistoryMetrics(
      [{ id: "src/a.ts", kind: "file", name: "a.ts" }],
      repo.dir,
      options,
    );
    expect(loaded?.metrics.map((m) => m.name)).toContain("churn_30d");
    expect(loaded?.primaryEntries.length).toBeGreaterThan(0);
  });

  it("names windows and default windows the way the metric catalogue reads them", () => {
    expect(windowSuffix(90)).toBe("90d");
    expect(windowSuffix("lifetime")).toBe("lifetime");
    expect(DEFAULT_CHURN_WINDOWS).toEqual([30, 90, 180]);
    expect(resolveChurnWindows([90], 30, true)).toEqual([30, 90, "lifetime"]);
  });

  it("computes recency windows from first-seen epochs", () => {
    const metrics = computeRecencyWindows(new Map([["src/a.ts", 0]]), new Map([[30, new Set(["src/a.ts"])]]), 86400);
    expect(metrics.map((m) => m.name).sort()).toEqual(["file_age_days", "recency_30d"]);
  });
});

describe("patterns and git refs", () => {
  it("compiles glob patterns and matches against them", () => {
    expect(patternToRegex("src/**/*.ts").test("src/a/b.ts")).toBe(true);
    expect(matchesAny("src/a.ts", compilePatterns(["src/**"]))).toBe(true);
  });

  it("resolves a git ref to a commit sha", () => {
    expect(resolveGitRef(repo.dir, "HEAD")).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("deep AST", () => {
  it("reads a symbol's params and return type from the working tree", () => {
    const deep = computeDeepAst({
      filePath: "src/a.ts",
      absPath: path.join(repo.dir, "src/a.ts"),
      symbolName: "run",
    });
    expect(deep?.params.map((p) => p.name)).toEqual(["n"]);
    expect(deep?.returnType).toBe("string");
  });
});

describe("partition quality", () => {
  it("scores a two-package partition and inverts the bucket map", () => {
    const fileByPackage = new Map([
      ["a", ["a/x.ts"]],
      ["b", ["b/y.ts"]],
    ]);
    const result = computePartitionQuality({
      packages: [{ id: "a" }, { id: "b" }],
      fileByPackage,
      nodes: [
        { id: "a/x.ts", kind: "file", name: "x.ts" },
        { id: "b/y.ts", kind: "file", name: "y.ts" },
      ],
      edges: [{ srcId: "a/x.ts", dstId: "b/y.ts", kind: "imports" }],
    });
    expect(result.pairCoupling.map((p) => `${p.from}->${p.to}`)).toEqual(["a->b"]);
    expect(invertBuckets(fileByPackage).get("a/x.ts")).toBe("a");
  });
});

describe("store reads and prune", () => {
  it("replaces metrics by name, lists names, and ranks nodes", () => {
    const store = openCodeGraph(":memory:");
    const snapshotId = store.createSnapshot({ ref: "head", indexVersion: "0.0.0" });
    store.insertNodes(snapshotId, [
      { id: "a.ts", kind: "file", name: "a.ts", role: "source" },
      { id: "b.ts", kind: "file", name: "b.ts", role: "source" },
    ]);
    store.insertMetrics(snapshotId, [{ nodeId: "a.ts", name: "loc", value: 1, unit: "lines" }]);
    store.replaceMetricsByName(snapshotId, "loc", [
      { nodeId: "a.ts", name: "loc", value: 10, unit: "lines" },
      { nodeId: "b.ts", name: "loc", value: 30, unit: "lines" },
    ]);
    expect(store.listMetricNames(snapshotId)).toEqual(["loc"]);
    const top: TopMetricRow[] = store.topByMetric({ snapshotId, metric: "loc", limit: 1, kind: "file" });
    expect(top).toEqual([{ nodeId: "b.ts", name: "b.ts", kind: "file", role: "source", value: 30, unit: "lines" }]);
    store.close();
  });

  it("plans and runs a prune over snapshots", () => {
    const store = openCodeGraph(":memory:");
    for (const ref of ["a", "b", "c"]) store.createSnapshot({ ref, indexVersion: "0.0.0" });
    expect(planPrune(store, { keep: 1 }).remove).toHaveLength(2);
    expect(runPrune(store, { keep: 1 }).rowsAfter.snapshot).toBe(1);
    store.close();
  });
});
