import { z } from 'zod';

/**
 * agent-surface owns this list, but it sits a tier above this package, so the wire keeps a copy and
 * agent-surface's own test pins the two equal.
 */
declare const SURFACE_NAMES: readonly ["headless", "iterm-pane", "iterm-tab", "iterm-window", "tmux-window"];
declare const ISOLATION_NAMES: readonly ["none", "worktree", "file-ownership", "toolset-limited"];
declare const SUBSCRIBABLE_KINDS: readonly ["registered", "deregistered", "agent_spawned", "agent_attached", "agent_detached", "agent_resumed", "agent_exited", "agent_retired", "agent_spawn_refused"];
/** Marks a send or resume an automation made, so its event row is not read as the human typing. */
declare const WAKE_SOURCES: readonly ["watchdog", "shepherd", "console"];
/** The automation behind a CLI spawn or resume; display only. */
declare const LAUNCHERS: readonly ["seat-watchdog", "shepherd"];
declare const AGENT_LIFECYCLES: readonly ["spawning", "live", "detached", "exited", "retired"];
/** `adopted` names a human-started session whose name and brief are self-reported, not broker-assigned. */
declare const AGENT_ORIGINS: readonly ["spawned", "adopted"];
declare const SPAWN_REFUSAL_CODES: readonly ["surface_refused", "spawn_rate_limit", "machine_headless_limit", "machine_memory_floor", "seat_budget_stop", "seat_spawn_overlap", "seat_hand_reserve", "seat_spawn_unprefixed", "reviewer_account_limit", "broker_draining", "harness_unsupported", "account_exhausted"];
declare const SURFACE_LIFETIMES: readonly ["close-on-exit", "keep"];
declare const EFFORT_LEVELS: readonly ["low", "medium", "high", "xhigh", "max"];
declare const CACHE_TTLS: readonly ["5m", "1h"];
declare const PUSH_POLICIES: readonly ["no-rewrite", "scan-only"];
declare const AGENT_ROLES: readonly ["coordinator", "worker"];
declare const HARNESSES: readonly ["claude-code", "codex"];
declare const SETTING_SOURCES: readonly ["user", "project", "local"];
declare const RETURN_CONTRACTS: readonly ["implementer", "reviewer"];
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
    console: "console";
}>;
declare const LauncherSchema: z.ZodEnum<{
    shepherd: "shepherd";
    "seat-watchdog": "seat-watchdog";
}>;
declare const AgentLifecycleSchema: z.ZodEnum<{
    spawning: "spawning";
    live: "live";
    detached: "detached";
    exited: "exited";
    retired: "retired";
}>;
declare const AgentOriginSchema: z.ZodEnum<{
    spawned: "spawned";
    adopted: "adopted";
}>;
declare const SpawnRefusalCodeSchema: z.ZodEnum<{
    surface_refused: "surface_refused";
    spawn_rate_limit: "spawn_rate_limit";
    machine_headless_limit: "machine_headless_limit";
    machine_memory_floor: "machine_memory_floor";
    seat_budget_stop: "seat_budget_stop";
    seat_spawn_overlap: "seat_spawn_overlap";
    seat_hand_reserve: "seat_hand_reserve";
    seat_spawn_unprefixed: "seat_spawn_unprefixed";
    reviewer_account_limit: "reviewer_account_limit";
    broker_draining: "broker_draining";
    harness_unsupported: "harness_unsupported";
    account_exhausted: "account_exhausted";
}>;
declare const SurfaceLifetimeSchema: z.ZodEnum<{
    "close-on-exit": "close-on-exit";
    keep: "keep";
}>;
declare const EffortLevelSchema: z.ZodEnum<{
    low: "low";
    medium: "medium";
    high: "high";
    xhigh: "xhigh";
    max: "max";
}>;
declare const CacheTtlSchema: z.ZodEnum<{
    "5m": "5m";
    "1h": "1h";
}>;
declare const PushPolicySchema: z.ZodEnum<{
    "no-rewrite": "no-rewrite";
    "scan-only": "scan-only";
}>;
declare const AgentRoleSchema: z.ZodEnum<{
    coordinator: "coordinator";
    worker: "worker";
}>;
declare const HarnessSchema: z.ZodEnum<{
    "claude-code": "claude-code";
    codex: "codex";
}>;
declare const SettingSourceSchema: z.ZodEnum<{
    user: "user";
    project: "project";
    local: "local";
}>;
declare const ReturnContractSchema: z.ZodEnum<{
    implementer: "implementer";
    reviewer: "reviewer";
}>;
type SurfaceName = (typeof SURFACE_NAMES)[number];
type IsolationName = (typeof ISOLATION_NAMES)[number];
type SubscribableKind = (typeof SUBSCRIBABLE_KINDS)[number];
type WakeSource = (typeof WAKE_SOURCES)[number];
type Launcher = (typeof LAUNCHERS)[number];
type AgentLifecycle = (typeof AGENT_LIFECYCLES)[number];
type AgentOrigin = (typeof AGENT_ORIGINS)[number];
type SpawnRefusalCode = (typeof SPAWN_REFUSAL_CODES)[number];
type SurfaceLifetime = (typeof SURFACE_LIFETIMES)[number];
type EffortLevel = (typeof EFFORT_LEVELS)[number];
type CacheTtl = (typeof CACHE_TTLS)[number];
type PushPolicy = (typeof PUSH_POLICIES)[number];
type AgentRole = (typeof AGENT_ROLES)[number];
type Harness = (typeof HARNESSES)[number];
type SettingSource = (typeof SETTING_SOURCES)[number];
type ReturnContract = (typeof RETURN_CONTRACTS)[number];
/**
 * `exact` refuses a key the contract does not name, at every depth; a drift test parses captured
 * frames with it. `loose` keeps such keys, so a reader one release behind forwards a newer peer's frame intact.
 */
type WireParseMode = "exact" | "loose";
type NamedKeys<T> = {
    [K in keyof T as string extends K ? never : K]: T[K];
};
/**
 * A loose parse's output without the catch-all index signature, at every depth. A plain record
 * such as a profile's `env` names no keys, so it keeps its signature.
 */
type Known<T> = T extends readonly (infer U)[] ? Known<U>[] : T extends object ? [keyof NamedKeys<T>] extends [never] ? {
    [K in keyof T]: Known<T[K]>;
} : {
    [K in keyof NamedKeys<T>]: Known<NamedKeys<T>[K]>;
} : T;

