import { z } from "zod";

/** Enough issues to fix the reply by, few enough that a reply in the wrong shape does not flood the run error. */
const MAX_ISSUES = 25;

/** The reply's outermost JSON object, so a reply wrapped in a code fence or a sentence still parses. */
export function replyObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

const isObject = (value: unknown): value is Record<PropertyKey, unknown> => typeof value === "object" && value !== null;

const valueAt = (raw: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), raw);

/** Deletes, in place, each key zod reports as unrecognized, and returns its dotted path. */
function stripUnknownKeys(raw: unknown, issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue) => {
    if (issue.code !== "unrecognized_keys") return [];
    const owner = valueAt(raw, issue.path);
    if (!isObject(owner)) return [];
    for (const key of issue.keys) Reflect.deleteProperty(owner, key);
    return issue.keys.map((key) => [...issue.path, key].join("."));
  });
}

const shown = (value: unknown): string => (value === undefined ? "nothing" : JSON.stringify(value)).slice(0, 80);

/** An out-of-enum value, the value the reply gave, and the values the schema allows, so a retry can pick one. */
function enumText(issue: z.core.$ZodIssueInvalidValue, raw: unknown, where = issue.path.join(".") || "(root)"): string {
  return `${where}: ${shown(valueAt(raw, issue.path))} is not one of ${issue.values.map(String).join(", ")}`;
}

/** Each issue as `path: message`; with the reply, an enum issue names the bad value and the allowed ones instead. */
export const issueText = (issues: readonly z.core.$ZodIssue[], raw?: unknown): string => {
  const line = (issue: z.core.$ZodIssue) =>
    raw !== undefined && issue.code === "invalid_value" ? enumText(issue, raw) : `${issue.path.join(".") || "(root)"}: ${issue.message}`;
  const lines = issues.slice(0, MAX_ISSUES).map(line);
  return [...lines, ...(issues.length > MAX_ISSUES ? [`and ${issues.length - MAX_ISSUES} more`] : [])].join("; ");
};

/** Where the path's innermost list index sits, or -1 when it has none. */
const listAt = (path: readonly PropertyKey[]): number => path.reduce<number>((at, key, i) => (typeof key === "number" ? i : at), -1);

/** The schema itself less the wrappers (optional, default, pipe) that say whether a value may be absent. */
function core(schema: z.core.$ZodType): z.core.$ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable) return core(schema.unwrap());
  return schema instanceof z.ZodPipe ? core(schema.in) : schema;
}

/** The schema a path into a value is parsed with; undefined past a union or anything else not walked here. */
function schemaAt(schema: z.core.$ZodType, path: readonly PropertyKey[]): z.core.$ZodType | undefined {
  if (path.length === 0) return schema;
  const inner = core(schema);
  const next = inner instanceof z.ZodObject ? inner.shape[String(path[0])] : inner instanceof z.ZodArray ? inner.element : undefined;
  return next && schemaAt(next, path.slice(1));
}

const omittable = (schema: z.core.$ZodType | undefined): boolean => schema?._zod.optin !== undefined;

type Fix = { owner: Record<PropertyKey, unknown>; key: PropertyKey } | { list: unknown[]; index: number };

/**
 * A bad enum value's deterministic fix: an optional field loses its key, and a required one inside an item of an
 * optional list (a chip's kind) loses the item. Undefined for anything else: a required field goes to the retry.
 */
function enumFix(schema: z.core.$ZodType, raw: unknown, path: readonly PropertyKey[]): Fix | undefined {
  const owner = valueAt(raw, path.slice(0, -1));
  if (omittable(schemaAt(schema, path)) && isObject(owner) && !Array.isArray(owner)) return { owner, key: path.at(-1)! };
  const at = listAt(path);
  if (at < 0 || at < path.length - 2) return undefined;
  const [list, index] = [valueAt(raw, path.slice(0, at)), path[at]];
  return omittable(schemaAt(schema, path.slice(0, at))) && Array.isArray(list) && typeof index === "number" ? { list, index } : undefined;
}

/** Drops each fix's key or item; a list's items go last first, so an earlier index still names its item. */
function applyFixes(fixes: readonly Fix[]): void {
  const lists = new Map<unknown[], Set<number>>();
  for (const fix of fixes) {
    if ("owner" in fix) Reflect.deleteProperty(fix.owner, fix.key);
    else lists.set(fix.list, (lists.get(fix.list) ?? new Set()).add(fix.index));
  }
  for (const [list, indexes] of lists) for (const index of [...indexes].sort((x, y) => y - x)) list.splice(index, 1);
}

interface Repair {
  /** Keys the schema does not allow, by dotted path. */
  stripped: string[];
  /** Per out-of-enum value, what was dropped and why. */
  dropped: string[];
}

/**
 * Applies, in place, a fix for every issue when each one has a deterministic fix: an unknown key is deleted, and an
 * out-of-enum value is dropped by `enumFix`. When any issue has none, the reply is left as it was and undefined returned.
 */
export function repairReply(schema: z.core.$ZodType, raw: unknown, issues: readonly z.core.$ZodIssue[]): Repair | undefined {
  const bad = issues.filter((issue): issue is z.core.$ZodIssueInvalidValue => issue.code === "invalid_value");
  if (!issues.every((issue) => issue.code === "unrecognized_keys" || issue.code === "invalid_value")) return undefined;
  const fixes = bad.map((issue) => enumFix(schema, raw, issue.path)).filter((fix): fix is Fix => fix !== undefined);
  if (fixes.length < bad.length) return undefined;
  const dropped = bad.map((issue, i) => dropNote(issue, fixes[i]!, raw));
  const stripped = stripUnknownKeys(raw, issues);
  applyFixes(fixes);
  return { stripped, dropped };
}

/** "dropped <the key or item>", then the bad value under it, e.g. `dropped beats.0.visual.chips.1: kind: "x" is not one of ...`. */
function dropNote(issue: z.core.$ZodIssueInvalidValue, fix: Fix, raw: unknown): string {
  const drop = "list" in fix ? issue.path.slice(0, listAt(issue.path) + 1) : issue.path;
  const under = issue.path.slice(drop.length).join(".");
  return under ? `dropped ${drop.join(".")}: ${enumText(issue, raw, under)}` : `dropped ${enumText(issue, raw)}`;
}
