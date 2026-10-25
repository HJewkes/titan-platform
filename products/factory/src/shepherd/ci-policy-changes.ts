import type { CiPolicyKey } from "@titan-design/session-read";

/** One changed `.github/` file read at the base and at the head; an absent side is the empty string. */
export interface CiPolicyFile {
  path: string;
  before: string;
  after: string;
}

/** The lines of one weakened key that the head removes from or adds to one file, already capped and stripped. */
export interface CiPolicyChange {
  path: string;
  key: CiPolicyKey;
  removed: string[];
  added: string[];
  /** Lines the per-file cap left out, so the card can send the owner to the diff for them. */
  omitted: number;
}

/** What the D21 owner card shows: the keys the reviewer named weakened and the lines read for them. */
export interface CiPolicyCard {
  keys: readonly CiPolicyKey[];
  changes: readonly CiPolicyChange[];
}

export const MAX_LINES_PER_FILE = 20;
export const MAX_LINE_CHARS = 160;

/** Every line is author-written and reaches the owner's prompt, so escape sequences and bidi overrides go before anything else. */
// eslint-disable-next-line no-control-regex -- ANSI sequences are exactly what the owner prompt must not render
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex -- control characters are exactly what a prompt line refuses
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Escapes and control characters go before any matcher reads the line, so neither can hide a line from the card. */
const cleanLine = (line: string): string => line.replace(ANSI_SEQUENCE, "").replace(/\t/g, "  ").replace(CONTROL, "").trimEnd();

/** Strips escapes and control characters, keeps the indent that shows YAML nesting, and cuts at `MAX_LINE_CHARS` with an ellipsis. */
export function shownLine(line: string): string {
  const flat = cleanLine(line);
  return flat.length <= MAX_LINE_CHARS ? flat : `${flat.slice(0, MAX_LINE_CHARS - 1)}…`;
}

const PERMISSION_LINE = /^\s*(?:-\s*)?(?:permissions\s*:|[\w-]+\s*:\s*(?:read|write|none)\s*(?:#.*)?$)/;
const SECRETS_LINE = /secrets\.|secrets\s*:\s*inherit/;
const NAME_LINE = /^\s*(?:-\s*)?name\s*:/;
const QUOTED = /"[^"]+"/;

/**
 * YAML breaks a line at CR, LF or CRLF, so a bare CR must split, never be stripped into a join that hides a line from
 * every matcher. NEL and the Unicode separators split too: a viewer may render them as breaks, and split, each piece
 * still carries the card's own prefix.
 */
const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/;

/** Above this many table cells the changed middle of a file reads as wholly changed, which shows more lines, never fewer. */
const MAX_DIFF_CELLS = 4_000_000;

const isRulesetPath = (path: string): boolean => /^\.github\/rulesets\//i.test(path);
const isRequiredChecksPath = (path: string): boolean => /^\.github\/required-checks\.json$/i.test(path);

const linesOf = (text: string): string[] => text.split(LINE_BREAK).map(cleanLine);

const indicesWhere = (lines: readonly string[], test: (line: string) => boolean): Set<number> => new Set(lines.flatMap((line, index) => (test(line) ? [index] : [])));

/** The job-id lines: the first indent level under a top-level `jobs:`, which ends at the next top-level key. */
function jobIdLines(lines: readonly string[]): Set<number> {
  const ids = new Set<number>();
  let indent: number | undefined;
  let inJobs = false;
  lines.forEach((line, index) => {
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const depth = line.length - line.trimStart().length;
    if (depth === 0) {
      inJobs = /^jobs\s*:\s*(?:#.*)?$/.test(line);
      indent = undefined;
      return;
    }
    if (!inJobs) return;
    indent ??= depth;
    if (depth === indent && /^\s*[\w-]+\s*:/.test(line)) ids.add(index);
  });
  return ids;
}

/** The indices of the lines that bear on `key`; `other` names none, so the owner reads that change in the diff. */
function keyLines(key: CiPolicyKey, path: string, lines: readonly string[]): Set<number> {
  switch (key) {
    case "permissions":
      return indicesWhere(lines, (line) => PERMISSION_LINE.test(line));
    case "pull_request_target":
      return indicesWhere(lines, (line) => line.includes("pull_request_target"));
    case "secrets":
      return indicesWhere(lines, (line) => SECRETS_LINE.test(line));
    case "ruleset":
      return isRulesetPath(path) ? indicesWhere(lines, (line) => line.trim() !== "") : new Set();
    case "required-check":
      return requiredCheckLines(path, lines);
    case "other":
      return new Set();
  }
}

function requiredCheckLines(path: string, lines: readonly string[]): Set<number> {
  if (isRequiredChecksPath(path)) return indicesWhere(lines, (line) => QUOTED.test(line));
  const ids = jobIdLines(lines);
  for (const index of indicesWhere(lines, (line) => NAME_LINE.test(line))) ids.add(index);
  return ids;
}

/** A trailing comma is list punctuation, so dropping the last entry of a JSON list does not move the entry before it; indent still counts, as YAML nests by it. */
const diffKey = (line: string): string => line.replace(/,$/, "");

/** Base indices the head removes and head indices it adds. */
interface LineEdits {
  removed: number[];
  added: number[];
}

const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from) }, (_, offset) => from + offset);

