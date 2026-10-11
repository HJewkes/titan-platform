import { locateTokens, type TokenKind } from "./tokens.js";

export type RuleId = "home-path" | "aw-data-path" | "private-term" | "credential-token";

export const RULE_IDS: readonly RuleId[] = ["home-path", "aw-data-path", "private-term", "credential-token"];

/** A compiled private term. It exposes its line number, never its text or pattern. */
export interface TermRule {
  readonly index: number;
  matches(text: string): boolean;
  /** Offset of the first match, or -1. Optional so a bare matcher still works; a hit then reports column 1. */
  search?(text: string): number;
}

export interface RuleHit {
  readonly rule: RuleId;
  readonly termIndex?: number;
  readonly kind?: TokenKind;
}

/** Home-directory segments that are placeholders, not people. Compared case-insensitively. */
export const PLACEHOLDER_SEGMENTS: readonly string[] = [
  "Shared",
  "runner",
  "you",
  "your-name",
  "user",
  "username",
  "me",
  "example",
  "name",
  "x",
  "alice",
  "bob",
];

// One path separator: slash, backslash, or the JSON-escaped form of either.
const SEP = String.raw`(?:\\\\|\\/|/|\\)`;
const SEGMENT = String.raw`([^/\\\s"'\`),;\]]+)`;
const USERS = "[Uu][Ss][Ee][Rr][Ss]";
// A root must start a path; after `file://` any host may precede it.
const PATH_START = String.raw`(?:(?<![\w.-])|(?<=file://[^/\s"'\`]*))`;
const HOME_ROOT = String.raw`(?:${PATH_START}${SEP}(?:${USERS}|[Hh][Oo][Mm][Ee])|(?<!\w)[A-Za-z]:${SEP}${USERS})`;
const HOME_PATH = new RegExp(`${HOME_ROOT}${SEP}${SEGMENT}`, "g");

const SPACE = String.raw`(?: |%20|\\ )`;
const AW_DATA_ROOTS = [`Library${SEP}Application${SPACE}Support`, String.raw`\.local${SEP}share`, `AppData${SEP}Local`];
// The single definition of the active-work data directory shapes; narrow it here and nowhere else.
const AW_DATA_PATH = new RegExp(`(?:${AW_DATA_ROOTS.join("|")})${SEP}active-work(?!\\w)`, "i");

const PLACEHOLDER_SET = new Set(PLACEHOLDER_SEGMENTS.map((s) => s.toLowerCase()));

function isPlaceholder(rawSegment: string): boolean {
  const segment = rawSegment.replace(/[.:]+$/, "");
  if (segment === "") return true;
  if (/^<.*>$/.test(segment) || /^\{.*\}$/.test(segment) || segment.startsWith("$")) return true;
  return PLACEHOLDER_SET.has(segment.toLowerCase());
}

/** Offset of the first home path that is not a placeholder, or -1. */
export function homePathIndex(text: string): number {
  for (const match of text.matchAll(HOME_PATH)) {
    if (!isPlaceholder(match[1] ?? "")) return match.index;
  }
  return -1;
}

export function matchesHomePath(text: string): boolean {
  return homePathIndex(text) >= 0;
}

export function matchesAwDataPath(text: string): boolean {
  return AW_DATA_PATH.test(text);
}

/** Like `matchRules`, with the 0-based offset of each hit in `text`. */
export function locateRules(text: string, terms: readonly TermRule[] = []): (RuleHit & { readonly offset: number })[] {
  const hits: (RuleHit & { readonly offset: number })[] = [];
  const home = homePathIndex(text);
  if (home >= 0) hits.push({ rule: "home-path", offset: home });
  const aw = AW_DATA_PATH.exec(text);
  if (aw) hits.push({ rule: "aw-data-path", offset: aw.index });
  for (const term of terms) {
    if (term.matches(text)) hits.push({ rule: "private-term", termIndex: term.index, offset: Math.max(term.search?.(text) ?? 0, 0) });
  }
  for (const { kind, offset } of locateTokens(text)) hits.push({ rule: "credential-token", kind, offset });
  return hits;
}

export function matchRules(text: string, terms: readonly TermRule[] = []): RuleHit[] {
  const hits: RuleHit[] = [];
  if (matchesHomePath(text)) hits.push({ rule: "home-path" });
  if (matchesAwDataPath(text)) hits.push({ rule: "aw-data-path" });
  for (const term of terms) {
    if (term.matches(text)) hits.push({ rule: "private-term", termIndex: term.index });
  }
  for (const { kind } of locateTokens(text)) hits.push({ rule: "credential-token", kind });
  return hits;
}
