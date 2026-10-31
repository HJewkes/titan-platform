import { WorktreeRecord } from '@titan-design/worktree';
import { h as IsolationName } from '../schema.js';
import { A as AgentIdentity } from '../types.js';
import { J as JournalRow } from '../ports.js';

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

export { type Allocation, type FileOwnershipManifest, type FileOwnershipSummary, type HeldTree, type IsolationContext, type IsolationRegistry, type IsolationRegistryOptions, type IsolationStrategy, type LivePeer, type OwnershipConflict, type OwnershipRule, type ParkTarget, type ReleaseOptions, type TenancyVerdict, type TreeHolder, type TreeHolders, WARNING_PREFIX, adopterBlocker, allocatedWorktree, buildOwnershipManifest, canonicalPath, checkConflicts, clearRefusal, composite, createIsolationRegistry, fileOwnershipStrategy, formatOwnershipBrief, getAgentOwnershipSummary, getOwner, getOwners, isAtOrUnder, isReviewerSpawn, isReviewerTreeName, isWarning, liveBlocker, matchPattern, mergeAllocations, noneStrategy, occupantOf, parkBlocker, parkTenancyBlocker, parkable, recordRefusal, refusalOf, refusalsIn, tenantsOf, toolsetStrategy, warn, worktreeTenancy };

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
