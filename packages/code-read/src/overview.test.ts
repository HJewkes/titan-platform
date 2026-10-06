import { describe, expect, it } from "vitest";
import { answer, edge, file, memorySource, metric, snapshotInfo, type MemorySnapshot } from "./memory-source.js";
import type { CommandResult } from "./query/contract.js";
import type { ModelFinding, ModelMetric } from "./query/model.js";
import { createQueryResolver } from "./query/resolver.js";

type Overview = CommandResult<"overview.get">;

const hot = (id: string, churn: number, cognitive: number, recency = 1): ModelMetric[] => [
  metric(id, "churn_30d", churn),
  metric(id, "cognitive_max", cognitive),
  metric(id, "recency_30d", recency),
];

const finding = (id: string, rule: string, nodeId: string): ModelFinding => ({ id, rule, severity: "warning", nodeId, message: rule });

// Scores: c 3 × 40 = 120, a 10 × 5 = 50, b 4 × 5 × 0.5 = 10. Both b and c import a, and c imports b.
const CURRENT: MemorySnapshot = {
  info: snapshotInfo(2),
  nodes: [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/client.gen.ts", "generated")],
  edges: [edge("src/b.ts", "src/a.ts"), edge("src/c.ts", "src/a.ts"), edge("src/c.ts", "src/b.ts"), edge("src/client.gen.ts", "src/a.ts")],
  metrics: [...hot("src/a.ts", 10, 5), ...hot("src/b.ts", 4, 5, 0.5), ...hot("src/c.ts", 3, 40), ...hot("src/client.gen.ts", 99, 99), metric("src/a.ts", "bus_factor_30d", 1)],
  findings: [finding("f-b", "max-loc", "src/b.ts"), finding("f-c", "hotspot", "src/c.ts")],
};

// b's finding carries over, c's is new, and a's is resolved by the current snapshot.
const BASELINE: MemorySnapshot = { ...CURRENT, info: snapshotInfo(1), findings: [finding("f-b", "max-loc", "src/b.ts"), finding("f-a", "max-loc", "src/a.ts")] };

const resolve = createQueryResolver(memorySource([CURRENT, BASELINE]));
const overview = (args: object): Overview => answer(resolve)<Overview>("overview.get", { cutoff: 100, ...args });
const penalties = (result: Overview): [string, number, boolean][] => result.signals.map((s) => [s.key, s.penalty, s.measured]);

describe("overview.get", () => {
  it("reports KPIs over files with churn, leaving out generated files", () => {
    expect(overview({}).kpis).toEqual({ hotspotsOverCutoff: 1, maxComplexity: 40, knowledgeSilos: 1, findings: { open: 2 } });
  });

  it("weighs each attention signal with the default weights, and marks hidden coupling unmeasured", () => {
    expect(penalties(overview({}))).toEqual([
      ["hotspots", 10, true],
      ["findings", 6, true],
      ["complexity", 10, true],
      ["hidden-coupling", 0, false],
    ]);
  });

  it("applies caller-supplied weights, filling the rest from the defaults", () => {
    const result = overview({ weights: { hotspots: { each: 1 }, findings: { each_carry: 50 }, complexity: { budget: 35 } } });

    expect(result.signals.map((s) => [s.key, s.penalty, s.cap])).toEqual([
      ["hotspots", 1, 30],
      ["findings", 20, 20],
      ["complexity", 5, 15],
      ["hidden-coupling", 0, 10],
    ]);
  });

  it("leaves excluded rules out of the findings signal but not the KPI", () => {
    const result = overview({ exclude_rules: ["hotspot"] });

    expect(result.signals.find((s) => s.key === "findings")!.penalty).toBe(3);
    expect(result.kpis.findings.open).toBe(2);
  });

  it("counts findings new, carried over, and resolved against a baseline", () => {
    const result = overview({ baseline: 1 });

    expect(result).toMatchObject({ baselineSnapshotId: 1, comparable: true, kpis: { findings: { open: 2, new: 1, carryover: 1, resolved: 1 } } });
    expect(result.signals.find((s) => s.key === "findings")!.penalty).toBe(11);
  });

  it("returns the combined number only when asked", () => {
    expect(overview({})).not.toHaveProperty("combined");
    expect(overview({ combined: true }).combined).toBe(74);
  });

  it("orders files to read by centrality", () => {
    expect(overview({}).readingOrder.map((r) => r.node.id)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(overview({ reading_limit: 1 }).readingOrder).toHaveLength(1);
  });

  it("lists where to look first by hotspot score, with the reasons for each row", () => {
    const rows = overview({}).lookFirst;

    expect(rows.map((r) => [r.node.id, r.score, r.reasons])).toEqual([
      ["src/c.ts", 120, ["over-cutoff", "findings"]],
      ["src/a.ts", 50, ["churn-complexity"]],
      ["src/b.ts", 10, ["findings"]],
    ]);
    expect(overview({ look_limit: 2 }).lookFirst).toHaveLength(2);
  });
});
