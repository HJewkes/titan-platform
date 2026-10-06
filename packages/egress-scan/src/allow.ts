import { compileGlobs, expandBraces } from "@titan-design/fix-proof";
import type { RuleId } from "./rules.js";

export type AllowableRule = Exclude<RuleId, "private-term">;

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
const TASK_ID = /\b[A-Z]+-\d+\b/;

// A glob made only of wildcard segments would allow a rule across the whole tree.
function hasLiteralSegment(glob: string): boolean {
  return glob.split("/").some((segment) => segment !== "" && !/[*?]/.test(segment));
}

// Every brace alternative must pass the guard: `{**,docs}/x.md` is fine, `{**,docs}/**` is not.
function alternativesOf(glob: string, line: number): string[] {
  try {
    return expandBraces(glob);
  } catch (error) {
    throw new AllowFileError(line, error instanceof Error ? error.message : "glob cannot be expanded");
  }
}

function parseEntry(entry: string, line: number): AllowEntry {
  const fields = /^(\S+)\s+(\S+)\s+(.+)$/.exec(entry);
  if (!fields) throw new AllowFileError(line, "expected <glob> <rule-id> <reason>");
  const [, glob = "", rule = "", reason = ""] = fields;
  if (rule === "private-term") throw new AllowFileError(line, "private-term is never allowable");
  if (!ALLOWABLE.includes(rule)) throw new AllowFileError(line, "unknown rule id");
  if (!TASK_ID.test(reason)) throw new AllowFileError(line, "reason must name a task id");
  if (!alternativesOf(glob, line).every(hasLiteralSegment)) throw new AllowFileError(line, "glob must name at least one literal path segment");
  return { glob, rule: rule as AllowableRule, line, matches: compileGlobs([glob]) };
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
  if (rule === "private-term") return false;
  return allow.entries.some((entry) => entry.rule === rule && entry.matches(path));
}
