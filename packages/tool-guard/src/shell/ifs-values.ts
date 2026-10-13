import { ParseError, tokenize } from "./lexer.js";
import { NestingLimitError } from "./nesting.js";
import type { Token, WordToken } from "./tokens.js";

/** What bash starts with and what `unset IFS` restores. */
export const DEFAULT_IFS = " \t\n";

/** How many `eval` or `sh -c` texts deep a value is still looked for; deeper text leaves IFS unknown. */
const MAX_RESCAN = 2;
const ASSIGNMENT_RE = /^IFS=(.*)$/s;
/** Dynamic words keep their raw text, so this also finds `${IFS:=,}`, `$((IFS=1))` and `$IFS`. */
const NAMES_IFS_RE = /(?<![A-Za-z0-9_])IFS(?![A-Za-z0-9_])/;
/** Builtins that read a quoted `IFS=v` argument as an assignment, which a command word would not. */
const DECLARERS = new Set(["local", "export", "declare", "typeset", "readonly"]);

interface Scan {
  found: Set<string>;
  unknown: boolean;
}

/** What the words of one command so far say about how a later word that names IFS is read. */
interface Segment {
  declared: boolean;
  unset: boolean;
  /** A dynamic word may be the command word, and so a declarer, `eval` or `printf -v`. */
  dynamic: boolean;
}

/**
 * Every IFS a line could hold when one of its expansions splits: the default first, then each distinct
 * non-empty literal value the line assigns anywhere, in order. An empty IFS never splits, so it adds no reading.
 * Null when the line names IFS in any way that does not resolve to a literal value (`IFS+=,`, `read IFS`,
 * `${IFS:=,}`, `IFS=$V`, a dynamic command word), so a caller fails closed.
 */
export function lineIfsValues(tokens: Token[]): string[] | null {
  const scan: Scan = { found: new Set([DEFAULT_IFS]), unknown: false };
  scanTokens(tokens, 0, scan);
  return scan.unknown ? null : [...scan.found];
}

function scanTokens(tokens: Token[], depth: number, scan: Scan): void {
  let segment = newSegment();
  tokens.forEach((token, i) => {
    if (token.type === "op") {
      segment = newSegment();
    } else if (token.type === "word") {
      if (isWord(token, "IFS") && isWord(tokens[i - 1], "for")) addForList(tokens, i, scan);
      else scanWord(token, segment, depth, scan);
      noteWord(token, segment);
    } else {
      scanSubs(token.subs, depth, scan);
      if (token.type === "redirect" && token.target) scanWord(token.target, segment, depth, scan);
    }
  });
}

function newSegment(): Segment {
  return { declared: false, unset: false, dynamic: false };
}

function noteWord(word: WordToken, segment: Segment): void {
  segment.dynamic ||= word.dynamic;
  segment.declared ||= !word.dynamic && DECLARERS.has(word.value);
  segment.unset ||= isWord(word, "unset");
}

function scanSubs(subs: Token[][], depth: number, scan: Scan): void {
  for (const sub of subs) scanTokens(sub, depth, scan);
}

function scanWord(word: WordToken, segment: Segment, depth: number, scan: Scan): void {
  scanSubs(word.subs, depth, scan);
  if (!NAMES_IFS_RE.test(word.value)) return;
  if (word.dynamic || segment.dynamic) return markUnknown(scan);
  if (segment.unset && word.value === "IFS") return;
  const assigned = ASSIGNMENT_RE.exec(word.value)?.[1];
  if (assigned !== undefined && (segment.declared || !whollyQuoted(word))) return add(assigned, scan);
  if (whollyQuoted(word)) return rescan(word.value, depth, scan);
  markUnknown(scan);
}

/** `'IFS=,; true'` is text for `eval` or `sh -c`, not an assignment, unless a declarer reads it. */
function whollyQuoted(word: WordToken): boolean {
  return word.quoted && !word.spliced;
}

/** `for IFS in a b; do`: each literal list word is a value IFS holds for one pass of the loop. */
function addForList(tokens: Token[], i: number, scan: Scan): void {
  if (!isWord(tokens[i + 1], "in")) return markUnknown(scan);
  for (const token of tokens.slice(i + 2)) {
    if (token.type !== "word" || isWord(token, "do")) return;
    if (token.dynamic) return markUnknown(scan);
    add(token.value, scan);
  }
}

function isWord(token: Token | undefined, value: string): boolean {
  return token?.type === "word" && !token.dynamic && !token.quoted && token.value === value;
}

function markUnknown(scan: Scan): void {
  scan.unknown = true;
}

function add(value: string, scan: Scan): void {
  if (value !== "") scan.found.add(value);
}

/** Text that names IFS without assigning it may still run as shell code, as with `eval` or `sh -c`. */
function rescan(text: string, depth: number, scan: Scan): void {
  if (depth >= MAX_RESCAN) return markUnknown(scan);
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (error) {
    if (!(error instanceof ParseError || error instanceof NestingLimitError)) throw error;
    return markUnknown(scan);
  }
  scanTokens(tokens, depth + 1, scan);
}
