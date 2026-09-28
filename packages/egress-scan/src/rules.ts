export type RuleId = "home-path" | "aw-data-path" | "private-term";

export const RULE_IDS: readonly RuleId[] = ["home-path", "aw-data-path", "private-term"];

/** A compiled private term. It exposes its line number, never its text or pattern. */
export interface TermRule {
  readonly index: number;
  matches(text: string): boolean;
}

export interface RuleHit {
  readonly rule: RuleId;
  readonly termIndex?: number;
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

export function matchesHomePath(text: string): boolean {
  for (const match of text.matchAll(HOME_PATH)) {
    if (!isPlaceholder(match[1] ?? "")) return true;
  }
  return false;
}

export function matchesAwDataPath(text: string): boolean {
  return AW_DATA_PATH.test(text);
}

export function matchRules(text: string, terms: readonly TermRule[] = []): RuleHit[] {
  const hits: RuleHit[] = [];
  if (matchesHomePath(text)) hits.push({ rule: "home-path" });
  if (matchesAwDataPath(text)) hits.push({ rule: "aw-data-path" });
  for (const term of terms) {
    if (term.matches(text)) hits.push({ rule: "private-term", termIndex: term.index });
  }
  return hits;
}
