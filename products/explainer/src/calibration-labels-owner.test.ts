import { BY_REC_FEEDBACK_GENERAL } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { labelsFromFeedback } from "./calibration-agreement.js";

describe("labelsFromFeedback on a by-rec answer", () => {
  it("refuses feedback answered by auto-by-rec as owner labels", () => {
    const feedback = { schema: "titan-review/feedback@1", general: BY_REC_FEEDBACK_GENERAL, answers: [{ questionId: "q01", pick: "Yes (q01)" }] };

    expect(() => labelsFromFeedback(feedback)).toThrow("feedback.json was answered by automation, not the owner; its picks are no owner labels");
  });

  it("reads an owner's feedback with a general note as labels", () => {
    const feedback = { schema: "titan-review/feedback@1", general: "Clear enough.", answers: [{ questionId: "q01", pick: "Yes (q01)" }] };

    expect([...labelsFromFeedback(feedback)]).toEqual([["q01", "yes"]]);
  });
});
