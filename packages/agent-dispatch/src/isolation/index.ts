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
