import type { RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import type { CiSnapshot } from "../workflows/land.js";
import { GATE_DEMOTIONS, recordAutoPass, type GateDemotions } from "./auto-pass.js";
import type { Verdict } from "./phases.js";
import { mergeEvidenceAt } from "./policy.js";
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
  merged: Map<string, Verdict>;
  fresh: Set<string>;
  escalations: Map<string, Escalated>;
  lastCi?: CiSnapshot;
}

/** `merge` goes on to the merge decision, `review-again` sends a fresh reviewer to the same head, `gate` asks the owner. */
type FailedRoundsRoute = { route: "merge" | "review-again" } | { route: "gate"; escalated: Escalated };

/** The run's own MERGE at exactly this head, with evidence collected there; a carried MERGE counts, as its carry was tree-equal. */
function standingMergeAt(run: FailedRoundsRun, headSha: string): Verdict | undefined {
  const merged = run.merged.get(headSha);
  return merged?.kind === "MERGE" && mergeEvidenceAt(headSha, () => merged)?.head === headSha ? merged : undefined;
}

function ciGreenAt(ci: CiSnapshot | undefined, headSha: string): ci is CiSnapshot {
  return ci?.headSha === headSha && ci.verdict === "green";
}

function roundsLine(run: FailedRoundsRun): string {
  return `failed rounds: ${run.failedOutcomes.join(", ")}`;
}

/**
 * D7 (TP-3697): a failed-rounds escalation passes without the owner when only infrastructure failed, the run's MERGE at
 * this head stands, and CI is green there; the merge policy then judges that MERGE as it would any other. Otherwise one
 * fresh reviewer goes first, and only its failure asks the owner. A seat-held escalation keeps its gate.
 */
export async function demoteFailedRounds(run: FailedRoundsRun, headSha: string, escalated: Escalated, demotions: GateDemotions = GATE_DEMOTIONS): Promise<FailedRoundsRoute> {
  if (!demotions.failedRounds || escalated.escalation !== "failed-rounds" || escalated.words !== undefined) return { route: "gate", escalated };
  const standing = standingMergeAt(run, headSha);
  if (escalated.infraOnly && standing !== undefined && ciGreenAt(run.lastCi, headSha)) {
    run.reviews.set(headSha, standing);
    const checks = run.lastCi.contexts?.length ? run.lastCi.contexts.join(", ") : "every required context";
    const evidence = [`head ${headSha}`, roundsLine(run), `MERGE standing at ${headSha}`, `CI green at ${headSha}: ${checks}`];
    await recordAutoPass(run.ctx, { ...run.target, rule: "D7/infra-standing-merge", headSha, detail: `${escalated.detail}; the merge policy judges the standing MERGE.`, evidence });
    return { route: "merge" };
  }
  if (run.fallbackReviewed) return { route: "gate", escalated: { ...escalated, detail: `${escalated.detail}; the fallback fresh reviewer failed too` } };
  run.fallbackReviewed = true;
  run.reviews.delete(headSha);
  run.fresh.add(headSha);
  const why = escalated.infraOnly ? "no MERGE stands at this head with CI green" : "a round failed on more than infrastructure";
  const detail = `${escalated.detail}; ${why}, so a fresh reviewer goes before the owner.`;
  await recordAutoPass(run.ctx, { ...run.target, rule: "D7/fallback-reviewer", headSha, detail, evidence: [`head ${headSha}`, roundsLine(run)] });
  return { route: "review-again" };
}

/** A conflict is a stuck round, and never an infrastructure failure. */
export function countConflictRound(run: FailedRoundsState): void {
  run.failedRounds += 1;
  run.failedOutcomes.push("conflict");
}

/** True goes on to the merge decision; false reviews the head again, as the D7 fallback reviewer does before the owner is asked. */
export async function onEscalated(run: FailedRoundsRun, headSha: string, escalated: Escalated): Promise<boolean> {
  const demoted = await demoteFailedRounds(run, headSha, escalated);
  if (demoted.route !== "gate") return demoted.route === "merge";
  run.escalations.set(headSha, demoted.escalated);
  return true;
}