declare function buildRequestSchemas(mode: WireParseMode): {
    resume: z.ZodObject<{
        t: z.ZodLiteral<"resume">;
        name: z.ZodString;
        surface: z.ZodOptional<z.ZodEnum<{
            headless: "headless";
            "iterm-pane": "iterm-pane";
            "iterm-tab": "iterm-tab";
            "iterm-window": "iterm-window";
            "tmux-window": "tmux-window";
        }>>;
        message: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodEnum<{
            watchdog: "watchdog";
            shepherd: "shepherd";
            console: "console";
        }>>;
        remoteControl: z.ZodOptional<z.ZodBoolean>;
        nonce: z.ZodOptional<z.ZodString>;
        host: z.ZodOptional<z.ZodString>;
        callerAgent: z.ZodOptional<z.ZodString>;
        launchedBy: z.ZodOptional<z.ZodEnum<{
            shepherd: "shepherd";
            "seat-watchdog": "seat-watchdog";
        }>>;
        launchReason: z.ZodOptional<z.ZodString>;
        rid: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    retire: z.ZodObject<{
        t: z.ZodLiteral<"retire">;
        name: z.ZodString;
        force: z.ZodOptional<z.ZodBoolean>;
        caller: z.ZodOptional<z.ZodString>;
        agentId: z.ZodOptional<z.ZodString>;
        rid: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    agents: z.ZodObject<{
        t: z.ZodLiteral<"agents">;
        includeRetired: z.ZodOptional<z.ZodBoolean>;
        view: z.ZodOptional<z.ZodObject<{
            spawner: z.ZodOptional<z.ZodString>;
            prefix: z.ZodOptional<z.ZodString>;
            includeFinished: z.ZodOptional<z.ZodBoolean>;
            includeRetired: z.ZodOptional<z.ZodBoolean>;
            limit: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        rid: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    surface: z.ZodObject<{
        t: z.ZodLiteral<"surface">;
        name: z.ZodString;
        rid: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    subscription: z.ZodObject<{
        selector: z.ZodUnion<readonly [z.ZodObject<{
            all: z.ZodLiteral<true>;
        }, z.core.$strict>, z.ZodObject<{
            name: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            tag: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            spawnedBy: z.ZodLiteral<"self">;
        }, z.core.$strict>]>;
        kinds: z.ZodArray<z.ZodEnum<{
            registered: "registered";
            deregistered: "deregistered";
            agent_spawned: "agent_spawned";
            agent_attached: "agent_attached";
            agent_detached: "agent_detached";
            agent_resumed: "agent_resumed";
            agent_exited: "agent_exited";
            agent_retired: "agent_retired";
            agent_spawn_refused: "agent_spawn_refused";
        }>>;
    }, z.core.$strict>;
    experiment: z.ZodObject<{
        id: z.ZodString;
        arm: z.ZodString;
    }, z.core.$strict>;
    rosterView: z.ZodObject<{
        spawner: z.ZodOptional<z.ZodString>;
        prefix: z.ZodOptional<z.ZodString>;
        includeFinished: z.ZodOptional<z.ZodBoolean>;
        includeRetired: z.ZodOptional<z.ZodBoolean>;
        limit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    spawn: z.ZodObject<{
        t: z.ZodLiteral<"spawn">;
        name: z.ZodString;
        profile: z.ZodString;
        brief: z.ZodString;
        briefing: z.ZodOptional<z.ZodString>;
        tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
        subscriptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
            selector: z.ZodUnion<readonly [z.ZodObject<{
                all: z.ZodLiteral<true>;
            }, z.core.$strict>, z.ZodObject<{
                name: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                tag: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                spawnedBy: z.ZodLiteral<"self">;
            }, z.core.$strict>]>;
            kinds: z.ZodArray<z.ZodEnum<{
                registered: "registered";
                deregistered: "deregistered";
                agent_spawned: "agent_spawned";
                agent_attached: "agent_attached";
                agent_detached: "agent_detached";
                agent_resumed: "agent_resumed";
                agent_exited: "agent_exited";
                agent_retired: "agent_retired";
                agent_spawn_refused: "agent_spawn_refused";
            }>>;
        }, z.core.$strict>>>;
        predecessor: z.ZodOptional<z.ZodString>;
        experiment: z.ZodOptional<z.ZodObject<{
            id: z.ZodString;
            arm: z.ZodString;
        }, z.core.$strict>>;
        returnContract: z.ZodOptional<z.ZodLiteral<"none">>;
        tier: z.ZodOptional<z.ZodNumber>;
        spawnedAs: z.ZodOptional<z.ZodEnum<{
            shepherd: "shepherd";
            burndown: "burndown";
        }>>;
        task: z.ZodOptional<z.ZodString>;
        slice: z.ZodOptional<z.ZodString>;
        routeOverride: z.ZodOptional<z.ZodString>;
        workRole: z.ZodOptional<z.ZodString>;
        override: z.ZodOptional<z.ZodLiteral<"fix-round">>;
        lineageFrom: z.ZodOptional<z.ZodString>;
        configDir: z.ZodOptional<z.ZodString>;
        account: z.ZodOptional<z.ZodString>;
        spawnerConfigDir: z.ZodOptional<z.ZodString>;
        resumeSession: z.ZodOptional<z.ZodString>;
        cwd: z.ZodOptional<z.ZodString>;
        isolation: z.ZodOptional<z.ZodEnum<{
            none: "none";
            worktree: "worktree";
            "file-ownership": "file-ownership";
            "toolset-limited": "toolset-limited";
        }>>;
        surface: z.ZodOptional<z.ZodEnum<{
            headless: "headless";
            "iterm-pane": "iterm-pane";
            "iterm-tab": "iterm-tab";
            "iterm-window": "iterm-window";
            "tmux-window": "tmux-window";
        }>>;
        worktree: z.ZodOptional<z.ZodString>;
        owns: z.ZodOptional<z.ZodArray<z.ZodString>>;
        claimPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
        baseRef: z.ZodOptional<z.ZodString>;
        inherit: z.ZodOptional<z.ZodLiteral<"context">>;
        forkFrom: z.ZodOptional<z.ZodString>;
        remoteControl: z.ZodOptional<z.ZodBoolean>;
        hostPlatform: z.ZodOptional<z.ZodString>;
        launchesHere: z.ZodOptional<z.ZodLiteral<true>>;
        host: z.ZodOptional<z.ZodString>;
        callerHost: z.ZodOptional<z.ZodString>;
        callerHome: z.ZodOptional<z.ZodString>;
        callerAgent: z.ZodOptional<z.ZodString>;
        launchedBy: z.ZodOptional<z.ZodEnum<{
            shepherd: "shepherd";
            "seat-watchdog": "seat-watchdog";
        }>>;
        launchReason: z.ZodOptional<z.ZodString>;
        rid: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
};
/** Transport shape only: account, ownership and launch authority stay broker checks. */
declare const SpawnRequestSchema: z.ZodObject<{
    t: z.ZodLiteral<"spawn">;
    name: z.ZodString;
    profile: z.ZodString;
    brief: z.ZodString;
    briefing: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    subscriptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        selector: z.ZodUnion<readonly [z.ZodObject<{
            all: z.ZodLiteral<true>;
        }, z.core.$strict>, z.ZodObject<{
            name: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            tag: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            spawnedBy: z.ZodLiteral<"self">;
        }, z.core.$strict>]>;
        kinds: z.ZodArray<z.ZodEnum<{
            registered: "registered";
            deregistered: "deregistered";
            agent_spawned: "agent_spawned";
            agent_attached: "agent_attached";
            agent_detached: "agent_detached";
            agent_resumed: "agent_resumed";
            agent_exited: "agent_exited";
            agent_retired: "agent_retired";
            agent_spawn_refused: "agent_spawn_refused";
        }>>;
    }, z.core.$strict>>>;
    predecessor: z.ZodOptional<z.ZodString>;
    experiment: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        arm: z.ZodString;
    }, z.core.$strict>>;
    returnContract: z.ZodOptional<z.ZodLiteral<"none">>;
    tier: z.ZodOptional<z.ZodNumber>;
    spawnedAs: z.ZodOptional<z.ZodEnum<{
        shepherd: "shepherd";
        burndown: "burndown";
    }>>;
    task: z.ZodOptional<z.ZodString>;
    slice: z.ZodOptional<z.ZodString>;
    routeOverride: z.ZodOptional<z.ZodString>;
    workRole: z.ZodOptional<z.ZodString>;
    override: z.ZodOptional<z.ZodLiteral<"fix-round">>;
    lineageFrom: z.ZodOptional<z.ZodString>;
    configDir: z.ZodOptional<z.ZodString>;
    account: z.ZodOptional<z.ZodString>;
    spawnerConfigDir: z.ZodOptional<z.ZodString>;
    resumeSession: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    isolation: z.ZodOptional<z.ZodEnum<{
        none: "none";
        worktree: "worktree";
        "file-ownership": "file-ownership";
        "toolset-limited": "toolset-limited";
    }>>;
    surface: z.ZodOptional<z.ZodEnum<{
        headless: "headless";
        "iterm-pane": "iterm-pane";
        "iterm-tab": "iterm-tab";
        "iterm-window": "iterm-window";
        "tmux-window": "tmux-window";
    }>>;
    worktree: z.ZodOptional<z.ZodString>;
    owns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    claimPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
    baseRef: z.ZodOptional<z.ZodString>;
    inherit: z.ZodOptional<z.ZodLiteral<"context">>;
    forkFrom: z.ZodOptional<z.ZodString>;
    remoteControl: z.ZodOptional<z.ZodBoolean>;
    hostPlatform: z.ZodOptional<z.ZodString>;
    launchesHere: z.ZodOptional<z.ZodLiteral<true>>;
    host: z.ZodOptional<z.ZodString>;
    callerHost: z.ZodOptional<z.ZodString>;
    callerHome: z.ZodOptional<z.ZodString>;
    callerAgent: z.ZodOptional<z.ZodString>;
    launchedBy: z.ZodOptional<z.ZodEnum<{
        shepherd: "shepherd";
        "seat-watchdog": "seat-watchdog";
    }>>;
    launchReason: z.ZodOptional<z.ZodString>;
    rid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
declare const ResumeRequestSchema: z.ZodObject<{
    t: z.ZodLiteral<"resume">;
    name: z.ZodString;
    surface: z.ZodOptional<z.ZodEnum<{
        headless: "headless";
        "iterm-pane": "iterm-pane";
        "iterm-tab": "iterm-tab";
        "iterm-window": "iterm-window";
        "tmux-window": "tmux-window";
    }>>;
    message: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodEnum<{
        watchdog: "watchdog";
        shepherd: "shepherd";
        console: "console";
    }>>;
    remoteControl: z.ZodOptional<z.ZodBoolean>;
    nonce: z.ZodOptional<z.ZodString>;
    host: z.ZodOptional<z.ZodString>;
    callerAgent: z.ZodOptional<z.ZodString>;
    launchedBy: z.ZodOptional<z.ZodEnum<{
        shepherd: "shepherd";
        "seat-watchdog": "seat-watchdog";
    }>>;
    launchReason: z.ZodOptional<z.ZodString>;
    rid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
declare const RetireRequestSchema: z.ZodObject<{
    t: z.ZodLiteral<"retire">;
    name: z.ZodString;
    force: z.ZodOptional<z.ZodBoolean>;
    caller: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodString>;
    rid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
declare const AgentListRequestSchema: z.ZodObject<{
    t: z.ZodLiteral<"agents">;
    includeRetired: z.ZodOptional<z.ZodBoolean>;
    view: z.ZodOptional<z.ZodObject<{
        spawner: z.ZodOptional<z.ZodString>;
        prefix: z.ZodOptional<z.ZodString>;
        includeFinished: z.ZodOptional<z.ZodBoolean>;
        includeRetired: z.ZodOptional<z.ZodBoolean>;
        limit: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    rid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
declare const SurfaceRequestSchema: z.ZodObject<{
    t: z.ZodLiteral<"surface">;
    name: z.ZodString;
    rid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
declare const SubscriptionSchema: z.ZodObject<{
    selector: z.ZodUnion<readonly [z.ZodObject<{
        all: z.ZodLiteral<true>;
    }, z.core.$strict>, z.ZodObject<{
        name: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        tag: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        spawnedBy: z.ZodLiteral<"self">;
    }, z.core.$strict>]>;
    kinds: z.ZodArray<z.ZodEnum<{
        registered: "registered";
        deregistered: "deregistered";
        agent_spawned: "agent_spawned";
        agent_attached: "agent_attached";
        agent_detached: "agent_detached";
        agent_resumed: "agent_resumed";
        agent_exited: "agent_exited";
        agent_retired: "agent_retired";
        agent_spawn_refused: "agent_spawn_refused";
    }>>;
}, z.core.$strict>;
declare const ExperimentArmSchema: z.ZodObject<{
    id: z.ZodString;
    arm: z.ZodString;
}, z.core.$strict>;
declare const RosterViewSchema: z.ZodObject<{
    spawner: z.ZodOptional<z.ZodString>;
    prefix: z.ZodOptional<z.ZodString>;
    includeFinished: z.ZodOptional<z.ZodBoolean>;
    includeRetired: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
type SpawnRequest = Known<z.output<typeof SpawnRequestSchema>>;
type ResumeRequest = Known<z.output<typeof ResumeRequestSchema>>;
type RetireRequest = Known<z.output<typeof RetireRequestSchema>>;
type AgentListRequest = Known<z.output<typeof AgentListRequestSchema>>;
type SurfaceRequest = Known<z.output<typeof SurfaceRequestSchema>>;
type Subscription = Known<z.output<typeof SubscriptionSchema>>;
type SubscriptionSelector = Subscription["selector"];
type ExperimentArm = Known<z.output<typeof ExperimentArmSchema>>;
type RosterView = Known<z.output<typeof RosterViewSchema>>;

declare function buildResultSchemas(mode: WireParseMode): {
    profile: z.ZodObject<{
        mcpServers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        warnings: z.ZodOptional<z.ZodArray<z.ZodString>>;
        name: z.ZodString;
        description: z.ZodString;
        harness: z.ZodOptional<z.ZodEnum<{
            "claude-code": "claude-code";
            codex: "codex";
        }>>;
        model: z.ZodString;
        allowedTools: z.ZodArray<z.ZodString>;
        disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        isolation: z.ZodEnum<{
            none: "none";
            worktree: "worktree";
            "file-ownership": "file-ownership";
            "toolset-limited": "toolset-limited";
        }>;
        surface: z.ZodEnum<{
            headless: "headless";
            "iterm-pane": "iterm-pane";
            "iterm-tab": "iterm-tab";
            "iterm-window": "iterm-window";
            "tmux-window": "tmux-window";
        }>;
        surfaceLifetime: z.ZodOptional<z.ZodEnum<{
            "close-on-exit": "close-on-exit";
            keep: "keep";
        }>>;
        role: z.ZodOptional<z.ZodEnum<{
            coordinator: "coordinator";
            worker: "worker";
        }>>;
        remoteControl: z.ZodOptional<z.ZodBoolean>;
        returnContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            implementer: "implementer";
            reviewer: "reviewer";
        }>, z.ZodLiteral<"none">]>>;
        effort: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        cacheTtl: z.ZodOptional<z.ZodEnum<{
            "5m": "5m";
            "1h": "1h";
        }>>;
        pushPolicy: z.ZodOptional<z.ZodEnum<{
            "no-rewrite": "no-rewrite";
            "scan-only": "scan-only";
        }>>;
        promptPrelude: z.ZodString;
        strictMcpConfig: z.ZodOptional<z.ZodBoolean>;
        settingSources: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            project: "project";
            local: "local";
        }>>>;
        disableSlashCommands: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    remoteProfile: z.ZodObject<{
        mcpServers: z.ZodOptional<z.ZodNever>;
        env: z.ZodOptional<z.ZodNever>;
        warnings: z.ZodOptional<z.ZodNever>;
        name: z.ZodString;
        description: z.ZodString;
        harness: z.ZodOptional<z.ZodEnum<{
            "claude-code": "claude-code";
            codex: "codex";
        }>>;
        model: z.ZodString;
        allowedTools: z.ZodArray<z.ZodString>;
        disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        isolation: z.ZodEnum<{
            none: "none";
            worktree: "worktree";
            "file-ownership": "file-ownership";
            "toolset-limited": "toolset-limited";
        }>;
        surface: z.ZodEnum<{
            headless: "headless";
            "iterm-pane": "iterm-pane";
            "iterm-tab": "iterm-tab";
            "iterm-window": "iterm-window";
            "tmux-window": "tmux-window";
        }>;
        surfaceLifetime: z.ZodOptional<z.ZodEnum<{
            "close-on-exit": "close-on-exit";
            keep: "keep";
        }>>;
        role: z.ZodOptional<z.ZodEnum<{
            coordinator: "coordinator";
            worker: "worker";
        }>>;
        remoteControl: z.ZodOptional<z.ZodBoolean>;
        returnContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            implementer: "implementer";
            reviewer: "reviewer";
        }>, z.ZodLiteral<"none">]>>;
        effort: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        cacheTtl: z.ZodOptional<z.ZodEnum<{
            "5m": "5m";
            "1h": "1h";
        }>>;
        pushPolicy: z.ZodOptional<z.ZodEnum<{
            "no-rewrite": "no-rewrite";
            "scan-only": "scan-only";
        }>>;
        promptPrelude: z.ZodString;
        strictMcpConfig: z.ZodOptional<z.ZodBoolean>;
        settingSources: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            project: "project";
            local: "local";
        }>>>;
        disableSlashCommands: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    remoteLaunch: z.ZodObject<{
        agentId: z.ZodString;
        sessionId: z.ZodString;
        name: z.ZodString;
        profile: z.ZodObject<{
            mcpServers: z.ZodOptional<z.ZodNever>;
            env: z.ZodOptional<z.ZodNever>;
            warnings: z.ZodOptional<z.ZodNever>;
            name: z.ZodString;
            description: z.ZodString;
            harness: z.ZodOptional<z.ZodEnum<{
                "claude-code": "claude-code";
                codex: "codex";
            }>>;
            model: z.ZodString;
            allowedTools: z.ZodArray<z.ZodString>;
            disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            isolation: z.ZodEnum<{
                none: "none";
                worktree: "worktree";
                "file-ownership": "file-ownership";
                "toolset-limited": "toolset-limited";
            }>;
            surface: z.ZodEnum<{
                headless: "headless";
                "iterm-pane": "iterm-pane";
                "iterm-tab": "iterm-tab";
                "iterm-window": "iterm-window";
                "tmux-window": "tmux-window";
            }>;
            surfaceLifetime: z.ZodOptional<z.ZodEnum<{
                "close-on-exit": "close-on-exit";
                keep: "keep";
            }>>;
            role: z.ZodOptional<z.ZodEnum<{
                coordinator: "coordinator";
                worker: "worker";
            }>>;
            remoteControl: z.ZodOptional<z.ZodBoolean>;
            returnContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                implementer: "implementer";
                reviewer: "reviewer";
            }>, z.ZodLiteral<"none">]>>;
            effort: z.ZodOptional<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            cacheTtl: z.ZodOptional<z.ZodEnum<{
                "5m": "5m";
                "1h": "1h";
            }>>;
            pushPolicy: z.ZodOptional<z.ZodEnum<{
                "no-rewrite": "no-rewrite";
                "scan-only": "scan-only";
            }>>;
            promptPrelude: z.ZodString;
            strictMcpConfig: z.ZodOptional<z.ZodBoolean>;
            settingSources: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                user: "user";
                project: "project";
                local: "local";
            }>>>;
            disableSlashCommands: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        brief: z.ZodString;
        preamble: z.ZodString;
        adopted: z.ZodOptional<z.ZodLiteral<true>>;
        surface: z.ZodEnum<{
            headless: "headless";
            "iterm-pane": "iterm-pane";
            "iterm-tab": "iterm-tab";
            "iterm-window": "iterm-window";
            "tmux-window": "tmux-window";
        }>;
        tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
        subscriptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
            selector: z.ZodUnion<readonly [z.ZodObject<{
                all: z.ZodLiteral<true>;
            }, z.core.$strict>, z.ZodObject<{
                name: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                tag: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                spawnedBy: z.ZodLiteral<"self">;
            }, z.core.$strict>]>;
            kinds: z.ZodArray<z.ZodEnum<{
                registered: "registered";
                deregistered: "deregistered";
                agent_spawned: "agent_spawned";
                agent_attached: "agent_attached";
                agent_detached: "agent_detached";
                agent_resumed: "agent_resumed";
                agent_exited: "agent_exited";
                agent_retired: "agent_retired";
                agent_spawn_refused: "agent_spawn_refused";
            }>>;
        }, z.core.$strict>>>;
        remoteControl: z.ZodOptional<z.ZodBoolean>;
        channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
        permissionMode: z.ZodOptional<z.ZodString>;
        anchor: z.ZodOptional<z.ZodString>;
        landToken: z.ZodOptional<z.ZodString>;
        successorFirst: z.ZodOptional<z.ZodLiteral<true>>;
        cwd: z.ZodOptional<z.ZodString>;
        configDir: z.ZodOptional<z.ZodString>;
        configDirUnset: z.ZodOptional<z.ZodLiteral<true>>;
        resume: z.ZodOptional<z.ZodLiteral<true>>;
    }, z.core.$strict>;
    spawnResultFields: z.ZodObject<{
        ok: z.ZodBoolean;
        agentId: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        code: z.ZodOptional<z.ZodEnum<{
            surface_refused: "surface_refused";
            spawn_rate_limit: "spawn_rate_limit";
            machine_headless_limit: "machine_headless_limit";
            machine_memory_floor: "machine_memory_floor";
            seat_budget_stop: "seat_budget_stop";
            seat_spawn_overlap: "seat_spawn_overlap";
            seat_hand_reserve: "seat_hand_reserve";
            seat_spawn_unprefixed: "seat_spawn_unprefixed";
            reviewer_account_limit: "reviewer_account_limit";
            broker_draining: "broker_draining";
            harness_unsupported: "harness_unsupported";
            account_exhausted: "account_exhausted";
        }>>;
        retryable: z.ZodOptional<z.ZodBoolean>;
        retryAfterMs: z.ZodOptional<z.ZodNumber>;
        warnings: z.ZodOptional<z.ZodArray<z.ZodString>>;
        disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        transcript: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            found: z.ZodBoolean;
        }, z.core.$strict>>;
        account: z.ZodOptional<z.ZodString>;
        base: z.ZodOptional<z.ZodObject<{
            ref: z.ZodString;
            sha: z.ZodString;
        }, z.core.$strict>>;
        deduped: z.ZodOptional<z.ZodBoolean>;
        launch: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            sessionId: z.ZodString;
            name: z.ZodString;
            profile: z.ZodObject<{
                mcpServers: z.ZodOptional<z.ZodNever>;
                env: z.ZodOptional<z.ZodNever>;
                warnings: z.ZodOptional<z.ZodNever>;
                name: z.ZodString;
                description: z.ZodString;
                harness: z.ZodOptional<z.ZodEnum<{
                    "claude-code": "claude-code";
                    codex: "codex";
                }>>;
                model: z.ZodString;
                allowedTools: z.ZodArray<z.ZodString>;
                disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                isolation: z.ZodEnum<{
                    none: "none";
                    worktree: "worktree";
                    "file-ownership": "file-ownership";
                    "toolset-limited": "toolset-limited";
                }>;
                surface: z.ZodEnum<{
                    headless: "headless";
                    "iterm-pane": "iterm-pane";
                    "iterm-tab": "iterm-tab";
                    "iterm-window": "iterm-window";
                    "tmux-window": "tmux-window";
                }>;
                surfaceLifetime: z.ZodOptional<z.ZodEnum<{
                    "close-on-exit": "close-on-exit";
                    keep: "keep";
                }>>;
                role: z.ZodOptional<z.ZodEnum<{
                    coordinator: "coordinator";
                    worker: "worker";
                }>>;
                remoteControl: z.ZodOptional<z.ZodBoolean>;
                returnContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                    implementer: "implementer";
                    reviewer: "reviewer";
                }>, z.ZodLiteral<"none">]>>;
                effort: z.ZodOptional<z.ZodEnum<{
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                cacheTtl: z.ZodOptional<z.ZodEnum<{
                    "5m": "5m";
                    "1h": "1h";
                }>>;
                pushPolicy: z.ZodOptional<z.ZodEnum<{
                    "no-rewrite": "no-rewrite";
                    "scan-only": "scan-only";
                }>>;
                promptPrelude: z.ZodString;
                strictMcpConfig: z.ZodOptional<z.ZodBoolean>;
                settingSources: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                    user: "user";
                    project: "project";
                    local: "local";
                }>>>;
                disableSlashCommands: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            brief: z.ZodString;
            preamble: z.ZodString;
            adopted: z.ZodOptional<z.ZodLiteral<true>>;
            surface: z.ZodEnum<{
                headless: "headless";
                "iterm-pane": "iterm-pane";
                "iterm-tab": "iterm-tab";
                "iterm-window": "iterm-window";
                "tmux-window": "tmux-window";
            }>;
            tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
            subscriptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
                selector: z.ZodUnion<readonly [z.ZodObject<{
                    all: z.ZodLiteral<true>;
                }, z.core.$strict>, z.ZodObject<{
                    name: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    tag: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    spawnedBy: z.ZodLiteral<"self">;
                }, z.core.$strict>]>;
                kinds: z.ZodArray<z.ZodEnum<{
                    registered: "registered";
                    deregistered: "deregistered";
                    agent_spawned: "agent_spawned";
                    agent_attached: "agent_attached";
                    agent_detached: "agent_detached";
                    agent_resumed: "agent_resumed";
                    agent_exited: "agent_exited";
                    agent_retired: "agent_retired";
                    agent_spawn_refused: "agent_spawn_refused";
                }>>;
            }, z.core.$strict>>>;
            remoteControl: z.ZodOptional<z.ZodBoolean>;
            channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
            permissionMode: z.ZodOptional<z.ZodString>;
            anchor: z.ZodOptional<z.ZodString>;
            landToken: z.ZodOptional<z.ZodString>;
            successorFirst: z.ZodOptional<z.ZodLiteral<true>>;
            cwd: z.ZodOptional<z.ZodString>;
            configDir: z.ZodOptional<z.ZodString>;
            configDirUnset: z.ZodOptional<z.ZodLiteral<true>>;
            resume: z.ZodOptional<z.ZodLiteral<true>>;
        }, z.core.$strict>>;
        host: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    agentRecord: z.ZodObject<{
        repo: z.ZodOptional<z.ZodString>;
        branch: z.ZodOptional<z.ZodString>;
        base: z.ZodOptional<z.ZodObject<{
            sha: z.ZodString;
            ref: z.ZodString;
        }, z.core.$strict>>;
        task: z.ZodOptional<z.ZodString>;
        workRole: z.ZodOptional<z.ZodString>;
        workRoleInferred: z.ZodOptional<z.ZodLiteral<true>>;
        lastEventAt: z.ZodNumber;
        exitedAt: z.ZodOptional<z.ZodNumber>;
        detachedAt: z.ZodOptional<z.ZodNumber>;
        generation: z.ZodNumber;
        teleportFrom: z.ZodOptional<z.ZodString>;
        predecessor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        exit: z.ZodOptional<z.ZodObject<{
            code: z.ZodNullable<z.ZodNumber>;
            summary: z.ZodString;
            costUsd: z.ZodOptional<z.ZodNumber>;
            failedToStart: z.ZodOptional<z.ZodBoolean>;
            inferred: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        agentId: z.ZodString;
        name: z.ZodString;
        profile: z.ZodString;
        state: z.ZodEnum<{
            spawning: "spawning";
            live: "live";
            detached: "detached";
            exited: "exited";
            retired: "retired";
        }>;
        origin: z.ZodEnum<{
            spawned: "spawned";
            adopted: "adopted";
        }>;
        spawnedBy: z.ZodString;
        launchedBy: z.ZodOptional<z.ZodEnum<{
            shepherd: "shepherd";
            "seat-watchdog": "seat-watchdog";
        }>>;
        spawnedAt: z.ZodNumber;
        brief: z.ZodOptional<z.ZodString>;
        cwd: z.ZodString;
        isolation: z.ZodString;
        surface: z.ZodString;
        sessionId: z.ZodString;
        configDir: z.ZodOptional<z.ZodString>;
        configDirUnset: z.ZodOptional<z.ZodBoolean>;
        host: z.ZodOptional<z.ZodString>;
        provisionalName: z.ZodOptional<z.ZodLiteral<true>>;
    }, z.core.$strict>;
    rosterHidden: z.ZodObject<{
        finished: z.ZodNumber;
        retired: z.ZodNumber;
        overLimit: z.ZodNumber;
    }, z.core.$strict>;
    spawnResult: z.ZodObject<{
        ok: z.ZodBoolean;
        agentId: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        code: z.ZodOptional<z.ZodEnum<{
            surface_refused: "surface_refused";
            spawn_rate_limit: "spawn_rate_limit";
            machine_headless_limit: "machine_headless_limit";
            machine_memory_floor: "machine_memory_floor";
            seat_budget_stop: "seat_budget_stop";
            seat_spawn_overlap: "seat_spawn_overlap";
            seat_hand_reserve: "seat_hand_reserve";
            seat_spawn_unprefixed: "seat_spawn_unprefixed";
            reviewer_account_limit: "reviewer_account_limit";
            broker_draining: "broker_draining";
            harness_unsupported: "harness_unsupported";
            account_exhausted: "account_exhausted";
        }>>;
        retryable: z.ZodOptional<z.ZodBoolean>;
        retryAfterMs: z.ZodOptional<z.ZodNumber>;
        warnings: z.ZodOptional<z.ZodArray<z.ZodString>>;
        disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        transcript: z.ZodOptional<z.ZodObject<{
            path: z.ZodString;
            found: z.ZodBoolean;
        }, z.core.$strict>>;
        account: z.ZodOptional<z.ZodString>;
        base: z.ZodOptional<z.ZodObject<{
            ref: z.ZodString;
            sha: z.ZodString;
        }, z.core.$strict>>;
        deduped: z.ZodOptional<z.ZodBoolean>;
        launch: z.ZodOptional<z.ZodObject<{
            agentId: z.ZodString;
            sessionId: z.ZodString;
            name: z.ZodString;
            profile: z.ZodObject<{
                mcpServers: z.ZodOptional<z.ZodNever>;
                env: z.ZodOptional<z.ZodNever>;
                warnings: z.ZodOptional<z.ZodNever>;
                name: z.ZodString;
                description: z.ZodString;
                harness: z.ZodOptional<z.ZodEnum<{
                    "claude-code": "claude-code";
                    codex: "codex";
                }>>;
                model: z.ZodString;
                allowedTools: z.ZodArray<z.ZodString>;
                disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
                isolation: z.ZodEnum<{
                    none: "none";
                    worktree: "worktree";
                    "file-ownership": "file-ownership";
                    "toolset-limited": "toolset-limited";
                }>;
                surface: z.ZodEnum<{
                    headless: "headless";
                    "iterm-pane": "iterm-pane";
                    "iterm-tab": "iterm-tab";
                    "iterm-window": "iterm-window";
                    "tmux-window": "tmux-window";
                }>;
                surfaceLifetime: z.ZodOptional<z.ZodEnum<{
                    "close-on-exit": "close-on-exit";
                    keep: "keep";
                }>>;
                role: z.ZodOptional<z.ZodEnum<{
                    coordinator: "coordinator";
                    worker: "worker";
                }>>;
                remoteControl: z.ZodOptional<z.ZodBoolean>;
                returnContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                    implementer: "implementer";
                    reviewer: "reviewer";
                }>, z.ZodLiteral<"none">]>>;
                effort: z.ZodOptional<z.ZodEnum<{
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                cacheTtl: z.ZodOptional<z.ZodEnum<{
                    "5m": "5m";
                    "1h": "1h";
                }>>;
                pushPolicy: z.ZodOptional<z.ZodEnum<{
                    "no-rewrite": "no-rewrite";
                    "scan-only": "scan-only";
                }>>;
                promptPrelude: z.ZodString;
                strictMcpConfig: z.ZodOptional<z.ZodBoolean>;
                settingSources: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                    user: "user";
                    project: "project";
                    local: "local";
                }>>>;
                disableSlashCommands: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
            brief: z.ZodString;
            preamble: z.ZodString;
            adopted: z.ZodOptional<z.ZodLiteral<true>>;
            surface: z.ZodEnum<{
                headless: "headless";
                "iterm-pane": "iterm-pane";
                "iterm-tab": "iterm-tab";
                "iterm-window": "iterm-window";
                "tmux-window": "tmux-window";
            }>;
            tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
            subscriptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
                selector: z.ZodUnion<readonly [z.ZodObject<{
                    all: z.ZodLiteral<true>;
                }, z.core.$strict>, z.ZodObject<{
                    name: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    tag: z.ZodString;
                }, z.core.$strict>, z.ZodObject<{
                    spawnedBy: z.ZodLiteral<"self">;
                }, z.core.$strict>]>;
                kinds: z.ZodArray<z.ZodEnum<{
                    registered: "registered";
                    deregistered: "deregistered";
                    agent_spawned: "agent_spawned";
                    agent_attached: "agent_attached";
                    agent_detached: "agent_detached";
                    agent_resumed: "agent_resumed";
                    agent_exited: "agent_exited";
                    agent_retired: "agent_retired";
                    agent_spawn_refused: "agent_spawn_refused";
                }>>;
            }, z.core.$strict>>>;
            remoteControl: z.ZodOptional<z.ZodBoolean>;
            channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
            permissionMode: z.ZodOptional<z.ZodString>;
            anchor: z.ZodOptional<z.ZodString>;
            landToken: z.ZodOptional<z.ZodString>;
            successorFirst: z.ZodOptional<z.ZodLiteral<true>>;
            cwd: z.ZodOptional<z.ZodString>;
            configDir: z.ZodOptional<z.ZodString>;
            configDirUnset: z.ZodOptional<z.ZodLiteral<true>>;
            resume: z.ZodOptional<z.ZodLiteral<true>>;
        }, z.core.$strict>>;
        host: z.ZodOptional<z.ZodString>;
        t: z.ZodLiteral<"spawn_result">;
        rid: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    agentsResult: z.ZodObject<{
        t: z.ZodLiteral<"agents_result">;
        agents: z.ZodArray<z.ZodObject<{
            repo: z.ZodOptional<z.ZodString>;
            branch: z.ZodOptional<z.ZodString>;
            base: z.ZodOptional<z.ZodObject<{
                sha: z.ZodString;
                ref: z.ZodString;
            }, z.core.$strict>>;
            task: z.ZodOptional<z.ZodString>;
            workRole: z.ZodOptional<z.ZodString>;
            workRoleInferred: z.ZodOptional<z.ZodLiteral<true>>;
            lastEventAt: z.ZodNumber;
            exitedAt: z.ZodOptional<z.ZodNumber>;
            detachedAt: z.ZodOptional<z.ZodNumber>;
            generation: z.ZodNumber;
            teleportFrom: z.ZodOptional<z.ZodString>;
            predecessor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            exit: z.ZodOptional<z.ZodObject<{
                code: z.ZodNullable<z.ZodNumber>;
                summary: z.ZodString;
                costUsd: z.ZodOptional<z.ZodNumber>;
                failedToStart: z.ZodOptional<z.ZodBoolean>;
                inferred: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>>;
            agentId: z.ZodString;
            name: z.ZodString;
            profile: z.ZodString;
            state: z.ZodEnum<{
                spawning: "spawning";
                live: "live";
                detached: "detached";
                exited: "exited";
                retired: "retired";
            }>;
            origin: z.ZodEnum<{
                spawned: "spawned";
                adopted: "adopted";
            }>;
            spawnedBy: z.ZodString;
            launchedBy: z.ZodOptional<z.ZodEnum<{
                shepherd: "shepherd";
                "seat-watchdog": "seat-watchdog";
            }>>;
            spawnedAt: z.ZodNumber;
            brief: z.ZodOptional<z.ZodString>;
            cwd: z.ZodString;
            isolation: z.ZodString;
            surface: z.ZodString;
            sessionId: z.ZodString;
            configDir: z.ZodOptional<z.ZodString>;
            configDirUnset: z.ZodOptional<z.ZodBoolean>;
            host: z.ZodOptional<z.ZodString>;
            provisionalName: z.ZodOptional<z.ZodLiteral<true>>;
        }, z.core.$strict>>;
        slots: z.ZodOptional<z.ZodObject<{
            held: z.ZodNumber;
            cap: z.ZodNumber;
        }, z.core.$strict>>;
        hidden: z.ZodOptional<z.ZodObject<{
            finished: z.ZodNumber;
            retired: z.ZodNumber;
            overLimit: z.ZodNumber;
        }, z.core.$strict>>;
        rid: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    switchResult: z.ZodObject<{
        t: z.ZodLiteral<"switch_result">;
        ok: z.ZodBoolean;
        reason: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        agentId: z.ZodOptional<z.ZodString>;
        surface: z.ZodOptional<z.ZodEnum<{
            headless: "headless";
            "iterm-pane": "iterm-pane";
            "iterm-tab": "iterm-tab";
            "iterm-window": "iterm-window";
            "tmux-window": "tmux-window";
        }>>;
        warnings: z.ZodOptional<z.ZodArray<z.ZodString>>;
        rid: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
};

/** agent-chat's on-disk profile. Parsing it grants no launch or permission authority. */
declare const AgentProfileSchema: z.ZodObject<{
    mcpServers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    warnings: z.ZodOptional<z.ZodArray<z.ZodString>>;
    name: z.ZodString;
    description: z.ZodString;
    harness: z.ZodOptional<z.ZodEnum<{
        "claude-code": "claude-code";
        codex: "codex";
    }>>;
    model: z.ZodString;
    allowedTools: z.ZodArray<z.ZodString>;
    disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    isolation: z.ZodEnum<{
        none: "none";
        worktree: "worktree";
        "file-ownership": "file-ownership";
        "toolset-limited": "toolset-limited";
    }>;
    surface: z.ZodEnum<{
        headless: "headless";
        "iterm-pane": "iterm-pane";
        "iterm-tab": "iterm-tab";
        "iterm-window": "iterm-window";
        "tmux-window": "tmux-window";
    }>;
    surfaceLifetime: z.ZodOptional<z.ZodEnum<{
        "close-on-exit": "close-on-exit";
        keep: "keep";
    }>>;
    role: z.ZodOptional<z.ZodEnum<{
        coordinator: "coordinator";
        worker: "worker";
    }>>;
    remoteControl: z.ZodOptional<z.ZodBoolean>;
    returnContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
        implementer: "implementer";
        reviewer: "reviewer";
    }>, z.ZodLiteral<"none">]>>;
    effort: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
        xhigh: "xhigh";
        max: "max";
    }>>;
    cacheTtl: z.ZodOptional<z.ZodEnum<{
        "5m": "5m";
        "1h": "1h";
    }>>;
    pushPolicy: z.ZodOptional<z.ZodEnum<{
        "no-rewrite": "no-rewrite";
        "scan-only": "scan-only";
    }>>;
    promptPrelude: z.ZodString;
    strictMcpConfig: z.ZodOptional<z.ZodBoolean>;
    settingSources: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        project: "project";
        local: "local";
    }>>>;
    disableSlashCommands: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
/** Refuses `env`, `mcpServers` and `warnings` even in a loose parse, so none crosses to a remote host. */
declare const RemoteProfileSchema: z.ZodObject<{
    mcpServers: z.ZodOptional<z.ZodNever>;
    env: z.ZodOptional<z.ZodNever>;
    warnings: z.ZodOptional<z.ZodNever>;
    name: z.ZodString;
    description: z.ZodString;
    harness: z.ZodOptional<z.ZodEnum<{
        "claude-code": "claude-code";
        codex: "codex";
    }>>;
    model: z.ZodString;
    allowedTools: z.ZodArray<z.ZodString>;
    disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    isolation: z.ZodEnum<{
        none: "none";
        worktree: "worktree";
        "file-ownership": "file-ownership";
        "toolset-limited": "toolset-limited";
    }>;
    surface: z.ZodEnum<{
        headless: "headless";
        "iterm-pane": "iterm-pane";
        "iterm-tab": "iterm-tab";
        "iterm-window": "iterm-window";
        "tmux-window": "tmux-window";
    }>;
    surfaceLifetime: z.ZodOptional<z.ZodEnum<{
        "close-on-exit": "close-on-exit";
        keep: "keep";
    }>>;
    role: z.ZodOptional<z.ZodEnum<{
        coordinator: "coordinator";
        worker: "worker";
    }>>;
    remoteControl: z.ZodOptional<z.ZodBoolean>;
    returnContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
        implementer: "implementer";
        reviewer: "reviewer";
    }>, z.ZodLiteral<"none">]>>;
    effort: z.ZodOptional<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
        xhigh: "xhigh";
        max: "max";
    }>>;
    cacheTtl: z.ZodOptional<z.ZodEnum<{
        "5m": "5m";
        "1h": "1h";
    }>>;
    pushPolicy: z.ZodOptional<z.ZodEnum<{
        "no-rewrite": "no-rewrite";
        "scan-only": "scan-only";
    }>>;
    promptPrelude: z.ZodString;
    strictMcpConfig: z.ZodOptional<z.ZodBoolean>;
    settingSources: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        project: "project";
        local: "local";
    }>>>;
    disableSlashCommands: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
