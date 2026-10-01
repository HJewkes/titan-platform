export {
  createWorktreeAllocator,
  type WorktreeAllocator,
  type WorktreeCheck,
  type WorktreeReleaseOutcome,
  type WorktreeRequest,
} from "./allocator.js";
export { WORKTREE_ADD_TIMEOUT_MS, type WorktreeAddRunner } from "./add.js";
export { resolveBranchBase, type BranchBase } from "./branch-base.js";
export { OriginUnreachableError, WorktreeBudgetExhaustedError, WorktreeInUseError } from "./errors.js";
export {
  DEFAULT_STRIPPED_ENV_PREFIXES,
  findGitRoot,
  gitChildEnv,
  observedPresence,
  runGit,
  type GitPresence,
  type GitRunner,
} from "./git.js";
export { pruneStaleWorktrees } from "./layout.js";
export {
  BRANCH_PREFIX,
  DEFAULT_BASE_PATH,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_WORKTREE_BUDGET,
  RECLAIM_GRACE_MS,
  type WorktreeOptions,
} from "./options.js";
export { parkWorktree } from "./park.js";
export { reattachWorktree, recreateWorktree, type WorktreeAllocation, type WorktreeRecord } from "./reattach.js";
export { describeRefusal, inspectForRelease, type ReleaseCheck, type WorktreeReleaseSafety } from "./release-safety.js";
export {
  DEFAULT_SETUP_TIMEOUT_MS,
  parseSetupStep,
  runSetupCommand,
  runWorktreeSetup,
  SETUP_FILE,
  SETUP_LOG,
  setupEnv,
  type SetupResult,
  type SetupRunner,
  type SetupStep,
  type SetupTarget,
} from "./setup.js";
export {
  agentWorktreesIn,
  isLive,
  reclaimWorktree,
  sweepWorktrees,
  type FoundWorktree,
  type GitLister,
  type HeldWorktree,
  type SweepOptions,
  type SweepOwner,
  type SweepStatus,
  type SweptWorktree,
} from "./sweep.js";
