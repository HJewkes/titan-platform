import type { WorkflowContext } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import { REVIEW_INTENT_STEP } from "./review.js";
import type { Route } from "./route-table.js";

/** Routes that review the same head again. */
const AGAIN: ReadonlySet<Route> = new Set(["fresh-reviewer", "retry-review", "await-external"]);

/**
 * A replay takes the route its record took after this head's review. A route table changed by a redeploy would otherwise
 * send a restarted run back to review a head it had already left, or past a review the record shows it asked for again.
 */
export function recordedRoute(ctx: WorkflowContext, headSha: string, route: Route): Route {
  const next = ctx.historyNext();
  if (next === undefined) return route;
  const reviewedAgain = next === `${REVIEW_INTENT_STEP}:${headSha}`;
  if (!AGAIN.has(route)) return reviewedAgain ? "retry-review" : route;
  if (reviewedAgain) return route;
  if (stepIdMatches("sh-train-leave", next)) return "new-cycle";
  return stepIdMatches("sh-policy", next) ? "merge" : route;
}
