import { A as AgentProfile } from '../schema.js';
export { a as AGENT_ROLES, b as AgentRole, C as CACHE_TTLS, c as CONTRACT_CHOICES, d as CacheTtl, e as ContractChoice, D as DEFAULT_SURFACE_LIFETIME, E as EFFORT_LEVELS, f as EffortLevel, H as HARNESSES, g as Harness, I as ISOLATION_NAMES, h as IsolationName, P as PUSH_POLICIES, i as PushPolicy, R as RETURN_CONTRACTS, j as ReturnContract, S as SETTING_SOURCES, k as SURFACE_LIFETIMES, l as SURFACE_NAMES, m as SettingSource, n as SurfaceLifetime, o as SurfaceName, p as isCacheTtl, q as isContractChoice, r as isEffortLevel, s as isHarness, t as isIsolationName, u as isPushPolicy, v as isRole, w as isSurfaceLifetime, x as isSurfaceName } from '../schema.js';

declare const HARNESS_UNSUPPORTED = "harness_unsupported";
/** The refusal for launching this profile, before any process, worktree or slot exists; undefined when it can launch. */
declare function harnessRefusal(profile: AgentProfile): string | undefined;

/**
 * Validate a parsed profile file, ported from agent-chat's `parseProfile` and split by field
 * family so each check reads on its own. The checks run in agent-chat's order, so a file with
 * several faults is refused with the same first message.
 */

type ProfileParseResult = AgentProfile | {
    error: string;
};
/**
 * Returns the profile or an explanatory error, never a partially-trusted object: a profile that
 * half-loaded would grant whatever its defaults happened to be.
 */
declare function parseProfile(name: string, raw: unknown, file?: string): ProfileParseResult;

export { AgentProfile, HARNESS_UNSUPPORTED, type ProfileParseResult, harnessRefusal, parseProfile };

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