declare const RemoteLaunchSchema: z.ZodObject<{
    agentId: z.ZodString;
    sessionId: z.ZodString;
    name: z.ZodString;
    profile: z.ZodObject<{
        mcpServers: z.ZodOptional<z.ZodNever>;
        env: z.ZodOptional<z.ZodNever>;
        warnings: z.ZodOptional<z.ZodNever>;
        name: z.ZodString;
        description: z.ZodString;
        harness: z.ZodOptional<z.ZodEnum<{
            "claude-code": "claude-code";
            codex: "codex";
        }>>;
        model: z.ZodString;
        allowedTools: z.ZodArray<z.ZodString>;
        disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        isolation: z.ZodEnum<{
            none: "none";
            worktree: "worktree";
            "file-ownership": "file-ownership";
            "toolset-limited": "toolset-limited";
        }>;
        surface: z.ZodEnum<{
            headless: "headless";
            "iterm-pane": "iterm-pane";
            "iterm-tab": "iterm-tab";
            "iterm-window": "iterm-window";
            "tmux-window": "tmux-window";
        }>;
        surfaceLifetime: z.ZodOptional<z.ZodEnum<{
            "close-on-exit": "close-on-exit";
            keep: "keep";
        }>>;
        role: z.ZodOptional<z.ZodEnum<{
            coordinator: "coordinator";
            worker: "worker";
        }>>;
        remoteControl: z.ZodOptional<z.ZodBoolean>;
        returnContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            implementer: "implementer";
            reviewer: "reviewer";
        }>, z.ZodLiteral<"none">]>>;
        effort: z.ZodOptional<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        cacheTtl: z.ZodOptional<z.ZodEnum<{
            "5m": "5m";
            "1h": "1h";
        }>>;
        pushPolicy: z.ZodOptional<z.ZodEnum<{
            "no-rewrite": "no-rewrite";
            "scan-only": "scan-only";
        }>>;
        promptPrelude: z.ZodString;
        strictMcpConfig: z.ZodOptional<z.ZodBoolean>;
        settingSources: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            project: "project";
            local: "local";
        }>>>;
        disableSlashCommands: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    brief: z.ZodString;
    preamble: z.ZodString;
    adopted: z.ZodOptional<z.ZodLiteral<true>>;
    surface: z.ZodEnum<{
        headless: "headless";
        "iterm-pane": "iterm-pane";
        "iterm-tab": "iterm-tab";
        "iterm-window": "iterm-window";
        "tmux-window": "tmux-window";
    }>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    subscriptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        selector: z.ZodUnion<readonly [z.ZodObject<{
            all: z.ZodLiteral<true>;
        }, z.core.$strict>, z.ZodObject<{
            name: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            tag: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            spawnedBy: z.ZodLiteral<"self">;
        }, z.core.$strict>]>;
        kinds: z.ZodArray<z.ZodEnum<{
            registered: "registered";
            deregistered: "deregistered";
            agent_spawned: "agent_spawned";
            agent_attached: "agent_attached";
            agent_detached: "agent_detached";
            agent_resumed: "agent_resumed";
            agent_exited: "agent_exited";
            agent_retired: "agent_retired";
            agent_spawn_refused: "agent_spawn_refused";
        }>>;
    }, z.core.$strict>>>;
    remoteControl: z.ZodOptional<z.ZodBoolean>;
    channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
    permissionMode: z.ZodOptional<z.ZodString>;
    anchor: z.ZodOptional<z.ZodString>;
    landToken: z.ZodOptional<z.ZodString>;
    successorFirst: z.ZodOptional<z.ZodLiteral<true>>;
    cwd: z.ZodOptional<z.ZodString>;
    configDir: z.ZodOptional<z.ZodString>;
    configDirUnset: z.ZodOptional<z.ZodLiteral<true>>;
    resume: z.ZodOptional<z.ZodLiteral<true>>;
}, z.core.$strict>;
declare const SpawnResultFieldsSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    agentId: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodEnum<{
        surface_refused: "surface_refused";
        spawn_rate_limit: "spawn_rate_limit";
        machine_headless_limit: "machine_headless_limit";
        machine_memory_floor: "machine_memory_floor";
        seat_budget_stop: "seat_budget_stop";
        seat_spawn_overlap: "seat_spawn_overlap";
        seat_hand_reserve: "seat_hand_reserve";
        seat_spawn_unprefixed: "seat_spawn_unprefixed";
        reviewer_account_limit: "reviewer_account_limit";
        broker_draining: "broker_draining";
        harness_unsupported: "harness_unsupported";
        account_exhausted: "account_exhausted";
    }>>;
    retryable: z.ZodOptional<z.ZodBoolean>;
    retryAfterMs: z.ZodOptional<z.ZodNumber>;
    warnings: z.ZodOptional<z.ZodArray<z.ZodString>>;
    disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    transcript: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        found: z.ZodBoolean;
    }, z.core.$strict>>;
    account: z.ZodOptional<z.ZodString>;
    base: z.ZodOptional<z.ZodObject<{
        ref: z.ZodString;
        sha: z.ZodString;
    }, z.core.$strict>>;
    deduped: z.ZodOptional<z.ZodBoolean>;
    launch: z.ZodOptional<z.ZodObject<{
        agentId: z.ZodString;
        sessionId: z.ZodString;
        name: z.ZodString;
        profile: z.ZodObject<{
            mcpServers: z.ZodOptional<z.ZodNever>;
            env: z.ZodOptional<z.ZodNever>;
            warnings: z.ZodOptional<z.ZodNever>;
            name: z.ZodString;
            description: z.ZodString;
            harness: z.ZodOptional<z.ZodEnum<{
                "claude-code": "claude-code";
                codex: "codex";
            }>>;
            model: z.ZodString;
            allowedTools: z.ZodArray<z.ZodString>;
            disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            isolation: z.ZodEnum<{
                none: "none";
                worktree: "worktree";
                "file-ownership": "file-ownership";
                "toolset-limited": "toolset-limited";
            }>;
            surface: z.ZodEnum<{
                headless: "headless";
                "iterm-pane": "iterm-pane";
                "iterm-tab": "iterm-tab";
                "iterm-window": "iterm-window";
                "tmux-window": "tmux-window";
            }>;
            surfaceLifetime: z.ZodOptional<z.ZodEnum<{
                "close-on-exit": "close-on-exit";
                keep: "keep";
            }>>;
            role: z.ZodOptional<z.ZodEnum<{
                coordinator: "coordinator";
                worker: "worker";
            }>>;
            remoteControl: z.ZodOptional<z.ZodBoolean>;
            returnContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                implementer: "implementer";
                reviewer: "reviewer";
            }>, z.ZodLiteral<"none">]>>;
            effort: z.ZodOptional<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            cacheTtl: z.ZodOptional<z.ZodEnum<{
                "5m": "5m";
                "1h": "1h";
            }>>;
            pushPolicy: z.ZodOptional<z.ZodEnum<{
                "no-rewrite": "no-rewrite";
                "scan-only": "scan-only";
            }>>;
            promptPrelude: z.ZodString;
            strictMcpConfig: z.ZodOptional<z.ZodBoolean>;
            settingSources: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                user: "user";
                project: "project";
                local: "local";
            }>>>;
            disableSlashCommands: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        brief: z.ZodString;
        preamble: z.ZodString;
        adopted: z.ZodOptional<z.ZodLiteral<true>>;
        surface: z.ZodEnum<{
            headless: "headless";
            "iterm-pane": "iterm-pane";
            "iterm-tab": "iterm-tab";
            "iterm-window": "iterm-window";
            "tmux-window": "tmux-window";
        }>;
        tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
        subscriptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
            selector: z.ZodUnion<readonly [z.ZodObject<{
                all: z.ZodLiteral<true>;
            }, z.core.$strict>, z.ZodObject<{
                name: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                tag: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                spawnedBy: z.ZodLiteral<"self">;
            }, z.core.$strict>]>;
            kinds: z.ZodArray<z.ZodEnum<{
                registered: "registered";
                deregistered: "deregistered";
                agent_spawned: "agent_spawned";
                agent_attached: "agent_attached";
                agent_detached: "agent_detached";
                agent_resumed: "agent_resumed";
                agent_exited: "agent_exited";
                agent_retired: "agent_retired";
                agent_spawn_refused: "agent_spawn_refused";
            }>>;
        }, z.core.$strict>>>;
        remoteControl: z.ZodOptional<z.ZodBoolean>;
        channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
        permissionMode: z.ZodOptional<z.ZodString>;
        anchor: z.ZodOptional<z.ZodString>;
        landToken: z.ZodOptional<z.ZodString>;
        successorFirst: z.ZodOptional<z.ZodLiteral<true>>;
        cwd: z.ZodOptional<z.ZodString>;
        configDir: z.ZodOptional<z.ZodString>;
        configDirUnset: z.ZodOptional<z.ZodLiteral<true>>;
        resume: z.ZodOptional<z.ZodLiteral<true>>;
    }, z.core.$strict>>;
    host: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** A roster row. Root `AgentIdentity` is the neutral handle; `AgentRecord.agentId` is that handle. */
