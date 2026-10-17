import { UpdateResultResult } from "../workflows/land-steps.js";
import type { CiSnapshot } from "../workflows/land.js";
import type { Escalated } from "./route-table.js";

/** A head behind its base is reviewed once its own checks are green, so a busy base delays only the merge, never the review. */
export function reviewable(ci: CiSnapshot): boolean {
  return ci.verdict === "green" || (ci.verdict === "behind" && ci.checksGreen === true);
}

/** `land` read this head behind, so going on in `land` updates the branch there and its update bound applies. */
export function behindAt(lastCi: CiSnapshot | undefined, headSha: string): boolean {
  return lastCi?.headSha === headSha && lastCi.verdict === "behind";
}

/** An escalation at a behind head still holds after `land` merges the base into it, or the update would clear it. */
function inheritEscalation(escalations: Map<string, Escalated>, lastCi: CiSnapshot | undefined, updateResult: unknown): void {
  const update = UpdateResultResult.safeParse(updateResult);
  const escalated = lastCi && escalations.get(lastCi.headSha);
  if (update.success && update.data.own && escalated) escalations.set(update.data.headSha, escalated);
}

/** After `land`'s update-branch: an escalation follows Shepherd's own update, which the next review names as its cause. */
export function onUpdated(run: { escalations: Map<string, Escalated>; lastCi?: CiSnapshot; trail: { updated: Set<string> } }, result: unknown): void {
  inheritEscalation(run.escalations, run.lastCi, result);
  const update = UpdateResultResult.safeParse(result);
  if (update.success && update.data.own) run.trail.updated.add(update.data.headSha);
}
