import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import { AWAIT_VERDICT_STEP } from "./await-verdict.js";
import { REVIEW_INTENT_STEP } from "./review.js";
import { PANEL_STEPS } from "./review-panel-step.js";
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

/** A counted panel round as the next one at its head is compared against (TP-3910). */
interface PanelPrint {
  head: string;
  outcome: string;
  /** The seats with no verdict, sorted and joined; `unplanned` when every dispatched member answered. */
  missing: string;
  /** A member failed to start or its wait ran out, so another review could answer differently. */
  infra: boolean;
}

/** The run state TP-3796 adds: the reviewers of the review in flight, and of every failed round counted so far. */
export interface NoVerdictState {
  roundReviewers: ReviewerSeen[];
  failedReviewers: ReviewerSeen[];
  /** True once a counted failed round had an adversary that returned a verdict: D7's case, never a diagnosis. */
  adversaryHeard: boolean;
  /** The outcome of the review in flight's panel record; absent when it recorded none, as a single-reviewer review does not. */
  roundOutcome?: string;
  /** A member of the review in flight waited out its deadline with no verdict. */
  roundRanOut?: boolean;
  /** The last counted round's panel print. */
  lastPanel?: PanelPrint;
}

export const freshNoVerdictState = (): NoVerdictState => ({ roundReviewers: [], failedReviewers: [], adversaryHeard: false, roundOutcome: undefined, roundRanOut: undefined, lastPanel: undefined });

const CORRECTNESS = "correctness";
const MEMBER_SHAPES: ReadonlySet<string> = new Set(["adversary", "tests", "visual", "perf"]);

const Intent = z.looseObject({ kind: z.literal("intent"), reviewer: z.string(), panelReviewers: z.record(z.string(), z.string()).optional() });
const Started = z.looseObject({ kind: z.literal("dispatched"), agentId: z.string(), sessionId: z.string() });
const Refused = z.looseObject({ kind: z.literal("none"), reason: z.string().optional(), refused: z.string().optional() });
const Heard = z.looseObject({ kind: z.literal("verdict") });
const RanOut = z.looseObject({ kind: z.literal("none"), ended: z.literal("deadline") });
const PanelRecord = z.looseObject({ outcome: z.string() });

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

function notePanel(run: NoVerdictState, result: unknown): void {
  const panel = PanelRecord.safeParse(result);
  if (panel.success) run.roundOutcome = panel.data.outcome;
}

function noteAwait(run: NoVerdictState, place: { head: string; shape: string }, result: unknown): void {
  if (Heard.safeParse(result).success) seen(run, place.head, place.shape).verdict = true;
  if (RanOut.safeParse(result).success) run.roundRanOut = true;
}

/** Taps a review's recorded steps, so a replay rebuilds who reviewed each round as surely as the live run saw it. */
export function noteReviewerStep(run: NoVerdictState, stepId: string, result: unknown): void {
  if (PANEL_STEPS.some((declared) => stepIdMatches(declared.id, stepId))) return notePanel(run, result);
  const intent = stepIdMatches(REVIEW_INTENT_STEP, stepId);
  const place = placeOf(stepId);
  if (place === undefined) return;
  if (intent) return noteIntent(run, place.head, result);
  if (stepIdMatches(REVIEW_STEP, stepId)) return noteDispatch(seen(run, place.head, place.shape), result);
  if (stepIdMatches(AWAIT_VERDICT_STEP, stepId)) noteAwait(run, place, result);
}

/** A new review's reviewers and panel record start empty. */
export function startRound(run: NoVerdictState): void {
  run.roundReviewers = [];
  run.roundOutcome = undefined;
  run.roundRanOut = undefined;
}

function panelPrint(run: NoVerdictState, head: string): PanelPrint | undefined {
  if (run.roundOutcome === undefined) return undefined;
  const here = run.roundReviewers.filter((reviewer) => reviewer.head === head);
  const silent = here.filter((reviewer) => reviewer.verdict !== true).map((reviewer) => reviewer.shape).sort();
  const infra = run.roundRanOut === true || here.some((reviewer) => reviewer.refused !== undefined);
  return { head, outcome: run.roundOutcome, infra, missing: silent.length > 0 ? silent.join(",") : "unplanned" };
}

/**
 * True when the review in flight repeats the last counted round at the same head: the same panel outcome and the same seats
 * missing, and no member of either failed to start or ran out of time. Another review there cannot answer differently (TP-3910).
 */
export function repeatsLastPanel(run: NoVerdictState, head: string): boolean {
  const now = panelPrint(run, head);
  const last = run.lastPanel;
  if (now === undefined || last === undefined || now.infra || last.infra) return false;
  return now.head === last.head && now.outcome === last.outcome && now.missing === last.missing;
}

/** A panel's adversaries are its members beside correctness; a review with no member has its one reviewer as adversary. */
function adversaryVerdict(reviewers: readonly ReviewerSeen[]): boolean {
  const members = reviewers.filter((reviewer) => reviewer.shape !== CORRECTNESS);
  return (members.length > 0 ? members : reviewers).some((reviewer) => reviewer.verdict === true);
}

/** A failed round's reviewers join the run's; the review in flight starts its own list. */
export function countFailedReviewers(run: NoVerdictState, head: string): void {
  run.failedReviewers.push(...run.roundReviewers);
  if (adversaryVerdict(run.roundReviewers)) run.adversaryHeard = true;
  run.lastPanel = panelPrint(run, head);
  startRound(run);
}
