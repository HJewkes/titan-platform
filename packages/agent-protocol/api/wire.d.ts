import { z } from 'zod';

declare const SURFACE_NAMES: readonly ["headless", "iterm-pane", "iterm-tab", "iterm-window", "tmux-window"];
declare const ISOLATION_NAMES: readonly ["none", "worktree", "file-ownership", "toolset-limited"];
declare const SurfaceNameSchema: z.ZodEnum<{
    headless: "headless";
    "iterm-pane": "iterm-pane";
    "iterm-tab": "iterm-tab";
    "iterm-window": "iterm-window";
    "tmux-window": "tmux-window";
}>;
declare const IsolationNameSchema: z.ZodEnum<{
    none: "none";
    worktree: "worktree";
    "file-ownership": "file-ownership";
    "toolset-limited": "toolset-limited";
}>;
type SurfaceName = z.infer<typeof SurfaceNameSchema>;
type IsolationName = z.infer<typeof IsolationNameSchema>;
declare const SUBSCRIBABLE_KINDS: readonly ["registered", "deregistered", "agent_spawned", "agent_attached", "agent_detached", "agent_resumed", "agent_exited", "agent_retired", "agent_spawn_refused"];
declare const WAKE_SOURCES: readonly ["watchdog", "shepherd"];
declare const SubscribableKindSchema: z.ZodEnum<{
    registered: "registered";
    deregistered: "deregistered";
    agent_spawned: "agent_spawned";
    agent_attached: "agent_attached";
    agent_detached: "agent_detached";
    agent_resumed: "agent_resumed";
    agent_exited: "agent_exited";
    agent_retired: "agent_retired";
    agent_spawn_refused: "agent_spawn_refused";
}>;
declare const WakeSourceSchema: z.ZodEnum<{
    watchdog: "watchdog";
    shepherd: "shepherd";
}>;
type SubscribableKind = z.infer<typeof SubscribableKindSchema>;
type WakeSource = z.infer<typeof WakeSourceSchema>;
declare const SURFACE_LIFETIMES: readonly ["close-on-exit", "keep"];
declare const SurfaceLifetimeSchema: z.ZodEnum<{
    "close-on-exit": "close-on-exit";
    keep: "keep";
}>;
type SurfaceLifetime = z.infer<typeof SurfaceLifetimeSchema>;
declare const EFFORT_LEVELS: readonly ["low", "medium", "high", "xhigh", "max"];
declare const EffortLevelSchema: z.ZodEnum<{
    low: "low";
    medium: "medium";
    high: "high";
    xhigh: "xhigh";
    max: "max";
}>;
type EffortLevel = z.infer<typeof EffortLevelSchema>;
declare const AGENT_ROLES: readonly ["coordinator", "worker"];
declare const AgentRoleSchema: z.ZodEnum<{
    coordinator: "coordinator";
    worker: "worker";
}>;
type AgentRole = z.infer<typeof AgentRoleSchema>;
declare const SETTING_SOURCES: readonly ["user", "project", "local"];
declare const SettingSourceSchema: z.ZodEnum<{
    user: "user";
    project: "project";
    local: "local";
}>;
type SettingSource = z.infer<typeof SettingSourceSchema>;
declare const RETURN_CONTRACTS: readonly ["implementer", "reviewer"];
declare const ReturnContractSchema: z.ZodEnum<{
    implementer: "implementer";
    reviewer: "reviewer";
}>;
type ReturnContract = z.infer<typeof ReturnContractSchema>;
declare const AGENT_LIFECYCLES: readonly ["spawning", "live", "detached", "exited", "retired"];
declare const AgentLifecycleSchema: z.ZodEnum<{
    spawning: "spawning";
    live: "live";
    detached: "detached";
    exited: "exited";
    retired: "retired";
}>;
type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;
declare const AGENT_ORIGINS: readonly ["spawned", "adopted"];
declare const AgentOriginSchema: z.ZodEnum<{
    spawned: "spawned";
    adopted: "adopted";
}>;
type AgentOrigin = z.infer<typeof AgentOriginSchema>;
declare const EVENT_KINDS: readonly ["message", "broadcast", "question", "notice", "answer", "resolution", "approval_request", "registered", "deregistered", "route_failed", "agent_spawned", "agent_attached", "agent_detached", "agent_resumed", "agent_exited", "agent_retired", "agent_handoff", "agent_stood_down", "isolation_allocated", "isolation_released", "isolation_parked", "agent_spawn_refused", "verdict_refused", "endorse_request", "decided", "seat_blocked", "seat_unblocked", "seat_activity", "seat_ask_denied"];
declare const EventKindSchema: z.ZodEnum<{
    registered: "registered";
    deregistered: "deregistered";
    agent_spawned: "agent_spawned";
    agent_attached: "agent_attached";
    agent_detached: "agent_detached";
    agent_resumed: "agent_resumed";
    agent_exited: "agent_exited";
    agent_retired: "agent_retired";
    agent_spawn_refused: "agent_spawn_refused";
    message: "message";
    broadcast: "broadcast";
    question: "question";
    notice: "notice";
    answer: "answer";
    resolution: "resolution";
    approval_request: "approval_request";
    route_failed: "route_failed";
    agent_handoff: "agent_handoff";
    agent_stood_down: "agent_stood_down";
    isolation_allocated: "isolation_allocated";
    isolation_released: "isolation_released";
    isolation_parked: "isolation_parked";
    verdict_refused: "verdict_refused";
    endorse_request: "endorse_request";
    decided: "decided";
    seat_blocked: "seat_blocked";
    seat_unblocked: "seat_unblocked";
    seat_activity: "seat_activity";
    seat_ask_denied: "seat_ask_denied";
}>;
type EventKind = z.infer<typeof EventKindSchema>;

