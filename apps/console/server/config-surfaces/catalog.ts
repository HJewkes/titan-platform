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
