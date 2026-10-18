import { caseOperator, caseWord, closeCase, isCaseParen, noteCaseBlock, openCase } from "./case-grammar.js";
import { nextAfter } from "./joins.js";
import { ParseError } from "./parse-error.js";
import type { LexState, RegexScan, Token } from "./tokens.js";

/** The word before a compound assignment's `(`; quotes are already removed from the value. */
const ASSIGNMENT_HEAD_RE = /^[A-Za-z_]\w*(?:\[.*\])?\+?=/s;
/** Words after which the next word is still in command position, so a `[[` there opens a conditional. */
const COMMAND_PREFIXES = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "time", "coproc"]);
/** Characters bash may read, with extglob on or in some `[[ ]]`, as opening a pattern when glued to a `(`. */
const EXTGLOB_PREFIXES = "?*+@!";
/** Words that open a compound command, the only body bash accepts after a function header. */
const COMPOUND_OPENERS = new Set(["{", "if", "for", "while", "until", "case", "select", "[["]);
/** The control operators after which a `[[` is read the same by bash and zsh, with no prefix word before it. */
const BARE_START_OPS = new Set([";", "&", "&&", "||", "|", "|&", "\n", "("]);
const HEREDOC_OPENERS = new Set(["<<", "<<-", "<<<"]);
const BLOCK_OPENERS =new Set(["if", "for", "while", "until", "select"]);
const BLOCK_CLOSERS = new Set(["fi", "done"]);
/** Prefix words bash accepts only inside an `if` or a loop. */
const BLOCK_WORDS = new Set(["then", "elif", "else", "do"]);

export function newRegexScan(): RegexScan {
  return {
    scanned: 0,
    depth: 0,
    commandStart: true,
    conditionalAt: -1,
    joinsAt: -1,
    bareStart: true,
    regexAt: -1,
    wordAtStart: false,
    timed: false,
    nameNext: false,
    named: false,
    cases: [],
    blockDepth: 0,
    headerAt: -1,
    bodyPending: false,
  };
}

/**
 * Moves `s.depth` for the operator at `s.i` and tracks `NAME=( … )`. Inside it bash accepts only words, newlines and
 * the closing `)`; any other operator ends the line in a syntax error. In arithmetic or a `=~` operand `NAME=(` only
 * groups.
 */
export function noteParen(s: LexState, op: string, glued: string | null): void {
  if (s.caseWords && isCaseParen(scanned(s), op)) return;
  if (op === "(") s.depth++;
  if (op === ")") s.depth = Math.max(0, s.depth - 1);
  if (s.compoundDepth !== -1 && op !== ")" && op !== "\n") throw new ParseError(`\`${op}\` inside a compound assignment ( … ) is a bash syntax error`);
  if (op === ")" && s.depth < s.compoundDepth) s.compoundDepth = -1;
  if (op !== "(" || s.compoundDepth !== -1 || s.i < s.arithEnd) return;
  const before = s.tokens[s.tokens.length - 1];
  if (before?.type === "word" && ASSIGNMENT_HEAD_RE.test(before.value) && regexDepth(s) === -1) s.compoundDepth = s.depth;
  else refuseMisplacedParen(s, glued);
}

/**
 * Where bash rejects a `(`, or with extglob reads it as pattern text, it registers no heredoc the guard would read in
 * the parens, and the lines after it would hide from the guard while bash may still run them.
 */
function refuseMisplacedParen(s: LexState, glued: string | null): void {
  regexDepth(s);
  if (s.regex.conditionalAt !== -1) return;
  if (glued && EXTGLOB_PREFIXES.includes(glued)) throw new ParseError(`bash may read \`${glued}(\` as an extglob pattern, whose text the guard would read as commands`);
  if (!opensCommand(s)) throw new ParseError("bash rejects a `(` after a word outside command position, so no heredoc in it is real");
}

/** Whether bash reads a `(` here as a subshell, a function header or body, or a case pattern. */
function opensCommand(s: LexState): boolean {
  const r = s.regex;
  const last = s.tokens[s.tokens.length - 1];
  if (r.commandStart) return r.blockDepth > 0 || !BLOCK_WORDS.has(bareWord(last) ?? "");
  if (last?.type === "op" && last.value === ")") return r.bodyPending;
  if (r.named) {
    markHeader(s);
    return true;
  }
  return r.wordAtStart && markHeader(s);
}

/** A `name (` in command position is a function header only when `)` follows past blanks; bash rejects `f (<newline>)`. */
function markHeader(s: LexState): boolean {
  let j = nextAfter(s.src, s.i);
  while (s.src[j] === " " || s.src[j] === "\t") j = nextAfter(s.src, j);
  if (s.src[j] !== ")") return false;
  s.regex.headerAt = s.depth;
  return true;
}

function bareWord(t: Token | undefined): string | null {
  return t?.type === "word" && !t.quoted && !t.spliced ? t.value : null;
}

/**
 * Bash reads a redirect inside a compound assignment as a syntax error, and inside a `=~` operand's parens as text.
 * No heredoc opener is legal in `[[ ]]`, and inside an extglob paren there bash reads it as pattern text; `<` and `>`
 * stay, since `[[ a < b ]]` compares.
 */
