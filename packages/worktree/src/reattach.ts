import { existsSync } from "node:fs";
import path from "node:path";
import { addWorktree, boundedAdd, WORKTREE_ADD_TIMEOUT_MS, type WorktreeAddRunner } from "./add.js";
import { fetchTip, resolveBranchBase, type BranchBase } from "./branch-base.js";
import { OriginUnreachableError, WorktreeBudgetExhaustedError, WorktreeInUseError } from "./errors.js";
import { gitOrNull, gitText } from "./git.js";
import { allocatedPaths, checkoutOf, copyClaudeDir, pruneStaleWorktrees } from "./layout.js";
import { basePathOf, budgetOf, DEFAULT_FETCH_TIMEOUT_MS, type WorktreeOptions } from "./options.js";
import { runWorktreeSetup, type SetupTarget } from "./setup.js";

/** Where a worktree an allocator created sat, as its caller recorded it. */
export interface WorktreeRecord {
  gitRoot: string;
  worktree: string;
  branch: string;
  /** An agent adopted this tree from the allocator the record came from, so it is not that agent's to remove. */
  adopted?: boolean;
}

/** What an allocation hands back: where the agent works, one line for its brief, and a handle for release. */
export interface WorktreeAllocation {
  cwd: string;
  note: string;
  /** Branch, worktree, gitRoot and base; flags are the string 'true'. Persist it to release later. */
  ref: Record<string, string>;
  /** Advisory lines for the requester. */
  warnings?: string[];
}

/** How a re-attached worktree got its branch back. */
type BranchSource = "local" | "origin" | "fresh";

/** `warning` is set exactly when the base is a local HEAD, which no setup declaration is trusted from. */
export const setupTarget = (gitRoot: string, worktree: string, base: BranchBase): SetupTarget => ({
  gitRoot,
  worktree,
  baseSha: base.sha,
  fetched: base.warning === undefined,
});

