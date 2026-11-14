import { describe, expect, it } from "vitest";
import { writingJudgeVersion, type WritingJudgeConfig, type WritingRubrics } from "./writing-judge.js";

const CONFIG: WritingJudgeConfig = { provider: "claude-print", model: "judge-model", extractor_model: "extractor-model", max_budget_usd: 0.5, wall_time_s: 60 };
const RUBRICS: WritingRubrics = { judge: "JUDGE {{checklist}} {{piece}}", checklist: "[]", extract: "EXTRACT {{piece}}" };

describe("writing judge eval_version", () => {
  it("changes when the judge rubric, the checklist or the extractor model changes, and not with the budget", () => {
    const base = writingJudgeVersion(RUBRICS, CONFIG);

    expect(writingJudgeVersion({ ...RUBRICS, judge: `${RUBRICS.judge}\nMore.` }, CONFIG)).not.toBe(base);
    expect(writingJudgeVersion({ ...RUBRICS, checklist: '[{"id":"x","question":"y"}]' }, CONFIG)).not.toBe(base);
    expect(writingJudgeVersion(RUBRICS, { ...CONFIG, extractor_model: "other" })).not.toBe(base);
    expect(writingJudgeVersion(RUBRICS, { ...CONFIG, max_budget_usd: 2 })).toBe(base);
  });
});