type SubscriptionSelector = {
    all: true;
} | {
    name: string;
} | {
    tag: string;
} | {
    spawnedBy: 'self';
};
interface Subscription {
    selector: SubscriptionSelector;
    kinds: SubscribableKind[];
}
interface ExperimentArm {
    id: string;
    arm: string;
}
type SpawnRequest = {
    t: 'spawn';
    name: string;
    profile: string;
    brief: string;
    cwd?: string;
    isolation?: IsolationName;
    surface?: SurfaceName;
    /**
     * An active-work initiative slug, or `auto`, whose brief, open tasks and
     * latest session are prepended to `brief` by the broker (CC-63), followed by
     * what the active-work daemon ranks as related to `brief` (CC-101). Sent as a
     * pointer rather than as text so the requester cannot use it to have
     * arbitrary files read back to it — the broker resolves what it will read.
     */
    briefing?: string;
    /**
     * A worktree the TASK SYSTEM assigned, rather than one the profile's
     * isolation strategy chose (CC-72). Isolation is a property of the work,
     * not of the agent: several tasks can share one worktree under file
     * ownership, and a child task inherits its parent's. agent-chat's side of
     * that is ACCEPTING an assignment, never computing one — so this is an
     * absolute path that must already exist, and the strategy is bypassed
     * rather than asked.
     */
    worktree?: string;
    /**
     * Path globs, relative to the worktree, that this agent owns (CC-81).
     * Turns `file-ownership` isolation from a no-op into a real assignment:
     * they become the agent's claim, checked against what live peers already
     * hold in the same worktree.
     */
    owns?: string[];
    /**
     * CC-952: path globs, relative to the agent's own worktree, the broker
     * claims as a `files` claim held by the agent's name, so the burndown tick
     * sees them before the agent registers. Unlike `owns` it isolates nothing
     * and is accepted with a worktree profile.
     */
    claimPaths?: string[];
    /** CC-1158: the `origin/<branch>` a worktree spawn is cut from; a stacked slice names its parent's PR branch. */
    baseRef?: string;
    /**
     * CC-44: start the agent from a COPY of the requester's own conversation
     * instead of from an empty one. `'context'` is the only value, and there
     * is deliberately no field naming WHOSE conversation — the broker resolves
     * that from the requesting connection, the same discipline `anchor` and
     * `parentAgentId` follow, because a fork hands an entire conversation to a
     * new process and only the session that owns one may do that.
     */
    inherit?: 'context';
    /** H-12: explicit opt-in to `--remote-control` for an interactive agent; headless ignores it. */
    remoteControl?: boolean;
    /**
     * The Claude Code session id the requester claims to be forking, checked
     * against the one the broker observed for this connection and REFUSED when
     * they differ.
     *
     * Exists only to make that refusal explicit. The MCP tool never sends it —
     * a model has no way to name a transcript — but the socket is one client
     * among several (see `sanitizeSubscriptions` for the same reasoning), and a
     * raw client asking to fork a peer should be told no rather than quietly
     * getting its own transcript back.
     */
    forkFrom?: string;
    /** Tags and subscriptions the spawned agent starts with, before it runs. */
    tags?: string[];
    subscriptions?: Subscription[];
    /**
     * CC-100: the Claude config dir — and therefore the ACCOUNT — this agent
     * should run on, named explicitly. An absolute path under the user's home
     * that already exists; anything else is refused rather than corrected,
     * because running on a different account than the one asked for is the
     * failure this field exists to prevent.
     */
    configDir?: string;
    /**
     * The REQUESTER's own `CLAUDE_CONFIG_DIR`, observed by its MCP server from
     * its own environment (CC-100).
     *
     * Sent rather than only read from the registry because the human at the CLI
     * holds no registry entry to read it from, and they are the caller most
     * likely to have switched accounts in their shell. For a registered session
     * the broker falls back to what that session reported on `register`, which
     * is the same value from the same environment.
     */
    spawnerConfigDir?: string;
    /**
     * CC-126: a Claude Code session uuid to continue instead of minting a new
     * one. Its transcript must already exist under the chosen config dir and
     * cwd; the broker refuses otherwise and names the path it checked.
     */
    resumeSession?: string;
    /**
     * CC-133: the name of the agent whose work this one takes over. Sent as a
     * name, not text: the broker reads its last report, branch and transcript
     * from the log, and refuses unless the requester spawned it.
     */
    predecessor?: string;
    /** CC-168: the experiment and arm this spawn runs; both must be non-empty or the spawn is refused. */
    experiment?: ExperimentArm;
    /** CC-286: `none` stops the broker appending its return contract to `brief`. */
    returnContract?: 'none';
    /** CC-774: the class-of-service tier the burndown plan placed the task in; recorded on the `dispatched` row. */
    tier?: number;
    /**
     * CC-802: who a CLI spawn is on behalf of. Only an unregistered connection's claim is read, since a
     * session is already named by its registration; the row then records it in place of the human.
     */
    spawnedAs?: 'burndown' | 'shepherd';
    /** CC-1206: the agent identity in the CLI caller's env; only lowers trust, read only from an unregistered connection. */
    callerAgent?: string;
    /** CC-915: the task id the agent runs, recorded on its spawn row; a burndown spawn without one is refused. */
    task?: string;
    /** CC-915: implementer, reviewer, fix-round-N, shepherd-review, planner or other; inferred when absent. */
    workRole?: string;
    /** CC-932: `fix-round` states that a spawn on a claimed or brief-ready task is the seat's own fix round. */
    override?: 'fix-round';
    /** CC-1059: the requester's own OS, sent by its process and never by the model; picks a remote surface. */
    hostPlatform?: string;
    /** CC-1059: the requester can launch a spawn on its own host; absent is an older client, launched here. */
    launchesHere?: true;
    /** CC-1059: the machine to launch on, a config `machines` alias or a hostname. */
    host?: string;
    /** CC-1059: the CLI's own hostname. Read only from an unregistered connection; a session's comes from its registration. */
    callerHost?: string;
    /** CC-1059: the requester's home, which the broker's lexical cwd check holds a remote cwd under. */
    callerHome?: string;
};
type ResumeRequest = {
    t: 'resume';
    name: string;
    surface?: SurfaceName;
    message?: string;
    source?: WakeSource;
    /** CC-883: run with `--remote-control` if the agent is a coordinator; a worker resumes without it. */
    remoteControl?: boolean;
};
type RetireRequest = {
    t: 'retire';
    name: string;
    force?: boolean;
    caller?: string;
    agentId?: string;
};
type AgentListRequest = {
    t: 'agents';
    includeRetired?: boolean;
};
type SurfaceRequest = {
    t: 'surface';
    name: string;
};

