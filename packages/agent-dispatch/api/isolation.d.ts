import { WorktreeRecord, GitRunner, ParkIgnoredFilesPolicy, WorktreeAddRunner, SetupRunner, ReleaseProof, WorktreeReleaseSafety } from '@titan-design/worktree';
import { h as IsolationName } from '../schema.js';
import { A as AgentIdentity } from '../types.js';
import { J as JournalRow, N as NamePresence } from '../ports.js';

/**
 * A peer an isolation strategy is allowed to reason about: an agent that is both
 * a durable identity and currently connected (roster ∩ registry).
 *
 * The caller computes the intersection and hands it in, which is what keeps every
 * strategy pure and testable without a broker. It is also the mechanism behind
 * the claim-as-lease rule: a claim by an agent whose socket has closed is simply
 * absent from `peers`, so it stops blocking with no reaper and no stale lock.
 */
interface LivePeer {
    agentId: string;
    name: string;
    cwd: string;
    /** Paths this peer declared it would modify, from its own allocation. */
    claims?: readonly string[];
}
/** Tree directory name to the name of whoever spawned the agent in it. */
type TreeHolders = () => ReadonlyMap<string, string>;
interface IsolationContext {
    agentId: string;
    agentName: string;
    baseCwd: string;
    /** For file-ownership: the paths this agent declares it will modify. */
    declaredPaths?: string[];
    /** Roster ∩ registry, supplied by the caller. Absent means "assume nobody". */
    peers?: readonly LivePeer[];
    /**
     * A worktree the task system assigned (CC-72). When set, `worktree` isolation
     * ADOPTS it instead of allocating: no branch is created, and release must not
     * remove what this process did not create. Isolation is a property of the
     * work, so the assignment outranks whatever the profile would have chosen.
     */
    assignedWorktree?: string;
    /** CC-283: the record of allocating `assignedWorktree`, which re-creates it if it was removed. */
    assignedRecord?: WorktreeRecord;
    /** For toolset-limited: the profile's tool lists, which the context does not otherwise carry. */
    toolset?: {
        allowedTools?: string[];
        disallowedTools?: string[];
    };
    /** Turns advisory conflicts into refusals. Wired to `--strict`. */
    strict?: boolean;
    /** When this agent stopped: its `agent_exited` time, else its last detach. Anchors the worktree reclaim grace window. */
    stoppedAt?: number;
    /**
     * Discard a leftover branch instead of adopting it. Opt-in, and deliberately
     * on the context rather than defaulted: allocation can destroy commits exactly
     * as release can, so it takes the same explicit instruction.
     */
    forceReset?: boolean;
    /**
     * CC-1158: an `origin/<branch>` a new worktree branch is cut from instead of the
     * default branch: a stacked slice starts on its parent's PR branch. Refused when
     * it cannot be fetched, never quietly replaced by the default branch.
     */
    baseRef?: string;
    /** CC-1469: who holds each worktree, read only when the pool refuses this spawn. */
    treeHolders?: TreeHolders;
}
interface Allocation {
    cwd: string;
    env?: Record<string, string>;
    addDirs?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    /** One line for the agent's brief: "you own src/cli/**; everything else is read-only". */
    note?: string;
    /** Strategy-specific handle: branch, worktree path, claim id. Goes in meta. */
    ref?: Record<string, string>;
    /** Advisory lines for the requester, surfaced in `spawn_result.warnings`. */
    warnings?: string[];
}
interface ReleaseOptions {
    /** Bypass the dirty/unmerged refusal. Explicit destruction only. */
    force?: boolean;
    /** CC-921: release a tree that was already parked, and keep its branch. Refused while the tree is on disk. */
    keepBranch?: boolean;
}
interface IsolationStrategy {
    readonly name: IsolationName;
    /** Pre-flight. Empty array = safe to proceed. Non-empty = reasons, shown to the requester. */
    check(ctx: IsolationContext): Promise<string[]>;
    allocate(ctx: IsolationContext): Promise<Allocation>;
    /** Returns false when it refused (dirty/unmerged) rather than failed; `refusalOf(alloc)` says why. */
    release(ctx: IsolationContext, alloc: Allocation, opts?: ReleaseOptions): Promise<boolean>;
}
/** `cwd` comes from the last strategy that moved it; tools narrow, never widen. */
declare function mergeAllocations(baseCwd: string, parts: readonly Allocation[]): Allocation;
/** Several strategies as one: checks gathered, allocations layered in order, releases unwound in reverse. */
declare function composite(strategies: readonly IsolationStrategy[]): IsolationStrategy;

interface IsolationRegistryOptions {
    /** The worktree strategy reads the host's budgets, so the host builds it and hands it in. */
    worktree: IsolationStrategy;
}
interface IsolationRegistry {
    getStrategy(name: IsolationName): IsolationStrategy;
    /**
     * Compose strategies into one. A profile names exactly one today, but the
     * composite means `['toolset-limited', 'worktree']` stays a config change rather
     * than a refactor. Do not reintroduce the single-strategy assumption into a
     * caller: call this even for one name.
     */
    resolve(names: readonly IsolationName[]): IsolationStrategy;
}
/** One registry per host, rather than a module singleton, because the worktree strategy carries host budget readers. */
declare function createIsolationRegistry(options: IsolationRegistryOptions): IsolationRegistry;

/**
 * `check` returns a single array, but a caller has to tell "you are sharing a
 * checkout with bob" (spawn proceeds, the line goes in `spawn_result.warnings`)
 * from "that branch still holds uncommitted work" (spawn does not proceed).
 * Rather than widen the interface, advisory lines carry this prefix and
 * callers split on it. Anything unprefixed is a refusal.
 *
 * Its own module rather than strategy.ts so that strategies can import the value
 * without a runtime import cycle back through the registry.
 */
