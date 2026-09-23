import { describe, expect, it } from "vitest";
import { openCodeGraph } from "../store.js";
import type { GraphMetric, GraphNode } from "../types.js";
import { runChecks } from "./check.js";
import { percentileOf } from "./outlier-rule.js";
import type { MetricOutlierRule } from "./types.js";

function symbol(i: number): GraphNode {
  return { id: `src/a.py#f${i}`, kind: "symbol", name: `f${i}`, parentId: "src/a.py", attrs: { startLine: i, endLine: i } };
}

/** Twenty symbols valued 1..20, plus a file carrying the same metric name that the rule must ignore. */
function snapshot(values: readonly number[]): { nodes: GraphNode[]; metrics: GraphMetric[] } {
  const nodes: GraphNode[] = [{ id: "src/a.py", kind: "file", name: "a.py" }];
  const metrics: GraphMetric[] = [{ nodeId: "src/a.py", name: "symbol_loc", value: 10_000 }];
  values.forEach((value, i) => {
    nodes.push(symbol(i));
    metrics.push({ nodeId: `src/a.py#f${i}`, name: "symbol_loc", value });
  });
  return { nodes, metrics };
}

function check(rule: MetricOutlierRule, values: readonly number[]) {
  const store = openCodeGraph(":memory:");
  const snapshotId = store.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
  const { nodes, metrics } = snapshot(values);
  store.insertNodes(snapshotId, nodes);
  store.insertMetrics(snapshotId, metrics);
  const result = runChecks(store, { snapshotId, rules: [rule] });
  store.close();
  return result.violations;
}

const ONE_TO_TWENTY = Array.from({ length: 20 }, (_, i) => i + 1);
const RULE: MetricOutlierRule = { type: "metric-outlier", id: "long-fn", metric: "symbol_loc", kind: "symbol", percentile: 90 };

describe("percentileOf", () => {
  it("interpolates linearly between the closest ranks", () => {
    expect(percentileOf([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentileOf(ONE_TO_TWENTY, 90)).toBeCloseTo(18.1);
    expect(percentileOf([7, 3], 100)).toBe(7);
    expect(percentileOf([5], 90)).toBe(5);
  });
});

describe("metric-outlier rule (TP-322)", () => {
  it("flags exactly the nodes of the kind strictly above the percentile, with value and threshold", () => {
    const violations = check(RULE, ONE_TO_TWENTY);

    expect(violations.map((v) => [v.nodeId, v.value])).toEqual([
      ["src/a.py#f18", 19],
      ["src/a.py#f19", 20],
    ]);
    expect(violations[0]!.threshold).toBeCloseTo(18.1);
    expect(violations[0]).toMatchObject({ ruleId: "long-fn", severity: "error", metric: "symbol_loc", path: "src/a.py", symbol: "f18" });
    expect(violations[0]!.evidence).toBe("symbol_loc=19 (p90 18.1)");
  });

  it("stays silent below the default minimum sample of 20", () => {
    expect(check(RULE, ONE_TO_TWENTY.slice(1))).toEqual([]);
  });

  it("honours a smaller minSample", () => {
    expect(check({ ...RULE, minSample: 5 }, [1, 1, 1, 1, 9]).map((v) => v.nodeId)).toEqual(["src/a.py#f4"]);
  });

  it("flags nothing at the 100th percentile or when every value ties", () => {
    expect(check({ ...RULE, percentile: 100 }, ONE_TO_TWENTY)).toEqual([]);
    expect(check(RULE, Array.from({ length: 25 }, () => 3))).toEqual([]);
  });

  it("draws the population and the flagged nodes from the rule's kind only", () => {
    const store = openCodeGraph(":memory:");
    const snapshotId = store.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
    const files: GraphNode[] = ONE_TO_TWENTY.map((i) => ({ id: `src/f${i}.ts`, kind: "file", name: `f${i}.ts` }));
    store.insertNodes(snapshotId, [...files, { id: "pkg", kind: "module", name: "pkg" }]);
    store.insertMetrics(snapshotId, [
      ...ONE_TO_TWENTY.map((i) => ({ nodeId: `src/f${i}.ts`, name: "fan_out", value: i })),
      { nodeId: "pkg", name: "fan_out", value: 500 },
    ]);
    const rule: MetricOutlierRule = { ...RULE, metric: "fan_out", kind: "file" };

    const { violations } = runChecks(store, { snapshotId, rules: [rule] });
    store.close();

    expect(violations.map((v) => v.nodeId)).toEqual(["src/f19.ts", "src/f20.ts"]);
  });

  it("uses the rule's severity", () => {
    expect(check({ ...RULE, severity: "warning" }, ONE_TO_TWENTY)[0]!.severity).toBe("warning");
  });
});
