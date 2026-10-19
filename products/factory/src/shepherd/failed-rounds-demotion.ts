import type { RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { GATE_DEMOTIONS, recordAutoPass, type GateDemotions } from "./auto-pass.js";
import type { Verdict } from "./phases.js";
import type { Escalated } from "./route-table.js";

/** The run state D7 adds: what each counted round failed on, and whether the fallback reviewer went. */
export interface FailedRoundsState {
  /** The outcome of each round `failedRounds` counted; a conflict counts as `conflict`. */
  failedOutcomes: string[];
  failedRounds: number;
  fallbackReviewed: boolean;
}

/** What the D7 demotion reads and moves on a shepherd run. */
export interface FailedRoundsRun extends FailedRoundsState {
  ctx: WorkflowContext;
  target: { repo: RepoSlug; pr: number };
  reviews: Map<string, Verdict>;
  fresh: Set<string>;
  escalations: Map<string, Escalated>;
}

/** `review-again` sends a fresh reviewer to the same head, `gate` asks the owner. */
type FailedRoundsRoute = { route: "review-again" } | { route: "gate"; escalated: Escalated };

/**
 * D7 (TP-3697): a failed-rounds escalation whose every counted round failed on infrastructure sends one fresh reviewer
 * before the owner, and only its failure asks the owner. D7 never merges: a MERGE still has to stand through the normal
 * review path. A round that failed on more than infrastructure, and a seat-held escalation, keep the owner gate.
 */
export async function demoteFailedRounds(run: FailedRoundsRun, headSha: string, escalated: Escalated, demotions: GateDemotions = GATE_DEMOTIONS): Promise<FailedRoundsRoute> {
  if (!demotions.failedRounds || escalated.escalation !== "failed-rounds" || escalated.words !== undefined || !escalated.infraOnly) return { route: "gate", escalated };
  if (run.fallbackReviewed) return { route: "gate", escalated: { ...escalated, detail: `${escalated.detail}; the fallback fresh reviewer failed too` } };
  run.fallbackReviewed = true;
  run.reviews.delete(headSha);
  run.fresh.add(headSha);
  const detail = `${escalated.detail}; every round failed on infrastructure, so a fresh reviewer goes before the owner.`;
  await recordAutoPass(run.ctx, { ...run.target, rule: "D7/fallback-reviewer", headSha, detail, evidence: [`head ${headSha}`, `failed rounds: ${run.failedOutcomes.join(", ")}`] });
  return { route: "review-again" };
}

/** A conflict is a stuck round, and never an infrastructure failure. */
export function countConflictRound(run: FailedRoundsState): void {
  run.failedRounds += 1;
  run.failedOutcomes.push("conflict");
}

/** True goes on to the merge decision, where the owner gate opens; false reviews the head again with the D7 fallback reviewer. */
export async function onEscalated(run: FailedRoundsRun, headSha: string, escalated: Escalated): Promise<boolean> {
  const demoted = await demoteFailedRounds(run, headSha, escalated);
  if (demoted.route === "review-again") return false;
  run.escalations.set(headSha, demoted.escalated);
  return true;
}
