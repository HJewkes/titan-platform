import { compileGlobs, expandBraces } from "@titan-design/fix-proof";
import type { RuleId } from "./rules.js";

export type AllowableRule = Exclude<RuleId, "private-term" | "credential-token">;

export interface AllowEntry {
  readonly glob: string;
  readonly rule: AllowableRule;
  readonly line: number;
  readonly matches: (path: string) => boolean;
}

export interface AllowList {
  readonly entries: readonly AllowEntry[];
}

export const EMPTY_ALLOW: AllowList = { entries: [] };

/** A malformed `.egress-allow`. Callers must fail the scan on it, never treat the file as empty. */
export class AllowFileError extends Error {
  constructor(
    readonly line: number,
    reason: string,
  ) {
    super(`.egress-allow line ${line}: ${reason}`);
    this.name = "AllowFileError";
  }
}

const ALLOWABLE: readonly string[] = ["home-path", "aw-data-path"];
// A credential in a pushed file is a leak wherever it sits; fixtures build theirs at runtime.
const NEVER_ALLOWABLE: readonly string[] = ["private-term", "credential-token"];
const TASK_ID = /\b[A-Z]+-\d+\b/;

// A glob made only of wildcard segments would allow a rule across the whole tree.
function hasLiteralSegment(glob: string): boolean {
  return glob.split("/").some((segment) => segment !== "" && !/[*?]/.test(segment));
}

// Every brace alternative must pass the guard: `{**,docs}/x.md` is fine, `{**,docs}/**` is not.
// Expansion and compilation share one try so no raw RangeError or Error escapes parseAllow.
function compileEntry(glob: string, line: number): (path: string) => boolean {
  try {
    if (!expandBraces(glob).every(hasLiteralSegment)) {
      throw new AllowFileError(line, "glob must name at least one literal path segment");
    }
    return compileGlobs([glob]);
  } catch (error) {
    if (error instanceof AllowFileError) throw error;
    throw new AllowFileError(line, error instanceof Error ? error.message : "glob cannot be compiled");
  }
}

function parseEntry(entry: string, line: number): AllowEntry {
  const fields = /^(\S+)\s+(\S+)\s+(.+)$/.exec(entry);
  if (!fields) throw new AllowFileError(line, "expected <glob> <rule-id> <reason>");
  const [, glob = "", rule = "", reason = ""] = fields;
  if (NEVER_ALLOWABLE.includes(rule)) throw new AllowFileError(line, `${rule} is never allowable`);
  if (!ALLOWABLE.includes(rule)) throw new AllowFileError(line, "unknown rule id");
  if (!TASK_ID.test(reason)) throw new AllowFileError(line, "reason must name a task id");
  return { glob, rule: rule as AllowableRule, line, matches: compileEntry(glob, line) };
}

export function parseAllow(text: string): AllowList {
  const entries: AllowEntry[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const entry = raw.trim();
    if (entry === "" || entry.startsWith("#")) return;
    entries.push(parseEntry(entry, i + 1));
  });
  return { entries };
}

export function isAllowed(allow: AllowList, path: string, rule: RuleId): boolean {
  if (NEVER_ALLOWABLE.includes(rule)) return false;
  return allow.entries.some((entry) => entry.rule === rule && entry.matches(path));
}
