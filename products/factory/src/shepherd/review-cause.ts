import type { StepResult, WorkflowContext, WorkflowRun } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import { CARRYING_KINDS } from "./carry-merge.js";
import { isCorrectionFailure } from "./correct-verdict.js";
import { DEPTH_FLOOR_REASON } from "./depth-floor.js";
import type { Verdict, WakeRequest } from "./phases.js";
import type { ReviewOutcome } from "./route-table.js";
import { ReviewCauseSchema, type ReviewCause, type ReviewCauseKind } from "./review-schemas.js";
import { inRange, isoWeek } from "./stats.js";

export type { ReviewCause } from "./review-schemas.js";

/** Why a MERGE did not carry to a moved head, for `merge-up-not-carried` and `seat-push`. */
type CarryRefusal = "base-unknown" | "not-one-merge" | "base-off-branch" | "remerge-touched" | "probe-failed" | "seat";

/** Why the same head was reviewed again, for `retry`. */
type RetryReason = "timeout" | "no-verdict" | "depth-floor" | "malformed" | "not-started";

/** The run's previous review: the head it was at, what it came to, and its verdict. */
export interface LastReview {
  headSha: string;
  outcome: ReviewOutcome;
  verdict: Verdict;
}

/** What the carry steps answered at a new head, read from their recorded results. */
export interface CarryProbe {
  kind?: string | null;
  baseRef?: string | null;
  remergeReason?: string;
  seatClear?: boolean;
}

/** The run's own record up to a review; none of it costs a GitHub call. */
export interface CauseFacts {
  headSha: string;
  last?: LastReview;
  /** A resync cancelled a gate at this head and asked for its review again. */
  ownerAsked: boolean;
  /** The latest wake since the last review. */
  woken?: WakeRequest["kind"];
  /** Heads Shepherd's own update-branch pushed. */
  updated: ReadonlySet<string>;
  /** Absent when the run had no MERGE to carry, so no carry step ran. */
  carry?: CarryProbe;
}

