import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { addWorktree, boundedAdd, WORKTREE_ADD_TIMEOUT_MS, type WorktreeAddRunner } from "./add.js";
import { resolveBranchBase } from "./branch-base.js";
import { WorktreeBudgetExhaustedError, WorktreeInUseError } from "./errors.js";
import { findGitRoot, gitOrNull } from "./git.js";
import { allocatedPaths, checkoutOf, copyClaudeDir, pruneStaleWorktrees, removeWorktree } from "./layout.js";
import {
  basePathOf,
  branchFor,
  budgetOf,
  DEFAULT_FETCH_TIMEOUT_MS,
  RECLAIM_GRACE_MS,
  slug,
  type WorktreeOptions,
} from "./options.js";
import { readoptWorktree, setupTarget, type WorktreeAllocation, type WorktreeRecord } from "./reattach.js";
import { describeRefusal, inspectForRelease } from "./release-safety.js";
import { runWorktreeSetup } from "./setup.js";

/** One agent's request for a worktree. A caller's richer context record satisfies it structurally. */
export interface WorktreeRequest {
  agentName: string;
  baseCwd: string;
  /**
   * A worktree the caller assigned. It is ADOPTED instead of allocated: no
   * branch is created, no budget slot is taken, and release leaves it alone.
   */
  assignedWorktree?: string;
  /** The caller's record of allocating `assignedWorktree`, which re-creates it if it was removed. */
  assignedRecord?: WorktreeRecord;
  /** When the agent exited; anchors the reclaim grace window. */
  exitedAt?: number;
  /** Discard a leftover branch instead of adopting it. Allocation can destroy commits as release can. */
  forceReset?: boolean;
}

export interface WorktreeCheck {
  /** Reasons the allocation would fail. */
  refusals: string[];
  /** Advisory lines; allocation proceeds. */
  warnings: string[];
}

export type WorktreeReleaseOutcome = { released: true } | { released: false; refusal: string };

export interface WorktreeAllocator {
  check(req: WorktreeRequest): Promise<WorktreeCheck>;
  allocate(req: WorktreeRequest): Promise<WorktreeAllocation>;
  /** A refusal (dirty, unmerged, inside the grace window) leaves everything on disk. */
  release(
    req: Pick<WorktreeRequest, "exitedAt">,
    alloc: { ref?: Record<string, string> },
    opts?: { force?: boolean }
  ): Promise<WorktreeReleaseOutcome>;
}

interface AttachOptions {
  base: string;
  force: boolean;
  run?: WorktreeAddRunner | undefined;
}

async function resetTo(gitRoot: string, branch: string, worktreePath: string, opts: AttachOptions): Promise<void> {
  await gitOrNull(["worktree", "remove", "--force", worktreePath], gitRoot);
  rmSync(worktreePath, { recursive: true, force: true });
  await gitOrNull(["branch", "-D", branch], gitRoot);
  await addWorktree(gitRoot, ["worktree", "add", "-b", branch, worktreePath, opts.base], opts.run);
}

/**
 * Attach a worktree for `branch`, and return whether an existing branch was adopted.
 *
 * The crash path: an agent commits, then dies without ever calling release. Its
 * directory is gone but the branch holds the only copy of those commits, so an
 * unconditional `branch -D` here would make them unreachable. Adopting beats
 * refusing: a respawn under the same name IS that agent continuing. A branch
 * holding nothing worth keeping is still reset, so it does not inherit a stale base.
 */
async function attachWorktree(
  gitRoot: string,
  branch: string,
  worktreePath: string,
  opts: AttachOptions
): Promise<boolean> {
  if ((await gitOrNull(["rev-parse", "--verify", branch], gitRoot)) === null) {
    await addWorktree(gitRoot, ["worktree", "add", "-b", branch, worktreePath, opts.base], opts.run);
    return false;
  }
  if (opts.force) {
    await resetTo(gitRoot, branch, worktreePath, opts);
    return false;
  }
  const safety = await inspectForRelease(gitRoot, worktreePath, branch, opts.base);
  if (safety.unmerged) await addWorktree(gitRoot, ["worktree", "add", worktreePath, branch], opts.run);
  else await resetTo(gitRoot, branch, worktreePath, opts);
  return safety.unmerged;
}

/** Null when release may proceed, otherwise the reason it may not. */
async function refuseRelease(
  exitedAt: number | undefined,
  ref: { gitRoot: string; worktree: string; branch: string; base: string }
): Promise<string | null> {
  if (exitedAt !== undefined && Date.now() - exitedAt < RECLAIM_GRACE_MS)
    return `agent exited less than ${RECLAIM_GRACE_MS / 1000}s ago; inside the reclaim grace window`;
  const safety = await inspectForRelease(ref.gitRoot, ref.worktree, ref.branch, ref.base);
  return safety.dirty || safety.unmerged ? describeRefusal(safety) : null;
}

/** A gone assigned tree comes back only from the caller's record of allocating it. */
function unrecoverableAssigned(assigned: string, record: WorktreeRecord | undefined): Error | undefined {
  if (existsSync(assigned) || (record !== undefined && path.resolve(record.worktree) === assigned)) return undefined;
  return new Error(
    `assigned worktree ${assigned} does not exist, and there is no record of allocating it ` +
      "to re-create it from. Not spawned"
  );
}

