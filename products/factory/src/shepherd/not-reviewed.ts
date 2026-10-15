import type { ReviewTarget } from "@titan-design/review-panel";
import type { WorkflowContext } from "@titan-design/workflow";
import { NO_REVIEWER_HOLD_STEP, noReviewerHeld } from "./no-reviewer-hold.js";
import type { Verdict } from "./phases.js";

/**
 * A busy broker or an unread roster that started nobody retries the review. A refusal (at the intent or the dispatch) holds the run as no-reviewer rather than counting a failed
 * round, so a repo with no usable reviewer never reaches approve-merge unreviewed (TP-2446). Any other none is a round with no verdict.
 * A replay whose record went on without a no-reviewer hold was written before that mapping (TP-2966 a), so it keeps the no-verdict it recorded
 * rather than diverging into a live hold step (TP-3015).
 */
export function notReviewed(ctx: WorkflowContext, target: ReviewTarget, result: Readonly<Record<string, unknown>>): Promise<Verdict> | Verdict {
  if (result.notStarted === true) return { kind: "none", cause: "not-started" };
  if (typeof result.refused === "string") return recordedWithoutHold(ctx) ? { kind: "none", cause: "no-verdict" } : noReviewerHeld(ctx, target, result.refused);
  return { kind: "none", cause: "no-verdict" };
}

function recordedWithoutHold(ctx: WorkflowContext): boolean {
  const next = ctx.historyNext();
  return next !== undefined && !next.startsWith(`${NO_REVIEWER_HOLD_STEP}:`);
}
