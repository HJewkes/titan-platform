import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { CI_POLICY_KEYS, type CiPolicyKey } from "@titan-design/session-read";
import { z } from "zod";
import { statusOf } from "../required-checks.js";

/** The PR author writes these lines, and they reach the owner's prompt, so each is bounded and stripped of control characters. */
export const MAX_LINES_PER_FILE = 20;
export const MAX_LINE_CHARS = 160;

interface CiPolicyFile {
  path: string;
  /** The file at the base; empty when it is absent there. */
  before: string;
  /** The file at the head; empty when it is absent there. */
  after: string;
}

/** The lines matching one weakened key in one file: in base and not head (`removed`), or the other way round (`added`). */
export interface CiPolicyChange {
  path: string;
  key: CiPolicyKey;
  removed: string[];
  added: string[];
  /** Lines past the per-file cap, dropped from this change. */
  omitted?: number;
}

export const CiPolicyChangeSchema = z.strictObject({
  path: z.string(),
  key: z.enum(CI_POLICY_KEYS),
  removed: z.array(z.string()),
  added: z.array(z.string()),
  omitted: z.number().int().positive().optional(),
});

type LineMatcher = (path: string, lines: readonly string[]) => string[];

const ACCESS_LINE = /^\s*[\w-]+\s*:\s*(read|write|none)\s*(#.*)?$/;

const matchingLines = (test: (line: string) => boolean): LineMatcher => (_path, lines) => lines.filter(test);

/** `other` has no matcher: the owner reads that change in the diff. */
const MATCHERS: Readonly<Record<CiPolicyKey, LineMatcher | undefined>> = {
  permissions: matchingLines((line) => /^\s*permissions\s*:/.test(line) || ACCESS_LINE.test(line)),
  pull_request_target: matchingLines((line) => line.includes("pull_request_target")),
  secrets: matchingLines((line) => line.includes("secrets.") || /secrets\s*:\s*inherit\b/.test(line)),
  "required-check": requiredCheckLines,
  ruleset: (path, lines) => (/^\.github\/rulesets\//i.test(path) ? [...lines] : []),
  other: undefined,
};

function requiredCheckLines(path: string, lines: readonly string[]): string[] {
  if (/^\.github\/required-checks\.json$/i.test(path)) return lines.filter((line) => /"[^"]+"/.test(line));
  if (!/^\.github\/workflows\//i.test(path)) return [];
  const jobIds = jobIdLines(lines);
  return lines.filter((line, at) => /^\s*-?\s*name\s*:/.test(line) || jobIds.has(at));
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** A job id is a bare key one level under the top-level `jobs:`, at the indent of the first key there. */
function jobIdLines(lines: readonly string[]): Set<number> {
  const ids = new Set<number>();
  let inJobs = false;
  let jobIndent: number | undefined;
  lines.forEach((line, at) => {
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    if (/^\S/.test(line)) {
      inJobs = /^jobs\s*:\s*$/.test(line);
      jobIndent = undefined;
      return;
    }
    if (!inJobs) return;
    jobIndent ??= indentOf(line);
    if (indentOf(line) === jobIndent && /^\s+[\w-]+\s*:\s*$/.test(line)) ids.add(at);
  });
  return ids;
}

/** Each line counts once per occurrence, so dropping one of two equal lines still shows as removed. */
function multisetMinus(from: readonly string[], minus: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const line of minus) left.set(line, (left.get(line) ?? 0) + 1);
  return from.filter((line) => {
    const count = left.get(line) ?? 0;
    if (count > 0) left.set(line, count - 1);
    return count === 0;
  });
}

// eslint-disable-next-line no-control-regex -- terminal escape sequences are exactly what the owner's prompt refuses
const ESCAPE_SEQUENCE = /\u001b(\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(\u0007|\u001b\\)|[@-_])/g;
// eslint-disable-next-line no-control-regex -- C0, C1 and the bidi and zero-width format characters that can disguise a line
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const cleanLine = (line: string): string => line.replace(ESCAPE_SEQUENCE, "").replace(CONTROL, "").trimEnd();

/** Strips escape sequences and control characters, then cuts the line at `MAX_LINE_CHARS` with an ellipsis. */
export function shownLine(line: string): string {
  const clean = cleanLine(line);
  return clean.length <= MAX_LINE_CHARS ? clean : `${clean.slice(0, MAX_LINE_CHARS - 1)}…`;
}

/** Matchers read cleaned lines, so a carriage return or escape planted in a line cannot hide it from its key. */
const linesOf = (text: string): string[] => (text === "" ? [] : text.split(/\r?\n/).map(cleanLine));

function fileChanges(keys: readonly CiPolicyKey[], file: CiPolicyFile): CiPolicyChange[] {
  const before = linesOf(file.before);
  const after = linesOf(file.after);
  return keys.flatMap((key) => {
    const matcher = MATCHERS[key];
    if (!matcher) return [];
    const was = matcher(file.path, before);
    const now = matcher(file.path, after);
    const change = { path: shownLine(file.path), key, removed: multisetMinus(was, now), added: multisetMinus(now, was) };
    return change.removed.length + change.added.length > 0 ? [change] : [];
  });
}

/** One file's changes share `MAX_LINES_PER_FILE`, removed lines first; each change counts what it dropped. */
function capped(changes: readonly CiPolicyChange[]): CiPolicyChange[] {
  let room = MAX_LINES_PER_FILE;
  return changes.map((change) => {
    const removed = change.removed.slice(0, room);
    room -= removed.length;
    const added = change.added.slice(0, room);
    room -= added.length;
    const omitted = change.removed.length + change.added.length - removed.length - added.length;
    return { ...change, removed: removed.map(shownLine), added: added.map(shownLine), ...(omitted > 0 && { omitted }) };
  });
}

/** The before→after lines of exactly the weakened keys in each file, read by code from base and head, never from the reviewer. */
export function ciPolicyChanges(keys: readonly CiPolicyKey[], files: readonly CiPolicyFile[]): CiPolicyChange[] {
  return files.flatMap((file) => capped(fileChanges(keys, file)));
}

/** At most this many `.github/` files are read for the D21 card; the rest are named as unread, and the owner reads them in the diff. */
const MAX_CARD_FILES = 10;

export interface CiPolicyChangesRead {
  changes: CiPolicyChange[];
  /** The files whose lines could not be read, as unread facts; their lines are left off the card. */
  unread: string[];
}

interface PrAt {
  repo: RepoSlug;
  head: string;
}

/** Reads each changed `.github/` file at the base branch and at the head; a failed read never stops the weakened gate opening. */
export async function readCiPolicyChanges(port: GitHubPort, at: PrAt, baseRef: string, keys: readonly CiPolicyKey[], githubPaths: readonly string[]): Promise<CiPolicyChangesRead> {
  const read = githubPaths.slice(0, MAX_CARD_FILES);
  const reads = await Promise.all(read.map((path) => cardFile(port, at.repo, path, baseRef, at.head)));
  const files = reads.filter((file): file is CiPolicyFile => !("unread" in file));
  const unread = reads.flatMap((file) => ("unread" in file ? [file.unread] : []));
  const skipped = githubPaths.length - read.length;
  if (skipped > 0) unread.push(`the CI-policy lines of ${skipped} more .github/ files were not read (cap ${MAX_CARD_FILES})`);
  return { changes: ciPolicyChanges(keys, files), unread };
}

async function cardFile(port: GitHubPort, repo: RepoSlug, path: string, baseRef: string, head: string): Promise<CiPolicyFile | { unread: string }> {
  try {
    const [before, after] = await Promise.all([port.getFile(repo, path, baseRef), port.getFile(repo, path, head)]);
    return { path, before: before?.content ?? "", after: after?.content ?? "" };
  } catch (error) {
    return { unread: `the CI-policy lines of ${shownLine(path)} are unreadable: ${statusOf(error)}` };
  }
}
