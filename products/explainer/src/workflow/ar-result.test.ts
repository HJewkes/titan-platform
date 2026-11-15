import { MetricSpecSchema, resultSchemaFor } from "@titan-design/autoresearch";
import { describe, expect, it } from "vitest";
import type { ColdResult } from "../eval-cold.js";
import type { L0Result } from "../eval-l0.js";
import { runArResults, type ArEnv, type ArGrade } from "./ar-result.js";
import { NO_USAGE, type StageRecord } from "./records.js";
import { ChildStageFailure } from "./stage-cache.js";

// The plan §6.1 keep rule for the script writer: undefined items a minute is judged, the other metrics are guards.
const SPEC = MetricSpecSchema.parse({
  primary: { name: "cold.undefined_items_per_min", direction: "min" },
  guards: { "rewrite.rows_out_of_band": 0, "script.words_per_min": 0, cost_usd_per_min: 0 },
  zeroTolerance: ["l0_error_rows", "number_invented", "fact_outside_selection", "judge_canary_failed"],
  allGate: true,
  noise: {},
});
const schema = resultSchemaFor(SPEC);

const record = (draft: string, usd = 0.5, cached = false): StageRecord => ({
  stage: "script", bridged: false, startedAt: "t", endedAt: "t", wallMs: 2500, usage: { ...NO_USAGE, usd, calls: 1 }, retries: 0, outputs: { draft }, checks: [], notes: [], ...(cached ? { cached } : {}),
});

const errorRow = (pass: boolean): L0Result => ({ check_id: "Q-E7", mode: "tagged", severity: "error", value: 1, threshold: 0, pass, detail_beats: [] });

const cold = (undefinedItems: number): ColdResult => ({
  eval_version: "v", judge: "j", failures: [], trusted: true, spend: { usd: 0, tokensIn: 0, tokensOut: 0 },
  chapters: [{ chapter: "c1", minutes: 2, summary: "", scores: [], odd_one_out: [], undefined_items: undefinedItems, undefined_per_minute: 0, undefined_terms: 0, undefined_terms_per_minute: 0, canaries: [{ canary: "k", dim: "d", got: "x", pass: true }] }],
});

const grade = (errorRows: number): ArGrade => ({ l0Rows: Array.from({ length: errorRows }, () => errorRow(false)), spokenWords: 300, cold: cold(4) });

function env(runFor: (sample: number) => Promise<StageRecord>, gradeOf: (sha: string) => ArGrade = () => grade(0)): ArEnv {
  return {
    run: (_inputs, sample) => runFor(sample),
    score: () => [{ check_id: "register:numbers", value: 30, threshold: 25, pass: false }],
    grade: async (sha) => gradeOf(sha),
  };
}

const cases = [{ name: "a", inputs: { spine: "sa", facts: "fa" } }, { name: "b", inputs: { spine: "sb", facts: "fb" } }];
const request = { cases, repeats: 2, rung: "script" };

describe("runArResults", () => {
  it("prints a line per case and repeat that parses against the plan's metric spec", async () => {
    const outcome = await runArResults(request, env(async (sample) => record(`d${sample}`)));

    expect(outcome.lines.map((line) => [line.case, line.repeat])).toEqual([["a", "r1"], ["b", "r1"], ["a", "r2"], ["b", "r2"]]);
    for (const line of outcome.lines) expect(() => schema.parse(line)).not.toThrow();
    expect(outcome.lines[0]).toMatchObject({
      metrics: { "cold.undefined_items_per_min": 2, "rewrite.rows_out_of_band": 1, "script.words_per_min": 150, cost_usd_per_min: 0.25 },
      usd: 0.5,
      wall_s: 2.5,
    });
  });

  it("reports l0.pass false and the error-row count for a sample that failed a gate", async () => {
    const failing = env(async () => {
      throw new ChildStageFailure("gate l0 failed", record("dx"));
    }, () => grade(2));

    const outcome = await runArResults({ ...request, cases: cases.slice(0, 1), repeats: 1 }, failing);

    expect(outcome.lines[0]?.gates["l0.pass"]).toBe(false);
    expect(outcome.lines[0]?.violations["l0_error_rows"]).toBe(2);
  });

  it("stops before a case that would pass --max-usd", async () => {
    const outcome = await runArResults({ ...request, maxUsd: 1.5 }, env(async (sample) => record(`d${sample}`, 1)));

    expect(outcome.lines).toHaveLength(1);
    expect(outcome.stopped).toMatch(/spend cap/);
  });

  it("stops a second arm before a run the first arm's dearest run says would pass the cap", async () => {
    const one = { ...request, cases: cases.slice(0, 1), repeats: 1, maxUsd: 1 };
    const armA = await runArResults(one, env(async () => record("d0", 0.7)));

    const armB = await runArResults({ ...one, prior: armA }, env(async () => record("d1", 0.7)));

    expect(armA.lines).toHaveLength(1);
    expect(armB.lines).toEqual([]);
    expect(armB.stopped).toMatch(/spend cap: \$0\.7000 spent/);
  });

  it("reports usd 0 for a cached repeat",async () => {
    const outcome = await runArResults({ ...request, cases: cases.slice(0, 1), repeats: 1 }, env(async () => record("d0", 0.5, true)));

    expect(outcome.lines[0]?.usd).toBe(0);
    expect(outcome.lines[0]?.metrics["cost_usd_per_min"]).toBe(0);
  });

  it("lists a run that made no script without a line", async () => {
    const outcome = await runArResults({ ...request, cases: cases.slice(0, 1), repeats: 1 }, env(async () => {
      throw new Error("model down");
    }));

    expect(outcome.lines).toEqual([]);
    expect(outcome.failed).toEqual(["a r1: model down"]);
  });
});
