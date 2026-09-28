import type { RuleId } from "./rules.js";

export type AllowableRule = Exclude<RuleId, "private-term">;

export interface AllowEntry {
  readonly glob: string;
  readonly rule: AllowableRule;
  readonly line: number;
  readonly pattern: RegExp;
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

/** Anchored glob over repo-relative paths: `**` spans directories, `*` and `?` stay within one. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? "";
    if (glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function parseEntry(entry: string, line: number): AllowEntry {
  const fields = /^(\S+)\s+(\S+)\s+(.+)$/.exec(entry);
  if (!fields) throw new AllowFileError(line, "expected <glob> <rule-id> <reason>");
  const [, glob = "", rule = "", reason = ""] = fields;
  if (rule === "private-term") throw new AllowFileError(line, "private-term is never allowable");
  if (!ALLOWABLE.includes(rule)) throw new AllowFileError(line, "unknown rule id");
  if (!TASK_ID.test(reason)) throw new AllowFileError(line, "reason must name a task id");
  return { glob, rule: rule as AllowableRule, line, pattern: globToRegExp(glob) };
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
  return allow.entries.some((entry) => entry.rule === rule && entry.pattern.test(path));
}