/** `ls-remote --exit-code` exits 2 only when the ref is absent; anything else is a failed lookup. */
async function originHasBranch(gitRoot: string, branch: string, timeoutMs: number): Promise<boolean> {
  try {
    await gitText(["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`], gitRoot, timeoutMs);
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === 2) return false;
    throw new OriginUnreachableError(branch, firstLine(err));
  }
}

const firstLine = (err: unknown): string =>
  String((err as { stderr?: unknown }).stderr || (err as Error).message)
    .trim()
    .split("\n")[0] ?? "unknown error";

/** Local first, since it may hold commits origin never saw; a squash merge deletes both. */
async function branchSource(gitRoot: string, branch: string, timeoutMs: number): Promise<BranchSource> {
  if ((await gitOrNull(["rev-parse", "--verify", branch], gitRoot)) !== null) return "local";
  if ((await gitOrNull(["remote", "get-url", "origin"], gitRoot)) === null) return "fresh";
  if (!(await originHasBranch(gitRoot, branch, timeoutMs))) return "fresh";
  if ((await fetchTip(gitRoot, branch, timeoutMs)) === null)
    throw new OriginUnreachableError(branch, "origin lists it but fetching it failed");
  return "origin";
}

function addArgs(record: WorktreeRecord, source: BranchSource, base: string): string[] {
  const { worktree, branch } = record;
  if (source === "local") return ["worktree", "add", worktree, branch];
  return ["worktree", "add", "-b", branch, worktree, source === "origin" ? `origin/${branch}` : base];
}

/** A concurrent re-attach of the same record loses the race here; say so rather than pass git's text on. */
async function addForSource(
  record: WorktreeRecord,
  source: BranchSource,
  base: string,
  run?: WorktreeAddRunner
): Promise<void> {
  try {
    await addWorktree(record.gitRoot, addArgs(record, source, base), run);
  } catch (err) {
    const holder = await checkoutOf(record.gitRoot, record.branch);
    if (holder !== null || existsSync(record.worktree))
      throw new WorktreeInUseError(record.branch, holder ?? record.worktree);
    throw err;
  }
}

function reattachWarnings(record: WorktreeRecord, source: BranchSource, base: BranchBase): string[] {
  const inherited = base.warning === undefined ? [] : [base.warning];
  if (source !== "fresh") return inherited;
  const fresh =
    `branch ${record.branch} no longer exists locally or on origin (a squash merge deletes it), so ` +
    `${record.worktree} was re-created on a fresh ${record.branch} from ${base.ref} ${base.sha}; ` +
    "commits the conversation mentions may be merged or gone";
  return [fresh, ...inherited];
}

/** The record comes from the caller's log, so it may only name a tree under this repository's worktree base. */
function checkRecordPlacement(record: WorktreeRecord, basePath: string): void {
  const base = path.resolve(record.gitRoot, basePath) + path.sep;
  if (!path.resolve(record.worktree).startsWith(base))
    throw new Error(`recorded worktree ${record.worktree} is not under ${base}; not re-created`);
}

/** Refuses when the tree is on disk, the budget is spent, or another tree holds the branch. */
async function checkReattachable(record: WorktreeRecord, opts: WorktreeOptions): Promise<void> {
  const { gitRoot, worktree, branch } = record;
  checkRecordPlacement(record, basePathOf(opts));
  if (existsSync(worktree)) throw new WorktreeInUseError(branch, worktree);
  await pruneStaleWorktrees(gitRoot);
  const allocated = await allocatedPaths(gitRoot, basePathOf(opts));
  const budget = budgetOf(opts);
  if (allocated.length >= budget) throw new WorktreeBudgetExhaustedError(allocated.length, budget);
  const holder = await checkoutOf(gitRoot, branch);
  if (holder !== null) throw new WorktreeInUseError(branch, holder);
}

/**
 * Put a removed worktree back at its recorded path, under the allocator's budget.
 *
 * `claude --resume` finds a transcript only under the project dir of the cwd it
 * starts in, and that dir is derived from the worktree path, so the path must be
 * the original one. Every file path in the conversation points there too.
 */
export async function reattachWorktree(
  record: WorktreeRecord,
  opts: WorktreeOptions = {},
  requireBranch = false
): Promise<WorktreeAllocation> {
  const { gitRoot, worktree, branch } = record;
  await checkReattachable(record, opts);
  const timeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const base = await resolveBranchBase(gitRoot, timeoutMs);
  const source = await branchSource(gitRoot, branch, timeoutMs);
  if (source === "fresh" && requireBranch)
    throw new Error(
      `branch ${branch} no longer exists locally or on origin, so the adopted worktree ${worktree} ` +
        "was not re-created on a fresh one"
    );
  await addForSource(
    record,
    source,
    base.sha,
    boundedAdd(opts.runWorktreeAdd, opts.addTimeoutMs ?? WORKTREE_ADD_TIMEOUT_MS)
  );
  copyClaudeDir(gitRoot, worktree);
  const warnings = [
    ...reattachWarnings(record, source, base),
    ...(await runWorktreeSetup(setupTarget(gitRoot, worktree, base), opts.runSetup)),
  ];
  return {
    cwd: worktree,
    note: `Your worktree at ${worktree} had been removed and was re-created on branch ${branch}. Commit your work there; nothing outside it is yours to change.`,
    ref: { branch, worktree, gitRoot, base: base.sha, base_ref: base.ref, reattached: source },
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * Put back a removed tree an agent adopted, on its allocator's branch.
 *
 * It stays marked assigned, so the adopter's release leaves it, and a branch that
 * is gone refuses rather than forking a fresh one the adopter never worked on.
 */
export async function readoptWorktree(record: WorktreeRecord, opts: WorktreeOptions): Promise<WorktreeAllocation> {
  const allocation = await reattachWorktree(record, opts, true);
  return {
    ...allocation,
    note: `The worktree assigned to this task at ${record.worktree} had been removed and was re-created on branch ${record.branch}. You may be sharing it with other agents, so stay inside the paths you were given.`,
    ref: { ...allocation.ref, assigned: "true" },
  };
}

/** Re-create a removed tree from its record, keeping an adopted one adopted. */
export function recreateWorktree(record: WorktreeRecord, opts: WorktreeOptions = {}): Promise<WorktreeAllocation> {
  return record.adopted === true ? readoptWorktree(record, opts) : reattachWorktree(record, opts);
}
