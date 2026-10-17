/** Runs one `git worktree add`, resolving to its output and rejecting on failure. */
type WorktreeAddRunner = (args: readonly string[], cwd: string) => Promise<string>;
/** Five minutes: a cold checkout of a multi-gigabyte repo takes tens of seconds, so only a hang reaches it. */
declare const WORKTREE_ADD_TIMEOUT_MS = 300000;

/** A path inside a commit: the declaration is read from git, never from a working tree. */
declare const SETUP_FILE = ".agent-chat/worktree.json";
/** Kept in the worktree's git dir, so it is neither tracked nor counted as dirt, and goes with the worktree. */
declare const SETUP_LOG = "agent-chat-setup.log";
/** Five minutes: a cold `npm ci` takes well under that, so only a hang reaches it. */
declare const DEFAULT_SETUP_TIMEOUT_MS = 300000;
interface SetupStep {
    command: string[];
    timeoutMs: number;
}
interface SetupResult {
    /** Null when the process never started or was killed by a signal. */
    exitCode: number | null;
    timedOut: boolean;
    output: string;
}
type SetupRunner = (command: readonly string[], cwd: string, timeoutMs: number) => Promise<SetupResult>;
interface SetupTarget {
    gitRoot: string;
    worktree: string;
    /** The commit the branch base resolved to; the only place a declaration is read from. */
    baseSha: string;
    /** False when that commit is a local HEAD rather than origin's default branch as fetched. */
    fetched: boolean;
}
/** An allowlist of what an install needs: the step runs with the host's authority, outside any permission profile. */
declare function setupEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** Keys it does not know are ignored, so a newer declaration still runs on an older host. */
declare function parseSetupStep(text: string): SetupStep | null | string;
/** Its own process group, so a timeout also kills what the step spawned (npm runs scripts in children). */
declare const runSetupCommand: SetupRunner;
/**
 * Run the repository's declared setup step in a fresh worktree, before the agent launches.
 *
 * The step runs with the host's authority, so its declaration comes only from origin's default
 * branch as fetched: a branch that edits the file changes nothing until it lands.
 * A tree whose pnpm-workspace.yaml or .npmrc differs from that branch's is skipped, since each can override the env pins.
 *
 * Never throws: a failed step is a warning and the spawn proceeds, since whatever
 * depended on it (the egress pre-push hook) fails closed on its own.
 */
declare function runWorktreeSetup(target: SetupTarget, run?: SetupRunner): Promise<string[]>;

declare const DEFAULT_WORKTREE_BUDGET = 3;
declare const DEFAULT_BASE_PATH = ".worktrees";
/** Ownership marker: the sweep treats only branches carrying this prefix as its own. */
declare const BRANCH_PREFIX = "agent-chat/";
declare const DEFAULT_FETCH_TIMEOUT_MS = 15000;
/**
 * Grace window between an agent exiting and its worktree becoming reclaimable.
 *
 * It guards the window between an agent exiting and a human noticing the
 * unpushed commits it left behind. Release does `git branch -D`, so reclaiming
 * inside that window turns "I'll look at it in a minute" into a dangling commit.
 * Anchored on the exit timestamp, not on wall clock since allocation.
 *
 * This window and the dirty/unmerged refusal are the two things most likely to
 * be dropped as incidental. They are not: both exist because work was lost.
 */
declare const RECLAIM_GRACE_MS = 120000;
interface WorktreeOptions {
    /** Relative to the git root. */
    basePath?: string;
    /** Per-repository cap on allocated worktrees. A function is read on every allocation. */
    budget?: number | (() => number);
    branchPrefix?: string;
    /** Bound on fetching origin's default branch before cutting a new one. */
    fetchTimeoutMs?: number;
    /** Bound on one `git worktree add`; the add is killed and the repo's queue moves on when it passes. */
    addTimeoutMs?: number;
    /** Runs each `git worktree add`; tests inject one to observe how adds interleave. */
    runWorktreeAdd?: WorktreeAddRunner;
    /** Runs the repository's declared setup step; tests inject one so no real install runs. */
    runSetup?: SetupRunner;
}

/** The commit a new branch is cut from, the ref it was read from, and a warning when that ref is not origin's. */
interface BranchBase {
    sha: string;
    ref: string;
    warning?: string;
}
/**
 * The main checkout's HEAD may lag origin or hold another session's unpushed
 * commits, and a branch cut from it ships both. So cut from a fresh fetch of
 * origin's default branch, and say so loudly when that is impossible.
 */