async function adoptAssigned(
  req: WorktreeRequest,
  gitRoot: string,
  opts: WorktreeOptions
): Promise<WorktreeAllocation> {
  const assigned = path.resolve(req.assignedWorktree as string);
  if (!existsSync(assigned)) return readoptWorktree(req.assignedRecord as WorktreeRecord, opts);
  const branch = (await gitOrNull(["rev-parse", "--abbrev-ref", "HEAD"], assigned)) ?? "HEAD";
  return {
    cwd: assigned,
    note: `You are in a worktree assigned to this task at ${assigned}, on branch ${branch}. You may be sharing it with other agents, so stay inside the paths you were given.`,
    ref: { branch, worktree: assigned, gitRoot, assigned: "true" },
  };
}

/** Everything allocate would refuse, as the errors it throws, so check and allocate cannot disagree. */
interface Preflight {
  refusals: Error[];
  warnings: string[];
}

/** An existing branch is re-attached unless forced, which needs both it and its directory to be free. */
async function holderRefusal(gitRoot: string, branch: string, worktreePath: string): Promise<Error[]> {
  const holder = await checkoutOf(gitRoot, branch);
  if (holder === null && !existsSync(worktreePath)) return [];
  return [new WorktreeInUseError(branch, holder ?? worktreePath)];
}

async function preflight(req: WorktreeRequest, gitRoot: string, opts: WorktreeOptions): Promise<Preflight> {
  if (req.assignedWorktree !== undefined) {
    const refusal = unrecoverableAssigned(path.resolve(req.assignedWorktree), req.assignedRecord);
    return { refusals: refusal === undefined ? [] : [refusal], warnings: [] };
  }
  await pruneStaleWorktrees(gitRoot);
  const allocated = await allocatedPaths(gitRoot, basePathOf(opts));
  const budget = budgetOf(opts);
  const refusals: Error[] =
    allocated.length >= budget ? [new WorktreeBudgetExhaustedError(allocated.length, budget)] : [];
  const branch = branchFor(req.agentName, opts);
  if ((await gitOrNull(["rev-parse", "--verify", branch], gitRoot)) === null) return { refusals, warnings: [] };
  if (req.forceReset !== true) {
    const worktreePath = path.resolve(gitRoot, basePathOf(opts), slug(req.agentName));
    refusals.push(...(await holderRefusal(gitRoot, branch, worktreePath)));
  }
  const warnings = [`branch ${branch} already exists; it will be adopted if it holds commits, reset if it does not`];
  return { refusals, warnings };
}

async function check(req: WorktreeRequest, opts: WorktreeOptions): Promise<WorktreeCheck> {
  const gitRoot = await findGitRoot(req.baseCwd);
  if (gitRoot === null)
    return { refusals: [`${req.baseCwd} is not a git repository; worktree isolation needs one`], warnings: [] };
  const { refusals, warnings } = await preflight(req, gitRoot, opts);
  return { refusals: refusals.map((error) => error.message), warnings };
}

async function allocate(req: WorktreeRequest, opts: WorktreeOptions): Promise<WorktreeAllocation> {
  const gitRoot = await findGitRoot(req.baseCwd);
  if (gitRoot === null) throw new Error(`${req.baseCwd} is not a git repository`);
  const [refusal] = (await preflight(req, gitRoot, opts)).refusals;
  if (refusal !== undefined) throw refusal;
  if (req.assignedWorktree !== undefined) return adoptAssigned(req, gitRoot, opts);

  const branch = branchFor(req.agentName, opts);
  const worktreePath = path.resolve(gitRoot, basePathOf(opts), slug(req.agentName));
  const base = await resolveBranchBase(gitRoot, opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const reused = await attachWorktree(gitRoot, branch, worktreePath, {
    base: base.sha,
    force: req.forceReset === true,
    run: boundedAdd(opts.runWorktreeAdd, opts.addTimeoutMs ?? WORKTREE_ADD_TIMEOUT_MS),
  });
  const warnings = [
    ...copyClaudeDir(gitRoot, worktreePath),
    ...(base.warning === undefined ? [] : [base.warning]),
    ...(await runWorktreeSetup(setupTarget(gitRoot, worktreePath, base), opts.runSetup)),
  ];
  const carried = reused ? " It already carries commits from an earlier run under this name." : "";
  return {
    cwd: worktreePath,
    note: `You are on branch ${branch} in an isolated worktree at ${worktreePath}.${carried} Commit your work there; nothing outside it is yours to change.`,
    ref: {
      branch,
      worktree: worktreePath,
      gitRoot,
      base: base.sha,
      base_ref: base.ref,
      ...(reused ? { reused: "true" } : {}),
    },
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

async function release(
  req: Pick<WorktreeRequest, "exitedAt">,
  alloc: { ref?: Record<string, string> },
  opts: { force?: boolean } = {}
): Promise<WorktreeReleaseOutcome> {
  const ref = alloc.ref;
  if (!ref?.branch || !ref.worktree || !ref.gitRoot)
    return { released: false, refusal: "allocation carries no worktree reference" };
  const { branch, worktree, gitRoot } = ref;

  // An assigned tree belongs to whoever assigned it and may be shared, so even
  // `force` leaves it: force discards THIS agent's commits, not someone else's tree.
  if (ref.assigned === "true") return { released: true };

  if (!opts.force) {
    const refusal = await refuseRelease(req.exitedAt, { gitRoot, worktree, branch, base: ref.base ?? "HEAD" });
    if (refusal !== null) return { released: false, refusal };
  }
  const refused = await removeWorktree(gitRoot, worktree, branch, opts);
  return refused === undefined ? { released: true } : { released: false, refusal: refused };
}

/** Worktree isolation for agents: one branch and one directory per agent name, under a per-repo budget. */
export function createWorktreeAllocator(opts: WorktreeOptions = {}): WorktreeAllocator {
  return {
    check: (req) => check(req, opts),
    allocate: (req) => allocate(req, opts),
    release,
  };
}
