import type { TestOnlyDiff } from "./test-only-diff.js";

export const TASK_KINDS = ["correctness", "security", "feature", "refactor", "test-only", "unknown"] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

/** The kinds whose runs read the fix-proof result (`gateOf` in fix-proof.ts); a fix/ branch adds the gate to any kind. */
export const FIX_PROOF_KINDS: ReadonlySet<TaskKind> = new Set(["correctness", "security", "test-only"]);

/**
 * Until the gate reads test-only diffs and mutants, a run cannot move into test-only at all. A test-only run is gated exactly like
 * correctness meanwhile, so a fresh `--kind test-only` registration loosens nothing.
 */
const TEST_ONLY_GATED: boolean = false;

/**
 * Why a move from `from` into test-only is refused once the kind is live. Only a correctness run needs diff facts: test-only is
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

/**
 * Why an explicit move from `from` to `to` is refused, or undefined when it applies. A security run never leaves security,
 * because only the other kinds may carry a reviewed MERGE across a tree-equal update (`CARRYING_KINDS`, MRG-AU-RC). A security
 * run's owner approval follows one thing only, Shepherd's own disjoint clean merge-up (`OWN_MERGE_UP_KINDS`).
 * A fix-proof kind may not move outside `FIX_PROOF_KINDS`, because `gateOf` runs fix-proof for exactly those kinds; moving out
 * would drop the gate. `diff` is the PR's test-only classification, read for a move into test-only.
 */
export function kindMoveRefusal(from: TaskKind, to: TaskKind, diff?: TestOnlyDiff): string | undefined {
  if (from === "security" && to !== "security") {
    return `kind ${from} cannot move to ${to}: a security run keeps its fresh reviewer, and ${to} would let it carry a reviewed MERGE across an update`;
  }
  if (FIX_PROOF_KINDS.has(from) && !FIX_PROOF_KINDS.has(to)) {
    return `kind ${from} cannot move to ${to}, which is outside the fix-proof kinds`;
  }
  if (to !== "test-only" || from === "test-only") return undefined;
  if (!TEST_ONLY_GATED) return `kind ${from} cannot move to test-only yet: the fix-proof gate does not read test-only diffs`;
  return testOnlyMoveRefusal(from, diff);
}
