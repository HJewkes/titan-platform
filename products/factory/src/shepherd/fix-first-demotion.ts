import { GATE_DEMOTIONS, autoPassStepId, recordAutoPass, type GateDemotions } from "./auto-pass.js";
import { hasReviewerFixFirst, trailSummary, type FixFirstTrail } from "./fix-first-trail.js";
import { noticeHeldSeat } from "./gate-route.js";
import { awaitNewHead, type GateRun } from "./gates.js";
import { LeaveLand } from "./leave-land.js";
import type { Verdict } from "./phases.js";
import { escalationReason, type Escalated, type Escalation } from "./route-table.js";

/** What the D8 demotion reads and moves on a shepherd run; `convergedAt` on the trail is the head its review went to. */
export interface FixFirstDemotionRun extends GateRun, FixFirstTrail {
  reviews: Map<string, Verdict>;
  fresh: Set<string>;
}

/** Escalations that say point fixes are not converging; a convergence review answers them instead of the owner. */
const RUNAWAYS: ReadonlySet<Escalation> = new Set(["fix-first-runaway", "no-progress"]);
const CONVERGENCE_RULE = "D8/convergence-review";

/**
 * D8 (TP-3734): a runaway or no-progress head gets one fresh convergence review instead of approve-merge. Its MERGE takes
 * the normal land path at the PR's tier; its FIX_FIRST tells the seat to route the task to the planner, and the run waits
 * for a new head. False reviews the head again. Undefined leaves the escalation to the owner gate: the flag is off, or no
 * seat could be told, which is the seat-notice fallback every other seat route keeps.
 */
export async function onFixFirstEscalated(run: FixFirstDemotionRun, headSha: string, escalated: Escalated, demotions: GateDemotions = GATE_DEMOTIONS): Promise<false | undefined> {
  if (!demotions.fixFirstRunaway || !RUNAWAYS.has(escalated.escalation)) return undefined;
  if (run.convergedAt !== headSha) return convergesOn(run, headSha) ? sendConvergenceReview(run, headSha, escalated) : undefined;
  const why = `the convergence review still said FIX_FIRST after ${reasonOf(escalated)}, so the task goes to its planner to redesign or split it. Trail: ${trailSummary(run.fixFirstTrail).join("; ")}`;
  const told = await noticeHeldSeat(run, JSON.stringify(["fix-first-planner", headSha]), { headSha, why, gate: "fix-first-planner" });
  if (told !== undefined && !told.sent) return undefined;
  throw new LeaveLand(await awaitNewHead(run, headSha));
}

/**
 * A convergence review judges reviewer FIX_FIRSTs, so a trail of fix-proof NO_REPROs alone has nothing for it to judge, and a
 * head whose fix-proof said NO_REPRO would end that review before any reviewer started (TP-3900); both go to the owner gate.
 * A record that already took D8 there replays it, so the run does not diverge.
 */
function convergesOn(run: FixFirstDemotionRun, headSha: string): boolean {
  if (run.ctx.historyNext() === autoPassStepId(CONVERGENCE_RULE, headSha)) return true;
  return hasReviewerFixFirst(run.fixFirstTrail) && run.reviews.get(headSha)?.kind !== "NO_REPRO";
}

const reasonOf = (escalated: Escalated): string => escalationReason(escalated.escalation, escalated.detail, escalated.words);

// The evidence lands in a PR comment, so it names heads and counts only; the reviewers' class text goes to the seat alone.
async function sendConvergenceReview(run: FixFirstDemotionRun, headSha: string, escalated: Escalated): Promise<false> {
  run.convergedAt = headSha;
  run.reviews.delete(headSha);
  run.fresh.add(headSha);
  const detail = `${reasonOf(escalated)}; one fresh convergence reviewer judges the FIX_FIRST trail instead of the owner.`;
  const heads = run.fixFirstTrail.map((entry) => entry.headSha.slice(0, 12)).join(", ");
  const evidence = [`head ${headSha}`, `escalation: ${escalated.escalation}`, `FIX_FIRST heads, oldest first: ${heads}`];
  await recordAutoPass(run.ctx, { ...run.target, rule: CONVERGENCE_RULE, headSha, detail, evidence });
  return false;
}
