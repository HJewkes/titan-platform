/** A claim with no `namePrefix` names its agents `bd-...`, as every claim did before seats. */
export const DEFAULT_NAME_PREFIX = "bd";

/** The agent name, and so the worktree directory, a tick spawn for `taskId` (and `slice`) would use. */
export const agentNameFor = (taskId: string, slice?: string, prefix = DEFAULT_NAME_PREFIX): string =>
  `${prefix}-${taskId.toLowerCase()}${slice === undefined ? "" : `-${slice.toLowerCase()}`}`;

/** The `attempt`th successor, which adopts the original's worktree rather than cutting its own. */
export const successorNameFor = (taskId: string, attempt: number, slice?: string, prefix = DEFAULT_NAME_PREFIX): string =>
  `${agentNameFor(taskId, slice, prefix)}-s${attempt}`;

export const reviewerNameFor = (taskId: string, round: number, slice?: string, prefix = DEFAULT_NAME_PREFIX): string =>
  `${agentNameFor(taskId, slice, prefix)}-r${round}`;
