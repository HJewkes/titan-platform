import { describe, expect, it } from "vitest";
import { agreement, AgreementRecordSchema, labelsFromFeedback, pooledAgreement, promotionRefusal, type AgreementRecord, type JudgeAgreement, type OwnerLabel } from "./calibration-agreement.js";
import type { CalibrationJudge, KeyEntry } from "./calibration-queue.js";

const entry = (id: string, judge: CalibrationJudge, pass: boolean, evalVersion?: string): KeyEntry =>
  ({ id, judge, case: "c", videoType: "repo-tour", target: id, pass, configId: "cfg", run: "1", ...(evalVersion === undefined ? {} : { evalVersion }) });
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

  it("reads a pair's A as yes and B as no, dropping a pick that names another item", () => {
    const feedback = { schema: "titan-review/feedback@1", answers: [
      { questionId: "q07", pick: "A (q07)" }, { questionId: "q08", pick: "B (q08)" }, { questionId: "q09", pick: "Can't tell (q09)" }, { questionId: "q10", pick: "A (q07)" },
    ] };

    expect([...labelsFromFeedback(feedback)]).toEqual([["q07", "yes"], ["q08", "no"], ["q09", "unsure"]]);
  });
});

describe("agreement", () => {
  it("scores each judge on the items the owner decided, leaving can't-tell out of the share", () => {
    const key = [entry("q1", "cold", true), entry("q2", "cold", false), entry("q3", "cold", true), entry("q4", "cold", false), entry("q5", "l1", true)];
    const labels = new Map<string, OwnerLabel>([["q1", "yes"], ["q2", "no"], ["q3", "no"], ["q4", "unsure"], ["q5", "yes"]]);

    const [cold, rubric, l1] = agreement(key, labels);

    expect(cold).toEqual({ judge: "cold", items: 4, labelled: 3, unsure: 1, agreed: 2, agreement: 2 / 3, fail_recall: 1 / 2, stale: 0, eval_versions: [] });
    expect(rubric).toMatchObject({ judge: "cold-rubric", items: 0, labelled: 0, agreement: null, fail_recall: null });
    expect(l1).toMatchObject({ agreement: 1, fail_recall: null });
  });
});

describe("agreement over pairs", () => {
  it("counts one pair label for both pickers in it", () => {
    const key = [entry("q1", "audition-code", true), entry("q1", "audition-rubric", false)];

    const rows = agreement(key, new Map<string, OwnerLabel>([["q1", "no"]]));

    expect(rows.find((r) => r.judge === "audition-code")).toMatchObject({ labelled: 1, agreed: 0 });
    expect(rows.find((r) => r.judge === "audition-rubric")).toMatchObject({ labelled: 1, agreed: 1, fail_recall: 1 });
  });
});

describe("pooledAgreement", () => {
  const labels = (...pairs: [string, OwnerLabel][]) => new Map<string, OwnerLabel>(pairs);

  it("pools a judge's labels across rounds at one eval_version, reading each round's ids against its own labels", () => {
    const first = { entries: [entry("q01", "cold", true, "v2"), entry("q02", "cold", false, "v2")], labels: labels(["q01", "yes"], ["q02", "yes"]) };
    const second = { entries: [entry("q01", "cold", false, "v2")], labels: labels(["q01", "no"]) };

    const cold = pooledAgreement([first, second])[0]!;

    expect(cold).toMatchObject({ items: 3, labelled: 3, agreed: 2, stale: 0, eval_versions: ["v2"] });
  });

  it("leaves out an earlier round's item at another eval_version or at none, counting it stale", () => {
    const first = { entries: [entry("q01", "cold", true, "v1"), entry("q02", "cold", true)], labels: labels(["q01", "yes"], ["q02", "yes"]) };
    const second = { entries: [entry("q01", "cold", false, "v2"), entry("q02", "l1", true, "l1-v1")], labels: labels(["q01", "yes"], ["q02", "yes"]) };

    const [cold, , l1] = pooledAgreement([first, second]);

    expect(cold).toMatchObject({ items: 1, labelled: 1, agreed: 0, stale: 2, eval_versions: ["v2"] });
    expect(l1).toMatchObject({ items: 1, stale: 0, eval_versions: ["l1-v1"] });
  });

  it("never pools two rounds that both lack an eval_version, since nothing shows they ran one version", () => {
    const first = { entries: [entry("q01", "cold", true)], labels: labels(["q01", "yes"]) };
    const second = { entries: [entry("q01", "cold", true)], labels: labels(["q01", "yes"]) };

    expect(pooledAgreement([first, second])[0]).toMatchObject({ items: 1, stale: 1 });
  });

  it("keeps an earlier round whole for a judge the newest round does not ask about", () => {
    const first = { entries: [entry("q01", "cold-rubric", true, "r1")], labels: labels(["q01", "yes"]) };
    const second = { entries: [entry("q01", "cold", true, "v2")], labels: labels(["q01", "yes"]) };

    expect(pooledAgreement([first, second])[1]).toMatchObject({ judge: "cold-rubric", items: 1, agreed: 1, stale: 0 });
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

  it("reads a pooled record the same way, and a record from before pooling still parses", () => {
    const pooled = { ...record({ ...row("cold", 6, 5 / 6), stale: 1, eval_versions: ["v2"] }), rounds: ["unit", "unit-r2"] };

    expect(promotionRefusal("cold", AgreementRecordSchema.parse(pooled))).toBeNull();
    expect(AgreementRecordSchema.parse(record(row("l1", 8, 1))).rounds).toBeUndefined();
  });
});
