import { z } from "zod";
import { LineCounter, isMap, isNode, isScalar, parseDocument, type Node, type Pair } from "yaml";
import { readCommand } from "../owner-guard.js";

const SURFACE_GROUPS = ["coordinator", "agent-chat", "factory", "console", "claude"] as const;
type SurfaceGroup = (typeof SURFACE_GROUPS)[number];

/**
 * One kind of config file. `safeFields` is an allowlist: a path segment `*` stands for any one key
 * and `**` for any run of keys. A key no pattern reaches is listed hidden, with no value and no
 * comment, so a secret added to any file later never reaches a response by default.
 */
export interface SurfaceSpec {
  kind: string;
  group: SurfaceGroup;
  /** The surface's row number in the TP-3579 inventory. */
  inventory: number;
  /** `derived` and `env` surfaces are never walked; their readers build the named rows themselves. */
  format: "frontmatter" | "json" | "derived" | "env";
  safeFields: readonly string[];
  /**
   * A shown value must be a scalar or a list of scalars, else it is listed hidden: a map or a list
   * of maps under an allowed key could carry keys no pattern names.
   */
  strictValues?: boolean;
  /** Per `safeFields` entry, what to show instead of the raw value; its output is built only from the parts it names. */
  projections?: Readonly<Record<string, (value: unknown) => unknown>>;
}

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

export const CHARTER_SURFACE: SurfaceSpec = {
  kind: "charter",
  group: "coordinator",
  inventory: 1,
  format: "frontmatter",
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
  safeFields: [
    "schema", "name", "prefix", "role", "attended", "pool", "overflow_pool", "config_dir", "concurrency.*", "spend.*", "share_caps.*", "kind_weights.*",
    "initiatives.*", "scope_tags", "excluded_tags", "grants_extra", "repos", "heartbeat_cron", "surface", "model", "effort", "profile",
  ],
};

export const BURNDOWN_SURFACE: SurfaceSpec = {
  kind: "burndown",
  group: "coordinator",
  inventory: 9,
  format: "json",
  safeFields: ["enabled", "reportTo", "seats", "maxAgents", "maxWorktreesPerRepo", "briefGate.**", "handReserve.**"],
};

/** Only the owner switches; the runtime readings beside them are listed hidden. */
export const SEAT_WATCHDOG_SURFACE: SurfaceSpec = {
  kind: "seat-watchdog",
  group: "coordinator",
  inventory: 10,
  format: "json",
  safeFields: ["stopped.**", "held.**", "attended.**"],
};

/** Machine limits and switches;`machines`, `hostProof` and anything new stay hidden until named here. */
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

const configRow = z.object({
  surface: z.string(),
  file: z.string(),
  field: z.string(),
  /** 0 for a row with no line of its own: an environment variable or a count derived from the whole file. */
  line: z.number().int(),
  hidden: z.boolean(),
  value: z.unknown().optional(),
  /** The inline comment on the value's line, today's only change history in the seat files. */
  comment: z.string().optional(),
  /** Decision numbers the comment names. */
  decisions: z.array(z.string()),
});

const configFile = z.object({
  surface: z.string(),
  kind: z.string(),
  group: z.enum(SURFACE_GROUPS),
  inventory: z.number().int(),
  file: z.string(),
  mtime: z.string(),
  /** The newest `<name>.bak*` sibling, by name, the hand backups' only record of a change. */
  newestBackup: z.string().nullable(),
});

const configSurfacesResult = z.object({ files: z.array(configFile), rows: z.array(configRow), gaps: z.array(z.string()) });

export type ConfigRow = z.infer<typeof configRow>;
export type ConfigFile = z.infer<typeof configFile>;
export type ConfigSurfaces = z.infer<typeof configSurfacesResult>;

export const EMPTY_SURFACES: ConfigSurfaces = { files: [], rows: [], gaps: [] };

export function joinSurfaces(answers: readonly ConfigSurfaces[]): ConfigSurfaces {
  return { files: answers.flatMap((answer) => answer.files), rows: answers.flatMap((answer) => answer.rows), gaps: answers.flatMap((answer) => answer.gaps) };
}

type FieldPath = readonly string[];
type Placement = "show" | "descend" | "hide";

interface Walk {
  surface: string;
  file: string;
  spec: SurfaceSpec;
  patterns: readonly FieldPath[];
  lines: LineCounter;
  lineOffset: number;
  rows: ConfigRow[];
}

const keyMatches = (segment: string | undefined, key: string): boolean => segment === "*" || segment === key;
const isDeep = (pattern: FieldPath): boolean => pattern.at(-1) === "**";

function prefixMatches(pattern: FieldPath, path: FieldPath): boolean {
  return path.every((key, index) => keyMatches(pattern[index], key));
}

/** A `**` pattern covers its prefix and everything under it; any other pattern names one path. */
function covers(pattern: FieldPath, path: FieldPath): boolean {
  const fixed = isDeep(pattern) ? pattern.slice(0, -1) : pattern;
  if (isDeep(pattern)) return path.length >= fixed.length && prefixMatches(fixed, path.slice(0, fixed.length));
  return fixed.length === path.length && prefixMatches(fixed, path);
}

/** Whether some pattern names a key below `path`, so a map there is walked rather than shown whole. */
function reachesBelow(pattern: FieldPath, path: FieldPath): boolean {
  const fixed = isDeep(pattern) ? pattern.slice(0, -1) : pattern;
  if (isDeep(pattern) && path.length >= fixed.length) return prefixMatches(fixed, path.slice(0, fixed.length));
  return fixed.length > path.length && prefixMatches(fixed, path);
}

