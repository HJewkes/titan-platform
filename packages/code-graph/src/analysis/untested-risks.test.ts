import { describe, it, expect } from "vitest";
import type { GraphMetric, GraphNode } from "../types.js";
import { buildReportContext } from "./graph-report-sections.js";
import { topUntestedRisks } from "./untested-risks.js";

const file = (id: string): GraphNode => ({ id, kind: "file", name: id });
const metric = (nodeId: string, name: string, value: number): GraphMetric => ({
  nodeId,
  name,
  value,
  unit: "count",
});

describe("topUntestedRisks (C-63)", () => {
  const nodes = [file("a.ts"), file("b.ts"), file("c.ts"), file("d.ts")];
  // Each hotspot = churn 10 × cognitive 5 × recency 1 = 50.
  const metrics: GraphMetric[] = [
    ...["a.ts", "b.ts", "c.ts", "d.ts"].flatMap((id) => [
      metric(id, "churn_30d", 10),
      metric(id, "cognitive_max", 5),
    ]),
    metric("a.ts", "coverage_pct", 0), // fully untested hotspot
    metric("b.ts", "coverage_pct", 100), // fully covered → excluded
    metric("c.ts", "coverage_pct", 50), // half covered
    // d.ts: no coverage_pct → excluded (never assumed)
  ];
  const ctx = () =>
    buildReportContext({ nodes, metrics, excluders: [], excludedRoles: new Set(), windowDays: 30 });

  it("ranks hotspot × (1 − coverage), dropping fully-covered and coverage-less files", () => {
    const rows = topUntestedRisks(ctx(), 10);
    expect(rows.map((r) => [r.nodeId, r.score])).toEqual([
      ["a.ts", 50], // 50 × (1 − 0)
      ["c.ts", 25], // 50 × (1 − 0.5)
    ]);
    // b.ts (100% covered) and d.ts (no coverage) are absent.
    expect(rows.map((r) => r.nodeId)).not.toContain("b.ts");
    expect(rows.map((r) => r.nodeId)).not.toContain("d.ts");
  });
});