declare const WARNING_PREFIX = "warning: ";
declare const warn: (reason: string) => string;
declare const isWarning: (reason: string) => boolean;
declare const refusalsIn: (reasons: readonly string[]) => string[];

declare const recordRefusal: (alloc: Allocation, reason: string) => void;
declare const clearRefusal: (alloc: Allocation) => void;
declare const refusalOf: (alloc: Allocation) => string | undefined;

/**
 * No isolation: the agent works in the same checkout as everyone else.
 *
 * The correct default for `peer` agents, where coordination happens by
 * conversation rather than by partition. `check` warns instead of refusing:
 * sharing a tree with a human or another agent is the intended mode here, not
 * an error, and a refusal would make the common case impossible.
 */
declare const noneStrategy: IsolationStrategy;

declare const toolsetStrategy: IsolationStrategy;

/**
 * Ownership as advice, and, with `--strict`, as a gate.
 *
 * The manifest is built from the claims of currently-CONNECTED agents, so a
 * claim is a lease held by presence. A dead agent's claim stops blocking the
 * moment its socket closes: no stale locks, and nothing to reap.
 */
interface OwnershipRule {
    agentId: string;
    patterns: string[];
}
interface FileOwnershipManifest {
    rules: OwnershipRule[];
}
interface OwnershipConflict {
    pattern: string;
    agents: string[];
}
interface FileOwnershipSummary {
    ownedFiles: string[];
    readOnlyHint: string;
}
/**
 * Match a file path against a glob-like pattern.
 * Supports: `*` (single segment wildcard), `**` (multi-segment), exact matches,
 * and prefix patterns like `src/services/`.
 */
declare function matchPattern(filePath: string, pattern: string): boolean;
/** Build a manifest from a set of agent-to-pattern assignments. */
declare function buildOwnershipManifest(assignments: Array<{
    agentId: string;
    patterns: readonly string[];
}>): FileOwnershipManifest;
/** Detect overlapping ownership: two or more agents claiming the same glob pattern. */
declare function checkConflicts(manifest: FileOwnershipManifest): OwnershipConflict[];
/** Resolve who owns a given file path. Returns the agent ID or null if unowned. */
declare function getOwner(manifest: FileOwnershipManifest, filePath: string): string | null;
/** All owners matching a path: the path-level counterpart to `checkConflicts`. */
declare function getOwners(manifest: FileOwnershipManifest, filePath: string): string[];
/** Build a summary for a specific agent: which files it owns and a read-only hint. */
declare function getAgentOwnershipSummary(manifest: FileOwnershipManifest, agentId: string): FileOwnershipSummary;
/** Format ownership info for inclusion in a dispatch brief. */
declare function formatOwnershipBrief(manifest: FileOwnershipManifest, agentId: string): string;
declare const fileOwnershipStrategy: IsolationStrategy;

/** realpath of the deepest ancestor that exists, with the missing tail rejoined, so a gone path still compares canonically. */
declare function canonicalPath(dir: string): string;
/** Both sides canonical; the separator check keeps a sibling `tree-2` from counting as inside `tree`. */
declare const isAtOrUnder: (real: string, root: string) => boolean;

declare function isReviewerSpawn(profileName: string, agentName: string): boolean;
/**
 * CC-1040: a tree on disk carries only its directory name, so the reviewer worktree pool is
 * decided from the agent name alone, the same way when allocating and when counting.
 */
declare function isReviewerTreeName(name: string): boolean;

/**
 * CC-141: a successor spawned with `worktree:` adopts its predecessor's tree, and adoption
 * leaves ownership with the predecessor, so retiring or parking the predecessor would pull
 * the tree out from under the successor. "Still working" means any identity that is not
 * retired: an exited or detached agent can still be resumed into that cwd. Every roster
 * passed here is the not-retired roster; the retire, bulk-retire and park paths share these
 * rules so the refusal cannot hold on one path and lapse on another.
 */
/** Every identity other than `agentId` whose cwd is the tree or anywhere inside it, symlinks resolved. */
declare function tenantsOf(worktree: string, agentId: string, roster: readonly AgentIdentity[]): AgentIdentity[];
/** A live agent whose cwd is the tree or anywhere inside it, whatever its name or branch (CC-277). */
declare function occupantOf(worktree: string, roster: readonly AgentIdentity[]): AgentIdentity | undefined;
/** The agent being retired, with the isolation it holds. */
interface TreeHolder {
    agentId: string;
    name: string;
    isolation: string;
    /** The allocation's ref: `worktree`, `branch` and `assigned` are read. */
    ref?: Readonly<Record<string, string>>;
}
interface TenancyVerdict {
    refusal?: string;
    warning?: string;
}
/** A retire of a tree another identity works in is refused; `--force` releases it and says so. */
declare function worktreeTenancy(holder: TreeHolder, roster: readonly AgentIdentity[], force: boolean): TenancyVerdict | undefined;
/** The tree an agent allocated, as the bulk retire and park paths see it. */
interface HeldTree {
    worktree: string;
    /** Adopted rather than allocated: not this agent's to remove. */
    assigned: boolean;
}
/** The bulk retire's form of the same rule: skip an agent whose allocated tree another identity works in. */
declare function adopterBlocker(agent: AgentIdentity, target: HeldTree | undefined, roster: readonly AgentIdentity[]): string | undefined;
/** Park refuses while any other identity that is not retired works in the tree, live or not, since it could be resumed there. */
declare function parkTenancyBlocker(agent: AgentIdentity, tree: string, roster: readonly AgentIdentity[]): string | undefined;

