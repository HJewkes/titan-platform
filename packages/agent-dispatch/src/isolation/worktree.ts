import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  BRANCH_PREFIX,
  createWorktreeAllocator,
  DEFAULT_BASE_PATH,
  describeRefusal,
  findGitRoot,
  inspectForRelease as inspectWithPackage,
  MissingAssignedWorktreeRecordError,
  pruneStaleWorktrees,
  RECLAIM_GRACE_MS,
  reattachWorktree as platformReattach,
  recreateWorktree as platformRecreate,
  runGit,
  setupWorktree,
  type ReleaseCheck,
  type ReleaseProof,
  type SetupRunner,
  type WorktreeAddRunner,
  type WorktreeAllocation,
  type WorktreeAllocator,
  type WorktreeOptions,
  type WorktreeRecord,
  type WorktreeReleaseSafety,
} from "@titan-design/worktree";
import { clearRefusal, recordRefusal } from "./refusals.js";
import type {
  Allocation,
  IsolationContext,
  IsolationStrategy,
  ReleaseOptions,
  TreeHolders,
} from "./strategy.js";
import { unsavedWork } from "./unsaved-work.js";
import { warn } from "./warnings.js";
import {
  holdingsOf,
  poolBudget,
  poolExhausted,
  poolOf,
  poolUse,
  slug,
  WorktreeBudgetExhaustedError,
  type PoolBudgets,
} from "./worktree-pool.js";

export interface WorktreeStrategyOptions extends PoolBudgets {
  /** Relative to the git root. */
  basePath?: string;
  /** Bound on fetching origin's default branch before cutting a new one. */
  fetchTimeoutMs?: number;
  /** Bound on each `gh pr view` a release makes; a `gh` that outlives it supplies no landing proof. */
  ghTimeoutMs?: number;
  /** Bound on one `git worktree add`; the add is killed and the repo's queue moves on when it passes. */
  addTimeoutMs?: number;
  /** Runs each `git worktree add`; tests inject one to observe how adds interleave. */
  runWorktreeAdd?: WorktreeAddRunner;
  /** Runs the repository's declared setup step; tests inject one so no real install runs. */
  runSetup?: SetupRunner;
  /** CC-1469: read only when a pool refuses, to say who holds its trees. */
  treeHolders?: TreeHolders;
}

const branchFor = (name: string): string => `${BRANCH_PREFIX}${slug(name)}`;

async function recordStackBase(
  gitRoot: string,
  branch: string,
  baseRef: string | undefined,
): Promise<string[]> {
  const key = `branch.${branch}.agent-chat-base`;
  if (baseRef === undefined) {
    await runGit(["config", "--unset", key], gitRoot);
    return [];
  }
  const parent = baseRef.slice("origin/".length);
  if ((await runGit(["config", key, parent], gitRoot)) !== null) return [];
  return [warn(`could not record ${key}=${parent}; pr-ready may not find this branch's stack base`)];
}

function dependencyNote(outcome: string | undefined): string {
  return outcome === "ran"
    ? "The repository's setup step reinstalled its dependencies; build outputs such as dist were not rebuilt, so build before relying on them."
    : "Ignored files such as node_modules and dist were not restored and no setup step reinstalled them, so install dependencies and build before running checks.";
}

function platformOptions(opts: WorktreeStrategyOptions): WorktreeOptions {
  return {
    ...(opts.basePath === undefined ? {} : { basePath: opts.basePath }),
    branchPrefix: BRANCH_PREFIX,
    releaseProof: "git-or-merged-pr-tip",
    ...(opts.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: opts.fetchTimeoutMs }),
    ...(opts.ghTimeoutMs === undefined ? {} : { ghTimeoutMs: opts.ghTimeoutMs }),
    ...(opts.addTimeoutMs === undefined ? {} : { addTimeoutMs: opts.addTimeoutMs }),
    ...(opts.runWorktreeAdd === undefined ? {} : { runWorktreeAdd: opts.runWorktreeAdd }),
    skipSetup: true,
    includeSetupTarget: true,
    allocationGroup: poolOf,
    budget: (name) => poolBudget(poolOf(name), opts),
    budgetError: (allocated, budget, name) =>
      new WorktreeBudgetExhaustedError(allocated, budget, poolOf(name)),
  };
}

function reattachNote(ref: WorktreeAllocation["ref"], dependency: string): string {
  const { worktree, branch, assigned } = ref;
  return assigned === "true"
    ? `The worktree assigned to this task at ${worktree} had been removed and was re-created on branch ${branch}. ${dependency} You may be sharing it with other agents, so stay inside the paths you were given.`
    : `Your worktree at ${worktree} had been removed and was re-created on branch ${branch}. ${dependency} Commit your work there; nothing outside it is yours to change.`;
}

