import type { TestOnlyDiff } from "./test-only-diff.js";

type KindGuard = typeof kindMoveRefusal;

/** What a correctness run's move off the fix-proof kinds needs: no review started at any head, and a stated reason. */
export interface EarlyMove {
  /** Undefined when the run could not be read, which refuses the move. */
  reviewStarted: boolean | undefined;
  reason: string | undefined;
  /** Who asked for the move, for its event. */
  actor?: string;
}

/** The guard a register applies, and the PR's diff facts and review state it reads them with. */
export interface KindMove {
  guard: KindGuard;
  diff: TestOnlyDiff | undefined;
  early?: EarlyMove;
}

export const TASK_KINDS = ["correctness", "security", "feature", "refactor", "test-only", "unknown"] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

/** The kinds whose runs read the fix-proof result (`gateOf` in fix-proof.ts); a fix/ branch adds the gate to any kind. */
export const FIX_PROOF_KINDS: ReadonlySet<TaskKind> = new Set(["correctness", "security", "test-only"]);

/**
 * Why a move from `from` into test-only is refused. Only a correctness run needs diff facts: test-only is
 * the one fix-proof kind it may move to, and only when the PR's diff, read in full, reads test-only; every other reading refuses.
 */
export function testOnlyMoveRefusal(from: TaskKind, diff: TestOnlyDiff | undefined): string | undefined {
  if (from !== "correctness") return undefined;
  if (diff === undefined) return `kind ${from} cannot move to test-only without reading the PR's diff`;
  if (diff.kind !== "test-only") return `kind ${from} cannot move to test-only: ${reasonOf(diff)}`;
  return undefined;
}

function reasonOf(diff: Exclude<TestOnlyDiff, { kind: "test-only" }>): string {
  switch (diff.kind) {
    case "source":
      return `the PR changes non-test source ${diff.paths[0] ?? "(unnamed)"}`;
    case "flagged":
    case "unread":
      return diff.reason;
  }
}

/** The kinds a correctness run may move to before any review starts, at a head whose proof cannot reproduce (TP-5399). */
const EARLY_MOVE_KINDS: ReadonlySet<TaskKind> = new Set(["refactor", "feature"]);

/** Undefined when a correctness run may leave the fix-proof kinds for `to`; otherwise what the move still lacks. */
function earlyMoveRefusal(from: TaskKind, to: TaskKind, early: EarlyMove | undefined): string | undefined {
  const refused = `kind ${from} cannot move to ${to}, which is outside the fix-proof kinds`;
  if (from !== "correctness" || !EARLY_MOVE_KINDS.has(to)) return refused;
  if (early?.reviewStarted === undefined) return `${refused}: whether a review has started could not be read`;
  if (early.reviewStarted) return `${refused}: a review has started, so the kind it was briefed on stays`;
  return early.reason === undefined ? `${refused} without --kind-reason, which the move's event records` : undefined;
}

/**
 * Why an explicit move from `from` to `to` is refused, or undefined when it applies. A security run never leaves security,
 * because only the other kinds may carry a reviewed MERGE across a tree-equal update (`CARRYING_KINDS`, MRG-AU-RC). A security
 * run's owner approval follows one thing only, Shepherd's own disjoint clean merge-up (`OWN_MERGE_UP_KINDS`).
 * A fix-proof kind may not move outside `FIX_PROOF_KINDS`, because `gateOf` runs fix-proof for exactly those kinds; moving out
 * would drop the gate, so an implementer cannot relabel a run past its proof (TP-1506). TP-5399 narrows that: a correctness run
 * may move to refactor or feature before any review starts, with a reason the store records as an event, since a proof that
 * cannot reproduce (a docs fix, a same-value rename) otherwise dead-ends. Once a review starts the move is refused as before.
 * `diff` is the PR's test-only classification, read for a move into test-only.
 */
export function kindMoveRefusal(from: TaskKind, to: TaskKind, diff?: TestOnlyDiff, early?: EarlyMove): string | undefined {
  if (from === "security" && to !== "security") {
    return `kind ${from} cannot move to ${to}: a security run keeps its fresh reviewer, and ${to} would let it carry a reviewed MERGE across an update`;
  }
  if (FIX_PROOF_KINDS.has(from) && !FIX_PROOF_KINDS.has(to)) return earlyMoveRefusal(from, to, early);
  if (to !== "test-only" || from === "test-only") return undefined;
  return testOnlyMoveRefusal(from, diff);
}
