import { describe, expect, it } from "vitest";
import { aggregateChurn, type ChurnEntry } from "./history/index.js";
import { churnMetrics, ownershipMetrics, resolveChurnWindows } from "./history-metrics.js";
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