declare const WORK_ROLES: readonly ["implementer", "reviewer", "shepherd-review", "planner", "other"];
type WorkRole = (typeof WORK_ROLES)[number] | `fix-round-${number}`;
/** Captured legacy MCP input; socket field names remain a separate projection. */
declare const AgentSpawnArgsSchema: z.ZodObject<{
    name: z.ZodString;
    profile: z.ZodString;
    brief: z.ZodString;
    surface: z.ZodOptional<z.ZodEnum<{
        headless: "headless";
        "iterm-pane": "iterm-pane";
        "iterm-tab": "iterm-tab";
        "iterm-window": "iterm-window";
        "tmux-window": "tmux-window";
    }>>;
    isolation: z.ZodOptional<z.ZodEnum<{
        none: "none";
        worktree: "worktree";
        "file-ownership": "file-ownership";
        "toolset-limited": "toolset-limited";
    }>>;
    cwd: z.ZodOptional<z.ZodString>;
    worktree: z.ZodOptional<z.ZodString>;
    owns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    inherit: z.ZodOptional<z.ZodEnum<{
        context: "context";
    }>>;
    remote_control: z.ZodOptional<z.ZodBoolean>;
    resume_session: z.ZodOptional<z.ZodString>;
    predecessor: z.ZodOptional<z.ZodString>;
    experiment: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        arm: z.ZodString;
    }, z.core.$strip>>;
    return_contract: z.ZodOptional<z.ZodEnum<{
        none: "none";
    }>>;
    config_dir: z.ZodOptional<z.ZodString>;
    briefing: z.ZodOptional<z.ZodString>;
    task: z.ZodOptional<z.ZodString>;
    role: z.ZodOptional<z.ZodString & z.ZodType<WorkRole, string, z.core.$ZodTypeInternals<WorkRole, string>>>;
    override: z.ZodOptional<z.ZodLiteral<"fix-round">>;
    host: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type AgentSpawnArgs = z.infer<typeof AgentSpawnArgsSchema>;

