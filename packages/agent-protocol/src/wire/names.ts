import { z } from "zod";

/**
 * agent-surface owns this list, but it sits a tier above this package, so the wire keeps a copy and
 * agent-surface's own test pins the two equal.
 */
export const SURFACE_NAMES = ["headless", "iterm-pane", "iterm-tab", "iterm-window", "tmux-window"] as const;
export const ISOLATION_NAMES = ["none", "worktree", "file-ownership", "toolset-limited"] as const;
export const SUBSCRIBABLE_KINDS = [
  "registered",
  "deregistered",
  "agent_spawned",
  "agent_attached",
  "agent_detached",
  "agent_resumed",
  "agent_exited",
  "agent_retired",
  "agent_spawn_refused",
] as const;
/** Marks a send or resume an automation made, so its event row is not read as the human typing. */
export const WAKE_SOURCES = ["watchdog", "shepherd", "console"] as const;
/** The automation behind a CLI spawn or resume; display only. */
export const LAUNCHERS = ["seat-watchdog", "shepherd"] as const;
export const AGENT_LIFECYCLES = ["spawning", "live", "detached", "exited", "retired"] as const;
/** `adopted` names a human-started session whose name and brief are self-reported, not broker-assigned. */
export const AGENT_ORIGINS = ["spawned", "adopted"] as const;
export const SPAWN_REFUSAL_CODES = [
  "surface_refused",
  "spawn_rate_limit",
  "machine_headless_limit",
  "machine_memory_floor",
  "seat_budget_stop",
  "seat_spawn_overlap",
  "seat_hand_reserve",
  "seat_spawn_unprefixed",
  "reviewer_account_limit",
  "broker_draining",
  "harness_unsupported",
  "account_exhausted",
] as const;
export const SURFACE_LIFETIMES = ["close-on-exit", "keep"] as const;
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CACHE_TTLS = ["5m", "1h"] as const;
export const PUSH_POLICIES = ["no-rewrite", "scan-only"] as const;
export const AGENT_ROLES = ["coordinator", "worker"] as const;
export const HARNESSES = ["claude-code", "codex"] as const;
export const SETTING_SOURCES = ["user", "project", "local"] as const;
export const RETURN_CONTRACTS = ["implementer", "reviewer"] as const;

export const SurfaceNameSchema = z.enum(SURFACE_NAMES);
export const IsolationNameSchema = z.enum(ISOLATION_NAMES);
export const SubscribableKindSchema = z.enum(SUBSCRIBABLE_KINDS);
export const WakeSourceSchema = z.enum(WAKE_SOURCES);
export const LauncherSchema = z.enum(LAUNCHERS);
export const AgentLifecycleSchema = z.enum(AGENT_LIFECYCLES);
export const AgentOriginSchema = z.enum(AGENT_ORIGINS);
export const SpawnRefusalCodeSchema = z.enum(SPAWN_REFUSAL_CODES);
export const SurfaceLifetimeSchema = z.enum(SURFACE_LIFETIMES);
export const EffortLevelSchema = z.enum(EFFORT_LEVELS);
export const CacheTtlSchema = z.enum(CACHE_TTLS);
export const PushPolicySchema = z.enum(PUSH_POLICIES);
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export const HarnessSchema = z.enum(HARNESSES);
export const SettingSourceSchema = z.enum(SETTING_SOURCES);
export const ReturnContractSchema = z.enum(RETURN_CONTRACTS);

export type SurfaceName = (typeof SURFACE_NAMES)[number];
export type IsolationName = (typeof ISOLATION_NAMES)[number];
export type SubscribableKind = (typeof SUBSCRIBABLE_KINDS)[number];
export type WakeSource = (typeof WAKE_SOURCES)[number];
export type Launcher = (typeof LAUNCHERS)[number];
export type AgentLifecycle = (typeof AGENT_LIFECYCLES)[number];
export type AgentOrigin = (typeof AGENT_ORIGINS)[number];
export type SpawnRefusalCode = (typeof SPAWN_REFUSAL_CODES)[number];
export type SurfaceLifetime = (typeof SURFACE_LIFETIMES)[number];
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type CacheTtl = (typeof CACHE_TTLS)[number];
export type PushPolicy = (typeof PUSH_POLICIES)[number];
export type AgentRole = (typeof AGENT_ROLES)[number];
export type Harness = (typeof HARNESSES)[number];
export type SettingSource = (typeof SETTING_SOURCES)[number];
export type ReturnContract = (typeof RETURN_CONTRACTS)[number];

/**
 * `exact` refuses a key the contract does not name, at every depth; a drift test parses captured
 * frames with it. `loose` keeps such keys, so a reader one release behind forwards a newer peer's frame intact.
 */
export type WireParseMode = "exact" | "loose";

export function objectFor(mode: WireParseMode) {
  return mode === "exact" ? z.strictObject : z.looseObject;
}

type NamedKeys<T> = { [K in keyof T as string extends K ? never : K]: T[K] };

/**
 * A loose parse's output without the catch-all index signature, at every depth. A plain record
 * such as a profile's `env` names no keys, so it keeps its signature.
 */
export type Known<T> = T extends readonly (infer U)[]
  ? Known<U>[]
  : T extends object
    ? [keyof NamedKeys<T>] extends [never]
      ? { [K in keyof T]: Known<T[K]> }
      : { [K in keyof NamedKeys<T>]: Known<NamedKeys<T>[K]> }
    : T;
