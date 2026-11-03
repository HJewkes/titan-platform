export {
  createWorktreeAllocator,
  type WorktreeAllocator,
  type WorktreeCheck,
  type WorktreeReleaseOutcome,
  type WorktreeRequest,
} from "./allocator.js";
export { WORKTREE_ADD_TIMEOUT_MS, type WorktreeAddRunner } from "./add.js";
export { fetchDefaultTip, resolveBranchBase, resolveRequestedBase, type BranchBase } from "./branch-base.js";
export { MissingAssignedWorktreeRecordError, OriginUnreachableError, WorktreeBudgetExhaustedError, WorktreeInUseError } from "./errors.js";
export {
  DEFAULT_STRIPPED_ENV_PREFIXES,
  SAFE_GIT_PROTOCOLS,
  pinGitProtocols,
  withPinnedGitProtocols,
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
  DEFAULT_GH_TIMEOUT_MS,
  DEFAULT_WORKTREE_BUDGET,
  RECLAIM_GRACE_MS,
  type WorktreeOptions,
  type ReleaseProof,
} from "./options.js";
export { parkWorktree, type ParkOptions, type ParkIgnoredFilesObservation, type ParkIgnoredFilesPolicy, type ParkLocalBackingObservation, type ParkLocalBackingCandidate, type ParkLocalBackingReader } from "./park.js";
export { reattachWorktree, recreateWorktree, type WorktreeAllocation, type WorktreeRecord } from "./reattach.js";
export { describeRefusal, inspectForRelease, type IgnoredFilesPolicy, type ReleaseCheck, type WorktreeReleaseSafety } from "./release-safety.js";
export {
  DEFAULT_SETUP_TIMEOUT_MS,
  NPMRC_FILE,
  PNPM_WORKSPACE_FILE,
  parseSetupStep,
  runSetupCommand,
  runWorktreeSetup,
  SETUP_FILE,
  SETUP_LOG,
  setupEnv,
  setupWorktree,
  type SetupOutcome,
  type SetupReport,
  type SetupResult,
  type SetupRunner,
  type SetupStep,
  type SetupTarget,
} from "./setup.js";
export {
  agentWorktreesIn,
  porcelain as listWorktreesPorcelain,
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