/** Under `strictValues` a map that some pattern reaches into is walked even when another names it whole, since it could only be shown hidden. */
function placement(patterns: readonly FieldPath[], path: FieldPath, value: unknown, strict: boolean): Placement {
  if (isMap(value)) {
    const below = patterns.some((pattern) => reachesBelow(pattern, path));
    if (strict && below) return "descend";
    if (patterns.some((pattern) => !isDeep(pattern) && covers(pattern, path))) return "show";
    return below ? "descend" : "hide";
  }
  return patterns.some((pattern) => covers(pattern, path)) ? "show" : "hide";
}

function decisionsIn(comment: string | undefined): string[] {
  return comment === undefined ? [] : [...comment.matchAll(/\bdecisions?\s+#?(\d+)/gi)].flatMap((match) => match[1] ?? []);
}

const isLeaf = (value: unknown): boolean => value === null || typeof value !== "object";
const isFlat = (value: unknown): boolean => isLeaf(value) || (Array.isArray(value) && value.every(isLeaf));

/** The value to show at `field`, or undefined when the spec's projections and value rule keep it hidden. */
function shownValue(walk: Walk, field: FieldPath, value: Node | null): { value: unknown } | undefined {
  const raw = value === null ? null : (value.toJSON() as unknown);
  const projected = Object.entries(walk.spec.projections ?? {}).find(([pattern]) => covers(pattern.split("."), field));
  if (projected !== undefined) return { value: projected[1](raw) };
  return walk.spec.strictValues === true && !isFlat(raw) ? undefined : { value: raw };
}

function shown(walk: Walk, field: FieldPath, value: Node | null): Pick<ConfigRow, "value" | "comment" | "decisions"> | undefined {
  const picked = shownValue(walk, field, value);
  if (picked === undefined) return undefined;
  const comment = value !== null && !isMap(value) ? value.comment?.trim() || undefined : undefined;
  return { ...picked, ...(comment === undefined ? {} : { comment }), decisions: decisionsIn(comment) };
}

function visitPair(pair: Pair<unknown, unknown>, path: FieldPath, walk: Walk): void {
  const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
  const field = [...path, key];
  const value = isNode(pair.value) ? pair.value : null;
  const where = placement(walk.patterns, field, value, walk.spec.strictValues === true);
  if (where === "descend" && isMap(value) && value.items.length > 0) {
    for (const child of value.items) visitPair(child, field, walk);
    return;
  }
  const offset = isScalar(pair.key) ? (pair.key.range?.[0] ?? 0) : 0;
  const line = walk.lines.linePos(offset).line + walk.lineOffset;
  const base = { surface: walk.surface, file: walk.file, field: field.join("."), line };
  const visible = where === "hide" ? undefined : shown(walk, field, value);
  walk.rows.push(visible === undefined ? { ...base, hidden: true, decisions: [] } : { ...base, hidden: false, ...visible });
}

function frontMatter(text: string): { text: string; lineOffset: number } | null {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  return end < 0 ? null : { text: lines.slice(1, end).join("\n"), lineOffset: 1 };
}

/**
 * Lists every top-level and allowed nested key of one file as a row. A parse failure names only
 * the error code and line: the parser's own message quotes the source, which may hold a secret.
 */
export function surfaceRows(spec: SurfaceSpec, surface: string, file: string, text: string): { rows: ConfigRow[]; gaps: string[] } {
  if (spec.format === "derived" || spec.format === "env") return { rows: [], gaps: [`${file}: ${spec.kind} is never walked`] };
  const body = spec.format === "frontmatter" ? frontMatter(text) : { text, lineOffset: 0 };
  if (body === null) return { rows: [], gaps: [`${file}: no front matter`] };
  const lines = new LineCounter();
  const doc = parseDocument(body.text, { lineCounter: lines, prettyErrors: false });
  const [error] = doc.errors;
  if (error !== undefined) return { rows: [], gaps: [`${file}: not valid ${spec.format} (${error.code} at line ${lines.linePos(error.pos[0]).line + body.lineOffset})`] };
  if (!isMap(doc.contents)) return { rows: [], gaps: [`${file}: the top level is not a map`] };
  const walk: Walk = { surface, file, spec, patterns: spec.safeFields.map((field) => field.split(".")), lines, lineOffset: body.lineOffset, rows: [] };
  for (const pair of doc.contents.items) visitPair(pair, [], walk);
  return { rows: walk.rows, gaps: [] };
}

/** One host's files of one group; `config.surfaces` concatenates every reader's answer. */
export type SurfaceReader = () => Promise<ConfigSurfaces>;

/** A reader the daemon was given no source for, so the page says so instead of showing an empty host. */
export function unconfigured(name: string): SurfaceReader {
  return () => Promise.resolve({ files: [], rows: [], gaps: [`${name}: not configured`] });
}

export function configSurfacesCommands(readers: readonly SurfaceReader[]) {
  return {
    "config.surfaces": readCommand({
      name: "config.surfaces",
      description: "Every fleet config field the catalog declares safe, with its value, file, line and inline-comment provenance; undeclared keys are listed hidden",
      args: z.object({}),
      result: configSurfacesResult,
      run: async () => joinSurfaces(await Promise.all(readers.map((read) => read()))),
    }),
  };
}
