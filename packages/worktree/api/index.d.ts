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
/** pnpm 10 ranks this file's ignorePnpmfile and ignoreScripts above every env pin. */
declare const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";
/** npm exec exports this file's keys as npm_config_* over the env pins, and its registry picks what npx runs. */
declare const NPMRC_FILE = ".npmrc";
/** An allowlist of what an install needs: the step runs with the host's authority, outside any permission profile. */
declare function setupEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** Keys it does not know are ignored, so a newer declaration still runs on an older host. */
declare function parseSetupStep(text: string): SetupStep | null | string;
/** Its own process group, so a timeout also kills what the step spawned (npm runs scripts in children). */
declare const runSetupCommand: SetupRunner;
/** Whether a declared step reinstalled the tree's dependencies. */
type SetupOutcome = "ran" | "none" | "skipped" | "failed";
interface SetupReport {
    outcome: SetupOutcome;
    warnings: string[];
}
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
declare function setupWorktree(target: SetupTarget, run?: SetupRunner): Promise<SetupReport>;
/** The warnings of {@link setupWorktree}, for callers that record no outcome. */
declare function runWorktreeSetup(target: SetupTarget, run?: SetupRunner): Promise<string[]>;

declare const DEFAULT_WORKTREE_BUDGET = 3;
declare const DEFAULT_BASE_PATH = ".worktrees";
/** Ownership marker: the sweep treats only branches carrying this prefix as its own. */
declare const BRANCH_PREFIX = "agent-chat/";
declare const DEFAULT_FETCH_TIMEOUT_MS = 15000;
declare const DEFAULT_GH_TIMEOUT_MS = 3000;
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
type ReleaseProof = "git" | "git-or-merged-pr-tip";
interface WorktreeOptions {
    /** Git-only by default; opt in to exact merged PR head/commit evidence, never a dirty-check override. */
    releaseProof?: ReleaseProof;
    /** Relative to the git root. */
    basePath?: string;
    /** Per-repository cap on allocated worktrees. A function is read on every allocation. */
    budget?: number | ((name: string) => number);
    /** Partition capacity by sanitized agent/directory name; the host owns group names and policy. */
    allocationGroup?: (name: string) => string;
    /** Preserve the host error class and wording when its capacity is exhausted. */
    budgetError?: (allocated: number, budget: number, name: string) => Error;
    /** Leave setup orchestration to the caller. Default behavior still runs the trusted declaration. */
    skipSetup?: boolean;
    branchPrefix?: string;
    /** Bound on fetching origin's default branch before cutting a new one. */
    fetchTimeoutMs?: number;
    /** Bound on each `gh pr view` a release makes; a `gh` that outlives it supplies no landing proof. */
    ghTimeoutMs?: number;
    /** Bound on one `git worktree add`; the add is killed and the repo's queue moves on when it passes. */
    addTimeoutMs?: number;
    /** Runs each `git worktree add`; tests inject one to observe how adds interleave. */
    runWorktreeAdd?: WorktreeAddRunner;
    /** Include the actual setup target selected for this operation; metadata alone does not suppress setup. */
    includeSetupTarget?: boolean;
    /** Runs the repository's declared setup step; tests inject one so no real install runs. */
    runSetup?: SetupRunner;
}

/** The commit a new branch is cut from, the ref it was read from, and a warning when that ref is not origin's. */
interface BranchBase {
    sha: string;
    ref: string;
    warning?: string;
}
/** The timeout is one budget shared by every candidate, not one per candidate. */
declare function fetchDefaultTip(gitRoot: string, timeoutMs: number): Promise<BranchBase | string>;
/**
 * The main checkout's HEAD may lag origin or hold another session's unpushed
 * commits, and a branch cut from it ships both. So cut from a fresh fetch of
 * origin's default branch, and say so loudly when that is impossible.
 */
