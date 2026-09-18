import { describe, expect, it } from "vitest";
import { aggregateChurn, type ChurnEntry } from "./history/index.js";
import type { TestSourceLink } from "./analysis/test-linker.js";
import {
  churnMetrics,
  computeTestCoverageOwnership,
  ownershipMetrics,
  resolveChurnWindows,
} from "./history-metrics.js";
import type { GraphMetric } from "./types.js";

function entry(commit: string, author: string, filePath: string, lines: number): ChurnEntry {
  return { commit, author, epoch: 0, filePath, added: lines, deleted: 0 };
}

const valueOf = (metrics: GraphMetric[], id: string, name: string) =>
  metrics.find((m) => m.nodeId === id && m.name === name)?.value;

describe("churnMetrics", () => {
  it("uses the window in the metric name", () => {
    const m = churnMetrics(new Map([[7, aggregateChurn([entry("c1", "a", "a.ts", 2)])]]));
    expect(m.map((x) => x.name)).toEqual(["churn_7d", "churn_7d_commits", "churn_7d_authors"]);
  });
});

describe("ownershipMetrics", () => {
  it("suffixes lifetime ownership metrics with `lifetime`", () => {
    const m = ownershipMetrics(
      [entry("c1", "alice", "a.ts", 40), entry("c2", "bob", "a.ts", 40), entry("c3", "carol", "a.ts", 20)],
      "lifetime",
    );
    expect(valueOf(m, "a.ts", "bus_factor_lifetime")).toBe(2);
    expect(valueOf(m, "a.ts", "top_author_share_lifetime")).toBe(0.4);
    expect(valueOf(m, "a.ts", "bus_factor_30d")).toBeUndefined();
  });

  it("uses the configured window in metric names", () => {
    const m = ownershipMetrics([entry("c1", "alice", "a.ts", 10)], 90);
    expect(valueOf(m, "a.ts", "bus_factor_90d")).toBe(1);
    expect(valueOf(m, "a.ts", "top_author_share_90d")).toBe(1);
  });

  it("rounds top_author_share to 3 decimals", () => {
    const m = ownershipMetrics(
      [entry("c1", "alice", "a.ts", 1), entry("c2", "bob", "a.ts", 1), entry("c3", "carol", "a.ts", 1)],
      30,
    );
    expect(valueOf(m, "a.ts", "top_author_share_30d")).toBe(0.333);
  });
});

describe("resolveChurnWindows", () => {
  it("adds the primary window to the defaults, sorted, with lifetime last when requested", () => {
    expect(resolveChurnWindows(undefined, 7, false)).toEqual([7, 30, 90, 180]);
    expect(resolveChurnWindows([30], 30, true)).toEqual([30, "lifetime"]);
  });
});

function pathLink(testId: string, sourceId: string): TestSourceLink {
  return { testId, sourceId, method: "path" };
}

describe("computeTestCoverageOwnership", () => {
  it("keys test-coverage bus-factor on the source node", () => {
    // a.ts is production code; a.test.ts is its single-author test.
    const metrics = computeTestCoverageOwnership(
      [entry("c1", "alice", "a.test.ts", 30)],
      [pathLink("a.test.ts", "a.ts")],
    );
    expect(valueOf(metrics, "a.ts", "test_bus_factor_30d")).toBe(1);
    expect(valueOf(metrics, "a.ts", "test_top_author_share_30d")).toBe(1);
    // It does NOT key on the test file itself.
    expect(metrics.some((m) => m.nodeId === "a.test.ts")).toBe(false);
  });

  it("splits production-spread from test-silo for the same source", () => {
    // Production churn spread three ways (top author 0.4 < 0.5 → bus factor 2).
    // But the tests are alice-only — a single-author test silo despite the
    // well-spread prod code.
    const churn = [
      entry("p1", "alice", "svc.ts", 40),
      entry("p2", "bob", "svc.ts", 30),
      entry("p3", "carol", "svc.ts", 30),
      entry("t1", "alice", "svc.test.ts", 40),
    ];
    const prod = ownershipMetrics(churn, 30, new Set(["svc.ts"]));
    const cover = computeTestCoverageOwnership(churn, [pathLink("svc.test.ts", "svc.ts")]);
    expect(valueOf(prod, "svc.ts", "bus_factor_30d")).toBe(2);
    expect(valueOf(cover, "svc.ts", "test_bus_factor_30d")).toBe(1);
  });

  it("aggregates authorship across all tests linked to one source", () => {
    // Two test files cover svc.ts: alice owns one, bob the other → spread.
    const churn = [entry("t1", "alice", "svc.a.test.ts", 40), entry("t2", "bob", "svc.b.test.ts", 40)];
    const metrics = computeTestCoverageOwnership(
      churn,
      [pathLink("svc.a.test.ts", "svc.ts"), pathLink("svc.b.test.ts", "svc.ts")],
      { busFactorThreshold: 0.5 },
    );
    // alice 40, bob 40 → top author alone is 0.5 → bus factor 1 at threshold.
    expect(valueOf(metrics, "svc.ts", "test_top_author_share_30d")).toBe(0.5);
  });

  it("emits nothing for a source whose linked tests have no churn", () => {
    const metrics = computeTestCoverageOwnership(
      [entry("c1", "alice", "unrelated.ts", 10)],
      [pathLink("a.test.ts", "a.ts")],
    );
    expect(metrics).toEqual([]);
  });

  it("respects the configured windowDays in metric names", () => {
    const metrics = computeTestCoverageOwnership(
      [entry("c1", "alice", "a.test.ts", 10)],
      [pathLink("a.test.ts", "a.ts")],
      { windowDays: 90 },
    );
    expect(valueOf(metrics, "a.ts", "test_bus_factor_90d")).toBe(1);
  });
});
