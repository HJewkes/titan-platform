import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { caseHash } from "./hash.js";
import { scoreMeasurementAudit } from "./measurement-audit.js";
import type { AuditGold } from "./measurement-audit.js";
import { parseSpec } from "./spec/index.js";
import type { EvalCase, SuiteSpec, UnitSpec } from "./spec/index.js";

type Report = { metrics: { id: string; title: string }[]; gaps: { rank: number; metric: string[]; slice: { title: string } }[] } & Record<string, unknown>;

const ROOT = fileURLToPath(new URL("../fixtures/measurement-audit/", import.meta.url));
const read = <T>(relative: string): T => JSON.parse(readFileSync(`${ROOT}${relative}`, "utf8")) as T;
const goldCase = parseSpec(read("cases/shepherd.json")) as EvalCase;
const gold = goldCase.expected as AuditGold;
const run = { costUsd: 1.8 };

function withMetricsAndSlices(metrics: Report["metrics"], slices: string[][]): Report {
  const base = read<Report>("samples/perfect.json");
  const template = base.metrics[0];
  return {
    ...base,
    metrics: metrics.map((metric) => ({ ...template, ...metric })),
    gaps: slices.map((metric, index) => ({ ...base.gaps[0], rank: index + 1, metric, slice: { ...base.gaps[0]?.slice, title: `slice ${index + 1}` } })),
  } as Report;
}

const goldNamed = (ids: string[]): Report["metrics"] =>
  gold.metrics.filter((metric) => ids.includes(metric.id)).map((metric) => ({ id: `m-${metric.id}`, title: metric.name }));

describe("the measurement-audit gold case", () => {
  it("holds the 44 named metrics and 11 capture gaps of the Shepherd audit", () => {
    expect(gold.metrics).toHaveLength(44);
    expect(gold.metrics.every((metric) => metric.name.length > 0)).toBe(true);
    expect(gold.gaps).toHaveLength(11);
  });

  it("is listed by the suite and its unit declares gap F1 as the objective", () => {
    const suite = parseSpec(read("suite.json")) as SuiteSpec;
    const unit = parseSpec(read("unit.json")) as UnitSpec;

    expect(suite.cases).toEqual([caseHash(goldCase)]);
    expect(unit.objective.primary).toEqual({ name: "gap-f1", direction: "maximize" });
    expect(suite.checks.map((check) => check.id)).toContain("cost-cap");
  });
});

describe("scoreMeasurementAudit", () => {
  it("parses a real-shaped v1 report and scores one with reworded metric names at full marks", () => {
    const report = read<Report>("samples/perfect.json");
    const goldNames = new Set(gold.metrics.flatMap((metric) => [metric.name, ...(metric.aliases ?? [])].map((name) => name.toLowerCase())));

    expect(report.metrics.filter((metric) => goldNames.has(metric.title.toLowerCase()))).toEqual([]);
    expect(scoreMeasurementAudit(gold, report, run)).toEqual({ metricRecall: 1, metricPrecision: 1, metricF1: 1, gapRecall: 1, gapPrecision: 1, gapF1: 1, costUsd: 1.8 });
  });

  it("takes cost from the run, not the report", () => {
    expect(scoreMeasurementAudit(gold, read("samples/perfect.json"), { costUsd: 0.25 }).costUsd).toBe(0.25);
  });

  it("refuses a report that is not a measurement-audit v1 report", () => {
    expect(() => scoreMeasurementAudit(gold, { metrics: [], slices: [], costUsd: 0 }, run)).toThrow();
  });

  it("scores a partial run by the share of metrics and gaps it found", () => {
    const score = scoreMeasurementAudit(gold, read("samples/partial.json"), run);

    expect(score.metricRecall).toBeCloseTo(22 / 44);
    expect(score.metricPrecision).toBe(1);
    expect(score.gapRecall).toBeCloseTo(3 / 11);
    expect(score.gapPrecision).toBe(1);
  });

  it("scores an empty run at zero", () => {
    expect(scoreMeasurementAudit(gold, read("samples/empty.json"), { costUsd: 0 })).toMatchObject({ metricF1: 0, gapF1: 0 });
  });

  it("scores a report that lists the gold ids as metrics and names every id in every slice at zero", () => {
    const ids = gold.metrics.map((metric) => metric.id);
    const listedIds = ["A", "F", "Q", "O", "C", "B"].flatMap((family) => Array.from({ length: 20 }, (_, n) => `${family}${n + 1}`));
    const report = withMetricsAndSlices(listedIds.map((id) => ({ id, title: id })), Array.from({ length: 11 }, () => ids));

    expect(scoreMeasurementAudit(gold, report, run)).toMatchObject({ metricRecall: 0, gapRecall: 0, gapF1: 0 });
  });

  it("closes no gap with slices that each name every metric, even when the metrics are right", () => {
    const metrics = goldNamed(gold.metrics.map((metric) => metric.id));
    const report = withMetricsAndSlices(metrics, Array.from({ length: 11 }, () => metrics.map((metric) => metric.id)));

    expect(scoreMeasurementAudit(gold, report, run).gapRecall).toBe(0);
  });

  it("penalises padding with extra metrics and one slice per metric through precision", () => {
    const padding = Array.from({ length: 132 }, (_, n) => ({ id: `junk-${n}`, title: `unrelated measure ${n}` }));
    const metrics = [...goldNamed(gold.metrics.map((metric) => metric.id)), ...padding];
    const score = scoreMeasurementAudit(gold, withMetricsAndSlices(metrics, metrics.map((metric) => [metric.id])), run);

    expect(score.metricPrecision).toBeCloseTo(44 / 176);
    expect(score.metricF1).toBeLessThan(0.5);
    expect(score.gapF1).toBeLessThan(0.2);
  });

  it("lets one reworded title match only one gold metric", () => {
    const report = withMetricsAndSlices([{ id: "x", title: "Reviewer cost per merged PR" }], []);

    expect(scoreMeasurementAudit(gold, report, run).metricRecall).toBeCloseTo(1 / 44);
  });

  it.each(["Service down", "Stuck doors", "Cost"])("does not match the short wrong title %s to a gold metric on one shared word", (title) => {
    const report = withMetricsAndSlices([{ id: "x", title }], []);

    expect(scoreMeasurementAudit(gold, report, run).metricRecall).toBe(0);
  });

  it("finds both gaps that share a key metric whichever order their slices come in", () => {
    const sharedGold: AuditGold = { metrics: gold.metrics, gaps: gold.gaps.filter((gap) => gap.id === "S6" || gap.id === "S11") };
    const metrics = goldNamed(["C1", "C2"]);
    expect(sharedGold.gaps).toHaveLength(2);

    for (const slices of [[["m-C1"], ["m-C2"]], [["m-C2"], ["m-C1"]]]) {
      expect(scoreMeasurementAudit(sharedGold, withMetricsAndSlices(metrics, slices), run).gapRecall).toBe(1);
    }
  });
});
