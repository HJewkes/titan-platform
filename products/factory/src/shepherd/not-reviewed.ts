import type { ReviewTarget } from "@titan-design/review-panel";
import type { WorkflowContext } from "@titan-design/workflow";
import { noReviewerHeld } from "./no-reviewer-hold.js";
import type { Verdict } from "./phases.js";

/**
 * A busy broker or an unread roster that started nobody retries the review. A refusal (at the intent or the dispatch) holds the run as no-reviewer rather than counting a failed
 * round, so a repo with no usable reviewer never reaches approve-merge unreviewed (TP-2446). Any other none is a round with no verdict.
 */
export function notReviewed(ctx: WorkflowContext, target: ReviewTarget, result: Readonly<Record<string, unknown>>): Promise<Verdict> | Verdict {
  if (result.notStarted === true) return { kind: "none", cause: "not-started" };
  if (typeof result.refused === "string") return noReviewerHeld(ctx, target, result.refused);
  return { kind: "none", cause: "no-verdict" };
}