declare const AgentRecordSchema: z.ZodObject<{
    repo: z.ZodOptional<z.ZodString>;
    branch: z.ZodOptional<z.ZodString>;
    base: z.ZodOptional<z.ZodObject<{
        sha: z.ZodString;
        ref: z.ZodString;
    }, z.core.$strict>>;
    task: z.ZodOptional<z.ZodString>;
    workRole: z.ZodOptional<z.ZodString>;
    workRoleInferred: z.ZodOptional<z.ZodLiteral<true>>;
    lastEventAt: z.ZodNumber;
    exitedAt: z.ZodOptional<z.ZodNumber>;
    detachedAt: z.ZodOptional<z.ZodNumber>;
    generation: z.ZodNumber;
    teleportFrom: z.ZodOptional<z.ZodString>;
    predecessor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    exit: z.ZodOptional<z.ZodObject<{
        code: z.ZodNullable<z.ZodNumber>;
        summary: z.ZodString;
        costUsd: z.ZodOptional<z.ZodNumber>;
        failedToStart: z.ZodOptional<z.ZodBoolean>;
        inferred: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    agentId: z.ZodString;
    name: z.ZodString;
    profile: z.ZodString;
    state: z.ZodEnum<{
        spawning: "spawning";
        live: "live";
        detached: "detached";
        exited: "exited";
        retired: "retired";
    }>;
    origin: z.ZodEnum<{
        spawned: "spawned";
        adopted: "adopted";
    }>;
    spawnedBy: z.ZodString;
    launchedBy: z.ZodOptional<z.ZodEnum<{
        shepherd: "shepherd";
        "seat-watchdog": "seat-watchdog";
    }>>;
    spawnedAt: z.ZodNumber;
    brief: z.ZodOptional<z.ZodString>;
    cwd: z.ZodString;
    isolation: z.ZodString;
    surface: z.ZodString;
    sessionId: z.ZodString;
    configDir: z.ZodOptional<z.ZodString>;
    configDirUnset: z.ZodOptional<z.ZodBoolean>;
    host: z.ZodOptional<z.ZodString>;
    provisionalName: z.ZodOptional<z.ZodLiteral<true>>;
}, z.core.$strict>;
declare const RosterHiddenSchema: z.ZodObject<{
    finished: z.ZodNumber;
    retired: z.ZodNumber;
    overLimit: z.ZodNumber;
}, z.core.$strict>;
/** The answer to `spawn`, `resume` and `retire`. */
declare const SpawnResultSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    agentId: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodEnum<{
        surface_refused: "surface_refused";
        spawn_rate_limit: "spawn_rate_limit";
        machine_headless_limit: "machine_headless_limit";
        machine_memory_floor: "machine_memory_floor";
        seat_budget_stop: "seat_budget_stop";
        seat_spawn_overlap: "seat_spawn_overlap";
        seat_hand_reserve: "seat_hand_reserve";
        seat_spawn_unprefixed: "seat_spawn_unprefixed";
        reviewer_account_limit: "reviewer_account_limit";
        broker_draining: "broker_draining";
        harness_unsupported: "harness_unsupported";
        account_exhausted: "account_exhausted";
    }>>;
    retryable: z.ZodOptional<z.ZodBoolean>;
    retryAfterMs: z.ZodOptional<z.ZodNumber>;
    warnings: z.ZodOptional<z.ZodArray<z.ZodString>>;
    disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    transcript: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        found: z.ZodBoolean;
    }, z.core.$strict>>;
    account: z.ZodOptional<z.ZodString>;
    base: z.ZodOptional<z.ZodObject<{
        ref: z.ZodString;
        sha: z.ZodString;
    }, z.core.$strict>>;
    deduped: z.ZodOptional<z.ZodBoolean>;
    launch: z.ZodOptional<z.ZodObject<{
        agentId: z.ZodString;
        sessionId: z.ZodString;
        name: z.ZodString;
        profile: z.ZodObject<{
            mcpServers: z.ZodOptional<z.ZodNever>;
            env: z.ZodOptional<z.ZodNever>;
            warnings: z.ZodOptional<z.ZodNever>;
            name: z.ZodString;
            description: z.ZodString;
            harness: z.ZodOptional<z.ZodEnum<{
                "claude-code": "claude-code";
                codex: "codex";
            }>>;
            model: z.ZodString;
            allowedTools: z.ZodArray<z.ZodString>;
            disallowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
            isolation: z.ZodEnum<{
                none: "none";
                worktree: "worktree";
                "file-ownership": "file-ownership";
                "toolset-limited": "toolset-limited";
            }>;
            surface: z.ZodEnum<{
                headless: "headless";
                "iterm-pane": "iterm-pane";
                "iterm-tab": "iterm-tab";
                "iterm-window": "iterm-window";
                "tmux-window": "tmux-window";
            }>;
            surfaceLifetime: z.ZodOptional<z.ZodEnum<{
                "close-on-exit": "close-on-exit";
                keep: "keep";
            }>>;
            role: z.ZodOptional<z.ZodEnum<{
                coordinator: "coordinator";
                worker: "worker";
            }>>;
            remoteControl: z.ZodOptional<z.ZodBoolean>;
            returnContract: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                implementer: "implementer";
                reviewer: "reviewer";
            }>, z.ZodLiteral<"none">]>>;
            effort: z.ZodOptional<z.ZodEnum<{
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            cacheTtl: z.ZodOptional<z.ZodEnum<{
                "5m": "5m";
                "1h": "1h";
            }>>;
            pushPolicy: z.ZodOptional<z.ZodEnum<{
                "no-rewrite": "no-rewrite";
                "scan-only": "scan-only";
            }>>;
            promptPrelude: z.ZodString;
            strictMcpConfig: z.ZodOptional<z.ZodBoolean>;
            settingSources: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                user: "user";
                project: "project";
                local: "local";
            }>>>;
            disableSlashCommands: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>;
        brief: z.ZodString;
        preamble: z.ZodString;
        adopted: z.ZodOptional<z.ZodLiteral<true>>;
        surface: z.ZodEnum<{
            headless: "headless";
            "iterm-pane": "iterm-pane";
            "iterm-tab": "iterm-tab";
            "iterm-window": "iterm-window";
            "tmux-window": "tmux-window";
        }>;
        tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
        subscriptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
            selector: z.ZodUnion<readonly [z.ZodObject<{
                all: z.ZodLiteral<true>;
            }, z.core.$strict>, z.ZodObject<{
                name: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                tag: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                spawnedBy: z.ZodLiteral<"self">;
            }, z.core.$strict>]>;
            kinds: z.ZodArray<z.ZodEnum<{
                registered: "registered";
                deregistered: "deregistered";
                agent_spawned: "agent_spawned";
                agent_attached: "agent_attached";
                agent_detached: "agent_detached";
                agent_resumed: "agent_resumed";
                agent_exited: "agent_exited";
                agent_retired: "agent_retired";
                agent_spawn_refused: "agent_spawn_refused";
            }>>;
        }, z.core.$strict>>>;
        remoteControl: z.ZodOptional<z.ZodBoolean>;
        channels: z.ZodOptional<z.ZodArray<z.ZodString>>;
        permissionMode: z.ZodOptional<z.ZodString>;
        anchor: z.ZodOptional<z.ZodString>;
        landToken: z.ZodOptional<z.ZodString>;
        successorFirst: z.ZodOptional<z.ZodLiteral<true>>;
        cwd: z.ZodOptional<z.ZodString>;
        configDir: z.ZodOptional<z.ZodString>;
        configDirUnset: z.ZodOptional<z.ZodLiteral<true>>;
        resume: z.ZodOptional<z.ZodLiteral<true>>;
    }, z.core.$strict>>;
    host: z.ZodOptional<z.ZodString>;
    t: z.ZodLiteral<"spawn_result">;
    rid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
