import { z } from "zod";
import { LineCounter, isMap, isScalar, parseDocument, type Node, type Pair } from "yaml";
import { readCommand } from "../owner-guard.js";

export const SURFACE_GROUPS = ["coordinator"] as const;
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
  format: "frontmatter" | "json";
  safeFields: readonly string[];
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

const configRow = z.object({
  surface: z.string(),
  file: z.string(),
  field: z.string(),
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

export const configSurfacesResult = z.object({ files: z.array(configFile), rows: z.array(configRow), gaps: z.array(z.string()) });

export type ConfigRow = z.infer<typeof configRow>;
export type ConfigFile = z.infer<typeof configFile>;
export type ConfigSurfaces = z.infer<typeof configSurfacesResult>;

type FieldPath = readonly string[];
type Placement = "show" | "descend" | "hide";

interface Walk {
  surface: string;
  file: string;
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

function placement(patterns: readonly FieldPath[], path: FieldPath, value: unknown): Placement {
  if (isMap(value)) {
    if (patterns.some((pattern) => !isDeep(pattern) && covers(pattern, path))) return "show";
    return patterns.some((pattern) => reachesBelow(pattern, path)) ? "descend" : "hide";
  }
  return patterns.some((pattern) => covers(pattern, path)) ? "show" : "hide";
}

function decisionsIn(comment: string | undefined): string[] {
  return comment === undefined ? [] : [...comment.matchAll(/\bdecisions?\s+#?(\d+)/gi)].map((match) => match[1] as string);
}

function shown(value: Node | null): Pick<ConfigRow, "value" | "comment" | "decisions"> {
  const comment = value !== null && !isMap(value) ? value.comment?.trim() || undefined : undefined;
  return { value: value === null ? null : (value.toJSON() as unknown), ...(comment === undefined ? {} : { comment }), decisions: decisionsIn(comment) };
}

function visitPair(pair: Pair<unknown, unknown>, path: FieldPath, walk: Walk): void {
  const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
  const field = [...path, key];
  const value = (pair.value ?? null) as Node | null;
  const where = placement(walk.patterns, field, value);
  if (where === "descend" && isMap(value) && value.items.length > 0) {
    for (const child of value.items) visitPair(child, field, walk);
    return;
  }
  const offset = isScalar(pair.key) ? (pair.key.range?.[0] ?? 0) : 0;
  const line = walk.lines.linePos(offset).line + walk.lineOffset;
  const base = { surface: walk.surface, file: walk.file, field: field.join("."), line };
  walk.rows.push(where === "hide" ? { ...base, hidden: true, decisions: [] } : { ...base, hidden: false, ...shown(value) });
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
  const body = spec.format === "frontmatter" ? frontMatter(text) : { text, lineOffset: 0 };
  if (body === null) return { rows: [], gaps: [`${file}: no front matter`] };
  const lines = new LineCounter();
  const doc = parseDocument(body.text, { lineCounter: lines, prettyErrors: false });
  const [error] = doc.errors;
  if (error !== undefined) return { rows: [], gaps: [`${file}: not valid ${spec.format} (${error.code} at line ${lines.linePos(error.pos[0]).line + body.lineOffset})`] };
  if (!isMap(doc.contents)) return { rows: [], gaps: [`${file}: the top level is not a map`] };
  const walk: Walk = { surface, file, patterns: spec.safeFields.map((field) => field.split(".")), lines, lineOffset: body.lineOffset, rows: [] };
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
      run: async () => {
        const answers = await Promise.all(readers.map((read) => read()));
        return { files: answers.flatMap((answer) => answer.files), rows: answers.flatMap((answer) => answer.rows), gaps: answers.flatMap((answer) => answer.gaps) };
      },
    }),
  };
}
