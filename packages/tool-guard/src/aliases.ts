import { tokenize, type Token, type WordToken } from "./shell/lexer.js";

/** Alias name to every value seen for it; a name can carry the floor's value and the snapshot's. */
type AliasValues = Map<string, string[]>;

/**
 * Aliases assumed even with no readable snapshot, so a missing or oversized one still fails closed for them. Every
 * profile's zsh setup defines `g=git`.
 */
const FLOOR_ALIASES: Readonly<Record<string, readonly string[]>> = { g: ["git"] };

const SECTION = "# Aliases";
/** Bounds the re-lexing a line with an unclosed quote costs: each try re-reads the joined lines from the start. */
const MAX_DEFINITION_LINES = 32;

/**
 * The aliases a Claude Code shell snapshot defines. Only its last `# Aliases` section is read, since function bodies
 * above it can hold `alias` lines, or that header, that never run at source time; a file with no such header falls back
 * to every line that starts with `alias `. Accepts zsh's `alias -- NAME=VALUE` and bash's `alias NAME=VALUE`, quoting
 * removed. A line the lexer rejects is skipped, unless joining a few lines after it closes a quote that holds a newline.
 */
export function parseSnapshotAliases(text: string): AliasValues {
  const lines = aliasSection(text.split("\n"));
  const table: AliasValues = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.startsWith("alias ")) continue;
    const parsed = parseDefinition(lines, i);
    if (!parsed) continue;
    for (const [name, value] of parsed.pairs) addValue(table, name, value);
    i = parsed.last;
  }
  return table;
}

/** A copy of `table` that also holds every floor alias. */
export function withFloor(table: AliasValues): AliasValues {
  const merged: AliasValues = new Map([...table].map(([name, values]) => [name, [...values]]));
  for (const [name, values] of Object.entries(FLOOR_ALIASES)) for (const value of values) addValue(merged, name, value);
  return merged;
}

function aliasSection(lines: string[]): string[] {
  const start = lines.lastIndexOf(SECTION);
  if (start < 0) return lines;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("# "));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

/** The definition starting at line `first`, read through the first later line that lets it tokenize. */
function parseDefinition(lines: string[], first: number): { pairs: Array<[string, string]>; last: number } | null {
  const end = Math.min(lines.length, first + MAX_DEFINITION_LINES);
  for (let last = first; last < end; last++) {
    const tokens = tokensOf(lines.slice(first, last + 1).join("\n"));
    if (!tokens) continue;
    const pairs = definitionPairs(tokens);
    return pairs ? { pairs, last } : null;
  }
  return null;
}

function tokensOf(src: string): Token[] | null {
  try {
    return tokenize(src);
  } catch {
    return null;
  }
}

/**
 * `alias [-g] [--] NAME=VALUE…` as name and value pairs, or null for any other shape. A suffix alias (`-s`) names a
 * file extension rather than a command, and a word with an unquoted expansion has no fixed value, so both are refused.
 */
function definitionPairs(tokens: Token[]): Array<[string, string]> | null {
  const words = tokens.filter((t): t is WordToken => t.type === "word");
  if (words.length !== tokens.length || words.some((w) => w.dynamic)) return null;
  const [head, ...rest] = words.map((w) => w.value);
  if (head !== "alias") return null;
  while (rest[0] === "-g") rest.shift();
  if (rest[0] === "--") rest.shift();
  const pairs: Array<[string, string]> = [];
  for (const word of rest) {
    const pair = splitDefinition(word);
    if (!pair) return null;
    pairs.push(pair);
  }
  return pairs.length > 0 ? pairs : null;
}

function splitDefinition(word: string): [string, string] | null {
  const eq = word.indexOf("=");
  return eq > 0 ? [word.slice(0, eq), word.slice(eq + 1)] : null;
}

function addValue(table: AliasValues, name: string, value: string): void {
  const values = table.get(name);
  if (!values) table.set(name, [value]);
  else if (!values.includes(value)) values.push(value);
}