/**
 * A positional diff of whole files: the common prefix and suffix, then a longest-common-subsequence over the rest, so a
 * swapped, moved or repeated line still shows. Set membership would cancel a `read` and a `write` that trade places.
 */
function lineEdits(before: readonly string[], after: readonly string[]): LineEdits {
  const a = before.map(diffKey);
  const b = after.map(diffKey);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) [endA, endB] = [endA - 1, endB - 1];
  if ((endA - start + 1) * (endB - start + 1) > MAX_DIFF_CELLS) return { removed: range(start, endA), added: range(start, endB) };
  const middle = lcsEdits(a.slice(start, endA), b.slice(start, endB));
  return { removed: middle.removed.map((index) => index + start), added: middle.added.map((index) => index + start) };
}

function lcsEdits(a: readonly string[], b: readonly string[]): LineEdits {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const edits: LineEdits = { removed: [], added: [] };
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) [i, j] = [i + 1, j + 1];
    else if (j >= b.length || (i < a.length && at(i + 1, j) >= at(i, j + 1))) edits.removed.push((i += 1) - 1);
    else edits.added.push((j += 1) - 1);
  }
  return edits;
}

/** Spends one file's line budget in key order, removed lines first, so a long key cannot hide every other one. */
function capped(changes: CiPolicyChange[]): CiPolicyChange[] {
  let left = MAX_LINES_PER_FILE;
  const take = (lines: string[]): string[] => {
    const kept = lines.slice(0, Math.max(0, left));
    left -= kept.length;
    return kept;
  };
  return changes.map((change) => {
    const removed = take(change.removed);
    const added = take(change.added);
    return { ...change, removed, added, omitted: change.removed.length + change.added.length - removed.length - added.length };
  });
}

/** Each shown line names its 1-based line number on its own side, so two lines of the same text in different jobs stay apart. */
const numbered = (lines: readonly string[], indices: readonly number[], keyed: ReadonlySet<number>): string[] =>
  indices.filter((index) => keyed.has(index)).map((index) => shownLine(`L${index + 1}:${lines[index] ?? ""}`));

/**
 * The before→after lines of each weakened key in each file: a line the positional diff removes from the base is removed,
 * and one it adds at the head is added. A key with no such line in a file yields no entry for it.
 */
export function ciPolicyChanges(keys: readonly CiPolicyKey[], files: readonly CiPolicyFile[]): CiPolicyChange[] {
  return files.flatMap((file) => {
    const before = linesOf(file.before);
    const after = linesOf(file.after);
    const edits = lineEdits(before, after);
    const changes = keys.flatMap((key): CiPolicyChange[] => {
      const removed = numbered(before, edits.removed, keyLines(key, file.path, before));
      const added = numbered(after, edits.added, keyLines(key, file.path, after));
      return removed.length + added.length === 0 ? [] : [{ path: shownLine(file.path), key, removed, added, omitted: 0 }];
    });
    return capped(changes);
  });
}