/** Run setup against the engine-selected target after product metadata is recorded. */
async function decorateAllocation(
  rawAllocation: WorktreeAllocation,
  opts: WorktreeStrategyOptions,
  baseRef?: string,
): Promise<Allocation> {
  const { setupTarget: selectedTarget, ...allocation } = rawAllocation;
  const { branch, worktree, gitRoot, base, base_ref: baseRefUsed, reattached, assigned } = allocation.ref;
  if (!branch || !worktree || !gitRoot || !base || !baseRefUsed) return allocation;
  const metadataWarnings =
    reattached || assigned === "true" ? [] : await recordStackBase(gitRoot, branch, baseRef);
  const setup = selectedTarget === undefined ? undefined : await setupWorktree(selectedTarget, opts.runSetup);
  const warnings = [...(allocation.warnings ?? []), ...metadataWarnings, ...(setup?.warnings ?? [])];
  return {
    ...allocation,
    note: reattached ? reattachNote(allocation.ref, dependencyNote(setup?.outcome)) : allocation.note,
    ref: { ...allocation.ref, ...(reattached && setup !== undefined ? { setup: setup.outcome } : {}) },
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function reattachWorktree(
  record: WorktreeRecord,
  opts: WorktreeStrategyOptions = {},
  requireBranch = false,
): Promise<Allocation> {
  return decorateAllocation(await platformReattach(record, platformOptions(opts), requireBranch), opts);
}

export async function recreateWorktree(
  record: WorktreeRecord,
  opts: WorktreeStrategyOptions = {},
): Promise<Allocation> {
  return decorateAllocation(await platformRecreate(record, platformOptions(opts)), opts);
}

/**
 * A repository that does not ignore its worktree directory would show it untracked, and an
 * untracked dir is a dirty primary tree (CC-916). The repo-local exclude file is not tracked,
 * so listing it there leaves the tree clean without a commit.
 */
async function excludeBasePath(gitRoot: string, basePath: string): Promise<void> {
  const file = await runGit(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], gitRoot);
  if (file === null) return;
  const entry = `/${basePath.replace(/^\.?\/+|\/+$/g, "")}/`;
  try {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.split("\n").includes(entry)) return;
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}${entry}\n`);
  } catch {
    // Best effort: the worktree itself is already cut, and a gitignore may cover it.
  }
}

/** Product wording for package refusals; CC-1469 adds the holder breakdown, which the budget hook cannot see. */
async function productAllocationError(
  err: unknown,
  ctx: IsolationContext,
  basePath: string,
  opts: WorktreeStrategyOptions,
): Promise<unknown> {
  if (err instanceof MissingAssignedWorktreeRecordError)
    return new Error(
      `assigned worktree ${err.worktreePath} does not exist, and agent-chat has no record of allocating it ` +
        "to re-create it from. Not spawned",
    );
  if (!(err instanceof WorktreeBudgetExhaustedError)) return err;
  const gitRoot = await findGitRoot(ctx.baseCwd);
  if (gitRoot === null) return err;
  const use = await poolUse(gitRoot, basePath, slug(ctx.agentName), opts);
  const holdings = holdingsOf(use, ctx.treeHolders ?? opts.treeHolders);
  return new WorktreeBudgetExhaustedError(err.allocated, err.budget, err.pool, holdings);
}

const UNCOMMITTED = "uncommitted changes in the worktree";

/**
 * Is it safe to destroy this worktree and its branch? Commits are judged by the package; the
 * tree's files by dispatch's own ignored-file policy, the one park uses, since the package's
 * list misses build outputs such as `*.tsbuildinfo` and would hold every built tree.
 */
export async function inspectForRelease(
  gitRoot: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
  releaseProof: ReleaseProof = "git",
  ghTimeoutMs?: number,
): Promise<WorktreeReleaseSafety> {
  const safety = await inspectWithPackage(gitRoot, worktreePath, branch, baseRef, releaseProof, ghTimeoutMs);
  const unsaved = existsSync(worktreePath) ? await unsavedWork(worktreePath, "release") : undefined;
  const detail =
    unsaved === undefined ? "worktree clean" : unsaved.kind === "changes" ? UNCOMMITTED : unsaved.detail;
  const dirty: ReleaseCheck = { name: "dirty", ok: unsaved === undefined, detail };
  const rest = safety.checked.filter((check) => check.name !== "dirty");
  return { ...safety, dirty: unsaved !== undefined, checked: [dirty, ...rest] };
}

interface TreeRef {
  branch: string;
  worktree: string;
  gitRoot: string;
  base?: string;
}

/** Without --force, so git itself still refuses a tree that gained untracked or modified files. */
async function removeTree({ gitRoot, worktree, branch }: TreeRef): Promise<string | undefined> {
  const removed = await runGit(["worktree", "remove", worktree], gitRoot);
  if (removed === null && existsSync(worktree)) return `git would not remove ${worktree}`;
  await pruneStaleWorktrees(gitRoot);
  await runGit(["branch", "-D", branch], gitRoot);
  return undefined;
}

/** The unforced release, judged by product policy rather than the allocator's own inspection. */
async function releaseInspected(
  stoppedAt: number | undefined,
  ref: TreeRef,
  ghTimeoutMs: number | undefined,
): Promise<string | undefined> {
  if (stoppedAt !== undefined && Date.now() - stoppedAt < RECLAIM_GRACE_MS)
    return `agent stopped less than ${RECLAIM_GRACE_MS / 1000}s ago; inside the reclaim grace window`;
  const { gitRoot, worktree, branch, base = "HEAD" } = ref;
  const safety = await inspectForRelease(gitRoot, worktree, branch, base, "git-or-merged-pr-tip", ghTimeoutMs);
  if (safety.dirty || safety.unmerged) return describeRefusal(safety);
  return removeTree(ref);
}

/** A tree this strategy cut and may remove; forced, parked, assigned and ref-less releases stay with the package. */
function ownedTree(allocation: Allocation, opts: ReleaseOptions): TreeRef | undefined {
  const ref = allocation.ref;
  if (opts.force === true || opts.keepBranch === true || ref?.assigned === "true") return undefined;
  if (!ref?.branch || !ref.worktree || !ref.gitRoot) return undefined;
  return {
    branch: ref.branch,
    worktree: ref.worktree,
    gitRoot: ref.gitRoot,
    ...(ref.base ? { base: ref.base } : {}),
  };
}

async function checkTree(
  ctx: IsolationContext,
  basePath: string,
  opts: WorktreeStrategyOptions,
): Promise<string[]> {
  const gitRoot = await findGitRoot(ctx.baseCwd);
  if (gitRoot === null) return [`${ctx.baseCwd} is not a git repository; worktree isolation needs one`];

  await pruneStaleWorktrees(gitRoot);
  const use = await poolUse(gitRoot, basePath, slug(ctx.agentName), opts);
  const reasons: string[] = [];
  if (use.allocated >= use.budget)
    reasons.push(
      `${poolExhausted(use.pool, use.allocated, use.budget)} under ${basePath}` +
        holdingsOf(use, ctx.treeHolders ?? opts.treeHolders),
    );
  if ((await runGit(["rev-parse", "--verify", branchFor(ctx.agentName)], gitRoot)) !== null) {
    reasons.push(
      warn(
        `branch ${branchFor(ctx.agentName)} already exists; it will be adopted if it holds commits, ` +
          "reset if it does not",
      ),
    );
  }
  return reasons;
}

async function releaseThroughPackage(
  allocator: WorktreeAllocator,
  ctx: IsolationContext,
  allocation: Allocation,
  opts: ReleaseOptions,
): Promise<string | undefined> {
  const exited = ctx.stoppedAt === undefined ? {} : { exitedAt: ctx.stoppedAt };
  const result = await allocator.release(exited, allocation, opts);
  return result.released ? undefined : result.refusal;
}

export function createWorktreeStrategy(opts: WorktreeStrategyOptions = {}): IsolationStrategy {
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH;
  const allocator = createWorktreeAllocator(platformOptions(opts));
  return {
    name: "worktree",
    check: (ctx) => checkTree(ctx, basePath, opts),

    async allocate(ctx) {
      const allocation = await allocator.allocate(ctx).catch(async (err: unknown) => {
        throw await productAllocationError(err, ctx, basePath, opts);
      });
      const gitRoot = allocation.ref.gitRoot;
      if (allocation.ref.assigned !== "true" && gitRoot !== undefined)
        await excludeBasePath(gitRoot, basePath);
      return decorateAllocation(allocation, opts, ctx.baseRef);
    },

    async release(ctx, allocation, releaseOpts = {}) {
      clearRefusal(allocation);
      const owned = ownedTree(allocation, releaseOpts);
      const refusal =
        owned === undefined
          ? await releaseThroughPackage(allocator, ctx, allocation, releaseOpts)
          : await releaseInspected(ctx.stoppedAt, owned, opts.ghTimeoutMs);
      if (refusal !== undefined) recordRefusal(allocation, refusal);
      return refusal === undefined;
    },
  };
}
