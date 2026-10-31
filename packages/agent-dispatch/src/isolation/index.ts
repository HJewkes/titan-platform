export type {
  Allocation,
  IsolationContext,
  IsolationStrategy,
  LivePeer,
  ReleaseOptions,
  TreeHolders,
} from "./strategy.js";
export { composite, mergeAllocations } from "./strategy.js";
export {
  createIsolationRegistry,
  type IsolationRegistry,
  type IsolationRegistryOptions,
} from "./registry.js";
export { WARNING_PREFIX, isWarning, refusalsIn, warn } from "./warnings.js";
export { clearRefusal, recordRefusal, refusalOf } from "./refusals.js";
export { noneStrategy } from "./none.js";
export { toolsetStrategy } from "./toolset.js";
export {
  buildOwnershipManifest,
  checkConflicts,
  fileOwnershipStrategy,
  formatOwnershipBrief,
  getAgentOwnershipSummary,
  getOwner,
  getOwners,
  matchPattern,
  type FileOwnershipManifest,
  type FileOwnershipSummary,
  type OwnershipConflict,
  type OwnershipRule,
} from "./file-ownership.js";
export { canonicalPath, isAtOrUnder } from "./paths.js";
export { isReviewerSpawn, isReviewerTreeName } from "./reviewer-names.js";
export {
  adopterBlocker,
  occupantOf,
  parkTenancyBlocker,
  tenantsOf,
  worktreeTenancy,
  type HeldTree,
  type TenancyVerdict,
  type TreeHolder,
} from "./tenancy.js";
export {
  allocatedWorktree,
  liveBlocker,
  parkable,
  parkBlocker,
  type ParkTarget,
} from "./park-rules.js";
export { workBlocker } from "./work-blocker.js";
export { heldBranches, reviewedAgentName, type HeldBranch } from "./held-branches.js";
export {
  connectedBlocker,
  inScope,
  retireFinished,
  SCOPE_REQUIRED,
  STALE_AFTER_MS,
  STALE_RETIRE_CAP,
  type FinishedHolds,
  type FinishedRetireOutcome,
  type FinishedRetirePort,
  type RetirePlanEntry,
  type RetireResult,
  type RetireScope,
} from "./retire-finished.js";
export {
  isFinishedReport,
  NOT_FINISHED,
  retireAtReport,
  type ReportRetirePort,
  type ReportRetireResult,
} from "./retire-at-report.js";
export {
  isVerdictText,
  NO_VERDICT,
  parkImplementerAtExit,
  parkReviewerAtReport,
  type ImplementerParkPort,
  type ParkAtExitResult,
  type ReviewerParkPort,
} from "./park-at-exit.js";
export {
  parsePrState,
  prStateReader,
  prTarget,
  reportPr,
  type GhOutcome,
  type PrHead,
  type PrState,
  type PrStateDeps,
  type PrStateReader,
  type PrTarget,
} from "./pr-state.js";
export {
  isWorkerProfile,
  MERGED_RETIRE_EVERY_MS,
  passPrReads,
  PR_READS_PER_PASS,
  PR_REREAD_MS,
  retireMerged,
  startMergedRetireSweep,
  type MergedRetirePort,
  type MergedRetireResult,
  type PrRead,
} from "./retire-merged.js";
export {
  REVIEWER_TREE_CHANGED,
  reviewerDirtyText,
  runRawGit,
  treeChange,
  treeFingerprint,
  type RawGitRunner,
  type TreeFingerprint,
} from "./reviewer-tree-guard.js";
export { dispatchIgnoredFiles, unsavedWork, type UnsavedWork } from "./unsaved-work.js";
export {
  DEFAULT_REVIEWER_WORKTREE_BUDGET,
  heldBy,
  treeHoldersOf,
  WorktreeBudgetExhaustedError,
  type PoolBudgets,
  type PoolUse,
  type WorktreePool,
} from "./worktree-pool.js";
export {
  createWorktreeStrategy,
  inspectForRelease,
  reattachWorktree,
  recreateWorktree,
  type WorktreeStrategyOptions,
} from "./worktree.js";
