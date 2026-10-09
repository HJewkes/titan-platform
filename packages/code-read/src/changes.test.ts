import { describe, expect, it } from "vitest";
import { answer, file, memorySource, metric, snapshotInfo, type MemorySnapshot } from "./memory-source.js";
import type { CommandResult } from "./query/contract.js";
import type { ModelFinding, ModelMetric } from "./query/model.js";
import { createQueryResolver } from "./query/resolver.js";

type Changes = CommandResult<"changes.get">;

const hot = (id: string, churn: number, cognitive: number): ModelMetric[] => [
  metric(id, "churn_30d", churn),
  metric(id, "cognitive_max", cognitive),
  metric(id, "recency_30d", 1),
];

const finding = (rule: string, nodeId: string, value: number): ModelFinding => ({
  id: `${rule}|${nodeId}`, rule, severity: "warning", nodeId, metric: "loc", value, threshold: 5, message: rule,
});

// Scores at the baseline: b 200, a 50, c 10, and d unscored. The cutoff in these tests is 100.
const BASELINE: MemorySnapshot = {
  info: snapshotInfo(1),
  nodes: [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/d.ts"), file("src/gone.ts")],
  metrics: [...hot("src/a.ts", 10, 5), ...hot("src/b.ts", 10, 20), ...hot("src/c.ts", 2, 5)],
  findings: [finding("max-loc", "src/a.ts", 10), finding("max-loc", "src/c.ts", 50), finding("max-loc", "src/gone.ts", 9)],
};

// Now: a 150 and d 150 cross the cutoff, b rises to 300 above it, c holds, and new.ts and a generated file arrive.
const CURRENT: MemorySnapshot = {
  info: snapshotInfo(2),
  nodes: [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/d.ts"), file("src/new.ts"), file("src/client.gen.ts", "generated")],
  metrics: [...hot("src/a.ts", 10, 15), ...hot("src/b.ts", 10, 30), ...hot("src/c.ts", 2, 5), ...hot("src/d.ts", 5, 30), ...hot("src/new.ts", 1, 2)],
  findings: [finding("max-loc", "src/a.ts", 12), finding("max-loc", "src/c.ts", 40), finding("max-cyclo", "src/new.ts", 7)],
};

const OTHER_INDEX: MemorySnapshot = { ...BASELINE, info: snapshotInfo(3, "main", "0.15.0") };

const resolve = createQueryResolver(memorySource([OTHER_INDEX, CURRENT, BASELINE]));
const changes = (args: object = {}): Changes => answer(resolve)<Changes>("changes.get", { snapshot: 2, baseline: 1, cutoff: 100, ...args });
const ids = (rows: readonly { node: { id: string } }[]): string[] => rows.map((r) => r.node.id);

describe("changes.get against a baseline", () => {
  it("lists files that crossed the cutoff, largest rise first", () => {
    expect(changes().files.crossedCutoff.map((r) => [r.node.id, r.before, r.after, r.delta])).toEqual([
      ["src/d.ts", 0, 150, 150],
      ["src/a.ts", 50, 150, 100],
    ]);
  });

  it("lists files the baseline does not hold, leaving out generated ones", () => {
    expect(changes().files.added.map((r) => [r.node.id, r.score])).toEqual([["src/new.ts", 2]]);
  });

  it("lists findings that are new since the baseline", () => {
    expect(changes().findings.new.map((f) => f.id)).toEqual(["max-cyclo|src/new.ts"]);
  });

  it("lists findings whose value worsened, with the baseline value and the delta", () => {
    expect(changes().findings.worsened.map((c) => [c.finding.id, c.before, c.delta])).toEqual([["max-loc|src/a.ts", 10, 2]]);
  });

  it("lists findings whose value improved", () => {
    expect(changes().findings.improved.map((c) => [c.finding.id, c.before, c.delta])).toEqual([["max-loc|src/c.ts", 50, -10]]);
  });

  it("lists findings the current snapshot no longer has as resolved", () => {
    expect(changes().findings.resolved.map((f) => [f.id, f.snapshotId])).toEqual([["max-loc|src/gone.ts", 1]]);
  });

  it("reports new coupling as unmeasured, since co-change pairs are not stored", () => {
    expect(changes().coupling).toEqual({ measured: false, added: [] });
  });

  it("ties a rising file to its open findings as a regression, and skips rising files with none", () => {
    expect(changes().regressions.map((r) => [r.node.id, r.delta, r.findings])).toEqual([["src/a.ts", 100, ["max-loc|src/a.ts"]]]);
  });

  it("caps every list at limit while counts keep the full sizes", () => {
    const result = changes({ limit: 1 });

    expect(ids(result.files.crossedCutoff)).toEqual(["src/d.ts"]);
    expect(result.counts).toEqual({
      crossedCutoff: 2, newFiles: 1, newFindings: 1, worsened: 1, improved: 1, resolved: 1, newCoupling: 0, regressions: 1,
    });
  });

  it("returns comparable false and no changes when the snapshots differ in index version", () => {
    const result = changes({ baseline: 3 });

    expect(result).toMatchObject({ snapshotId: 2, baselineSnapshotId: 3, comparable: false });
    expect(result.files).toEqual({ crossedCutoff: [], added: [] });
    expect(result.findings).toEqual({ new: [], worsened: [], improved: [], resolved: [] });
    expect(result.regressions).toEqual([]);
    expect(Object.values(result.counts).every((n) => n === 0)).toBe(true);
  });

  it("is comparable for snapshots of one index version", () => {
    expect(changes()).toMatchObject({ snapshotId: 2, baselineSnapshotId: 1, comparable: true });
  });
});

describe("changes.get on a minimum rule", () => {
  const minCov = (id: number, a: number, b: number): MemorySnapshot => ({
    info: snapshotInfo(id),
    nodes: [file("src/a.ts"), file("src/b.ts")],
    metrics: [],
    findings: [
      { id: "min-cov|src/a.ts", rule: "min-cov", severity: "warning", nodeId: "src/a.ts", metric: "cov", value: a, threshold: 80, message: "" },
      { id: "min-cov|src/b.ts", rule: "min-cov", severity: "warning", nodeId: "src/b.ts", metric: "cov", value: b, threshold: 80, message: "" },
    ],
    rules: [{ id: "min-cov", type: "metric-min", severity: "warning", text: "cov must be at least 80." }],
  });
  const call = answer(createQueryResolver(memorySource([minCov(2, 40, 50), minCov(1, 60, 20)])));

  it("lists a falling value as worsened and a rising one as improved", () => {
    const { findings } = call<Changes>("changes.get", { snapshot: 2, baseline: 1 });

    expect(findings.worsened.map((c) => [c.finding.id, c.delta])).toEqual([["min-cov|src/a.ts", -20]]);
    expect(findings.improved.map((c) => [c.finding.id, c.delta])).toEqual([["min-cov|src/b.ts", 30]]);
  });
});
