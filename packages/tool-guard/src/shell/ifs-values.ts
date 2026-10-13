import { ParseError, tokenize } from "./lexer.js";
import { NestingLimitError } from "./nesting.js";
import type { Token, WordToken } from "./tokens.js";

/** What bash starts with and what `unset IFS` restores. */
export const DEFAULT_IFS = " \t\n";

/** How many `eval` or `sh -c` texts deep a value is still looked for; deeper text leaves IFS unknown. */
const MAX_RESCAN = 2;
/**
 * A word that may name IFS once brace expansion or quote removal has run: `{I,}FS`, `I{F,}S`, `${IFS:=,}`.
 * Dynamic words keep their raw text, so this also catches `$IFS` and `$((IFS=1))`.
 */
const POSSIBLY_IFS_RE = /I.*F.*S/s;
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=(.*)$/s;
const OPTION_RE = /^[-+][A-Za-z]+$/;
const RESERVED = new Set(["!", "{", "}", "if", "then", "elif", "else", "fi", "while", "until", "do", "done", "time"]);
const PREFIXES = new Set(["command", "builtin"]);
const DECLARERS = new Set(["local", "export", "declare", "typeset", "readonly"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh"]);
/** Builtins that write a variable named by an operand; a dynamic operand may name IFS. */
const NAME_WRITERS = new Set(["read", "mapfile", "readarray", "getopts", "wait", "let", "select"]);

interface Scan {
  found: Set<string>;
  unknown: boolean;
}

interface Assignment {
  name: string;
  plain: boolean;
  value: string;
}

/**
 * Every IFS a line could hold when one of its expansions splits: the default first, then each distinct
 * non-empty literal value the line assigns anywhere, in order. An empty IFS never splits, so it adds no reading.
 * Null when a word that may name IFS after expansion does not resolve to a literal value (`IFS+=,`, `read IFS`,
 * `${IFS:=,}`, `{I,}FS=,`, `IFS=$V`), or a name-writing command takes a dynamic name, so a caller fails closed.
 */
export function lineIfsValues(tokens: Token[]): string[] | null {
  const scan: Scan = { found: new Set([DEFAULT_IFS]), unknown: false };
  scanTokens(tokens, 0, scan);
  return scan.unknown ? null : [...scan.found];
}

function scanTokens(tokens: Token[], depth: number, scan: Scan): void {
  let words: WordToken[] = [];
  for (const token of tokens) {
    if (token.type === "op") {
      scanCommand(words, depth, scan);
      words = [];
    } else if (token.type === "word") {
      words.push(token);
    } else {
      scanSubs(token.subs, depth, scan);
      if (token.type === "redirect" && token.target) scanRedirectTarget(token.target, depth, scan);
    }
  }
  scanCommand(words, depth, scan);
}

function scanSubs(subs: Token[][], depth: number, scan: Scan): void {
  for (const sub of subs) scanTokens(sub, depth, scan);
}

/** `> ${IFS:=x}` assigns while it expands. */
function scanRedirectTarget(target: WordToken, depth: number, scan: Scan): void {
  scanSubs(target.subs, depth, scan);
  if (target.dynamic && possiblyIfs(target.value)) markUnknown(scan);
}

function scanCommand(words: WordToken[], depth: number, scan: Scan): void {
  for (const word of words) scanSubs(word.subs, depth, scan);
  let i = 0;
  while (i < words.length && isReserved(words[i])) i++;
  for (; i < words.length && isPrefixAssignment(words[i]); i++) scanAssignment(words[i]!, scan);
  while (i < words.length && PREFIXES.has(literal(words[i]))) i++;
  const [command, ...args] = words.slice(i);
  if (command?.dynamic) return scanDynamicCommand(command, args, scan);
  if (command) scanArgs(command, args, depth, scan);
}

function isReserved(word: WordToken | undefined): boolean {
  return RESERVED.has(literal(word));
}

function isPrefixAssignment(word: WordToken | undefined): boolean {
  return word !== undefined && !whollyQuoted(word) && ASSIGNMENT_RE.test(word.value);
}

/** A dynamic command word may be a declarer, `eval` or `read`, so any IFS-like or dynamic operand is unknown. */
function scanDynamicCommand(command: WordToken, args: WordToken[], scan: Scan): void {
  if (possiblyIfs(command.value) || args.some((word) => word.dynamic || possiblyIfs(word.value))) markUnknown(scan);
}

function scanArgs(command: WordToken, args: WordToken[], depth: number, scan: Scan): void {
  const name = command.value;
  if (name === "eval") return scanEval(args, depth, scan);
  if (SHELLS.has(name.slice(name.lastIndexOf("/") + 1))) return scanShell(args, depth, scan);
  if (DECLARERS.has(name)) return scanDeclarer(args, scan);
  if (name === "unset") return;
  if (name === "for") return scanFor(args, scan);
  if (NAME_WRITERS.has(name) && args.some((word) => word.dynamic)) return markUnknown(scan);
  if (name === "printf" && printfTargetDynamic(args)) return markUnknown(scan);
  if ([command, ...args].some((word) => possiblyIfs(word.value))) markUnknown(scan);
}

/** `eval` joins its operands with spaces and runs the result as shell text. */
function scanEval(args: WordToken[], depth: number, scan: Scan): void {
  if (args.some((word) => word.dynamic && possiblyIfs(word.value))) return markUnknown(scan);
  const text = args.filter((word) => !word.dynamic).map((word) => word.value).join(" ");
  if (text !== "") rescan(text, depth, scan);
}

/** Any literal operand of `sh` may be the `-c` script; rescanning an option or a path finds nothing. */
function scanShell(args: WordToken[], depth: number, scan: Scan): void {
  for (const word of args) {
    if (word.dynamic && possiblyIfs(word.value)) return markUnknown(scan);
    if (!word.dynamic && !OPTION_RE.test(word.value)) rescan(word.value, depth, scan);
  }
}

function scanDeclarer(args: WordToken[], scan: Scan): void {
  const nameref = args.some((word) => !word.dynamic && /^-[A-Za-z]*n/.test(word.value));
  for (const word of args) {
    if (!word.dynamic && OPTION_RE.test(word.value)) continue;
    if (nameref && (word.dynamic || possiblyIfs(word.value))) return markUnknown(scan);
    if (word.dynamic && !dynamicDeclarationKnown(word)) return markUnknown(scan);
    if (!word.dynamic && word.value !== "IFS" && ASSIGNMENT_RE.test(word.value)) scanAssignment(word, scan);
    else if (!word.dynamic && word.value !== "IFS" && possiblyIfs(word.value)) return markUnknown(scan);
  }
}

/** `export PATH="$HOME/bin"` names its variable literally; `declare "${x}S=,"` does not. */
function dynamicDeclarationKnown(word: WordToken): boolean {
  const assignment = parseAssignment(word.value);
  return assignment !== null && assignment.name !== "IFS" && !possiblyIfs(assignment.value);
}

/** `for IFS in a b; do`: each literal list word is a value IFS holds for one pass of the loop. */
function scanFor(args: WordToken[], scan: Scan): void {
  const [variable, keyword, ...list] = args;
  if (!variable || !possiblyIfs(variable.value)) {
    if (args.some((word) => word.dynamic && possiblyIfs(word.value))) markUnknown(scan);
    return;
  }
  if (literal(variable) !== "IFS" || literal(keyword) !== "in" || list.some((word) => word.dynamic)) return markUnknown(scan);
  for (const word of list) add(word.value, scan);
}

/** `printf -v NAME` and `printf -vNAME` write NAME. */
function printfTargetDynamic(args: WordToken[]): boolean {
  return args.some((word, i) => (literal(word) === "-v" && args[i + 1]?.dynamic === true) || (word.dynamic && word.value.startsWith("-v")));
}

function scanAssignment(word: WordToken, scan: Scan): void {
  const assignment = parseAssignment(word.value);
  if (!assignment) return;
  if (assignment.name !== "IFS") {
    if (word.dynamic && possiblyIfs(assignment.value)) markUnknown(scan);
    return;
  }
  if (!assignment.plain || word.dynamic) return markUnknown(scan);
  add(assignment.value, scan);
}

function parseAssignment(text: string): Assignment | null {
  const match = ASSIGNMENT_RE.exec(text);
  if (!match) return null;
  return { name: match[1]!, plain: match[2] === undefined && match[3] === "", value: match[4]! };
}

/** `'IFS=,; true'` in command position runs a command of that name; it assigns nothing. */
function whollyQuoted(word: WordToken): boolean {
  return word.quoted && !word.spliced;
}

function literal(word: WordToken | undefined): string {
  return word && !word.dynamic && !word.quoted ? word.value : "";
}

function possiblyIfs(text: string): boolean {
  return POSSIBLY_IFS_RE.test(text);
}

function markUnknown(scan: Scan): void {
  scan.unknown = true;
}

function add(value: string, scan: Scan): void {
  if (value !== "") scan.found.add(value);
}

/** Shell text run by `eval` or `sh -c`, read the way that shell reads it. */
function rescan(text: string, depth: number, scan: Scan): void {
  if (!possiblyIfs(text) && !text.includes("$'")) return;
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
