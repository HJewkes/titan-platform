import type { FailureClass } from "./types.js";

/** The heals a policy row may name; a heal never pushes to the PR. */
export type HealKind = "refresh-checkout" | "degrade-headroom" | "retarget" | "await-account";

/**
 * One same-head attempt kind, taken `times` times in order before the row's `then`. `late-read` reads the member's
 * transcript once more before a fresh member is spawned. `times: null` means the attempt is never counted.
 */
export type RetryStep =
  | { action: "retry" | "correct" | "late-read"; times: number }
  | { action: "heal"; heal: HealKind; times: number | null };

/** The key S7's fixer fingerprint is built from, joined with the class's own detail (a profile name, a shape, a step id). */
export type FixerKey = "profile" | "dispatch" | "timeout" | "parser" | "plan-aggregate-mismatch" | "repeat" | "schema";

/** What follows once a row's steps are spent; there is no owner action (decision 515). */
export type RetryTerminal =
  | { kind: "fixer"; key: FixerKey }
  | { kind: "stop"; outcome: "no-verdict" | "NO_REPRO" | "proof-spec-problem" }
  /** Not a failure: the heal resolves it, so nothing follows. */
  | { kind: "none" };

export interface RetryRule {
  class: FailureClass;
  steps: readonly RetryStep[];
  then: RetryTerminal;
  /** Takes the place of `then` when a shortfall's missing seat is not the fix-proof's. */
  otherwise?: RetryTerminal;
}

export type RetryPolicy = readonly RetryRule[];

/** One row per failure class (plan TP-3916 §(b)); a hill-climbing variant replaces rows, never code. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = [
  { class: "never-started", steps: [{ action: "retry", times: 1 }], then: { kind: "stop", outcome: "no-verdict" } },
  { class: "start-refused:profile", steps: [], then: { kind: "fixer", key: "profile" } },
  {
    class: "start-refused:headroom",
    steps: [{ action: "heal", heal: "degrade-headroom", times: 1 }],
    then: { kind: "stop", outcome: "no-verdict" },
  },
  { class: "start-refused:other", steps: [{ action: "retry", times: 1 }], then: { kind: "fixer", key: "dispatch" } },
  {
    class: "timeout",
    steps: [
      { action: "late-read", times: 1 },
      { action: "retry", times: 1 },
    ],
    then: { kind: "fixer", key: "timeout" },
  },
  { class: "throttled", steps: [], then: { kind: "stop", outcome: "no-verdict" } },
  { class: "usage-limit", steps: [{ action: "heal", heal: "await-account", times: null }], then: { kind: "none" } },
  {
    class: "malformed",
    steps: [
      { action: "correct", times: 1 },
      { action: "retry", times: 1 },
    ],
    then: { kind: "fixer", key: "parser" },
  },
  { class: "stale-head", steps: [{ action: "heal", heal: "retarget", times: null }], then: { kind: "none" } },
  {
    class: "shortfall",
    steps: [],
    then: { kind: "stop", outcome: "NO_REPRO" },
    otherwise: { kind: "fixer", key: "plan-aggregate-mismatch" },
  },
  { class: "deterministic-repeat", steps: [], then: { kind: "fixer", key: "repeat" } },
  { class: "schema-drift", steps: [], then: { kind: "fixer", key: "schema" } },
  { class: "proof-spec-problem", steps: [], then: { kind: "stop", outcome: "proof-spec-problem" } },
];
