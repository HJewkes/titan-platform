import type { AdversaryHoldContext, OVERLAY_SHAPES, ReviewTarget } from "@titan-design/review-panel";
import { join } from "node:path";
import type { ShepherdDeps } from "./phases.js";
import { removeReviewCheckout, reviewCheckoutRoot } from "./review-checkout.js";

export type MemberShape = (typeof OVERLAY_SHAPES)[number];

/** The hold reason an adversary aims its probes at; an unreadable store gives the brief none. */
export function holdContextOf(deps: ShepherdDeps, runId: string | undefined): AdversaryHoldContext | undefined {
  if (runId === undefined) return undefined;
  try {
    const holdReason = deps.store.get().byRun(runId)?.holdReason;
    return holdReason ? { holdReason } : undefined;
  } catch {
    return undefined;
  }
}

/** A panel member other than correctness checks out under its shape's dir, since each reviewer removes its own run dir when it is done. */
export const checkoutRootOf = (deps: ShepherdDeps, shape?: MemberShape): string => {
  const root = deps.reviewCheckouts?.root ?? reviewCheckoutRoot();
  return shape === undefined ? root : join(root, shape);
};

/** Removes the run's checkout dir; the reviewer is told to, but a reviewer that failed or timed out never does, and a verdict must not depend on it. */
export async function dropCheckout(deps: ShepherdDeps, target: ReviewTarget, shape?: MemberShape): Promise<void> {
  await removeReviewCheckout(checkoutRootOf(deps, shape), target, deps.reviewCheckouts?.remove);
}

/**
 * Removes the checkout once the reviewer is finished with it: when `work` returns and `finished` says so. A throw (an abort at
 * shutdown, say) leaves it, because the reviewer outlives the step and a replay waits on it; the sweep is the backstop.
 */
export async function thenDropCheckout<T>(deps: ShepherdDeps, target: ReviewTarget, work: () => Promise<T>, finished: (result: T) => boolean, shape?: MemberShape): Promise<T> {
  const result = await work();
  if (finished(result)) await dropCheckout(deps, target, shape);
  return result;
}
