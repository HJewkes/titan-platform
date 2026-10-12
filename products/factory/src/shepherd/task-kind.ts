export const TASK_KINDS = ["correctness", "security", "feature", "refactor", "unknown"] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

const FIX_PROOF_KINDS: ReadonlySet<TaskKind> = new Set(["correctness", "security"]);

/**
 * Why an explicit move from `from` to `to` is refused, or undefined when it applies. A security run never leaves security,
 * because only the other kinds may carry a reviewed MERGE across a tree-equal update (`CARRYING_KINDS`, MRG-AU-RC).
 * A correctness run may not move to a kind outside `FIX_PROOF_KINDS`. Nothing reads the kind to run or skip fix-proof today;
 * these refusals are a guard on the stored kind, not a gate.
 */
export function kindMoveRefusal(from: TaskKind, to: TaskKind): string | undefined {
  if (from === "security" && to !== "security") {
    return `kind ${from} cannot move to ${to}: a security run keeps its fresh reviewer, and ${to} would let it carry a reviewed MERGE across an update`;
  }
  if (FIX_PROOF_KINDS.has(from) && !FIX_PROOF_KINDS.has(to)) {
    return `kind ${from} cannot move to ${to}, which is outside the fix-proof kinds`;
  }
  return undefined;
}
