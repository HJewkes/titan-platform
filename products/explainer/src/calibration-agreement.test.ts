import { describe, expect, it } from "vitest";
import { agreement, labelsFromFeedback, promotionRefusal, type AgreementRecord, type JudgeAgreement, type OwnerLabel } from "./calibration-agreement.js";
import type { CalibrationJudge, KeyEntry } from "./calibration-queue.js";

const entry = (id: string, judge: CalibrationJudge, pass: boolean): KeyEntry => ({ id, judge, case: "c", videoType: "repo-tour", target: id, pass });
const record = (...judges: JudgeAgreement[]): AgreementRecord => ({ schema: "judge-agreement/v1", round: "r", recorded_at: "2026-10-22T00:00:00Z", judges });
const row = (judge: CalibrationJudge, labelled: number, agreement: number | null): JudgeAgreement =>
  ({ judge, items: labelled, labelled, unsure: 0, agreed: Math.round((agreement ?? 0) * labelled), agreement, fail_recall: null });

describe("labelsFromFeedback", () => {
  it("reads the console's picks as labels and drops blanks and off-option answers", () => {
    const feedback = { schema: "titan-review/feedback@1", answers: [
      { questionId: "q01", pick: "Yes (q01)" }, { questionId: "q02", pick: "No (q02)" }, { questionId: "q03", pick: "Can't tell (q03)" },
      { questionId: "q04" }, { questionId: "q05", pick: "None of these, request a revision" }, { questionId: "q06", pick: "Yes (q01)" },
    ] };

    expect([...labelsFromFeedback(feedback)]).toEqual([["q01", "yes"], ["q02", "no"], ["q03", "unsure"]]);
  });
});

describe("agreement", () => {
  it("scores each judge on the items the owner decided, leaving can't-tell out of the share", () => {
    const key = [entry("q1", "cold", true), entry("q2", "cold", false), entry("q3", "cold", true), entry("q4", "cold", false), entry("q5", "l1", true)];
    const labels = new Map<string, OwnerLabel>([["q1", "yes"], ["q2", "no"], ["q3", "no"], ["q4", "unsure"], ["q5", "yes"]]);

    const [cold, rubric, l1] = agreement(key, labels);

    expect(cold).toEqual({ judge: "cold", items: 4, labelled: 3, unsure: 1, agreed: 2, agreement: 2 / 3, fail_recall: 1 / 2 });
    expect(rubric).toMatchObject({ judge: "cold-rubric", items: 0, labelled: 0, agreement: null, fail_recall: null });
    expect(l1).toMatchObject({ agreement: 1, fail_recall: null });
  });
});

describe("promotionRefusal", () => {
  it("refuses every judge when no agreement is recorded", () => {
    expect(promotionRefusal("cold-rubric", undefined)).toMatch(/no agreement recorded/);
    expect(promotionRefusal("l1", record(row("cold", 8, 1)))).toMatch(/no agreement recorded/);
  });

  it("refuses a judge below the 0.8 bar or with too few labels, and allows one that clears both", () => {
    const recorded = record(row("cold", 8, 0.75), row("cold-rubric", 4, 1), row("l1", 8, 0.875));

    expect(promotionRefusal("cold", recorded)).toMatch(/0\.75 is below 0\.8/);
    expect(promotionRefusal("cold-rubric", recorded)).toMatch(/4 labelled items/);
    expect(promotionRefusal("l1", recorded)).toBeNull();
  });
});
