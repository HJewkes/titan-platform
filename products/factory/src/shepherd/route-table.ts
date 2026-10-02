/** GitHub's `mergeable_state` values; a value GitHub adds later is read as `unknown`. */
export const MERGEABLE_STATES = ["clean", "blocked", "behind", "unstable", "dirty", "unknown", "draft", "has_hooks"] as const;
export type MergeableState = (typeof MERGEABLE_STATES)[number];

/** What the review of one green head came to, read after the review ends. */
export const REVIEW_OUTCOMES = ["MERGE", "FIX_FIRST", "no-verdict", "timeout", "head-moved", "external-hold"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** Whether the PR is still Shepherd's to land, or was merged or closed by someone else. */
export const RUN_STATES = ["open", "merged-elsewhere", "closed-elsewhere"] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * Every route is autonomous. `merge` goes to the merge decision; `update-branch` and `new-cycle` start the next land
 * round, which updates a behind branch or re-reads a moved or unsettled head; `fresh-reviewer` reviews the same head
 * again under a never-held name; `await-external` reads the hold's reviewer again; `end-run` ends the run.
 */
export const ROUTES = ["merge", "update-branch", "wake-fixer", "fresh-reviewer", "await-external", "new-cycle", "end-run"] as const;
export type Route = (typeof ROUTES)[number];

type Row = Readonly<Record<ReviewOutcome, Route>>;
type Table = Readonly<Record<RunState, Readonly<Record<MergeableState, Row>>>>;

/** A state GitHub will merge through; `blocked` is here because merge facts judge a review-only block. */
const MERGEABLE: Row = { MERGE: "merge", FIX_FIRST: "wake-fixer", "no-verdict": "fresh-reviewer", timeout: "fresh-reviewer", "head-moved": "new-cycle", "external-hold": "await-external" };
const BEHIND: Row = { MERGE: "update-branch", FIX_FIRST: "wake-fixer", "no-verdict": "update-branch", timeout: "update-branch", "head-moved": "new-cycle", "external-hold": "update-branch" };
const DIRTY: Row = { MERGE: "wake-fixer", FIX_FIRST: "wake-fixer", "no-verdict": "wake-fixer", timeout: "wake-fixer", "head-moved": "new-cycle", "external-hold": "wake-fixer" };
const UNSETTLED: Row = { MERGE: "new-cycle", FIX_FIRST: "wake-fixer", "no-verdict": "new-cycle", timeout: "new-cycle", "head-moved": "new-cycle", "external-hold": "new-cycle" };
/** A draft is no merge candidate: the run ends without a gate, and registering the PR again restarts it. */
const DRAFT: Row = { MERGE: "end-run", FIX_FIRST: "wake-fixer", "no-verdict": "end-run", timeout: "end-run", "head-moved": "new-cycle", "external-hold": "end-run" };
const GONE: Row = { MERGE: "end-run", FIX_FIRST: "end-run", "no-verdict": "end-run", timeout: "end-run", "head-moved": "end-run", "external-hold": "end-run" };

const GONE_STATES: Readonly<Record<MergeableState, Row>> = { clean: GONE, blocked: GONE, behind: GONE, unstable: GONE, dirty: GONE, unknown: GONE, draft: GONE, has_hooks: GONE };

/** The one routing table: run state x mergeable_state x review outcome. */
export const ROUTE_TABLE: Table = {
  open: { clean: MERGEABLE, blocked: MERGEABLE, unstable: MERGEABLE, has_hooks: MERGEABLE, behind: BEHIND, dirty: DIRTY, unknown: UNSETTLED, draft: DRAFT },
  "merged-elsewhere": GONE_STATES,
  "closed-elsewhere": GONE_STATES,
};

export function routeFor(run: RunState, state: MergeableState, outcome: ReviewOutcome): Route {
  return ROUTE_TABLE[run][state][outcome];
}

export function mergeableState(raw: string, draft: boolean): MergeableState {
  if (draft) return "draft";
  return (MERGEABLE_STATES as readonly string[]).includes(raw) ? (raw as MergeableState) : "unknown";
}

/** Stuck rounds at one task before the owner is asked. */
export const MAX_FAILED_ROUNDS = 3;
/** FIX_FIRST reviews at one task before the owner is asked; below it each one is progress, so only a runaway stops. */
export const MAX_FIX_FIRSTS = 6;

/** The only reasons Shepherd opens approve-merge; the gate's prompt names one. */
export const ESCALATIONS = {
  conflict: "a merge conflict survived one fixer attempt",
  "policy-denial": "the authority policy did not allow an automated merge",
  "failed-rounds": `${MAX_FAILED_ROUNDS} review rounds failed at this task`,
  "fix-first-runaway": `${MAX_FIX_FIRSTS} FIX_FIRST reviews at this task`,
} as const;
export type Escalation = keyof typeof ESCALATIONS;

/** Why the owner decides one head: which escalation, and what happened there. */
export interface Escalated {
  escalation: Escalation;
  detail: string;
}

/** Routes that retry the same head because nobody answered; each one taken is a stuck round. */
const RETRIES: ReadonlySet<Route> = new Set(["fresh-reviewer", "await-external"]);

/** `stuck` is silence, a timeout or a conflict; a FIX_FIRST is counted on its own, because the fix it asks for is progress. */
export type RoundKind = "stuck" | "fix-first" | "progress";

export function roundKind(route: Route, outcome: ReviewOutcome): RoundKind {
  if (RETRIES.has(route)) return "stuck";
  if (route !== "wake-fixer") return "progress";
  return outcome === "FIX_FIRST" ? "fix-first" : "stuck";
}

/** The gate reason: which escalation, then the detail. */
export function escalationReason(escalation: Escalation, detail: string): string {
  return `${ESCALATIONS[escalation]}: ${detail}`;
}

/** How a finished post-merge main CI read is classified; `cancelled` means every failed run was cancelled. */
export const MAIN_CI_READS = ["green", "red", "cancelled", "cancelled-superseded"] as const;
export type MainCiRead = (typeof MAIN_CI_READS)[number];
export type MainCiRoute = "done" | "main-red" | "read-newer-run";

/** A run that concurrency cancelled because a newer main push superseded it says nothing about main; the newer run does. */
export const MAIN_CI_ROUTES: Readonly<Record<MainCiRead, MainCiRoute>> = { green: "done", red: "main-red", cancelled: "main-red", "cancelled-superseded": "read-newer-run" };
