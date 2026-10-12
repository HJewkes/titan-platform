import type { StepResult } from "@titan-design/workflow";
import { z } from "zod";

/** One per head; a panel member other than correctness gets `sh-review:<head>:<shape>`. */
export const REVIEW_STEP = "sh-review";

/** Three, as in MAX_FAILED_ROUNDS: a broker still refusing after three retries, each with its busy wait, needs a human's look. */
export const MAX_NOT_STARTED_REVIEWS = 3;

/** `sh-review:<head>`; a panel member's `sh-review:<head>:<shape>` is not the head's review, so neither count reads it. */
const isHeadReview = (stepId: string): boolean => {
  const [name, , member] = stepId.split(":");
  return name === REVIEW_STEP && member === undefined;
};

/** Review dispatches since the last one that started a reviewer; the run never counts these, so only the view does. */
export function notStartedStreak(steps: readonly StepResult[]): number {
  const reviews = steps.filter((result) => isHeadReview(result.stepId));
  return reviews.reduce((streak, result) => (wasNotStarted(result) ? streak + 1 : 0), 0);
}

const NestedNotStarted = z.object({ result: z.object({ notStarted: z.unknown() }) });

/** The writer nests the dispatch outcome under data.result; rows written before that kept it at the top level. */
function wasNotStarted(step: StepResult): boolean {
  const nested = NestedNotStarted.safeParse(step.data);
  return (nested.success && nested.data.result.notStarted === true) || step.data?.notStarted === true;
}

const DispatchedReviewData = z.object({ result: z.object({ kind: z.literal("dispatched"), reviewer: z.string().min(1) }) });

/** The reviewer the newest started review dispatched, so consumers need not guess it from the branch. */
export function reviewerName(steps: readonly StepResult[]): string | null {
  const names = steps.flatMap((result) => {
    const parsed = isHeadReview(result.stepId) ? DispatchedReviewData.safeParse(result.data) : undefined;
    return parsed?.success ? [parsed.data.result.reviewer] : [];
  });
  return names.at(-1) ?? null;
}
