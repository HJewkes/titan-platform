/**
 * The agent profile shape and its closed value lists, ported from agent-chat's `agents/types.ts`.
 *
 * Runtime arrays rather than bare type unions: profile files are user-authored JSON, so every
 * value has to be checkable at the point a string arrives from disk, not only at compile time.
 * agent-protocol's `/wire` holds the same lists, but this package does not depend on it, so these
 * are copies of agent-chat's values.
 */

export const ISOLATION_NAMES = ["none", "worktree", "file-ownership", "toolset-limited"] as const;

export type IsolationName = (typeof ISOLATION_NAMES)[number];

export const SURFACE_NAMES = ["headless", "iterm-pane", "iterm-tab", "iterm-window", "tmux-window"] as const;

export type SurfaceName = (typeof SURFACE_NAMES)[number];

/**
 * What happens to an agent's pane when the agent itself ends (CC-95). A profile decision: the
 * lifetime of the surface follows what kind of thing was launched. `keep` still closes on retire.
 */
export const SURFACE_LIFETIMES = ["close-on-exit", "keep"] as const;

export type SurfaceLifetime = (typeof SURFACE_LIFETIMES)[number];

/** `keep` for a profile that does not say: the behaviour files written before the field were authored against. */
export const DEFAULT_SURFACE_LIFETIME: SurfaceLifetime = "keep";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** CC-1553: the values Claude Code's `CLAUDE_CODE_PROMPT_CACHE_TTL` accepts. */
export const CACHE_TTLS = ["5m", "1h"] as const;

export type CacheTtl = (typeof CACHE_TTLS)[number];

/**
 * CC-1633: what the pre-push hook refuses; `no-rewrite` denies deletes, non-fast-forwards, mirrors and main or master.
 * CC-1650: `scan-only` is the explicit opt-out to the leak scan alone; an absent field means `no-rewrite`.
 */
export const PUSH_POLICIES = ["no-rewrite", "scan-only"] as const;

export type PushPolicy = (typeof PUSH_POLICIES)[number];

/**
 * CC-163: what an agent may do with the bus beyond its own work. A coordinator may spawn agents
 * and run with Remote Control; a worker may do neither and reports needs to its spawner instead.
 */
export const AGENT_ROLES = ["coordinator", "worker"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

/** CC-1516: the CLI a profile launches. Absent means `claude-code`, the only one with a launch plan today. */
export const HARNESSES = ["claude-code", "codex"] as const;

export type Harness = (typeof HARNESSES)[number];

/** The settings files `--setting-sources` can name; `user` is the one holding the account's own allow rules. */
export const SETTING_SOURCES = ["user", "project", "local"] as const;

export type SettingSource = (typeof SETTING_SOURCES)[number];

/** CC-286: the report rules a dispatcher appends to a spawned agent's brief. */
export const RETURN_CONTRACTS = ["implementer", "reviewer"] as const;

export type ReturnContract = (typeof RETURN_CONTRACTS)[number];

export const CONTRACT_CHOICES = [...RETURN_CONTRACTS, "none"] as const;

export type ContractChoice = (typeof CONTRACT_CHOICES)[number];

const member =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    values.some((entry) => entry === value);

export const isIsolationName = member(ISOLATION_NAMES);
export const isSurfaceName = member(SURFACE_NAMES);
export const isSurfaceLifetime = member(SURFACE_LIFETIMES);
export const isEffortLevel = member(EFFORT_LEVELS);
export const isCacheTtl = member(CACHE_TTLS);
export const isPushPolicy = member(PUSH_POLICIES);
export const isRole = member(AGENT_ROLES);
export const isHarness = member(HARNESSES);
export const isContractChoice = member(CONTRACT_CHOICES);
export const isSettingSource = member(SETTING_SOURCES);

/**
 * A profile bundles the things that always travel together, so a spawn is one noun rather than
 * six flags.
 *
 * There is deliberately no `permissionMode` field. A profile widens a posture by naming tools,
 * which is reviewable in a diff; a mode flag widens it by category, which is not.
 */
export interface AgentProfile {
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
