import { ArResultSchema } from "@titan-design/autoresearch";
import { describe, expect, it } from "vitest";
import { arResultFor, type ArResultInput } from "./ar-result.js";
import type { ColdChapter } from "./eval-cold.js";
import type { L1Result } from "./eval-judge.js";
import type { L0Result } from "./eval-l0.js";
import type { BeatRejectionRule } from "./rewrite-guard.js";
import type { RejectedBeat, RewriteReport, TargetRow } from "./rewrite-pass.js";

const chapter = (minutes: number, undefinedItems: number, canaryPass = true): ColdChapter => ({
  chapter: "c1",
  minutes,
  summary: "",
  scores: [],
  odd_one_out: [],
  undefined_items: undefinedItems,
  undefined_per_minute: 0,
  undefined_terms: 0,
  undefined_terms_per_minute: 0,
  canaries: [{ canary: "k", dim: "d", got: "x", pass: canaryPass }],
});

const l0Row = (check_id: string, severity: "error" | "warning", pass: boolean): L0Result => ({
  check_id,
  mode: "tagged",
  severity,
  value: 1,
  threshold: 0,
  pass,
  detail_beats: [],
});

const target = (check_id: string, pass: boolean): TargetRow => ({ check_id, value: 1, threshold: 1, pass });

const rejected = (...rules: BeatRejectionRule[]): RejectedBeat => ({
  beat: "b1",
  rejections: rules.map((rule) => ({ rule, detail: "" })),
});

const report = (after: TargetRow[], rejects: RejectedBeat[] = []): RewriteReport => ({
  judge: "j",
  before: [],
  after,
  rounds: [{ round: 1, kept: true, failing: { before: 0, after: 0 }, distance: { before: 0, after: 0 }, rewritten: [], rejected: rejects, reverted: [], chapters: [] }],
  calls: [],
  usd: 0,
  tokensIn: 0,
  tokensOut: 0,
});

const l1 = (scores: (number | null)[]): L1Result => ({
  eval_version: "v",
  judge: "j",
  beats: [],
  script: scores.map((score) => ({ dim: "J1" as const, verdict: { score, evidence: "", void_reason: null } })),
  canaries: [{ canary: "k", dim: "J1", got: "x", pass: false }],
  failures: [],
  trusted: true,
  spend: { usd: 0, tokensIn: 0, tokensOut: 0 },
});

const input = (over: Partial<ArResultInput> = {}): ArResultInput => ({
  case: "case-a",
  repeat: "r1",
  rung: "L2",
  l0Rows: [l0Row("Q-E7", "error", true)],
  cold: { eval_version: "v", judge: "j", chapters: [chapter(2, 3), chapter(1, 3)], failures: [], trusted: true, spend: { usd: 0, tokensIn: 0, tokensOut: 0 } },
  rewrite: { report: report([target("register:numbers", true), target("register:triads", false)]), spokenWords: 450 },
  usd: 1.5,
  wallS: 12,
  ...over,
});

describe("arResultFor", () => {
  it("parses with ArResultSchema", () => {
    const parsed = ArResultSchema.parse(arResultFor(input()));

    expect(parsed).toMatchObject({ case: "case-a", repeat: "r1", rung: "L2", usd: 1.5, wall_s: 12 });
  });

  it("divides summed undefined items by summed chapter minutes, and gives 0 with no minutes", () => {
    const withMinutes = arResultFor(input());
    const noMinutes = arResultFor(input({ cold: { ...input().cold, chapters: [chapter(0, 4)] } }));

    expect(withMinutes.metrics["cold.undefined_items_per_min"]).toBe(2);
    expect(noMinutes.metrics["cold.undefined_items_per_min"]).toBe(0);
  });

  it("carries the guard metrics, and omits l1.J_mean when no l1 result is passed", () => {
    const without = arResultFor(input());
    const withL1 = arResultFor(input({ l1: l1([4, 2, null]) }));

    expect(without.metrics["rewrite.rows_out_of_band"]).toBe(1);
    expect(without.metrics["script.words_per_min"]).toBe(150);
    expect(without.metrics["cost_usd_per_min"]).toBe(0.5);
    expect(without.metrics).not.toHaveProperty("l1.J_mean");
    expect(withL1.metrics["l1.J_mean"]).toBe(3);
  });

  it("counts violations and fails l0.pass on any L0 error row", () => {
    const result = arResultFor(
      input({
        l0Rows: [l0Row("Q-E7", "error", false), l0Row("Q-E9", "error", false), l0Row("Q-E8", "warning", false)],
        rewrite: { report: report([], [rejected("number-invented", "number-invented"), rejected("fact-id", "terms")]), spokenWords: 450 },
        l1: l1([3]),
      }),
    );

    expect(result.violations).toEqual({ l0_errors: 2, number_invented: 2, fact_outside_selection: 1, judge_canary_failed: 1 });
    expect(result.gates["l0.pass"]).toBe(false);
    expect(arResultFor(input()).gates["l0.pass"]).toBe(true);
  });
});
