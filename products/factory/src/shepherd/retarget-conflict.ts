import { stepIdMatches } from "../definition.js";
import type { CiSnapshot, LandOutcome } from "../workflows/land.js";
import { fixConflict, type ConflictRun } from "./conflict-demotion.js";
import { orderedConflict, RESERVE_STEP, resolvedConflict } from "./merge-order-steps.js";

export interface RetargetRun extends ConflictRun {
  lastCi?: CiSnapshot;
  /** The base GitHub moved the PR off, from the last CI read before the move until a green head; replay rebuilds it. */
  retargetedFrom?: string;
}

/** Read before `lastCi` takes `ci`: a base that differs from the last read's is a retarget, as when a stacked parent merges. */
export function noteRetarget(run: RetargetRun, ci: CiSnapshot): CiSnapshot {
  if (ci.verdict === "green") run.retargetedFrom = undefined;
  const before = run.lastCi?.baseRef;
  if (before !== undefined && ci.baseRef !== undefined && ci.baseRef !== before && ci.verdict !== "green") run.retargetedFrom = before;
  return ci;
}

/** An update-branch conflict, or a stop at a head the last CI read showed dirty. */
export function isConflict(run: Pick<RetargetRun, "lastCi">, outcome: LandOutcome): boolean {
  if (outcome.kind !== "stopped") return false;
  const dirty = outcome.reason === "not-mergeable" && run.lastCi?.headSha === outcome.headSha && run.lastCi.mergeableState === "dirty";
  return outcome.reason === "conflict" || dirty;
}

/** Wakes a fixer with `payload`; true when an agent took it and a new head is up. */
type Wake = (payload: unknown) => Promise<boolean>;

/**
 * Merge order first (TP-4098), then one fixer wake at the base the overlapping PRs leave behind. TP-4566: a stacked
 * child retargeted onto the base its parent squash-merged into conflicts with that squash, and no overlapping merge it
 * could wait out will fix that. Waiting in the merge order there held such PRs in `merging` until the TTL, so the fixer
 * is woken at once, through each conflict wake up to the usual cap. A record that reserved at this conflict, made before
 * this, replays the order path.
 */
export function conflictRound(run: RetargetRun, headSha: string, wake: Wake): Promise<LandOutcome | undefined> {
  const fix = () => fixConflict(run, headSha, wake);
  const next = run.ctx.historyNext();
  const ordered = run.retargetedFrom === undefined || (next !== undefined && stepIdMatches(RESERVE_STEP, next));
  return resolvedConflict(run, ordered ? orderedConflict(run, headSha, fix) : fix());
}
