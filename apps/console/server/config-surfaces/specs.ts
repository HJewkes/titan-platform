import type { SurfaceSpec } from "./catalog.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringsIn = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** A map shown by its key names alone, so nothing a server entry holds (env, headers, args) is read out. */
export const namesOnly = (value: unknown): string[] => (isRecord(value) ? Object.keys(value).sort() : []);

/** A Claude Code hook event shown as its matchers and the commands they run; every other key of an entry is dropped. */
function hookCommands(value: unknown): { matcher: string | null; commands: string[] }[] {
  return (Array.isArray(value) ? value : []).filter(isRecord).map((entry) => ({
    matcher: typeof entry.matcher === "string" ? entry.matcher : null,
    commands: (Array.isArray(entry.hooks) ? entry.hooks : []).filter(isRecord).flatMap((hook) => stringsIn([hook.command])),
  }));
}

/** A seat's repo entries as their path and remote; any other key an entry gains is dropped. */
function repoPaths(value: unknown): { path: string | null; remote: string | null }[] {
  const text = (item: unknown): string | null => (typeof item === "string" ? item : null);
  return (Array.isArray(value) ? value : []).filter(isRecord).map((entry) => ({ path: text(entry.path), remote: text(entry.remote) }));
}

export const CHARTER_SURFACE: SurfaceSpec = {
  kind: "charter",
  group: "coordinator",
  inventory: 1,
  format: "frontmatter",
  strictValues: true,
  safeFields: [
    "schema", "owner_seat", "hub", "charter_owner", "seats", "human_only_initiatives", "hard_stops", "defaults.**", "funds.**",
    ...["config_dir", "reserve_seven_day", "ceiling_five_hour", "per_day_points", "sonnet_band_points", "dispatch_five_hour_points"].map((key) => `pools.*.${key}`),
  ],
};

export const SEAT_SURFACE: SurfaceSpec = {
  kind: "seat",
  group: "coordinator",
  inventory: 3,
  format: "frontmatter",
  strictValues: true,
  safeFields: [
    "schema", "name", "prefix", "role", "attended", "pool", "overflow_pool", "config_dir", "concurrency.*", "spend.*", "share_caps.*", "kind_weights.*",
    "initiatives.*", "scope_tags", "excluded_tags", "grants_extra", "repos", "heartbeat_cron", "surface", "model", "effort", "profile",
  ],
  projections: { repos: repoPaths },
};

export const BURNDOWN_SURFACE: SurfaceSpec = {
  kind: "burndown",
  group: "coordinator",
  inventory: 9,
  format: "json",
  strictValues: true,
  safeFields: ["enabled", "reportTo", "seats", "maxAgents", "maxWorktreesPerRepo", "briefGate.**", "handReserve.**"],
};

/** Only the owner switches; the runtime readings beside them are listed hidden. */
export const SEAT_WATCHDOG_SURFACE: SurfaceSpec = {
  kind: "seat-watchdog",
  group: "coordinator",
  inventory: 10,
  format: "json",
  strictValues: true,
  safeFields: ["stopped.**", "held.**", "attended.**"],
};

/** Machine limits and switches; `machines`, `hostProof` and anything new stay hidden until named here. */
export const AGENT_CHAT_CONFIG_SURFACE: SurfaceSpec = {
  kind: "agent-chat-config",
  group: "agent-chat",
  inventory: 7,
  format: "json",
  strictValues: true,
  safeFields: [
    "coordinatorConfig", "agentSlots", "worktreeBudget", "reviewerWorktreeBudget", "worktreeOwnerReserve", "fullSuiteSlots",
    "machineHeadlessAgents", "machineMemoryFreePercent", "machineStopMemoryFreePercent", "machineStopLoad5", "machineStopSwapUsedPercent", "machineStopPressureLevel",
    "poolPick", "seatSpawnGate", "seatStewards", "seatStewards.*", "decider.agentId", "coordinatorGrantableTools", "permissionHookTimeoutSeconds",
    "noticeTtlHours", "ghWriteGapSeconds", "reportBatchSeconds", "processGuardMode", "processKillBytes", "orphanReapKill", "ledgerShadow", "parkAdvice",
  ],
};

/** `env` stays hidden: a profile may pass a token to its agents. MCP servers show by name only. */
export const PROFILE_SURFACE: SurfaceSpec = {
  kind: "profile",
  group: "agent-chat",
  inventory: 8,
  format: "json",
  strictValues: true,
  safeFields: [
    "name", "description", "model", "effort", "role", "allowedTools", "disallowedTools", "isolation", "surface", "surfaceLifetime",
    "remoteControl", "promptPrelude", "mcpServers", "strictMcpConfig", "settingSources", "disableSlashCommands",
  ],
  projections: { mcpServers: namesOnly },
};

