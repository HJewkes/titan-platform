import { ParseError, tokenize } from "./lexer.js";
import { NestingLimitError } from "./nesting.js";
import type { Token, WordToken } from "./tokens.js";

/** What bash starts with and what `unset IFS` restores. */
export const DEFAULT_IFS = " \t\n";

/** How many `eval` or `sh -c` texts deep a value is still looked for; deeper text is refused when it is walked. */
const MAX_RESCAN = 2;
const ASSIGNMENT_RE = /^IFS=(.*)$/s;
/** Builtins that read a quoted `IFS=v` argument as an assignment, which a command word would not. */
const DECLARERS = new Set(["local", "export", "declare", "typeset", "readonly"]);

/**
 * Every IFS a line could hold when one of its expansions splits: the default first, then each distinct
 * non-empty literal value the line assigns anywhere, in order. An empty IFS never splits, so it adds no reading.
 */
export function lineIfsValues(tokens: Token[]): string[] {
  const found = new Set<string>([DEFAULT_IFS]);
  scanTokens(tokens, 0, found);
  return [...found];
}

function scanTokens(tokens: Token[], depth: number, found: Set<string>): void {
  let declared = false;
  tokens.forEach((token, i) => {
    if (token.type === "op") {
      declared = false;
    } else if (token.type === "word") {
      scanWord(token, declared, depth, found);
      declared ||= !token.dynamic && DECLARERS.has(token.value);
      addForList(tokens, i, found);
    } else {
      scanSubs(token.subs, depth, found);
      if (token.type === "redirect" && token.target) scanWord(token.target, false, depth, found);
    }
  });
}

function scanSubs(subs: Token[][], depth: number, found: Set<string>): void {
  for (const sub of subs) scanTokens(sub, depth, found);
}

function scanWord(word: WordToken, declared: boolean, depth: number, found: Set<string>): void {
  scanSubs(word.subs, depth, found);
  if (word.dynamic) return;
  const assigned = ASSIGNMENT_RE.exec(word.value)?.[1];
  if (assigned !== undefined && (declared || !whollyQuoted(word))) return add(assigned, found);
  if (word.value.includes("IFS")) rescan(word.value, depth, found);
}

/** `'IFS=,; true'` is text for `eval` or `sh -c`, not an assignment, unless a declarer reads it. */
function whollyQuoted(word: WordToken): boolean {
  return word.quoted && !word.spliced;
}

/** `for IFS in a b; do`: each literal list word is a value IFS holds for one pass of the loop. */
function addForList(tokens: Token[], i: number, found: Set<string>): void {
  if (!isWord(tokens[i], "for") || !isWord(tokens[i + 1], "IFS") || !isWord(tokens[i + 2], "in")) return;
  for (const token of tokens.slice(i + 3)) {
    if (token.type !== "word" || isWord(token, "do")) return;
    if (!token.dynamic) add(token.value, found);
  }
}

function isWord(token: Token | undefined, value: string): boolean {
  return token?.type === "word" && !token.dynamic && !token.quoted && token.value === value;
}

function add(value: string, found: Set<string>): void {
  if (value !== "") found.add(value);
}

/** Text that names IFS without assigning it may still run as shell code, as with `eval` or `sh -c`. */
function rescan(text: string, depth: number, found: Set<string>): void {
  if (depth >= MAX_RESCAN) return;
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (error) {
    if (error instanceof ParseError || error instanceof NestingLimitError) return;
    throw error;
  }
  scanTokens(tokens, depth + 1, found);
}
