import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import { AWAIT_VERDICT_STEP } from "./await-verdict.js";
import { REVIEW_INTENT_STEP } from "./review.js";
import { REVIEW_STEP } from "./review-steps.js";

/** One reviewer a review round dispatched: its session, or why it never started, and whether it returned a verdict. */
export interface ReviewerSeen {
  head: string;
  shape: string;
  name?: string;
  agentId?: string;
  sessionId?: string;
  /** Why the dispatch never started the reviewer; absent for a started one. */
  refused?: string;
  verdict?: true;
}

/** The run state TP-3796 adds: the reviewers of the review in flight, and of every failed round counted so far. */
export interface NoVerdictState {
  roundReviewers: ReviewerSeen[];
  failedReviewers: ReviewerSeen[];
  /** True once a counted failed round had an adversary that returned a verdict: D7's case, never a diagnosis. */
  adversaryHeard: boolean;
}

export const freshNoVerdictState = (): NoVerdictState => ({ roundReviewers: [], failedReviewers: [], adversaryHeard: false });

const CORRECTNESS = "correctness";
const MEMBER_SHAPES: ReadonlySet<string> = new Set(["adversary", "tests", "visual", "perf"]);

const Intent = z.looseObject({ kind: z.literal("intent"), reviewer: z.string(), panelReviewers: z.record(z.string(), z.string()).optional() });
const Started = z.looseObject({ kind: z.literal("dispatched"), agentId: z.string(), sessionId: z.string() });
const Refused = z.looseObject({ kind: z.literal("none"), reason: z.string().optional(), refused: z.string().optional() });
const Heard = z.looseObject({ kind: z.literal("verdict") });

/** `<step>:<head>[:<shape>][:corrected]`; a step with no member shape is the correctness reviewer's. */
function placeOf(stepId: string): { head: string; shape: string } | undefined {
  const [, head, third] = stepId.split(":");
  if (head === undefined) return undefined;
  return { head, shape: third !== undefined && MEMBER_SHAPES.has(third) ? third : CORRECTNESS };
}

function seen(run: NoVerdictState, head: string, shape: string): ReviewerSeen {
  const found = run.roundReviewers.find((reviewer) => reviewer.head === head && reviewer.shape === shape);
  if (found !== undefined) return found;
  const added: ReviewerSeen = { head, shape };
  run.roundReviewers.push(added);
  return added;
}

function noteIntent(run: NoVerdictState, head: string, result: unknown): void {
  const intent = Intent.safeParse(result);
  if (!intent.success) return;
  seen(run, head, CORRECTNESS).name = intent.data.reviewer;
  for (const [shape, name] of Object.entries(intent.data.panelReviewers ?? {})) seen(run, head, shape).name = name;
}

function noteDispatch(reviewer: ReviewerSeen, result: unknown): void {
  const started = Started.safeParse(result);
  if (started.success) Object.assign(reviewer, { agentId: started.data.agentId, sessionId: started.data.sessionId });
  const refused = Refused.safeParse(result);
  if (refused.success) reviewer.refused = refused.data.reason ?? refused.data.refused ?? "the dispatch started no reviewer";
}

/** Taps a review's recorded steps, so a replay rebuilds who reviewed each round as surely as the live run saw it. */
export function noteReviewerStep(run: NoVerdictState, stepId: string, result: unknown): void {
  const intent = stepIdMatches(REVIEW_INTENT_STEP, stepId);
  const place = placeOf(stepId);
  if (place === undefined) return;
  if (intent) return noteIntent(run, place.head, result);
  if (stepIdMatches(REVIEW_STEP, stepId)) return noteDispatch(seen(run, place.head, place.shape), result);
  if (stepIdMatches(AWAIT_VERDICT_STEP, stepId) && Heard.safeParse(result).success) seen(run, place.head, place.shape).verdict = true;
}

/** A panel's adversaries are its members beside correctness; a review with no member has its one reviewer as adversary. */
function adversaryVerdict(reviewers: readonly ReviewerSeen[]): boolean {
  const members = reviewers.filter((reviewer) => reviewer.shape !== CORRECTNESS);
  return (members.length > 0 ? members : reviewers).some((reviewer) => reviewer.verdict === true);
}

/** A failed round's reviewers join the run's; the review in flight starts its own list. */
export function countFailedReviewers(run: NoVerdictState): void {
  run.failedReviewers.push(...run.roundReviewers);
  if (adversaryVerdict(run.roundReviewers)) run.adversaryHeard = true;
  run.roundReviewers = [];
}