declare const SubscriptionSchema: z.ZodType<Subscription>;
/** Transport shape only; account, ownership and launch authority remain broker checks. */
declare const SpawnRequestSchema: z.ZodType<SpawnRequest>;
declare const ResumeRequestSchema: z.ZodType<ResumeRequest>;
declare const RetireRequestSchema: z.ZodType<RetireRequest>;
declare const AgentListRequestSchema: z.ZodType<AgentListRequest>;
declare const SurfaceRequestSchema: z.ZodType<SurfaceRequest>;

interface AgentProfile {
    name: string;
    description: string;
    model: string;
    /**
     * Passed to --allowed-tools, and THE permission lever. Declare the narrowest
     * set that actually completes the work: too wide leaks authority, too narrow
     * yields an agent that silently produces degraded output.
     */
    allowedTools: string[];
    disallowedTools?: string[];
    isolation: IsolationName;
    surface: SurfaceName;
    /**
     * Whether this kind of agent's pane goes with it when it ends. Inert for a
     * headless profile, which has no surface to close. See {@link SurfaceLifetime}.
     */
    surfaceLifetime?: SurfaceLifetime;
    /** Absent means `worker`: spawning and Remote Control are opted into, never granted by omission. */
    role?: AgentRole;
    /** CC-924: spawn and teleport with Remote Control unless the request says otherwise. Coordinator profiles only. */
    remoteControl?: boolean;
    /** Absent means the contract is inferred from the name and grants; `none` opts out. */
    returnContract?: ReturnContract | 'none';
    /** Passed as --effort when set; unset leaves the harness default. */
    effort?: EffortLevel;
    /** Appended via --append-system-prompt, after the standard peer preamble. */
    promptPrelude: string;
    /** Extra MCP servers merged into the generated --mcp-config. */
    mcpServers?: Record<string, unknown>;
    /** Load only the generated --mcp-config, dropping user-scope and plugin MCP servers. Absent means on for a headless worker. */
    strictMcpConfig?: boolean;
    /** Passed to --setting-sources. Absent means project and local for a worker, and no flag for a coordinator. */
    settingSources?: SettingSource[];
    /** Drop every skill and slash command, which otherwise load into each turn. */
    disableSlashCommands?: boolean;
    /** Extra environment for the launched process. Never overrides AGENT_CHAT_* or CLAUDE_CONFIG_DIR. */
    env?: Record<string, string>;
    /** Set by the loader, never read from a file: keys in the file that no field here answers to. */
    warnings?: string[];
}
type RemoteProfile = Omit<AgentProfile, 'env' | 'mcpServers' | 'warnings'>;
interface RemoteLaunch {
    agentId: string;
    sessionId: string;
    name: string;
    profile: RemoteProfile;
    brief: string;
    preamble: string;
    /** CC-281: the predecessor was a human's own session, so its successor has no spawner to report to. */
    adopted?: true;
    surface: SurfaceName;
    tags?: string[];
    subscriptions?: Subscription[];
    remoteControl?: boolean;
    /** CC-951: carried channel targets; the caller's host checks each one before it reaches an argv. */
    channels?: string[];
    /** CC-951: carried permission mode, checked against the same allowlist on the caller's host. */
    permissionMode?: string;
    anchor?: string;
    /** CC-913: this landing's secret; the only proof a later `teleport_land_failed` came from the caller that armed it. */
    landToken?: string;
    /** CC-951: launch now, not after the predecessor exits, and end it only on a later `endSelf` plan. */
    successorFirst?: true;
    /** CC-951: set only for a host launcher, which has no predecessor of its own to take these from. */
    cwd?: string;
    /** CC-951: the account the predecessor spent, which must exist on the launcher's machine. */
    configDir?: string;
    /** CC-1059: a spawn on the default account, so the launching host runs it with CLAUDE_CONFIG_DIR unset. */
    configDirUnset?: true;
}
interface SpawnResultFields {
    ok: boolean;
    agentId?: string;
    name?: string;
    reason?: string;
    /** CC-441: the surface refused to launch (iTerm2 down, not macOS), so a headless launch may still work. */
    code?: 'surface_refused' | 'spawn_rate_limit' | 'machine_headless_limit' | 'machine_memory_floor' | 'seat_budget_stop' | 'seat_spawn_overlap' | 'seat_hand_reserve' | 'seat_spawn_unprefixed' | 'reviewer_account_limit' | 'broker_draining';
    /** CC-445: the machine guard's refusals clear as load drops, so the same spawn may be retried later. */
    retryable?: boolean;
    /** CC-1179: set with `broker_draining`, the time until the drain lifts at its ttl. */
    retryAfterMs?: number;
    warnings?: string[];
    /**
     * The profile's own deny list, echoed back on success. CC-29's finding:
     * a toolset-confined agent cannot report being stuck — the tool is absent
     * from its schema, not refused — so the only place this is knowable with
     * certainty is here, at spawn time, before the agent can fail silently.
     */
    disallowedTools?: string[];
    /** CC-126: set on any resume, so the caller is told whether a conversation actually came back. */
    transcript?: {
        path: string;
        found: boolean;
    };
    /** CC-151: the ref and commit a new worktree branch was cut from, so a coordinator can check it. */
    base?: {
        ref: string;
        sha: string;
    };
    /** CC-1059: recorded, not launched: the requester launches this on `host`, then reports `spawn_launched`. */
    launch?: RemoteLaunch;
    /** CC-1059: the host the agent launches on, when that is not the broker's. */
    host?: string;
}
interface AgentIdentity {
    agentId: string;
    name: string;
    profile: string;
    state: AgentLifecycle;
    /** Whether the name and brief are broker-assigned or self-reported. */
    origin: AgentOrigin;
    spawnedBy: string;
    spawnedAt: number;
    brief: string;
    cwd: string;
    isolation: string;
    surface: string;
    /** The uuid passed to --session-id. The resume handle. */
    sessionId: string;
    /**
     * The Claude config dir this agent was launched on, resolved at spawn (CC-100).
     *
     * Recorded rather than recomputed because it is where the agent's transcript and
     * status-cache actually live: an agent spawned from a session on a dedicated
     * account writes neither under the broker's own dir, so a reader that assumes
     * `CLAUDE_CONFIG_DIR` from its own environment finds nothing and reports "not
     * written yet" forever. Empty for rows written before CC-100.
     */
    configDir?: string;
    /** CC-200: the agent runs with `CLAUDE_CONFIG_DIR` unset, so its global config is `~/.claude.json`. */
    configDirUnset?: boolean;
    /** CC-1059: the machine the spawn launched on; absent on rows written before it was recorded. */
    host?: string;
    /** CC-959: an adopted session's current name was derived from its directory (CC-82), not chosen. */
    provisionalName?: true;
    /** CC-915: `owner/name` of the worktree's GitHub origin; absent off GitHub and on older rows. */
    repo?: string;
    /** CC-915: the worktree's branch. */
    branch?: string;
    /** CC-915: the commit a new worktree branch was cut from; a resume onto a fresh branch replaces it. */
    base?: {
        sha: string;
        ref: string;
    };
    /** CC-915: the task id the spawner assigned. */
    task?: string;
    /** CC-915: implementer, reviewer, fix-round-N, shepherd-review, planner or other. Set on every folded identity. */
    workRole?: string;
    /** CC-915: the role was read from the profile and name, not stated by the spawner. */
    workRoleInferred?: true;
    /** Timestamp of the newest row referencing this identity, spawn included. */
    lastEventAt: number;
    /** Timestamp of the `agent_exited` row, cleared by a resume; the reclaim grace window's start. */
    exitedAt?: number;
    /** Timestamp of the newest `agent_detached` row, cleared by a resume or attach; stands in for `exitedAt` while no exit is recorded. */
    detachedAt?: number;
    /**
     * How many teleports deep this identity is: 1 for one that has never
     * teleported, incrementing per hop. Broker-derived, like `teleportFrom` —
     * written by the broker from its own resolution of the predecessor, never from
     * a client-supplied field, which is what makes it lineage rather than a claim.
     */
    generation: number;
    /** The immediate predecessor's agentId. The rest of the chain is a walk of these. */
    teleportFrom?: string;
    /**
     * `failedToStart` (CC-95) separates "this agent ran and finished" from "this
     * agent never came up". Carried on the exit rather than as a sixth lifecycle
     * because the durable fact IS an exit — the process is gone and the identity is
     * terminal — and only the roster needs to say WHICH kind, which it does without
     * every consumer of `AgentLifecycle` growing a case for it.
     */
    exit?: {
        code: number | null;
        summary: string;
        costUsd?: number;
        failedToStart?: boolean;
        /** CC-333: written by the settle timer or a presence check, not by a recorded process exit. */
        inferred?: boolean;
    };
}
interface AgentEventRow {
    kind: EventKind;
    ts: number;
    actor: string;
    target: string | null;
    msgId: string | null;
    ref: string | null;
    body: string | null;
    meta: Record<string, string>;
}
interface LoggedEventRow extends AgentEventRow {
    id: number;
}
type AgentListResult = {
    t: 'agents_result';
    agents: AgentIdentity[];
    slots?: {
        held: number;
        cap: number;
    };
};
type SurfaceResult = {
    t: 'switch_result';
    ok: boolean;
    reason?: string;
    name?: string;
    agentId?: string;
    surface?: SurfaceName;
    warnings?: string[];
};
type SpawnResult = {
    t: "spawn_result";
} & SpawnResultFields;

