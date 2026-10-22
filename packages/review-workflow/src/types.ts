import type { PanelMember, PanelVerdict, ReviewRequest, ReviewShape, ReviewTarget } from "@titan-design/review-panel";

/** One review of one PR head; the ports carry every read and effect, so the input names only what the caller already knows. */
export interface ReviewHeadInput {
  target: ReviewTarget;
  /** The registered kind; absent means unread, which takes the strict class. */
  kind?: string;
  /** Everything the member briefs carry except the target. */
  brief: ReviewRequest["brief"];
  /** A member a hold requires on top of the planned panel, such as a G10 hold's adversary. */
  hold?: PanelMember;
}

/**
 * Why one member, or the run, failed to reach a verdict. Each class has exactly one row in the retry policy. `throttled`
 * is a `never-started` or `timeout` while the machine stop held, so it goes to the caller's throttle path and never to the fixer.
 */
export const FAILURE_CLASSES = [
  "never-started",
  "start-refused:profile",
  "start-refused:headroom",
  "start-refused:other",
  "timeout",
  "throttled",
  "usage-limit",
  "malformed",
  "stale-head",
  "shortfall",
  "deterministic-repeat",
  "schema-drift",
  "proof-spec-problem",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** How one review of one head ended; the workflow pushes nothing, so catching up to main is always the author's lane. */
export type ReviewOutcome =
  | { kind: "MERGE"; head: string; verdict: PanelVerdict }
  | { kind: "FIX_FIRST"; head: string; verdict: PanelVerdict }
  /** The fix-proof did not reproduce the bug; the author's lane, never counted as FIX_FIRST. */
  | { kind: "NO_REPRO"; head: string; waivable: boolean }
  /** A clean merge-up of `from`, a head the review signed off; no reviewer runs. */
  | { kind: "carried"; head: string; from: string }
  | { kind: "head-moved"; head: string; current: string }
  /** Behind the base and merges clean. */
  | { kind: "needs-update"; head: string }
  | { kind: "conflict"; head: string }
  | { kind: "account-hold"; head: string; resetsAt?: number }
  /** Draft, closed or merged: nothing to review. */
  | { kind: "not-open"; head: string; state: "draft" | "closed" | "merged" }
  | { kind: "ci-not-green"; head: string; ci: "pending" | "failing" }
  /** Every failure was transient and its retry budget is spent. */
  | { kind: "no-verdict"; head: string; classes: readonly FailureClass[] }
  /** A hard error parked the run until `resolve(fingerprint)`. */
  | { kind: "needs-fixer"; head: string; fingerprint: string; failure: FailureClass }
  /** The fix-proof errored on a carried test-support target; the author's lane, with the file named. */
  | { kind: "proof-spec-problem"; head: string; file: string };

export type ReviewOutcomeKind = ReviewOutcome["kind"];

/**
 * The step id each recipe step records under. Shepherd injects its legacy ids so the outcome corpus, which keys on
 * `sh-await-verdict:<head>`, stays continuous.
 */
export interface ReviewStepIds {
  preflight: string;
  heal: string;
  fixProof: string;
  intent: string;
  dispatch: string;
  await: string;
  correct: string;
  lateRead: string;
  aggregate: string;
  fixer: string;
}

export const DEFAULT_REVIEW_STEP_IDS: Readonly<ReviewStepIds> = {
  preflight: "review-preflight",
  heal: "review-heal",
  fixProof: "review-fix-proof",
  intent: "review-intent",
  dispatch: "review-dispatch",
  await: "review-await",
  correct: "review-correct",
  lateRead: "review-late-read",
  aggregate: "review-aggregate",
  fixer: "review-fixer",
};

/** Names a member's agent; the default is review-panel's `memberName`. */
export type MemberNamer = (target: ReviewTarget, shape: ReviewShape, attempt: 1 | 2) => string;