declare const AgentListResultSchema: z.ZodObject<{
    t: z.ZodLiteral<"agents_result">;
    agents: z.ZodArray<z.ZodObject<{
        repo: z.ZodOptional<z.ZodString>;
        branch: z.ZodOptional<z.ZodString>;
        base: z.ZodOptional<z.ZodObject<{
            sha: z.ZodString;
            ref: z.ZodString;
        }, z.core.$strict>>;
        task: z.ZodOptional<z.ZodString>;
        workRole: z.ZodOptional<z.ZodString>;
        workRoleInferred: z.ZodOptional<z.ZodLiteral<true>>;
        lastEventAt: z.ZodNumber;
        exitedAt: z.ZodOptional<z.ZodNumber>;
        detachedAt: z.ZodOptional<z.ZodNumber>;
        generation: z.ZodNumber;
        teleportFrom: z.ZodOptional<z.ZodString>;
        predecessor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        exit: z.ZodOptional<z.ZodObject<{
            code: z.ZodNullable<z.ZodNumber>;
            summary: z.ZodString;
            costUsd: z.ZodOptional<z.ZodNumber>;
            failedToStart: z.ZodOptional<z.ZodBoolean>;
            inferred: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        agentId: z.ZodString;
        name: z.ZodString;
        profile: z.ZodString;
        state: z.ZodEnum<{
            spawning: "spawning";
            live: "live";
            detached: "detached";
            exited: "exited";
            retired: "retired";
        }>;
        origin: z.ZodEnum<{
            spawned: "spawned";
            adopted: "adopted";
        }>;
        spawnedBy: z.ZodString;
        launchedBy: z.ZodOptional<z.ZodEnum<{
            shepherd: "shepherd";
            "seat-watchdog": "seat-watchdog";
        }>>;
        spawnedAt: z.ZodNumber;
        brief: z.ZodOptional<z.ZodString>;
        cwd: z.ZodString;
        isolation: z.ZodString;
        surface: z.ZodString;
        sessionId: z.ZodString;
        configDir: z.ZodOptional<z.ZodString>;
        configDirUnset: z.ZodOptional<z.ZodBoolean>;
        host: z.ZodOptional<z.ZodString>;
        provisionalName: z.ZodOptional<z.ZodLiteral<true>>;
    }, z.core.$strict>>;
    slots: z.ZodOptional<z.ZodObject<{
        held: z.ZodNumber;
        cap: z.ZodNumber;
    }, z.core.$strict>>;
    hidden: z.ZodOptional<z.ZodObject<{
        finished: z.ZodNumber;
        retired: z.ZodNumber;
        overLimit: z.ZodNumber;
    }, z.core.$strict>>;
    rid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
/** The answer to `surface`. */
declare const SurfaceResultSchema: z.ZodObject<{
    t: z.ZodLiteral<"switch_result">;
    ok: z.ZodBoolean;
    reason: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodString>;
    surface: z.ZodOptional<z.ZodEnum<{
        headless: "headless";
        "iterm-pane": "iterm-pane";
        "iterm-tab": "iterm-tab";
        "iterm-window": "iterm-window";
        "tmux-window": "tmux-window";
    }>>;
    warnings: z.ZodOptional<z.ZodArray<z.ZodString>>;
    rid: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
type AgentProfile = Known<z.output<typeof AgentProfileSchema>>;
type RemoteProfile = Known<z.output<typeof RemoteProfileSchema>>;
type RemoteLaunch = Known<z.output<typeof RemoteLaunchSchema>>;
type SpawnResultFields = Known<z.output<typeof SpawnResultFieldsSchema>>;
type AgentRecord = Known<z.output<typeof AgentRecordSchema>>;
type RosterHidden = Known<z.output<typeof RosterHiddenSchema>>;
type SpawnResult = Known<z.output<typeof SpawnResultSchema>>;
type AgentListResult = Known<z.output<typeof AgentListResultSchema>>;
type SurfaceResult = Known<z.output<typeof SurfaceResultSchema>>;

/** Refuses blank as well as absent: a stringified `undefined` once reached a peer as the word "undefined". */
declare const nonBlank: (message: string) => z.ZodString;
declare const requiredString: (field: string) => z.ZodString;
/** The refusal wording callers match on when an enum argument is out of range. */
declare const oneOf: (field: string, allowed: readonly string[]) => {
    error: string;
};
declare const WORK_ROLES: readonly ["implementer", "reviewer", "shepherd-review", "planner", "other"];
/** One of `WORK_ROLES`, or `fix-round-<n>` for a shepherd's n-th fix round. */
type WorkRole = (typeof WORK_ROLES)[number] | `fix-round-${number}`;
declare const isWorkRole: (value: string) => value is WorkRole;
declare const WORK_ROLE_CHOICES: string;

/**
 * `agent_spawn`'s MCP arguments, in the snake_case a model types. A plain object, so a key the tool
 * does not name is stripped rather than forwarded. Carries no `.describe()` text: the help is the
 * product's, written for its models, and the product adds it with `.extend()`.
 */
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
    slice: z.ZodOptional<z.ZodString>;
    route_override: z.ZodOptional<z.ZodString>;
    role: z.ZodOptional<z.ZodString & z.ZodType<WorkRole, string, z.core.$ZodTypeInternals<WorkRole, string>>>;
    override: z.ZodOptional<z.ZodLiteral<"fix-round">>;
    host: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type AgentSpawnArgs = z.output<typeof AgentSpawnArgsSchema>;

/** MCP arguments for the agent tools other than spawn; plain objects, so unknown keys are stripped. */
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
    host: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const AgentSurfaceArgsSchema: z.ZodObject<{
    name: z.ZodString;
}, z.core.$strip>;
/** `limit`'s default and cap are applied by the tool, so the published schema keeps it optional. */
declare const AgentListArgsSchema: z.ZodObject<{
    include_finished: z.ZodOptional<z.ZodBoolean>;
    include_retired: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
    mine: z.ZodOptional<z.ZodBoolean>;
    prefix: z.ZodOptional<z.ZodString>;
    verbose: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
declare const AgentProfilesArgsSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    verbose: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
type AgentResumeArgs = z.output<typeof AgentResumeArgsSchema>;
type AgentSurfaceArgs = z.output<typeof AgentSurfaceArgsSchema>;
type AgentListArgs = z.output<typeof AgentListArgsSchema>;
type AgentProfilesArgs = z.output<typeof AgentProfilesArgsSchema>;

export { AGENT_LIFECYCLES, AGENT_ORIGINS, AGENT_ROLES, type AgentLifecycle, AgentLifecycleSchema, type AgentListArgs, AgentListArgsSchema, type AgentListRequest, AgentListRequestSchema, type AgentListResult, AgentListResultSchema, type AgentOrigin, AgentOriginSchema, type AgentProfile, AgentProfileSchema, type AgentProfilesArgs, AgentProfilesArgsSchema, type AgentRecord, AgentRecordSchema, type AgentResumeArgs, AgentResumeArgsSchema, type AgentRole, AgentRoleSchema, type AgentSpawnArgs, AgentSpawnArgsSchema, type AgentSurfaceArgs, AgentSurfaceArgsSchema, CACHE_TTLS, type CacheTtl, CacheTtlSchema, EFFORT_LEVELS, type EffortLevel, EffortLevelSchema, type ExperimentArm, ExperimentArmSchema, HARNESSES, type Harness, HarnessSchema, ISOLATION_NAMES, type IsolationName, IsolationNameSchema, type Known, LAUNCHERS, type Launcher, LauncherSchema, PUSH_POLICIES, type PushPolicy, PushPolicySchema, RETURN_CONTRACTS, type RemoteLaunch, RemoteLaunchSchema, type RemoteProfile, RemoteProfileSchema, type ResumeRequest, ResumeRequestSchema, type RetireRequest, RetireRequestSchema, type ReturnContract, ReturnContractSchema, type RosterHidden, RosterHiddenSchema, type RosterView, RosterViewSchema, SETTING_SOURCES, SPAWN_REFUSAL_CODES, SUBSCRIBABLE_KINDS, SURFACE_LIFETIMES, SURFACE_NAMES, type SettingSource, SettingSourceSchema, type SpawnRefusalCode, SpawnRefusalCodeSchema, type SpawnRequest, SpawnRequestSchema, type SpawnResult, type SpawnResultFields, SpawnResultFieldsSchema, SpawnResultSchema, type SubscribableKind, SubscribableKindSchema, type Subscription, SubscriptionSchema, type SubscriptionSelector, type SurfaceLifetime, SurfaceLifetimeSchema, type SurfaceName, SurfaceNameSchema, type SurfaceRequest, SurfaceRequestSchema, type SurfaceResult, SurfaceResultSchema, WAKE_SOURCES, WORK_ROLES, WORK_ROLE_CHOICES, type WakeSource, WakeSourceSchema, type WireParseMode, type WorkRole, buildRequestSchemas, buildResultSchemas, isWorkRole, nonBlank, oneOf, requiredString };