declare function resolveBranchBase(gitRoot: string, timeoutMs: number): Promise<BranchBase>;

/** Where a worktree an allocator created sat, as its caller recorded it. */
interface WorktreeRecord {
    gitRoot: string;
    worktree: string;
    branch: string;
    /** An agent adopted this tree from the allocator the record came from, so it is not that agent's to remove. */
    adopted?: boolean;
}
/** What an allocation hands back: where the agent works, one line for its brief, and a handle for release. */
interface WorktreeAllocation {
    cwd: string;
    note: string;
    /** Branch, worktree, gitRoot and base; flags are the string 'true'. Persist it to release later. */
    ref: Record<string, string>;
    /** Advisory lines for the requester. */
    warnings?: string[];
}
/**
 * Put a removed worktree back at its recorded path, under the allocator's budget.
 *
 * `claude --resume` finds a transcript only under the project dir of the cwd it
 * starts in, and that dir is derived from the worktree path, so the path must be
 * the original one. Every file path in the conversation points there too.
 */
declare function reattachWorktree(record: WorktreeRecord, opts?: WorktreeOptions, requireBranch?: boolean): Promise<WorktreeAllocation>;
/** Re-create a removed tree from its record, keeping an adopted one adopted. */
declare function recreateWorktree(record: WorktreeRecord, opts?: WorktreeOptions): Promise<WorktreeAllocation>;

