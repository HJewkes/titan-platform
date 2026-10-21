export class WorktreeBudgetExhaustedError extends Error {
  constructor(readonly allocated: number, readonly budget: number) {
    super(`Worktree budget exhausted: ${allocated}/${budget} allocated`);
    this.name = "WorktreeBudgetExhaustedError";
  }
}

/**
 * Adoption is impossible: something is still holding the branch or the path.
 *
 * Distinct from "the branch holds work", which is recoverable by adopting it.
 * This one means a live agent of the same name already has the worktree, or a
 * directory is sitting in the way: cases where proceeding would clobber files
 * nobody has agreed to lose.
 */
export class WorktreeInUseError extends Error {
  constructor(readonly branch: string, readonly worktreePath: string) {
    super(
      `${worktreePath} is still on disk and holds branch ${branch}. Another agent of this name may be ` +
        "live. Release it, spawn under a different name, or force the allocation to discard it."
    );
    this.name = "WorktreeInUseError";
  }
}

/** Origin could not answer whether it holds the branch, so a fresh fork might discard real work. */
export class OriginUnreachableError extends Error {
  constructor(readonly branch: string, detail: string) {
    super(
      `cannot reach origin to look for branch ${branch} (${detail}); it may still hold the agent's work, ` +
        "so the worktree was not re-created. Fix the remote and resume again."
    );
    this.name = "OriginUnreachableError";
  }
}

/** A missing assigned tree cannot be re-created without its caller's matching allocation record. */
export class MissingAssignedWorktreeRecordError extends Error {
  constructor(readonly worktreePath: string) {
    super(
      `assigned worktree ${worktreePath} does not exist, and there is no record of allocating it ` +
        "to re-create it from. Not spawned"
    );
    this.name = "MissingAssignedWorktreeRecordError";
  }
}