/** Legacy transport/storage DTO shapes; parsing never grants launch or permission authority. */
declare const AgentProfileSchema: z.ZodType<AgentProfile>;
declare const RemoteProfileSchema: z.ZodType<RemoteProfile>;
declare const RemoteLaunchSchema: z.ZodType<RemoteLaunch>;
declare const SpawnResultFieldsSchema: z.ZodType<SpawnResultFields>;
declare const AgentIdentitySchema: z.ZodType<AgentIdentity>;
declare const AgentEventRowSchema: z.ZodType<AgentEventRow>;
declare const LoggedEventRowSchema: z.ZodType<LoggedEventRow>;
declare const AgentListResultSchema: z.ZodType<AgentListResult>;
declare const SurfaceResultSchema: z.ZodType<SurfaceResult>;
declare const SpawnResultSchema: z.ZodType<SpawnResult>;

/** Exact legacy MCP argument projection; not a socket request. */
declare const AgentResumeArgsSchema: z.ZodObject<{
    name: z.ZodString;
    message: z.ZodOptional<z.ZodString>;
    surface: z.ZodOptional<z.ZodEnum<{
        headless: "headless";
        "iterm-pane": "iterm-pane";
        "iterm-tab": "iterm-tab";
        "iterm-window": "iterm-window";
        "tmux-window": "tmux-window";
    }>>;
}, z.core.$strip>;
type AgentResumeArgs = z.infer<typeof AgentResumeArgsSchema>;
/** Exact legacy MCP argument projection; not a socket request. */
declare const AgentListArgsSchema: z.ZodObject<{
    include_retired: z.ZodOptional<z.ZodBoolean>;
    mine: z.ZodOptional<z.ZodBoolean>;
    prefix: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type AgentListArgs = z.infer<typeof AgentListArgsSchema>;
/** Exact legacy MCP argument projection; not a socket request. */
declare const AgentSurfaceArgsSchema: z.ZodObject<{
    name: z.ZodString;
}, z.core.$strip>;
type AgentSurfaceArgs = z.infer<typeof AgentSurfaceArgsSchema>;
/** Exact legacy MCP argument projection; not a socket request. */
declare const AgentProfilesArgsSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type AgentProfilesArgs = z.infer<typeof AgentProfilesArgsSchema>;
/** These legacy MCP commands return formatted text, not new JSON socket frames. */
declare const AgentToolTextResultSchema: z.ZodString;

export { AGENT_LIFECYCLES, AGENT_ORIGINS, AGENT_ROLES, type AgentEventRow, AgentEventRowSchema, type AgentIdentity, AgentIdentitySchema, type AgentLifecycle, AgentLifecycleSchema, type AgentListArgs, AgentListArgsSchema, type AgentListRequest, AgentListRequestSchema, type AgentListResult, AgentListResultSchema, type AgentOrigin, AgentOriginSchema, type AgentProfile, AgentProfileSchema, type AgentProfilesArgs, AgentProfilesArgsSchema, type AgentResumeArgs, AgentResumeArgsSchema, type AgentRole, AgentRoleSchema, type AgentSpawnArgs, AgentSpawnArgsSchema, type AgentSurfaceArgs, AgentSurfaceArgsSchema, AgentToolTextResultSchema, EFFORT_LEVELS, EVENT_KINDS, type EffortLevel, EffortLevelSchema, type EventKind, EventKindSchema, type ExperimentArm, ISOLATION_NAMES, type IsolationName, IsolationNameSchema, type LoggedEventRow, LoggedEventRowSchema, RETURN_CONTRACTS, type RemoteLaunch, RemoteLaunchSchema, type RemoteProfile, RemoteProfileSchema, type ResumeRequest, ResumeRequestSchema, type RetireRequest, RetireRequestSchema, type ReturnContract, ReturnContractSchema, SETTING_SOURCES, SUBSCRIBABLE_KINDS, SURFACE_LIFETIMES, SURFACE_NAMES, type SettingSource, SettingSourceSchema, type SpawnRequest, SpawnRequestSchema, type SpawnResult, type SpawnResultFields, SpawnResultFieldsSchema, SpawnResultSchema, type SubscribableKind, SubscribableKindSchema, type Subscription, SubscriptionSchema, type SubscriptionSelector, type SurfaceLifetime, SurfaceLifetimeSchema, type SurfaceName, SurfaceNameSchema, type SurfaceRequest, SurfaceRequestSchema, type SurfaceResult, SurfaceResultSchema, WAKE_SOURCES, type WakeSource, WakeSourceSchema };
