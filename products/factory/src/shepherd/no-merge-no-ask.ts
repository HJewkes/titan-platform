import type { WorkflowContext } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import { verdictIsMergeAt } from "../gate-brief.js";
import { GATE_DEMOTIONS, recordAutoPass, type GateDemotions } from "./auto-pass.js";
import { noticeHeldSeat } from "./gate-route.js";
import { awaitNewHead, type GateRun } from "./gates.js";
import { LeaveLand } from "./leave-land.js";
import type { Verdict } from "./phases.js";
import { gateHead } from "./stale-gates.js";

/** What the approve-merge guard reads and moves on a shepherd run. */
export interface NoMergeRun extends GateRun {
  reviews: Map<string, Verdict>;
  fresh: Set<string>;
  release?: unknown;
  /** Heads whose approve-merge already sent a fresh reviewer for want of a MERGE; a replay rebuilds it in the same order. */
  unreviewedAsks: Set<string>;
}

/**
 * A MERGE stands at the head when the run holds a parsed MERGE written at, or carried to, exactly that head (the test the
 * approve-merge brief recommends merging on), or Shepherd's own MERGE there that a seat holds. A panel member's MERGE
 * under a panel that gave no verdict is not one, since the run holds a plain `none` there.
 */
function mergeStandsAt(reviews: ReadonlyMap<string, Verdict>, headSha: string): boolean {
  const verdict = reviews.get(headSha);
  return verdictIsMergeAt(verdict, headSha) || (verdict?.kind === "none" && verdict.seatHeld?.head === headSha);
}

/** A bare `none`, with no cause or reason, is what a run with no reviewer wired gets; a fresh reviewer there would be no one, so the owner reviews. */
const noReviewerWired = (verdict: Verdict | undefined): boolean => verdict?.kind === "none" && verdict.cause === undefined && verdict.reason === undefined;

/**
 * Route escalations keep their own paths: D7 (r3) and D8 (r2) end in a seat or ops notice and open approve-merge only
 * when that notice could not go out, and D7 stays as it is on main until the owner rules on it.
 */
const ROUTE_ESCALATION = /\bPolicy shepherd-route\//;

const guarded = (run: NoMergeRun, headSha: string, prompt: string): boolean =>
  !run.release && !ROUTE_ESCALATION.test(prompt) && !mergeStandsAt(run.reviews, headSha) && !noReviewerWired(run.reviews.get(headSha));

/**
 * TP-3734 r4: the owner is asked to merge only a head a reviewer said MERGE at. Without one, a visual, seat or guard gate
 * does not open: the head gets one fresh reviewer, then the repo's seat hears and the run waits for a new head. Only a
 * notice that could not go out opens the gate, and its prompt says why. A release run reviews no head, and a run with no
 * reviewer wired has none to send, so their gates pass through.
 */
export function askingOnlyOverMerge(run: NoMergeRun, assisted: WorkflowContext["assisted"], demotions: GateDemotions = GATE_DEMOTIONS): WorkflowContext["assisted"] {
  return async (stepId, prompt, options) => {
    const headSha = stepIdMatches("approve-merge", stepId) ? gateHead(prompt) : undefined;
    if (!demotions.noMergeNoAsk || headSha === undefined || !guarded(run, headSha, prompt)) return assisted(stepId, prompt, options);
    if (!run.unreviewedAsks.has(headSha)) throw await reviewAgain(run, headSha);
    const why = "no reviewer MERGE stands at this head after a fresh review, and Shepherd asks the owner to merge only a reviewed head";
    const told = await noticeHeldSeat(run, JSON.stringify(["unreviewed", headSha]), { headSha, why, gate: "unreviewed" });
    if (told?.sent !== false) throw new LeaveLand(await awaitNewHead(run, headSha));
    return assisted(stepId, `${prompt}\n\nUnreviewed: ${why}; the seat notice could not go out (${told.detail}).`, options);
  };
}

async function reviewAgain(run: NoMergeRun, headSha: string): Promise<LeaveLand> {
  run.unreviewedAsks.add(headSha);
  const held = run.reviews.get(headSha);
  run.reviews.delete(headSha);
  run.fresh.add(headSha);
  const detail = `the merge decision at ${headSha} would have asked the owner with no reviewer MERGE there, so a fresh reviewer goes first`;
  await recordAutoPass(run.ctx, { ...run.target, rule: "R4/fresh-reviewer", headSha, detail, evidence: [`head ${headSha}`, `verdict held there: ${held?.kind ?? "none"}`] });
  return new LeaveLand();
}
