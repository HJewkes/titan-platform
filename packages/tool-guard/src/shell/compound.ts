import { ParseError } from "./parse-error.js";
import type { LexState, RegexScan, Token } from "./tokens.js";

/** The word before a compound assignment's `(`; quotes are already removed from the value. */
const ASSIGNMENT_HEAD_RE = /^[A-Za-z_]\w*(?:\[.*\])?\+?=/s;
/** Words after which the next word is still in command position, so a `[[` there opens a conditional. */
const COMMAND_PREFIXES = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time"]);

export function newRegexScan(): RegexScan {
  return { scanned: 0, depth: 0, commandStart: true, conditionalAt: -1, regexAt: -1 };
}

/**
 * Moves `s.depth` for the operator at `s.i` and tracks `NAME=( … )`. Inside it bash accepts only words, newlines and
 * the closing `)`; any other operator ends the line in a syntax error. In arithmetic or a `=~` operand `NAME=(` only
 * groups.
 */
export function noteParen(s: LexState, op: string): void {
  if (op === "(") s.depth++;
  if (op === ")") s.depth--;
  if (s.compoundDepth !== -1 && op !== ")" && op !== "\n") throw new ParseError(`\`${op}\` inside a compound assignment ( … ) is a bash syntax error`);
  if (op === ")" && s.depth < s.compoundDepth) s.compoundDepth = -1;
  if (op !== "(" || s.compoundDepth !== -1 || s.i < s.arithEnd) return;
  const before = s.tokens[s.tokens.length - 1];
  if (before?.type === "word" && ASSIGNMENT_HEAD_RE.test(before.value) && regexDepth(s) === -1) s.compoundDepth = s.depth;
}

/** Bash reads a redirect inside a compound assignment as a syntax error, and inside a `=~` operand's parens as text. */
export function refuseRedirect(s: LexState): void {
  if (s.compoundDepth !== -1) throw new ParseError("a redirect inside a compound assignment ( … ) is a bash syntax error");
  const at = regexDepth(s);
  if (at !== -1 && s.depth > at) throw new ParseError("bash reads a redirect inside a =~ operand's ( … ) as regex text");
}

/** The paren depth of the `=~` whose operand the tokens so far end inside, or -1. Scans each token once. */
function regexDepth(s: LexState): number {
  const r = s.regex;
  for (const t of s.tokens.slice(r.scanned)) scanToken(r, t);
  r.scanned = s.tokens.length;
  return r.regexAt;
}

function scanToken(r: RegexScan, t: Token): void {
  if (t.type === "op") return scanOperator(r, t.value);
  const bare = t.type === "word" && !t.quoted && !t.spliced ? t.value : null;
  if (r.conditionalAt === -1) {
    if (r.commandStart && bare === "[[") r.conditionalAt = r.depth;
    r.commandStart = r.commandStart && bare !== null && COMMAND_PREFIXES.has(bare);
  } else if (bare === "=~") r.regexAt = r.depth;
  else if (bare === "]]" && r.depth === r.conditionalAt) Object.assign(r, { conditionalAt: -1, regexAt: -1, commandStart: false });
}

/** A `=~` operand ends at an operator other than a paren at its depth; a conditional also allows `&&` and `||`. */
function scanOperator(r: RegexScan, op: string): void {
  if (op === "(") r.depth++;
  if (op === ")") r.depth--;
  const paren = op === "(" || op === ")";
  if (r.depth < r.regexAt || (r.depth === r.regexAt && !paren)) r.regexAt = -1;
  if (r.depth < r.conditionalAt || (r.depth === r.conditionalAt && !paren && op !== "&&" && op !== "||")) r.conditionalAt = -1;
  if (r.conditionalAt === -1) r.commandStart = op !== ")";
}