/**
 * CC-282: who may have a finished agent's worktree parked. Parking removes the tree and keeps
 * the branch, so `agent resume` re-creates it at the same path. These are the pure rules; the
 * removal itself and its process and unsaved-work checks live beside the worktree strategy.
 */
/** The worktree an agent's newest `isolation_allocated` row records, and whether it was adopted rather than created. */
interface ParkTarget extends WorktreeRecord {
    assigned: boolean;
}
declare function allocatedWorktree(rows: readonly JournalRow[], agentId: string): ParkTarget | undefined;
/** Why `agent` cannot be parked, or undefined when it can. `tracked` means this broker still watches its process. */
declare function parkBlocker(agent: AgentIdentity, tracked: boolean, target: ParkTarget | undefined, roster: readonly AgentIdentity[]): string | undefined;
/** An adopted tree belongs to its owner and a gone one has nothing left to remove. */
declare const parkable: (target: ParkTarget | undefined) => target is ParkTarget;
/** `tracked` means this broker still watches the agent's process, which a detached agent can have. */
declare function liveBlocker(agent: AgentIdentity, tracked: boolean): string | undefined;

/** Uncommitted or unpushed work in the agent's tree, or in its branch when the tree is gone. */
declare function workBlocker(target: ParkTarget, git?: GitRunner): Promise<string | undefined>;

/**
 * CC-1325: the bulk finished retire keeps an implementer or reviewer while a PR it worked on is open,
 * Shepherd-registered or not. Shepherd resumes a non-retired implementer warm and starts a cold
 * successor for a retired one, and a seat re-asks a reviewer by name. Overrides CC-950 for the bulk path only.
 */
interface HeldBranch {
    gitRoot: string;
    branch: string;
}
declare function reviewedAgentName(name: string): string | undefined;
/** Every branch whose open PR holds `agent`; a branch with no repo to ask is dropped. */
declare function heldBranches(agent: AgentIdentity, target: ParkTarget | undefined, roster: readonly AgentIdentity[], events: readonly JournalRow[]): HeldBranch[];

/**
 * CC-323: the skip rules for `agent retire --finished`. Every rule errs towards
 * skipping: a wrong skip costs a line of output, a wrong retire can lose work.
 * The retire itself still goes through the host's retire, so its refusals apply too.
 * CC-1325: it also keeps implementers, Shepherd-registered ones included, and reviewers while their PR is open.
 */
interface RetireScope {
    spawner?: string;
    prefix?: string;
    /**
     * CC-1465: exited over STALE_AFTER_MS ago with no worktree left on disk, machine-wide unless the
     * other fields narrow it; at most STALE_RETIRE_CAP retires a call. The age and cap are the host's.
     */
    stale?: boolean;
}
declare const STALE_AFTER_MS: number;
/** One call's retires, so a backlog drains over passes instead of one long burst under the write lock. */
declare const STALE_RETIRE_CAP = 200;
/** One agent in a bulk retire's plan: retired, or skipped for `reason`. */
interface RetirePlanEntry {
    name: string;
    action: "retire" | "skip";
    reason?: string;
    /** CC-408: set, with `duplicate`, when another unretired row holds the same name. */
    agentId?: string;
    duplicate?: true;
}
/** What `retire` answered for one planned agent; `reason` on success is its caveat. */
interface RetireResult {
    name: string;
    ok: boolean;
    reason?: string;
}
/**
 * CC-904, CC-950 and CC-1325: the reads that keep a finished agent whose PR still needs it. The host
 * implements them over Shepherd and `gh` and memoizes them for a whole plan, since each read spawns a
 * process. Each answers why the agent must stay, or undefined; a read that fails answers a skip.
 */