declare function resolveBranchBase(gitRoot: string, timeoutMs: number): Promise<BranchBase>;
/** Fetch a requested origin branch without silently substituting the default branch. */
declare function resolveRequestedBase(gitRoot: string, ref: string, timeoutMs: number): Promise<BranchBase>;

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
    /** Opt-in data selected by this operation, not an origin-authentication claim. Absent when no setup base was selected. */
    setupTarget?: SetupTarget;
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
    /** Fetch this origin branch for the checkout, with no default-branch fallback. */
    baseRef?: string;
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
    refusalCode?: "unsaved-changes";
};
interface WorktreeAllocator {
    check(req: WorktreeRequest): Promise<WorktreeCheck>;
    allocate(req: WorktreeRequest): Promise<WorktreeAllocation>;
    /** A refusal (dirty, unmerged, inside the grace window) leaves everything on disk. */
    release(req: Pick<WorktreeRequest, "exitedAt">, alloc: {
        ref?: Record<string, string>;
    }, opts?: {
        force?: boolean;
        keepBranch?: boolean;
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
/** A missing assigned tree cannot be re-created without its caller's matching allocation record. */
declare class MissingAssignedWorktreeRecordError extends Error {
    readonly worktreePath: string;
    constructor(worktreePath: string);
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
 * The caller's GIT_ALLOW_PROTOCOL narrowed to the safe list, or undefined (leave it unset) when the
 * caller set none or the legacy full list. git reads an exported list over every `protocol.*.allow`
 * config, so exporting one for a caller who never chose it would lift their own denies (CC-1336).
 * A caller list with nothing safe in it (`ext` alone) gives '', which git reads as allowing no transport.
 */
declare function pinGitProtocols(value: string | undefined): string | undefined;
/** `env` with the transport pin, for a child that may run git without going through `gitChildEnv`. */
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

/** A copied snapshot of the actual local branch and commit being parked. */
interface ParkLocalBackingObservation {
    readonly branch: string;
    readonly head: string;
    readonly worktree: string;
}
/** Caller-supplied local commit and opaque correlation; not authenticated provider evidence. */
interface ParkLocalBackingCandidate {
    readonly oid: string;
    readonly ref: string;
}
/** Called lazily only when ordinary origin backing did not prove the captured HEAD. */
type ParkLocalBackingReader = (observation: Readonly<ParkLocalBackingObservation>) => Promise<readonly ParkLocalBackingCandidate[]>;

/** A fresh package-owned ignored-file observation, not caller-supplied clearance. */
interface ParkIgnoredFilesObservation {
    readonly worktree: string;
    readonly entries: readonly string[];
}
/** Product policy over ignored files only; dirty work and failed reads cannot be waived. */
interface ParkIgnoredFilesPolicy {
    readonly expandDirectories?: boolean;
    readonly protectedEntries: (observation: ParkIgnoredFilesObservation) => readonly string[];
    readonly formatRefusal?: (observation: ParkIgnoredFilesObservation) => string;
}

/** Parking keeps the local branch; an opt-in fresh default proof can establish its commits are already backed. */
interface ParkOptions {
    /** Lazy caller-supplied local commit backing; requires allowOriginHeadAncestor strictly true. */
    localBackingCandidates?: ParkLocalBackingReader;
    /** Explicit policy over fresh ignored files only; dirty status and failed observations always refuse. */
    ignoredFiles?: ParkIgnoredFilesPolicy;
    /** Retain the actual branch when tracking or a fresh origin-head ancestry proof backs its HEAD. */
    allowOriginHeadAncestor?: boolean;
    /** Permit a missing origin/branch only when a fresh DEFAULT fetch contains the actual HEAD. */
    allowDefaultBranchAncestor?: boolean;
    /** Positive finite fetch budget; invalid values refuse without fetching. Defaults to 15 seconds. */
    fetchTimeoutMs?: WorktreeOptions["fetchTimeoutMs"];
}

/** A selected local candidate adds only its opaque correlation; ordinary origin success has no backingRef. */
declare function parkWorktree(target: WorktreeRecord, recheck: (() => string | undefined) | undefined, options: ParkOptions & {
    allowOriginHeadAncestor: true;
    localBackingCandidates: ParkLocalBackingReader;
}): Promise<{
    ok: true;
    head: string;
    branch: string;
    containedIn?: string;
    backingRef?: string;
} | {
    ok: false;
    reason: string;
}>;
/** Explicit origin-head proof reports the actual retained branch and any differently named backing head. */
declare function parkWorktree(target: WorktreeRecord, recheck: (() => string | undefined) | undefined, options: ParkOptions & {
    allowOriginHeadAncestor: true;
}): Promise<{
    ok: true;
    head: string;
    branch: string;
    containedIn?: string;
} | {
    ok: false;
    reason: string;
}>;
/** Refuse file loss, recheck lifecycle immediately before nonforced removal, and always keep the local branch. */
declare function parkWorktree(target: WorktreeRecord, recheck?: () => string | undefined, options?: ParkOptions): Promise<{
    ok: true;
    head: string;
} | {
    ok: false;
    reason: string;
}>;

/** Caller policy: extra ignored paths that count as disposable. `*` matches within a segment, `**` across segments; a pattern also covers everything beneath a match. */
interface IgnoredFilesPolicy {
    readonly disposable: readonly string[];
}

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
declare function inspectForRelease(gitRoot: string, worktreePath: string, branch: string, baseRef: string, releaseProof?: ReleaseProof, ghTimeoutMs?: number, ignoredFiles?: IgnoredFilesPolicy): Promise<WorktreeReleaseSafety>;
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
    /** Synchronous presentation of an already classified holds-work observation; cannot change its status. */
    formatSafetyDetail?: (safety: Readonly<Pick<WorktreeReleaseSafety, "dirty" | "unmerged">>) => string;
    /** Extra ignored paths that do not make a tree hold work; the built-in regenerable list always applies. */
    ignoredFiles?: IgnoredFilesPolicy;
}
declare const porcelain: GitLister;
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
 * lifecycle guard rather than advice. File and commit safety is observed again
 * before ordinary removal because the tree may have changed since the sweep.
 * No new exit timestamp is inferred from the report.
 */
declare function reclaimWorktree(entry: SweptWorktree, options?: {
    force?: boolean;
}): Promise<{
    ok: boolean;
    reason?: string;
}>;

export { BRANCH_PREFIX, type BranchBase, DEFAULT_BASE_PATH, DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_GH_TIMEOUT_MS, DEFAULT_SETUP_TIMEOUT_MS, DEFAULT_STRIPPED_ENV_PREFIXES, DEFAULT_WORKTREE_BUDGET, type FoundWorktree, type GitLister, type GitPresence, type GitRunner, type HeldWorktree, type IgnoredFilesPolicy, MissingAssignedWorktreeRecordError, NPMRC_FILE, OriginUnreachableError, PNPM_WORKSPACE_FILE, type ParkIgnoredFilesObservation, type ParkIgnoredFilesPolicy, type ParkLocalBackingCandidate, type ParkLocalBackingObservation, type ParkLocalBackingReader, type ParkOptions, RECLAIM_GRACE_MS, type ReleaseCheck, type ReleaseProof, SAFE_GIT_PROTOCOLS, SETUP_FILE, SETUP_LOG, type SetupOutcome, type SetupReport, type SetupResult, type SetupRunner, type SetupStep, type SetupTarget, type SweepOptions, type SweepOwner, type SweepStatus, type SweptWorktree, WORKTREE_ADD_TIMEOUT_MS, type WorktreeAddRunner, type WorktreeAllocation, type WorktreeAllocator, WorktreeBudgetExhaustedError, type WorktreeCheck, WorktreeInUseError, type WorktreeOptions, type WorktreeRecord, type WorktreeReleaseOutcome, type WorktreeReleaseSafety, type WorktreeRequest, agentWorktreesIn, createWorktreeAllocator, describeRefusal, fetchDefaultTip, findGitRoot, gitChildEnv, inspectForRelease, isLive, porcelain as listWorktreesPorcelain, observedPresence, parkWorktree, parseSetupStep, pinGitProtocols, pruneStaleWorktrees, reattachWorktree, reclaimWorktree, recreateWorktree, resolveBranchBase, resolveRequestedBase, runGit, runSetupCommand, runWorktreeSetup, setupEnv, setupWorktree, sweepWorktrees, withPinnedGitProtocols };
