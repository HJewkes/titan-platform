import { stepIdMatches } from "../definition.js";
import type { CiSnapshot, LandOutcome } from "../workflows/land.js";
import { RESERVE_STEP, type OrderRun } from "./merge-order-steps.js";

export interface RetargetRun extends OrderRun {
  lastCi?: CiSnapshot;
  /** The base GitHub moved the PR off, from the last CI read before the move until a green head; replay rebuilds it. */
  retargetedFrom?: string;
}

/** Read before `lastCi` takes `ci`: a base that differs from the last read's is a retarget, as when a stacked parent merges. */
export function noteRetarget(run: RetargetRun, ci: CiSnapshot): void {
  if (ci.verdict === "green") run.retargetedFrom = undefined;
  const before = run.lastCi?.baseRef;
  if (before !== undefined && ci.baseRef !== undefined && ci.baseRef !== before && ci.verdict !== "green") run.retargetedFrom = before;
}

/**
 * TP-4566: a stacked child retargeted onto the base its parent squash-merged into conflicts with that squash, and no
 * overlapping merge it could wait out will fix that. Waiting in the merge order there held such PRs in `merging` until
 * the TTL, so the fixer is woken at once, through each conflict wake up to the usual cap. A record that reserved at this
 * conflict, made before this, replays the order path.
 */
export function retargetConflict(run: RetargetRun, ordered: () => Promise<LandOutcome | undefined>, wake: () => Promise<LandOutcome | undefined>): Promise<LandOutcome | undefined> {
  const next = run.ctx.historyNext();
  if (run.retargetedFrom === undefined || (next !== undefined && stepIdMatches(RESERVE_STEP, next))) return ordered();
  return wake();
}