interface FinishedHolds {
    /** A Shepherd run that names the agent or its branch, or an open PR no run has taken. */
    shepherd(agent: AgentIdentity, target: ParkTarget | undefined): Promise<string | undefined>;
    /** An open PR on any of the branches that hold the agent. */
    openPr(candidates: readonly HeldBranch[]): Promise<string | undefined>;
}
/** What the bulk form reads from, and retires through, the host. */
interface FinishedRetirePort {
    roster(): AgentIdentity[];
    events(): readonly JournalRow[];
    /** This broker still watches the agent's process. */
    tracked(agentId: string): boolean;
    parking(agentId: string): boolean;
    current(agentId: string): AgentIdentity | undefined;
    /** CC-408: liveness from the connected process, since a registry row can say `exited` while it runs. */
    presence(agent: AgentIdentity): NamePresence;
    /** CC-1138: why the caller may not retire this agent, keyed on its spawn row's parent id; undefined when it may. */
    ownership?(agent: AgentIdentity): string | undefined;
    /** CC-408: by id, so a stale row never resolves to the newest holder of its name. */
    retire(agentId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    git?: GitRunner;
    /** CC-904: the open-PR and Shepherd reads; the host always passes them. */
    holds?: FinishedHolds;
    /** Epoch ms the stale scope measures exit age against; defaults to the wall clock. */
    now?: () => number;
}
interface FinishedRetireOutcome {
    ok: boolean;
    reason?: string;
    plan: RetirePlanEntry[];
    results: RetireResult[];
}
declare const SCOPE_REQUIRED = "name --spawner or --prefix; --finished alone would sweep every agent on the machine";
/** Plan every in-scope agent, then retire the planned ones one at a time; one failure never stops the rest. */
declare function retireFinished(port: FinishedRetirePort, req: RetireScope & {
    dryRun?: boolean;
    caller?: string;
}): Promise<FinishedRetireOutcome>;
/** A scope with no field would sweep every agent on the machine, so it matches nothing; `stale` narrows by age instead. */
declare function inScope(agent: AgentIdentity, scope: RetireScope): boolean;
declare function connectedBlocker(port: Pick<FinishedRetirePort, "presence">, agent: AgentIdentity): string | undefined;

/**
 * CC-921: when an opted-in spawner's agent exits after a final `Status:` or `Verdict:`
 * report, the broker parks its clean, pushed tree and retires it, so seats stop spending
 * calls on closeout. The park keeps the branch and the retire keeps it too: nothing on this
 * path deletes a branch. Every check errs towards keeping: a kept tree costs a manual
 * retire, a wrong retire costs work or a Shepherd fix round.
 */
type Outcome$1 = {
    ok: boolean;
    reason?: string;
};
interface ReportRetirePort {
    current(agentId: string): AgentIdentity | undefined;
    roster(): AgentIdentity[];
    events(): readonly JournalRow[];
    /** Whether the spawner opted in through `autoRetire.onFinalReport`. */
    enabledFor(spawner: string): boolean;
    /** The text of the agent's last report to its spawner in this run, if any. */
    lastReport(agent: AgentIdentity): string | undefined;
    /** This broker still watches the agent's process. */
    tracked(agentId: string): boolean;
    holds: Pick<FinishedHolds, "shepherd">;
    /** `agent park` by id: refuses a live-cwd, dirty, off-branch or unpushed tree, and keeps the branch. */
    park(agentId: string): Promise<Outcome$1>;
    /** Retire by id with a branch-keeping release. */
    retire(agentId: string): Promise<Outcome$1>;
}
type ReportRetireResult = {
    action: "off";
} | {
    action: "kept";
    name: string;
    reason: string;
} | {
    action: "retired";
    name: string;
    parked: boolean;
    reason?: string;
};
/** Never rejects: a failure is a kept agent with the reason. */
declare function retireAtReport(port: ReportRetirePort, agentId: string): Promise<ReportRetireResult>;
declare const NOT_FINISHED = "no final Status: DONE, DONE_WITH_CONCERNS or Verdict report";
declare const isFinishedReport: (text: string) => boolean;

/**
 * CC-1039: a spawned non-reviewer agent's tree is parked when the agent exits normally, without
 * waiting for CI and without CC-921's opt-in, because a clean tree whose HEAD origin holds loses
 * nothing: the park keeps the branch and `agent resume` re-creates the tree for a fix round. The
 * `agent park` rules still decide, so a dirty, unpushed or occupied tree stays. A tree a burndown
 * claim still reads stays too, since parking it would stall the claim.
 *
 * CC-976: a reviewer that exited on its final Verdict has its tree parked even when its spawner
 * never opted into CC-921, because a review tree holds no work. The agent is not retired.
 * Shepherd's reviewers never message their spawner; Shepherd reads the Verdict from the last
 * assistant turn of the transcript, often after a lead-in paragraph. So a Verdict line anywhere
 * in either the last report or the final assistant text counts.
 */
interface ParkPort {
    current(agentId: string): AgentIdentity | undefined;
    events(): readonly JournalRow[];
    /** `agent park` by id: refuses a live-cwd, dirty, off-branch or unpushed tree, and keeps the branch. */
    park(agentId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
}
interface ImplementerParkPort extends ParkPort {
    /** `autoPark.onExit`, read per exit. */
    enabled(): boolean;
    /** Why a held burndown claim still reads `tree`, or undefined. */
    treeHold(tree: string): string | undefined;
}
interface ReviewerParkPort extends ParkPort {
    /** The agent's last report to its spawner in this run, if any. */
    lastReport(agent: AgentIdentity): string | undefined;
    /** The final assistant text of the agent's transcript, if any. */
    finalText(agent: AgentIdentity): string | undefined;
}
type ParkAtExitResult = {
    action: "off";
} | {
    action: "kept";
    name: string;
    reason: string;
} | {
    action: "parked";
    name: string;
    reason?: string;
};
declare const NO_VERDICT = "no final Verdict report";
declare const isVerdictText: (text: string) => boolean;
declare function parkImplementerAtExit(port: ImplementerParkPort, agentId: string): Promise<ParkAtExitResult>;
declare function parkReviewerAtReport(port: ReviewerParkPort, agentId: string): Promise<ParkAtExitResult>;

/**
 * CC-1678: one PR's state for the broker's merged-PR retire. The read is async, since a blocking
 * runner would stall every session, and the host decides which budget it spends: `refusal` lets a
 * cooling lane turn the read away before it reaches GitHub, and `after` is where each call is logged
 * and a rate limit starts a cooldown.
 */
/** A PR's head at the time it was read; what a park backs an agent's branch with. */
interface PrHead {
    number: number;
    headSha: string;
}
interface PrState {
    state: "OPEN" | "MERGED" | "CLOSED";
    head: PrHead;
}
/** Rejects when the state cannot be told, which the sweep treats as a kept agent. */
type PrStateReader = (pr: string) => Promise<PrState>;
interface GhOutcome {
    exitCode: number;
    stdout: string;
}
interface PrStateDeps {
    /** Why a `gh` read must not start now, or undefined. */
    refusal(args: readonly string[]): Promise<string | undefined>;
    gh(args: readonly string[]): Promise<GhOutcome>;
    /** Runs after every call that started, whatever its exit code. */
    after(args: readonly string[], outcome: GhOutcome): Promise<void>;
}
interface PrTarget {
    repo: string;
    pr: number;
}
/** `https://github.com/<owner>/<repo>/pull/<n>` or `<owner>/<repo>#<n>`; anything else is not a PR reference. */
declare function prTarget(pr: string | undefined): PrTarget | undefined;
/** `PR:` as `owner/repo#n`; a GitHub pull URL is rewritten to that form, and anything else is not a PR. */
declare function reportPr(report: string): string | null;
declare function parsePrState(stdout: string, number: number): PrState;
declare const prStateReader: (deps: PrStateDeps) => PrStateReader;

/**
 * CC-1678: coordinators retired each exited worker by hand once its PR landed, so the broker does it.
 * The PR is the one the worker's last report names. Every check errs towards keeping, as CC-921's
 * do: a kept agent costs a later pass, a wrong retire costs work. Park keeps the branch and refuses
 * unpushed work, with the PR's head as backing because a merge may have deleted its branch on origin.
 */
type Outcome = {
    ok: boolean;
    reason?: string;
};
declare const MERGED_RETIRE_EVERY_MS: number;
/** A backlog drains over passes, since an answer already held costs nothing. */
declare const PR_READS_PER_PASS = 20;
/** An open PR, or a failed read, is asked about again after this; a terminal state never is. */
declare const PR_REREAD_MS: number;
type PrRead = (pr: string) => Promise<PrState | undefined>;
interface MergedRetirePort extends Pick<FinishedRetirePort, "roster" | "events" | "current" | "tracked" | "parking" | "presence"> {
    /** The text of the agent's last report to its spawner in this run, if any. */
    lastReport(agent: AgentIdentity): string | undefined;
    /** Why a held burndown claim still reads `tree`, or undefined. */
    treeHold(tree: string): string | undefined;
    holds: FinishedHolds;
    readPr: PrRead;
    /** `agent park` by id, with the process check on and `head` as backing. */
    park(agentId: string, head: PrHead): Promise<Outcome>;
    /** Retire by id with a branch-keeping release. */
    retire(agentId: string): Promise<Outcome>;
}
type MergedRetireResult = {
    action: "kept";
    name: string;
    pr: string;
    reason: string;
} | {
    action: "retired";
    name: string;
    pr: string;
    parked: boolean;
};
declare const isWorkerProfile: (profile: string) => boolean;
/** A pass's reader over answers that outlive it, so one PR costs one read however many agents name it. */
declare function passPrReads(read: PrStateReader, clock?: () => number): () => PrRead;
/** One sweep; retires one at a time, and one failure never stops the rest. An open PR reports nothing. */
declare function retireMerged(port: MergedRetirePort): Promise<MergedRetireResult[]>;
/** Runs `pass` on an unref'd interval, never two at once. Returns its cancel. */
declare function startMergedRetireSweep(pass: () => Promise<void>, everyMs?: number): () => void;

/**
 * CC-233: a reviewer profile denies Write and Edit but allows Bash, and shell syntax has too many
 * write forms (`sed -i`, redirects, `git apply`) for a deny pattern to close. So the supervisor
 * detects instead: it fingerprints the reviewed tree before launch and again at exit, and tells
 * the spawner which paths changed. Nothing is reverted; the spawner decides.
 */
declare const REVIEWER_TREE_CHANGED = "reviewer-tree-changed";
/** Each dirty path's status and content hash, plus HEAD, so a commit by the reviewer counts too. */
interface TreeFingerprint {
    head: string;
    entries: Map<string, string>;
}
/** Raw stdout, or null when git fails. Untrimmed: porcelain's first column may be a space. */
type RawGitRunner = (args: readonly string[], cwd: string) => Promise<string | null>;
declare const runRawGit: RawGitRunner;
/** Read-only. Undefined when `cwd` is not a git work tree. */
declare function treeFingerprint(cwd: string, git?: RawGitRunner): Promise<TreeFingerprint | undefined>;
/** Paths whose status or content differ between the two reads; `HEAD` when the commit moved. */
declare function treeChange(before: TreeFingerprint, after: TreeFingerprint): string[];
declare function reviewerDirtyText(name: string, cwd: string, paths: readonly string[]): string;

/** `changes` is plain uncommitted or untracked work; `other` is a failed read or an ignored file kept. */
interface UnsavedWork {
    kind: "changes" | "other";
    detail: string;
}
/** `-uall` so `status.showUntrackedFiles=no` cannot hide an untracked file the removal would take. */
declare function unsavedWork(worktree: string, action: string): Promise<UnsavedWork | undefined>;
/** The same policy for the package's park, which observes status and ignored files itself and asks only what to keep. */
declare const dispatchIgnoredFiles: ParkIgnoredFilesPolicy;

/** CC-1040: Shepherd's reviewer cap, so a full reviewer round never waits on implementer slots. */
declare const DEFAULT_REVIEWER_WORKTREE_BUDGET = 8;
type WorktreePool = "implementer" | "reviewer";
/**
 * CC-1469: a refused coordinator needs to know whether its own trees or another seat's fill the
 * pool. Each tree is charged to its agent's direct spawner, largest holder first.
 */
declare function heldBy(trees: readonly string[], holders: ReadonlyMap<string, string>): string;
/** Newest identity first, so a reused name charges its tree to the latest spawner. */
declare function treeHoldersOf(agents: readonly {
    name: string;
    spawnedBy: string;
}[]): ReadonlyMap<string, string>;
declare class WorktreeBudgetExhaustedError extends Error {
    readonly allocated: number;
    readonly budget: number;
    readonly pool: WorktreePool;
    constructor(allocated: number, budget: number, pool?: WorktreePool, holdings?: string);
}
/** Budget readers, called on every spawn so a host's config edit applies to the next one. */
interface PoolBudgets {
    budget?: () => number;
    reviewerBudget?: () => number;
}
interface PoolUse {
    pool: WorktreePool;
    allocated: number;
    budget: number;
    /** Directory names of the pool's trees. */
    trees: string[];
}

interface WorktreeStrategyOptions extends PoolBudgets {
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
declare function reattachWorktree(record: WorktreeRecord, opts?: WorktreeStrategyOptions, requireBranch?: boolean): Promise<Allocation>;
declare function recreateWorktree(record: WorktreeRecord, opts?: WorktreeStrategyOptions): Promise<Allocation>;
/**
 * Is it safe to destroy this worktree and its branch? Commits are judged by the package; the
 * tree's files by dispatch's own ignored-file policy, the one park uses, since the package's
 * list misses build outputs such as `*.tsbuildinfo` and would hold every built tree.
 */
declare function inspectForRelease(gitRoot: string, worktreePath: string, branch: string, baseRef: string, releaseProof?: ReleaseProof, ghTimeoutMs?: number): Promise<WorktreeReleaseSafety>;
declare function createWorktreeStrategy(opts?: WorktreeStrategyOptions): IsolationStrategy;

export { type Allocation, DEFAULT_REVIEWER_WORKTREE_BUDGET, type FileOwnershipManifest, type FileOwnershipSummary, type FinishedHolds, type FinishedRetireOutcome, type FinishedRetirePort, type GhOutcome, type HeldBranch, type HeldTree, type ImplementerParkPort, type IsolationContext, type IsolationRegistry, type IsolationRegistryOptions, type IsolationStrategy, type LivePeer, MERGED_RETIRE_EVERY_MS, type MergedRetirePort, type MergedRetireResult, NOT_FINISHED, NO_VERDICT, type OwnershipConflict, type OwnershipRule, PR_READS_PER_PASS, PR_REREAD_MS, type ParkAtExitResult, type ParkTarget, type PoolBudgets, type PoolUse, type PrHead, type PrRead, type PrState, type PrStateDeps, type PrStateReader, type PrTarget, REVIEWER_TREE_CHANGED, type RawGitRunner, type ReleaseOptions, type ReportRetirePort, type ReportRetireResult, type RetirePlanEntry, type RetireResult, type RetireScope, type ReviewerParkPort, SCOPE_REQUIRED, STALE_AFTER_MS, STALE_RETIRE_CAP, type TenancyVerdict, type TreeFingerprint, type TreeHolder, type TreeHolders, type UnsavedWork, WARNING_PREFIX, WorktreeBudgetExhaustedError, type WorktreePool, type WorktreeStrategyOptions, adopterBlocker, allocatedWorktree, buildOwnershipManifest, canonicalPath, checkConflicts, clearRefusal, composite, connectedBlocker, createIsolationRegistry, createWorktreeStrategy, dispatchIgnoredFiles, fileOwnershipStrategy, formatOwnershipBrief, getAgentOwnershipSummary, getOwner, getOwners, heldBranches, heldBy, inScope, inspectForRelease, isAtOrUnder, isFinishedReport, isReviewerSpawn, isReviewerTreeName, isVerdictText, isWarning, isWorkerProfile, liveBlocker, matchPattern, mergeAllocations, noneStrategy, occupantOf, parkBlocker, parkImplementerAtExit, parkReviewerAtReport, parkTenancyBlocker, parkable, parsePrState, passPrReads, prStateReader, prTarget, reattachWorktree, recordRefusal, recreateWorktree, refusalOf, refusalsIn, reportPr, retireAtReport, retireFinished, retireMerged, reviewedAgentName, reviewerDirtyText, runRawGit, startMergedRetireSweep, tenantsOf, toolsetStrategy, treeChange, treeFingerprint, treeHoldersOf, unsavedWork, warn, workBlocker, worktreeTenancy };

// ./dist/ports.d.ts
/**
 * The seams the dispatch fold reads and writes through. Each shape follows what
 * agent-chat's supervisor touches today, so a product adapter (the broker's event
 * store, a registry, a claim table) satisfies a port without translation.
 */
/** One durable lifecycle row. The spawn row mints the agent id; every later row cites it in `ref`. */
interface JournalRow {
    kind: string;
    ts: number;
    actor: string;
    target: string | null;
    msgId: string | null;
    ref: string | null;
    body: string | null;
    meta: Record<string, string>;
}
/** The append-only log the roster folds. Order of append is the order of the fold. */
interface AgentJournal {
    append(row: JournalRow): void;
    /** Every row, oldest first. */
    rows(): readonly JournalRow[];
    /** The fold input for one agent: its spawn row and each row citing it, oldest first. */
    rowsFor(agentId: string): readonly JournalRow[];
}
/** How a name's live connection relates to an agent: none, that agent, or another one. */
type NamePresence = 'none' | 'self' | 'other';
/** Ephemeral presence: dies with a socket, unlike the journal. */
interface PresencePort {
    /** The agent id bound to the name's connection, `null` when connected but unbound, `undefined` when not connected. */
    boundAgent(name: string): string | null | undefined;
    namePresence(name: string, agentId: string): NamePresence;
}
interface AdmissionRequest {
    agentId: string;
    name: string;
    /** The harness the launch is for, so a verdict can differ per harness. */
    harness?: string;
}
type AdmissionVerdict = {
    admitted: true;
} | {
    admitted: false;
    reason: string;
};
/** What a readmit of an already-admitted launch concluded. */
type ReadmitOutcome = 'readmitted' | 'unchanged' | 'refused';
/** The launch-integrity seam: types only here; the state machine lives behind an adapter. */
interface AdmissionLedger {
    admit(request: AdmissionRequest): AdmissionVerdict;
    verdict(agentId: string): AdmissionVerdict | undefined;
    readmit(agentId: string): ReadmitOutcome;
}
/** Why a tree must not be reclaimed on retire. Absent is no hold. */
interface RetireHoldPort {
    holdFor(tree: string): string | undefined;
}
interface DispatchHost {
    journal: AgentJournal;
    presence: PresencePort;
    admission: AdmissionLedger;
    retireHold: RetireHoldPort;
}

export type { AdmissionRequest as A, DispatchHost as D, JournalRow as J, NamePresence as N, PresencePort as P, ReadmitOutcome as R, AdmissionLedger as a, AdmissionVerdict as b, AgentJournal as c, RetireHoldPort as d };

// ./dist/schema.d.ts
/**
 * The agent profile shape and its closed value lists, ported from agent-chat's `agents/types.ts`.
 *
 * Runtime arrays rather than bare type unions: profile files are user-authored JSON, so every
 * value has to be checkable at the point a string arrives from disk, not only at compile time.
 * agent-protocol's `/wire` holds the same lists, but this package does not depend on it, so these
 * are copies of agent-chat's values.
 */
declare const ISOLATION_NAMES: readonly ["none", "worktree", "file-ownership", "toolset-limited"];
type IsolationName = (typeof ISOLATION_NAMES)[number];
declare const SURFACE_NAMES: readonly ["headless", "iterm-pane", "iterm-tab", "iterm-window", "tmux-window"];
type SurfaceName = (typeof SURFACE_NAMES)[number];
/**
 * What happens to an agent's pane when the agent itself ends (CC-95). A profile decision: the
 * lifetime of the surface follows what kind of thing was launched. `keep` still closes on retire.
 */
declare const SURFACE_LIFETIMES: readonly ["close-on-exit", "keep"];
type SurfaceLifetime = (typeof SURFACE_LIFETIMES)[number];
/** `keep` for a profile that does not say: the behaviour files written before the field were authored against. */
declare const DEFAULT_SURFACE_LIFETIME: SurfaceLifetime;
declare const EFFORT_LEVELS: readonly ["low", "medium", "high", "xhigh", "max"];
type EffortLevel = (typeof EFFORT_LEVELS)[number];
/** CC-1553: the values Claude Code's `CLAUDE_CODE_PROMPT_CACHE_TTL` accepts. */
declare const CACHE_TTLS: readonly ["5m", "1h"];
type CacheTtl = (typeof CACHE_TTLS)[number];
/**
 * CC-1633: what the pre-push hook refuses; `no-rewrite` denies deletes, non-fast-forwards, mirrors and main or master.
 * CC-1650: `scan-only` is the explicit opt-out to the leak scan alone; an absent field means `no-rewrite`.
 */
declare const PUSH_POLICIES: readonly ["no-rewrite", "scan-only"];
type PushPolicy = (typeof PUSH_POLICIES)[number];
/**
 * CC-163: what an agent may do with the bus beyond its own work. A coordinator may spawn agents
 * and run with Remote Control; a worker may do neither and reports needs to its spawner instead.
 */
declare const AGENT_ROLES: readonly ["coordinator", "worker"];
type AgentRole = (typeof AGENT_ROLES)[number];
/** CC-1516: the CLI a profile launches. Absent means `claude-code`, the only one with a launch plan today. */
declare const HARNESSES: readonly ["claude-code", "codex"];
type Harness = (typeof HARNESSES)[number];
/** The settings files `--setting-sources` can name; `user` is the one holding the account's own allow rules. */
declare const SETTING_SOURCES: readonly ["user", "project", "local"];
type SettingSource = (typeof SETTING_SOURCES)[number];
/** CC-286: the report rules a dispatcher appends to a spawned agent's brief. */
declare const RETURN_CONTRACTS: readonly ["implementer", "reviewer"];
type ReturnContract = (typeof RETURN_CONTRACTS)[number];
declare const CONTRACT_CHOICES: readonly ["implementer", "reviewer", "none"];
type ContractChoice = (typeof CONTRACT_CHOICES)[number];
declare const isIsolationName: (value: unknown) => value is "none" | "worktree" | "file-ownership" | "toolset-limited";
declare const isSurfaceName: (value: unknown) => value is "headless" | "iterm-pane" | "iterm-tab" | "iterm-window" | "tmux-window";
declare const isSurfaceLifetime: (value: unknown) => value is "close-on-exit" | "keep";
declare const isEffortLevel: (value: unknown) => value is "low" | "medium" | "high" | "xhigh" | "max";
declare const isCacheTtl: (value: unknown) => value is "5m" | "1h";
declare const isPushPolicy: (value: unknown) => value is "no-rewrite" | "scan-only";
declare const isRole: (value: unknown) => value is "coordinator" | "worker";
declare const isHarness: (value: unknown) => value is "claude-code" | "codex";
declare const isContractChoice: (value: unknown) => value is "none" | "implementer" | "reviewer";
/**
 * A profile bundles the things that always travel together, so a spawn is one noun rather than
 * six flags.
 *
 * There is deliberately no `permissionMode` field. A profile widens a posture by naming tools,
 * which is reviewable in a diff; a mode flag widens it by category, which is not.
 */
interface AgentProfile {
    name: string;
    description: string;
    /** Absent means `claude-code`. A `codex` profile loads but refuses every launch until its launch plan exists (CC-1517). */
    harness?: Harness;
    model: string;
    /**
     * Passed to --allowed-tools, and THE permission lever. Too wide leaks authority; too narrow
     * yields an agent that silently produces degraded output.
     */
    allowedTools: string[];
    /** The only list that takes a tool away: `allowedTools` grants, it never removes. */
    disallowedTools?: string[];
    isolation: IsolationName;
    surface: SurfaceName;
    /** Whether this kind of agent's pane goes with it when it ends. Inert for a headless profile. */
    surfaceLifetime?: SurfaceLifetime;
    /** Absent means `worker`: spawning and Remote Control are opted into, never granted by omission. */
    role?: AgentRole;
    /** CC-924: spawn and teleport with Remote Control unless the request says otherwise. Coordinator profiles only. */
    remoteControl?: boolean;
    /** Absent means the contract is inferred from the name and grants; `none` opts out. */
    returnContract?: ContractChoice;
    /** Passed as --effort when set; unset leaves the harness default. */
    effort?: EffortLevel;
    /** Sets `CLAUDE_CODE_PROMPT_CACHE_TTL`, over any value in `env`; unset leaves the harness default. */
    cacheTtl?: CacheTtl;
    /** Absent or `no-rewrite` selects the no-rewrite pre-push hook; only `scan-only` leaves pushes to the leak scan alone (CC-1650). */
    pushPolicy?: PushPolicy;
    /** Appended via --append-system-prompt, after the standard peer preamble. */
    promptPrelude: string;
    /** Extra MCP servers merged into the generated --mcp-config. */
    mcpServers?: Record<string, unknown>;
    /** Load only the generated --mcp-config. Absent means on for a headless worker. */
    strictMcpConfig?: boolean;
    /** Passed to --setting-sources. Absent means project and local for a worker, and no flag for a coordinator. */
    settingSources?: SettingSource[];
    /** Drop every skill and slash command, which otherwise load into each turn. */
    disableSlashCommands?: boolean;
    /** Extra environment for the launched process. Never overrides AGENT_CHAT_* or CLAUDE_CONFIG_DIR. */
    env?: Record<string, string>;
    /** Set by the parser, never read from a file: unknown keys and the denies it derived. */
    warnings?: string[];
}

export { type AgentProfile as A, CACHE_TTLS as C, DEFAULT_SURFACE_LIFETIME as D, EFFORT_LEVELS as E, HARNESSES as H, ISOLATION_NAMES as I, PUSH_POLICIES as P, RETURN_CONTRACTS as R, SETTING_SOURCES as S, AGENT_ROLES as a, type AgentRole as b, CONTRACT_CHOICES as c, type CacheTtl as d, type ContractChoice as e, type EffortLevel as f, type Harness as g, type IsolationName as h, type PushPolicy as i, type ReturnContract as j, SURFACE_LIFETIMES as k, SURFACE_NAMES as l, type SettingSource as m, type SurfaceLifetime as n, type SurfaceName as o, isCacheTtl as p, isContractChoice as q, isEffortLevel as r, isHarness as s, isIsolationName as t, isPushPolicy as u, isRole as v, isSurfaceLifetime as w, isSurfaceName as x };

// ./dist/types.d.ts
/** The identity shapes the roster folds into. Mirrors agent-chat's protocol so a product adapter needs no translation. */
declare const AGENT_LIFECYCLES: readonly ["spawning", "live", "detached", "exited", "retired"];
type AgentLifecycle = (typeof AGENT_LIFECYCLES)[number];
declare const AGENT_ORIGINS: readonly ["spawned", "adopted"];
type AgentOrigin = (typeof AGENT_ORIGINS)[number];
declare const LAUNCHERS: readonly ["seat-watchdog", "shepherd"];
type Launcher = (typeof LAUNCHERS)[number];
declare const launcherOf: (value: unknown) => Launcher | undefined;
/** The principal that stands for a person at the keyboard. */
declare const HUMAN = "human";
interface AgentExit {
    code: number | null;
    summary: string;
    costUsd?: number;
    failedToStart?: boolean;
    inferred?: boolean;
}
/** A durable agent identity: who it is, never whether it is plugged in. */
interface AgentIdentity {
    agentId: string;
    name: string;
    profile: string;
    state: AgentLifecycle;
    origin: AgentOrigin;
    spawnedBy: string;
    launchedBy?: Launcher;
    spawnedAt: number;
    /** Read off the spawn row on demand; not enumerable, so a serialised roster leaves it out. */
    brief: string;
    cwd: string;
    isolation: string;
    surface: string;
    sessionId: string;
    configDir?: string;
    configDirUnset?: boolean;
    host?: string;
    provisionalName?: true;
    repo?: string;
    branch?: string;
    base?: {
        sha: string;
        ref: string;
    };
    task?: string;
    workRole?: string;
    workRoleInferred?: true;
    lastEventAt: number;
    exitedAt?: number;
    detachedAt?: number;
    generation: number;
    teleportFrom?: string;
    /** `null` when the spawn row records none; absent when the row cannot say. */
    predecessor?: string | null;
    exit?: AgentExit;
}
/** What an agent-list page asks the roster to cut. */
interface RosterView {
    spawner?: string;
    prefix?: string;
    includeFinished?: boolean;
    includeRetired?: boolean;
    limit?: number;
}
/** How many rows each cut dropped, so a reader knows the page is not the whole roster. */
interface RosterHidden {
    finished: number;
    retired: number;
    overLimit: number;
}
/** A message read back from the log, as a report to carry into a successor's brief. */
interface QueueItem {
    msgId: string;
    kind: string;
    from: string;
    text: string;
    at: number;
    meta: Record<string, string>;
}

export { type AgentIdentity as A, HUMAN as H, LAUNCHERS as L, type QueueItem as Q, type RosterView as R, type RosterHidden as a, AGENT_LIFECYCLES as b, AGENT_ORIGINS as c, type AgentExit as d, type AgentLifecycle as e, type AgentOrigin as f, type Launcher as g, launcherOf as l };