const record = (result: unknown): Record<string, unknown> => (typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const nullableText = (value: unknown): string | null => text(value) ?? null;

/** Folds one carry step's recorded answer into the probe; any other step is ignored. */
export function noteCarryStep(probe: CarryProbe, stepId: string, result: unknown): void {
  const answer = record(result);
  if (stepIdMatches("sh-carry-scope", stepId)) Object.assign(probe, { kind: nullableText(answer.kind), baseRef: nullableText(answer.baseRef) });
  else if (stepIdMatches("sh-remerge", stepId) && answer.carries !== true) probe.remergeReason = text(answer.reason) ?? "";
  else if (stepIdMatches("sh-carry-seat", stepId)) probe.seatClear = answer.clear === true;
}

/** The remerge probe's refusal text, as `remerge-carry.ts` words it, to its closed name. */
function remergeRefusal(reason: string): CarryRefusal {
  if (/ is not [0-9a-f]+ plus one merge$/.test(reason)) return "not-one-merge";
  if (/^second parent \S+ is not on /.test(reason)) return "base-off-branch";
  if (reason.includes("outside the declared generated files")) return "remerge-touched";
  return "probe-failed";
}

function carryRefusal(probe: CarryProbe): { kind: string } | { reason: CarryRefusal } {
  if (probe.kind === undefined || probe.kind === null || !CARRYING_KINDS.has(probe.kind)) return { kind: probe.kind ?? "unregistered" };
  if (probe.baseRef === null || probe.baseRef === undefined) return { reason: "base-unknown" };
  if (probe.seatClear === false) return { reason: "seat" };
  return { reason: probe.remergeReason === undefined ? "probe-failed" : remergeRefusal(probe.remergeReason) };
}

function retryReason({ outcome, verdict }: LastReview): RetryReason {
  const reason = verdict.kind === "none" ? verdict.reason : undefined;
  if (outcome === "not-started") return "not-started";
  if (reason === DEPTH_FLOOR_REASON) return "depth-floor";
  if (isCorrectionFailure(reason)) return "malformed";
  return outcome === "timeout" ? "timeout" : "no-verdict";
}

const RETRIED: ReadonlySet<ReviewOutcome> = new Set(["no-verdict", "timeout", "not-started"]);

function sameHeadCause(last: LastReview, ownerAsked: boolean): ReviewCause {
  if (ownerAsked) return { cause: "owner-request" };
  if (last.outcome === "external-hold") return { cause: "hold" };
  return RETRIED.has(last.outcome) ? { cause: "retry", reason: retryReason(last) } : { cause: "unknown" };
}

const WOKEN: Readonly<Record<WakeRequest["kind"], ReviewCauseKind>> = { review: "fix-round", "fix-proof": "fix-round", conflict: "conflict", "ci-red": "ci-fix" };

/** A new head: who moved it, and, after a MERGE, why that MERGE did not carry to it. */
function movedHeadCause(facts: CauseFacts, last: LastReview): ReviewCause {
  if (last.outcome === "head-moved") return { cause: "superseded" };
  if (last.verdict.kind === "FIX_FIRST" || last.verdict.kind === "NO_REPRO") return { cause: "fix-round" };
  if (facts.woken) return { cause: WOKEN[facts.woken] };
  const mover = facts.updated.has(facts.headSha) ? "update-branch" : "seat-push";
  if (!facts.carry) return { cause: mover };
  const refused = carryRefusal(facts.carry);
  if ("kind" in refused) return { cause: "kind-no-carry", reason: refused.kind };
  return { cause: mover === "update-branch" ? "merge-up-not-carried" : "seat-push", reason: refused.reason };
}

/** Why the review about to be dispatched at `facts.headSha` is happening, from the run's own history. */
export function reviewCause(facts: CauseFacts): ReviewCause {
  const { last } = facts;
  if (!last) return { cause: "first" };
  return last.headSha === facts.headSha ? sameHeadCause(last, facts.ownerAsked) : movedHeadCause(facts, last);
}

/** What a run notes between reviews to name the next one's cause; replay rebuilds it like the rest of the run state. */
export interface CauseTrail {
  last?: LastReview;
  woken?: WakeRequest["kind"];
  updated: Set<string>;
  ownerAsked: Set<string>;
}

export const newCauseTrail = (): CauseTrail => ({ updated: new Set(), ownerAsked: new Set() });

/** The cause of the review about to be dispatched at `headSha`; the wake and the owner's ask it explains are spent. */
export function takeCause(trail: CauseTrail, headSha: string, probe: CarryProbe): ReviewCause {
  const carried = "kind" in probe ? { carry: probe } : {};
  const cause = reviewCause({ headSha, ownerAsked: trail.ownerAsked.has(headSha), updated: trail.updated, ...(trail.last && { last: trail.last }), ...(trail.woken && { woken: trail.woken }), ...carried });
  trail.woken = undefined;
  trail.ownerAsked.delete(headSha);
  return cause;
}

export const causeLabel =({ cause, reason }: ReviewCause): string => (reason === undefined ? cause : `${cause}(${reason})`);

/** `ctx` with every dispatch's result also handed to `tap`, so a caller can read the steps a helper ran. */
export function tapped(ctx: WorkflowContext, tap: (stepId: string, result: unknown) => void): WorkflowContext {
  const dispatch: WorkflowContext["dispatch"] = async (stepId, template, options) => {
    const done = await ctx.dispatch(stepId, template, options);
    tap(stepId, done.data?.result);
    return done;
  };
  return new Proxy(ctx, {
    get: (target, key) => {
      if (key === "dispatch") return dispatch;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export interface ReviewCauseRow {
  repo: string;
  /** ISO week of the dispatch, e.g. `2026-W41`. */
  week: string;
  reviews: number;
  /** Dispatches per `causeLabel`. */
  causes: Record<string, number>;
}

/** The cause a recorded intent names; an intent from before causes, or one that does not parse, is `unknown`. */
function recordedCause(result: StepResult): ReviewCause | undefined {
  const intent = record(result.data?.result);
  if (intent.kind !== "intent") return undefined;
  const parsed = ReviewCauseSchema.safeParse(intent.cause);
  return parsed.success ? parsed.data : { cause: "unknown" };
}

/** Per repo and ISO week: every review Shepherd dispatched, counted by why it was dispatched. */
export function reviewCauseStats(runs: readonly WorkflowRun[], range: { from?: string; to?: string } = {}): ReviewCauseRow[] {
  const rows = new Map<string, ReviewCauseRow>();
  for (const run of runs) {
    const repo = run.params.repo?.toLowerCase();
    if (!repo) continue;
    for (const result of Object.values(run.stepResults)) {
      const cause = stepIdMatches("sh-review-intent", result.stepId) ? recordedCause(result) : undefined;
      const at = Date.parse(result.completedAt);
      if (!cause || !inRange(at, range)) continue;
      const week = isoWeek(at);
      const row = rows.get(`${repo} ${week}`) ?? { repo, week, reviews: 0, causes: {} };
      rows.set(`${repo} ${week}`, row);
      row.reviews++;
      row.causes[causeLabel(cause)] = (row.causes[causeLabel(cause)] ?? 0) + 1;
    }
  }
  return [...rows.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.week.localeCompare(b.week));
}
