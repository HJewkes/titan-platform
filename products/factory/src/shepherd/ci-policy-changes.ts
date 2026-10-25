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
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

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

const isRulesetPath = (path: string): boolean => /^\.github\/rulesets\//i.test(path);
const isRequiredChecksPath = (path: string): boolean => /^\.github\/required-checks\.json$/i.test(path);

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

/** The lines of `text` that bear on `key`; `other` names nothing, so the owner reads that change in the diff. */
function keyLines(key: CiPolicyKey, path: string, text: string): string[] {
  const lines = text.split(/\r?\n/).map(cleanLine);
  switch (key) {
    case "permissions":
      return lines.filter((line) => PERMISSION_LINE.test(line));
    case "pull_request_target":
      return lines.filter((line) => line.includes("pull_request_target"));
    case "secrets":
      return lines.filter((line) => SECRETS_LINE.test(line));
    case "ruleset":
      return isRulesetPath(path) ? lines.filter((line) => line.trim() !== "") : [];
    case "required-check":
      return requiredCheckLines(path, lines);
    case "other":
      return [];
  }
}

function requiredCheckLines(path: string, lines: readonly string[]): string[] {
  if (isRequiredChecksPath(path)) return lines.filter((line) => QUOTED.test(line));
  const ids = jobIdLines(lines);
  return lines.filter((line, index) => ids.has(index) || NAME_LINE.test(line));
}

/** A trailing comma is list punctuation, so dropping the last entry of a JSON list does not move the entry before it; indent still counts, as YAML nests by it. */
const diffKey = (line: string): string => line.replace(/,$/, "");

function lineDiff(before: readonly string[], after: readonly string[]): { removed: string[]; added: string[] } {
  const kept = new Set(after.map(diffKey));
  const had = new Set(before.map(diffKey));
  return { removed: before.filter((line) => !kept.has(diffKey(line))), added: after.filter((line) => !had.has(diffKey(line))) };
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

/**
 * The before→after lines of each weakened key in each file: a line in the base and not the head is removed, and the
 * reverse is added. A key whose lines did not change in a file yields no entry for it.
 */
export function ciPolicyChanges(keys: readonly CiPolicyKey[], files: readonly CiPolicyFile[]): CiPolicyChange[] {
  return files.flatMap((file) => {
    const changes = keys.flatMap((key): CiPolicyChange[] => {
      const { removed, added } = lineDiff(keyLines(key, file.path, file.before), keyLines(key, file.path, file.after));
      return removed.length + added.length === 0 ? [] : [{ path: shownLine(file.path), key, removed: removed.map(shownLine), added: added.map(shownLine), omitted: 0 }];
    });
    return capped(changes);
  });
}
