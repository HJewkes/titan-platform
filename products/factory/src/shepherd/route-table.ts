/** GitHub's `mergeable_state` values; a value GitHub adds later is read as `unknown`. */
export const MERGEABLE_STATES = ["clean", "blocked", "behind", "unstable", "dirty", "unknown", "draft", "has_hooks"] as const;
export type MergeableState = (typeof MERGEABLE_STATES)[number];

/** What the review of one green head came to, read after the review ends. */
export const REVIEW_OUTCOMES = ["MERGE", "FIX_FIRST", "no-verdict", "timeout", "head-moved", "external-hold", "not-started"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** Whether the PR is still Shepherd's to land, or was merged or closed by someone else. */
export const RUN_STATES = ["open", "merged-elsewhere", "closed-elsewhere"] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * Every route is autonomous. `merge` goes to the merge decision; `update-branch` and `new-cycle` start the next land
 * round, which updates a behind branch or re-reads a moved or unsettled head; `fresh-reviewer` reviews the same head
 * again under a never-held name; `retry-review` asks again for the reviewer a busy broker never started;
 * `await-external` reads the hold's reviewer again; `end-run` ends the run.
 */
export const ROUTES = ["merge", "update-branch", "wake-fixer", "fresh-reviewer", "retry-review", "await-external", "new-cycle", "end-run"] as const;
export type Route = (typeof ROUTES)[number];

type Row = Readonly<Record<ReviewOutcome, Route>>;
type Table = Readonly<Record<RunState, Readonly<Record<MergeableState, Row>>>>;

/** A state GitHub will merge through; `blocked` is here because merge facts judge a review-only block. */
const MERGEABLE: Row = { MERGE: "merge", FIX_FIRST: "wake-fixer", "no-verdict": "fresh-reviewer", timeout: "fresh-reviewer", "head-moved": "new-cycle", "external-hold": "await-external", "not-started": "retry-review" };
/** A behind head whose reviewer never started still needs its review: `update-branch` would go on to the merge decision with no review at all. */
const BEHIND: Row = { MERGE: "update-branch", FIX_FIRST: "wake-fixer", "no-verdict": "update-branch", timeout: "update-branch", "head-moved": "new-cycle", "external-hold": "update-branch", "not-started": "retry-review" };
const DIRTY: Row = { MERGE: "wake-fixer", FIX_FIRST: "wake-fixer", "no-verdict": "wake-fixer", timeout: "wake-fixer", "head-moved": "new-cycle", "external-hold": "wake-fixer", "not-started": "wake-fixer" };
const UNSETTLED: Row = { MERGE: "new-cycle", FIX_FIRST: "wake-fixer", "no-verdict": "new-cycle", timeout: "new-cycle", "head-moved": "new-cycle", "external-hold": "new-cycle", "not-started": "new-cycle" };
/** A draft is no merge candidate: the run ends without a gate, and registering the PR again restarts it. */
const DRAFT: Row = { MERGE: "end-run", FIX_FIRST: "wake-fixer", "no-verdict": "end-run", timeout: "end-run", "head-moved": "new-cycle", "external-hold": "end-run", "not-started": "end-run" };
const GONE: Row = { MERGE: "end-run", FIX_FIRST: "end-run", "no-verdict": "end-run", timeout: "end-run", "head-moved": "end-run", "external-hold": "end-run", "not-started": "end-run" };

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
const MAX_FIX_FIRSTS = 6;
/** Consecutive FIX_FIRST reviews whose Closer line said no before the owner is asked; a review with no Closer line never counts. */
const MAX_NO_CLOSER_STREAK = 2;
/** Fixer wakes of every kind at one run, counted across heads, before the owner is asked; FIX_FIRST keeps its own tighter cap too. */
export const MAX_REPAIRS = 10;

/** The only reasons Shepherd opens approve-merge; the gate's prompt names one. */
export const ESCALATIONS = {
  /** The fixer already had the conflict files and its head still conflicts, so a second wake would likely repeat it; by design (TP-1753). */
  conflict: "a merge conflict survived one fixer attempt",
  "policy-denial": "the authority policy did not allow an automated merge",
  "failed-rounds": `${MAX_FAILED_ROUNDS} review rounds failed at this task`,
  "fix-first-runaway": `${MAX_FIX_FIRSTS} FIX_FIRST reviews at this task`,
  "no-progress": `${MAX_NO_CLOSER_STREAK} FIX_FIRST reviews in a row said the head is no closer to MERGE`,
  "repair-budget": `${MAX_REPAIRS} fixer wakes at this run`,
} as const;
export type Escalation = keyof typeof ESCALATIONS;

/** How a failed-rounds gate names the outcome of its last round. */
export const FAILED_ROUND_WORDS: Partial<Record<ReviewOutcome, string>> = {
  "no-verdict": "no reviewer verdict",
  timeout: "no reviewer verdict before the wait ran out",
  "external-hold": "no verdict yet from the reviewer the hold names",
};

/** Why the owner decides one head: which escalation, and what happened there. */
export interface Escalated {
  escalation: Escalation;
  detail: string;
}

/** Routes that retry the same head because nobody answered; each one taken is a stuck round. */
const RETRIES: ReadonlySet<Route> = new Set(["fresh-reviewer", "await-external"]);

/**
 * `stuck` is silence, a timeout or a conflict; a FIX_FIRST is counted on its own, because the fix it asks for is progress.
 * `not-started` is no round at all: a busy broker started no reviewer, so nothing at this head failed review.
 */
export type RoundKind = "stuck" | "fix-first" | "progress" | "not-started";

export function roundKind(route: Route, outcome: ReviewOutcome): RoundKind {
  if (outcome === "not-started") return "not-started";
  if (RETRIES.has(route)) return "stuck";
  if (route !== "wake-fixer") return "progress";
  return outcome === "FIX_FIRST" ? "fix-first" : "stuck";
}

/** Consecutive FIX_FIRST rounds that said Closer: no, and the head the last one counted at. */
export interface CloserStreak {
  streak: number;
  head?: string;
}

/** Any other round, or a missing or yes answer, resets it; a head already counted never counts twice, so a replayed verdict cannot escalate alone. */
export function nextCloserStreak(state: CloserStreak, kind: RoundKind, verdict: { kind: string; closer?: string }, headSha: string): CloserStreak {
  if (kind !== "fix-first" || verdict.kind !== "FIX_FIRST" || verdict.closer !== "no") return { streak: 0 };
  return state.head === headSha ? state : { streak: state.streak + 1, head: headSha };
}

/** The owner is asked once the streak reaches its cap, ahead of the runaway cap; `fixFirsts` includes this round. */
export function fixFirstEscalation(fixFirsts: number, streak: number, headSha: string): Escalated | undefined {
  const detail = `the last at ${headSha}`;
  if (streak >= MAX_NO_CLOSER_STREAK) return { escalation: "no-progress", detail };
  return fixFirsts >= MAX_FIX_FIRSTS ? { escalation: "fix-first-runaway", detail } : undefined;
}

/** The gate reason: which escalation, then the detail. */
export function escalationReason(escalation: Escalation, detail: string): string {
  return `${ESCALATIONS[escalation]}: ${detail}`;
}

/** How a finished post-merge main CI read is classified; `cancelled` means every failed run was cancelled and no later run of its name superseded it. */
export const MAIN_CI_READS = ["green", "red", "cancelled", "cancelled-superseded"] as const;
export type MainCiRead = (typeof MAIN_CI_READS)[number];
export type MainCiRoute = "done" | "main-red" | "read-newer-run" | "wait";

/**
 * A run that concurrency cancelled because a newer main push superseded it says nothing about main; the newer run does.
 * A cancel with no successor is not red either: the read waits for a later run of its name, or its deadline.
 */
export const MAIN_CI_ROUTES = { green: "done", red: "main-red", cancelled: "wait", "cancelled-superseded": "read-newer-run" } as const satisfies Readonly<Record<MainCiRead, MainCiRoute>>;
