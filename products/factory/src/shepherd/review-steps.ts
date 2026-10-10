import type { StepResult } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";

/** Three, as in MAX_FAILED_ROUNDS: a broker still refusing after three retries, each with its busy wait, needs a human's look. */
export const MAX_NOT_STARTED_REVIEWS = 3;

/** Review dispatches since the last one that started a reviewer; the run never counts these, so only the view does. */
export function notStartedStreak(steps: readonly StepResult[]): number {
  const reviews = steps.filter((result) => result.stepId.split(":")[0] === "sh-review");
  return reviews.reduce((streak, result) => (result.data?.notStarted === true ? streak + 1 : 0), 0);
}

const DispatchedReviewData = z.object({ result: z.object({ kind: z.literal("dispatched"), reviewer: z.string().min(1) }) });

/** The reviewer the newest started review dispatched, so consumers need not guess it from the branch. */
export function reviewerName(steps: readonly StepResult[]): string | null {
  const names = steps.flatMap((result) => {
    const parsed = stepIdMatches("sh-review", result.stepId) ? DispatchedReviewData.safeParse(result.data) : undefined;
    return parsed?.success ? [parsed.data.result.reviewer] : [];
  });
  return names.at(-1) ?? null;
}