/** One agent's request for a worktree. A caller's richer context record satisfies it structurally. */
interface WorktreeRequest {
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
interface WorktreeCheck {
    /** Reasons the allocation would fail. */
    refusals: string[];
    /** Advisory lines; allocation proceeds. */
    warnings: string[];
}
type WorktreeReleaseOutcome = {
    released: true;
} | {
    released: false;
    refusal: string;
};
interface WorktreeAllocator {
    check(req: WorktreeRequest): Promise<WorktreeCheck>;
    allocate(req: WorktreeRequest): Promise<WorktreeAllocation>;
    /** A refusal (dirty, unmerged, inside the grace window) leaves everything on disk. */
    release(req: Pick<WorktreeRequest, "exitedAt">, alloc: {
        ref?: Record<string, string>;
    }, opts?: {
        force?: boolean;
    }): Promise<WorktreeReleaseOutcome>;
}
/** Worktree isolation for agents: one branch and one directory per agent name, under a per-repo budget. */
declare function createWorktreeAllocator(opts?: WorktreeOptions): WorktreeAllocator;

declare class WorktreeBudgetExhaustedError extends Error {
    readonly allocated: number;
    readonly budget: number;
    constructor(allocated: number, budget: number);
}
/**
 * Adoption is impossible: something is still holding the branch or the path.
 *
 * Distinct from "the branch holds work", which is recoverable by adopting it.
 * This one means a live agent of the same name already has the worktree, or a
 * directory is sitting in the way: cases where proceeding would clobber files
 * nobody has agreed to lose.
 */
declare class WorktreeInUseError extends Error {
    readonly branch: string;
    readonly worktreePath: string;
    constructor(branch: string, worktreePath: string);
}
/** Origin could not answer whether it holds the branch, so a fresh fork might discard real work. */
declare class OriginUnreachableError extends Error {
    readonly branch: string;
    constructor(branch: string, detail: string);
}

/**
 * One `git` invocation, returning null rather than throwing.
 *
 * git failures are routine control flow here: "is this a repository at all" is
 * a failing command, and every caller treats a miss as an answer. Injectable so
 * tests of callers never shell out.
 */
type GitRunner = (args: readonly string[], cwd: string) => Promise<string | null>;
/** The transports git may use for agent-chat and its agents; `ext::` runs a shell command (CC-1095). */
declare const SAFE_GIT_PROTOCOLS: readonly string[];
/**
 * The caller's GIT_ALLOW_PROTOCOL narrowed to the safe list, or the whole safe list when unset.
 * git reads this list over every `protocol.*.allow` config scope, so a repo's config cannot re-enable `ext`.
 * A caller list with nothing safe in it (`ext` alone) gives '', which git reads as allowing no transport.
 */
declare function pinGitProtocols(value: string | undefined): string;
/** `env` with GIT_ALLOW_PROTOCOL pinned, for a child that may run git without going through `gitChildEnv`. */
declare function withPinnedGitProtocols(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** A git child that inherits a dispatcher's identity variables can register as the agent that spawned it. */
declare const DEFAULT_STRIPPED_ENV_PREFIXES: readonly string[];
declare function gitChildEnv(env?: NodeJS.ProcessEnv, stripPrefixes?: readonly string[]): NodeJS.ProcessEnv;
declare const runGit: GitRunner;
/**
 * The true repository root, resolved through worktrees.
 *
 * `--git-common-dir` rather than `--show-toplevel`: from inside a worktree the
 * toplevel is that worktree, and allocating from it would nest worktrees.
 */
declare function findGitRoot(cwd: string, git?: GitRunner): Promise<string | null>;
/** Where a process is observably running, as git sees it, as opposed to what it says about itself. */
interface GitPresence {
    gitBranch?: string;
    /** The checkout this process's files live in. */
    worktreePath?: string;
    /** The repository behind the checkout; two worktrees of one repo share it. */
    repoPath?: string;
    isLinkedWorktree?: boolean;
}
/**
 * Undefined outside a git repository. The toplevel and the common dir answer
 * different questions: when they disagree, this is a linked worktree.
 */
declare function observedPresence(cwd: string, git?: GitRunner): Promise<GitPresence | undefined>;

/**
 * Drop registrations whose directory is gone from disk, so a machine that was
 * rebooted mid-run does not permanently hold budget it is not using.
 */
declare function pruneStaleWorktrees(gitRoot: string): Promise<void>;

/** Parking keeps the local branch; an opt-in fresh default proof can establish its commits are already backed. */
interface ParkOptions {
    /** Permit a missing origin/branch only when a fresh DEFAULT fetch contains the actual HEAD. */
    allowDefaultBranchAncestor?: boolean;
    /** Positive finite fetch budget; invalid values refuse without fetching. Defaults to 15 seconds. */
    fetchTimeoutMs?: WorktreeOptions["fetchTimeoutMs"];
}
/** Refuse file loss, recheck lifecycle immediately before nonforced removal, and always keep the local branch. */
declare function parkWorktree(target: WorktreeRecord, recheck?: () => string | undefined, options?: ParkOptions): Promise<{
    ok: true;
    head: string;
} | {
    ok: false;
    reason: string;
}>;

interface ReleaseCheck {
    name: "dirty" | "pushed" | "landed" | "gh";
    ok: boolean;
    detail: string;
}
interface WorktreeReleaseSafety {
    dirty: boolean;
    /** Commits that exist nowhere else: not on the remote, not in the base ref, and not landed. */
    unmerged: boolean;
    /** Every file the branch changed already matches the current base: a squash or rebase merge. */
    landed: boolean;
    /** Commits on the branch but not on `compareTo`; null when the range could not be counted. */
    ahead: number | null;
    checked: ReleaseCheck[];
}
/**
 * Is it safe to destroy this worktree and its branch?
 *
 * The tree's files go through the same check as park, so a status git cannot
 * read, a hidden untracked file, or an ignored file no build regenerates all
 * count as dirty. A tree already gone from disk has no files left to lose.
 *
 * With no remote the comparison falls back to the commit the branch forked
 * from, since treating "no remote" as safe would silently delete every commit
 * the agent made. Over-refusal is the failure mode we accept: `force` is one
 * flag away.
 *
 * Commits that fail that count are still safe when their content has landed on
 * the checkout's current branch (or `origin/HEAD`), which is how a squash-merged
 * PR looks once the host deletes the remote branch. Nothing is fetched: a stale
 * local main makes this refuse until someone pulls.
 */
declare function inspectForRelease(gitRoot: string, worktreePath: string, branch: string, baseRef: string): Promise<WorktreeReleaseSafety>;
/** The failed checks, as one line a coordinator can act on. */
declare function describeRefusal(safety: WorktreeReleaseSafety): string;

/**
 * Find the worktrees an allocator is holding, and say which ones nobody is using.
 *
 * Release is driven by a person deciding they are done. The leak is the case
 * where nobody decides: an agent exits, is never released, and holds its
 * worktree and branch indefinitely.
 *
 * Ownership is the branch prefix, not the path: the prefix is what the allocator
 * writes and nothing else creates. That keeps the sweep off other tools' agent
 * worktrees, which sit on ordinary branch names and are usually locked.
 */
/** Where a worktree sits in the lifecycle, and therefore what may be done to it. */
type SweepStatus =
/** Its agent is still running. Nothing to do, and nothing safe to do. */
"held"
/** Its agent has exited, but inside the window that protects unnoticed work. */
 | "in-grace"
/** Uncommitted changes, or commits that exist nowhere else. Needs a person. */
 | "holds-work"
/** Nobody is using it and nothing would be lost. `reclaimWorktree` takes these. */
 | "reclaimable";
/** The agent a caller says owns a found worktree. */
interface SweepOwner {
    agentId: string;
    name: string;
    state: string;
    lastEventAt: number;
    exitedAt?: number;
}
/** An allocation the caller believes it still holds. */
interface HeldWorktree {
    gitRoot: string;
    branch: string;
    /** The commit the branch was cut from; release safety compares against it when there is no remote. */
    base?: string;
}
interface FoundWorktree {
    gitRoot: string;
    worktree: string;
    branch: string;
}
interface SweptWorktree extends FoundWorktree {
    status: SweepStatus;
    /** Absent when no owner was found for the worktree. */
    agent?: {
        agentId: string;
        name: string;
        state: string;
        lastEventAt: number;
    };
    /** One line of why it is in this state, for a human reading the report. */
    detail: string;
}
type GitLister = (gitRoot: string) => Promise<string>;
interface SweepOptions {
    /** Repositories to scan beyond the ones `held` names, which catches a tree no record points at. */
    roots?: readonly string[];
    held?: readonly HeldWorktree[];
    /** Joins a found worktree to its agent; the caller owns the roster. */
    ownerOf?: (found: FoundWorktree) => SweepOwner | undefined;
    branchPrefix?: string;
    list?: GitLister;
    now?: () => number;
}
/** Every unlocked worktree in `gitRoot` whose branch carries `branchPrefix`, from git itself. */
declare function agentWorktreesIn(gitRoot: string, list?: GitLister, branchPrefix?: string): Promise<{
    worktree: string;
    branch: string;
}[]>;
/** Live means someone is in it; anything else has stopped and may be reclaimable. */
declare const isLive: (state: string) => boolean;
/** Every allocator worktree in the named and held repositories, classified. */
declare function sweepWorktrees(options?: SweepOptions): Promise<SweptWorktree[]>;
/**
 * Destroy one swept worktree and its branch.
 *
 * Refuses anything not `reclaimable` unless forced, so the classification is the
 * guard rather than advice. The grace window and the safety check already ran in
 * the sweep, against the report the caller read, so they are not re-derived here.
 */
declare function reclaimWorktree(entry: SweptWorktree, options?: {
    force?: boolean;
}): Promise<{
    ok: boolean;
    reason?: string;
}>;

export { BRANCH_PREFIX, type BranchBase, DEFAULT_BASE_PATH, DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_SETUP_TIMEOUT_MS, DEFAULT_STRIPPED_ENV_PREFIXES, DEFAULT_WORKTREE_BUDGET, type FoundWorktree, type GitLister, type GitPresence, type GitRunner, type HeldWorktree, OriginUnreachableError, type ParkOptions, RECLAIM_GRACE_MS, type ReleaseCheck, SAFE_GIT_PROTOCOLS, SETUP_FILE, SETUP_LOG, type SetupResult, type SetupRunner, type SetupStep, type SetupTarget, type SweepOptions, type SweepOwner, type SweepStatus, type SweptWorktree, WORKTREE_ADD_TIMEOUT_MS, type WorktreeAddRunner, type WorktreeAllocation, type WorktreeAllocator, WorktreeBudgetExhaustedError, type WorktreeCheck, WorktreeInUseError, type WorktreeOptions, type WorktreeRecord, type WorktreeReleaseOutcome, type WorktreeReleaseSafety, type WorktreeRequest, agentWorktreesIn, createWorktreeAllocator, describeRefusal, findGitRoot, gitChildEnv, inspectForRelease, isLive, observedPresence, parkWorktree, parseSetupStep, pinGitProtocols, pruneStaleWorktrees, reattachWorktree, reclaimWorktree, recreateWorktree, resolveBranchBase, runGit, runSetupCommand, runWorktreeSetup, setupEnv, sweepWorktrees, withPinnedGitProtocols };
