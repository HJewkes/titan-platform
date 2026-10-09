import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { caseHash } from "./hash.js";
import { scoreMeasurementAudit } from "./measurement-audit.js";
import type { AuditGold, AuditOutput } from "./measurement-audit.js";
import { parseSpec } from "./spec/index.js";
import type { EvalCase, SuiteSpec, UnitSpec } from "./spec/index.js";

const ROOT = fileURLToPath(new URL("../fixtures/measurement-audit/", import.meta.url));
const read = <T>(relative: string): T => JSON.parse(readFileSync(`${ROOT}${relative}`, "utf8")) as T;
const goldCase = parseSpec(read("cases/shepherd.json")) as EvalCase;
const gold = goldCase.expected as AuditGold;

describe("the measurement-audit gold case", () => {
  it("holds the 44 metrics and 11 capture gaps of the Shepherd audit", () => {
    expect(gold.metrics).toHaveLength(44);
    expect(gold.gaps).toHaveLength(11);
  });

  it("is listed by the suite and its unit declares recall as the objective", () => {
    const suite = parseSpec(read("suite.json")) as SuiteSpec;
    const unit = parseSpec(read("unit.json")) as UnitSpec;

    expect(suite.cases).toEqual([caseHash(goldCase)]);
    expect(unit.objective.primary).toEqual({ name: "gap-recall", direction: "maximize" });
    expect(suite.checks.map((check) => check.id)).toContain("cost-cap");
  });
});

describe("scoreMeasurementAudit", () => {
  it("scores a run that finds every metric and gap at full recall and reports its cost", () => {
    expect(scoreMeasurementAudit(gold, read<AuditOutput>("samples/perfect.json"))).toEqual({ metricRecall: 1, gapRecall: 1, costUsd: 1.8 });
  });

  it("scores a partial run by the share of metrics and gaps it found", () => {
    const score = scoreMeasurementAudit(gold, read<AuditOutput>("samples/partial.json"));

    expect(score.metricRecall).toBeCloseTo(22 / 44);
    expect(score.gapRecall).toBeCloseTo(3 / 11);
    expect(score.costUsd).toBe(0.9);
  });

  it("scores an empty run at zero recall", () => {
    expect(scoreMeasurementAudit(gold, read<AuditOutput>("samples/empty.json"))).toEqual({ metricRecall: 0, gapRecall: 0, costUsd: 0 });
  });

  it("lets one proposed slice recall only one gap, so repeating a metric cannot inflate recall", () => {
    const output: AuditOutput = { metrics: [], slices: [{ title: "all", metrics: ["C1", "C2"] }], costUsd: 0 };

    expect(scoreMeasurementAudit(gold, output).gapRecall).toBeCloseTo(1 / 11);
  });

  it("finds both gaps that share a key metric whichever order their slices come in", () => {
    const sharedGold: AuditGold = { metrics: [], gaps: gold.gaps.filter((gap) => gap.id === "S6" || gap.id === "S11") };
    const tokenCost = { title: "token cost", metrics: ["C1"] };
    const reviewerProfile = { title: "record reviewerProfile", metrics: ["C2"] };
    expect(sharedGold.gaps).toHaveLength(2);

    for (const slices of [[tokenCost, reviewerProfile], [reviewerProfile, tokenCost]]) {
      expect(scoreMeasurementAudit(sharedGold, { metrics: [], slices, costUsd: 0 }).gapRecall).toBe(1);
    }
  });
});