export function refuseRedirect(s: LexState, op: string): void {
  if (s.compoundDepth !== -1) throw new ParseError("a redirect inside a compound assignment ( … ) is a bash syntax error");
  const at = regexDepth(s);
  if (at !== -1 && s.depth > at) throw new ParseError("bash reads a redirect inside a =~ operand's ( … ) as regex text");
  if (s.regex.conditionalAt !== -1 && HEREDOC_OPENERS.has(op)) throw new ParseError(`bash reads \`${op}\` inside [[ ]] as pattern text or a syntax error, never a heredoc`);
  if (s.regex.bodyPending) throw new ParseError("bash rejects a redirect between a function header and its body");
}

/** Whether the character at `s.i` sits directly in a `[[` opened at a bare command start, where `&&` and `||` join tests. */
export function inJoiningConditional(s: LexState): boolean {
  regexDepth(s);
  return s.trials.joinsConditional && s.regex.joinsAt !== -1 && s.depth === s.regex.joinsAt;
}

/** Whether the tokens so far end inside a `[[ ]]`, where `<` and `>` compare strings. */
export function inConditional(s: LexState): boolean {
  regexDepth(s);
  return s.regex.conditionalAt !== -1;
}

/** Whether the tokens so far leave a `case` without its `esac`. */
export function inOpenCase(s: LexState): boolean {
  regexDepth(s);
  return s.regex.cases.length > 0;
}

/**
 * The scan brought up to the tokens so far. Before any `case` or `esac` word no case is open, so `noteParen` skips it
 * and the arithmetic trials, which scan nothing else, stay as cheap as before.
 */
function scanned(s: LexState): RegexScan {
  regexDepth(s);
  return s.regex;
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
  const bare = bareWord(t);
  const bareStart = r.bareStart;
  r.bareStart = false;
  if (r.conditionalAt === -1) scanCommandWord(r, t, bare, bareStart && t.type === "word" && !t.computed && !t.dynamic);
  else if (bare === "=~") r.regexAt = r.depth;
  else if (bare === "]]" && r.depth === r.conditionalAt) Object.assign(r, { conditionalAt: -1, joinsAt: -1, regexAt: -1, commandStart: false });
}

function scanCommandWord(r: RegexScan, t: Token, bare: string | null, bareStart: boolean): void {
  if (caseWord(r, t, bare)) return void Object.assign(r, { commandStart: false, wordAtStart: false, timed: false, nameNext: false, named: false });
  if (r.commandStart) noteKeyword(r, bare, bareStart);
  const timeOption = r.timed && (bare === "-p" || bare === "--");
  r.named = r.nameNext;
  r.nameNext = r.commandStart && (bare === "function" || bare === "coproc");
  r.wordAtStart = r.commandStart && t.type === "word";
  r.timed = r.commandStart && (bare === "time" || timeOption);
  if (bare !== null && COMPOUND_OPENERS.has(bare)) r.bodyPending = false;
  r.commandStart = r.commandStart && bare !== null && (COMMAND_PREFIXES.has(bare) || timeOption);
}

/** Counts the `case`s, `if`s and loops a word in command position opens or closes, and opens a `[[`. */
function noteKeyword(r: RegexScan, bare: string | null, bareStart: boolean): void {
  if (bare === null) return;
  if (bare === "[[") Object.assign(r, { conditionalAt: r.depth, joinsAt: bareStart ? r.depth : -1 });
  if (bare === "case") openCase(r);
  if (bare === "esac") closeCase(r);
  noteCaseBlock(r, bare);
  if (BLOCK_OPENERS.has(bare)) r.blockDepth++;
  if (BLOCK_CLOSERS.has(bare)) r.blockDepth = Math.max(0, r.blockDepth - 1);
}

/** A `=~` operand ends at an operator other than a paren at its depth; a conditional also allows `&&` and `||`. */
function scanOperator(r: RegexScan, op: string): void {
  const pattern = isCaseParen(r, op);
  caseOperator(r, op);
  const closesHeader = !pattern && op === ")" && r.depth === r.headerAt;
  if (op === "(" && !pattern) r.depth++;
  if (op === ")" && !pattern) r.depth = Math.max(0, r.depth - 1);
  const paren = op === "(" || op === ")";
  if (r.depth < r.regexAt || (r.depth === r.regexAt && !paren)) r.regexAt = -1;
  if (r.depth < r.conditionalAt || (r.depth === r.conditionalAt && !paren && op !== "&&" && op !== "||")) Object.assign(r, { conditionalAt: -1, joinsAt: -1 });
  r.bareStart = BARE_START_OPS.has(op);
  if (r.conditionalAt === -1) r.commandStart = op !== ")" || closesHeader || pattern;
  noteHeader(r, op, closesHeader);
}

/** A header's `)` leaves its body pending, which a `(` or a compound opener word ends. */
function noteHeader(r: RegexScan, op: string, closesHeader: boolean): void {
  if (closesHeader) Object.assign(r, { headerAt: -1, bodyPending: true });
  else if (op === "(") r.bodyPending = false;
  Object.assign(r, { wordAtStart: false, timed: false, nameNext: false, named: false });
}