const REVIEW_FIELDS = [
  "profile", "roles.g10", "roles.standard", "g10ChangedLines", "configDir", "fallbackConfigDirs", "maxConcurrent", "panel", "codewatchRepos",
  "verdictTimeoutMs", "sessionStartTimeoutMs", "minFreeBytes", "minFreeInodesPct", "adversaryProfile", "adversaryConfigDir",
];

/**
 * `digest.push` and `visualDelivery.push` hold the push topic URL, a secret, so neither is named; nor are
 * `remoteFactory` and `service.deployRemote`, URLs a credential could be written into.
 */
export const FACTORY_CONFIG_SURFACE: SurfaceSpec = {
  kind: "factory-config",
  group: "factory",
  inventory: 19,
  format: "json",
  strictValues: true,
  safeFields: [
    "dbPath", "postMerge.argv", "postMerge.cwd", "postMerge.timeoutMs", "service.labelPrefix", "service.deployCheckout", "service.deployWatchMs", "github.*",
    ...["outDir", "copyDirs", "icloudDir", "timezone", "slots", "queuesDir", "logsDir"].map((key) => `digest.${key}`),
    ...["seatsDir", "charterPath", "hardStopRepos.*", "agentChatBin", "hubSeat", "visualPacket", "visualSetCarry", "visualPacketProfile"].map((key) => `shepherd.${key}`),
    ...REVIEW_FIELDS.map((key) => `shepherd.review.${key}`),
    "shepherd.fixer.configDir", "shepherd.spawnGate.*", "shepherd.gateReset.*", "shepherd.deployAlarm.*", "shepherd.gateNotify.*",
    "shepherd.flakyChecks.*.checks", "shepherd.flakyChecks.*.waitSeconds", "shepherd.repos.*.*", "shepherd.visualDelivery.mode",
  ],
};

/** Permissions and autoMode as their rule texts, hooks as the commands they run; `env` and `apiKeyHelper` stay hidden. */
export const CLAUDE_SETTINGS_SURFACE: SurfaceSpec = {
  kind: "claude-settings",
  group: "claude",
  inventory: 14,
  format: "json",
  strictValues: true,
  safeFields: [
    "permissions.allow", "permissions.deny", "permissions.ask", "permissions.defaultMode", "permissions.additionalDirectories",
    "autoMode.allow", "autoMode.soft_deny", "autoMode.environment", "hooks.*", "model", "effortLevel", "enabledPlugins.*", "sandbox.**",
  ],
  projections: { "hooks.*": hookCommands },
};

/**
 * Folder trust, MCP servers and the OAuth account share this file, so it is never walked: only the
 * two fields named here are derived from it, and no other key, hidden or not, becomes a row.
 */
export const CLAUDE_JSON_SURFACE: SurfaceSpec = {
  kind: "claude-json",
  group: "claude",
  inventory: 15,
  format: "derived",
  safeFields: ["trustedFolders", "mcpServers"],
};

/** The home CLAUDE.md is prose, so it is never walked: only the per-repo worktree cap it states is derived, for drift. */
export const CLAUDE_MD_SURFACE: SurfaceSpec = {
  kind: "claude-md",
  group: "claude",
  inventory: 17,
  format: "derived",
  safeFields: ["worktreesPerRepo"],
};

/** `TITAN_CONSOLE_CODEWATCH_URL` is left out: a URL can carry a credential. */
export const CONSOLE_ENV_SURFACE: SurfaceSpec = {
  kind: "console-env",
  group: "console",
  inventory: 22,
  format: "env",
  safeFields: [
    "PORT", "STATE", "ACTIVE_WORK_PORT", "AGENT_CHAT_PORT", "FACTORY_PORT", "AGENT_CHAT_TOKEN", "EVENTS_DB", "SEATS", "SESSION_GRAPH",
    "HOST", "LAN_NAMES", "TLS_CERT", "TLS_KEY", "TOKEN", "OWNER_WRITES", "INBOX_DIR", "ROUNDS_DIR", "DECISIONS_FILE", "GATE_ANSWERS",
    "AUTONOMY_DIR", "CLAUDE_DIRS", "FACTORY_CONFIG",
  ].map((name) => `TITAN_CONSOLE_${name}`),
};
